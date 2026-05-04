#!/usr/bin/env node

// CoBolt Rebalance Apply — applies milestone-rebalance-plan.json moves.
//
// Closes the v0.52 RawDrive incident class (2026-04-27). cobolt-preflight.js
// already produces a non-destructive move plan via `rebalance-milestones --write`,
// but the plan was never consumed: cobolt-plan-fix dispatched `cobolt-decompose-milestones`
// (greenfield-only — re-clusters from PRD, clobbers milestones.md) directly, and the
// consolidator inside that flow stripped FR coverage to satisfy the 10-story cap.
//
// This tool reads `_cobolt-output/latest/planning/milestone-rebalance-plan.json`
// and applies its `summary.suggestedMoves[]` to the canonical story↔milestone
// mapping in `story-tracker.json` (and `rtm.json` when story FRs are tagged).
//
// Why story-tracker.json is the only mutation target:
//   - It is the canonical source build operates on (per
//     tools/cobolt-preflight.js extractStoryFrIds + storiesByMilestone).
//   - epics.md / milestones.md derive from the tracker in the existing producer
//     skills (cobolt-create-epics-and-stories, cobolt-decompose-milestones). After
//     this tool runs, callers should re-run those skills with --rebalance-only or
//     equivalent regeneration to refresh the markdown surfaces.
//   - rtm.json holds per-FR milestone tags; we update those alongside so the
//     downstream RTM census stays consistent.
//
// Exit codes (per CLAUDE.md tool-exit-contract):
//   0 — applied or no-op (plan reports needsRebalance:false)
//   1 — error (plan missing, malformed, or apply step failed)
//   2 — missing optional dep (n/a here; reserved)
//   3 — missing infra (n/a here; reserved)

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('../lib/cobolt-atomic-write');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    const k = v.startsWith('--') ? v.slice(2) : null;
    if (!k) {
      args._.push(v);
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[k] = true;
    } else {
      args[k] = next;
      i++;
    }
  }
  return args;
}

function readJsonOrFail(filePath, label) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new Error(`${label} not found at ${filePath}: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${label} is not valid JSON at ${filePath}: ${e.message}`);
  }
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeMilestoneId(value) {
  if (value == null) return null;
  const s = String(value).trim().toUpperCase();
  if (/^M\d+$/u.test(s)) return s;
  const match = s.match(/^M(\d+)/u);
  return match ? `M${match[1]}` : null;
}

function applyMovesToTracker(tracker, moves, dryRun) {
  if (!tracker || !Array.isArray(tracker.stories)) {
    return { applied: 0, skipped: moves.length, missingStoryIds: moves.map((m) => m.storyId).filter(Boolean) };
  }
  const byId = new Map();
  for (const story of tracker.stories) {
    if (story?.id) byId.set(String(story.id), story);
  }
  let applied = 0;
  const skipped = [];
  for (const move of moves) {
    const storyId = move.storyId ? String(move.storyId) : null;
    const targetMilestone = normalizeMilestoneId(move.toMilestone);
    if (!storyId || !targetMilestone) {
      skipped.push({ move, reason: 'missing storyId or toMilestone' });
      continue;
    }
    const story = byId.get(storyId);
    if (!story) {
      skipped.push({ move, reason: 'story not found in tracker' });
      continue;
    }
    const currentMilestone = normalizeMilestoneId(story.milestone || story.milestoneId);
    if (currentMilestone === targetMilestone) {
      // Already in target milestone — counts as applied (idempotent).
      applied += 1;
      continue;
    }
    if (!dryRun) {
      story.milestone = targetMilestone;
      if ('milestoneId' in story) story.milestoneId = targetMilestone;
    }
    applied += 1;
  }
  return { applied, skipped };
}

function applyMovesToRtm(rtm, moves, dryRun, tracker) {
  if (!rtm || !Array.isArray(rtm.requirements)) return { updated: 0 };
  const trackerStories = Array.isArray(tracker?.stories) ? tracker.stories : [];
  // Build a map from storyId -> {fromMilestone, toMilestone, frIds[]} for moves
  const moveByStory = new Map();
  for (const move of moves) {
    const storyId = move.storyId ? String(move.storyId) : null;
    const target = normalizeMilestoneId(move.toMilestone);
    if (!storyId || !target) continue;
    const story = trackerStories.find((s) => String(s?.id || '') === storyId);
    const frIds = story
      ? [
          ...(Array.isArray(story.frIds) ? story.frIds : []),
          ...(Array.isArray(story.requirementIds)
            ? story.requirementIds.filter((id) => /^FR-\d+/iu.test(String(id || '')))
            : []),
        ]
      : [];
    moveByStory.set(storyId, {
      storyId,
      fromMilestone: normalizeMilestoneId(move.fromMilestone),
      toMilestone: target,
      frIds,
    });
  }
  // Aggregate FR-IDs that need their milestone tags updated.
  const frTargetMap = new Map();
  for (const move of moveByStory.values()) {
    for (const frId of move.frIds) {
      const canonical = String(frId).trim().toUpperCase();
      if (!frTargetMap.has(canonical)) frTargetMap.set(canonical, move.toMilestone);
    }
  }

  let updated = 0;
  for (const req of rtm.requirements) {
    const id = String(req?.frId || req?.id || '')
      .trim()
      .toUpperCase();
    if (!id) continue;
    const target = frTargetMap.get(id);
    if (!target) continue;
    const existing = Array.isArray(req.milestones) ? req.milestones : req.milestone ? [req.milestone] : [];
    const normalizedExisting = existing.map(normalizeMilestoneId).filter(Boolean);
    if (normalizedExisting.includes(target)) continue;
    if (!dryRun) {
      // Append target milestone (preserves multi-milestone phasing per v0.24 RTM schema).
      const next = [...new Set([...normalizedExisting, target])];
      req.milestones = next;
      if (req.milestone && !req.milestones.includes(req.milestone)) {
        // Keep legacy scalar in sync with primary if it was the sole previous tag.
        req.milestone = req.milestones[0];
      }
    }
    updated += 1;
  }
  return { updated };
}

