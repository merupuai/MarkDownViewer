#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const {
  BASELINE_REVIEWERS,
  OPTIONAL_REVIEWERS,
  baselinePrefixesForMode,
  toReviewerPrefix,
} = require('../lib/cobolt-reviewer-registry');
const { checkGate } = require('./cobolt-review-readiness-gate');
const {
  REVIEW_FILES,
  defaultReviewDir,
  detectMilestone,
  detectProjectRoot,
  detectSurfaceSignals,
  listFindings,
  loadJson,
  maybePrintHelpAndExit,
  readCoboltState,
  readReviewData,
  severityWeight,
  validateSourceManifest,
} = require('./_review-readiness-utils');

const USAGE = `Usage: node tools/cobolt-review-governance.js build|check [--dir <path>] [--json] [--build-pipeline]

Commands:
  build    Emit review-governance artifacts (coverage matrix, release gate, risk register, ...)
  check    Verify governance state without modifying artifacts

Flags:
  --dir <path>      Review dir (default: _cobolt-output/latest/review)
  --json            Emit machine-readable JSON
  --build-pipeline  Build-pipeline mode
  --help, -h        Show this help and exit
`;

const GOVERNANCE_FILES = {
  riskRegister: 'review-risk-register.json',
  riskAcceptance: 'risk-acceptance.json',
  reviewerProfilePolicy: 'reviewer-profile-policy.json',
  coverageMatrix: 'review-coverage-matrix.json',
  releaseGate: 'review-release-gate.json',
  challengeBacklog: 'review-challenge-backlog.json',
  authzReplayGate: 'review-authz-replay-gate.json',
};

const REQUIRED_REVIEW_GOVERNANCE_CONTRACTS = Object.values(GOVERNANCE_FILES);

const HIGH_RISK_SEVERITIES = new Set(['critical', 'high']);

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function compactPath(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function fileListFromManifest(manifest) {
  return (Array.isArray(manifest?.files) ? manifest.files : [])
    .map((filePath) => compactPath(filePath))
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

function normalizeReviewedFiles(manifest, findings) {
  const files = new Set();
  for (const filePath of manifest?.reviewedFiles || []) files.add(compactPath(filePath));
  for (const filePath of manifest?.filesReviewed || []) files.add(compactPath(filePath));
  for (const finding of findings || []) {
    const filePath = finding.location?.file || finding.file;
    if (filePath) files.add(compactPath(filePath));
  }
  return [...files].sort((left, right) => left.localeCompare(right));
}

function findingPrefix(finding) {
  return toReviewerPrefix(finding?.prefix || finding?.reviewerAgent || finding?.id) || String(finding?.prefix || '');
}

function findingStatus(finding) {
  return String(finding?.verification?.status || 'unverified').toLowerCase();
}

function isBlockingFinding(finding) {
  const priority = String(finding?.priority || '').toUpperCase();
  const severity = String(finding?.severity || '').toLowerCase();
  const status = findingStatus(finding);
  return priority === 'P0' || (status === 'verified' && HIGH_RISK_SEVERITIES.has(severity));
}

function isSecurityRelevant(finding) {
  const prefix = findingPrefix(finding);
  return ['SEC', 'AUTHZ', 'AUTHZ-RUNTIME', 'API', 'DEP', 'DB', 'CONF', 'OPS'].includes(prefix);
}

function riskDisposition(finding) {
  const status = findingStatus(finding);
  const severity = String(finding?.severity || '').toLowerCase();
  const priority = String(finding?.priority || '').toUpperCase();
  if (status === 'rejected') return 'reject-phantom';
  if (priority === 'P0') return 'fix-now';
  if (status !== 'verified' && HIGH_RISK_SEVERITIES.has(severity)) return 'investigate-before-release';
  if (isBlockingFinding(finding)) return 'fix-now';
  return 'backlog-allowed';
}

function riskImpact(finding) {
  const disposition = riskDisposition(finding);
  if (disposition === 'fix-now') return 'blocks-release';
  if (disposition === 'investigate-before-release') return 'blocks-release-until-investigated';
  if (disposition === 'reject-phantom') return 'no-release-impact';
  return isSecurityRelevant(finding) ? 'requires-owner-triage' : 'non-blocking';
}

function buildRiskRegister(findings, context) {
  const risks = (findings || [])
    .map((finding) => {
      const location = finding.location || {};
      const filePath = location.file || finding.file || null;
      const severity = String(finding.severity || 'unknown').toLowerCase();
      const disposition = riskDisposition(finding);
      return {
        findingId: finding.id,
        prefix: findingPrefix(finding),
        severity,
        priority: finding.priority || null,
        verificationStatus: findingStatus(finding),
        title: finding.title || finding.category || finding.description || 'review finding',
        location: {
          file: filePath,
          line: location.line || finding.line || null,
        },
        affectedRequirement: finding.requirementId || finding.requirement || finding.frId || null,
        exploitability: HIGH_RISK_SEVERITIES.has(severity) || isSecurityRelevant(finding) ? 'high' : 'medium',
        releaseImpact: riskImpact(finding),
        requiredDisposition: disposition,
        owner: disposition === 'fix-now' ? 'cobolt-fix-lead' : finding.reviewerAgent || 'review-lead',
        dueStage: disposition === 'fix-now' ? 'before-release' : 'next-planning-cycle',
        requiredEvidence:
          disposition === 'fix-now'
            ? ['fix evidence', 'regression test', 'scoped re-review']
            : ['owner triage', 'backlog link or acceptance rationale'],
      };
    })
    .sort((left, right) => {
      const severityCompare = severityWeight(left.severity) - severityWeight(right.severity);
      if (severityCompare !== 0) return severityCompare;
      return String(left.findingId || '').localeCompare(String(right.findingId || ''));
    });

  return {
    version: '1.0.0',
    generatedAt: context.generatedAt,
    generatedBy: 'cobolt-review-governance',
    reviewDir: context.reviewDir,
    sourceRoot: context.projectRoot,
    milestone: context.milestone,
    summary: {
      totalRisks: risks.length,
      blocking: risks.filter((risk) => String(risk.releaseImpact || '').startsWith('blocks-release')).length,
      fixNow: risks.filter((risk) => risk.requiredDisposition === 'fix-now').length,
      investigate: risks.filter((risk) => risk.requiredDisposition === 'investigate-before-release').length,
      backlog: risks.filter((risk) => risk.requiredDisposition === 'backlog-allowed').length,
      rejected: risks.filter((risk) => risk.requiredDisposition === 'reject-phantom').length,
    },
    risks,
  };
}

function normalizeAcceptanceEntries(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.accepted)) return payload.accepted;
  if (Array.isArray(payload.acceptances)) return payload.acceptances;
  if (Array.isArray(payload.entries)) return payload.entries;
  return [];
}

