#!/usr/bin/env node

// CoBolt Production Evidence Gate
//
// This gate makes production-track quality enforceable before build and
// release for every app size. It deliberately requires machine-readable evidence instead of
// trusting narrative PRDs, markdown architecture, or reviewer summaries.
//
// Usage:
//   node tools/cobolt-production-evidence.js check --phase prebuild --milestone M5 --json
//   node tools/cobolt-production-evidence.js check --phase release --milestone M5 --json
//   node tools/cobolt-production-evidence.js scan-stubs --json

const fs = require('node:fs');
const path = require('node:path');
const { paths: coboltPaths } = require('../lib/cobolt-paths');
const { validateProductionEvidenceArtifacts } = require('./cobolt-production-evidence-validate');

const DEFAULT_MIN_SCORE = 90;
const READY_REQUIREMENT_STATUSES = new Set(['covered', 'tested', 'implemented']);
const PASS_STATUSES = new Set(['pass', 'passed', 'ok', 'verified', 'not-applicable']);
const SENSITIVE_TERMS =
  /\b(payment|pci|finance|financial|bank|ledger|hipaa|health|medical|phi|child|children|kid|legal|soc2|iso\s*27001|enterprise|sensitive|pii|gdpr|privacy)\b/i;

const EXECUTABLE_PRD_FIELDS = [
  'acceptanceCriteria',
  'negativeCases',
  'edgeCases',
  'permissions',
  'dataLifecycle',
  'auditLogging',
  'performanceTargets',
  'securityRequirements',
  'failureBehavior',
  'observability',
  'migrationRollback',
  'stateTransitions',
  'apiContracts',
  'e2eScenarios',
];

const ARCHITECTURE_CONTROLS = [
  'boundedContexts',
  'databaseOwnership',
  'versionedApiContracts',
  'authRbacTenantModel',
  'backgroundJobsRetries',
  'integrationContracts',
  'failureModes',
  'nfrBudgets',
];

const BOUNDARY_TYPES = [
  'frontend-backend-api',
  'backend-database-schema',
  'service-queue',
  'webhooks',
  'third-party-integrations',
  'auth-session',
  'file-storage',
  'email-sms-payment',
  'feature-flags-config',
];

const EXTERNAL_BOUNDARY_TYPES = new Set(['webhooks', 'third-party-integrations', 'file-storage', 'email-sms-payment']);

const SECURITY_CONTROLS = [
  'threatModel',
  'authRbacTests',
  'tenantIsolationTests',
  'inputValidationTests',
  'injectionChecks',
  'dependencyScan',
  'secretsScan',
  'csrfCorsSessionCookieReview',
  'rateLimitAbuseTests',
  'auditLogVerification',
  'retentionPrivacyRules',
];

const RESILIENCE_CONTROLS = [
  'performanceBudgets',
  'loadTests',
  'slowQueryDetection',
  'bundleSizeChecks',
  'memoryLeakChecks',
  'retryIdempotencyTests',
  'timeoutTests',
  'queueFailureTests',
  'upstreamOutageTests',
  'dbConnectionExhaustionTests',
  'rollbackRehearsal',
];

const FINAL_VALIDATION_CONTROLS = [
  'happyPathE2E',
  'unhappyPathE2E',
  'rolePermissionMatrix',
  'mobileResponsive',
  'accessibility',
  'browserCompatibility',
  'realisticSeedData',
  'emptyLargeErrorStates',
  'upgradeMigrationPath',
  'rollbackPath',
  'postDeploySmoke',
  'monitoringAlertVerification',
];

const SHARED_CAPABILITIES = ['auth', 'billing', 'notifications', 'files', 'search', 'permissions'];

