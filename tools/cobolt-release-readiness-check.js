#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { CoboltPaths } = require('../lib/cobolt-paths');
const { formatGateFireRateSummary, summarizeGateFireRate } = require('../lib/cobolt-observability');

const CHECKS = Object.freeze([
  { id: 'build-hooks', command: 'npm', args: ['run', 'build:hooks'], label: 'Build hooks' },
  { id: 'check-version', command: 'npm', args: ['run', 'check:version'], label: 'Version sync' },
  { id: 'check-tools', command: 'npm', args: ['run', 'check:tools'], label: 'Tool availability' },
  { id: 'check-skill-args', command: 'npm', args: ['run', 'check:skill-args'], label: 'Skill argument lint' },
  { id: 'check-surface', command: 'npm', args: ['run', 'check:surface'], label: 'Public surface drift' },
  { id: 'check-agents', command: 'npm', args: ['run', 'check:agents'], label: 'AGENTS stats drift' },
  {
    id: 'check-output-contract',
    command: 'npm',
    args: ['run', 'check:output-contract'],
    label: 'Output contract',
  },
  {
    id: 'runtime-resilience',
    command: 'npm',
    args: ['run', 'check:runtime-resilience'],
    label: 'Runtime resilience closure-class registry',
  },
  {
    // RT-04: per-release fault-injection suite. Re-runs the named regression
    // test for every entry in source/templates/failure-class-registry.json so
    // closure-class regressions surface here even when --skip-tests bypasses
    // the full Node test suite. Intentionally NOT tagged `test:true` — this
    // is a closure-class safety net, not the generic test surface.
    id: 'runtime-resilience-fault-inject',
    command: 'npm',
    args: ['run', 'runtime:resilience:fault-inject'],
    label: 'Runtime resilience fault-injection (closure-class regression suite)',
  },
  { id: 'test', command: 'npm', args: ['test'], label: 'Node test suite', test: true },
  { id: 'tools-health', command: 'npm', args: ['run', 'tools:health'], label: 'Tools health', slow: true },
  // v0.45.0 — production-done 8-point checklist (SDLC gaps production-done).
  // Skipped automatically when the project has not declared a milestone or
  // selected-stack-contract (non-production-track / framework-first projects
  // that haven't reached release). When declared, runs the full checklist
  // and fails release readiness on any critical check failure.
  {
    id: 'production-done',
    command: process.execPath,
    args: [path.join(__dirname, 'cobolt-production-done.js'), 'check', '--env', 'production', '--json'],
    label: 'Production-done 8-point checklist (v0.45)',
    skipWhenMissing: '_cobolt-output/latest/planning/selected-stack-contract.json',
  },
  {
    id: 'install-trust',
    command: process.execPath,
    args: [path.join(__dirname, 'cobolt-verify-install.js'), 'verify'],
    label: 'Install trust-chain provenance (SC-09)',
    skipWhenMissing: '_cobolt-output/release/install-trust/latest.json',
  },
]);

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    json: false,
    skipTests: false,
    fast: false,
    strict: false,
    rootDir: process.cwd(),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--skip-tests') options.skipTests = true;
    else if (arg === '--fast') options.fast = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--root') options.rootDir = path.resolve(argv[++i] || options.rootDir);
    else if (arg.startsWith('--root=')) options.rootDir = path.resolve(arg.slice('--root='.length));
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function shouldSkip(check, options) {
  // kind:'flag' — explicit user opt-out via --skip-tests / --fast. These
  // block --strict because the user has consciously disabled a gate.
  if (options.skipTests && check.test) return { reason: 'skipped by --skip-tests', kind: 'flag' };
  if (options.fast && (check.test || check.slow)) return { reason: 'skipped by --fast', kind: 'flag' };
  // kind:'structural' — the check declared `skipWhenMissing` and the
  // sentinel is absent, meaning the check does not apply to this project
  // (e.g. production-done only runs when a selected-stack-contract exists;
  // CoBolt itself is a framework with no such contract). These must NOT
  // block --strict, or strict-release becomes impossible for any project
  // that structurally opts out of a check.
  if (check.skipWhenMissing) {
    const rootDir = options.rootDir || process.cwd();
    const gatingPath = path.isAbsolute(check.skipWhenMissing)
      ? check.skipWhenMissing
      : path.join(rootDir, check.skipWhenMissing);
    try {
      if (!fs.existsSync(gatingPath)) {
        return { reason: `skipped because ${check.skipWhenMissing} is absent`, kind: 'structural' };
      }
    } catch {
      return { reason: `skipped because ${check.skipWhenMissing} is unreadable`, kind: 'structural' };
    }
  }
  return null;
}

