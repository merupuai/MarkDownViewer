#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const {
  ARTIFACTS,
  SCHEMA_VERSION,
  artifactPath,
  evidenceLink,
  loadPlanningManifest,
  parseArgs,
  printJsonOrHuman,
  readJson,
  readPlanReviewThreshold,
  resolvePlanningDir,
  resolveProjectRoot,
  statusFromPlanReview,
  writeJson,
} = require('../lib/cobolt-planning-vnext');

const TOOL_ID = 'cobolt-planning-loop-verdict';

function authorityInput(id, label, tier, status, filePath, message = null) {
  return {
    id,
    label,
    tier,
    status,
    path: filePath || null,
    message,
  };
}

function statusFromJson(filePath, classifier) {
  if (!fs.existsSync(filePath))
    return { status: 'missing', message: `${path.basename(filePath)} is missing`, data: null };
  const data = readJson(filePath, null);
  if (!data) return { status: 'error', message: `${path.basename(filePath)} is unreadable`, data: null };
  return { ...classifier(data), data };
}

function classifyManifest(manifest) {
  if (manifest.summary?.buildAuthorization === 'authorized' && manifest.summary?.verdict !== 'critical') {
    return {
      status: manifest.summary.verdict === 'advisory' ? 'advisory' : 'pass',
      message: `manifest verdict ${manifest.summary.verdict}`,
    };
  }
  return {
    status: 'blocked',
    message: `manifest buildAuthorization=${manifest.summary?.buildAuthorization || 'unknown'}`,
  };
}

function classifyAudit(report) {
  const verdict = report.verdict || report.status;
  if (verdict === 'PASS' || verdict === 'pass') return { status: 'pass', message: 'plan output audit passed' };
  const results = Array.isArray(report.results) ? report.results : [];
  const blockers = results.filter((result) => result.status === 'block' || result.status === 'error');
  if (blockers.length > 0) return { status: 'blocked', message: `${blockers.length} output audit axis blocker(s)` };
  if (verdict) return { status: 'advisory', message: `plan output audit verdict ${verdict}` };
  return { status: 'advisory', message: 'plan output audit did not expose a PASS verdict' };
}

function classifySweep(report) {
  const verdict = String(report.verdict || report.status || report.summary?.verdict || '').toLowerCase();
  if (['pass', 'clean', 'ok'].includes(verdict)) return { status: 'pass', message: 'plan-fix sweep passed' };
  if (['critical', 'fail', 'failed', 'blocked', 'block'].includes(verdict))
    return { status: 'blocked', message: `plan-fix sweep verdict ${verdict}` };
  return {
    status: 'advisory',
    message: verdict ? `plan-fix sweep verdict ${verdict}` : 'plan-fix sweep verdict unknown',
  };
}

function classifyProduction(report) {
  if (report.passed === true || report.authorized === true || report.status === 'pass') {
    return { status: 'pass', message: 'production prebuild evidence passed' };
  }
  if (report.skipped === true)
    return { status: 'skipped', message: report.reason || 'production prebuild evidence skipped' };
  return { status: 'blocked', message: report.message || report.reason || 'production prebuild evidence did not pass' };
}

function classifyVNext(report) {
  const critical = (report.findings || []).filter((item) => item.severity === 'critical').length;
  const advisory = (report.findings || []).filter((item) => item.severity !== 'critical').length;
  if (critical > 0) return { status: 'blocked', message: `${critical} critical finding(s)` };
  if (advisory > 0) return { status: 'advisory', message: `${advisory} advisory finding(s)` };
  return { status: 'pass', message: 'passed' };
}

function classifyEvidenceSignature(report) {
  if (report.summary?.status === 'pass' && report.signing?.signature) {
    return { status: 'pass', message: 'planning evidence signature passed' };
  }
  if (report.summary?.status === 'advisory')
    return { status: 'advisory', message: 'planning evidence signature has advisory findings' };
  return { status: 'blocked', message: report.findings?.[0]?.message || 'planning evidence signature did not pass' };
}

function recoveryFor(id) {
  const map = {
    'planning-manifest': 'node tools/index.js planning-manifest generate --json',
    'plan-review-verdict': 'node tools/index.js plan-review run --refresh-audit --json',
    'plan-output-audit': 'node tools/index.js plan-output-audit --target . --json',
    'plan-fix-sweep': 'node tools/index.js plan-fix-sweep --target . --json',
    'production-prebuild-gate':
      'node tools/index.js production-evidence check --phase prebuild --milestone M{n} --json',
    'planning-external-source-ledger': 'node tools/index.js planning-source-ledger generate --json',
    'planning-control-map': 'node tools/index.js planning-control-map generate --json',
    'planning-risk-model': 'node tools/index.js planning-risk-model generate --json',
    'agentic-threat-model': 'node tools/index.js agentic-threat-model generate --json',
    'planning-performance-profile': 'node tools/index.js planning-performance-profile generate --json',
    'planning-replay-calibration': 'node tools/index.js planning-replay-calibration generate --json',
    'planning-evidence-signature': 'node tools/index.js planning-evidence-signature generate --json',
  };
  return map[id] || 'node tools/index.js doctor plan';
}

