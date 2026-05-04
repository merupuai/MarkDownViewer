#!/usr/bin/env node

// CoBolt Auto-Resume — Policy check and checkpoint writer for round-boundary resumes.
//
// The v2 bounded-context memory model keeps per-round orchestrator state small,
// but the orchestrator's own session still accumulates instruction and tool-output
// history across rounds. Under pressure (large milestones, many iterations),
// the session benefits from being recycled at a round boundary rather than
// running until Round 5 + context-safety-net fires.
//
// This tool provides two primitives called from source/skills/cobolt-build/
// steps/03-tdd-green.md section 3.5 (after flush-verdict, before round advance):
//
//   should-resume --round N [--total-rounds T] [--anchor-path P]
//     Returns "true" on stdout when the active policy says recycle now.
//     Exit 0 always (policy signal is the stdout string).
//
//   checkpoint --milestone M{n} --round N [--reason <text>]
//     Writes the two markers that existing infrastructure watches for:
//       1. _cobolt-output/context-resets/NEEDS_FRESH_AGENT.json  (resume payload)
//       2. _cobolt-output/.context-safety-recommended.flag        (existing safety-net trigger)
//     On the next Agent dispatch, cobolt-context-safety-net.js (Tier 1 PreToolUse)
//     reads the flag + pending phase + context pressure and hard-blocks with a
//     clean-exit message directing the user to /cobolt-build M{x} --resume.
//
// Policy: adaptive (default). Triggers resume when:
//   - round > ADAPTIVE_MIN_ROUND (default 4) AND total rounds remaining > 0
//   OR
//   - anchor file size exceeds SOFT_BYTE_CAP (advisory — complementary to anchor.js cap)
//
// Other policies (for future tuning, not default):
//   off            — never auto-resume
//   every-round    — resume after every round (stress test / tiny context budget)
//   every-N-rounds — configurable cadence
//
// The policy is read from COBOLT_AUTO_RESUME_POLICY env var (default: adaptive).
// Explicit opt-out: COBOLT_AUTO_RESUME=0.

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJSON } = require('../lib/cobolt-atomic-write');

// ── Autonomous-mode awareness ─────────────────────────────────────
// When the build is running in --auto/--autonomous, round-boundary
// handoffs are EXPENSIVE: every handoff requires the user (or a CLI
// daemon) to relaunch `/cobolt-build M{n} --resume --autonomous`. Users
// expect --auto to feel continuous. Prior to this change, cadence+anchor
// thresholds tuned for interactive use (ADAPTIVE_MIN_ROUND=4,
// SOFT_BYTE_CAP=12000, STORY_RESUME_CADENCE=3) fired handoffs as early
// as Round 1→2 on medium milestones, matching the reported pattern
// "every build phase stops at M2 Step 02-03". Under autonomous mode we
// raise these thresholds dramatically so the only handoff triggers are
// phantom-cascade (safety signal), genuine mid-round context pressure
// (anchor size), and user-supplied env overrides. Interactive builds
// keep today's tighter defaults — those users can manually resume.
function detectAutonomousForPolicy() {
  if (process.env.COBOLT_FORCE_AUTONOMOUS_POLICY === '1') return true;
  if (process.env.COBOLT_FORCE_AUTONOMOUS_POLICY === '0') return false;
  try {
    const statePath = path.join(process.cwd(), 'cobolt-state.json');
    if (!fs.existsSync(statePath)) return false;
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    try {
      const { isAutonomous } = require('../lib/cobolt-autonomous.js');
      return isAutonomous(state);
    } catch {
      return (
        state?.build?.autonomous === true ||
        state?.pipeline?.autonomous === true ||
        state?.pipeline?.mode === 'autonomous' ||
        state?.flags?.autonomous === true
      );
    }
  } catch {
    return false;
  }
}

const AUTONOMOUS_POLICY = detectAutonomousForPolicy();