function npmCliPath() {
  return path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

function commandInvocation(command, args = []) {
  if (process.platform === 'win32' && command === 'npm') {
    return { command: process.execPath, args: [npmCliPath(), ...args] };
  }
  return { command, args };
}

function defaultCommandRunner(check, options) {
  const invocation = commandInvocation(check.command, check.args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.rootDir,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    exitCode: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout || '',
    stderr: result.stderr || (result.error ? result.error.message : ''),
  };
}

function summarizeOutput(stdout, stderr) {
  const combined = `${stdout || ''}\n${stderr || ''}`.trim();
  if (!combined) return '';
  const lines = combined.split(/\r?\n/).filter(Boolean);
  return lines.slice(-12).join('\n');
}

function runReleaseReadiness(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const commandRunner = options.commandRunner || defaultCommandRunner;
  const startedAt = new Date().toISOString();
  const checks = [];

  for (const check of CHECKS) {
    const skipped = shouldSkip(check, options);
    if (skipped) {
      checks.push({
        id: check.id,
        label: check.label,
        status: 'SKIPPED',
        exitCode: 0,
        skipped: skipped.reason,
        skipKind: skipped.kind,
        command: `${check.command} ${check.args.join(' ')}`,
        durationMs: 0,
      });
      continue;
    }

    const started = Date.now();
    const result = commandRunner(check, { ...options, rootDir });
    checks.push({
      id: check.id,
      label: check.label,
      status: result.exitCode === 0 ? 'PASS' : 'FAIL',
      exitCode: result.exitCode,
      command: `${check.command} ${check.args.join(' ')}`,
      durationMs: Date.now() - started,
      outputTail: summarizeOutput(result.stdout, result.stderr),
    });
  }

  const failed = checks.filter((check) => check.status === 'FAIL');
  const skipped = checks.filter((check) => check.status === 'SKIPPED');
  const gateFireRate = summarizeGateFireRate({
    projectRoot: rootDir,
    threshold: 5,
    windowHours: 24,
    perFileLines: 500,
    maxBytesPerFile: 1024 * 1024,
  });
  // Only user-flag skips (--skip-tests / --fast) block --strict. Structural
  // skips (skipWhenMissing sentinel absent) are a feature of the check
  // contract and must NOT block strict-release.
  const flagSkips = skipped.filter((check) => check.skipKind === 'flag');
  const strictSkipFailure = Boolean(options.strict && flagSkips.length > 0);
  const gateFireRateFailure = !gateFireRate.ok;
  const verdict = failed.length === 0 && !strictSkipFailure && !gateFireRateFailure ? 'PASS' : 'FAIL';

  return {
    ok: verdict === 'PASS',
    verdict,
    strict: Boolean(options.strict),
    startedAt,
    completedAt: new Date().toISOString(),
    rootDir,
    summary: {
      total: checks.length,
      passed: checks.filter((check) => check.status === 'PASS').length,
      failed: failed.length,
      skipped: skipped.length,
      skippedStructural: skipped.length - flagSkips.length,
      skippedByFlag: flagSkips.length,
    },
    checks,
    gateFireRate,
    findings: [
      ...failed.map((check) => ({
        code: 'CHECK_FAILED',
        check: check.id,
        message: `${check.label} failed with exit code ${check.exitCode}`,
      })),
      ...(gateFireRateFailure
        ? gateFireRate.violatingGates.map((gate) => ({
            code: 'GATE_FIRE_RATE_THRESHOLD',
            check: 'gate-firerate',
            gate: gate.gate,
            message: `${gate.gate} fired ${gate.unresolvedBlockCount} unresolved time(s) in the last ${gateFireRate.windowHours}h`,
          }))
        : []),
      ...(strictSkipFailure
        ? [
            {
              code: 'STRICT_SKIPPED_CHECK',
              message: `--strict does not allow user-flag skips: ${flagSkips.map((check) => check.id).join(', ')}`,
            },
          ]
        : []),
    ],
  };
}

function reportDir(rootDir) {
  const paths = new CoboltPaths(rootDir);
  return paths.reports('release-readiness');
}

function writeReports(result, rootDir = process.cwd()) {
  const dir = reportDir(rootDir);
  const jsonPath = path.join(dir, 'latest.json');
  const mdPath = path.join(dir, 'latest.md');
  fs.writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, renderMarkdown(result), 'utf8');
  return { jsonPath, mdPath };
}

