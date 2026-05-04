#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { buildBrownfieldSemanticDrift, detectProjectRoot } = require('./cobolt-brownfield-semantic-drift');

const TOOL_NAME = 'cobolt-brownfield-contracts';
const CONTRACT_VERSION = '1.0.0';

const PLANNING_MODES = new Set(['full', 'add-feature', 'fix-issues', 'continue-plan', 'continue-build']);
const ASSESSMENT_MODES = new Set(['assessment', 'deep', 'default', 'analysis-only']);

const CONTRACT_FILE_BY_TYPE = Object.freeze({
  'brownfield-assessment-verdict': 'brownfield-assessment-verdict.json',
  'brownfield-intake-profile': 'brownfield-intake-profile.json',
  'brownfield-security-waiver': 'brownfield-security-waiver.json',
  'legacy-data-classification': 'legacy-data-classification.json',
  'legacy-data-lifecycle': 'legacy-data-lifecycle.json',
  'brownfield-parity-contract': 'brownfield-parity-contract.json',
  'migration-safety-plan': 'migration-safety-plan.json',
  'brownfield-evidence-confidence': 'brownfield-evidence-confidence.json',
  'legacy-risk-register': 'legacy-risk-register.json',
  'brownfield-supply-chain-policy': 'brownfield-supply-chain-policy.json',
  'legacy-ops-inventory': 'legacy-ops-inventory.json',
  'modernization-ops-gap-report': 'modernization-ops-gap-report.json',
  'brownfield-modernization-readiness': 'brownfield-modernization-readiness.json',
  'standards-version-baseline': 'standards-version-baseline.json',
  'brownfield-lifecycle-map': 'brownfield-lifecycle-map.json',
  'observability-semantics-contract': 'observability-semantics-contract.json',
  'ai-system-inventory': 'ai-system-inventory.json',
});

const ASSESSMENT_CONTRACT_TYPES = Object.freeze([
  'brownfield-intake-profile',
  'brownfield-assessment-verdict',
  'legacy-data-classification',
  'brownfield-evidence-confidence',
  'legacy-risk-register',
  'standards-version-baseline',
  'brownfield-lifecycle-map',
  'ai-system-inventory',
]);

const PLANNING_CONTRACT_TYPES = Object.freeze([
  'legacy-data-lifecycle',
  'brownfield-parity-contract',
  'migration-safety-plan',
  'brownfield-supply-chain-policy',
  'legacy-ops-inventory',
  'modernization-ops-gap-report',
  'observability-semantics-contract',
  'brownfield-modernization-readiness',
]);

const P3_REQUIRED = Object.freeze([
  '16-issues-registry.json',
  '17-enhancement-advisory.md',
  '19-evidence-index.json',
  '23-master-assessment.md',
]);

const PLANNING_REQUIRED = Object.freeze([
  '24-modernization-prd.md',
  '25-modernization-trd.md',
  '26-modernization-security-requirements.md',
  '26a-modernization-secure-coding-standard.md',
  '26b-modernization-engineering-quality-standards.md',
  '26c-modernization-compliance-architecture.md',
  '27-modernization-system-architecture.md',
  '28-modernization-architecture-decisions.md',
  '29-modernization-data-model-spec.md',
  '30-modernization-api-contracts.md',
  '32-modernization-implicit-requirements.md',
  '33-modernization-dependency-and-integration-register.md',
  '35-modernization-milestones.md',
  '36-modernization-epics-and-stories.md',
  '37-modernization-traceability-matrix.md',
  '38-modernization-test-strategy.md',
  '39-modernization-delivery-plan.md',
  '40-modernization-milestone-tracker.json',
  '41-modernization-story-tracker.json',
  '42-modernization-issue-and-blocker-tracker.json',
  '43-modernization-validation-report.md',
  '44-modernization-release-readiness-checklist.md',
  '45-modernization-master-plan.md',
]);

const TEXT_HINT_FILES = Object.freeze([
  '01-intake-and-classification.md',
  '05-database-and-data-store-report.md',
  '06-integration-map.md',
  '07-configuration-and-access-audit.md',
  '09-supply-chain-and-vulnerability-review.md',
  '12-security-and-quality-assessment.md',
  '14-business-rules-and-validation.md',
  '23-master-assessment.md',
  '24-modernization-prd.md',
  '25-modernization-trd.md',
  '26-modernization-security-requirements.md',
  '26c-modernization-compliance-architecture.md',
  '27-modernization-system-architecture.md',
  '29-modernization-data-model-spec.md',
  '30-modernization-api-contracts.md',
  '38-modernization-test-strategy.md',
  '39-modernization-delivery-plan.md',
]);

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function artifactRef(bfDir, artifact) {
  const artifactPath = path.join(bfDir, artifact);
  try {
    const stats = fs.statSync(artifactPath);
    return { artifact, exists: true, sizeBytes: stats.size };
  } catch {
    return { artifact, exists: false, sizeBytes: 0 };
  }
}

function artifactRefs(bfDir, artifacts) {
  return artifacts.map((artifact) => artifactRef(bfDir, artifact));
}

function sourceArtifactsThatExist(bfDir, artifacts) {
  return artifactRefs(bfDir, artifacts).filter((entry) => entry.exists);
}

function collectText(bfDir, artifacts = TEXT_HINT_FILES) {
  const parts = [];
  for (const artifact of artifacts) {
    const content = readText(path.join(bfDir, artifact));
    if (content) parts.push(content.slice(0, 25000));
  }
  return parts.join('\n');
}

function listIssues(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data.filter((item) => item && typeof item === 'object');
  if (Array.isArray(data.issues)) return data.issues.filter((item) => item && typeof item === 'object');
  return Object.values(data).filter((value) => value && typeof value === 'object' && (value.id || value.priority));
}

function severityCounts(issues) {
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0, unknown: 0 };
  for (const issue of issues) {
    const key = String(issue.priority || issue.severity || 'unknown').toUpperCase();
    if (Object.hasOwn(counts, key)) counts[key] += 1;
    else counts.unknown += 1;
  }
  return counts;
}

function normalizeModeKey(value) {
  const mode = String(value || '')
    .trim()
    .toLowerCase();
  if (PLANNING_MODES.has(mode) || ASSESSMENT_MODES.has(mode)) return mode;
  if (mode === 'scan-full' || mode === 'reverse-engineer') return 'full';
  if (mode === 'scan-deep') return 'deep';
  if (mode === 'scan-quick' || mode === 'default') return 'assessment';
  return '';
}