// User-configurable via env so projects can tune thresholds to their context budget.
// Defaults chosen to match cobolt-anchor.js SOFT_TOKEN_CAP * CHARS_PER_TOKEN (3000 * 4).
const ADAPTIVE_MIN_ROUND = parseInt(process.env.COBOLT_ADAPTIVE_MIN_ROUND || (AUTONOMOUS_POLICY ? '99' : '4'), 10);
const SOFT_BYTE_CAP = parseInt(process.env.COBOLT_ANCHOR_SOFT_BYTES || (AUTONOMOUS_POLICY ? '40000' : '12000'), 10);
const STORY_RESUME_CADENCE = parseInt(process.env.COBOLT_STORY_RESUME_CADENCE || (AUTONOMOUS_POLICY ? '0' : '3'), 10);
const RESET_DIR = path.join('_cobolt-output', 'context-resets');
const RESET_MARKER = 'NEEDS_FRESH_AGENT.json';
const STORY_MARKER = 'NEEDS_FRESH_AGENT_STORY.json';
// v0.66.5 (Wave 1 D-2): milestone-complete marker. Distinct file so per-story
// and per-milestone resume payloads do not overwrite each other when a single
// session crosses both boundaries.
const MILESTONE_MARKER = 'NEEDS_FRESH_AGENT_MILESTONE.json';
const SAFETY_FLAG = path.join('_cobolt-output', '.context-safety-recommended.flag');

// ── Argument parser ──────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

// ── Policy engine ────────────────────────────────────────────────

function getPolicy() {
  if (process.env.COBOLT_AUTO_RESUME === '0') return 'off';
  const raw = (process.env.COBOLT_AUTO_RESUME_POLICY || 'adaptive').toLowerCase().trim();
  if (['off', 'every-round', 'adaptive'].includes(raw)) return raw;
  const m = raw.match(/^every-(\d+)-rounds?$/);
  if (m) return { kind: 'every-n', n: parseInt(m[1], 10) };
  return 'adaptive';
}

function anchorBytes(anchorPath) {
  if (!anchorPath) return 0;
  try {
    return fs.statSync(anchorPath).size;
  } catch {
    return 0;
  }
}

function decideResume({ round, totalRounds, anchorPath }) {
  const policy = getPolicy();
  if (policy === 'off') return { resume: false, reason: 'policy=off' };
  if (policy === 'every-round') return { resume: true, reason: 'policy=every-round' };

  if (typeof policy === 'object' && policy.kind === 'every-n') {
    const match = round % policy.n === 0;
    return {
      resume: match,
      reason: match ? `policy=every-${policy.n}-rounds hit` : `policy=every-${policy.n}-rounds miss`,
    };
  }

  // adaptive
  const remaining = totalRounds ? Math.max(totalRounds - round, 0) : 1;
  if (round >= ADAPTIVE_MIN_ROUND && remaining > 0) {
    return { resume: true, reason: `adaptive: round ${round} >= ${ADAPTIVE_MIN_ROUND} with ${remaining} remaining` };
  }
  const bytes = anchorBytes(anchorPath);
  if (bytes > SOFT_BYTE_CAP && remaining > 0) {
    return { resume: true, reason: `adaptive: anchor ${bytes}b > ${SOFT_BYTE_CAP}b soft cap` };
  }
  return { resume: false, reason: 'adaptive: below thresholds' };
}

// ── Commands ─────────────────────────────────────────────────────

// v0.61 (D10): rejection messages now name the offending value and the
// reason it was rejected. Pre-fix, `--round 0` printed
// "should-resume requires --round N (positive integer)" with no echo of
// the input — operators couldn't tell whether their arg was missing,
// non-numeric, or zero. Build rounds start at 1 by convention; round 0
// has no defined semantics.
function rejectInvalidRound(command, raw, parsed) {
  const echo = raw === undefined ? '<missing>' : JSON.stringify(raw);
  let reason;
  if (raw === undefined) {
    reason = `${command} requires --round N. Build rounds start at 1.`;
  } else if (!Number.isInteger(parsed)) {
    reason = `${command} got --round ${echo} which is not an integer. Build rounds start at 1.`;
  } else if (parsed < 1) {
    reason = `${command} got --round ${echo}. Build rounds start at 1; round 0 has no defined semantics — pass --round 1 if you mean the first round.`;
  } else {
    reason = `${command} requires --round N (positive integer); got ${echo}.`;
  }
  console.error(reason);
  process.exit(1);
}