function planningDirOf(projectRoot) {
  return path.join(projectRoot, '_cobolt-output', 'latest', 'planning');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    process.stdout.write(
      [
        'Usage: cobolt-rebalance-apply [--plan-path <path>] [--project <root>] [--dry-run] [--json]',
        '',
        'Reads _cobolt-output/latest/planning/milestone-rebalance-plan.json and applies its',
        'summary.suggestedMoves[] to story-tracker.json + rtm.json. Non-destructive: never',
        'rewrites milestones.md or epics.md from PRD (use cobolt-decompose-milestones for that).',
        '',
        'After applying, regenerate epics.md / milestones.md by re-running:',
        '  Skill cobolt-create-epics-and-stories --autonomous',
        '',
        'Exit codes: 0=success/no-op, 1=error.',
        '',
      ].join('\n'),
    );
    process.exit(0);
  }

  const projectRoot = path.resolve(args.project ? String(args.project) : process.cwd());
  const planningDir = planningDirOf(projectRoot);
  const planPath = args['plan-path']
    ? path.resolve(String(args['plan-path']))
    : path.join(planningDir, 'milestone-rebalance-plan.json');

  let plan;
  try {
    plan = readJsonOrFail(planPath, 'rebalance plan');
  } catch (e) {
    process.stderr.write(`[rebalance-apply] ${e.message}\n`);
    process.exit(1);
  }

  if (plan.needsRebalance === false) {
    const msg = { applied: 0, skipped: 0, message: 'Plan reports needsRebalance:false — nothing to apply.' };
    if (args.json) process.stdout.write(`${JSON.stringify(msg)}\n`);
    else process.stdout.write(`${msg.message}\n`);
    process.exit(0);
  }

  const moves = Array.isArray(plan?.summary?.suggestedMoves) ? plan.summary.suggestedMoves : [];
  if (moves.length === 0) {
    const msg = {
      applied: 0,
      skipped: 0,
      message: 'Plan has no suggestedMoves[] — re-decomposition required (run /cobolt-decompose-milestones).',
    };
    if (args.json) process.stdout.write(`${JSON.stringify(msg)}\n`);
    else process.stdout.write(`${msg.message}\n`);
    process.exit(0);
  }

  const trackerPath = path.join(planningDir, 'story-tracker.json');
  const tracker = readJsonSafe(trackerPath);
  if (!tracker) {
    process.stderr.write(`[rebalance-apply] story-tracker.json not found at ${trackerPath}\n`);
    process.exit(1);
  }
  const rtmPath = path.join(planningDir, 'rtm.json');
  const rtm = readJsonSafe(rtmPath);

  const trackerResult = applyMovesToTracker(tracker, moves, args['dry-run'] === true);
  const rtmResult = rtm ? applyMovesToRtm(rtm, moves, args['dry-run'] === true, tracker) : { updated: 0 };

  if (!args['dry-run']) {
    try {
      atomicWrite(trackerPath, `${JSON.stringify(tracker, null, 2)}\n`);
      if (rtm) atomicWrite(rtmPath, `${JSON.stringify(rtm, null, 2)}\n`);
    } catch (e) {
      process.stderr.write(`[rebalance-apply] write failed: ${e.message}\n`);
      process.exit(1);
    }
  }

  const summary = {
    applied: trackerResult.applied,
    skipped: trackerResult.skipped?.length ?? 0,
    rtmUpdated: rtmResult.updated,
    dryRun: args['dry-run'] === true,
    trackerPath: path.relative(projectRoot, trackerPath).split(path.sep).join('/'),
    rtmPath: rtm ? path.relative(projectRoot, rtmPath).split(path.sep).join('/') : null,
  };
  if (args.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(
      `[rebalance-apply] applied ${summary.applied} story move(s)` +
        ` (skipped ${summary.skipped}); rtm updates: ${summary.rtmUpdated}` +
        `${summary.dryRun ? ' [DRY RUN]' : ''}\n`,
    );
    process.stdout.write(
      'Next: regenerate epics.md / milestones.md (Skill cobolt-create-epics-and-stories --autonomous).\n',
    );
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = {
  applyMovesToTracker,
  applyMovesToRtm,
  normalizeMilestoneId,
  parseArgs,
};