function buildPlanningLoopVerdict(options = {}) {
  const projectRoot = resolveProjectRoot(options);
  const planningDir = resolvePlanningDir(projectRoot, { create: options.write !== false });
  const threshold = options.strict ? 'strict' : readPlanReviewThreshold(projectRoot);
  const manifestPath = path.join(planningDir, 'planning-manifest.json');
  const planReviewPath = path.join(planningDir, 'plan-review-verdict.json');
  const outputAuditPath = path.join(projectRoot, '_cobolt-output', 'audit', 'plan-output-audit', 'audit-report.json');
  const sweepPath = path.join(projectRoot, '_cobolt-output', 'audit', 'plan-fix-sweep.json');
  const productionPath = path.join(
    projectRoot,
    '_cobolt-output',
    'latest',
    'production-evidence',
    'prebuild-gate.json',
  );
  const sourceLedgerPath = path.join(planningDir, ARTIFACTS.sourceLedger);
  const controlMapPath = path.join(planningDir, ARTIFACTS.controlMap);
  const riskModelPath = path.join(planningDir, ARTIFACTS.riskModel);
  const threatModelPath = path.join(planningDir, ARTIFACTS.threatModel);
  const performanceProfilePath = path.join(planningDir, ARTIFACTS.performanceProfile);
  const replayCalibrationPath = path.join(planningDir, ARTIFACTS.replayCalibration);
  const evidenceSignaturePath = path.join(planningDir, ARTIFACTS.evidenceSignature);

  const manifest = loadPlanningManifest(projectRoot, planningDir);
  const manifestStatus = manifest
    ? classifyManifest(manifest)
    : { status: 'missing', message: 'planning-manifest.json is missing' };
  const planReviewVerdict = readJson(planReviewPath, null);
  const planReviewStatus = statusFromPlanReview(planReviewVerdict, threshold);

  const productionTier = options.productionOptional ? 'advisory' : 'strict';
  const inputs = [
    authorityInput(
      'planning-manifest',
      'Planning manifest',
      'strict',
      manifestStatus.status,
      manifestPath,
      manifestStatus.message,
    ),
    authorityInput(
      'plan-review-verdict',
      'Plan review verdict',
      'strict',
      planReviewStatus.status,
      planReviewPath,
      planReviewStatus.message,
    ),
    authorityInput(
      'plan-output-audit',
      'Plan output audit',
      'strict',
      statusFromJson(outputAuditPath, classifyAudit).status,
      outputAuditPath,
      statusFromJson(outputAuditPath, classifyAudit).message,
    ),
    authorityInput(
      'plan-fix-sweep',
      'Plan-fix sweep',
      'strict',
      statusFromJson(sweepPath, classifySweep).status,
      sweepPath,
      statusFromJson(sweepPath, classifySweep).message,
    ),
    authorityInput(
      'production-prebuild-gate',
      'Production prebuild evidence',
      productionTier,
      statusFromJson(productionPath, classifyProduction).status,
      productionPath,
      statusFromJson(productionPath, classifyProduction).message,
    ),
    authorityInput(
      'planning-external-source-ledger',
      'External source ledger',
      options.strict ? 'strict' : 'advisory',
      statusFromJson(sourceLedgerPath, classifyVNext).status,
      sourceLedgerPath,
      statusFromJson(sourceLedgerPath, classifyVNext).message,
    ),
    authorityInput(
      'planning-control-map',
      'Planning control map',
      options.strict ? 'strict' : 'advisory',
      statusFromJson(controlMapPath, classifyVNext).status,
      controlMapPath,
      statusFromJson(controlMapPath, classifyVNext).message,
    ),
    authorityInput(
      'planning-risk-model',
      'Planning risk model',
      options.strict ? 'strict' : 'advisory',
      statusFromJson(riskModelPath, classifyVNext).status,
      riskModelPath,
      statusFromJson(riskModelPath, classifyVNext).message,
    ),
    authorityInput(
      'agentic-threat-model',
      'Agentic threat model',
      options.strict ? 'strict' : 'advisory',
      statusFromJson(threatModelPath, classifyVNext).status,
      threatModelPath,
      statusFromJson(threatModelPath, classifyVNext).message,
    ),
    authorityInput(
      'planning-performance-profile',
      'Planning performance profile',
      options.strict ? 'strict' : 'advisory',
      statusFromJson(performanceProfilePath, classifyVNext).status,
      performanceProfilePath,
      statusFromJson(performanceProfilePath, classifyVNext).message,
    ),
    authorityInput(
      'planning-replay-calibration',
      'Planning replay calibration',
      options.strict ? 'strict' : 'advisory',
      statusFromJson(replayCalibrationPath, classifyVNext).status,
      replayCalibrationPath,
      statusFromJson(replayCalibrationPath, classifyVNext).message,
    ),
    authorityInput(
      'planning-evidence-signature',
      'Planning evidence signature',
      'strict',
      statusFromJson(evidenceSignaturePath, classifyEvidenceSignature).status,
      evidenceSignaturePath,
      statusFromJson(evidenceSignaturePath, classifyEvidenceSignature).message,
    ),
  ];

  const blockingStatuses = options.strict
    ? ['blocked', 'missing', 'error', 'advisory']
    : ['blocked', 'missing', 'error'];
  const blockingInputs = inputs.filter((input) => input.tier === 'strict' && blockingStatuses.includes(input.status));
  const advisoryInputs = inputs.filter(
    (input) =>
      input.status === 'advisory' ||
      (input.tier === 'advisory' && ['blocked', 'missing', 'error'].includes(input.status)),
  );
  const status = blockingInputs.length > 0 ? 'blocked' : advisoryInputs.length > 0 ? 'advisory' : 'pass';
  const artifactMap = [
    evidenceLink(projectRoot, 'planning-manifest', manifestPath),
    evidenceLink(projectRoot, 'plan-review-verdict', planReviewPath),
    evidenceLink(projectRoot, 'plan-output-audit', outputAuditPath),
    evidenceLink(projectRoot, 'plan-fix-sweep', sweepPath),
    evidenceLink(projectRoot, 'production-prebuild-gate', productionPath),
    evidenceLink(projectRoot, 'planning-external-source-ledger', sourceLedgerPath),
    evidenceLink(projectRoot, 'planning-control-map', controlMapPath),
    evidenceLink(projectRoot, 'planning-risk-model', riskModelPath),
    evidenceLink(projectRoot, 'agentic-threat-model', threatModelPath),
    evidenceLink(projectRoot, 'planning-performance-profile', performanceProfilePath),
    evidenceLink(projectRoot, 'planning-replay-calibration', replayCalibrationPath),
    evidenceLink(projectRoot, 'planning-evidence-signature', evidenceSignaturePath),
  ];

  const report = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    generatedBy: TOOL_ID,
    projectRoot,
    planningDir,
    status,
    buildAuthorized: blockingInputs.length === 0,
    threshold,
    authorityInputs: inputs,
    blockingReasons: blockingInputs.map((input) => `${input.id}: ${input.message || input.status}`),
    advisoryReasons: advisoryInputs.map((input) => `${input.id}: ${input.message || input.status}`),
    recoveryCommands: [...new Set([...blockingInputs, ...advisoryInputs].map((input) => recoveryFor(input.id)))],
    artifactMap,
  };

  if (options.write !== false) writeJson(artifactPath(projectRoot, ARTIFACTS.loopVerdict, { planningDir }), report);
  return report;
}

function checkPlanningLoopVerdict(options = {}) {
  const report = buildPlanningLoopVerdict(options);
  return { ...report, passed: report.status !== 'blocked' && report.status !== 'error' };
}

function render(report) {
  const lines = [`planning-loop-verdict: ${report.status}`, `buildAuthorized=${report.buildAuthorized}`];
  if (report.blockingReasons.length) lines.push(`blocked: ${report.blockingReasons[0]}`);
  if (!report.blockingReasons.length && report.advisoryReasons.length)
    lines.push(`advisory: ${report.advisoryReasons[0]}`);
  return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === 'help') {
    process.stdout.write(
      'usage: cobolt-planning-loop-verdict generate|check [--project <dir>] [--json] [--strict] [--production-optional]\n',
    );
    return 0;
  }
  const report = options.command === 'check' ? checkPlanningLoopVerdict(options) : buildPlanningLoopVerdict(options);
  printJsonOrHuman(report, options.json, render);
  if (options.command === 'check' && report.passed === false) return 1;
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = {
  TOOL_ID,
  buildPlanningLoopVerdict,
  checkPlanningLoopVerdict,
  main,
};
