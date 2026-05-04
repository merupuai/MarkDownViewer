#!/usr/bin/env node

// CoBolt Planning Census (v0.22.8) — symmetric cross-artifact parity checks
// for the planning pipeline. Closes three drift gaps identified in the
// production-readiness audit:
//
//   1. sprint-status.yaml coverage — every story in story-tracker.json is in
//      sprint-status.yaml (and vice-versa). Empty status is OK; orphans block.
//   2. milestone-tracker census — every milestone in milestones.md is in
//      milestone-tracker.json. Drift in either direction is surfaced.
//   3. milestone ceiling — hard floor of 3 already enforced elsewhere; this
//      tool adds a symmetric hard ceiling (default 20 single-context / 8 per
//      BC for multi-context) to catch over-decomposed plans.
//
// Usage:
//   node tools/cobolt-planning-census.js check [--json] [--dir <path>]
//   node tools/cobolt-planning-census.js sprint [--json] [--dir <path>]
//   node tools/cobolt-planning-census.js milestones [--json] [--dir <path>]
//   node tools/cobolt-planning-census.js ceiling [--json] [--dir <path>]
//
// Exit codes:
//   0 — all census checks pass
//   1 — census violations detected (one or more orphans / drift / over-ceiling)
//   2 — usage error
//   3 — required input missing (e.g., no planning dir)

const fs = require('node:fs');
const path = require('node:path');
const { canonicalTrackerStories } = require('../lib/cobolt-planning-artifacts');

const DEFAULT_MILESTONE_CEILING_SINGLE_CONTEXT = 20;
const DEFAULT_MILESTONE_CEILING_PER_BC = 8;
const DEFAULT_MILESTONE_FLOOR = 3;

function parseArgs(argv) {
  const out = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const next = argv[i + 1];
        if (next != null && !next.startsWith('--')) {
          out.flags[a.slice(2)] = next;
          i += 1;
        } else out.flags[a.slice(2)] = true;
      }
    } else out.positional.push(a);
  }
  return out;
}

function planningDir(projectRoot) {
  return path.join(projectRoot, '_cobolt-output', 'latest', 'planning');
}

function loadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function loadText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function parseYamlLite(text) {
  // Minimal parser — we only need top-level keys and flat list contents.
  // We extract story IDs from lines like `  - STORY-001: <title>` or
  // `    id: STORY-001` or `    id: E1-S1`.
  // Canonical forms emitted by cobolt-sprint-plan / cobolt-tracker-init
  // include `E<n>-S<m>` — match that BEFORE the bare `S-?\d+` pattern so
  // we don't strip the epic prefix and produce phantom short-IDs.
  // CB-OBS-13: LANDING-S{N} is also canonical (auto-injected via
  // cobolt-story-gen) — match it explicitly so the census does not
  // truncate "LANDING-S1" to "S1".
  if (!text) return { stories: new Set() };
  const stories = new Set();
  const storyIdRe = /\b(STORY-[\dA-Z]+|LANDING-S\d+|E[A-Z0-9_]+-S\d+|M\d+-S\d+|S-?\d+)\b/g;
  let m;
  while ((m = storyIdRe.exec(text)) !== null) stories.add(m[1]);
  return { stories };
}

function parseMilestonesMd(text) {
  // Look for lines like `## M1: ...` or `### M-2 ...` or `- [ ] M3 — ...`
  if (!text) return new Set();
  const ids = new Set();
  const re = /\b(M-?\d+)\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    // normalize M-1 → M1
    const id = m[1].toUpperCase().replace('-', '');
    // Only accept when it looks like a milestone ID (≤4 digits)
    if (/^M\d{1,4}$/.test(id)) ids.add(id);
  }
  return ids;
}

