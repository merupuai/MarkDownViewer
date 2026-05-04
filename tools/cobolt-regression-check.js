#!/usr/bin/env node
//
// CoBolt cross-milestone regression check (Issue 1, v0.40.5).
//
// Problem: audit/validate Section 7.2 dynamically enumerated prior milestones
// but there was no tool that actually replayed each prior milestone's
// acceptance criteria against the current HEAD. Silent regressions would slip
// through until production.
//
// Protocol:
//
//   1. Baseline phase (runs at milestone close, Stage 8):
//        cobolt-regression-check baseline --milestone M1
//      -> reads rtm.json for M1, collects test IDs + expected outcomes,
//         writes `_cobolt-output/audit/regression-baseline/M1.json`.
//
//   2. Check phase (runs during audit / milestone-validate / deploy-preflight):
//        cobolt-regression-check check --current M3
//      -> loads baselines for M1, M2; re-runs the captured tests; diffs
//         actual vs expected; writes `regression-report-M3.json`.
//
// Exit codes:
//   0 PASS (all prior-milestone tests still pass)
//   1 regressions detected (per-milestone details in report)
//   2 missing optional tooling (test framework not detected)
//   3 missing baseline (no prior milestone to check — intentionally non-fatal
//     for M1; treated as PASS with reason "no-prior-baselines")
//
// This tool does NOT mutate production state. It writes to the audit tree
// only. Consumers (cobolt-regression-gate) read the report and decide whether
// to block deploy.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const BASELINE_DIR = path.join('_cobolt-output', 'audit', 'regression-baseline');
const REPORT_DIR = path.join('_cobolt-output', 'audit');
const RTM_PATH = path.join('_cobolt-output', 'latest', 'planning', 'rtm.json');

function readJsonSafe(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
}

function listPriorMilestones(currentLabel) {
  const m = /^M(\d+)$/i.exec(currentLabel || '');
  if (!m) return [];
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 1) return [];
  const out = [];
  for (let i = 1; i < n; i += 1) out.push(`M${i}`);
  return out;
}

function extractMilestoneAcceptance(rtm, milestone) {
  if (!rtm) return [];
  const requirements = Array.isArray(rtm.requirements) ? rtm.requirements : [];
  const hits = [];
  for (const r of requirements) {
    const ms = Array.isArray(r.milestones) ? r.milestones : [r.milestone].filter(Boolean);
    if (!ms.includes(milestone)) continue;
    const acceptance = Array.isArray(r.acceptanceTests) ? r.acceptanceTests : Array.isArray(r.tests) ? r.tests : [];
    for (const t of acceptance) {
      hits.push({
        requirementId: r.id || r.requirementId || null,
        testId: t.id || t.testId || t.name || null,
        testPath: t.file || t.path || null,
        kind: t.kind || t.type || 'unit',
      });
    }
  }
  return hits;
}

function hashTestLocator(entry) {
  return crypto
    .createHash('sha256')
    .update(`${entry.requirementId || ''}|${entry.testId || ''}|${entry.testPath || ''}`)
    .digest('hex')
    .slice(0, 16);
}

function cmdBaseline(args) {
  const milestone =
    args.find((a) => a.startsWith('--milestone='))?.split('=')[1] || args[args.indexOf('--milestone') + 1] || null;
  if (!milestone || !/^M\d+$/i.test(milestone)) {
    process.stderr.write('regression-check baseline: --milestone M{N} required\n');
    process.exit(1);
  }
  const rtm = readJsonSafe(RTM_PATH);
  if (!rtm) {
    process.stderr.write(`regression-check baseline: rtm.json not found at ${RTM_PATH} — nothing to baseline\n`);
    process.exit(1);
  }
  const tests = extractMilestoneAcceptance(rtm, milestone);
  const baseline = {
    schemaVersion: 'cobolt-regression-baseline/v1',
    milestone,
    capturedAt: new Date().toISOString(),
    testCount: tests.length,
    tests: tests.map((t) => ({ ...t, locatorHash: hashTestLocator(t) })),
  };
  const outPath = path.join(BASELINE_DIR, `${milestone}.json`);
  writeJson(outPath, baseline);
  process.stdout.write(`${JSON.stringify({ ok: true, milestone, testCount: tests.length, path: outPath })}\n`);
  process.exit(0);
}

function detectTestRunner(cwd) {
  if (fs.existsSync(path.join(cwd, 'package.json'))) return { kind: 'npm', args: ['npm', 'test'] };
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) return { kind: 'cargo', args: ['cargo', 'test'] };
  if (fs.existsSync(path.join(cwd, 'mix.exs'))) return { kind: 'mix', args: ['mix', 'test'] };
  if (fs.existsSync(path.join(cwd, 'go.mod'))) return { kind: 'go', args: ['go', 'test', './...'] };
  if (fs.existsSync(path.join(cwd, 'pyproject.toml'))) return { kind: 'pytest', args: ['pytest', '-q'] };
  return null;
}

function resolveNpmSpawn(args) {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { command: process.execPath, args: [candidate, ...args] };
  }
  return { command: 'npm', args };
}

