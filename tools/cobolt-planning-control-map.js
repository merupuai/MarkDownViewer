#!/usr/bin/env node

const path = require('node:path');

const {
  ARTIFACTS,
  SCHEMA_VERSION,
  artifactPath,
  evidenceLink,
  finding,
  loadPlanningManifest,
  parseArgs,
  printJsonOrHuman,
  readJson,
  resolvePlanningDir,
  resolveProjectRoot,
  toPosix,
  writeJson,
} = require('../lib/cobolt-planning-vnext');
const { buildPlanningSourceLedger } = require('./cobolt-planning-source-ledger');

const TOOL_ID = 'cobolt-planning-control-map';

const CONTROL_DEFS = [
  {
    id: 'PLAN.EVIDENCE.MANIFEST',
    title: 'Planning evidence manifest exists and authorizes handoff',
    tier: 'strict',
    standardIds: ['NIST-SSDF-800-218', 'SLSA-SPEC'],
    evidenceIds: ['planning-manifest'],
  },
  {
    id: 'PLAN.REVIEW.VERDICT',
    title: 'Plan review verdict is fresh and below threshold',
    tier: 'strict',
    standardIds: ['NIST-SSDF-800-218', 'ISO-29148'],
    evidenceIds: ['plan-review-verdict'],
  },
  {
    id: 'PLAN.AUDIT.OUTPUT',
    title: 'Plan output audit validates generated packet consistency',
    tier: 'strict',
    standardIds: ['NIST-SSDF-800-218'],
    evidenceIds: ['plan-output-audit'],
  },
  {
    id: 'PLAN.REPAIR.SWEEP',
    title: 'Plan-fix sweep has no unresolved blocking defects',
    tier: 'strict',
    standardIds: ['NIST-SSDF-800-218'],
    evidenceIds: ['plan-fix-sweep'],
  },
  {
    id: 'PLAN.PRODUCTION.PREBUILD',
    title: 'Production prebuild evidence exists before implementation',
    tier: 'strict',
    standardIds: ['NIST-SSDF-800-218', 'EU-CRA'],
    evidenceIds: ['production-prebuild-gate'],
  },
  {
    id: 'PLAN.STANDARDS.FRESHNESS',
    title: 'External standards are versioned and freshness-assessed',
    tier: 'advisory',
    standardIds: ['NIST-SSDF-800-218', 'OWASP-ASVS', 'WCAG-22', 'OPENAPI-SPEC'],
    evidenceIds: ['planning-external-source-ledger'],
  },
  {
    id: 'PLAN.SECURITY.AGENTIC',
    title: 'Agentic planning threat model maps AI-specific threats to mitigations',
    tier: 'advisory',
    standardIds: ['NIST-AI-RMF-1', 'OWASP-LLM-TOP-10', 'MCP-SECURITY-BEST-PRACTICES'],
    evidenceIds: ['agentic-threat-model'],
  },
  {
    id: 'PLAN.RISK.MODEL',
    title: 'Planning risk model explains required scrutiny',
    tier: 'advisory',
    standardIds: ['NIST-AI-RMF-1', 'GOOGLE-SRE-SLOS'],
    evidenceIds: ['planning-risk-model'],
  },
  {
    id: 'PLAN.PERFORMANCE.PROFILE',
    title: 'Planning performance and incremental invalidation profile is available',
    tier: 'advisory',
    standardIds: ['GOOGLE-SRE-SLOS', 'OPENTELEMETRY-SEMCONV'],
    evidenceIds: ['planning-performance-profile'],
  },
  {
    id: 'PLAN.REPLAY.CALIBRATION',
    title: 'Agent replay calibration and drift evidence is available',
    tier: 'advisory',
    standardIds: ['NIST-AI-RMF-1', 'OWASP-LLM-TOP-10'],
    evidenceIds: ['planning-replay-calibration'],
  },
];

function buildEvidence(projectRoot, planningDir, options = {}) {
  return [
    evidenceLink(projectRoot, 'planning-manifest', path.join(planningDir, 'planning-manifest.json'), {
      required: true,
    }),
    evidenceLink(projectRoot, 'plan-review-verdict', path.join(planningDir, 'plan-review-verdict.json'), {
      required: true,
    }),
    evidenceLink(
      projectRoot,
      'plan-output-audit',
      path.join(projectRoot, '_cobolt-output', 'audit', 'plan-output-audit', 'audit-report.json'),
      { required: true },
    ),
    evidenceLink(
      projectRoot,
      'plan-fix-sweep',
      path.join(projectRoot, '_cobolt-output', 'audit', 'plan-fix-sweep.json'),
      {
        required: true,
      },
    ),
    evidenceLink(
      projectRoot,
      'production-prebuild-gate',
      path.join(projectRoot, '_cobolt-output', 'latest', 'production-evidence', 'prebuild-gate.json'),
      { required: options.productionOptional !== true },
    ),
    evidenceLink(projectRoot, 'planning-external-source-ledger', path.join(planningDir, ARTIFACTS.sourceLedger)),
    evidenceLink(projectRoot, 'agentic-threat-model', path.join(planningDir, ARTIFACTS.threatModel)),
    evidenceLink(projectRoot, 'planning-risk-model', path.join(planningDir, ARTIFACTS.riskModel)),
    evidenceLink(projectRoot, 'planning-performance-profile', path.join(planningDir, ARTIFACTS.performanceProfile)),
    evidenceLink(projectRoot, 'planning-replay-calibration', path.join(planningDir, ARTIFACTS.replayCalibration)),
  ];
}

