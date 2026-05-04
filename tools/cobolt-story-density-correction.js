#!/usr/bin/env node
// cobolt-story-density-correction — warning-zone density detector + redispatch planner.
//
// Purpose
//   The preflight density validators (cobolt-preflight.js) classify each milestone
//   and epic as ok / warning / failed. The hard failures (status=failed) are already
//   blocked by axisStoryDensity / axisEpicDensity in cobolt-plan-output-audit.js.
//   The warning-zone entries (status=warning: FR/story ∈ (2, 3], or stories/epic
//   outside 2-4 target) historically went unenforced — the plan pipeline shipped
//   with a reduced D3 score but no retry attempt.
//
//   This tool closes that gap by:
//   1. Running the existing density validators.
//   2. Emitting density-state.json for the orchestrator (always — even when clean).
//   3. Emitting density-redispatch.json with a concrete correctionPrompt when any
//      warning-zone entry exists and no prior attempt has been recorded.
//
// Contract
//   The orchestrator (cobolt-plan step 21c) reads density-state.json. If
//   warningCount > 0 AND redispatchAttempts == 0, it re-invokes
//   cobolt-create-epics-and-stories with --redispatch-plan pointing at
//   density-redispatch.json, which contains per-milestone/per-epic split guidance.
//
//   After the skill returns, the orchestrator calls this tool again. This run
//   increments redispatchAttempts based on prior state. If the warning zone is
//   still non-empty at attempts >= 1, the orchestrator records carry-forward debt
//   via cobolt-planning-debt.js and proceeds — hard limits (>3 FR/story) would
//   have been caught by the Tier 1 gate earlier.
//
// Exit codes (per tools/CLAUDE.md contract)
//   0 — success (including warning detected + redispatch plan written).
//   1 — hard error: missing planning dir, unreadable inputs, invariant violated.
//   2/3 — n/a (no optional deps, no external infra).

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ROOT = process.cwd();