function acceptanceFindingId(entry) {
  return entry?.findingId || entry?.findingID || entry?.id || entry?.riskId || null;
}

function acceptanceIsActive(entry, now = new Date()) {
  const status = String(entry?.status || entry?.verdict || 'accepted').toLowerCase();
  if (!['accepted', 'approved', 'active'].includes(status)) return false;
  if (!entry?.owner && !entry?.approvedBy && !entry?.approval) return false;
  if (!entry?.expiresAt && !entry?.expiry && !entry?.validUntil) return false;
  const expiry = new Date(entry.expiresAt || entry.expiry || entry.validUntil);
  if (Number.isNaN(expiry.getTime())) return false;
  return expiry.getTime() > now.getTime();
}

function buildRiskAcceptance(riskRegister, context) {
  const existingPath = path.join(context.reviewDir, GOVERNANCE_FILES.riskAcceptance);
  const existing = loadJson(existingPath);
  const activeAcceptances = normalizeAcceptanceEntries(existing).filter((entry) => acceptanceIsActive(entry));
  const acceptedIds = new Set(activeAcceptances.map(acceptanceFindingId).filter(Boolean));
  const blockingRisks = (riskRegister.risks || []).filter((risk) =>
    String(risk.releaseImpact || '').startsWith('blocks'),
  );
  const pending = blockingRisks
    .filter((risk) => !acceptedIds.has(risk.findingId))
    .map((risk) => ({
      findingId: risk.findingId,
      severity: risk.severity,
      releaseImpact: risk.releaseImpact,
      requiredOwner: 'release-owner',
      requiredExpiry: true,
      requiredCompensatingControls: true,
      requiredApprovalSignatures: ['release-owner', 'security-owner'],
      status: 'pending-acceptance-or-fix',
    }));

  return {
    version: '1.0.0',
    generatedAt: context.generatedAt,
    generatedBy: 'cobolt-review-governance',
    reviewDir: context.reviewDir,
    milestone: context.milestone,
    policy:
      'Verified critical/high review risks block release unless fixed or explicitly accepted with owner, expiry, compensating controls, and approvals.',
    passed: pending.length === 0,
    accepted: activeAcceptances,
    pending,
    rejectedOrExpired: normalizeAcceptanceEntries(existing).filter((entry) => !acceptanceIsActive(entry)),
  };
}