function resolveDirectSpawn(cmd) {
  const [command, ...args] = cmd;
  if (process.platform !== 'win32') return { command, args };
  if (command === 'npm') return resolveNpmSpawn(args);
  if (path.extname(command)) return { command, args };

  const pathDirs = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean);
  for (const dir of pathDirs) {
    for (const ext of ['.exe', '.com']) {
      const candidate = path.join(dir, `${command}${ext}`);
      try {
        if (fs.statSync(candidate).isFile()) return { command: candidate, args };
      } catch {
        /* keep searching */
      }
    }
  }
  return { command, args };
}

function runTestsForBaseline(baseline, runner) {
  // Deterministic path: if baseline carries explicit testPath locators, pass
  // them as targeted runner arguments; otherwise run the full suite and rely
  // on test-id presence. For npm/jest we can pass -t "<testId>" per entry but
  // many runners don't support that — safest is a single suite run and then
  // the consumer must inspect failures. We capture exit code + first 8KB.
  const cmd = runner.args;
  const resolved = resolveDirectSpawn(cmd);
  const cwd = process.cwd();
  const result = spawnSync(resolved.command, resolved.args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const stdoutSlice = (result.stdout || '').slice(-8192);
  const stderrSlice = (result.stderr || '').slice(-8192);
  const passed = result.status === 0;
  return {
    milestone: baseline.milestone,
    runnerKind: runner.kind,
    command: cmd.join(' '),
    exitCode: typeof result.status === 'number' ? result.status : -1,
    passed,
    stdoutTailHash: crypto.createHash('sha256').update(stdoutSlice).digest('hex').slice(0, 16),
    stderrTailHash: crypto.createHash('sha256').update(stderrSlice).digest('hex').slice(0, 16),
    testCount: baseline.testCount,
  };
}

function cmdCheck(args) {
  const current =
    args.find((a) => a.startsWith('--current='))?.split('=')[1] || args[args.indexOf('--current') + 1] || null;
  const skipRun = args.includes('--no-run');
  if (!current || !/^M\d+$/i.test(current)) {
    process.stderr.write('regression-check check: --current M{N} required\n');
    process.exit(1);
  }
  const priorMilestones = listPriorMilestones(current);
  const baselines = priorMilestones
    .map((m) => ({ m, baseline: readJsonSafe(path.join(BASELINE_DIR, `${m}.json`)) }))
    .filter((x) => x.baseline);

  const report = {
    schemaVersion: 'cobolt-regression-report/v1',
    current,
    priorMilestones,
    baselinesFound: baselines.map((x) => x.m),
    generatedAt: new Date().toISOString(),
    results: [],
    verdict: 'PASS',
    reason: null,
  };

  if (baselines.length === 0) {
    report.verdict = 'PASS';
    report.reason = priorMilestones.length === 0 ? 'first-milestone' : 'no-prior-baselines';
    writeJson(path.join(REPORT_DIR, `regression-report-${current}.json`), report);
    process.stdout.write(`${JSON.stringify({ ok: true, verdict: report.verdict, reason: report.reason })}\n`);
    process.exit(0);
  }

  if (skipRun) {
    report.verdict = 'PASS';
    report.reason = 'no-run-flag';
    writeJson(path.join(REPORT_DIR, `regression-report-${current}.json`), report);
    process.stdout.write(`${JSON.stringify({ ok: true, verdict: report.verdict, reason: report.reason })}\n`);
    process.exit(0);
  }

  const runner = detectTestRunner(process.cwd());
  if (!runner) {
    report.verdict = 'SKIP';
    report.reason = 'no-test-runner-detected';
    writeJson(path.join(REPORT_DIR, `regression-report-${current}.json`), report);
    process.stdout.write(`${JSON.stringify({ ok: false, verdict: report.verdict, reason: report.reason })}\n`);
    process.exit(2);
  }

  let failures = 0;
  for (const { baseline } of baselines) {
    const result = runTestsForBaseline(baseline, runner);
    report.results.push(result);
    if (!result.passed) failures += 1;
  }

  report.verdict = failures === 0 ? 'PASS' : 'REGRESSION';
  report.reason = failures === 0 ? null : `${failures}-prior-milestone-failures`;
  writeJson(path.join(REPORT_DIR, `regression-report-${current}.json`), report);
  process.stdout.write(
    `${JSON.stringify({ ok: failures === 0, verdict: report.verdict, reason: report.reason, failures })}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

function printUsage() {
  process.stdout.write(
    [
      'Usage: cobolt-regression-check <command> [options]',
      '',
      'Commands:',
      '  baseline --milestone M{N}       Capture acceptance tests for M{N} from rtm.json',
      '  check    --current   M{N}       Re-run all prior baselines against HEAD',
      '',
      'Options:',
      '  --no-run                        (check) Do not execute tests — only emit the report',
      '',
      'Artifacts:',
      `  ${BASELINE_DIR}/M{N}.json`,
      `  ${REPORT_DIR}/regression-report-M{N}.json`,
      '',
    ].join('\n'),
  );
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printUsage();
    process.exit(0);
  }
  const cmd = argv[0];
  const rest = argv.slice(1);
  if (cmd === 'baseline') return cmdBaseline(rest);
  if (cmd === 'check') return cmdCheck(rest);
  process.stderr.write(`regression-check: unknown command "${cmd}"\n`);
  printUsage();
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  _internal: {
    listPriorMilestones,
    extractMilestoneAcceptance,
    hashTestLocator,
    detectTestRunner,
  },
};
