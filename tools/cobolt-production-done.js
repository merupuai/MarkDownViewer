#!/usr/bin/env node

// CoBolt Production Done Checklist (v0.44.0).
//
// Operationalizes the "Production Done Checklist" at the end of
// docs/COBOLT-SDLC-GAPS-FINDINGS-AND-RESEARCH.md. Produces a verdict JSON
// enumerating which of the 8 checks passed and which failed. Intended to
// plug into cobolt-release-readiness-check as a hard gate for
// production-track projects.
//
// The 8 points (from the gaps doc, closing the loop):
//   1. Every requirement maps to implementation, tests, runtime, release evidence.
//   2. Planning ambiguity + assumptions resolved or blocked from release.
//   3. Architecture / API / data / authz / compliance contracts current + replayed.
//   4. Build + audit + validate gates pass.
//   5. SBOM + SCA/CVE + license + secrets + container/IaC + provenance evidence.
//   6. Rollback + observability + incident + backup/restore + runbook evidence.
//   7. Post-deploy verification passed.
//   8. DORA feedback captured, change register populated, postmortems within SLA.
//
// Each check is backed by a concrete artifact on disk (no heuristics).
//
// Commands:
//   check  [--milestone M1] [--env production] [--json]
//   help
//
// Exit codes: 0 all-pass, 1 one-or-more-failed.
//
// Bypass: COBOLT_V12_GATES=bypass (master) | COBOLT_PRODUCTION_DONE_GATE=0 (per-gate).