function detectMode(bfDir) {
  const runContext = readJson(path.join(bfDir, '00-run-context.json')) || {};
  const issues = readJson(path.join(bfDir, '16-issues-registry.json')) || {};
  let modeKey = normalizeModeKey(runContext.modeKey || issues.meta?.modeKey || issues.meta?.scanMode);

  if (!modeKey) {
    const hasPlanningArtifacts = PLANNING_REQUIRED.some((artifact) => fs.existsSync(path.join(bfDir, artifact)));
    modeKey = hasPlanningArtifacts ? 'full' : 'assessment';
  }

  return {
    modeKey,
    planningMode: PLANNING_MODES.has(modeKey),
    assessmentMode: !PLANNING_MODES.has(modeKey),
    runContext,
  };
}

const CATEGORY_CHECKS = Object.freeze([
  { label: 'personal-data', pattern: /\b(pii|personal data|email|phone|address|user profile|customer)\b/i },
  { label: 'payment-data', pattern: /\b(pci|cardholder|credit card|payment|billing)\b/i },
  { label: 'health-data', pattern: /\b(hipaa|phi|patient|medical|health record)\b/i },
  { label: 'credentials', pattern: /\b(password|credential|secret|api key|token|jwt|oauth)\b/i },
  { label: 'financial-data', pattern: /\b(invoice|ledger|bank|financial|tax|revenue)\b/i },
  { label: 'audit-data', pattern: /\b(audit log|event log|security log|trace)\b/i },
]);

const REGULATION_CHECKS = Object.freeze([
  { label: 'GDPR', pattern: /\bgdpr\b|general data protection regulation/i },
  { label: 'HIPAA', pattern: /\bhipaa\b/i },
  { label: 'PCI-DSS', pattern: /\bpci(?:-|\s*)dss\b|\bpci\b/i },
  { label: 'SOC2', pattern: /\bsoc\s*2\b|\bsoc2\b/i },
  { label: 'FedRAMP', pattern: /\bfedramp\b/i },
  { label: 'DPDP', pattern: /\bdpdp\b/i },
]);

const EXPOSURE_CHECKS = Object.freeze([
  { label: 'public-api', pattern: /\bpublic api\b/i },
  { label: 'webhook', pattern: /\bwebhook\b/i },
  { label: 'oauth-sso', pattern: /\b(oauth|sso|saml)\b/i },
  { label: 'browser-login', pattern: /\b(browser|login|sign[- ]in|authentication)\b/i },
  { label: 'internet-facing', pattern: /\binternet\b/i },
]);

function collectEvidence(bfDir, artifacts, checks) {
  const evidence = [];
  for (const artifact of artifacts) {
    const content = readText(path.join(bfDir, artifact));
    if (!content) continue;
    for (const { label, pattern } of checks) {
      const match = content.match(pattern);
      if (!match) continue;
      const idx = content.indexOf(match[0]);
      if (idx === -1) continue;
      const start = Math.max(0, idx - 60);
      const end = Math.min(content.length, idx + match[0].length + 60);
      const snippet = content.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 240);
      if (snippet) evidence.push({ label, sourceArtifact: artifact, snippet });
    }
  }
  return evidence;
}

function uniqueLabels(evidence) {
  const seen = new Set();
  const labels = [];
  for (const item of evidence) {
    if (seen.has(item.label)) continue;
    seen.add(item.label);
    labels.push(item.label);
  }
  return labels;
}

function detectCategories(bfDir, artifacts = TEXT_HINT_FILES) {
  const evidence = collectEvidence(bfDir, artifacts, CATEGORY_CHECKS);
  return { values: uniqueLabels(evidence), evidence };
}

function detectRegulations(bfDir, artifacts = TEXT_HINT_FILES) {
  const evidence = collectEvidence(bfDir, artifacts, REGULATION_CHECKS);
  return { values: uniqueLabels(evidence), evidence };
}

function detectInternetExposure(bfDir, artifacts = TEXT_HINT_FILES) {
  const evidence = collectEvidence(bfDir, artifacts, EXPOSURE_CHECKS);
  return { exposed: evidence.length > 0, evidence };
}

function hasAnyFile(bfDir, artifacts) {
  return artifacts.some((artifact) => fs.existsSync(path.join(bfDir, artifact)));
}

function contractBase(contractType, mode, sourceArtifacts, status = 'generated') {
  return {
    contractType,
    contractVersion: CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    generatedBy: TOOL_NAME,
    modeKey: mode.modeKey,
    status,
    sourceArtifacts,
  };
}

