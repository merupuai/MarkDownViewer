#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { projectExecutionLedger, syncFixExecutionLedger } = require('../lib/cobolt-execution-ledger');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    command: argv[0] || 'run',
    milestone: null,
    json: false,
    delegate: false,
    timeoutMs: 30 * 60 * 1000,
  };
  if (argv.includes('--help') || argv.includes('-h')) args.command = 'help';
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--milestone' || arg === '-m') args.milestone = normalizeMilestone(argv[++i]);
    else if (arg === '--json') args.json = true;
    else if (arg === '--delegate') args.delegate = true;
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

function projectPath(projectRoot, ...parts) {
  return path.join(projectRoot, ...parts);
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, ''));
  } catch {
    return fallback;
  }
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeJson(filePath, payload) {
  writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function reviewDir(projectRoot) {
  return projectPath(projectRoot, '_cobolt-output', 'latest', 'review');
}

function fixDir(projectRoot) {
  return projectPath(projectRoot, '_cobolt-output', 'latest', 'fix');
}

function buildDir(projectRoot, milestone) {
  return projectPath(projectRoot, '_cobolt-output', 'latest', 'build', milestone);
}

function reportDir(projectRoot, milestone) {
  return projectPath(projectRoot, '_cobolt-output', 'reports', milestone);
}

function loadReviewState(projectRoot) {
  const handoffPath = path.join(reviewDir(projectRoot), 'review-handoff.json');
  const findingsPath = path.join(reviewDir(projectRoot), 'review-findings.json');
  const handoffExists = fs.existsSync(handoffPath);
  const findingsExists = fs.existsSync(findingsPath);
  const handoff = readJson(handoffPath, {});
  const reviewFindings = readJson(findingsPath, { findings: [] });
  const findings = Array.isArray(reviewFindings?.findings) ? reviewFindings.findings : [];
  return { handoff, reviewFindings, findings, handoffExists, findingsExists, handoffPath, findingsPath };
}

function blockingFindingIds(handoff, findings) {
  const fromHandoff = Array.isArray(handoff?.findings?.blocking) ? handoff.findings.blocking : [];
  const inferred = findings
    .filter((finding) => {
      const severity = String(finding?.severity || '').toLowerCase();
      const status = String(finding?.verification?.status || '').toLowerCase();
      return ['critical', 'high'].includes(severity) && status !== 'rejected';
    })
    .map((finding) => finding.id)
    .filter(Boolean);
  return [...new Set([...fromHandoff, ...inferred])];
}

function writeNoBlockingFixArtifacts(projectRoot, milestone, reviewState) {
  const generatedAt = new Date().toISOString();
  const blocking = blockingFindingIds(reviewState.handoff, reviewState.findings);
  const nonBlocking = reviewState.findings.filter((finding) => !blocking.includes(finding.id));
  const fDir = fixDir(projectRoot);
  const bDir = buildDir(projectRoot, milestone);
  const checkpointsDir = projectPath(projectRoot, '_cobolt-output', 'latest', 'build', 'checkpoints');
  const rDir = reportDir(projectRoot, milestone);

  const tracker = {
    version: '1.0.0',
    generatedAt,
    generatedBy: 'cobolt-build-fix-step',
    milestone,
    status: 'no-blocking-findings',
    findings: nonBlocking.map((finding) => ({
      id: finding.id,
      severity: finding.severity || 'medium',
      status: 'backlog',
      source: 'review',
      location: finding.location || null,
      reason: 'Non-blocking finding carried forward; no automated patch required for Build Step 06.',
    })),
    summary: {
      total: reviewState.findings.length,
      blocking: 0,
      carriedForward: nonBlocking.length,
      resolved: 0,
    },
  };
  const trackerPath = path.join(fDir, 'finding-tracker.json');
  writeJson(trackerPath, tracker);

  const completeness = {
    version: '1.0.0',
    generatedAt,
    generatedBy: 'cobolt-build-fix-step',
    milestone,
    passed: true,
    status: 'no-blocking-findings',
    regressionTestResult: 'not_applicable',
    fixIntroducedRegressions: 0,
    unresolvedCriticalHigh: 0,
    totals: tracker.summary,
  };
  const completenessPath = path.join(fDir, 'fix-completeness-report.json');
  writeJson(completenessPath, completeness);

  writeJson(path.join(fDir, 'fix-iteration-log.json'), {
    generatedAt,
    milestone,
    iterations: [],
    decision: 'no-blocking-findings',
  });
  writeJson(path.join(fDir, 'troubleshooting-dossier.json'), {
    generatedAt,
    milestone,
    dossiers: [],
    decision: 'no-blocking-findings',
  });

  const checkpoint = {
    step: '06-fix',
    milestone,
    status: 'no-findings',
    generatedAt,
    generatedBy: 'cobolt-build-fix-step',
    remainingCount: 0,
    unresolvedCriticalHigh: 0,
    fixesApplied: 0,
    carriedForwardNonBlocking: nonBlocking.length,
    decision: 'proceed-to-contract-replay',
    evidence: {
      reviewHandoff: '_cobolt-output/latest/review/review-handoff.json',
      findingTracker: '_cobolt-output/latest/fix/finding-tracker.json',
      completeness: '_cobolt-output/latest/fix/fix-completeness-report.json',
    },
  };
  const checkpointPath = path.join(bDir, `${milestone}-06-fix.json`);
  writeJson(checkpointPath, checkpoint);
  writeJson(path.join(checkpointsDir, `${milestone}-06-fix.json`), checkpoint);
  writeJson(path.join(checkpointsDir, '06-fix.json'), checkpoint);

  const report = [
    `# ${milestone} Fix Report`,
    '',
    `Generated: ${generatedAt}`,
    '',
    '## Decision',
    '',
    'No critical or high review findings were present after Build Step 05. Build Step 06 wrote no-action fix evidence and carried non-blocking findings forward for backlog handling.',
    '',
    `- Review findings: ${reviewState.findings.length}`,
    `- Blocking findings: 0`,
    `- Carried forward non-blocking findings: ${nonBlocking.length}`,
    '',
  ].join('\n');
  writeFile(path.join(rDir, `${milestone}-fix-report.md`), `${report}\n`);
  writeFile(path.join(rDir, `${milestone}-rca-report.md`), `${report}\n`);
  syncFixExecutionLedger(projectRoot, milestone, {
    findingTrackerPath: trackerPath,
    completenessPath,
  });
  projectExecutionLedger(projectRoot);

  return {
    ok: true,
    reason: 'no-blocking-findings',
    checkpointPath,
    trackerPath,
    completenessPath,
    carriedForwardNonBlocking: nonBlocking.length,
  };
}

function delegateToFix(projectRoot, milestone, timeoutMs) {
  const cliPath = path.resolve(__dirname, '..', 'cli', 'index.js');
  const result = spawnSync(process.execPath, [cliPath, 'fix', milestone, '--autonomous', '--build-pipeline'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    env: {
      ...process.env,
      COBOLT_TOOLS: process.env.COBOLT_TOOLS || path.resolve(__dirname),
      COBOLT_TOOLS_DIR: process.env.COBOLT_TOOLS_DIR || path.resolve(__dirname),
    },
  });
  if ((result.status ?? 1) === 0) {
    syncFixExecutionLedger(projectRoot, milestone);
    projectExecutionLedger(projectRoot);
  }
  return {
    ok: (result.status ?? 1) === 0,
    reason: 'delegated-to-cobolt-fix',
    exitCode: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout || '',
    stderr: result.stderr || (result.error ? String(result.error.message || result.error) : ''),
  };
}

function run(args = parseArgs()) {
  if (args.command !== 'run') {
    return {
      ok: args.command === 'help',
      usage: 'node tools/cobolt-build-fix-step.js run --milestone M1 [--delegate] [--json]',
    };
  }
  const milestone = normalizeMilestone(args.milestone);
  if (!milestone) return { ok: false, reason: 'milestone-required' };

  const projectRoot = process.cwd();
  const reviewState = loadReviewState(projectRoot);
  if (!reviewState.handoffExists) {
    return { ok: false, reason: 'review-handoff-missing', path: reviewState.handoffPath };
  }
  if (!reviewState.findingsExists) {
    return { ok: false, reason: 'review-findings-missing', path: reviewState.findingsPath };
  }
  if (reviewState.handoff?.reviewIntegrity?.passed === false) {
    return { ok: false, reason: 'review-integrity-failed' };
  }
  const blocking = blockingFindingIds(reviewState.handoff, reviewState.findings);
  if (blocking.length > 0) {
    if (args.delegate) return delegateToFix(projectRoot, milestone, args.timeoutMs);
    return { ok: false, reason: 'blocking-findings-require-cobolt-fix', blocking };
  }
  return writeNoBlockingFixArtifacts(projectRoot, milestone, reviewState);
}

if (require.main === module) {
  const args = parseArgs();
  const result = run(args);
  if (args.json || result.usage) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.ok) {
    console.error(`[cobolt-build-fix-step] FAILED: ${result.reason || 'unknown'}`);
  } else {
    console.log(`[cobolt-build-fix-step] ${result.reason}`);
  }
  process.exit(result.ok ? 0 : 1);
}

module.exports = {
  blockingFindingIds,
  parseArgs,
  run,
  writeNoBlockingFixArtifacts,
};
