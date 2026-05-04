#!/usr/bin/env node

// CoBolt Plan Refresh — close the late-materialization ordering bug
//
// Problem this closes:
//   During /cobolt-plan, deterministic renderers (render-matrix, sprint-plan
//   generate) run in the middle of Phase 4/5 while RTM mappings and story
//   files are still being populated. The outputs therefore freeze stale data
//   (e.g. traceability-matrix.md with every Milestone/Epic/Story column as
//   `-`, sprint-status.yaml with `storyFile: null` for every story). Later
//   mapping + story-file writes never trigger a refresh, so the artifacts
//   ship broken.
//
// What this tool does:
//   Runs the two idempotent deterministic renderers at plan-close AFTER all
//   upstream data (rtm.json, stories/, story-tracker.json) is materialized:
//     1. node tools/cobolt-rtm.js render-matrix   → traceability-matrix.md
//     2. node tools/cobolt-sprint-plan.js generate → sprint-status.yaml
//   Optionally detects staleness via mtime comparison and only refreshes
//   outputs that are older than their inputs.
//
// Usage:
//   node tools/cobolt-plan-refresh.js run [--project <dir>] [--json] [--force]
//   node tools/cobolt-plan-refresh.js check [--project <dir>] [--json]
//
// Exit codes:
//   0 = success
//   1 = hard error
//   2 = missing required input (no rtm.json, no epics.md, etc.)

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RENDERERS = [
  {
    id: 'story-tracker',
    output: 'story-tracker.json',
    inputs: ['epics.md', 'milestones.md'],
    watchDirs: ['stories'],
    tool: 'cobolt-tracker-init.js',
    args: ['generate'],
  },
  {
    id: 'traceability-matrix',
    output: 'traceability-matrix.md',
    inputs: ['rtm.json'],
    tool: 'cobolt-rtm.js',
    args: ['render-matrix'],
  },
  {
    id: 'readiness-deterministic',
    output: 'readiness-deterministic.json',
    inputs: ['rtm.json', 'epics.md', 'milestones.md', 'story-tracker.json', 'feature-registry.json'],
    watchDirs: ['stories'],
    tool: 'cobolt-readiness-check.js',
    args: ['check', '--json'],
  },
  {
    id: 'readiness-report',
    output: 'readiness-report.md',
    inputs: ['readiness-deterministic.json'],
    tool: 'cobolt-readiness-render.js',
    args: ['render'],
  },
  {
    id: 'sprint-status',
    output: 'sprint-status.yaml',
    inputs: ['epics.md', 'story-tracker.json', 'milestones.md'],
    watchDirs: ['stories'],
    tool: 'cobolt-sprint-plan.js',
    args: ['generate'],
  },
  {
    id: 'master-plan',
    output: 'master-plan.md',
    inputs: [
      'epics.md',
      'story-tracker.json',
      'milestone-tracker.json',
      'feature-registry.json',
      'rtm.json',
      'readiness-deterministic.json',
      'readiness-report.json',
      'sprint-status.yaml',
    ],
    watchDirs: ['stories'],
    tool: 'cobolt-master-plan-reconcile.js',
    args: ['reconcile'],
  },
];

function parseArgs(argv) {
  const out = { command: 'run', project: process.cwd(), json: false, force: false, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--json') out.json = true;
    else if (a === '--force') out.force = true;
    else if (a === '--project' || a === '--root' || a === '--dir') {
      out.project = argv[i + 1] || out.project;
      i += 1;
    } else if (a.startsWith('--project=')) out.project = a.slice('--project='.length);
    else if (a.startsWith('--dir=')) out.project = a.slice('--dir='.length);
    else if (a.startsWith('--')) out.unknown = a;
    else positional.push(a);
  }
  if (positional.length > 0) out.command = positional[0];
  return out;
}

function printUsage() {
  console.log('Usage: node tools/cobolt-plan-refresh.js [run|check] [--project <dir>] [--json] [--force]');
  console.log();
  console.log('Re-runs late-bound planning projections at plan-close so stale artifacts pick');
  console.log('up final tracker census, RTM mappings, readiness outputs, and master-plan counts.');
}