function buildPlanningControlMap(options = {}) {
  const projectRoot = resolveProjectRoot(options);
  const planningDir = resolvePlanningDir(projectRoot, { create: options.write !== false });
  const sourceLedger =
    readJson(path.join(planningDir, ARTIFACTS.sourceLedger), null) ||
    buildPlanningSourceLedger({ ...options, projectRoot });
  const manifest = loadPlanningManifest(projectRoot, planningDir);
  const evidenceLinks = buildEvidence(projectRoot, planningDir, options);
  const evidenceById = new Map(evidenceLinks.map((entry) => [entry.id, entry]));
  const findings = [];

  const controlDefs = CONTROL_DEFS.map((control) =>
    control.id === 'PLAN.PRODUCTION.PREBUILD' && options.productionOptional === true
      ? { ...control, tier: 'advisory' }
      : control,
  );

  const controls = controlDefs.map((control) => {
    const links = control.evidenceIds.map((id) => evidenceById.get(id)).filter(Boolean);
    const presentCount = links.filter((link) => link.present).length;
    const status = presentCount === control.evidenceIds.length ? 'mapped' : presentCount > 0 ? 'partial' : 'missing';
    if (control.tier === 'strict' && status !== 'mapped') {
      findings.push(
        finding(`CONTROL-MISSING:${control.id}`, 'critical', `${control.id} is missing required evidence`, {
          controlId: control.id,
          missingEvidenceIds: control.evidenceIds.filter((id) => !evidenceById.get(id)?.present),
        }),
      );
    } else if (status !== 'mapped') {
      findings.push(
        finding(`CONTROL-PARTIAL:${control.id}`, 'advisory', `${control.id} has partial or missing evidence`),
      );
    }
    return { ...control, status };
  });

  const requirements = Array.isArray(manifest?.requirements)
    ? manifest.requirements.map((requirement) => ({
        id: requirement.id,
        controlIds: controls.map((control) => control.id),
        storyIds: Array.isArray(requirement.stories) ? requirement.stories : [],
        sourceIds: Array.isArray(requirement.sourceIds) ? requirement.sourceIds : [],
      }))
    : [];

  if (!manifest) {
    findings.push(
      finding('MANIFEST-MISSING', 'critical', 'planning-manifest.json is required to build a complete control map'),
    );
  }

  const strictControls = controls.filter((control) => control.tier === 'strict');
  const advisoryControls = controls.filter((control) => control.tier === 'advisory');
  const standards = (sourceLedger.sources || []).map((source) => ({
    id: source.id,
    title: source.title,
    version: source.version || null,
    url: source.url,
    freshness: source.freshness || 'unknown',
  }));

  const report = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    generatedBy: TOOL_ID,
    projectRoot,
    planningDir,
    standards,
    controls,
    requirements,
    evidenceLinks: evidenceLinks.map((link) => ({ ...link, path: toPosix(link.path) })),
    coverage: {
      strictControls: strictControls.length,
      mappedStrictControls: strictControls.filter((control) => control.status === 'mapped').length,
      advisoryControls: advisoryControls.length,
      mappedAdvisoryControls: advisoryControls.filter((control) => control.status === 'mapped').length,
    },
    findings,
  };

  if (options.write !== false) writeJson(artifactPath(projectRoot, ARTIFACTS.controlMap, { planningDir }), report);
  return report;
}

function checkPlanningControlMap(options = {}) {
  const report = buildPlanningControlMap(options);
  return {
    ...report,
    passed: options.strict ? !report.findings.length : !report.findings.some((item) => item.severity === 'critical'),
  };
}

function render(report) {
  return [
    `planning-control-map: strict ${report.coverage.mappedStrictControls}/${report.coverage.strictControls}`,
    `advisory ${report.coverage.mappedAdvisoryControls}/${report.coverage.advisoryControls}; findings=${report.findings.length}`,
  ].join('\n');
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === 'help') {
    process.stdout.write(
      'usage: cobolt-planning-control-map generate|check [--project <dir>] [--json] [--strict] [--production-optional]\n',
    );
    return 0;
  }
  const report = options.command === 'check' ? checkPlanningControlMap(options) : buildPlanningControlMap(options);
  printJsonOrHuman(report, options.json, render);
  if (options.command === 'check' && report.passed === false) return options.strict ? 1 : 0;
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = {
  TOOL_ID,
  CONTROL_DEFS,
  buildPlanningControlMap,
  checkPlanningControlMap,
  main,
};
