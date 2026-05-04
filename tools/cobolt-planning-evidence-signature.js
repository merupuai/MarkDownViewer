#!/usr/bin/env node

const crypto = require('node:crypto');
const path = require('node:path');

const {
  ARTIFACTS,
  SCHEMA_VERSION,
  artifactPath,
  evidenceLink,
  finding,
  parseArgs,
  printJsonOrHuman,
  readJson,
  resolvePlanningDir,
  resolveProjectRoot,
  writeJson,
} = require('../lib/cobolt-planning-vnext');

const TOOL_ID = 'cobolt-planning-evidence-signature';

const EVIDENCE_FILES = [
  ['planning-manifest', 'planning-manifest.json'],
  ['plan-review-verdict', 'plan-review-verdict.json'],
  ['plan-output-audit', path.join('_cobolt-output', 'audit', 'plan-output-audit', 'audit-report.json')],
  ['plan-fix-sweep', path.join('_cobolt-output', 'audit', 'plan-fix-sweep.json')],
  ['production-prebuild-gate', path.join('_cobolt-output', 'latest', 'production-evidence', 'prebuild-gate.json')],
  ['planning-external-source-ledger', ARTIFACTS.sourceLedger],
  ['planning-control-map', ARTIFACTS.controlMap],
  ['planning-risk-model', ARTIFACTS.riskModel],
  ['agentic-threat-model', ARTIFACTS.threatModel],
  ['planning-performance-profile', ARTIFACTS.performanceProfile],
  ['planning-replay-calibration', ARTIFACTS.replayCalibration],
];

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digestPayload(payload, key = null) {
  if (key) return crypto.createHmac('sha256', key).update(payload).digest('hex');
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function buildEvidenceLinks(projectRoot, planningDir) {
  return EVIDENCE_FILES.map(([id, relPath]) => {
    const fullPath = relPath.includes('_cobolt-output')
      ? path.join(projectRoot, relPath)
      : path.join(planningDir, relPath);
    return evidenceLink(projectRoot, id, fullPath);
  });
}

function buildPlanningEvidenceSignature(options = {}) {
  const projectRoot = resolveProjectRoot(options);
  const planningDir = resolvePlanningDir(projectRoot, { create: options.write !== false });
  const evidenceLinks = buildEvidenceLinks(projectRoot, planningDir);
  const presentLinks = evidenceLinks.filter((link) => link.present && link.sha256);
  const findings = [];

  if (presentLinks.length === 0) {
    findings.push(finding('SIGNATURE-NO-EVIDENCE', 'critical', 'no planning evidence artifacts are available to sign'));
  }

  const missingAuthorityIds = evidenceLinks
    .filter(
      (link) =>
        ['planning-manifest', 'plan-review-verdict', 'plan-output-audit', 'plan-fix-sweep'].includes(link.id) &&
        !link.present,
    )
    .map((link) => link.id);
  if (missingAuthorityIds.length > 0) {
    findings.push(
      finding(
        'SIGNATURE-AUTHORITY-MISSING',
        options.strict ? 'critical' : 'advisory',
        'core plan-close evidence is missing from signature payload',
        {
          missingAuthorityIds,
        },
      ),
    );
  }

  const signingKey = process.env.COBOLT_EVIDENCE_SIGNING_KEY || null;
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    projectRoot,
    planningDir,
    evidence: presentLinks
      .map((link) => ({ id: link.id, path: link.path, sha256: link.sha256 }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
  const payloadCanonical = canonicalJson(payload);
  const signature = digestPayload(payloadCanonical, signingKey);
  const report = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    generatedBy: TOOL_ID,
    projectRoot,
    planningDir,
    signing: {
      algorithm: signingKey ? 'hmac-sha256' : 'sha256-local',
      keyId: signingKey
        ? process.env.COBOLT_EVIDENCE_SIGNING_KEY_ID || 'env:COBOLT_EVIDENCE_SIGNING_KEY'
        : 'local-unsigned-digest',
      payloadSha256: `sha256:${crypto.createHash('sha256').update(payloadCanonical).digest('hex')}`,
      signature: `${signingKey ? 'hmac-sha256' : 'sha256'}:${signature}`,
    },
    summary: {
      status: findings.some((item) => item.severity === 'critical') ? 'blocked' : findings.length ? 'advisory' : 'pass',
      evidenceCount: presentLinks.length,
      missingCount: evidenceLinks.length - presentLinks.length,
      signedEvidenceIds: presentLinks.map((link) => link.id),
    },
    evidenceLinks,
    findings,
  };

  if (options.write !== false)
    writeJson(artifactPath(projectRoot, ARTIFACTS.evidenceSignature, { planningDir }), report);
  return report;
}

function checkPlanningEvidenceSignature(options = {}) {
  const projectRoot = resolveProjectRoot(options);
  const planningDir = resolvePlanningDir(projectRoot, { create: false });
  const current = readJson(path.join(planningDir, ARTIFACTS.evidenceSignature), null);
  const regenerated = buildPlanningEvidenceSignature({ ...options, projectRoot, write: false });
  const signatureMatches = current?.signing?.signature && current.signing.signature === regenerated.signing.signature;
  const report = {
    ...regenerated,
    signatureMatches: signatureMatches === true,
    passed:
      signatureMatches === true &&
      (options.strict
        ? !regenerated.findings.length
        : !regenerated.findings.some((item) => item.severity === 'critical')),
  };
  if (!signatureMatches) {
    report.findings = [
      ...report.findings,
      finding('SIGNATURE-MISMATCH', 'critical', 'planning evidence signature does not match current evidence payload'),
    ];
    report.summary = { ...report.summary, status: 'blocked' };
  }
  return report;
}

function render(report) {
  return `planning-evidence-signature: ${report.summary.status}; evidence=${report.summary.evidenceCount}`;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === 'help') {
    process.stdout.write(
      'usage: cobolt-planning-evidence-signature generate|check [--project <dir>] [--json] [--strict]\n',
    );
    return 0;
  }
  const report =
    options.command === 'check' ? checkPlanningEvidenceSignature(options) : buildPlanningEvidenceSignature(options);
  printJsonOrHuman(report, options.json, render);
  if (options.command === 'check' && report.passed === false) return 1;
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = {
  TOOL_ID,
  buildPlanningEvidenceSignature,
  checkPlanningEvidenceSignature,
  canonicalJson,
  main,
};