function cmdShouldResume(args) {
  const round = parseInt(args.round, 10);
  if (!Number.isInteger(round) || round < 1) {
    rejectInvalidRound('should-resume', args.round, round);
  }
  const totalRounds = args['total-rounds'] ? parseInt(args['total-rounds'], 10) : undefined;
  const anchorPath = args['anchor-path'] || null;
  const { resume, reason } = decideResume({ round, totalRounds, anchorPath });
  process.stdout.write(resume ? 'true\n' : 'false\n');
  if (args.explain) process.stderr.write(`[auto-resume] ${reason}\n`);
}

function cmdCheckpoint(args) {
  const milestone = args.milestone;
  const round = parseInt(args.round, 10);
  const reason = args.reason || 'auto-resume at round boundary';

  if (!milestone) {
    console.error('checkpoint requires --milestone M{n} (e.g. --milestone M1).');
    process.exit(1);
  }
  if (!Number.isInteger(round) || round < 1) {
    rejectInvalidRound('checkpoint', args.round, round);
  }

  // Marker 1: NEEDS_FRESH_AGENT.json — structured resume payload (read by _context-resume.js)
  const resetDir = path.join(process.cwd(), RESET_DIR);
  if (!fs.existsSync(resetDir)) fs.mkdirSync(resetDir, { recursive: true, mode: 0o700 });
  const resetPath = path.join(resetDir, RESET_MARKER);
  const resumePayload = {
    writtenAt: new Date().toISOString(),
    stage: 'build',
    milestone,
    resumeAt: `build/${milestone}/round-${round + 1}`,
    lastCompletedRound: round,
    reason,
  };
  atomicWriteJSON(resetPath, resumePayload, { mode: 0o600 });

  // Marker 2: .context-safety-recommended.flag — existing trigger for context-safety-net hook
  const flagPath = path.join(process.cwd(), SAFETY_FLAG);
  const flagDir = path.dirname(flagPath);
  if (!fs.existsSync(flagDir)) fs.mkdirSync(flagDir, { recursive: true, mode: 0o700 });
  const flagPayload = {
    writtenAt: new Date().toISOString(),
    milestone,
    lastCompletedRound: round,
    reason,
    source: 'cobolt-auto-resume',
  };
  atomicWriteJSON(flagPath, flagPayload, { mode: 0o600 });

  console.log(`Auto-resume checkpoint written: ${milestone} round ${round} → ${round + 1}`);
  console.log(`  Reset marker: ${resetPath}`);
  console.log(`  Safety flag:  ${flagPath}`);
  console.log('  On the next Agent dispatch, cobolt-context-safety-net.js will hard-block');
  console.log(`  with instructions to resume via: /cobolt-build ${milestone} --resume`);
}

// ── Per-story resume (mid-round) ─────────────────────────────────
//
// Within a round with many stories (e.g., 8 stories in Round 1), the
// orchestrator's session context accumulates even though no round boundary
// is hit. Without per-story auto-resume, context pressure builds until the
// model self-judges "budget exceeded" and halts with prose like
// "halting here rather than fabricating completion".
//
// Policy: trigger per-story resume when:
//   - opt-out off (COBOLT_AUTO_RESUME_STORY != '0' AND COBOLT_AUTO_RESUME != '0'), AND
//   - stories remain in this round (storyIndex < totalStories), AND
//   - (anchor bytes > SOFT_BYTE_CAP) OR (storyIndex > 0 AND storyIndex % STORY_RESUME_CADENCE === 0)

function readCascadeTrigger(round) {
  try {
    const p = path.join(process.cwd(), '_cobolt-output', 'audit', 'phantom-cascade-trigger.json');
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (data && String(data.round) === String(round)) return data;
    return null;
  } catch {
    return null;
  }
}

