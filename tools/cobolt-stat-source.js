#!/usr/bin/env node

// CoBolt Stat Source — single source of truth for repo-actual counts (SF-02).
//
// Emits a JSON snapshot of agent / skill / hook / tool / schema / test-file counts
// from disk to _cobolt-output/stats/current.json. README, AGENTS.md, CLAUDE.md, and
// the README "tests" badge all consume this same numbers via syncStatArtifacts().
//
// Why this tool exists: prior to v0.57.0 the README test badge was hand-maintained
// and drifted (3538 → real ~7557); the marker blocks were synced by a script that
// nothing in CI checked. SF-02 unifies both surfaces under one drift gate that runs
// in `ci:node` and `.husky/pre-push`.
//
// Usage:
//   node tools/cobolt-stat-source.js               # --emit (default): write _cobolt-output/stats/current.json
//   node tools/cobolt-stat-source.js --emit        # explicit emit
//   node tools/cobolt-stat-source.js --emit --out path/to/file.json
//   node tools/cobolt-stat-source.js --print       # print JSON to stdout (no file)
//   node tools/cobolt-stat-source.js --check       # exit 1 if README/AGENTS/CLAUDE/badge drifted
//   node tools/cobolt-stat-source.js --sync        # rewrite drifted artifacts
//
// Programmatic:
//   const { collectStats, emitStatsFile, checkStatDrift, syncStatArtifacts } =
//     require('./cobolt-stat-source.js');

const fs = require('node:fs');
const path = require('node:path');

const TOOL_ROOT = path.join(__dirname, '..');

// scripts/sync-readme-stats.js already does the canonical disk read for the marker
// blocks. Reuse it here so we don't grow a second reader that drifts from the first.
const syncReadme = require(path.join(TOOL_ROOT, 'scripts', 'sync-readme-stats.js'));

const TEST_BADGE_PATTERN = /tests-\d+_(?:files|passing)/g;

// v0.65.2 — Stat badge sync extension. Closes drift class A from the
// post-Wave-5 audit: README header badges (Skills/Hooks/Tools/Schemas/etc.)
// drifted whenever a wave landed because stat-source.js only knew about
// `tests-N_files`. Each entry: { key, statField, badgePattern, expectedSuffix }.
//   key            — stable identifier used in detect/sync return shapes.
//   statField      — field on the SF-02 stats object (collectStats()).
//   badgePattern   — global regex matching every badge of this kind in README.
//                    Captures the integer; the full match is what gets replaced.
//   expectedSuffix — the badge label after the integer (e.g. "Pipeline_Skills").
//                    Used to construct the canonical replacement string and the
//                    drift-detection comparator.
const STAT_BADGE_RULES = [
  {
    key: 'agents',
    statField: 'agents',
    badgePattern: /badge\/\d+-Specialist_Agents/g,
    expectedSuffix: 'Specialist_Agents',
  },
  {
    key: 'skills',
    statField: 'skillDirs',
    badgePattern: /badge\/\d+-Pipeline_Skills/g,
    expectedSuffix: 'Pipeline_Skills',
  },
  { key: 'hooks', statField: 'hooks', badgePattern: /badge\/\d+-Lifecycle_Hooks/g, expectedSuffix: 'Lifecycle_Hooks' },
  {
    key: 'tools',
    statField: 'tools',
    badgePattern: /badge\/\d+-Deterministic_Tools/g,
    expectedSuffix: 'Deterministic_Tools',
  },
  { key: 'schemas', statField: 'schemas', badgePattern: /badge\/\d+-JSON_Schemas/g, expectedSuffix: 'JSON_Schemas' },
  {
    key: 'workflows',
    statField: 'publicWorkflows',
    badgePattern: /badge\/\d+-Public_Workflows/g,
    expectedSuffix: 'Public_Workflows',
  },
  {
    key: 'security',
    statField: 'securityRegistry',
    badgePattern: /badge\/\d+-Security_Tools/g,
    expectedSuffix: 'Security_Tools',
  },
  {
    key: 'quality',
    statField: 'qualityRegistry',
    badgePattern: /badge\/\d+-Quality_Tools/g,
    expectedSuffix: 'Quality_Tools',
  },
];

function expectedStatBadge(rule, stats) {
  return `badge/${stats[rule.statField]}-${rule.expectedSuffix}`;
}