function parseCliArgs(argv) {
  const args = { target: null, json: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--target' && argv[i + 1]) {
      args.target = argv[++i];
    } else if (v === '--json') {
      args.json = true;
    } else if (v === '--dry-run') {
      args.dryRun = true;
    } else if (v === '--help' || v === '-h') {
      args.help = true;
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: cobolt-story-density-correction [--target <dir>] [--json] [--dry-run]

Emits a warning-zone density redispatch plan to
_cobolt-output/latest/planning/density-redispatch.json (when applicable)
and always emits _cobolt-output/latest/planning/density-state.json for the
plan orchestrator at step 21c.

Options:
  --target <dir>   Project root (defaults to cwd)
  --json           Print the full state object to stdout as JSON
  --dry-run        Do not write any files; print what would be written
  --help, -h       Show this help and exit 0
`);
}

function resolvePlanningDir(root) {
  const latest = path.join(root, '_cobolt-output', 'latest', 'planning');
  if (fs.existsSync(latest)) return latest;
  // Fall through — PreflightChecker has its own discovery path; we only use this
  // dir for writing the state files. If not present, we refuse to run.
  return null;
}

function safeReadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function loadPriorState(planningDir) {
  const p = path.join(planningDir, 'density-state.json');
  const prior = safeReadJson(p);
  if (!prior || typeof prior !== 'object') return null;
  return prior;
}

function classifyMilestones(storyDensityResult) {
  const milestones = Array.isArray(storyDensityResult?.milestones) ? storyDensityResult.milestones : [];
  const clean = milestones.filter((m) => m.status === 'ok').map((m) => m.id);
  const warning = milestones.filter((m) => m.status === 'warning');
  const hardFail = milestones.filter((m) => m.status === 'failed');
  return { clean, warning, hardFail, all: milestones };
}

function classifyEpics(epicDensityResult) {
  const epics = Array.isArray(epicDensityResult?.epics) ? epicDensityResult.epics : [];
  const clean = epics.filter((e) => e.status === 'ok').map((e) => e.id);
  const warning = epics.filter((e) => e.status === 'warning');
  const hardFail = epics.filter((e) => e.status === 'failed');
  return { clean, warning, hardFail, all: epics };
}

function topDenseStoryIds(milestone, limit = 3) {
  // Heuristic: surface up to `limit` story IDs from the milestone as split hints.
  // The producer skill will decide which to split; this just names specific targets
  // instead of leaving the correction prompt generic.
  const ids = Array.isArray(milestone?.storyIds) ? milestone.storyIds : [];
  return ids.slice(0, limit);
}

function buildMilestoneCorrectionLine(milestone, targetMaxFrPerStory) {
  const storyHints = topDenseStoryIds(milestone);
  const hintText = storyHints.length
    ? `Priority candidates to split: ${storyHints.join(', ')}.`
    : 'Review all stories in this milestone for FR bundles that can be separated.';
  const avg = milestone.avgFrPerStory ?? 'n/a';
  return (
    `- ${milestone.id}: ${milestone.frCount} FRs across ${milestone.storyCount} stories ` +
    `(avg ${avg} FR/story). Split at least one story so average drops to <=${targetMaxFrPerStory}. ${hintText}`
  );
}

function buildEpicCorrectionLine(epic, targetMaxFrPerStory) {
  const avg = epic.avgFrPerStory ?? 'n/a';
  return (
    `- ${epic.id}: ${epic.storyCount} stories / ${epic.frCount} FRs ` +
    `(avg ${avg} FR/story). Split one story or reduce scope so average drops to <=${targetMaxFrPerStory}.`
  );
}

function buildCorrectionPrompt(warningMilestones, warningEpics, targets) {
  const lines = [];
  lines.push(
    'Tighten story density in the milestones and epics listed below. These are in the WARNING zone — ' +
      `FR-per-story exceeds the preferred max ${targets.frPerStoryWarning} but is within the hard limit ${targets.frPerStoryHardLimit}.`,
  );
  lines.push('');
  lines.push('Rules for this correction pass:');
  lines.push('- Split only the named stories. Do NOT rewrite clean epics or milestones.');
  lines.push(
    '- Preserve FR coverage. If a story covers [FR-A, FR-B, FR-C], produce 2 stories that together still cover all three FRs.',
  );
  lines.push('- Keep milestone story counts within the hard upper bound (10 per milestone, 6 per epic).');
  lines.push('- Keep each new story at 1-2 FRs; never exceed the hard limit of 3.');
  lines.push('- Preserve story IDs for untouched stories. For new stories, follow the E{n}-S{m} sequence.');
  lines.push('');

  if (warningMilestones.length > 0) {
    lines.push('Milestones in warning zone:');
    for (const m of warningMilestones) {
      lines.push(buildMilestoneCorrectionLine(m, targets.frPerStoryWarning));
    }
    lines.push('');
  }
  if (warningEpics.length > 0) {
    lines.push('Epics in warning zone:');
    for (const e of warningEpics) {
      lines.push(buildEpicCorrectionLine(e, targets.frPerStoryWarning));
    }
    lines.push('');
  }

  lines.push(
    'After applying the splits, re-run the internal density gate (cobolt-plan-output-audit A22/A23) and return control. Do NOT enter an internal retry loop — the orchestrator owns the retry budget.',
  );
  return lines.join('\n');
}

function atomicWriteJson(filePath, obj) {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, filePath);
}

function runCorrection({ root, json, dryRun }) {
  const planningDir = resolvePlanningDir(root);
  if (!planningDir) {
    const msg = `STORY DENSITY CORRECTION: planning directory not found at ${path.join(root, '_cobolt-output/latest/planning')}. Run /cobolt-plan first.`;
    if (json) {
      console.log(JSON.stringify({ ok: false, error: 'no-planning-dir', message: msg }, null, 2));
    } else {
      console.error(msg);
    }
    return 1;
  }

  let PreflightChecker;
  try {
    ({ PreflightChecker } = require('./cobolt-preflight.js'));
  } catch (err) {
    const msg = `STORY DENSITY CORRECTION: failed to load cobolt-preflight.js — ${err.message}`;
    if (json) {
      console.log(JSON.stringify({ ok: false, error: 'preflight-unavailable', message: msg }, null, 2));
    } else {
      console.error(msg);
    }
    return 1;
  }

  const checker = new PreflightChecker(root);
  const storyDensity = checker.validateMilestoneStoryDensity();
  const epicDensity = checker.validateEpicDensity();

  const mBuckets = classifyMilestones(storyDensity);
  const eBuckets = classifyEpics(epicDensity);

  const warningCount = mBuckets.warning.length + eBuckets.warning.length;
  const hardFailCount = mBuckets.hardFail.length + eBuckets.hardFail.length;
  const cleanCount = mBuckets.clean.length + eBuckets.clean.length;

  const prior = loadPriorState(planningDir);
  const priorAttempts = Number.isInteger(prior?.redispatchAttempts) ? prior.redispatchAttempts : 0;
  // The orchestrator is the owner of the attempt counter. We increment only when
  // a redispatch.json already exists from a prior run and we still see warnings —
  // that signals the skill has taken one round at our guidance and this is the
  // post-retry check. On fresh runs (no prior state, no prior redispatch file),
  // attempts stay at 0.
  const redispatchFilePath = path.join(planningDir, 'density-redispatch.json');
  const redispatchFileExistedBefore = fs.existsSync(redispatchFilePath);
  const redispatchAttempts = redispatchFileExistedBefore ? priorAttempts + 1 : priorAttempts;

  const targets = {
    frPerStoryWarning: storyDensity.targets?.frPerStory?.warning ?? 2,
    frPerStoryHardLimit: storyDensity.targets?.frPerStory?.hardLimit ?? 3,
    storyCountMin: storyDensity.targets?.storyCount?.min ?? 3,
    storyCountMax: storyDensity.targets?.storyCount?.max ?? 6,
    storyCountHardMax: storyDensity.targets?.storyCount?.hardMax ?? 10,
    storiesPerEpicMin: epicDensity.thresholds?.storiesPerEpic?.min ?? 2,
    storiesPerEpicMax: epicDensity.thresholds?.storiesPerEpic?.max ?? 4,
    storiesPerEpicHardLimit: epicDensity.thresholds?.storiesPerEpic?.hardLimit ?? 6,
  };

  const state = {
    version: 1,
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-story-density-correction',
    planningDir: path.relative(root, planningDir).replaceAll('\\', '/'),
    cleanCount,
    warningCount,
    hardFailCount,
    redispatchAttempts,
    targets,
    milestones: {
      clean: mBuckets.clean,
      warning: mBuckets.warning.map((m) => ({
        id: m.id,
        frCount: m.frCount,
        storyCount: m.storyCount,
        avgFrPerStory: m.avgFrPerStory,
        storyIds: m.storyIds,
        advisories: m.advisories,
      })),
      hardFail: mBuckets.hardFail.map((m) => ({ id: m.id, failures: m.failures })),
    },
    epics: {
      clean: eBuckets.clean,
      warning: eBuckets.warning.map((e) => ({
        id: e.id,
        frCount: e.frCount,
        storyCount: e.storyCount,
        avgFrPerStory: e.avgFrPerStory,
        advisories: e.advisories,
      })),
      hardFail: eBuckets.hardFail.map((e) => ({ id: e.id, failures: e.failures })),
    },
  };

  // Decide whether to emit a redispatch plan on this run.
  //   - Clean (no warnings) → no plan.
  //   - Warnings present, no prior plan → emit fresh plan.
  //   - Warnings present, prior plan exists → this is the post-retry verification;
  //     do NOT emit a second plan. The orchestrator will record carry-forward.
  const shouldEmitRedispatch = warningCount > 0 && !redispatchFileExistedBefore;
  let redispatchPlan = null;
  if (shouldEmitRedispatch) {
    redispatchPlan = {
      version: 1,
      generatedAt: state.generatedAt,
      generatedBy: 'cobolt-story-density-correction',
      skill: 'cobolt-create-epics-and-stories',
      redispatchCount: 0,
      redispatches: [
        {
          skill: 'cobolt-create-epics-and-stories',
          reason: 'warning-zone-density',
          correctionPrompt: buildCorrectionPrompt(mBuckets.warning, eBuckets.warning, targets),
          targets: {
            milestones: mBuckets.warning.map((m) => ({
              id: m.id,
              frCount: m.frCount,
              storyCount: m.storyCount,
              avgFrPerStory: m.avgFrPerStory,
              storyIds: m.storyIds,
            })),
            epics: eBuckets.warning.map((e) => ({
              id: e.id,
              frCount: e.frCount,
              storyCount: e.storyCount,
              avgFrPerStory: e.avgFrPerStory,
            })),
          },
        },
      ],
    };
  }

  const statePath = path.join(planningDir, 'density-state.json');

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          state,
          redispatchPlan,
          wouldWrite: [statePath, shouldEmitRedispatch ? redispatchFilePath : null].filter(Boolean),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  atomicWriteJson(statePath, state);
  if (shouldEmitRedispatch) {
    atomicWriteJson(redispatchFilePath, redispatchPlan);
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          state,
          redispatchPlanEmitted: shouldEmitRedispatch,
          statePath: path.relative(root, statePath).replaceAll('\\', '/'),
          redispatchPath: shouldEmitRedispatch ? path.relative(root, redispatchFilePath).replaceAll('\\', '/') : null,
        },
        null,
        2,
      ),
    );
  } else {
    if (warningCount === 0 && hardFailCount === 0) {
      console.log(
        `[story-density-correction] clean — ${cleanCount} milestone(s)+epic(s) within target; no redispatch needed.`,
      );
    } else if (shouldEmitRedispatch) {
      console.log(
        `[story-density-correction] ${warningCount} warning-zone entr(y|ies) detected; redispatch plan written to ${path.relative(
          root,
          redispatchFilePath,
        )}.`,
      );
    } else if (warningCount > 0 && redispatchFileExistedBefore) {
      console.log(
        `[story-density-correction] ${warningCount} warning-zone entr(y|ies) persist after redispatch attempt ${redispatchAttempts}; orchestrator should record carry-forward.`,
      );
    }
    if (hardFailCount > 0) {
      console.log(
        `[story-density-correction] WARNING: ${hardFailCount} hard-fail entr(y|ies) present — the Tier 1 A22/A23 gate should have already blocked; density-correction is advisory only.`,
      );
    }
  }

  return 0;
}

if (require.main === module) {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  const root = args.target ? path.resolve(args.target) : DEFAULT_ROOT;
  const rc = runCorrection({ root, json: args.json, dryRun: args.dryRun });
  process.exit(rc);
}

module.exports = {
  runCorrection,
  buildCorrectionPrompt,
  classifyMilestones,
  classifyEpics,
  parseCliArgs,
};