const SOURCE_ROOTS = ['src', 'app', 'lib', 'server', 'client', 'pages', 'components', 'workers', 'services'];
const SOURCE_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rb',
  '.php',
  '.ex',
  '.exs',
  '.java',
  '.kt',
  '.cs',
  '.rs',
]);
const IGNORED_SCAN_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  'test',
  'tests',
  '__tests__',
  'deps',
  '_build',
  '.elixir_ls',
  'vendor',
  '.next',
  'out',
  'tmp',
]);
const STUB_PATTERNS = [
  { id: 'todo', matches: hasTodoCommentMarker },
  { id: 'fake-service', pattern: /\bfake[A-Z_ -]?service\b|\bfake service\b/i },
  { id: 'placeholder-auth', pattern: /placeholder auth|auth placeholder|mock auth/i },
  { id: 'hardcoded-demo-data', pattern: /demo data|sample data|hardcoded.*demo/i },
  { id: 'prod-mock-provider', pattern: /(mock|fake).*(payment|email|storage|sms|oauth|webhook)/i },
  { id: 'silent-catch', pattern: /catch\s*\([^)]*\)\s*\{\s*\}/ },
  { id: 'temporary-flag', pattern: /temporary feature flag|temp flag|remove before prod/i },
];

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function readJsonl(filePath) {
  return readText(filePath)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function latestDir(cwd) {
  return coboltPaths(cwd).latest();
}

function latestFile(cwd, ...segments) {
  return path.join(latestDir(cwd), ...segments);
}

function outputRoot(cwd) {
  return coboltPaths(cwd).outputRoot;
}

function rel(cwd, filePath) {
  return filePath ? path.relative(cwd, filePath).replace(/\\/g, '/') : null;
}

function listRequirements(rtm) {
  if (Array.isArray(rtm?.requirements)) return rtm.requirements;
  if (rtm?.requirements && typeof rtm.requirements === 'object') return Object.values(rtm.requirements);
  return [];
}

function functionalRequirements(rtm) {
  return listRequirements(rtm).filter((req) => /^FR[-_]\d+/i.test(String(req.id || '')) || req.type === 'functional');
}

function statusPassed(value) {
  if (value === true) return true;
  if (typeof value === 'string') return PASS_STATUSES.has(value.toLowerCase());
  // v0.40.5: accept object form {passed:true} or {status:"pass"|"ok"|...}
  // produced by LLM authors per the canonical architecture-readiness schema.
  // Without this, the tool silently rejects valid control entries where the
  // author supplied richer context (evidence, notes, count) alongside the
  // pass flag — the producer sees "all 8 controls missing" even when each
  // is present and pass-flagged.
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (value.passed === true) return true;
    if (typeof value.status === 'string' && PASS_STATUSES.has(value.status.toLowerCase())) return true;
  }
  return false;
}

function arrayLikeHasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return typeof value === 'string' && value.trim().length > 0;
}

function coverageValuePassed(value) {
  if (statusPassed(value)) return true;
  return typeof value === 'string' && /^(N\/A|Not applicable|None applicable)\b/i.test(value.trim());
}

function evidenceControl(id, label, passed, evidence = {}, remediation = null, severity = 'critical') {
  return {
    id,
    label,
    status: passed ? 'pass' : 'fail',
    severity,
    evidence,
    remediation,
  };
}

function dimension(id, label, weight, controls) {
  const passed = controls.filter((control) => control.status === 'pass').length;
  const score = controls.length ? Math.round((passed / controls.length) * 100) : 0;
  const blockers = controls.filter((control) => control.status === 'fail' && control.severity !== 'advisory');
  return { id, label, weight, score, controls, blockers };
}

function approval(cwd, milestone, event) {
  const fp = path.join(outputRoot(cwd), 'audit', 'human-approvals.jsonl');
  const entries = readJsonl(fp);
  const found = [...entries].reverse().find((entry) => {
    return (
      entry.event === event &&
      String(entry.verdict || entry.decision || '').toLowerCase() === 'approved' &&
      (!milestone || entry.milestone === milestone)
    );
  });
  return { artifact: fp, approved: Boolean(found), entry: found };
}

function rtmEvidence(cwd) {
  const artifact = latestFile(cwd, 'planning', 'rtm.json');
  const rtm = readJson(artifact);
  const frs = functionalRequirements(rtm);
  const ready = frs.filter((req) => READY_REQUIREMENT_STATUSES.has(String(req.status || '').toLowerCase()));
  return { artifact, rtm, frs, ready };
}

function projectScope(cwd, rtmInfo = rtmEvidence(cwd)) {
  const milestoneText = readText(latestFile(cwd, 'planning', 'milestones.md'));
  const milestoneCount = new Set([...milestoneText.matchAll(/\bM\d+\b/g)].map((match) => match[0])).size;
  return {
    frCount: rtmInfo.frs.length,
    milestoneCount,
    highComplexity: rtmInfo.frs.length > 50 || milestoneCount > 5,
  };
}