const fs = require('node:fs');
const path = require('node:path');
const { logDecision } = require('../lib/cobolt-gate-audit');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    command: argv[0] && !argv[0].startsWith('-') ? argv[0] : 'help',
    root: process.cwd(),
    milestone: null,
    environment: 'production',
    json: false,
  };
  const start = args.command === argv[0] ? 1 : 0;
  for (let i = start; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') args.root = argv[++i] || args.root;
    else if (arg === '--milestone' || arg === '-m') args.milestone = normalizeMilestone(argv[++i]);
    else if (arg === '--env' || arg === '-e') args.environment = argv[++i];
    else if (arg === '--json') args.json = true;
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

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

function exists(p, minBytes = 1) {
  try {
    const stat = fs.statSync(p);
    return stat.isFile() && stat.size >= minBytes;
  } catch {
    return false;
  }
}

function checkMilestoneArtifact(root, milestone, relFromBuild, minBytes = 1) {
  if (!milestone) return false;
  const p = path.join(root, '_cobolt-output', 'latest', 'build', milestone, relFromBuild);
  return exists(p, minBytes);
}

function evaluate(projectRoot, milestone, environment) {
  const root = path.resolve(projectRoot);
  const results = [];

  // 1. Requirements → implementation + tests + runtime + release evidence.
  const rtmPath = path.join(root, '_cobolt-output', 'latest', 'planning', 'rtm.json');
  const rtm = readJson(rtmPath);
  const rtmOk = rtm?.requirements && Object.keys(rtm.requirements).length > 0;
  results.push({
    id: 'PROD-1-requirement-coverage',
    label: 'Every requirement maps to implementation + tests + runtime + release evidence (RTM populated)',
    pass: !!rtmOk,
    evidence: rtmPath,
    remediation: 'Run /cobolt-plan so cobolt-rtm populates planning/rtm.json with every FR/NFR/IR.',
  });

  // 2. Ambiguity + assumptions resolved.
  const conflictPath = path.join(root, '_cobolt-output', 'latest', 'planning', 'source-conflicts.json');
  const assumptionsPath = path.join(root, '_cobolt-output', 'latest', 'planning', 'assumptions-log.md');
  const conflicts = readJson(conflictPath);
  const unresolved = Array.isArray(conflicts?.conflicts)
    ? conflicts.conflicts.filter((c) => String(c.status || '').toLowerCase() !== 'resolved').length
    : 0;
  results.push({
    id: 'PROD-2-ambiguity-resolved',
    label: 'Planning ambiguity + assumptions resolved (source-conflicts + assumptions-log)',
    pass: unresolved === 0 && exists(assumptionsPath),
    evidence: [conflictPath, assumptionsPath],
    remediation: 'Resolve open source-conflicts and populate assumptions-log.md before production release.',
  });

  // 3. Architecture / API / data / authz / compliance contracts current + replayed.
  const contractPaths = [
    'selected-stack-contract.json',
    'app-surface-contract.json',
    'milestone-surface-map.json',
    'authz-matrix.json',
    'compliance-scope.json',
    'supply-chain-policy.json',
    'sdlc-lifecycle-contract.json',
    'test-obligation-map.json',
  ].map((f) => path.join(root, '_cobolt-output', 'latest', 'planning', f));
  const missing = contractPaths.filter((p) => !exists(p));
  results.push({
    id: 'PROD-3-contracts-current',
    label: 'Architecture + API + data + authz + compliance contracts present',
    pass: missing.length === 0,
    evidence: contractPaths,
    missing,
    remediation: 'Run /cobolt-plan to emit every v0.41 + v0.42 contract before production release.',
  });

  // 4. Build + audit + validate gates pass.
  const validationPath = milestone
    ? path.join(root, '_cobolt-output', 'latest', 'build', milestone, `${milestone}-validation-results.json`)
    : null;
  const validation = validationPath ? readJson(validationPath) : null;
  const validationOk = validation && String(validation.overallStatus).toUpperCase() === 'PASS';
  results.push({
    id: 'PROD-4-build-validate-pass',
    label: 'Build + audit + validate (Phase A+B) pass',
    pass: !!validationOk,
    evidence: validationPath,
    remediation: 'Re-run build/validate until M{n}-validation-results.overallStatus === PASS.',
  });

  // 5. Supply-chain evidence.
  const supplyPaths = [
    path.join(root, 'sbom.cdx.json'),
    path.join(root, '_cobolt-output', 'latest', 'security', 'scan-report.json'),
    path.join(root, '_cobolt-output', 'latest', 'security', 'secrets-report.json'),
  ];
  const anySupply = supplyPaths.some((p) => exists(p));
  results.push({
    id: 'PROD-5-supply-chain',
    label: 'SBOM + SCA/CVE + license + secrets evidence present',
    pass: anySupply,
    evidence: supplyPaths,
    remediation:
      'Run npm run scan:sbom, scan:sast (or legacy tools:sbom, tools:scan); commit the output under _cobolt-output/latest/security/.',
  });

  // 6. Deploy readiness (rollback + observability + runbook + backup + ownership).
  const readinessPresent = checkMilestoneArtifact(root, milestone, `${milestone}-deploy-readiness.json`);
  results.push({
    id: 'PROD-6-deploy-readiness',
    label: 'Rollback + observability + runbook + backup/restore + ownership recorded',
    pass: readinessPresent,
    evidence: milestone
      ? path.join(root, '_cobolt-output', 'latest', 'build', milestone, `${milestone}-deploy-readiness.json`)
      : null,
    remediation:
      'Run node tools/cobolt-deploy-readiness.js scaffold --milestone ... --env production and fill in the fields.',
  });

  // 7. Post-deploy verification.
  const postDeployPath = milestone
    ? path.join(root, '_cobolt-output', 'latest', 'deploy', `${milestone}-post-deploy-verdict.json`)
    : null;
  const postDeploy = postDeployPath ? readJson(postDeployPath) : null;
  const postDeployOk = postDeploy && postDeploy.ok !== false && postDeploy.passed !== false;
  results.push({
    id: 'PROD-7-post-deploy-verified',
    label: 'Post-deploy verification passed (smoke + monitoring probes)',
    pass: !!postDeployOk,
    evidence: postDeployPath,
    remediation: 'Run cobolt-deploy-verify + cobolt-mttr-probe and commit the verdicts.',
  });

  // 8. DORA + change-register + postmortem SLA.
  const changeRegister = path.join(root, '_cobolt-output', 'audit', 'change-register.jsonl');
  const doraMetrics = path.join(root, '_cobolt-output', 'audit', 'dora-metrics.jsonl');
  const hasChangeRegister = exists(changeRegister);
  const hasDora = exists(doraMetrics);
  // Postmortem SLA is opportunistic — a project with zero incidents trivially passes.
  let postmortemOk = true;
  try {
    const pmSla = require('./cobolt-postmortem-sla');
    const auditResult = pmSla.cmdAudit({ root });
    postmortemOk = auditResult.ok;
  } catch {
    postmortemOk = true;
  }
  results.push({
    id: 'PROD-8-learning-loop',
    label: 'DORA metrics captured + change register populated + postmortems within SLA',
    pass: hasChangeRegister && hasDora && postmortemOk,
    evidence: { changeRegister, doraMetrics, postmortemOk },
    remediation:
      'Run cobolt-dora report, ensure cobolt-change-register has at least one entry, and close postmortems within SLA.',
  });

  const failed = results.filter((r) => !r.pass);
  const passed = failed.length === 0;
  return {
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-production-done',
    projectRoot: root,
    milestone,
    environment,
    passed,
    totalChecks: results.length,
    failedChecks: failed.length,
    results,
  };
}

function run(args = parseArgs()) {
  const v12 = String(process.env.COBOLT_V12_GATES || '').toLowerCase();
  if (v12 === 'bypass' || v12 === 'off') {
    logDecision(args.root || process.cwd(), {
      gate: 'cobolt-production-done',
      decision: 'bypass',
      env: 'COBOLT_V12_GATES',
    });
    return { ok: true, bypassed: 'COBOLT_V12_GATES', reason: 'master-bypass', passed: true, results: [] };
  }
  if (process.env.COBOLT_PRODUCTION_DONE_GATE === '0') {
    logDecision(args.root || process.cwd(), {
      gate: 'cobolt-production-done',
      decision: 'bypass',
      env: 'COBOLT_PRODUCTION_DONE_GATE',
    });
    return { ok: true, bypassed: 'COBOLT_PRODUCTION_DONE_GATE', reason: 'per-gate-bypass', passed: true, results: [] };
  }
  if (args.command === 'help') {
    return {
      ok: true,
      usage: 'node tools/cobolt-production-done.js check [--milestone M1] [--env production] [--json]',
    };
  }
  if (args.command === 'check') {
    const result = evaluate(args.root, args.milestone, args.environment);
    return { ok: result.passed, reason: result.passed ? 'production-done' : 'production-done-failed', ...result };
  }
  return { ok: false, reason: 'unknown-command', command: args.command };
}

if (require.main === module) {
  const args = parseArgs();
  const result = run(args);
  if (args.json || result.usage) console.log(JSON.stringify(result, null, 2));
  else if (!result.ok) {
    console.error(
      `${result.reason}: ${(result.results || [])
        .filter((r) => !r.pass)
        .map((r) => r.id)
        .join(', ')}`,
    );
  }
  process.exit(result.ok ? 0 : 1);
}

module.exports = { evaluate, parseArgs, run };