function resolvePlanningDir(projectRoot) {
  const candidates = [
    path.join(projectRoot, '_cobolt-output', 'latest', 'planning'),
    path.join(projectRoot, '_cobolt-output', 'planning'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
  }
  // v0.40+ run-pointer fallback: CoboltPaths#latestPlanning() resolves via
  // _cobolt-output/latest (symlink) and then _cobolt-output/latest.ptr.
  // This handles layouts where only runs/<day>/run-NNN/planning exists on
  // disk and latest is a text pointer instead of a symlink.
  try {
    const { CoboltPaths } = require('../lib/cobolt-paths');
    const p = new CoboltPaths(projectRoot);
    const dir = p.latestPlanning();
    if (dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
  } catch {
    /* fallthrough */
  }
  return null;
}

function stat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function isStale(renderer, planningDir) {
  const outStat = stat(path.join(planningDir, renderer.output));
  if (!outStat) return { stale: true, reason: 'output missing' };
  for (const rel of renderer.inputs) {
    const s = stat(path.join(planningDir, rel));
    if (!s) continue;
    if (s.mtimeMs > outStat.mtimeMs) {
      return {
        stale: true,
        reason: `input ${rel} newer than output (${Math.round((s.mtimeMs - outStat.mtimeMs) / 1000)}s)`,
      };
    }
  }
  for (const relDir of renderer.watchDirs || []) {
    const watchedDir = path.join(planningDir, relDir);
    const watchedDirStat = stat(watchedDir);
    if (watchedDirStat && watchedDirStat.mtimeMs > outStat.mtimeMs) {
      return { stale: true, reason: `${relDir}/ newer than ${renderer.output}` };
    }
    try {
      for (const entry of fs.readdirSync(watchedDir)) {
        const entryStat = stat(path.join(watchedDir, entry));
        if (entryStat?.isFile() && entryStat.mtimeMs > outStat.mtimeMs) {
          return { stale: true, reason: `${relDir} file ${entry} newer than ${renderer.output}` };
        }
      }
    } catch {
      /* ignore */
    }
  }
  return { stale: false };
}

function runTool(repoRoot, projectRoot, toolFile, args = []) {
  // Prefer repo-local tools/ over alternative locations. In the production install
  // the tool will live under the same repo the orchestrator called us from, so
  // walk the usual locations.
  const candidates = [
    path.join(repoRoot, 'tools', toolFile),
    path.join(projectRoot, 'tools', toolFile),
    path.join(__dirname, toolFile),
  ];
  const toolPath = candidates.find((c) => fs.existsSync(c));
  if (!toolPath) {
    return { ok: false, error: `tool ${toolFile} not found in ${candidates.join(', ')}` };
  }
  try {
    const out = execFileSync(process.execPath, [toolPath, ...(Array.isArray(args) ? args : [args])], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: out };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      code: err.status,
      stdout: String(err.stdout || ''),
      stderr: String(err.stderr || ''),
    };
  }
}

function refreshPlan(projectRoot, { force = false, repoRoot = null } = {}) {
  const root = path.resolve(projectRoot);
  const effectiveRepoRoot = repoRoot || findCoBoltRepoRoot(root);
  const planningDir = resolvePlanningDir(root);

  const report = {
    ok: false,
    projectRoot: root,
    planningDir,
    repoRoot: effectiveRepoRoot,
    force,
    refreshed: [],
    skipped: [],
    errors: [],
  };

  if (!planningDir) {
    report.errors.push({ code: 'PLAN_DIR_MISSING', message: 'No planning dir under _cobolt-output/' });
    return report;
  }

  for (const renderer of RENDERERS) {
    // Fail-closed when every canonical input is missing: we cannot regenerate
    // the output, and silently skipping would let the pipeline report refresh
    // success while producing nothing. A partially-present input set is still
    // treated as "try" (the underlying renderer will emit its own error).
    const missingInputs = renderer.inputs.filter((rel) => !fs.existsSync(path.join(planningDir, rel)));
    if (missingInputs.length === renderer.inputs.length) {
      report.errors.push({
        id: renderer.id,
        code: 'PRIMARY_INPUT_MISSING',
        reason: `required inputs missing: ${missingInputs.join(', ')}`,
      });
      continue;
    }

    const staleness = isStale(renderer, planningDir);
    if (!staleness.stale && !force) {
      report.skipped.push({ id: renderer.id, reason: 'output is fresh' });
      continue;
    }

    const result = runTool(effectiveRepoRoot, root, renderer.tool, renderer.args || renderer.subcommand);
    if (!result.ok) {
      report.errors.push({
        id: renderer.id,
        reason: result.error,
        code: result.code,
        stderr: result.stderr,
      });
      continue;
    }

    report.refreshed.push({
      id: renderer.id,
      output: renderer.output,
      reason: staleness.reason || (force ? 'force' : 'refreshed'),
    });
  }

  report.ok = report.errors.length === 0;
  return report;
}

function findCoBoltRepoRoot(startDir) {
  // Find the nearest ancestor that has tools/cobolt-rtm.js + tools/cobolt-sprint-plan.js.
  let dir = path.resolve(startDir);
  for (let i = 0; i < 6; i += 1) {
    if (
      fs.existsSync(path.join(dir, 'tools', 'cobolt-rtm.js')) &&
      fs.existsSync(path.join(dir, 'tools', 'cobolt-sprint-plan.js'))
    ) {
      return dir;
    }
    const next = path.dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  // Fall back to the CoBolt repo this tool ships from.
  return path.resolve(__dirname, '..');
}

function checkPlan(projectRoot) {
  const root = path.resolve(projectRoot);
  const planningDir = resolvePlanningDir(root);
  const report = {
    ok: true,
    projectRoot: root,
    planningDir,
    stale: [],
    fresh: [],
  };
  if (!planningDir) {
    report.ok = false;
    report.error = 'No planning dir under _cobolt-output/';
    return report;
  }
  for (const renderer of RENDERERS) {
    // Mirror refreshPlan: if every canonical input is missing, the output
    // cannot be trusted regardless of its mtime. Report stale with the
    // PRIMARY_INPUT_MISSING code so callers exit non-zero.
    const missingInputs = renderer.inputs.filter((rel) => !fs.existsSync(path.join(planningDir, rel)));
    if (missingInputs.length === renderer.inputs.length) {
      report.stale.push({
        id: renderer.id,
        output: renderer.output,
        code: 'PRIMARY_INPUT_MISSING',
        reason: `required inputs missing: ${missingInputs.join(', ')}`,
      });
      report.ok = false;
      continue;
    }

    const staleness = isStale(renderer, planningDir);
    if (staleness.stale) {
      report.stale.push({ id: renderer.id, output: renderer.output, reason: staleness.reason });
      report.ok = false;
    } else {
      report.fresh.push({ id: renderer.id, output: renderer.output });
    }
  }
  return report;
}

function printHuman(report) {
  console.log('CoBolt Plan Refresh');
  console.log(`Project:      ${report.projectRoot}`);
  console.log(`Planning dir: ${report.planningDir || '(unresolved)'}`);
  if (Array.isArray(report.refreshed)) {
    for (const r of report.refreshed) console.log(`  refreshed: ${r.id} — ${r.reason}`);
    for (const r of report.skipped) console.log(`  skipped:   ${r.id} — ${r.reason}`);
    for (const r of report.errors) console.log(`  error:     ${r.id}: ${r.reason}`);
  } else {
    for (const r of report.stale) console.log(`  STALE: ${r.id} (${r.output}) — ${r.reason}`);
    for (const r of report.fresh) console.log(`  fresh: ${r.id} (${r.output})`);
  }
  if (report.errors && report.errors.length > 0) {
    console.log();
    console.log(`Errors: ${report.errors.length}`);
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printUsage();
    return 0;
  }
  if (args.unknown) {
    console.error(`Unknown option: ${args.unknown}`);
    printUsage();
    return 1;
  }
  if (!['run', 'check'].includes(args.command)) {
    console.error(`Unknown command: ${args.command}`);
    printUsage();
    return 1;
  }

  const report = args.command === 'run' ? refreshPlan(args.project, { force: args.force }) : checkPlan(args.project);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }

  if (!report.ok) {
    if (!report.planningDir) return 2;
    if (report.errors?.some((e) => e.code === 'PLAN_DIR_MISSING')) return 2;
    return 1;
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  RENDERERS,
  refreshPlan,
  checkPlan,
  resolvePlanningDir,
  isStale,
  main,
};