function buildIntakeProfile(bfDir, mode, text) {
  const { values: categories, evidence: categoryEvidence } = detectCategories(bfDir, TEXT_HINT_FILES);
  const { values: regulations, evidence: regulationEvidence } = detectRegulations(bfDir, TEXT_HINT_FILES);
  const { evidence: exposureEvidence } = detectInternetExposure(bfDir, TEXT_HINT_FILES);
  const productionTrack =
    mode.planningMode || /\b(production|prod|release|deploy|sla|slo|rollback|incident)\b/i.test(text);

  const regulatedEvidence = [
    ...regulationEvidence.map((item) => ({
      regulation: item.label,
      sourceArtifact: item.sourceArtifact,
      snippet: item.snippet,
    })),
    ...categoryEvidence
      .filter((item) => item.label !== 'audit-data')
      .map((item) => ({
        category: item.label,
        sourceArtifact: item.sourceArtifact,
        snippet: item.snippet,
      })),
  ];

  // v0.66.5 (Wave 4 C-2): minimum-evidence threshold to prevent single weak
  // signals from flipping the booleans. Closes the user-reported "defaults
  // are 'regulated, internet-exposed, multi-framework' — wrong for most apps"
  // diagnostic. Default threshold is 1 (preserves v0.66.4 behavior). Operators
  // can raise via COBOLT_BROWNFIELD_MIN_EVIDENCE_HITS to demand stronger signal
  // before the boolean flips. When the threshold is set above 1 and evidence
  // exists but is below threshold, the boolean reports false with a tentative
  // advisory so the schema's evidence-array contract is not violated.
  const minHits = (() => {
    const raw = Number.parseInt(process.env.COBOLT_BROWNFIELD_MIN_EVIDENCE_HITS || '1', 10);
    return Number.isFinite(raw) && raw >= 1 ? raw : 1;
  })();
  const regulatedDataDetected = regulatedEvidence.length >= minHits;
  const regulatedDataAdvisory =
    regulatedEvidence.length > 0 && !regulatedDataDetected
      ? {
          status: 'tentative',
          evidenceCount: regulatedEvidence.length,
          requiredHits: minHits,
          message: `Found ${regulatedEvidence.length} regulation/category evidence item(s) but minimum threshold is ${minHits}. Set COBOLT_BROWNFIELD_MIN_EVIDENCE_HITS=1 to flip the boolean on a single signal, or accept the tentative classification.`,
        }
      : null;
  const internetExposure = exposureEvidence.length >= minHits;
  const internetExposureAdvisory =
    exposureEvidence.length > 0 && !internetExposure
      ? {
          status: 'tentative',
          evidenceCount: exposureEvidence.length,
          requiredHits: minHits,
          message: `Found ${exposureEvidence.length} exposure evidence item(s) but minimum threshold is ${minHits}.`,
        }
      : null;
  const internetExposureEvidence = exposureEvidence.map((item) => ({
    label: item.label,
    sourceArtifact: item.sourceArtifact,
    snippet: item.snippet,
  }));

  const deepSecurityEvidenceComplete = hasAnyFile(bfDir, [
    '12-security-and-quality-assessment.md',
    '16d-forensic-audit-report.md',
    '26-modernization-security-requirements.md',
    '46-standards-gate.json',
  ]);
  const requiresDeepSecurity =
    productionTrack && (regulatedDataDetected || internetExposure || mode.runContext.forensicAuditRequired === true);
  const waiverRequired = requiresDeepSecurity && !deepSecurityEvidenceComplete;

  const profile = {
    ...contractBase(
      'brownfield-intake-profile',
      mode,
      artifactRefs(bfDir, [
        '00-run-context.json',
        '01-intake-and-classification.md',
        '05-database-and-data-store-report.md',
        '07-configuration-and-access-audit.md',
        '12-security-and-quality-assessment.md',
      ]),
      waiverRequired ? 'requires-review' : 'complete',
    ),
    summary: 'Brownfield intake profile used to decide assessment depth, security waiver needs, and build eligibility.',
    classification: mode.planningMode ? 'modernization-planning' : 'brownfield-assessment',
    productionTrack,
    internetExposure,
    regulatedDataDetected,
    detectedDataCategories: categories,
    detectedRegulations: regulations,
    requiresDeepSecurity,
    deepSecurityEvidence: {
      status: deepSecurityEvidenceComplete ? 'complete' : 'missing',
      artifacts: sourceArtifactsThatExist(bfDir, [
        '12-security-and-quality-assessment.md',
        '16d-forensic-audit-report.md',
        '26-modernization-security-requirements.md',
        '46-standards-gate.json',
      ]),
    },
    securityWaiverRequired: waiverRequired,
  };

  if (regulatedDataDetected) profile.regulatedEvidence = regulatedEvidence;
  if (internetExposure) profile.internetExposureEvidence = internetExposureEvidence;
  // v0.66.5 (Wave 4 C-2): surface tentative-classification advisories so log
  // readers and downstream gates can see "evidence found but below threshold"
  // distinctly from "no evidence found at all".
  if (regulatedDataAdvisory) profile.regulatedDataAdvisory = regulatedDataAdvisory;
  if (internetExposureAdvisory) profile.internetExposureAdvisory = internetExposureAdvisory;
  profile.evidenceThresholds = { minHits, source: 'COBOLT_BROWNFIELD_MIN_EVIDENCE_HITS' };

  return profile;
}

function buildAssessmentVerdict(bfDir, mode) {
  const required = artifactRefs(bfDir, P3_REQUIRED);
  const missing = required.filter((artifact) => !artifact.exists);
  return {
    ...contractBase(
      'brownfield-assessment-verdict',
      mode,
      artifactRefs(bfDir, [...P3_REQUIRED, 'health-score.json', 'runtime-truth.json']),
      missing.length === 0 ? 'complete' : 'blocked',
    ),
    summary:
      'Assessment verdict intentionally does not authorize build. Build requires P4-P6 planning, standards, and handoff validation.',
    assessmentComplete: missing.length === 0,
    completedPhase: missing.length === 0 ? 'P3' : 'partial',
    buildAuthorized: false,
    nextRequiredPhase: mode.planningMode ? 'P4' : 'explicit-user-decision-or-P4',
    missingAssessmentArtifacts: missing.map((artifact) => artifact.artifact),
  };
}

function buildDataClassification(bfDir, mode, text) {
  const { values: categories } = detectCategories(bfDir, TEXT_HINT_FILES);
  const { values: regulations } = detectRegulations(bfDir, TEXT_HINT_FILES);
  return {
    ...contractBase(
      'legacy-data-classification',
      mode,
      artifactRefs(bfDir, [
        '05-database-and-data-store-report.md',
        '07-configuration-and-access-audit.md',
        '26c-modernization-compliance-architecture.md',
        '29-modernization-data-model-spec.md',
      ]),
      categories.length > 0 ? 'complete' : 'unknown',
    ),
    summary: 'Legacy data classification derived from database, security, compliance, and planning artifacts.',
    classifications:
      categories.length > 0
        ? categories.map((category) => ({ category, evidenceLevel: 'keyword-detected' }))
        : [{ category: 'unknown', evidenceLevel: 'not-found-in-current-artifacts' }],
    regulations,
    retentionKnown: /\b(retention|ttl|archive|purge|delete|erasure)\b/i.test(text),
  };
}

function buildDataLifecycle(bfDir, mode, text) {
  const lifecycleTerms = [
    ['create', /\b(create|insert|register|signup|import)\b/i],
    ['read', /\b(read|query|search|view|dashboard|report)\b/i],
    ['update', /\b(update|edit|modify|patch|sync)\b/i],
    ['delete', /\b(delete|remove|purge|erasure|archive)\b/i],
    ['migrate', /\b(migrate|migration|backfill|etl|transform)\b/i],
  ];
  const stages = lifecycleTerms
    .filter(([, pattern]) => pattern.test(text))
    .map(([stage]) => ({ stage, evidenceLevel: 'keyword-detected' }));
  return {
    ...contractBase(
      'legacy-data-lifecycle',
      mode,
      artifactRefs(bfDir, [
        '05-database-and-data-store-report.md',
        '29-modernization-data-model-spec.md',
        '39-modernization-delivery-plan.md',
      ]),
      stages.length > 0 ? 'draft' : 'unknown',
    ),
    summary: 'Data lifecycle expectations for migration, coexistence, rollback, and retention planning.',
    stages,
    rollbackImplications: /\b(rollback|backout|restore|revert)\b/i.test(text)
      ? 'rollback references detected'
      : 'rollback behavior must be validated before production migration',
  };
}

