#!/usr/bin/env node

// CoBolt Deploy-Marker Audit
//
// Verifies that every deployed CoBolt CommonJS tree carries a sibling
// {"type":"commonjs"} package.json marker — defense against consumer
// projects that declare `"type":"module"` at the root, which would
// otherwise cause `ReferenceError: require is not defined in ES module
// scope` on every CoBolt-managed .js load.
//
// Audited trees (when present):
//   <targetDir>/hooks/                  → must contain package.json type=commonjs
//   <targetDir>/cobolt/lib/             → same
//   <targetDir>/cobolt/tools/           → same
//
// Source-side markers also verified:
//   source/hooks/package.json
//   lib/package.json
//   tools/package.json
//
// Usage:
//   node tools/cobolt-deploy-marker-audit.js                # audit all detected installs
//   node tools/cobolt-deploy-marker-audit.js --all          # explicit (same as default)
//   node tools/cobolt-deploy-marker-audit.js --target <path>
//   node tools/cobolt-deploy-marker-audit.js --source-only  # only check source-side markers
//   node tools/cobolt-deploy-marker-audit.js --json         # machine-readable output
//
// Exit codes (per tools/CLAUDE.md contract):
//   0  all markers present and correct
//   1  one or more markers missing or incorrect (gate FAIL)
//   2  no installs detected and no source-side audit possible (Tier 2 skip)
//   3  missing infra (e.g., source root unreadable)
//
// See CLAUDE.md "Architectural Invariants" + tests/test-deploy-marker-audit.js

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_HOOKS = path.join(REPO_ROOT, 'source', 'hooks');
const SOURCE_LIB = path.join(REPO_ROOT, 'lib');
const SOURCE_TOOLS = path.join(REPO_ROOT, 'tools');

function parseArgs(argv) {
  const args = { all: false, sourceOnly: false, json: false, targets: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--all') args.all = true;
    else if (a === '--source-only') args.sourceOnly = true;
    else if (a === '--json') args.json = true;
    else if (a === '--target') args.targets.push(argv[++i]);
    else if (a.startsWith('--target=')) args.targets.push(a.slice('--target='.length));
  }
  if (!args.sourceOnly && args.targets.length === 0) args.all = true;
  return args;
}

function printHelp() {
  process.stdout.write(
    [
      'cobolt-deploy-marker-audit — verify {"type":"commonjs"} markers in CoBolt deployments',
      '',
      'Usage:',
      '  node tools/cobolt-deploy-marker-audit.js [options]',
      '',
      'Options:',
      '  --all                Audit every detected install (default).',
      '  --target <path>      Audit a specific install root (repeatable).',
      '  --source-only        Only verify source-side markers.',
      '  --json               Emit JSON instead of human-readable text.',
      '  -h, --help           Show this help.',
      '',
      'Exit codes: 0=ok, 1=marker missing/wrong, 2=no installs detected, 3=infra error.',
      '',
    ].join('\n'),
  );
}

function readMarker(pkgPath) {
  // Returns { exists, valid, type, error }
  if (!fs.existsSync(pkgPath)) return { exists: false, valid: false };
  try {
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw);
    const type = parsed && typeof parsed === 'object' ? parsed.type : null;
    return { exists: true, valid: type === 'commonjs', type };
  } catch (err) {
    return { exists: true, valid: false, error: err.message };
  }
}

function dirHasJs(dir) {
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith('.js'));
  } catch {
    return false;
  }
}

function auditTree(label, dir, opts = {}) {
  // opts.requireMarkerEvenIfEmpty — when true, missing-dir is "skipped" not failure;
  //    when false, missing-dir means the tree was never deployed (info only).
  const result = { label, dir, status: 'skipped', detail: '' };
  let dirExists;
  try {
    dirExists = fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  } catch (err) {
    result.status = 'fail';
    result.detail = `cannot stat ${dir}: ${err.message}`;
    return result;
  }
  if (!dirExists) {
    result.status = 'absent';
    result.detail = 'tree not deployed at this location';
    return result;
  }
  if (!opts.requireMarkerEvenIfEmpty && !dirHasJs(dir)) {
    result.status = 'absent';
    result.detail = 'tree exists but contains no .js files (skipping)';
    return result;
  }
  const pkgPath = path.join(dir, 'package.json');
  const m = readMarker(pkgPath);
  if (!m.exists) {
    result.status = 'fail';
    result.detail = `missing package.json marker at ${pkgPath}`;
    return result;
  }
  if (!m.valid) {
    result.status = 'fail';
    result.detail = m.error
      ? `unparseable package.json at ${pkgPath}: ${m.error}`
      : `package.json at ${pkgPath} has type=${JSON.stringify(m.type)} (expected "commonjs")`;
    return result;
  }
  result.status = 'pass';
  result.detail = `marker present and valid (type=commonjs)`;
  return result;
}