function detectProjectSignals(projectRoot, reviewDir, sourceFiles, surfaceSignals) {
  const lowerFiles = sourceFiles.map((filePath) => filePath.toLowerCase());
  const hasData = lowerFiles.some((filePath) => /(^|\/)(db|database|migrations?|models?|schema)(\/|$)/u.test(filePath));
  const hasJobs = lowerFiles.some((filePath) => /(^|\/)(jobs?|queues?|workers?|cron|scheduler)(\/|$)/u.test(filePath));
  const hasInfra = lowerFiles.some((filePath) =>
    /(^|\/)(infra|k8s|helm|terraform|cloudformation)(\/|$)|dockerfile|\.ya?ml$|\.tf$/u.test(filePath),
  );
  const hasPackageManifest = lowerFiles.some((filePath) =>
    /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|poetry\.lock|cargo\.lock|go\.sum)$/u.test(
      filePath,
    ),
  );
  const hasAI = lowerFiles.some((filePath) => /(openai|anthropic|llm|embedding|prompt|model|ai)/u.test(filePath));
  const authzMatrix = findAuthzMatrix(projectRoot, reviewDir);
  const hasComplianceScope = [
    path.join(projectRoot, '_cobolt-output', 'latest', 'planning', 'compliance-register.md'),
    path.join(projectRoot, '_cobolt-output', 'latest', 'planning', 'compliance-register.json'),
    path.join(projectRoot, '_cobolt-output', 'latest', 'planning', 'security-requirements.md'),
  ].some((candidate) => fs.existsSync(candidate));

  return {
    hasUI: Boolean(surfaceSignals.hasUI),
    hasHttpSurface: Boolean(surfaceSignals.hasHttpSurface),
    hasExternalSurface: Boolean(surfaceSignals.hasExternalSurface),
    hasData,
    hasJobs,
    hasInfra,
    hasPackageManifest,
    hasAI,
    hasComplianceScope,
    hasAuthzMatrix: Boolean(authzMatrix.path),
    authzMatrixPath: authzMatrix.path,
  };
}

function buildReviewerProfilePolicy(findings, context, sourceManifest, surfaceSignals) {
  const manifest = loadJson(path.join(context.reviewDir, REVIEW_FILES.manifest)) || {};
  const sourceFiles = fileListFromManifest(sourceManifest.manifest);
  const signals = detectProjectSignals(context.projectRoot, context.reviewDir, sourceFiles, surfaceSignals);
  const required = new Map();

  for (const prefix of baselinePrefixesForMode({ milestone: context.milestone })) {
    const reviewer = BASELINE_REVIEWERS.find((entry) => entry.prefix === prefix);
    required.set(prefix, {
      prefix,
      agent: reviewer?.agent || null,
      reason: 'baseline enterprise review coverage',
      requiredEvidence: 'completed reviewer, finding prefix, or explicit no-finding verdict',
    });
  }

  const optionalByPrefix = new Map(OPTIONAL_REVIEWERS.map((reviewer) => [reviewer.prefix, reviewer]));
  function requireOptional(prefix, reason) {
    const reviewer = optionalByPrefix.get(prefix);
    required.set(prefix, {
      prefix,
      agent: reviewer?.agent || null,
      reason,
      requiredEvidence: 'specialist reviewer completion or explicit N/A rationale',
    });
  }

  if (signals.hasAuthzMatrix) requireOptional('AUTHZ', 'authz-matrix.json exists');
  if (signals.hasAI) requireOptional('AISEC', 'AI/LLM integration signals detected');
  if (signals.hasData) requireOptional('DBAUDIT', 'database, schema, or migration surface detected');
  if (signals.hasExternalSurface) requireOptional('PEN', 'external HTTP/UI surface detected');

  const completedPrefixes = new Set();
  for (const reviewer of manifest.completed || []) {
    const prefix = toReviewerPrefix(reviewer);
    if (prefix) completedPrefixes.add(prefix);
  }
  for (const reviewer of manifest.dispatched || []) {
    const prefix = toReviewerPrefix(reviewer);
    if (prefix) completedPrefixes.add(prefix);
  }
  const reviewData = readReviewData(context.reviewDir);
  for (const reviewer of reviewData?.reviewers || []) {
    const prefix = toReviewerPrefix(reviewer);
    if (prefix) completedPrefixes.add(prefix);
  }
  for (const finding of findings || []) {
    const prefix = findingPrefix(finding);
    if (prefix) completedPrefixes.add(prefix);
  }

  const entries = [...required.values()].map((entry) => ({
    ...entry,
    status: completedPrefixes.has(entry.prefix) ? 'covered' : 'missing',
  }));
  const missing = entries.filter((entry) => entry.status === 'missing');

  return {
    version: '1.0.0',
    generatedAt: context.generatedAt,
    generatedBy: 'cobolt-review-governance',
    reviewDir: context.reviewDir,
    milestone: context.milestone,
    signals,
    passed: missing.length === 0,
    requiredReviewers: entries,
    missingReviewers: missing,
    completedPrefixes: [...completedPrefixes].sort((left, right) => left.localeCompare(right)),
  };
}