function buildParityContract(bfDir, mode, text) {
  const businessRuleEvidence = hasAnyFile(bfDir, [
    '14-business-rules-and-validation.md',
    '36-modernization-epics-and-stories.md',
    '38-modernization-test-strategy.md',
  ]);
  return {
    ...contractBase(
      'brownfield-parity-contract',
      mode,
      artifactRefs(bfDir, [
        '14-business-rules-and-validation.md',
        '15-feature-triage-matrix.md',
        '36-modernization-epics-and-stories.md',
        '38-modernization-test-strategy.md',
      ]),
      businessRuleEvidence ? 'draft' : 'requires-validation',
    ),
    summary: 'Behavioral parity contract for legacy business rules, workflows, and modernization acceptance tests.',
    parityRequired: true,
    sourcesDetected: businessRuleEvidence,
    expectedEvidence: [
      'legacy behavior inventory',
      'BDD acceptance criteria',
      'migration comparison tests',
      'rollback verification',
    ],
    coverageHints: {
      businessRules: /\b(rule|validation|decision table|calculation)\b/i.test(text),
      workflows: /\b(workflow|journey|flow|screen|route)\b/i.test(text),
      apiBehavior: /\b(api|endpoint|request|response)\b/i.test(text),
    },
  };
}

function buildMigrationSafetyPlan(bfDir, mode, text) {
  const migrationKnown = /\b(migration|migrate|backfill|etl|cutover|coexist|rollback|restore)\b/i.test(text);
  return {
    ...contractBase(
      'migration-safety-plan',
      mode,
      artifactRefs(bfDir, [
        '29-modernization-data-model-spec.md',
        '33-modernization-dependency-and-integration-register.md',
        '38-modernization-test-strategy.md',
        '39-modernization-delivery-plan.md',
      ]),
      migrationKnown ? 'draft' : 'requires-validation',
    ),
    summary: 'Migration safety guardrails for data movement, coexistence, rollback, validation, and operator evidence.',
    rollbackRequired: true,
    validationRequired: true,
    migrationSignalsDetected: migrationKnown,
    requiredControls: [
      'source snapshot or restore point',
      'idempotent migration execution',
      'sampled record reconciliation',
      'rollback or forward-fix procedure',
      'post-migration smoke tests',
    ],
  };
}

function buildEvidenceConfidence(bfDir, mode) {
  const evidence = readJson(path.join(bfDir, '19-evidence-index.json'));
  const issuesVerification = readJson(path.join(bfDir, '16-issues-registry-verification.json'));
  const accuracy = readJson(path.join(bfDir, 'phase-P3-accuracy-report.json'));
  const integrityValid = evidence?.integrity?.valid === true || evidence?.valid === true;
  const verified = Number(issuesVerification?.stats?.verified || 0);
  const unverified = Number(issuesVerification?.stats?.unverified || 0);
  const rejected = Number(issuesVerification?.stats?.rejected || 0);
  let overall = 'unknown';
  if (integrityValid && accuracy?.passed !== false && verified > 0 && unverified === 0 && rejected === 0)
    overall = 'high';
  else if (integrityValid || accuracy?.passed !== false || verified > 0) overall = 'medium';
  else if (evidence || issuesVerification || accuracy) overall = 'low';

  return {
    ...contractBase(
      'brownfield-evidence-confidence',
      mode,
      artifactRefs(bfDir, [
        '19-evidence-index.json',
        '16-issues-registry-verification.json',
        'phase-P3-accuracy-report.json',
      ]),
      overall === 'low' || overall === 'unknown' ? 'requires-review' : 'complete',
    ),
    summary: 'Evidence confidence contract separating source-proven findings from tool warnings and unknowns.',
    confidence: {
      overall,
      evidenceIndexIntegrity: integrityValid,
      issueVerification: { verified, unverified, rejected },
      accuracyPassed: accuracy?.passed !== false,
    },
  };
}

function buildRiskRegister(bfDir, mode) {
  const registry = readJson(path.join(bfDir, '16-issues-registry.json'));
  const issues = listIssues(registry);
  const counts = severityCounts(issues);
  const blocking = issues.filter((issue) =>
    ['P0', 'P1'].includes(String(issue.priority || issue.severity || '').toUpperCase()),
  );
  return {
    ...contractBase(
      'legacy-risk-register',
      mode,
      artifactRefs(bfDir, [
        '16-issues-registry.json',
        '20-modernization-decision-log.md',
        '42-modernization-issue-and-blocker-tracker.json',
      ]),
      blocking.length > 0 ? 'requires-review' : 'complete',
    ),
    summary:
      'Consolidated brownfield risk register for critical legacy issues, accepted risks, and modernization blockers.',
    issueCounts: counts,
    blockingRisks: blocking.slice(0, 25).map((issue) => ({
      id: String(issue.id || issue.key || 'unknown'),
      priority: String(issue.priority || issue.severity || 'unknown'),
      description: String(issue.description || issue.title || '').slice(0, 500),
    })),
  };
}

function buildSupplyChainPolicy(bfDir, mode) {
  const sbom = readJson(path.join(bfDir, 'sbom.json'));
  const specVersion = sbom?.specVersion || sbom?.spdxVersion || null;
  return {
    ...contractBase(
      'brownfield-supply-chain-policy',
      mode,
      artifactRefs(bfDir, [
        'sbom.json',
        '09-supply-chain-and-vulnerability-review.md',
        '26b-modernization-engineering-quality-standards.md',
      ]),
      sbom ? 'draft' : 'requires-review',
    ),
    summary: 'Supply-chain policy contract for SBOM format, vulnerability triage, licensing, and build provenance.',
    sbom: {
      present: Boolean(sbom),
      format: sbom?.bomFormat || (sbom?.spdxVersion ? 'SPDX' : null),
      specVersion,
      recommendedFormats: ['CycloneDX 1.7', 'SPDX 3.0'],
    },
    requiredControls: [
      'SBOM generated before build handoff',
      'critical dependency vulnerabilities block release',
      'license exceptions are explicitly approved',
      'build provenance retained for release evidence',
    ],
  };
}