function decideResumeStory({ round, storyIndex, totalStories, anchorPath }) {
  if (process.env.COBOLT_AUTO_RESUME === '0') return { resume: false, reason: 'policy=off' };
  if (process.env.COBOLT_AUTO_RESUME_STORY === '0') return { resume: false, reason: 'story-policy=off' };
  const remaining = Math.max((totalStories || 0) - (storyIndex || 0), 0);
  if (remaining <= 0) return { resume: false, reason: 'no stories remaining' };
  // v0.14.2 — phantom-cascade circuit breaker: if ≥ threshold phantom returns
  // happened in this round, force a checkpoint handoff immediately.
  const cascade = readCascadeTrigger(round);
  if (cascade) {
    return {
      resume: true,
      reason: `phantom-cascade: agent=${cascade.agent} count=${cascade.count} threshold=${cascade.threshold} (round ${round})`,
    };
  }
  // STORY_RESUME_CADENCE <= 0 means "disabled" (autonomous mode default).
  // Previously we fell back to 3 here, which silently re-enabled cadence
  // handoffs even when the user explicitly asked for zero.
  if (STORY_RESUME_CADENCE > 0) {
    const cadence = STORY_RESUME_CADENCE;
    if (storyIndex > 0 && storyIndex % cadence === 0) {
      return { resume: true, reason: `story cadence: index ${storyIndex} % ${cadence} == 0 (round ${round})` };
    }
  }
  const bytes = anchorBytes(anchorPath);
  if (bytes > SOFT_BYTE_CAP) {
    return {
      resume: true,
      reason: `anchor ${bytes}b > ${SOFT_BYTE_CAP}b soft cap (round ${round}, story ${storyIndex})`,
    };
  }
  return { resume: false, reason: 'below thresholds' };
}

function cmdShouldResumeStory(args) {
  const round = parseInt(args.round, 10);
  const storyIndex = parseInt(args['story-index'], 10);
  const totalStories = parseInt(args['total-stories'], 10);
  if (!Number.isInteger(round) || round < 1) {
    console.error('should-resume-story requires --round N (positive integer)');
    process.exit(1);
  }
  if (!Number.isInteger(storyIndex) || storyIndex < 0) {
    console.error('should-resume-story requires --story-index I (non-negative integer)');
    process.exit(1);
  }
  if (!Number.isInteger(totalStories) || totalStories < 1) {
    console.error('should-resume-story requires --total-stories T (positive integer)');
    process.exit(1);
  }
  const anchorPath = args['anchor-path'] || null;
  const { resume, reason } = decideResumeStory({ round, storyIndex, totalStories, anchorPath });
  process.stdout.write(resume ? 'true\n' : 'false\n');
  if (args.explain) process.stderr.write(`[auto-resume-story] ${reason}\n`);
}