function detectInstallTargets() {
  const home = os.homedir();
  const candidates = [
    { label: 'project-local (.claude)', dir: path.join(process.cwd(), '.claude') },
    { label: 'claude-global (~/.claude)', dir: path.join(home, '.claude') },
    { label: 'codex-global (~/.codex/cobolt)', dir: path.join(home, '.codex', 'cobolt') },
  ];
  const detected = [];
  for (const c of candidates) {
    let exists = false;
    try {
      exists = fs.existsSync(c.dir) && fs.statSync(c.dir).isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) continue;
    // Only treat as a CoBolt install if there is a `hooks/` or `cobolt/` subdir
    const hooksSub = fs.existsSync(path.join(c.dir, 'hooks'));
    const coboltSub = fs.existsSync(path.join(c.dir, 'cobolt'));
    if (!hooksSub && !coboltSub) continue;
    detected.push(c);
  }
  return detected;
}

function auditTarget(target) {
  // target = { label, dir }
  const checks = [];
  checks.push(auditTree(`${target.label}: hooks/`, path.join(target.dir, 'hooks')));
  checks.push(auditTree(`${target.label}: cobolt/lib/`, path.join(target.dir, 'cobolt', 'lib')));
  checks.push(auditTree(`${target.label}: cobolt/tools/`, path.join(target.dir, 'cobolt', 'tools')));
  return { target, checks };
}

function auditSourceMarkers() {
  return [
    auditTree('source/hooks/', SOURCE_HOOKS, { requireMarkerEvenIfEmpty: true }),
    auditTree('lib/', SOURCE_LIB, { requireMarkerEvenIfEmpty: true }),
    auditTree('tools/', SOURCE_TOOLS, { requireMarkerEvenIfEmpty: true }),
  ];
}

function summarize(results) {
  let pass = 0;
  let fail = 0;
  let absent = 0;
  for (const r of results) {
    if (r.status === 'pass') pass++;
    else if (r.status === 'fail') fail++;
    else if (r.status === 'absent') absent++;
  }
  return { pass, fail, absent, total: results.length };
}

function printText({ sourceChecks, targetReports, summary }) {
  process.stdout.write('CoBolt Deploy-Marker Audit\n');
  process.stdout.write('==========================\n\n');

  process.stdout.write('Source-side markers:\n');
  for (const r of sourceChecks) {
    process.stdout.write(`  [${r.status.padEnd(7)}] ${r.label}\n           ${r.detail}\n`);
  }
  process.stdout.write('\n');

  if (targetReports.length === 0) {
    process.stdout.write('No deployed installs audited.\n\n');
  } else {
    process.stdout.write('Deployed installs:\n');
    for (const tr of targetReports) {
      process.stdout.write(`  ${tr.target.label}  (${tr.target.dir})\n`);
      for (const r of tr.checks) {
        process.stdout.write(`    [${r.status.padEnd(7)}] ${r.label}\n             ${r.detail}\n`);
      }
    }
    process.stdout.write('\n');
  }

  process.stdout.write(
    `Summary: ${summary.pass} pass, ${summary.fail} fail, ${summary.absent} absent (of ${summary.total})\n`,
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Source markers — always verified (cheap and authoritative)
  let sourceChecks = [];
  try {
    sourceChecks = auditSourceMarkers();
  } catch (err) {
    process.stderr.write(`Error reading source-side markers: ${err.message}\n`);
    process.exit(3);
  }

  let targetReports = [];
  if (!args.sourceOnly) {
    let targets;
    if (args.targets.length > 0) {
      targets = args.targets.map((p) => ({ label: `--target ${p}`, dir: path.resolve(p) }));
    } else {
      targets = detectInstallTargets();
    }
    targetReports = targets.map(auditTarget);
  }

  const flat = [...sourceChecks, ...targetReports.flatMap((tr) => tr.checks)];
  const summary = summarize(flat);

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: summary.fail === 0,
          summary,
          sourceChecks,
          targetReports,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    printText({ sourceChecks, targetReports, summary });
  }

  if (summary.fail > 0) process.exit(1);
  if (!args.sourceOnly && targetReports.length === 0 && sourceChecks.every((r) => r.status === 'pass')) {
    // Source-side passes but no installs detected — Tier 2 skip-and-report.
    // Exit 2 is the deterministic signal "no installs to audit" so a CI gate
    // can decide to degrade rather than fail.
    process.exit(2);
  }
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  auditTree,
  auditSourceMarkers,
  auditTarget,
  detectInstallTargets,
  readMarker,
  parseArgs,
};