function loadMilestoneTrackerIds(projectRoot) {
  const p = path.join(projectRoot, '_cobolt-output', 'latest', 'planning', 'milestone-tracker.json');
  const data = loadJson(p);
  if (!data) return { present: false, ids: new Set(), path: p };
  const ids = new Set();
  const src = data.milestones || data.items || data;
  if (Array.isArray(src)) {
    for (const m of src) {
      const id = m?.id || m?.milestoneId || m?.name;
      if (id) ids.add(String(id).toUpperCase());
    }
  } else if (src && typeof src === 'object') {
    for (const k of Object.keys(src)) ids.add(String(k).toUpperCase());
  }
  return { present: true, ids, path: p };
}

function loadBoundedContexts(projectRoot) {
  const p = path.join(projectRoot, '_cobolt-output', 'latest', 'planning', 'bounded-contexts.json');
  const data = loadJson(p);
  if (!data) return { present: false, count: 1 };
  const bcs = data.boundedContexts || data.contexts || data.items || [];
  if (Array.isArray(bcs)) return { present: true, count: bcs.length || 1 };
  if (bcs && typeof bcs === 'object') return { present: true, count: Object.keys(bcs).length || 1 };
  return { present: true, count: 1 };
}

function sprintCheck(projectRoot) {
  const base = planningDir(projectRoot);
  const sprintPath = path.join(base, 'sprint-status.yaml');
  const trackerPath = path.join(base, 'story-tracker.json');

  if (!fs.existsSync(sprintPath)) {
    return {
      ok: false,
      code: 'sprint-status-missing',
      reason: 'sprint-status.yaml not found — cobolt-sprint-planning has not run yet',
      path: sprintPath,
    };
  }
  if (!fs.existsSync(trackerPath)) {
    return {
      ok: false,
      code: 'story-tracker-missing',
      reason: 'story-tracker.json not found — cannot census sprint coverage',
      path: trackerPath,
    };
  }

  const sprint = parseYamlLite(loadText(sprintPath));
  const tracker = loadJson(trackerPath) || {};
  const expected = new Set(
    Array.isArray(tracker.expectedStoryIds)
      ? tracker.expectedStoryIds
      : Array.isArray(tracker.stories)
        ? canonicalTrackerStories(tracker.stories)
            .map((story) => story?.id || story)
            .filter(Boolean)
        : [],
  );

  const inTrackerNotInSprint = [...expected].filter((id) => !sprint.stories.has(id));
  const inSprintNotInTracker = [...sprint.stories].filter((id) => !expected.has(id));

  const orphans = {
    inTrackerNotInSprint,
    inSprintNotInTracker,
  };
  const ok = inTrackerNotInSprint.length === 0 && inSprintNotInTracker.length === 0;
  return {
    ok,
    code: ok ? 'ok' : 'sprint-story-drift',
    expected: expected.size,
    inSprint: sprint.stories.size,
    orphans,
    reason: ok
      ? `sprint-status covers all ${expected.size} stories`
      : `${inTrackerNotInSprint.length} stories missing from sprint, ${inSprintNotInTracker.length} phantom in sprint`,
  };
}

function milestoneCheck(projectRoot) {
  const base = planningDir(projectRoot);
  const milestonesMdPath = path.join(base, 'milestones.md');

  if (!fs.existsSync(milestonesMdPath)) {
    return {
      ok: false,
      code: 'milestones-md-missing',
      reason: 'milestones.md not found — planning not complete',
      path: milestonesMdPath,
    };
  }

  const mdIds = parseMilestonesMd(loadText(milestonesMdPath));
  const tracker = loadMilestoneTrackerIds(projectRoot);

  if (!tracker.present) {
    return {
      ok: false,
      code: 'milestone-tracker-missing',
      reason: 'milestone-tracker.json absent — tracker must register every milestone',
      path: tracker.path,
      mdCount: mdIds.size,
    };
  }

  const inMdNotInTracker = [...mdIds].filter((id) => !tracker.ids.has(id));
  const inTrackerNotInMd = [...tracker.ids].filter((id) => !mdIds.has(id));
  const ok = inMdNotInTracker.length === 0 && inTrackerNotInMd.length === 0;

  return {
    ok,
    code: ok ? 'ok' : 'milestone-tracker-drift',
    mdCount: mdIds.size,
    trackerCount: tracker.ids.size,
    inMdNotInTracker,
    inTrackerNotInMd,
    reason: ok
      ? `milestone-tracker covers all ${mdIds.size} milestones from milestones.md`
      : `tracker drift: ${inMdNotInTracker.length} missing from tracker, ${inTrackerNotInMd.length} phantom in tracker`,
  };
}