function cmdCheckpointStory(args) {
  const milestone = args.milestone;
  const round = parseInt(args.round, 10);
  const storyId = args['story-id'];
  const nextStory = args['next-story'] || null;
  const reason = args.reason || 'per-story auto-resume (context pressure)';

  if (!milestone || !Number.isInteger(round) || round < 1 || !storyId) {
    console.error('checkpoint-story requires --milestone M{n} --round N --story-id <id> [--next-story <id>]');
    process.exit(1);
  }

  const resetDir = path.join(process.cwd(), RESET_DIR);
  if (!fs.existsSync(resetDir)) fs.mkdirSync(resetDir, { recursive: true, mode: 0o700 });

  // Story marker — machine-readable, encodes next-story pointer for --resume
  const storyPath = path.join(resetDir, STORY_MARKER);
  const storyPayload = {
    writtenAt: new Date().toISOString(),
    stage: 'build',
    milestone,
    round,
    lastCompletedStory: storyId,
    nextStory,
    resumeAt: nextStory
      ? `build/${milestone}/round-${round}/story-${nextStory}`
      : `build/${milestone}/round-${round + 1}`,
    reason,
  };
  atomicWriteJSON(storyPath, storyPayload, { mode: 0o600 });

  // Also write generic reset marker + safety flag so existing context-safety-net hook fires
  const resetPath = path.join(resetDir, RESET_MARKER);
  const resumePayload = {
    writtenAt: storyPayload.writtenAt,
    stage: 'build',
    milestone,
    resumeAt: storyPayload.resumeAt,
    lastCompletedRound: round - 1, // current round not yet complete
    lastCompletedStory: storyId,
    nextStory,
    reason,
    kind: 'per-story',
  };
  atomicWriteJSON(resetPath, resumePayload, { mode: 0o600 });

  const flagPath = path.join(process.cwd(), SAFETY_FLAG);
  const flagDir = path.dirname(flagPath);
  if (!fs.existsSync(flagDir)) fs.mkdirSync(flagDir, { recursive: true, mode: 0o700 });
  const flagPayload = {
    writtenAt: storyPayload.writtenAt,
    milestone,
    round,
    lastCompletedStory: storyId,
    nextStory,
    reason,
    source: 'cobolt-auto-resume-story',
  };
  atomicWriteJSON(flagPath, flagPayload, { mode: 0o600 });

  // Clear phantom-cascade trigger for this round — the handoff resolves it.
  try {
    const triggerPath = path.join(process.cwd(), '_cobolt-output', 'audit', 'phantom-cascade-trigger.json');
    if (fs.existsSync(triggerPath)) fs.unlinkSync(triggerPath);
  } catch {
    /* best-effort */
  }

  console.log(`Per-story auto-resume checkpoint written: ${milestone} round ${round} story ${storyId}`);
  console.log(`  Story marker: ${storyPath}`);
  if (nextStory) console.log(`  Next story:   ${nextStory}`);
  console.log(`  Resume with:  /cobolt-build ${milestone} --resume`);
}

// ── Per-milestone checkpoint (milestone-boundary handoff) ──────────
//
// v0.66.5 (Wave 1 D-2). When a milestone fully completes (all rounds done,
// 08-milestone-complete checkpoint reached), the orchestrator should hand off
// to a fresh agent before starting M{n+1}. The pre-existing checkpoint and
// checkpoint-story modes both REQUIRE round (and story respectively), so a
// caller at milestone boundary had no shape to use — the rigid signature was
// the diagnostic in CoBolt issue D-2 from the build feedback. This mode
// accepts only --milestone (with optional --next-milestone and --reason) and
// writes the milestone-boundary marker.

