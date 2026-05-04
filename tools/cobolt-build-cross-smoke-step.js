#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { projectExecutionLedger, syncBuildExecutionLedger } = require('../lib/cobolt-execution-ledger');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    command: argv[0] || 'run',
    milestone: null,
    json: false,
    timeoutMs: 10 * 60 * 1000,
  };
  if (argv.includes('--help') || argv.includes('-h')) args.command = 'help';
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--milestone' || arg === '-m') args.milestone = normalizeMilestone(argv[++i]);
    else if (arg === '--json') args.json = true;
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i] || args.timeoutMs);
  }
  return args;
}

function normalizeMilestone(value) {
  const match = String(value || '')
    .trim()
    .match(/^M?(\d+)$/i);
  return match ? `M${Number.parseInt(match[1], 10)}` : null;
}

function milestoneNumber(milestone) {
  const match = normalizeMilestone(milestone)?.match(/^M(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function writeFile(filePath, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode });
}

function writeJson(filePath, payload) {
  writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, ''));
  } catch {
    return fallback;
  }
}

function verdictPath(projectRoot, milestone) {
  return path.join(projectRoot, '_cobolt-output', 'latest', 'cross-milestone', `${milestone}-smoke-verdict.json`);
}

function checkpointPath(projectRoot, milestone) {
  return path.join(
    projectRoot,
    '_cobolt-output',
    'latest',
    'build',
    'checkpoints',
    `${milestone}-08b-cross-milestone-smoke.json`,
  );
}

function writeCheckpoint(projectRoot, milestone, status, verdictFile) {
  const checkpoint = {
    milestone,
    step: '08b-cross-milestone-smoke',
    status,
    verdict: path.relative(projectRoot, verdictFile).replace(/\\/g, '/'),
    completedAt: new Date().toISOString(),
    generatedBy: 'cobolt-build-cross-smoke-step',
  };
  const concretePath = checkpointPath(projectRoot, milestone);
  writeJson(concretePath, checkpoint);
  writeJson(
    path.join(projectRoot, '_cobolt-output', 'latest', 'build', 'checkpoints', '08b-cross-milestone-smoke.json'),
    checkpoint,
  );
  return concretePath;
}

function defaultRunCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    timeout: options.timeoutMs || 10 * 60 * 1000,
    windowsHide: true,
    env: options.env || process.env,
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout || '',
    stderr: result.stderr || (result.error ? String(result.error.message || result.error) : ''),
  };
}

function run(args = parseArgs(), options = {}) {
  if (args.command !== 'run') {
    return {
      ok: args.command === 'help',
      usage: 'node tools/cobolt-build-cross-smoke-step.js run --milestone M1 [--json]',
    };
  }

  const projectRoot = options.projectRoot || process.cwd();
  const toolsDir = options.toolsDir || process.env.COBOLT_TOOLS_DIR || process.env.COBOLT_TOOLS || __dirname;
  const milestone = normalizeMilestone(args.milestone);
  if (!milestone) return { ok: false, reason: 'milestone-required' };

  const number = milestoneNumber(milestone);
  const outPath = verdictPath(projectRoot, milestone);
  if (number && number <= 1) {
    const verdict = {
      milestone,
      verdict: 'pass',
      status: 'PASS',
      ok: true,
      skipped: true,
      reason: 'M1 has no prior milestone regression target',
      tests: [],
      generatedAt: new Date().toISOString(),
      generatedBy: 'cobolt-build-cross-smoke-step',
    };
    writeJson(outPath, verdict);
    const checkpoint = writeCheckpoint(projectRoot, milestone, 'passed', outPath);
    syncBuildExecutionLedger(projectRoot, milestone, {
      checkpointPath: checkpoint,
      checkpointId: '08b-cross-milestone-smoke',
    });
    projectExecutionLedger(projectRoot);
    return { ok: true, reason: 'm1-no-prior-milestone', milestone, verdictPath: outPath, checkpointPath: checkpoint };
  }

  const toolPath = path.join(toolsDir, 'cobolt-cross-milestone-smoke.js');
  if (!fs.existsSync(toolPath)) return { ok: false, reason: 'cross-smoke-tool-missing', toolPath };

  const runCommand = options.runCommand || defaultRunCommand;
  const result = runCommand(
    process.execPath,
    [toolPath, 'run', '--milestone', milestone, '--check-retroactive-drift'],
    {
      cwd: projectRoot,
      timeoutMs: args.timeoutMs,
    },
  );
  let verdict = readJson(outPath, null);
  if (!verdict) {
    verdict = {
      milestone,
      verdict: result.status === 0 ? 'pass' : 'fail',
      status: result.status === 0 ? 'PASS' : 'FAIL',
      reason:
        result.status === 0
          ? 'cross-milestone tool exited successfully without writing a verdict'
          : 'cross-milestone smoke exited non-zero',
      exitCode: result.status,
      stdoutTail: String(result.stdout || '').slice(-2000),
      stderrTail: String(result.stderr || '').slice(-2000),
      generatedAt: new Date().toISOString(),
      generatedBy: 'cobolt-build-cross-smoke-step',
    };
    writeJson(outPath, verdict);
  }

  const passed =
    result.status === 0 &&
    verdict.ok !== false &&
    verdict.pass !== false &&
    !['fail', 'failed', 'blocked', 'error'].includes(String(verdict.verdict || verdict.status || '').toLowerCase());
  const checkpoint = writeCheckpoint(projectRoot, milestone, passed ? 'passed' : 'failed', outPath);
  syncBuildExecutionLedger(projectRoot, milestone, {
    checkpointPath: checkpoint,
    checkpointId: '08b-cross-milestone-smoke',
  });
  projectExecutionLedger(projectRoot);
  return {
    ok: passed,
    reason: passed ? 'cross-smoke-passed' : 'cross-smoke-failed',
    milestone,
    verdictPath: outPath,
    checkpointPath: checkpoint,
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

if (require.main === module) {
  const args = parseArgs();
  const result = run(args);
  if (args.json || result.usage) console.log(JSON.stringify(result, null, 2));
  else if (!result.ok) console.error(result.reason || 'cross-milestone smoke failed');
  process.exit(result.ok ? 0 : 1);
}

module.exports = {
  normalizeMilestone,
  parseArgs,
  run,
};
