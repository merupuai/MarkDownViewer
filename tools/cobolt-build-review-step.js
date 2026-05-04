#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildReviewReport } = require('./cobolt-review-step');
const { projectExecutionLedger, syncReviewExecutionLedger } = require('../lib/cobolt-execution-ledger');

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const USAGE = 'Usage: node tools/cobolt-build-review-step.js run --milestone M1 [--json] [--timeout-ms <ms>]';

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    command: argv[0] || 'run',
    milestone: null,
    json: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') args.command = 'help';

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--milestone' || arg === '-m') args.milestone = argv[++i];
    else if (arg === '--json') args.json = true;
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i] || DEFAULT_TIMEOUT_MS);
    else if (arg === '--help' || arg === '-h') args.command = 'help';
  }

  return args;
}

function normalizeMilestone(value) {
  const match = String(value || '')
    .trim()
    .match(/^M?(\d+)$/i);
  return match ? `M${Number.parseInt(match[1], 10)}` : null;
}

function repoRoot() {
  return path.resolve(__dirname, '..');
}

function projectPath(projectRoot, ...parts) {
  return path.join(projectRoot, ...parts);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function printUsage(stream = process.stdout) {
  stream.write(`${USAGE}\n`);
}

function ensureMilestoneHandoff(projectRoot, milestone) {
  const reviewDir = projectPath(projectRoot, '_cobolt-output', 'latest', 'review');
  const genericPath = path.join(reviewDir, 'review-handoff.json');
  const milestonePath = path.join(reviewDir, `${milestone}-review-handoff.json`);
  if (!fs.existsSync(milestonePath) && fs.existsSync(genericPath)) {
    fs.copyFileSync(genericPath, milestonePath);
  }
  return milestonePath;
}

function repairReviewReport(projectRoot, milestone) {
  const handoff = readJson(projectPath(projectRoot, '_cobolt-output', 'latest', 'review', 'review-handoff.json'));
  if (!handoff) {
    return { ok: false, reason: 'review-handoff-missing' };
  }
  const reportPath = buildReviewReport(projectRoot, milestone, handoff);
  return { ok: true, reportPath };
}

function reviewCounts(projectRoot) {
  const reviewFindings = readJson(
    projectPath(projectRoot, '_cobolt-output', 'latest', 'review', 'review-findings.json'),
  );
  const manifest = readJson(projectPath(projectRoot, '_cobolt-output', 'latest', 'review', 'review-manifest.json'));
  const findings = Array.isArray(reviewFindings?.findings)
    ? reviewFindings.findings
    : Array.isArray(reviewFindings)
      ? reviewFindings
      : [];
  return {
    remainingFindings: findings.length,
    criticalHighCount: findings.filter((finding) =>
      ['critical', 'high'].includes(String(finding?.severity || '').toLowerCase()),
    ).length,
    reviewersDispatched: Array.isArray(manifest?.dispatched) ? manifest.dispatched.length : 0,
    reviewersCompleted: Array.isArray(manifest?.completed) ? manifest.completed.length : 0,
  };
}

function verifyReviewCoreOutputs(projectRoot, milestone) {
  const reviewDir = projectPath(projectRoot, '_cobolt-output', 'latest', 'review');
  const reportPath = projectPath(projectRoot, '_cobolt-output', 'reports', milestone, `${milestone}-review-report.md`);
  const milestoneHandoff = ensureMilestoneHandoff(projectRoot, milestone);
  const required = [
    path.join(reviewDir, 'review-handoff.json'),
    milestoneHandoff,
    path.join(reviewDir, 'review-findings.json'),
    reportPath,
  ];
  const missing = required.filter((filePath) => !fs.existsSync(filePath) || fs.statSync(filePath).size === 0);
  return { passed: missing.length === 0, missing, reportPath, milestoneHandoff };
}

function writeBuildReviewCheckpoint(projectRoot, milestone, options = {}) {
  repairReviewReport(projectRoot, milestone);
  const checked = verifyReviewCoreOutputs(projectRoot, milestone);
  if (!checked.passed) return { ok: false, missing: checked.missing };

  const generatedAt = new Date().toISOString();
  const counts = reviewCounts(projectRoot);
  const checkpoint = {
    checkpoint: 'review',
    status: 'passed',
    milestone,
    passedAt: generatedAt,
    metrics: counts,
    decision: 'proceed-to-step-06',
    source: 'cobolt-build-review-step',
  };

  const checkpointPath = projectPath(
    projectRoot,
    '_cobolt-output',
    'latest',
    'build',
    'checkpoints',
    `${milestone}-05-review.json`,
  );
  writeJson(checkpointPath, checkpoint);
  writeJson(projectPath(projectRoot, '_cobolt-output', 'latest', 'build', 'checkpoints', '05-review.json'), checkpoint);
  writeJson(projectPath(projectRoot, '_cobolt-output', 'latest', 'review', `${milestone}-05-review.json`), checkpoint);

  const proof = {
    step: '05-review',
    status: 'passed',
    milestone,
    verifiedAt: generatedAt,
    generatedBy: 'cobolt-build-review-step',
    command: options.command || null,
    evidence: {
      checkpoint: path.relative(projectRoot, checkpointPath).replace(/\\/g, '/'),
      handoff: '_cobolt-output/latest/review/review-handoff.json',
      milestoneHandoff: `_cobolt-output/latest/review/${milestone}-review-handoff.json`,
      report: `_cobolt-output/reports/${milestone}/${milestone}-review-report.md`,
    },
  };
  const proofPath = projectPath(
    projectRoot,
    '_cobolt-output',
    'latest',
    'build',
    'proofs',
    `${milestone}-05-review.proof.json`,
  );
  writeJson(proofPath, proof);
  syncReviewExecutionLedger(projectRoot, milestone, {
    reviewFindingsPath: projectPath(projectRoot, '_cobolt-output', 'latest', 'review', 'review-findings.json'),
    reviewHandoffPath: projectPath(projectRoot, '_cobolt-output', 'latest', 'review', 'review-handoff.json'),
    reportPath: checked.reportPath,
  });
  projectExecutionLedger(projectRoot);

  return {
    ok: true,
    checkpointPath,
    proofPath,
    reportPath: checked.reportPath,
    handoffPath: checked.milestoneHandoff,
    metrics: counts,
  };
}

function runReviewCli(projectRoot, milestone, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const root = repoRoot();
  const cliPath = path.join(root, 'cli', 'index.js');
  const runtimeDir = projectPath(projectRoot, '_cobolt-output', 'latest', 'review', 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const stdoutPath = path.join(runtimeDir, `${milestone}-build-step-review.stdout.log`);
  const stderrPath = path.join(runtimeDir, `${milestone}-build-step-review.stderr.log`);
  const outFd = fs.openSync(stdoutPath, 'w');
  const errFd = fs.openSync(stderrPath, 'w');

  let codexBin = process.env.COBOLT_CODEX_BIN || '';
  try {
    if (!codexBin) {
      codexBin = require('../cli/lib/codex-runner').findCodexBinary() || '';
    }
  } catch {
    codexBin = '';
  }

  const command = [cliPath, 'review', milestone, '--autonomous', '--build-pipeline'];
  try {
    const result = spawnSync(process.execPath, command, {
      cwd: projectRoot,
      timeout: timeoutMs,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
      env: {
        ...process.env,
        COBOLT_HOME: process.env.COBOLT_HOME || root,
        COBOLT_TOOLS: process.env.COBOLT_TOOLS || path.join(root, 'tools'),
        COBOLT_TOOLS_DIR: process.env.COBOLT_TOOLS_DIR || path.join(root, 'tools'),
        ...(codexBin ? { COBOLT_CODEX_BIN: codexBin } : {}),
      },
    });
    return {
      exitCode: result.status ?? (result.error ? 1 : 0),
      signal: result.signal || null,
      error: result.error ? String(result.error.message || result.error) : null,
      command: `node ${command.map((part) => JSON.stringify(part)).join(' ')}`,
      stdoutPath,
      stderrPath,
      codexBin: codexBin || null,
    };
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
}

function run(args = parseArgs()) {
  if (args.command !== 'run') {
    return { ok: args.command === 'help', usage: USAGE };
  }

  const milestone = normalizeMilestone(args.milestone);
  if (!milestone) {
    return { ok: false, reason: 'milestone-required', message: '--milestone M{n} is required' };
  }

  const projectRoot = process.cwd();
  const review = runReviewCli(projectRoot, milestone, args.timeoutMs);
  if (review.exitCode !== 0) {
    return {
      ok: false,
      reason: 'review-cli-failed',
      review,
      message: `cobolt-review exited with ${review.exitCode}${review.error ? `: ${review.error}` : ''}`,
    };
  }

  const checkpoint = writeBuildReviewCheckpoint(projectRoot, milestone, { command: review.command });
  if (!checkpoint.ok) {
    return {
      ok: false,
      reason: 'review-artifacts-missing',
      review,
      missing: checkpoint.missing,
    };
  }

  return { ok: true, milestone, review, checkpoint };
}

if (require.main === module) {
  const args = parseArgs();
  if (args.command === 'help') {
    printUsage(process.stdout);
    process.exit(0);
  }
  const result = run(args);
  if (result.usage) {
    printUsage(result.ok ? process.stdout : process.stderr);
  } else if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.ok) {
    console.error(`[cobolt-build-review-step] FAILED: ${result.reason || 'unknown'}`);
  } else {
    console.log(`[cobolt-build-review-step] ${result.milestone} review artifacts verified`);
  }
  // Forward inner sub-tool exit codes for review-cli failures so callers can
  // distinguish missing-dep (2) / missing-infra (3) from generic error (1).
  if (result.ok) process.exit(0);
  if (result.reason === 'review-cli-failed' && Number.isInteger(result.review?.exitCode)) {
    process.exit(result.review.exitCode);
  }
  process.exit(1);
}

module.exports = {
  ensureMilestoneHandoff,
  parseArgs,
  repairReviewReport,
  reviewCounts,
  run,
  runReviewCli,
  verifyReviewCoreOutputs,
  writeBuildReviewCheckpoint,
};