// Returns { key, ok, expected, found, reason } per rule. ok:false when at
// least one match in README differs from `expected`. ok:true (matches:[])
// when the badge pattern is absent — absence is not drift; the badge just
// isn't on the page. Pre-existing behaviour preserved.
function detectStatBadgeDrift(rule, readme, stats) {
  const matches = readme.match(rule.badgePattern);
  const expected = expectedStatBadge(rule, stats);
  if (!matches || matches.length === 0) {
    return { key: rule.key, ok: true, expected, found: [], absent: true };
  }
  const allMatch = matches.every((m) => m === expected);
  return {
    key: rule.key,
    ok: allMatch,
    matches,
    found: matches,
    expected,
    reason: allMatch ? null : `${rule.expectedSuffix} badge expected "${expected}", saw ${JSON.stringify(matches)}`,
  };
}

function detectAllStatBadgeDrift(readme, stats) {
  return STAT_BADGE_RULES.map((rule) => detectStatBadgeDrift(rule, readme, stats));
}

function defaultRoot() {
  return process.env.COBOLT_REPO_ROOT || TOOL_ROOT;
}

function collectStats(rootDir = defaultRoot()) {
  const base = syncReadme.collectReadmeStats(rootDir);
  return {
    ...base,
    generatedAt: new Date().toISOString(),
    source: 'tools/cobolt-stat-source.js',
  };
}

function resolveDefaultOutputPath(rootDir) {
  const baseDir = process.env.COBOLT_STAT_SOURCE_OUTPUT_DIR || path.join(rootDir, '_cobolt-output');
  return path.join(baseDir, 'stats', 'current.json');
}