function readExecutablePrd(cwd) {
  const artifact = latestFile(cwd, 'planning', 'executable-prd.json');
  const data = readJson(artifact);
  const requirements = Array.isArray(data?.requirements)
    ? data.requirements
    : data?.requirements && typeof data.requirements === 'object'
      ? Object.values(data.requirements)
      : [];
  const byId = new Map(requirements.map((req) => [req.id, req]));
  return { artifact, data, requirements, byId };
}

function readReleaseSlices(cwd) {
  const artifact = latestFile(cwd, 'planning', 'release-slices.json');
  const data = readJson(artifact);
  return { artifact, data, slices: Array.isArray(data?.slices) ? data.slices : [] };
}

function readArchitectureReadiness(cwd) {
  const artifact = latestFile(cwd, 'planning', 'architecture-readiness.json');
  const data = readJson(artifact);
  return { artifact, data, controls: data?.controls || {} };
}

function readBoundaryContracts(cwd) {
  const artifact = latestFile(cwd, 'planning', 'boundary-contracts.json');
  const data = readJson(artifact);
  return { artifact, data, boundaries: Array.isArray(data?.boundaries) ? data.boundaries : [] };
}

function readSecurityEvidence(cwd) {
  const artifact = latestFile(cwd, 'security', 'security-gate-evidence.json');
  const data = readJson(artifact);
  return { artifact, data, controls: data?.controls || {} };
}

function readResilienceEvidence(cwd) {
  const artifact = latestFile(cwd, 'resilience', 'resilience-gate-evidence.json');
  const data = readJson(artifact);
  return { artifact, data, controls: data?.controls || {} };
}

function readFinalValidationEvidence(cwd) {
  const artifact = latestFile(cwd, 'final-validation', 'final-validation-evidence.json');
  const data = readJson(artifact);
  return { artifact, data, controls: data?.controls || {} };
}

function readNoStubsEvidence(cwd) {
  const artifact = latestFile(cwd, 'no-stubs', 'production-no-stubs.json');
  const data = readJson(artifact);
  return { artifact, data };
}

function readScorecard(cwd) {
  const artifact = latestFile(cwd, 'production-readiness', 'scorecard.json');
  const data = readJson(artifact);
  return { artifact, data };
}

function readState(cwd) {
  return readJson(path.join(cwd, 'cobolt-state.json')) || {};
}

function normalizeMilestone(value) {
  const match = String(value || '')
    .trim()
    .match(/^M?(\d+)$/i);
  return match ? `M${Number(match[1])}` : null;
}