function classifySurface(filePath) {
  const normalized = compactPath(filePath).toLowerCase();
  if (/(^|\/)(api|routes?|routers?|controllers?|handlers?)(\/|$)|\.(controller|handler|route)\./u.test(normalized)) {
    return 'api';
  }
  if (/(^|\/)(migrations?|schema)(\/|$)|\.(sql|prisma)$/u.test(normalized)) return 'migrations';
  if (/(^|\/)(jobs?|queues?|workers?|cron|scheduler)(\/|$)/u.test(normalized)) return 'jobs-queues';
  if (/\.(tsx|jsx|vue|svelte|html|css|scss)$/u.test(normalized)) return 'ui';
  if (/(^|\/)(infra|k8s|helm|terraform|cloudformation)(\/|$)|dockerfile|\.ya?ml$|\.tf$/u.test(normalized)) {
    return 'infra-config';
  }
  if (/(^|\/)(tests?|spec|__tests__)(\/|$)|\.(test|spec)\./u.test(normalized)) return 'tests';
  if (/(^|\/)(db|database|models?)(\/|$)/u.test(normalized)) return 'data-model';
  return 'code';
}

function buildCoverageMatrix(findings, context, sourceManifest) {
  const manifest = loadJson(path.join(context.reviewDir, REVIEW_FILES.manifest)) || {};
  const sourceFiles = fileListFromManifest(sourceManifest.manifest);
  const reviewedFiles = normalizeReviewedFiles(manifest, findings);
  const reviewedSet = new Set(reviewedFiles);
  const findingsByFile = new Map();
  for (const finding of findings || []) {
    const filePath = compactPath(finding.location?.file || finding.file || '');
    if (!filePath) continue;
    if (!findingsByFile.has(filePath)) findingsByFile.set(filePath, []);
    findingsByFile.get(filePath).push(finding);
  }

  const surfaces = new Map();
  function ensureSurface(name) {
    if (!surfaces.has(name)) {
      surfaces.set(name, {
        surface: name,
        fileCount: 0,
        reviewedFileCount: 0,
        findingCount: 0,
        reviewerPrefixes: [],
        status: 'not_applicable',
        files: [],
      });
    }
    return surfaces.get(name);
  }

  for (const filePath of sourceFiles) {
    const surface = ensureSurface(classifySurface(filePath));
    const findingList = findingsByFile.get(filePath) || [];
    const covered = reviewedSet.has(filePath) || findingList.length > 0;
    surface.fileCount += 1;
    if (covered) surface.reviewedFileCount += 1;
    surface.findingCount += findingList.length;
    for (const finding of findingList) {
      const prefix = findingPrefix(finding);
      if (prefix && !surface.reviewerPrefixes.includes(prefix)) surface.reviewerPrefixes.push(prefix);
    }
    surface.files.push({
      path: filePath,
      reviewed: covered,
      findings: findingList.map((finding) => finding.id),
    });
  }

  for (const [filePath, findingList] of findingsByFile.entries()) {
    if (sourceFiles.includes(filePath)) continue;
    const surface = ensureSurface(classifySurface(filePath));
    surface.reviewedFileCount += 1;
    surface.findingCount += findingList.length;
    for (const finding of findingList) {
      const prefix = findingPrefix(finding);
      if (prefix && !surface.reviewerPrefixes.includes(prefix)) surface.reviewerPrefixes.push(prefix);
    }
    surface.files.push({
      path: filePath,
      reviewed: true,
      findings: findingList.map((finding) => finding.id),
      sourceManifestMissing: true,
    });
  }

  const rows = [...surfaces.values()].map((surface) => ({
    ...surface,
    reviewerPrefixes: surface.reviewerPrefixes.sort((left, right) => left.localeCompare(right)),
    status:
      surface.fileCount === 0
        ? 'not_applicable'
        : surface.reviewedFileCount === surface.fileCount
          ? 'covered'
          : surface.reviewedFileCount > 0
            ? 'partial'
            : 'uncovered',
  }));
  const uncovered = rows.filter((row) => row.status === 'uncovered' || row.status === 'partial');
  const criticalUncovered = uncovered.filter((row) =>
    ['api', 'migrations', 'jobs-queues', 'ui', 'infra-config', 'data-model'].includes(row.surface),
  );

  return {
    version: '1.0.0',
    generatedAt: context.generatedAt,
    generatedBy: 'cobolt-review-governance',
    reviewDir: context.reviewDir,
    sourceRoot: context.projectRoot,
    milestone: context.milestone,
    sourceManifest: {
      present: sourceManifest.pass,
      detail: sourceManifest.detail,
      fileCount: sourceFiles.length,
    },
    passed: criticalUncovered.length === 0,
    summary: {
      surfaces: rows.length,
      sourceFiles: sourceFiles.length,
      reviewedFiles: reviewedFiles.length,
      uncoveredSurfaces: uncovered.length,
      criticalUncoveredSurfaces: criticalUncovered.length,
    },
    surfaces: rows.sort((left, right) => left.surface.localeCompare(right.surface)),
    uncoveredSurfaces: uncovered.map((row) => row.surface),
    criticalUncoveredSurfaces: criticalUncovered.map((row) => row.surface),
    requirements: buildRequirementCoverage(findings, context),
  };
}