function emitStatsFile({ rootDir = defaultRoot(), outFile } = {}) {
  const stats = collectStats(rootDir);
  const target = outFile || resolveDefaultOutputPath(rootDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(stats, null, 2)}\n`, 'utf8');
  return { stats, path: target };
}

function readReadme(rootDir) {
  return fs.readFileSync(path.join(rootDir, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
}

function expectedTestBadge(stats) {
  return `tests-${stats.testFiles}_files`;
}

function detectTestBadgeDrift(rootDir, stats) {
  const readme = readReadme(rootDir);
  const matches = readme.match(TEST_BADGE_PATTERN);
  if (!matches) {
    return { ok: false, reason: 'README is missing a tests- badge', expected: expectedTestBadge(stats) };
  }
  const expected = expectedTestBadge(stats);
  const allMatch = matches.every((m) => m === expected);
  return {
    ok: allMatch,
    matches,
    expected,
    reason: allMatch ? null : `README test badge expected "${expected}", saw ${JSON.stringify(matches)}`,
  };
}

function checkStatDrift({ rootDir = defaultRoot() } = {}) {
  const markerResult = syncReadme.syncReadmeStats({ check: true, rootDir });
  const stats = collectStats(rootDir);
  const readme = readReadme(rootDir);
  const badge = detectTestBadgeDrift(rootDir, stats);
  const statBadges = detectAllStatBadgeDrift(readme, stats);
  const statBadgesOk = statBadges.every((entry) => entry.ok);
  const ok = markerResult.ok && badge.ok && statBadgesOk;
  return {
    ok,
    stats,
    markerOk: markerResult.ok,
    readmeChanged: markerResult.readmeChanged,
    agentsChanged: markerResult.agentsChanged,
    claudeChanged: markerResult.claudeChanged,
    testBadge: badge,
    statBadges,
  };
}

function syncStatArtifacts({ rootDir = defaultRoot() } = {}) {
  const markerResult = syncReadme.syncReadmeStats({ check: false, rootDir });
  const stats = collectStats(rootDir);
  const readmePath = path.join(rootDir, 'README.md');
  const original = fs.readFileSync(readmePath, 'utf8');
  let updated = original.replace(TEST_BADGE_PATTERN, expectedTestBadge(stats));
  // Apply every stat-badge rule. Each rule's pattern is global (`g` flag) so
  // String.prototype.replace rewrites every occurrence in one pass.
  for (const rule of STAT_BADGE_RULES) {
    const expected = expectedStatBadge(rule, stats);
    updated = updated.replace(rule.badgePattern, expected);
  }
  let testBadgeChanged = false;
  let statBadgesChanged = false;
  if (updated !== original) {
    fs.writeFileSync(readmePath, updated);
    // Differentiate which group of badges changed by re-running detection on
    // the BEFORE-state (we already have it as `original`).
    const beforeTest = original.match(TEST_BADGE_PATTERN);
    const afterTest = updated.match(TEST_BADGE_PATTERN);
    testBadgeChanged = JSON.stringify(beforeTest) !== JSON.stringify(afterTest);
    for (const rule of STAT_BADGE_RULES) {
      const before = original.match(rule.badgePattern);
      const after = updated.match(rule.badgePattern);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        statBadgesChanged = true;
        break;
      }
    }
  }
  return {
    ok: true,
    markerChanged: markerResult.changed,
    readmeChanged: markerResult.readmeChanged,
    agentsChanged: markerResult.agentsChanged,
    claudeChanged: markerResult.claudeChanged,
    testBadgeChanged,
    statBadgesChanged,
    stats,
  };
}

// ── CLI ───────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { mode: 'emit', outFile: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--emit') args.mode = 'emit';
    else if (a === '--print') args.mode = 'print';
    else if (a === '--check') args.mode = 'check';
    else if (a === '--sync') args.mode = 'sync';
    else if (a === '--json') args.json = true;
    else if (a === '--out' || a === '--output') {
      args.outFile = argv[++i];
    } else if (a === '--help' || a === '-h') {
      args.mode = 'help';
    } else if (a.startsWith('--out=')) {
      args.outFile = a.slice('--out='.length);
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(
    [
      'cobolt-stat-source — disk-derived stat source of truth (SF-02)',
      '',
      'Usage:',
      '  node tools/cobolt-stat-source.js [--emit|--print|--check|--sync] [--out <file>]',
      '',
      'Modes:',
      '  --emit  (default)  Write _cobolt-output/stats/current.json with disk-counted stats.',
      '  --print            Print stat JSON to stdout (no file write).',
      '  --check            Exit 1 if README/AGENTS/CLAUDE marker block or README test badge drifted.',
      '  --sync             Rewrite drifted artifacts to match disk.',
      '',
      'Env:',
      '  COBOLT_STAT_SOURCE_OUTPUT_DIR  Override output base dir (default: <repo>/_cobolt-output).',
      '  COBOLT_REPO_ROOT               Override repo root for stat collection.',
      '',
      'Exit codes (per tools/CLAUDE.md):',
      '  0  Success / no drift',
      '  1  Drift detected (--check) or unhandled error',
      '',
    ].join('\n'),
  );
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (args.mode === 'help') {
      printHelp();
      process.exit(0);
    }
    const rootDir = defaultRoot();
    if (args.mode === 'print') {
      const stats = collectStats(rootDir);
      process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
      process.exit(0);
    }
    if (args.mode === 'emit') {
      const { path: written, stats } = emitStatsFile({ rootDir, outFile: args.outFile });
      if (args.json) {
        process.stdout.write(`${JSON.stringify({ ok: true, path: written, stats }, null, 2)}\n`);
      } else {
        process.stderr.write(`stat-source: emitted ${written}\n`);
      }
      process.exit(0);
    }
    if (args.mode === 'check') {
      const result = checkStatDrift({ rootDir });
      if (!result.ok) {
        const lines = [
          'stat-source: drift detected — run `npm run sync:readme && node tools/cobolt-stat-source.js --sync`',
        ];
        if (!result.markerOk) {
          if (result.readmeChanged) lines.push('  - README.md stat block out of date');
          if (result.agentsChanged) lines.push('  - AGENTS.md stat block out of date');
          if (result.claudeChanged) lines.push('  - CLAUDE.md stat/context7 block out of date');
        }
        if (!result.testBadge.ok) {
          lines.push(`  - README.md tests badge: ${result.testBadge.reason}`);
        }
        for (const sb of result.statBadges || []) {
          if (!sb.ok) lines.push(`  - README.md ${sb.key} badge: ${sb.reason}`);
        }
        process.stderr.write(`${lines.join('\n')}\n`);
        process.exit(1);
      }
      process.stdout.write('stat-source: README / AGENTS / CLAUDE / tests-badge / stat-badges in sync with disk.\n');
      process.exit(0);
    }
    if (args.mode === 'sync') {
      const result = syncStatArtifacts({ rootDir });
      const summary = [];
      if (result.readmeChanged) summary.push('README marker block updated');
      if (result.agentsChanged) summary.push('AGENTS marker block updated');
      if (result.claudeChanged) summary.push('CLAUDE blocks updated');
      if (result.testBadgeChanged) summary.push('README tests badge updated');
      if (result.statBadgesChanged) summary.push('README stat badges updated');
      process.stdout.write(
        summary.length === 0 ? 'stat-source: already in sync.\n' : `stat-source: ${summary.join('; ')}.\n`,
      );
      process.exit(0);
    }
    printHelp();
    process.exit(1);
  } catch (err) {
    process.stderr.write(`stat-source: ${err.message}\n${err.stack ? `${err.stack}\n` : ''}`);
    process.exit(1);
  }
}

module.exports = {
  TEST_BADGE_PATTERN,
  STAT_BADGE_RULES,
  collectStats,
  detectTestBadgeDrift,
  detectStatBadgeDrift,
  detectAllStatBadgeDrift,
  emitStatsFile,
  expectedTestBadge,
  expectedStatBadge,
  checkStatDrift,
  syncStatArtifacts,
};