function buildOpsInventory(bfDir, mode, text) {
  const signals = [
    ['logging', /\b(log|logging|audit log)\b/i],
    ['metrics', /\b(metric|prometheus|dashboard|slo|sla)\b/i],
    ['tracing', /\b(trace|tracing|span|opentelemetry|otel)\b/i],
    ['alerts', /\b(alert|pager|incident|on-call)\b/i],
    ['rollback', /\b(rollback|restore|backout|revert)\b/i],
  ]
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name);
  return {
    ...contractBase(
      'legacy-ops-inventory',
      mode,
      artifactRefs(bfDir, [
        '02-baseline-health-and-scan-summary.md',
        '06-integration-map.md',
        '39-modernization-delivery-plan.md',
      ]),
      signals.length > 0 ? 'draft' : 'unknown',
    ),
    summary: 'Legacy operations inventory for observability, deployment, rollback, incident response, and runbooks.',
    detectedCapabilities: signals,
    missingCapabilities: ['logging', 'metrics', 'tracing', 'alerts', 'rollback'].filter(
      (capability) => !signals.includes(capability),
    ),
  };
}

function buildOpsGapReport(bfDir, mode, opsInventory) {
  return {
    ...contractBase(
      'modernization-ops-gap-report',
      mode,
      artifactRefs(bfDir, [
        '25-modernization-trd.md',
        '38-modernization-test-strategy.md',
        '39-modernization-delivery-plan.md',
        '44-modernization-release-readiness-checklist.md',
      ]),
      opsInventory.missingCapabilities.length > 0 ? 'requires-review' : 'complete',
    ),
    summary: 'Modernization operations gap report linking legacy gaps to required Day 2 engineering controls.',
    gaps: opsInventory.missingCapabilities.map((capability) => ({
      capability,
      severity: capability === 'rollback' || capability === 'alerts' ? 'high' : 'medium',
      requiredBeforeRelease: true,
    })),
  };
}

function buildStandardsBaseline(bfDir, mode) {
  return {
    ...contractBase(
      'standards-version-baseline',
      mode,
      artifactRefs(bfDir, ['26b-standards-validation.json', '46-standards-full-audit.json', '46-standards-gate.json']),
      'complete',
    ),
    summary:
      'Standards baseline used by brownfield gates. Versions are captured to avoid stale or ambiguous control mapping.',
    standards: [
      { name: 'ISO/IEC/IEEE 29148', scope: 'requirements quality' },
      { name: 'ISO/IEC 12207 family', scope: 'software lifecycle process alignment' },
      { name: 'ISO/IEC 25010', scope: 'software product quality attributes' },
      { name: 'ISO/IEC 5055', scope: 'structural quality measures' },
      { name: 'ISO/IEC 42001', scope: 'AI management system readiness when AI is present' },
      { name: 'NIST AI RMF', scope: 'AI risk governance when AI is present' },
      { name: 'NIST SSDF', scope: 'secure software development' },
      { name: 'NIST CSF 2.0', scope: 'security governance and operations' },
      { name: 'NIST SP 800-61r3', scope: 'incident response lifecycle' },
      { name: 'OWASP SAMM', scope: 'software assurance maturity' },
      { name: 'OWASP ASVS 5.0.0', scope: 'application security verification' },
      { name: 'OWASP Top 10 2025', scope: 'application security risk categories' },
      { name: 'OWASP API Security Top 10 2023', scope: 'API security verification' },
      { name: 'OWASP SCVS', scope: 'software component verification' },
      { name: 'OWASP SPVS', scope: 'software supply-chain verification' },
      { name: 'SLSA v1.2', scope: 'build and provenance levels' },
      { name: 'CycloneDX 1.7', scope: 'SBOM format baseline' },
      { name: 'SPDX 3.0', scope: 'SBOM and licensing baseline' },
      { name: 'OpenTelemetry Semantic Conventions 1.40.0', scope: 'observability naming' },
      { name: 'DORA metrics', scope: 'delivery performance measurement' },
    ],
  };
}

function buildLifecycleMap(bfDir, mode) {
  return {
    ...contractBase(
      'brownfield-lifecycle-map',
      mode,
      artifactRefs(bfDir, [
        '00-run-context.json',
        'phase-P3-readiness-gate.json',
        'brownfield-to-build-handoff-contract.json',
      ]),
      'complete',
    ),
    summary:
      'Brownfield lifecycle map aligning P0-P6 artifacts to intake, assessment, design, transition, validation, and release gates.',
    phases: [
      { phase: 'P0', purpose: 'intake, classification, health, runtime truth' },
      { phase: 'P1', purpose: 'feature, data, integration, config, UI, supply-chain discovery' },
      { phase: 'P2', purpose: 'deep reverse engineering and business rule recovery' },
      { phase: 'P2.5', purpose: 'forensic audit when deep or agent-based assessment requires it' },
      { phase: 'P3', purpose: 'synthesis, issue registry, evidence index, assessment verdict' },
      { phase: 'P4', purpose: 'target-state scope, TRD, security, compliance, engineering standards' },
      { phase: 'P5', purpose: 'architecture, data model, API, UX, implicit requirements, dependencies' },
      { phase: 'P6', purpose: 'milestones, epics, traceability, test strategy, delivery, handoff readiness' },
    ],
  };
}

function buildObservabilityContract(bfDir, mode, text) {
  const signals = [
    ['logs', /\b(log|logging|audit log)\b/i],
    ['metrics', /\b(metric|counter|gauge|histogram|slo|sla)\b/i],
    ['traces', /\b(trace|tracing|span|opentelemetry|otel)\b/i],
    ['events', /\b(event|domain event|webhook|pubsub|queue)\b/i],
  ]
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name);
  return {
    ...contractBase(
      'observability-semantics-contract',
      mode,
      artifactRefs(bfDir, [
        '25-modernization-trd.md',
        '38-modernization-test-strategy.md',
        '39-modernization-delivery-plan.md',
      ]),
      signals.length > 0 ? 'draft' : 'requires-review',
    ),
    summary: 'Observability semantics contract for logs, metrics, traces, events, cardinality, and evidence retention.',
    semanticBaseline: 'OpenTelemetry Semantic Conventions 1.40.0',
    detectedSignals: signals,
    requiredSignals: ['logs', 'metrics', 'traces'],
  };
}