function inferMilestone(cwd) {
  const envMilestone = normalizeMilestone(process.env.COBOLT_MILESTONE);
  if (envMilestone) return envMilestone;

  const state = readState(cwd);
  const candidates = [
    state.pipeline?.currentMilestone,
    state.pipeline?.priorMilestone,
    state.currentMilestone,
    state.build?.currentMilestone,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeMilestone(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function validateCheckFlags(flags, cwd) {
  flags.phase = String(flags.phase || '').trim();
  if (!new Set(['prebuild', 'release']).has(flags.phase)) {
    return { ok: false, message: 'cobolt-production-evidence check requires --phase prebuild or --phase release.' };
  }

  const normalizedMilestone = normalizeMilestone(flags.milestone);
  if (flags.milestoneProvided && !normalizedMilestone) {
    return { ok: false, message: 'cobolt-production-evidence check requires a non-empty --milestone M{n} value.' };
  }

  flags.milestone = normalizedMilestone || inferMilestone(cwd);
  if (!flags.milestone) {
    return {
      ok: false,
      message: 'cobolt-production-evidence check requires --milestone M{n}; no milestone could be inferred from state.',
    };
  }

  return { ok: true };
}

function sensitiveDomain(cwd, securityEvidence) {
  if (securityEvidence.data?.sensitiveDomain === true) return true;
  const prd = `${readText(latestFile(cwd, 'planning', 'prd.md'))}\n${readText(latestFile(cwd, 'planning', 'feature-prd.md'))}`;
  return SENSITIVE_TERMS.test(prd);
}

function evaluateExecutablePrd(cwd, rtmInfo) {
  const prd = readExecutablePrd(cwd);
  const missingFrs = rtmInfo.frs.filter((req) => !prd.byId.has(req.id)).map((req) => req.id);
  const incomplete = [];
  for (const req of rtmInfo.frs) {
    const item = prd.byId.get(req.id);
    if (!item) continue;
    const missingFields = EXECUTABLE_PRD_FIELDS.filter((field) => !arrayLikeHasValue(item[field]));
    if (missingFields.length) incomplete.push({ id: req.id, missingFields });
  }
  return dimension('executable-prd', 'Executable PRD coverage', 15, [
    evidenceControl(
      'executable-prd-artifact',
      'executable-prd.json exists and has requirements',
      prd.requirements.length > 0,
      { artifact: rel(cwd, prd.artifact), requirements: prd.requirements.length },
      'Generate planning/executable-prd.json from the PRD with every required field per FR.',
    ),
    evidenceControl(
      'all-frs-executable',
      'Every FR has executable PRD evidence',
      rtmInfo.frs.length > 0 && missingFrs.length === 0,
      { totalFrs: rtmInfo.frs.length, missingFrs },
      'Backfill executable PRD records for every FR in the RTM.',
    ),
    evidenceControl(
      'executable-field-depth',
      'Every FR includes acceptance, negative, edge, permissions, lifecycle, security, ops, and rollback detail',
      incomplete.length === 0 && rtmInfo.frs.length > 0,
      { incomplete: incomplete.slice(0, 25), requiredFields: EXECUTABLE_PRD_FIELDS },
      'Expand each FR with negative cases, edge cases, permissions, lifecycle, failure, observability, and rollback expectations.',
    ),
  ]);
}

function evaluateSlices(cwd, rtmInfo) {
  const slices = readReleaseSlices(cwd);
  const assignedFrs = new Set(slices.slices.flatMap((slice) => slice.frs || []));
  const missingFrs = rtmInfo.frs.filter((req) => !assignedFrs.has(req.id)).map((req) => req.id);
  const badSlices = slices.slices
    .filter((slice) => {
      const coverage = slice.verticalCoverage || {};
      return (
        slice.deployable !== true ||
        slice.gatesBeforeDependents !== true ||
        !['ui', 'api', 'database', 'tests', 'observability'].every((key) =>
          coverageValuePassed(Object.hasOwn(coverage, key) ? coverage[key] : slice[key]),
        )
      );
    })
    .map((slice) => slice.id);
  const platform = slices.data?.sharedCapabilities || {};
  const missingPlatform = SHARED_CAPABILITIES.filter((capability) => {
    const item = platform[capability];
    return !(item?.platformOwned === true || item?.platformMilestone || item?.notApplicable || item?.ownerMilestone);
  });
  return dimension('shippable-slices', 'Independently shippable slices', 10, [
    evidenceControl(
      'release-slices-artifact',
      'release-slices.json exists and declares vertical slices',
      slices.slices.length > 0,
      { artifact: rel(cwd, slices.artifact), slices: slices.slices.length },
      'Generate release-slices.json with independently deployable vertical slices.',
    ),
    evidenceControl(
      'frs-assigned-to-slices',
      'Every FR is assigned to a release slice',
      rtmInfo.frs.length > 0 && missingFrs.length === 0,
      { missingFrs },
      'Assign every FR to exactly one independently shippable slice.',
    ),
    evidenceControl(
      'vertical-slice-coverage',
      'Every slice covers UI/API/database/tests/observability or marks N/A',
      slices.slices.length > 0 && badSlices.length === 0,
      { badSlices },
      'Each slice must be deployable and include UI, API, database, tests, and observability evidence.',
    ),
    evidenceControl(
      'shared-capabilities-platform-owned',
      'Shared capabilities are platform milestones or explicitly not applicable',
      missingPlatform.length === 0,
      { missingPlatform, required: SHARED_CAPABILITIES },
      'Declare auth, billing, notifications, files, search, and permissions ownership before feature slices depend on them.',
    ),
  ]);
}

function evaluateArchitecture(cwd) {
  const arch = readArchitectureReadiness(cwd);
  const missing = ARCHITECTURE_CONTROLS.filter((key) => !statusPassed(arch.controls[key]));
  return dimension('architecture-gate', 'Hard architecture readiness before build', 10, [
    evidenceControl(
      'architecture-readiness-artifact',
      'architecture-readiness.json exists',
      Boolean(arch.data),
      { artifact: rel(cwd, arch.artifact) },
      'Generate architecture-readiness.json before build.',
    ),
    evidenceControl(
      'architecture-controls-complete',
      'Bounded contexts, DB ownership, versioned APIs, auth/RBAC/tenant model, jobs, integrations, failure modes, and budgets are complete',
      Boolean(arch.data) && missing.length === 0,
      { missing, required: ARCHITECTURE_CONTROLS },
      'Block build until all architecture readiness controls are pass/verified.',
    ),
  ]);
}

function evaluateBoundaryContracts(cwd) {
  const contracts = readBoundaryContracts(cwd);
  const byType = new Map(contracts.boundaries.map((boundary) => [boundary.type, boundary]));
  const missing = BOUNDARY_TYPES.filter((type) => !byType.has(type));
  const incomplete = [];
  for (const type of BOUNDARY_TYPES) {
    const boundary = byType.get(type);
    if (!boundary) continue;
    if (boundary.status === 'not-applicable') {
      if (!arrayLikeHasValue(boundary.reason)) incomplete.push({ type, reason: 'not-applicable requires reason' });
      continue;
    }
    const hasContract = arrayLikeHasValue(boundary.contract) || arrayLikeHasValue(boundary.contractArtifact);
    const hasTests = arrayLikeHasValue(boundary.tests) || arrayLikeHasValue(boundary.testArtifact);
    const sandboxOk = !EXTERNAL_BOUNDARY_TYPES.has(type) || boundary.realOrSandboxVerified === true;
    if (!hasContract || !hasTests || !sandboxOk) {
      incomplete.push({ type, hasContract, hasTests, realOrSandboxVerified: boundary.realOrSandboxVerified === true });
    }
  }
  return dimension('boundary-contracts', 'Mandatory contract tests across boundaries', 12, [
    evidenceControl(
      'boundary-contracts-artifact',
      'boundary-contracts.json exists',
      Boolean(contracts.data),
      { artifact: rel(cwd, contracts.artifact), boundaries: contracts.boundaries.length },
      'Generate boundary-contracts.json with every boundary type pass or explicit N/A.',
    ),
    evidenceControl(
      'all-boundaries-declared',
      'Every required boundary type is declared',
      missing.length === 0,
      { missing, required: BOUNDARY_TYPES },
      'Declare frontend/API, DB, queue, webhook, provider, auth/session, storage, email/payment, and config boundaries.',
    ),
    evidenceControl(
      'contracts-and-tests-complete',
      'Every applicable boundary has contract and test evidence; external providers use real or sandbox verification',
      incomplete.length === 0 && contracts.boundaries.length > 0,
      { incomplete },
      'Add contract tests for every applicable boundary and sandbox/live verification for external providers.',
    ),
  ]);
}

function evaluateSchemaValidation(cwd) {
  const report = validateProductionEvidenceArtifacts(cwd);
  const invalid = (report.results || []).filter((entry) => !entry.valid && entry.exists !== false);
  const missing = (report.results || []).filter((entry) => entry.exists === false);
  const invalidEvidence = invalid.map((entry) => ({
    artifact: entry.filename,
    errors: (entry.errors || []).slice(0, 12),
  }));

  return dimension('schema-gate', 'Production evidence artifact schemas', 12, [
    evidenceControl(
      'production-evidence-schema-valid',
      'executable-prd, release-slices, architecture-readiness, and boundary-contracts satisfy canonical schemas',
      report.passed === true,
      {
        summary: report.summary,
        invalid: invalidEvidence,
        missing: missing.map((entry) => entry.filename),
        reason: report.reason || null,
      },
      'Run node tools/cobolt-production-evidence-validate.js --json and repair every schema violation before the production evidence gate.',
    ),
  ]);
}

function evaluateSecurity(cwd, milestone) {
  const security = readSecurityEvidence(cwd);
  const missing = SECURITY_CONTROLS.filter((key) => !statusPassed(security.controls[key]));
  const unresolvedHigh = Number(security.data?.unresolvedCriticalHigh || 0);
  const sensitive = sensitiveDomain(cwd, security);
  const signoff = approval(cwd, milestone, 'security-signoff');
  return dimension('security', 'Blocking security gate', 15, [
    evidenceControl(
      'security-evidence-artifact',
      'security-gate-evidence.json exists',
      Boolean(security.data),
      { artifact: rel(cwd, security.artifact) },
      'Generate security-gate-evidence.json from threat model, scanner, authz, tenant isolation, and abuse tests.',
    ),
    evidenceControl(
      'security-controls-complete',
      'Threat model, auth/RBAC, tenancy, validation, injection, dependency, secrets, session, abuse, audit, and retention controls pass',
      Boolean(security.data) && missing.length === 0,
      { missing, required: SECURITY_CONTROLS },
      'Run blocking security tests/scans and mark every security control pass or verified.',
    ),
    evidenceControl(
      'zero-critical-high-security',
      'No unresolved critical/high security findings remain',
      unresolvedHigh === 0,
      { unresolvedCriticalHigh: unresolvedHigh },
      'Fix, verify, or formally false-positive all critical/high security findings.',
    ),
    evidenceControl(
      'sensitive-domain-human-security-signoff',
      'Sensitive domains have human security signoff',
      !sensitive || signoff.approved,
      { sensitiveDomain: sensitive, artifact: rel(cwd, signoff.artifact), signer: signoff.entry?.signer || null },
      'Record a human security-signoff approval for sensitive projects before release.',
    ),
  ]);
}

function evaluateResilience(cwd) {
  const resilience = readResilienceEvidence(cwd);
  const missing = RESILIENCE_CONTROLS.filter((key) => !statusPassed(resilience.controls[key]));
  return dimension('resilience', 'Load and resilience gates', 12, [
    evidenceControl(
      'resilience-evidence-artifact',
      'resilience-gate-evidence.json exists',
      Boolean(resilience.data),
      { artifact: rel(cwd, resilience.artifact) },
      'Generate resilience-gate-evidence.json from load, timeout, retry, queue, outage, DB exhaustion, and rollback tests.',
    ),
    evidenceControl(
      'resilience-controls-complete',
      'Performance, load, slow queries, bundle, memory, retry/idempotency, timeouts, queue failures, outages, DB exhaustion, and rollback pass',
      Boolean(resilience.data) && missing.length === 0,
      { missing, required: RESILIENCE_CONTROLS },
      'Run resilience scenarios against a real release candidate and attach pass evidence.',
    ),
  ]);
}

function evaluateFinalValidation(cwd) {
  const finalValidation = readFinalValidationEvidence(cwd);
  const missing = FINAL_VALIDATION_CONTROLS.filter((key) => !statusPassed(finalValidation.controls[key]));
  return dimension('final-validation', 'Final validation depth', 12, [
    evidenceControl(
      'final-validation-artifact',
      'final-validation-evidence.json exists',
      Boolean(finalValidation.data),
      { artifact: rel(cwd, finalValidation.artifact) },
      'Generate final-validation-evidence.json from full UAT, E2E, deploy, and monitoring verification.',
    ),
    evidenceControl(
      'final-validation-controls-complete',
      'Happy/unhappy E2E, roles, mobile, a11y, browser, realistic data, empty/large/error states, migration, rollback, smoke, and alerts pass',
      Boolean(finalValidation.data) && missing.length === 0,
      { missing, required: FINAL_VALIDATION_CONTROLS },
      'Run final validation beyond happy paths and attach evidence for every required control.',
    ),
  ]);
}

function evaluateNoStubs(cwd) {
  const noStubs = readNoStubsEvidence(cwd);
  const findings = Array.isArray(noStubs.data?.findings) ? noStubs.data.findings : [];
  return dimension('no-stubs', 'No stubs, fake services, or production placeholders', 9, [
    evidenceControl(
      'no-stubs-artifact',
      'production-no-stubs.json exists',
      Boolean(noStubs.data),
      { artifact: rel(cwd, noStubs.artifact) },
      'Run node tools/cobolt-production-evidence.js scan-stubs and fix all production-path findings.',
    ),
    evidenceControl(
      'no-stub-findings',
      'No production-path stub/fake/TODO/silent-catch findings remain',
      noStubs.data?.passed === true && findings.length === 0,
      { findings: findings.slice(0, 25), count: findings.length },
      'Remove stubs, fake providers, placeholder auth, demo data, silent catch blocks, and missing rollback placeholders from production paths.',
    ),
  ]);
}

function evaluateScorecard(cwd) {
  const scorecard = readScorecard(cwd);
  const categories = scorecard.data?.categories || {};
  const required = [
    'functionalCorrectness',
    'e2eCoverage',
    'security',
    'performance',
    'reliability',
    'observability',
    'data',
    'compliance',
    'deployment',
    'documentation',
  ];
  const missing = required.filter((key) => !statusPassed(categories[key]?.status || categories[key]));
  return dimension('scorecard', 'Machine-readable production readiness scorecard', 5, [
    evidenceControl(
      'scorecard-artifact',
      'scorecard.json exists',
      Boolean(scorecard.data),
      { artifact: rel(cwd, scorecard.artifact), score: scorecard.data?.score ?? null },
      'Generate production-readiness/scorecard.json with category-level pass/fail evidence.',
    ),
    evidenceControl(
      'scorecard-categories-complete',
      'Functional, E2E, security, performance, reliability, observability, data, compliance, deployment, and documentation categories pass',
      Boolean(scorecard.data) && Number(scorecard.data.score || 0) >= DEFAULT_MIN_SCORE && missing.length === 0,
      { missing, required, score: scorecard.data?.score ?? null },
      'Backfill category evidence and keep the readiness score at or above 90.',
    ),
  ]);
}

function evaluateRigorousTrack(cwd, scope) {
  const state = readState(cwd);
  const mode = state.mode === 'rigorous' ? 'rigorous' : 'auto';
  return dimension('rigorous-track', 'Production-track release uses rigorous track', 5, [
    evidenceControl(
      'production-rigorous-mode',
      'Production-track release evidence cannot pass from ordinary auto mode',
      mode === 'rigorous',
      { mode, projectScope: scope, autoImpliesRigorous: state.productionTrack?.autoImpliesRigorous === true },
      'Use cobolt-cli ... --auto or --autonomous. Auto now persists rigorous mode so human, independent verification, mutation, load/chaos, and invariant gates are active.',
    ),
  ]);
}

function phasesFor(phase) {
  if (phase === 'prebuild') {
    return ['schema-gate', 'executable-prd', 'shippable-slices', 'architecture-gate', 'boundary-contracts'];
  }
  return [
    'schema-gate',
    'rigorous-track',
    'executable-prd',
    'shippable-slices',
    'architecture-gate',
    'boundary-contracts',
    'security',
    'resilience',
    'final-validation',
    'no-stubs',
    'scorecard',
  ];
}

function evaluate(options = {}) {
  const cwd = options.cwd || process.cwd();
  const milestone = options.milestone || null;
  const phase = options.phase || 'release';
  const minScore = Number(options.minScore || DEFAULT_MIN_SCORE);
  const rtmInfo = rtmEvidence(cwd);
  const scope = projectScope(cwd, rtmInfo);

  const allDimensions = [
    evaluateSchemaValidation(cwd),
    evaluateRigorousTrack(cwd, scope),
    evaluateExecutablePrd(cwd, rtmInfo),
    evaluateSlices(cwd, rtmInfo),
    evaluateArchitecture(cwd),
    evaluateBoundaryContracts(cwd),
    evaluateSecurity(cwd, milestone),
    evaluateResilience(cwd),
    evaluateFinalValidation(cwd),
    evaluateNoStubs(cwd),
    evaluateScorecard(cwd),
  ];
  const includedIds = new Set(phasesFor(phase));
  const dimensions = allDimensions.filter((dim) => includedIds.has(dim.id));
  const totalWeight = dimensions.reduce((sum, dim) => sum + dim.weight, 0);
  const score = Math.round(dimensions.reduce((sum, dim) => sum + dim.score * dim.weight, 0) / totalWeight);
  const blockers = dimensions.flatMap((dim) =>
    dim.blockers.map((control) => ({
      dimension: dim.id,
      id: control.id,
      label: control.label,
      evidence: control.evidence,
      remediation: control.remediation,
    })),
  );
  const passed = score >= minScore && blockers.length === 0;
  // v0.40.13 PROD-14: capture the resolved run reference so downstream
  // consumers can detect stale evidence (e.g., planning-time run-001 gate
  // persisted across a run-003 build). Mirrors v0.40.13 PROD-13 freshness
  // metadata in cobolt-agent-failure-review.js.
  const resolvedLatest = latestDir(cwd);
  let runRef = null;
  try {
    const ptr = fs.readFileSync(path.join(cwd, '_cobolt-output', 'latest.ptr'), 'utf8').trim();
    if (ptr) runRef = ptr;
  } catch {
    runRef = resolvedLatest;
  }
  const generatedAtIso = new Date().toISOString();
  const result = {
    version: 1,
    generatedAt: generatedAtIso,
    staleAfter: new Date(Date.parse(generatedAtIso) + 30 * 60 * 1000).toISOString(),
    runRef,
    resolvedLatestDir: resolvedLatest,
    phase,
    milestone,
    projectScope: scope,
    minScore,
    score,
    passed,
    summary: {
      blockerCount: blockers.length,
      dimensionsPassed: dimensions.filter((dim) => dim.score >= minScore && dim.blockers.length === 0).length,
      dimensionsTotal: dimensions.length,
    },
    dimensions,
    blockers,
  };
  writeResult(cwd, result);
  return result;
}

function writeResult(cwd, result) {
  const outDir = path.join(latestDir(cwd), 'production-evidence');
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(outDir, `${result.phase}-gate.json`), JSON.stringify(result, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function scanSource(cwd = process.cwd()) {
  const findings = [];
  for (const rootName of SOURCE_ROOTS) {
    const root = path.join(cwd, rootName);
    if (!fs.existsSync(root)) continue;
    scanDir(cwd, root, findings);
  }
  const result = { version: 1, generatedAt: new Date().toISOString(), passed: findings.length === 0, findings };
  const outDir = latestFile(cwd, 'no-stubs');
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(outDir, 'production-no-stubs.json'), JSON.stringify(result, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  return result;
}

function hasTodoCommentMarker(line) {
  const markerIndex = String(line).search(/\b(TODO|FIXME)\b/i);
  if (markerIndex < 0) return false;

  let quote = null;
  let escaped = false;
  for (let i = 0; i < markerIndex; i++) {
    const ch = line[i];
    const next = line[i + 1];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '#') return true;
    if (ch === '/' && (next === '/' || next === '*')) return true;
    if (ch === '-' && next === '-') return true;
  }
  return false;
}

function scanDir(cwd, dir, findings) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fp = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_SCAN_DIRS.has(entry.name)) continue;
      scanDir(cwd, fp, findings);
      continue;
    }
    if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
    const text = readText(fp);
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      for (const pattern of STUB_PATTERNS) {
        const matched = pattern.matches ? pattern.matches(line) : pattern.pattern.test(line);
        if (matched) {
          findings.push({ id: pattern.id, file: rel(cwd, fp), line: index + 1, text: line.trim().slice(0, 180) });
        }
      }
    }
  }
}