function ceilingCheck(projectRoot, opts = {}) {
  const base = planningDir(projectRoot);
  const milestonesMdPath = path.join(base, 'milestones.md');
  if (!fs.existsSync(milestonesMdPath)) {
    return {
      ok: false,
      code: 'milestones-md-missing',
      reason: 'milestones.md not found',
      path: milestonesMdPath,
    };
  }
  const mdIds = parseMilestonesMd(loadText(milestonesMdPath));
  const bcs = loadBoundedContexts(projectRoot);
  const isMultiBc = bcs.count > 1;
  const ceiling = isMultiBc
    ? bcs.count * (opts.perBc || DEFAULT_MILESTONE_CEILING_PER_BC)
    : opts.single || DEFAULT_MILESTONE_CEILING_SINGLE_CONTEXT;
  const floor = opts.floor || DEFAULT_MILESTONE_FLOOR;

  const count = mdIds.size;
  let ok = true;
  const violations = [];
  if (count < floor) {
    ok = false;
    violations.push({
      kind: 'below-floor',
      actual: count,
      threshold: floor,
      message: `milestones.md declares ${count} milestone(s); minimum is ${floor}. Under-decomposition hides milestone boundaries.`,
    });
  }
  if (count > ceiling) {
    ok = false;
    violations.push({
      kind: 'over-ceiling',
      actual: count,
      threshold: ceiling,
      message: isMultiBc
        ? `milestones.md declares ${count} milestone(s) across ${bcs.count} bounded context(s); ceiling is ${ceiling} (${opts.perBc || DEFAULT_MILESTONE_CEILING_PER_BC}/BC). Over-decomposition fragments delivery.`
        : `milestones.md declares ${count} milestone(s); single-context ceiling is ${ceiling}. Consider decomposing into bounded contexts or consolidating.`,
    });
  }
  return {
    ok,
    code: ok ? 'ok' : 'milestone-ceiling-violation',
    count,
    floor,
    ceiling,
    boundedContexts: bcs.count,
    multiBc: isMultiBc,
    violations,
  };
}

function runAll(projectRoot, opts = {}) {
  return {
    sprint: sprintCheck(projectRoot),
    milestones: milestoneCheck(projectRoot),
    ceiling: ceilingCheck(projectRoot, opts),
  };
}