function buildAiInventory(bfDir, mode, text) {
  const detected = /\b(ai|machine learning|ml|llm|prompt|embedding|rag|classifier|inference|neural)\b/i.test(text);
  return {
    ...contractBase(
      'ai-system-inventory',
      mode,
      artifactRefs(bfDir, [
        '01-intake-and-classification.md',
        '23-master-assessment.md',
        '24-modernization-prd.md',
        '25-modernization-trd.md',
      ]),
      detected ? 'requires-review' : 'not-applicable',
    ),
    summary: detected
      ? 'AI-related terms were detected. ISO/IEC 42001 and NIST AI RMF controls must be evaluated.'
      : 'No AI system signals were detected in current brownfield artifacts. This is an explicit N/A stub.',
    aiDetected: detected,
    governanceRequired: detected,
    governanceBaselines: detected ? ['ISO/IEC 42001', 'NIST AI RMF'] : [],
  };
}

function buildSecurityWaiver(bfDir, mode, intakeProfile) {
  return {
    ...contractBase(
      'brownfield-security-waiver',
      mode,
      artifactRefs(bfDir, [
        '00-run-context.json',
        '12-security-and-quality-assessment.md',
        '16d-forensic-audit-report.md',
      ]),
      intakeProfile.securityWaiverRequired ? 'missing-approval' : 'not-applicable',
    ),
    summary:
      'Security waiver contract. Required only when production or regulated scope lacks the deep-security evidence expected for the selected brownfield mode.',
    required: intakeProfile.securityWaiverRequired,
    approved: false,
    approver: null,
    reason: intakeProfile.securityWaiverRequired
      ? 'Deep-security evidence is required before modernization can proceed.'
      : 'No waiver is required for the current intake profile.',
  };
}

function buildReadiness(bfDir, mode, intakeProfile, assessmentVerdict) {
  const missingPlanning = artifactRefs(bfDir, PLANNING_REQUIRED).filter((artifact) => !artifact.exists);
  const blockers = [];
  if (!mode.planningMode) {
    blockers.push({
      id: 'BF-READINESS-001',
      severity: 'critical',
      description: 'Run is assessment-only. Build handoff requires a full planning mode.',
    });
  }
  if (!assessmentVerdict.assessmentComplete) {
    blockers.push({
      id: 'BF-READINESS-002',
      severity: 'critical',
      description: 'Assessment P3 artifacts are incomplete.',
    });
  }
  if (intakeProfile.securityWaiverRequired) {
    blockers.push({
      id: 'BF-READINESS-003',
      severity: 'critical',
      description: 'Deep-security evidence is missing and no approved brownfield-security-waiver.json exists.',
    });
  }
  for (const missing of missingPlanning) {
    blockers.push({
      id: `BF-PLAN-${String(missing.artifact)
        .replace(/[^A-Za-z0-9]+/g, '-')
        .toUpperCase()}`,
      severity: 'critical',
      description: `${missing.artifact} is required before modernization handoff.`,
    });
  }

  const readyForBuild = blockers.length === 0;
  return {
    ...contractBase(
      'brownfield-modernization-readiness',
      mode,
      artifactRefs(bfDir, [...P3_REQUIRED, ...PLANNING_REQUIRED, 'brownfield-to-build-handoff-contract.json']),
      readyForBuild ? 'ready' : 'blocked',
    ),
    summary:
      'Modernization readiness contract. This is the build authorization surface for brownfield-to-build handoff.',
    readyForBuild,
    buildAuthorized: readyForBuild,
    blockers,
    missingPlanningArtifacts: missingPlanning.map((artifact) => artifact.artifact),
    requiredBeforeBuild: [
      'complete P3 assessment verdict',
      'complete P4-P6 modernization packet',
      'planning sync contract pass',
      'standards gate pass',
      'brownfield-to-build handoff pass',
    ],
  };
}

function buildAllContracts(bfDir) {
  const mode = detectMode(bfDir);
  const text = collectText(bfDir);
  const intakeProfile = buildIntakeProfile(bfDir, mode, text);
  const assessmentVerdict = buildAssessmentVerdict(bfDir, mode);
  const opsInventory = buildOpsInventory(bfDir, mode, text);
  const contracts = {
    'brownfield-intake-profile': intakeProfile,
    'brownfield-assessment-verdict': assessmentVerdict,
    'legacy-data-classification': buildDataClassification(bfDir, mode, text),
    'legacy-data-lifecycle': buildDataLifecycle(bfDir, mode, text),
    'brownfield-parity-contract': buildParityContract(bfDir, mode, text),
    'migration-safety-plan': buildMigrationSafetyPlan(bfDir, mode, text),
    'brownfield-evidence-confidence': buildEvidenceConfidence(bfDir, mode),
    'legacy-risk-register': buildRiskRegister(bfDir, mode),
    'brownfield-supply-chain-policy': buildSupplyChainPolicy(bfDir, mode),
    'legacy-ops-inventory': opsInventory,
    'modernization-ops-gap-report': buildOpsGapReport(bfDir, mode, opsInventory),
    'standards-version-baseline': buildStandardsBaseline(bfDir, mode),
    'brownfield-lifecycle-map': buildLifecycleMap(bfDir, mode),
    'observability-semantics-contract': buildObservabilityContract(bfDir, mode, text),
    'ai-system-inventory': buildAiInventory(bfDir, mode, text),
  };

  if (intakeProfile.securityWaiverRequired) {
    contracts['brownfield-security-waiver'] = buildSecurityWaiver(bfDir, mode, intakeProfile);
  }

  contracts['brownfield-modernization-readiness'] = buildReadiness(bfDir, mode, intakeProfile, assessmentVerdict);
  return { mode, contracts };
}

const INTAKE_FACTUAL_BOOLS = Object.freeze([
  'productionTrack',
  'internetExposure',
  'regulatedDataDetected',
  'requiresDeepSecurity',
  'securityWaiverRequired',
]);

const INTAKE_FACTUAL_ARRAYS = Object.freeze([
  'detectedDataCategories',
  'detectedRegulations',
  'regulatedEvidence',
  'internetExposureEvidence',
]);

