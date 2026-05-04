#!/usr/bin/env node

const path = require('node:path');

const {
  ARTIFACTS,
  SCHEMA_VERSION,
  artifactPath,
  finding,
  levelFromScore,
  loadPlanningManifest,
  parseArgs,
  printJsonOrHuman,
  readJson,
  resolvePlanningDir,
  resolveProjectRoot,
  writeJson,
} = require('../lib/cobolt-planning-vnext');

const TOOL_ID = 'cobolt-planning-risk-model';

function dimension(id, label, score, evidence = []) {
  return { id, label, score, level: levelFromScore(score), evidence };
}

function buildPlanningRiskModel(options = {}) {
  const projectRoot = resolveProjectRoot(options);
  const planningDir = resolvePlanningDir(projectRoot, { create: options.write !== false });
  const manifest = loadPlanningManifest(projectRoot, planningDir);
  const sourceLedger = readJson(path.join(planningDir, ARTIFACTS.sourceLedger), null);
  const threatModel = readJson(path.join(planningDir, ARTIFACTS.threatModel), null);
  const planReview = readJson(path.join(planningDir, 'plan-review-verdict.json'), null);
  const planOutputAudit = readJson(
    path.join(projectRoot, '_cobolt-output', 'audit', 'plan-output-audit', 'audit-report.json'),
    null,
  );
  const findings = [];

  const manifestCritical = Number(manifest?.summary?.critical || 0);
  const manifestAdvisory = Number(manifest?.summary?.advisory || 0);
  const sourceMissing = (sourceLedger?.inputs || []).filter(
    (input) => input.disposition === 'included' && !input.present,
  ).length;
  const staleSources =
    Number(sourceLedger?.summary?.staleCount || 0) + Number(sourceLedger?.summary?.unknownFreshnessCount || 0);
  const openThreats = Number(threatModel?.summary?.openCount || 0);
  const criticalThreats = (threatModel?.findings || []).filter((item) => item.severity === 'critical').length;
  const reviewStatus = planReview?.status || 'missing';
  const auditResults = Array.isArray(planOutputAudit?.results) ? planOutputAudit.results : [];
  const auditBlocks = auditResults.filter((result) => result.status === 'block' || result.status === 'error').length;

  const dimensions = [
    dimension(
      'source-quality',
      'Source quality and provenance',
      Math.min(100, sourceMissing * 35 + staleSources * 10 + (sourceLedger ? 0 : 55)),
      [sourceLedger ? ARTIFACTS.sourceLedger : 'source ledger missing'],
    ),
    dimension(
      'requirements-coverage',
      'Requirement and story coverage',
      Math.min(100, manifestCritical * 35 + manifestAdvisory * 8 + (manifest ? 0 : 75)),
      [manifest ? 'planning-manifest.json' : 'planning-manifest.json missing'],
    ),
    dimension(
      'review-output-integrity',
      'Plan review and output audit integrity',
      Math.min(
        100,
        auditBlocks * 25 +
          (reviewStatus === 'critical' ? 70 : reviewStatus === 'advisory' ? 30 : reviewStatus === 'missing' ? 55 : 0),
      ),
      [
        planReview ? 'plan-review-verdict.json' : 'plan-review-verdict.json missing',
        planOutputAudit ? 'plan-output-audit report' : 'plan-output-audit missing',
      ],
    ),
    dimension(
      'agentic-attack-surface',
      'Agentic AI attack surface',
      Math.min(100, openThreats * 15 + criticalThreats * 35 + (threatModel ? 0 : 60)),
      [threatModel ? ARTIFACTS.threatModel : 'agentic-threat-model.json missing'],
    ),
    dimension(
      'build-readiness',
      'Build handoff and production evidence',
      manifest?.summary?.buildAuthorization === 'authorized' ? 20 : 70,
      [
        manifest?.summary?.buildAuthorization
          ? `planning-manifest buildAuthorization=${manifest.summary.buildAuthorization}`
          : 'build authorization unknown',
      ],
    ),
  ];

  for (const item of dimensions) {
    if (item.level === 'critical')
      findings.push(finding(`RISK-CRITICAL:${item.id}`, 'critical', `${item.label} risk is critical`));
    else if (item.level === 'high')
      findings.push(finding(`RISK-HIGH:${item.id}`, 'advisory', `${item.label} risk is high`));
  }

  const overallScore = Math.round(
    dimensions.reduce((sum, item) => sum + item.score, 0) / Math.max(1, dimensions.length),
  );
  const report = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    generatedBy: TOOL_ID,
    projectRoot,
    planningDir,
    overallScore,
    riskLevel: levelFromScore(overallScore),
    dimensions,
    findings,
  };

  if (options.write !== false) writeJson(artifactPath(projectRoot, ARTIFACTS.riskModel, { planningDir }), report);
  return report;
}

function checkPlanningRiskModel(options = {}) {
  const report = buildPlanningRiskModel(options);
  return {
    ...report,
    passed: options.strict ? !report.findings.length : !report.findings.some((item) => item.severity === 'critical'),
  };
}

function render(report) {
  return `planning-risk-model: ${report.riskLevel} (${report.overallScore}/100), findings=${report.findings.length}`;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === 'help') {
    process.stdout.write('usage: cobolt-planning-risk-model generate|check [--project <dir>] [--json] [--strict]\n');
    return 0;
  }
  const report = options.command === 'check' ? checkPlanningRiskModel(options) : buildPlanningRiskModel(options);
  printJsonOrHuman(report, options.json, render);
  if (options.command === 'check' && report.passed === false) return options.strict ? 1 : 0;
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = {
  TOOL_ID,
  buildPlanningRiskModel,
  checkPlanningRiskModel,
  main,
};