function renderHuman(report) {
  const lines = [];
  const okAll = report.sprint.ok && report.milestones.ok && report.ceiling.ok;
  lines.push(`\n[planning-census] ${okAll ? 'PASS' : 'FAIL'}`);
  lines.push('');
  lines.push(`Sprint coverage: ${report.sprint.ok ? '[OK]' : '[!!]'} ${report.sprint.reason}`);
  if (!report.sprint.ok && report.sprint.orphans) {
    if (report.sprint.orphans.inTrackerNotInSprint?.length) {
      lines.push(`  stories missing from sprint-status.yaml:`);
      for (const id of report.sprint.orphans.inTrackerNotInSprint.slice(0, 20)) {
        lines.push(`    - ${id}`);
      }
      if (report.sprint.orphans.inTrackerNotInSprint.length > 20) {
        lines.push(`    ... and ${report.sprint.orphans.inTrackerNotInSprint.length - 20} more`);
      }
    }
    if (report.sprint.orphans.inSprintNotInTracker?.length) {
      lines.push(`  phantom stories in sprint-status.yaml (not in tracker):`);
      for (const id of report.sprint.orphans.inSprintNotInTracker.slice(0, 20)) {
        lines.push(`    - ${id}`);
      }
    }
  }
  lines.push('');
  lines.push(`Milestone tracker: ${report.milestones.ok ? '[OK]' : '[!!]'} ${report.milestones.reason}`);
  if (!report.milestones.ok) {
    if (report.milestones.inMdNotInTracker?.length) {
      lines.push(`  missing from milestone-tracker.json:`);
      for (const id of report.milestones.inMdNotInTracker) lines.push(`    - ${id}`);
    }
    if (report.milestones.inTrackerNotInMd?.length) {
      lines.push(`  phantom in milestone-tracker.json:`);
      for (const id of report.milestones.inTrackerNotInMd) lines.push(`    - ${id}`);
    }
  }
  lines.push('');
  if (report.ceiling.code === 'milestones-md-missing') {
    lines.push(`Milestone count: [--] ${report.ceiling.reason}`);
  } else {
    lines.push(
      `Milestone count: ${report.ceiling.ok ? '[OK]' : '[!!]'} ${report.ceiling.count} milestones ` +
        `(floor ${report.ceiling.floor}, ceiling ${report.ceiling.ceiling}, bounded-contexts ${report.ceiling.boundedContexts})`,
    );
  }
  if (!report.ceiling.ok && report.ceiling.violations) {
    for (const v of report.ceiling.violations) lines.push(`  [!!] ${v.message}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function main(argv = process.argv.slice(2)) {
  // Tool-exit-contract: --help/-h short-circuit before parseArgs.
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      'usage: cobolt-planning-census <check|sprint|milestones|ceiling> [--dir <path>] [--json] [--floor N] [--single N] [--per-bc N]\n',
    );
    return 0;
  }
  const parsed = parseArgs(argv);
  const cmd = parsed.positional[0] || 'check';
  const projectRoot = parsed.flags.dir ? path.resolve(parsed.flags.dir) : process.cwd();
  const opts = {
    floor: parsed.flags.floor ? Number(parsed.flags.floor) : undefined,
    single: parsed.flags.single ? Number(parsed.flags.single) : undefined,
    perBc: parsed.flags['per-bc'] ? Number(parsed.flags['per-bc']) : undefined,
  };

  let report;
  if (cmd === 'check') report = runAll(projectRoot, opts);
  else if (cmd === 'sprint')
    report = { sprint: sprintCheck(projectRoot), milestones: { ok: true }, ceiling: { ok: true } };
  else if (cmd === 'milestones')
    report = { sprint: { ok: true }, milestones: milestoneCheck(projectRoot), ceiling: { ok: true } };
  else if (cmd === 'ceiling')
    report = { sprint: { ok: true }, milestones: { ok: true }, ceiling: ceilingCheck(projectRoot, opts) };
  else if (cmd === '--help' || cmd === '-h') {
    process.stdout.write(
      'usage: cobolt-planning-census <check|sprint|milestones|ceiling> [--dir <path>] [--json] [--floor N] [--single N] [--per-bc N]\n',
    );
    return 0;
  } else {
    process.stderr.write(`unknown subcommand: ${cmd}\n`);
    return 1;
  }

  if (parsed.flags.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(renderHuman(report));
  }

  // Any violation fails the run.
  if (!report.sprint.ok || !report.milestones.ok || !report.ceiling.ok) {
    // Sprint/milestones missing inputs count as missing-dependency (exit 3);
    // drift/ceiling count as census violation (exit 1).
    const anyMissingInput = [report.sprint.code, report.milestones.code, report.ceiling.code].some((c) =>
      ['sprint-status-missing', 'story-tracker-missing', 'milestones-md-missing', 'milestone-tracker-missing'].includes(
        c,
      ),
    );
    return anyMissingInput ? 3 : 1;
  }
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  sprintCheck,
  milestoneCheck,
  ceilingCheck,
  runAll,
  parseYamlLite,
  parseMilestonesMd,
  DEFAULT_MILESTONE_CEILING_SINGLE_CONTEXT,
  DEFAULT_MILESTONE_CEILING_PER_BC,
  DEFAULT_MILESTONE_FLOOR,
  main,
};