function buildRequirementCoverage(findings, context) {
  const rtm = loadJson(path.join(context.projectRoot, '_cobolt-output', 'latest', 'planning', 'rtm.json'));
  const findingRequirements = new Set();
  for (const finding of findings || []) {
    const ids = [
      finding.requirementId,
      finding.requirement,
      finding.frId,
      ...(Array.isArray(finding.requirementIds) ? finding.requirementIds : []),
    ].filter(Boolean);
    for (const id of ids) findingRequirements.add(String(id));
  }
  const rtmRequirements = Array.isArray(rtm?.requirements)
    ? rtm.requirements.map((entry) => entry.id || entry.requirementId).filter(Boolean)
    : [];
  return {
    rtmPresent: Boolean(rtm),
    rtmRequirementCount: rtmRequirements.length,
    findingLinkedRequirementCount: findingRequirements.size,
    linkedRequirementIds: [...findingRequirements].sort((left, right) => left.localeCompare(right)),
  };
}

function findAuthzMatrix(projectRoot, reviewDir) {
  const candidates = [
    path.join(projectRoot, '_cobolt-output', 'latest', 'planning', 'authz-matrix.json'),
    path.join(projectRoot, '_cobolt-output', 'latest', 'security', 'authz-matrix.json'),
    path.join(projectRoot, '_cobolt-output', 'latest', 'review', 'authz-matrix.json'),
    path.join(reviewDir, 'authz-matrix.json'),
    path.join(projectRoot, 'authz-matrix.json'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  return { path: found || null, matrix: found ? loadJson(found) : null };
}

function countAuthzEntries(matrix) {
  if (!matrix) return 0;
  if (Array.isArray(matrix)) return matrix.length;
  for (const key of ['entries', 'routes', 'endpoints', 'resources', 'rules']) {
    if (Array.isArray(matrix[key])) return matrix[key].length;
  }
  return Object.keys(matrix).length;
}

function readAuthzEvidence(projectRoot, reviewDir) {
  const candidates = [
    path.join(reviewDir, 'authz-replay-results.json'),
    path.join(reviewDir, 'authz-census.json'),
    path.join(reviewDir, 'review-authz-evidence.json'),
    path.join(projectRoot, '_cobolt-output', 'latest', 'security', 'authz-replay-results.json'),
    path.join(projectRoot, '_cobolt-output', 'latest', 'test', 'authz-replay-results.json'),
  ];
  const evidencePath = candidates.find((candidate) => fs.existsSync(candidate));
  return { path: evidencePath || null, payload: evidencePath ? loadJson(evidencePath) : null };
}

function evidencePassed(payload) {
  if (!payload) return false;
  if (payload.passed === false || payload.ok === false || payload.status === 'failed') return false;
  if (payload.passed === true || payload.ok === true || payload.status === 'passed') return true;
  const checks = payload.checks || payload.results || payload.entries;
  if (Array.isArray(checks) && checks.length > 0) {
    return checks.every((entry) => entry.pass !== false && entry.passed !== false && entry.ok !== false);
  }
  return false;
}

function buildAuthzReplayGate(context) {
  const authz = findAuthzMatrix(context.projectRoot, context.reviewDir);
  if (!authz.path) {
    return {
      version: '1.0.0',
      generatedAt: context.generatedAt,
      generatedBy: 'cobolt-review-governance',
      reviewDir: context.reviewDir,
      milestone: context.milestone,
      applicable: false,
      passed: true,
      status: 'not_applicable',
      reason: 'No authz-matrix.json was found in planning, security, review, or project root outputs.',
      requiredChecks: [],
    };
  }

  const evidence = readAuthzEvidence(context.projectRoot, context.reviewDir);
  const passed = evidencePassed(evidence.payload);
  return {
    version: '1.0.0',
    generatedAt: context.generatedAt,
    generatedBy: 'cobolt-review-governance',
    reviewDir: context.reviewDir,
    milestone: context.milestone,
    applicable: true,
    passed,
    status: passed ? 'passed' : 'blocked',
    authzMatrix: {
      path: authz.path,
      entryCount: countAuthzEntries(authz.matrix),
    },
    evidence: {
      path: evidence.path,
      present: Boolean(evidence.path),
    },
    requiredChecks: [
      'positive role tests',
      'negative role tests',
      'tenant isolation tests',
      'resource ownership checks',
      'admin surface review',
    ],
    blocker: passed
      ? null
      : 'authz-matrix.json exists but no passing authz replay evidence was found before review handoff.',
  };
}

function buildChallengeBacklog(findings, context, reviewerPolicy, authzGate) {
  const items = [];
  const signals = reviewerPolicy.signals || {};
  function add(id, priority, title, source, requiredBeforeRelease = false) {
    items.push({
      id,
      priority,
      title,
      source,
      status: 'open',
      requiredBeforeRelease,
      owner: 'review-lead',
    });
  }

  if (authzGate.applicable) {
    add(
      'CHAL-AUTHZ-001',
      'P1',
      'Replay role, tenant, and ownership abuse cases from authz-matrix.json',
      'OWASP ASVS',
      true,
    );
  }
  if (signals.hasExternalSurface) {
    add(
      'CHAL-ABUSE-001',
      'P1',
      'Challenge external API/UI abuse flows and unauthenticated edge paths',
      'OWASP SAMM',
      true,
    );
  }
  if (signals.hasPackageManifest) {
    add(
      'CHAL-SUPPLY-001',
      'P2',
      'Challenge dependency provenance, lockfile drift, and risky transitive packages',
      'OWASP SCVS',
    );
  }
  if (signals.hasData) {
    add(
      'CHAL-DATA-001',
      'P2',
      'Challenge data integrity, rollback, retention, and migration failure modes',
      'NIST SSDF',
    );
  }
  if (signals.hasComplianceScope) {
    add('CHAL-COMP-001', 'P2', 'Challenge compliance evidence completeness and control ownership', 'SOC2/ISO 27001');
  }
  if ((findings || []).some(isSecurityRelevant)) {
    add(
      'CHAL-SEC-001',
      'P1',
      'Replay exploitability assumptions for security-relevant verified findings',
      'NIST SSDF',
      true,
    );
  }

  return {
    version: '1.0.0',
    generatedAt: context.generatedAt,
    generatedBy: 'cobolt-review-governance',
    reviewDir: context.reviewDir,
    milestone: context.milestone,
    minimumRequiredBeforeRelease: items.filter((item) => item.requiredBeforeRelease).map((item) => item.id),
    items,
  };
}

function buildReleaseGate(inputs, context) {
  const blockers = [];
  function block(id, reason, evidence) {
    blockers.push({ id, reason, evidence });
  }

  if (inputs.readiness?.passed === false) {
    block('READINESS', 'Review readiness gate failed.', inputs.readiness.failingChecks || []);
  }
  if (!inputs.riskAcceptance.passed) {
    block(
      'RISK-ACCEPTANCE',
      'Blocking critical/high review risks are neither fixed nor accepted.',
      inputs.riskAcceptance.pending,
    );
  }
  if (!inputs.reviewerPolicy.passed) {
    block(
      'REVIEWER-POLICY',
      'Mandatory reviewer profile coverage is incomplete.',
      inputs.reviewerPolicy.missingReviewers,
    );
  }
  if (!inputs.coverageMatrix.passed) {
    block(
      'COVERAGE-MATRIX',
      'Critical review surfaces are uncovered or partially covered.',
      inputs.coverageMatrix.criticalUncoveredSurfaces,
    );
  }
  if (!inputs.authzGate.passed) {
    block('AUTHZ-REPLAY', inputs.authzGate.blocker || 'Authorization replay gate failed.', inputs.authzGate.evidence);
  }

  const requiredChallenges = inputs.challengeBacklog.minimumRequiredBeforeRelease || [];
  if (requiredChallenges.length > 0) {
    block('CHALLENGE-BACKLOG', 'Top-risk challenge review items must be closed before release.', requiredChallenges);
  }

  const recommendation = blockers.some((entry) => entry.id === 'RISK-ACCEPTANCE')
    ? 'run-cobolt-fix'
    : blockers.some((entry) => entry.id === 'AUTHZ-REPLAY')
      ? 'run-authz-replay'
      : blockers.length > 0
        ? 'complete-review-governance-followups'
        : 'release-ready';

  return {
    version: '1.0.0',
    generatedAt: context.generatedAt,
    generatedBy: 'cobolt-review-governance',
    reviewDir: context.reviewDir,
    sourceRoot: context.projectRoot,
    milestone: context.milestone,
    passed: blockers.length === 0,
    blocked: blockers.length > 0,
    recommendation,
    policy:
      'Review is a release gate. Unresolved blocking risks, missing reviewer coverage, uncovered critical surfaces, authz replay gaps, or required challenge items block release.',
    blockers,
    inputReferences: {
      readinessGate: path.join(context.reviewDir, REVIEW_FILES.readinessGate),
      riskRegister: path.join(context.reviewDir, GOVERNANCE_FILES.riskRegister),
      riskAcceptance: path.join(context.reviewDir, GOVERNANCE_FILES.riskAcceptance),
      reviewerProfilePolicy: path.join(context.reviewDir, GOVERNANCE_FILES.reviewerProfilePolicy),
      coverageMatrix: path.join(context.reviewDir, GOVERNANCE_FILES.coverageMatrix),
      authzReplayGate: path.join(context.reviewDir, GOVERNANCE_FILES.authzReplayGate),
      challengeBacklog: path.join(context.reviewDir, GOVERNANCE_FILES.challengeBacklog),
    },
  };
}

function buildGovernance(reviewDir, options = {}) {
  const resolvedReviewDir = path.resolve(reviewDir || defaultReviewDir());
  const projectRoot = detectProjectRoot(resolvedReviewDir);
  const reviewData = readReviewData(resolvedReviewDir);
  const context = {
    generatedAt: new Date().toISOString(),
    reviewDir: resolvedReviewDir,
    projectRoot,
    milestone: detectMilestone(reviewData, projectRoot),
    state: readCoboltState(projectRoot) || {},
    buildPipeline: Boolean(options.buildPipeline),
  };
  const readiness = options.readiness || checkGate(resolvedReviewDir);
  const findings = listFindings(resolvedReviewDir);
  const sourceManifest = validateSourceManifest(resolvedReviewDir);
  const surfaceSignals = detectSurfaceSignals(projectRoot, resolvedReviewDir, sourceManifest.manifest);

  const riskRegister = buildRiskRegister(findings, context);
  const riskAcceptance = buildRiskAcceptance(riskRegister, context);
  const reviewerPolicy = buildReviewerProfilePolicy(findings, context, sourceManifest, surfaceSignals);
  const coverageMatrix = buildCoverageMatrix(findings, context, sourceManifest);
  const authzGate = buildAuthzReplayGate(context);
  const challengeBacklog = buildChallengeBacklog(findings, context, reviewerPolicy, authzGate);
  const releaseGate = buildReleaseGate(
    { readiness, riskAcceptance, reviewerPolicy, coverageMatrix, authzGate, challengeBacklog },
    context,
  );

  const artifacts = {
    riskRegister,
    riskAcceptance,
    reviewerProfilePolicy: reviewerPolicy,
    coverageMatrix,
    releaseGate,
    challengeBacklog,
    authzReplayGate: authzGate,
  };

  writeJson(path.join(resolvedReviewDir, GOVERNANCE_FILES.riskRegister), riskRegister);
  writeJson(path.join(resolvedReviewDir, GOVERNANCE_FILES.riskAcceptance), riskAcceptance);
  writeJson(path.join(resolvedReviewDir, GOVERNANCE_FILES.reviewerProfilePolicy), reviewerPolicy);
  writeJson(path.join(resolvedReviewDir, GOVERNANCE_FILES.coverageMatrix), coverageMatrix);
  writeJson(path.join(resolvedReviewDir, GOVERNANCE_FILES.releaseGate), releaseGate);
  writeJson(path.join(resolvedReviewDir, GOVERNANCE_FILES.challengeBacklog), challengeBacklog);
  writeJson(path.join(resolvedReviewDir, GOVERNANCE_FILES.authzReplayGate), authzGate);

  return {
    version: '1.0.0',
    generatedAt: context.generatedAt,
    generatedBy: 'cobolt-review-governance',
    reviewDir: resolvedReviewDir,
    sourceRoot: projectRoot,
    milestone: context.milestone,
    summary: {
      findings: findings.length,
      blockingRisks: riskRegister.summary.blocking,
      pendingRiskAcceptances: riskAcceptance.pending.length,
      missingReviewers: reviewerPolicy.missingReviewers.length,
      criticalUncoveredSurfaces: coverageMatrix.summary.criticalUncoveredSurfaces,
      authzReplayPassed: authzGate.passed,
      releaseBlocked: releaseGate.blocked,
    },
    files: Object.fromEntries(
      Object.entries(GOVERNANCE_FILES).map(([key, fileName]) => [key, path.join(resolvedReviewDir, fileName)]),
    ),
    artifacts,
  };
}

function checkGovernance(reviewDir) {
  const resolvedReviewDir = path.resolve(reviewDir || defaultReviewDir());
  const checks = REQUIRED_REVIEW_GOVERNANCE_CONTRACTS.map((fileName) => {
    const filePath = path.join(resolvedReviewDir, fileName);
    const parsed = loadJson(filePath);
    return {
      fileName,
      present: fs.existsSync(filePath),
      validJson: Boolean(parsed),
      nonEmpty: Boolean(parsed && Object.keys(parsed).length > 0),
    };
  });
  const releaseGate = loadJson(path.join(resolvedReviewDir, GOVERNANCE_FILES.releaseGate));
  const passed = checks.every((check) => check.present && check.validJson && check.nonEmpty) && Boolean(releaseGate);
  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-review-governance',
    reviewDir: resolvedReviewDir,
    passed,
    checks,
    releaseGate,
  };
}

function main() {
  const args = process.argv.slice(2);
  maybePrintHelpAndExit(args, USAGE);
  const command = args[0] || 'build';
  const dirIdx = args.indexOf('--dir');
  const reviewDir = dirIdx !== -1 && args[dirIdx + 1] ? args[dirIdx + 1] : defaultReviewDir();
  const jsonMode = args.includes('--json');
  const buildPipeline = args.includes('--build-pipeline');

  if (!['build', 'check'].includes(command)) {
    console.log('CoBolt Review Governance');
    console.log('');
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }

  const result = command === 'build' ? buildGovernance(reviewDir, { buildPipeline }) : checkGovernance(reviewDir);
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('[cobolt-review-governance] Review Governance');
  console.log(`  Milestone: ${result.milestone || result.releaseGate?.milestone || 'unknown'}`);
  console.log(`  Release blocked: ${Boolean(result.summary?.releaseBlocked || result.releaseGate?.blocked)}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  GOVERNANCE_FILES,
  REQUIRED_REVIEW_GOVERNANCE_CONTRACTS,
  buildAuthzReplayGate,
  buildCoverageMatrix,
  buildGovernance,
  buildReleaseGate,
  buildReviewerProfilePolicy,
  buildRiskAcceptance,
  buildRiskRegister,
  checkGovernance,
};