const INTAKE_TOOL_OWNED = Object.freeze([
  'contractType',
  'contractVersion',
  'generatedAt',
  'generatedBy',
  'sourceArtifacts',
  'status',
  'summary',
  'classification',
  'deepSecurityEvidence',
]);

function mergeIntakeProfile(existing, generated) {
  if (!existing || typeof existing !== 'object') return generated;
  if (existing.contractType !== 'brownfield-intake-profile') return generated;

  const merged = { ...existing };

  for (const key of INTAKE_TOOL_OWNED) {
    if (key in generated) merged[key] = generated[key];
  }

  for (const key of INTAKE_FACTUAL_BOOLS) {
    if (typeof existing[key] !== 'boolean' && key in generated) {
      merged[key] = generated[key];
    }
  }

  for (const key of INTAKE_FACTUAL_ARRAYS) {
    const existingValue = existing[key];
    if (!Array.isArray(existingValue) || existingValue.length === 0) {
      if (key in generated) merged[key] = generated[key];
      else delete merged[key];
    }
  }

  if (merged.regulatedDataDetected === false) delete merged.regulatedEvidence;
  if (merged.internetExposure === false) delete merged.internetExposureEvidence;

  if (
    merged.regulatedDataDetected === true &&
    (!Array.isArray(merged.regulatedEvidence) || merged.regulatedEvidence.length === 0) &&
    Array.isArray(generated.regulatedEvidence) &&
    generated.regulatedEvidence.length > 0
  ) {
    merged.regulatedEvidence = generated.regulatedEvidence;
  }
  if (
    merged.internetExposure === true &&
    (!Array.isArray(merged.internetExposureEvidence) || merged.internetExposureEvidence.length === 0) &&
    Array.isArray(generated.internetExposureEvidence) &&
    generated.internetExposureEvidence.length > 0
  ) {
    merged.internetExposureEvidence = generated.internetExposureEvidence;
  }

  merged.merged = true;
  return merged;
}

function emitBrownfieldContracts(bfDir, options = {}) {
  const force = options.force === true;
  const built = buildAllContracts(bfDir);
  const written = [];
  const auxiliary = [];
  for (const [contractType, contract] of Object.entries(built.contracts)) {
    const fileName = CONTRACT_FILE_BY_TYPE[contractType];
    if (!fileName) continue;
    const target = path.join(bfDir, fileName);
    let final = contract;
    let action = 'written';

    if (!force && contractType === 'brownfield-intake-profile' && fs.existsSync(target)) {
      const existing = readJson(target);
      if (existing && existing.contractType === 'brownfield-intake-profile') {
        final = mergeIntakeProfile(existing, contract);
        action = 'merged';
      }
    }

    writeJson(target, final);
    written.push({ contractType, file: fileName, path: target, status: final.status, action });
  }
  const semanticDrift = buildBrownfieldSemanticDrift(bfDir, {
    projectRoot: detectProjectRoot(bfDir),
  });
  auxiliary.push({
    contractType: 'brownfield-semantic-drift',
    file: path.basename(semanticDrift.outputPath),
    path: semanticDrift.outputPath,
    status: semanticDrift.fidelity.status,
    category: 'diagnostic',
  });
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    generatedBy: TOOL_NAME,
    modeKey: built.mode.modeKey,
    planningMode: built.mode.planningMode,
    force,
    written,
    auxiliary,
  };
}

let cachedSchemaValidator = null;

function loadSchemaValidator() {
  if (cachedSchemaValidator !== null) return cachedSchemaValidator;
  try {
    const Ajv2020 = require('ajv/dist/2020');
    const addFormats = require('ajv-formats');
    const Ajv = Ajv2020.default || Ajv2020;
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const schemaPath = path.join(__dirname, '..', 'source', 'schemas', 'brownfield-contracts.schema.json');
    cachedSchemaValidator = ajv.compile(readJson(schemaPath));
  } catch {
    cachedSchemaValidator = false;
  }
  return cachedSchemaValidator;
}

function requiredTypesForScope(bfDir, scope) {
  const mode = detectMode(bfDir);
  let effectiveScope = scope || 'auto';
  if (effectiveScope === 'auto') effectiveScope = mode.planningMode ? 'planning' : 'assessment';
  const required = new Set(ASSESSMENT_CONTRACT_TYPES);
  if (effectiveScope === 'planning') {
    for (const type of PLANNING_CONTRACT_TYPES) required.add(type);
  }

  const intake = readJson(path.join(bfDir, CONTRACT_FILE_BY_TYPE['brownfield-intake-profile']));
  if (intake?.securityWaiverRequired) required.add('brownfield-security-waiver');
  return { mode, effectiveScope, required: Array.from(required) };
}

function validateOneContract(bfDir, contractType) {
  const fileName = CONTRACT_FILE_BY_TYPE[contractType];
  const filePath = path.join(bfDir, fileName);
  if (!fs.existsSync(filePath)) {
    return {
      contractType,
      file: fileName,
      pass: false,
      severity: 'critical',
      detail: 'Contract file is missing',
    };
  }
  const parsed = readJson(filePath);
  if (!parsed) {
    return {
      contractType,
      file: fileName,
      pass: false,
      severity: 'critical',
      detail: 'Contract file is invalid JSON',
    };
  }
  if (parsed.contractType !== contractType) {
    return {
      contractType,
      file: fileName,
      pass: false,
      severity: 'critical',
      detail: `contractType mismatch: expected ${contractType}, got ${parsed.contractType || '<missing>'}`,
    };
  }
  const validateSchema = loadSchemaValidator();
  if (validateSchema && !validateSchema(parsed)) {
    return {
      contractType,
      file: fileName,
      pass: false,
      severity: 'high',
      detail: `Schema validation failed: ${(validateSchema.errors || [])
        .slice(0, 3)
        .map((err) => `${err.instancePath || '/'} ${err.message}`)
        .join('; ')}`,
    };
  }
  return {
    contractType,
    file: fileName,
    pass: true,
    severity: 'info',
    detail: `status=${parsed.status}`,
    status: parsed.status,
  };
}