function cmdCheckpointMilestone(args) {
  const milestone = args.milestone;
  const nextMilestone = args['next-milestone'] || null;
  const reason = args.reason || 'milestone-complete handoff (fresh agent for next milestone)';

  if (!milestone) {
    console.error('checkpoint-milestone requires --milestone M{n} [--next-milestone M{n+1}] [--reason "<text>"]');
    process.exit(1);
  }
  if (!/^M\d+$/i.test(milestone)) {
    console.error(`checkpoint-milestone --milestone must match /^M\\d+$/, got: ${milestone}`);
    process.exit(1);
  }
  if (nextMilestone && !/^M\d+$/i.test(nextMilestone)) {
    console.error(`checkpoint-milestone --next-milestone must match /^M\\d+$/, got: ${nextMilestone}`);
    process.exit(1);
  }

  const resetDir = path.join(process.cwd(), RESET_DIR);
  if (!fs.existsSync(resetDir)) fs.mkdirSync(resetDir, { recursive: true, mode: 0o700 });

  const writtenAt = new Date().toISOString();
  const resumeAt = nextMilestone ? `build/${nextMilestone}/round-1` : `build/${milestone}/complete`;

  // Milestone marker — distinct file so per-story and per-milestone payloads
  // don't trample each other if both fire in the same session.
  const milestonePath = path.join(resetDir, MILESTONE_MARKER);
  const milestonePayload = {
    writtenAt,
    stage: 'build',
    kind: 'milestone-complete',
    milestone,
    lastCompletedMilestone: milestone,
    nextMilestone,
    resumeAt,
    reason,
  };
  atomicWriteJSON(milestonePath, milestonePayload, { mode: 0o600 });

  // Generic reset marker — context-safety-net hook reads this for the resume payload.
  const resetPath = path.join(resetDir, RESET_MARKER);
  const resumePayload = {
    writtenAt,
    stage: 'build',
    milestone,
    resumeAt,
    lastCompletedMilestone: milestone,
    nextMilestone,
    reason,
    kind: 'milestone-complete',
  };
  atomicWriteJSON(resetPath, resumePayload, { mode: 0o600 });

  // Safety flag — fires the existing PreToolUse hard-block on next dispatch.
  const flagPath = path.join(process.cwd(), SAFETY_FLAG);
  const flagDir = path.dirname(flagPath);
  if (!fs.existsSync(flagDir)) fs.mkdirSync(flagDir, { recursive: true, mode: 0o700 });
  const flagPayload = {
    writtenAt,
    milestone,
    nextMilestone,
    kind: 'milestone-complete',
    reason,
    source: 'cobolt-auto-resume-milestone',
  };
  atomicWriteJSON(flagPath, flagPayload, { mode: 0o600 });

  // Clear stale phantom-cascade trigger — the milestone-boundary handoff resolves any
  // pending per-round cascade signal because the next session starts from zero.
  try {
    const triggerPath = path.join(process.cwd(), '_cobolt-output', 'audit', 'phantom-cascade-trigger.json');
    if (fs.existsSync(triggerPath)) fs.unlinkSync(triggerPath);
  } catch {
    /* best-effort */
  }

  console.log(
    `Milestone-complete auto-resume checkpoint written: ${milestone}${nextMilestone ? ` → ${nextMilestone}` : ''}`,
  );
  console.log(`  Milestone marker: ${milestonePath}`);
  if (nextMilestone) {
    console.log(`  Next milestone:   ${nextMilestone}`);
    console.log(`  Resume with:      /cobolt-build ${nextMilestone}`);
  } else {
    console.log(`  Resume with:      /cobolt-release  (or next milestone if any)`);
  }
}

// ── Main ─────────────────────────────────────────────────────────

function main() {
  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);
  const isHelp = command === '--help' || command === '-h' || command === 'help';
  switch (command) {
    case 'should-resume':
      return cmdShouldResume(args);
    case 'checkpoint':
      return cmdCheckpoint(args);
    case 'should-resume-story':
      return cmdShouldResumeStory(args);
    case 'checkpoint-story':
      return cmdCheckpointStory(args);
    case 'checkpoint-milestone':
      return cmdCheckpointMilestone(args);
    default: {
      const usage =
        'Usage: cobolt-auto-resume.js <should-resume|checkpoint|should-resume-story|checkpoint-story|checkpoint-milestone> [args]\n' +
        '  should-resume         --round N [--total-rounds T] [--anchor-path P] [--explain]\n' +
        '  checkpoint            --milestone M{n} --round N [--reason "<text>"]\n' +
        '  should-resume-story   --round N --story-index I --total-stories T [--anchor-path P] [--explain]\n' +
        '  checkpoint-story      --milestone M{n} --round N --story-id <id> [--next-story <id>] [--reason "<text>"]\n' +
        '  checkpoint-milestone  --milestone M{n} [--next-milestone M{n+1}] [--reason "<text>"]   (Wave 1 D-2)\n\n' +
        'Env:\n' +
        '  COBOLT_AUTO_RESUME_POLICY   off | every-round | every-N-rounds | adaptive (default)\n' +
        '  COBOLT_AUTO_RESUME=0        shortcut for policy=off';
      if (isHelp || !command) {
        process.stdout.write(`${usage}\n`);
        process.exit(0);
      }
      process.stderr.write(`${usage}\n`);
      process.exit(1);
    }
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`[auto-resume] ERROR: ${e.message}`);
    process.exit(1);
  }
}

module.exports = {
  decideResume,
  decideResumeStory,
  getPolicy,
  _testOnly: { ADAPTIVE_MIN_ROUND, SOFT_BYTE_CAP, STORY_RESUME_CADENCE },
};