function renderMarkdown(result) {
  const lines = [
    '# Release Readiness',
    '',
    `Verdict: ${result.verdict}`,
    `Started: ${result.startedAt}`,
    `Completed: ${result.completedAt}`,
    '',
    '| Check | Status | Command |',
    '| --- | --- | --- |',
  ];
  for (const check of result.checks) {
    lines.push(`| ${check.label} | ${check.status} | \`${check.command}\` |`);
  }
  if (result.findings.length > 0) {
    lines.push('', '## Findings', '');
    for (const item of result.findings) {
      lines.push(`- ${item.code}: ${item.message}`);
    }
  }
  lines.push('', '## Gate Fire-Rate', '');
  lines.push(`Verdict: ${result.gateFireRate.verdict}`);
  lines.push(`Window: ${result.gateFireRate.windowHours}h`);
  lines.push(`Threshold: >${result.gateFireRate.threshold} unresolved fires`);
  lines.push(`Blocks: ${result.gateFireRate.totalBlocks}`);
  if (result.gateFireRate.violatingGates.length > 0) {
    lines.push('', '| Gate | Unresolved Fires | Last Fire | Evidence |');
    lines.push('| --- | ---: | --- | --- |');
    for (const gate of result.gateFireRate.violatingGates) {
      lines.push(
        `| ${gate.gate} | ${gate.unresolvedBlockCount} | ${gate.lastFireAt || ''} | ${
          gate.lastEvidencePath ? `\`${gate.lastEvidencePath}\`` : ''
        } |`,
      );
    }
  } else {
    lines.push('');
    lines.push('No gate exceeded the unresolved fire-rate threshold.');
  }
  lines.push('');
  return lines.join('\n');
}

function formatHuman(result, reports) {
  const lines = [
    `Release readiness: ${result.verdict}`,
    `  Passed: ${result.summary.passed}/${result.summary.total}`,
    `  Failed: ${result.summary.failed}`,
    `  Skipped: ${result.summary.skipped}`,
    `  Gate fire-rate: ${result.gateFireRate.verdict} (${result.gateFireRate.totalBlocks} blocks in ${result.gateFireRate.windowHours}h)`,
  ];
  for (const check of result.checks) {
    lines.push(`  - ${check.status.padEnd(7)} ${check.label}`);
  }
  if (reports) {
    lines.push(`  JSON: ${reports.jsonPath}`);
    lines.push(`  Markdown: ${reports.mdPath}`);
  }
  if (result.gateFireRate.violatingGates.length > 0) {
    lines.push(formatGateFireRateSummary(result.gateFireRate, { verbose: true }));
  }
  return lines.join('\n');
}

function printHelp() {
  console.log('Usage: node tools/cobolt-release-readiness-check.js [--strict] [--skip-tests] [--fast] [--json]');
}

if (require.main === module) {
  try {
    const options = parseArgs();
    if (options.help) {
      printHelp();
      process.exit(0);
    }
    const result = runReleaseReadiness(options);
    const reports = writeReports(result, options.rootDir);
    if (options.json) {
      console.log(JSON.stringify({ ...result, reports }, null, 2));
    } else {
      console.log(formatHuman(result, reports));
    }
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    if (process.argv.includes('--json')) {
      console.log(
        JSON.stringify({ ok: false, verdict: 'ERROR', findings: [{ code: 'ERROR', message: err.message }] }, null, 2),
      );
    } else {
      console.error(err.message);
    }
    process.exit(1);
  }
}

module.exports = {
  CHECKS,
  defaultCommandRunner,
  formatHuman,
  parseArgs,
  renderMarkdown,
  runReleaseReadiness,
  writeReports,
};