function semanticChecks(bfDir, effectiveScope) {
  const checks = [];
  const assessment = readJson(path.join(bfDir, CONTRACT_FILE_BY_TYPE['brownfield-assessment-verdict']));
  if (!assessment) {
    checks.push({
      id: 'SC-001',
      pass: false,
      severity: 'critical',
      detail: 'brownfield-assessment-verdict.json is missing or invalid',
    });
  } else if (assessment.buildAuthorized !== false) {
    checks.push({
      id: 'SC-002',
      pass: false,
      severity: 'critical',
      detail: 'Assessment verdict must never authorize build directly',
    });
  } else {
    checks.push({
      id: 'SC-002',
      pass: true,
      severity: 'info',
      detail: 'assessment verdict blocks direct build handoff',
    });
  }

  const intake = readJson(path.join(bfDir, CONTRACT_FILE_BY_TYPE['brownfield-intake-profile']));
  if (intake?.securityWaiverRequired) {
    const waiver = readJson(path.join(bfDir, CONTRACT_FILE_BY_TYPE['brownfield-security-waiver']));
    const pass = waiver?.approved === true && waiver?.status === 'approved';
    checks.push({
      id: 'SC-003',
      pass,
      severity: pass ? 'info' : 'critical',
      detail: pass ? 'required security waiver is approved' : 'security waiver is required but not approved',
    });
  }

  if (effectiveScope === 'planning') {
    const readiness = readJson(path.join(bfDir, CONTRACT_FILE_BY_TYPE['brownfield-modernization-readiness']));
    const pass = readiness?.readyForBuild === true && readiness?.buildAuthorized === true;
    checks.push({
      id: 'SC-004',
      pass,
      severity: pass ? 'info' : 'critical',
      detail: pass
        ? 'modernization readiness authorizes build handoff'
        : 'modernization readiness does not authorize build handoff',
    });
  }

  return checks;
}

function validateBrownfieldContracts(bfDir, options = {}) {
  const { mode, effectiveScope, required } = requiredTypesForScope(bfDir, options.scope || 'auto');
  const contractChecks = required.map((contractType) => validateOneContract(bfDir, contractType));
  const semantic = semanticChecks(bfDir, effectiveScope);
  const failed = [...contractChecks, ...semantic].filter((check) => check.pass === false);
  const result = {
    ok: failed.length === 0,
    generatedAt: new Date().toISOString(),
    generatedBy: TOOL_NAME,
    modeKey: mode.modeKey,
    scope: effectiveScope,
    requiredContracts: required,
    checks: contractChecks,
    semanticChecks: semantic,
    blockers: failed.map((check) => ({
      id: check.id || check.contractType,
      severity: check.severity || 'critical',
      detail: check.detail,
      file: check.file || null,
    })),
  };
  if (options.write) writeJson(path.join(bfDir, 'brownfield-contract-validation.json'), result);
  return result;
}

function resolveBrownfieldDir(args) {
  const dirIdx = args.indexOf('--dir');
  if (dirIdx !== -1 && args[dirIdx + 1]) return path.resolve(args[dirIdx + 1]);
  return path.join(process.cwd(), '_cobolt-output', 'latest', 'brownfield');
}

function parseScope(args) {
  const idx = args.indexOf('--scope');
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  if (args.includes('--assessment')) return 'assessment';
  if (args.includes('--planning')) return 'planning';
  return 'auto';
}

function printHelp() {
  process.stdout.write(
    `cobolt-brownfield-contracts\n\n` +
      `USAGE\n` +
      `  node tools/cobolt-brownfield-contracts.js emit [--dir <brownfield-dir>] [--force|--force-overwrite] [--json]\n` +
      `  node tools/cobolt-brownfield-contracts.js validate [--dir <brownfield-dir>] [--scope assessment|planning|auto] [--json]\n` +
      `  node tools/cobolt-brownfield-contracts.js check [--dir <brownfield-dir>] [--scope assessment|planning|auto] [--json]\n\n` +
      `EMIT MERGE BEHAVIOUR\n` +
      `  brownfield-intake-profile.json is preserved when present: tool-derived metadata is\n` +
      `  refreshed, but user-curated factual booleans (regulatedDataDetected, internetExposure,\n` +
      `  productionTrack, requiresDeepSecurity) and non-empty evidence arrays are kept verbatim.\n` +
      `  Pass --force to discard existing values and regenerate the contract from scratch.\n\n` +
      `CONTRACTS\n` +
      `  P3 assessment contracts block direct build handoff.\n` +
      `  P4-P6 planning contracts authorize build only through brownfield-modernization-readiness.json.\n`,
  );
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'help';
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return 0;
  }

  const bfDir = resolveBrownfieldDir(argv);
  const jsonMode = argv.includes('--json');
  if (!fs.existsSync(bfDir)) {
    const result = { ok: false, reason: 'brownfield-dir-missing', bfDir };
    if (jsonMode) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stderr.write(`FAIL: brownfield dir not found: ${bfDir}\n`);
    return 3;
  }

  if (command === 'emit') {
    const force = argv.includes('--force') || argv.includes('--force-overwrite');
    const result = emitBrownfieldContracts(bfDir, { force });
    if (jsonMode) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      const verb = force ? 'wrote (forced)' : 'wrote';
      process.stdout.write(`[${TOOL_NAME}] ${verb} ${result.written.length} contract artifact(s)\n`);
      for (const item of result.written) {
        const tag = item.action === 'merged' ? ' [merged]' : '';
        process.stdout.write(`  - ${item.file}: ${item.status}${tag}\n`);
      }
      for (const item of result.auxiliary || [])
        process.stdout.write(`  - ${item.file}: ${item.status} (auxiliary ${item.category || 'artifact'})\n`);
    }
    return 0;
  }

  if (command === 'validate' || command === 'check') {
    const result = validateBrownfieldContracts(bfDir, { scope: parseScope(argv), write: true });
    if (jsonMode) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      process.stdout.write(`[${TOOL_NAME}] ${result.ok ? 'PASS' : 'FAIL'} (${result.scope})\n`);
      for (const blocker of result.blockers) process.stdout.write(`  - ${blocker.id}: ${blocker.detail}\n`);
    }
    return result.ok ? 0 : 1;
  }

  process.stderr.write(`Unknown command: ${command}\n`);
  printHelp();
  return 2;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  ASSESSMENT_CONTRACT_TYPES,
  CONTRACT_FILE_BY_TYPE,
  PLANNING_CONTRACT_TYPES,
  buildAllContracts,
  detectCategories,
  detectInternetExposure,
  detectMode,
  detectRegulations,
  emitBrownfieldContracts,
  mergeIntakeProfile,
  validateBrownfieldContracts,
};