function parseArgs(args) {
  const flags = {
    phase: 'release',
    milestone: null,
    milestoneProvided: false,
    json: false,
    minScore: DEFAULT_MIN_SCORE,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--phase') flags.phase = args[++i] || flags.phase;
    else if (arg === '--milestone') {
      flags.milestoneProvided = true;
      flags.milestone = args[++i] || null;
    } else if (arg === '--min-score') flags.minScore = Number(args[++i] || DEFAULT_MIN_SCORE);
    else if (arg === '--json') flags.json = true;
  }
  return flags;
}

function print(result) {
  console.log(`Production evidence gate - ${result.passed ? 'PASS' : 'FAIL'}`);
  console.log(`Phase: ${result.phase}`);
  console.log(`Score: ${result.score} (min ${result.minScore})`);
  if (result.blockers.length) {
    console.log(`\nBlockers (${result.blockers.length}):`);
    for (const blocker of result.blockers.slice(0, 25)) {
      console.log(`- [${blocker.dimension}] ${blocker.label}`);
      if (blocker.remediation) console.log(`  Remediation: ${blocker.remediation}`);
    }
  }
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  // v0.46 — explicit --help / -h / help → exit 0 per tools/CLAUDE.md contract
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(
      'Usage: cobolt-production-evidence.js check|scan-stubs [--phase prebuild|release] [--milestone M5] [--json]\n',
    );
    return 0;
  }
  if (cmd === 'check') {
    const flags = parseArgs(rest);
    const validation = validateCheckFlags(flags, process.cwd());
    if (!validation.ok) {
      console.error(validation.message);
      return 2;
    }
    const result = evaluate(flags);
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else print(result);
    return result.passed ? 0 : 1;
  }
  if (cmd === 'scan-stubs') {
    const flags = parseArgs(rest);
    const result = scanSource(process.cwd());
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else
      console.log(`Production no-stubs scan - ${result.passed ? 'PASS' : 'FAIL'} (${result.findings.length} findings)`);
    return result.passed ? 0 : 1;
  }
  console.error(
    'Usage: cobolt-production-evidence.js check|scan-stubs [--phase prebuild|release] [--milestone M5] [--json]',
  );
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = { evaluate, scanSource };
