#!/usr/bin/env node

// CoBolt Fix Readiness - deterministic remediation packet generation and gate.
//
// Converts review/standalone findings into a mandatory remediation contract:
// source registry, fix case registry, risk register, remediation plan,
// validation plan, coverage matrix, and readiness report.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildFixResolutionFidelity } = require('./cobolt-fix-resolution-fidelity');

const DEFAULT_SOURCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const EVIDENCE_LEVELS = new Set([
  'OBSERVED',
  'REPRODUCED',
  'LOGGED',
  'CODE_CONFIRMED',
  'TEST_CONFIRMED',
  'REVIEW_CONFIRMED',
  'INFERRED',
  'SUSPECTED',
  'ASSUMPTION',
]);

const PROCEED_EVIDENCE_LEVELS = new Set([
  'OBSERVED',
  'REPRODUCED',
  'LOGGED',
  'CODE_CONFIRMED',
  'TEST_CONFIRMED',
  'REVIEW_CONFIRMED',
  'INFERRED',
  'SUSPECTED',
]);

const REQUIRED_DIMENSIONS = [
  'findingSource',
  'severityPriority',
  'impact',
  'reproduction',
  'sourceEvidence',
  'recentChanges',
  'rootCauseHypotheses',
  'blastRadius',
  'rollbackPlan',
  'fixStrategy',
  'testPlan',
  'securityPrivacy',
  'dataMigration',
  'integrations',
  'observability',
  'deployment',
  'verification',
  'rcaPrevention',
];

const REQUIRED_FIX_CONTRACTS = [
  'fix-source-proof.json',
  'fix-blast-radius.json',
  'fix-touched-surface-gates.json',
  'fix-learning-packet.json',
  'risk-acceptance.json',
  'architecture-mutation-approval.json',
  'fix-rollback-plan.json',
  'hotfix-release-contract.json',
];

const ACTIONABLE_STATUSES = new Set([
  '',
  'open',
  'assigned',
  'verified',
  'unverified',
  'fix-applied',
  'fix-applied-unverified',
  'fix-applied-failing',
  'fix-applied-no-test',
  'stalled',
]);

const UI_PREFIXES = new Set(['A11Y', 'UI', 'UIPH', 'DT', 'UX', 'I18N']);
const API_PREFIXES = new Set(['API', 'APIWIRE', 'CONTRACT', 'ROUTE', 'WIRE']);
const SECURITY_PREFIXES = new Set(['SEC', 'AUTHZ', 'AISEC', 'PEN', 'SIL', 'COMP']);
const DATA_PREFIXES = new Set(['DB', 'QRY']);
const INTEGRATION_PREFIXES = new Set(['INT', 'LIFECYCLE']);
const OPS_PREFIXES = new Set(['OPS', 'CONF', 'DEP', 'LIFECYCLE']);

function parseArgs(args) {
  const get = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 && args[index + 1] ? args[index + 1] : null;
  };

  return {
    sourcePath: get('--source'),
    outputDir: get('--output-dir') || path.join('_cobolt-output', 'latest', 'fix'),
    mode: get('--mode') || 'pipeline',
    milestone: get('--milestone') || null,
    incidentId: get('--incident-id') || null,
    requireSourceProof: args.includes('--require-source-proof'),
    maxSourceAgeMs: Number(get('--max-source-age-ms') || DEFAULT_SOURCE_MAX_AGE_MS),
    zeroCaseReason: get('--zero-case-reason') || null,
    jsonMode: args.includes('--json'),
    allowEmpty: args.includes('--allow-empty'),
  };
}

function readJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function fileFingerprint(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const bytes = fs.readFileSync(filePath);
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function inferProjectRoot(outputDir, options = {}) {
  if (options.projectRoot) return path.resolve(options.projectRoot);
  const resolvedOutputDir = path.resolve(outputDir || options.outputDir || process.cwd());
  const marker = `${path.sep}_cobolt-output${path.sep}latest${path.sep}fix`;
  const markerIndex = resolvedOutputDir.lastIndexOf(marker);
  if (markerIndex !== -1) return resolvedOutputDir.slice(0, markerIndex);
  if (options.sourcePath) return path.dirname(path.resolve(options.sourcePath));
  return path.dirname(resolvedOutputDir);
}

function normalizeSeverity(value) {
  const severity = String(value || '')
    .trim()
    .toLowerCase();
  if (['critical', 'high', 'medium', 'low'].includes(severity)) return severity;
  return 'medium';
}

function normalizePriority(value, severity) {
  const priority = String(value || '')
    .trim()
    .toUpperCase();
  if (/^P[0-4]$/u.test(priority)) return priority;
  switch (normalizeSeverity(severity)) {
    case 'critical':
      return 'P0';
    case 'high':
      return 'P1';
    case 'medium':
      return 'P2';
    default:
      return 'P3';
  }
}

function extractPrefix(finding) {
  if (finding?.prefix) return String(finding.prefix).trim().toUpperCase();
  const match = String(finding?.id || '').match(/^([A-Z]+)-?\d/u);
  return match ? match[1] : 'CODE';
}

function normalizeFindingId(finding, index) {
  return String(finding?.id || `FIX-${String(index + 1).padStart(3, '0')}`).trim();
}

function resolveLocation(finding) {
  if (finding?.location && typeof finding.location === 'object') {
    return {
      file: finding.location.file || finding.file || null,
      line: finding.location.line || finding.line || null,
      function: finding.location.function || finding.function || null,
    };
  }
  if (typeof finding?.location === 'string') {
    return { file: finding.location, line: finding.line || null, function: finding.function || null };
  }
  return { file: finding?.file || null, line: finding?.line || null, function: finding?.function || null };
}

function normalizeFindings(payload) {
  const rawFindings = Array.isArray(payload) ? payload : Array.isArray(payload?.findings) ? payload.findings : [];
  return rawFindings
    .map((finding, index) => ({
      ...finding,
      id: normalizeFindingId(finding, index),
      prefix: extractPrefix(finding),
      severity: normalizeSeverity(finding?.severity),
      priority: normalizePriority(finding?.priority, finding?.severity),
      location: resolveLocation(finding),
      status: String(finding?.status || 'open').toLowerCase(),
    }))
    .filter((finding) => ACTIONABLE_STATUSES.has(finding.status));
}

function detectDefaultSourcePath(outputDir) {
  const candidates = [path.join(outputDir, 'finding-tracker.json')];
  const defaultOutputDir = path.resolve(path.join('_cobolt-output', 'latest', 'fix'));
  if (path.resolve(outputDir) === defaultOutputDir) {
    candidates.push(
      path.join('_cobolt-output', 'latest', 'review', 'review-findings.json'),
      path.join('_cobolt-output', 'latest', 'review', 'verified-findings.json'),
    );
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function text(value, fallback) {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function hasEvidence(finding) {
  return Array.isArray(finding?.evidence) && finding.evidence.some((entry) => String(entry || '').trim());
}

function dimension({ status = 'covered', evidenceLevel = 'INFERRED', detail, owner = 'fix-lead', artifact = null }) {
  return {
    status,
    evidenceLevel,
    detail: text(detail, 'Explicitly evaluate this dimension before dispatch.'),
    owner,
    artifact,
  };
}

function routeAgent(prefix) {
  if (UI_PREFIXES.has(prefix)) return 'cobolt-frontend-fix';
  if (prefix === 'DB') return 'cobolt-db-fix';
  if (prefix === 'COMP') return 'cobolt-compliance-fix';
  if (prefix === 'FEAT' || prefix === 'ENH') return 'deferred-to-planning-build';
  return 'cobolt-backend-fix';
}

function needsUi(prefix) {
  return UI_PREFIXES.has(prefix);
}

function needsApi(prefix) {
  return API_PREFIXES.has(prefix);
}

function needsSecurity(prefix) {
  return SECURITY_PREFIXES.has(prefix);
}

function needsData(prefix) {
  return DATA_PREFIXES.has(prefix);
}

function needsIntegration(prefix) {
  return INTEGRATION_PREFIXES.has(prefix) || API_PREFIXES.has(prefix);
}

function needsOps(prefix) {
  return OPS_PREFIXES.has(prefix) || SECURITY_PREFIXES.has(prefix);
}

function verificationChecksFor(finding) {
  const prefix = finding.prefix;
  const checks = ['toolGate', 'regressionTests', 'scopedReview', 'fixVerdict'];
  if (finding.severity === 'critical' || finding.severity === 'high') {
    checks.push('originalFailureReplay', 'minimalReproReplay');
  }
  if (needsUi(prefix) || needsApi(prefix)) checks.push('browserSmoke', 'uatRegression');
  if (needsSecurity(prefix)) checks.push('securityRetest');
  if (needsData(prefix)) checks.push('migrationOrQueryVerification');
  if (needsIntegration(prefix)) checks.push('integrationContractReplay');
  return [...new Set(checks)];
}

function findingFile(finding) {
  return finding?.location?.file || finding?.file || null;
}

function impactedSurfaceFor(finding) {
  const prefix = String(finding?.prefix || '').toUpperCase();
  const file = findingFile(finding);
  const surfaces = [];
  if (file) surfaces.push({ kind: 'file', id: file, evidence: 'finding-location' });
  if (needsApi(prefix)) surfaces.push({ kind: 'api-or-route', id: file || finding.id, evidence: `prefix:${prefix}` });
  if (needsSecurity(prefix)) surfaces.push({ kind: 'security-control', id: finding.id, evidence: `prefix:${prefix}` });
  if (needsData(prefix))
    surfaces.push({ kind: 'data-or-migration', id: file || finding.id, evidence: `prefix:${prefix}` });
  if (needsIntegration(prefix))
    surfaces.push({ kind: 'integration-contract', id: file || finding.id, evidence: `prefix:${prefix}` });
  if (needsUi(prefix)) surfaces.push({ kind: 'ui-flow', id: file || finding.id, evidence: `prefix:${prefix}` });
  if (needsOps(prefix)) surfaces.push({ kind: 'ops-or-deploy', id: file || finding.id, evidence: `prefix:${prefix}` });
  return surfaces;
}

function riskDomainFor(caseEntry) {
  const domains = [];
  if (caseEntry.dimensions.securityPrivacy.status !== 'n/a') domains.push('security-privacy');
  if (caseEntry.dimensions.dataMigration.status !== 'n/a') domains.push('data-migration');
  if (caseEntry.dimensions.integrations.status !== 'n/a') domains.push('integration');
  if (needsOps(caseEntry.prefix)) domains.push('operations');
  return domains.length > 0 ? domains : ['code-quality'];
}

function buildSourceRegistry(findings, options) {
  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-fix-readiness',
    mode: options.mode,
    milestone: options.milestone || null,
    sourcePath: options.sourcePath || null,
    entries: findings.map((finding, index) => {
      const sourceId = `FIXSRC-${String(index + 1).padStart(3, '0')}`;
      return {
        sourceId,
        findingId: finding.id,
        prefix: finding.prefix,
        severity: finding.severity,
        priority: finding.priority,
        status: finding.status || 'open',
        title: text(finding.title || finding.description, finding.id),
        description: text(finding.description || finding.message || finding.reason, 'No description supplied.'),
        location: finding.location,
        reviewerAgent: finding.reviewerAgent || finding.reviewer || finding.agent || null,
        evidenceLevel: hasEvidence(finding) ? 'CODE_CONFIRMED' : 'REVIEW_CONFIRMED',
        evidenceCount: Array.isArray(finding.evidence) ? finding.evidence.length : 0,
      };
    }),
  };
}

function buildCaseForFinding(finding, sourceId, index) {
  const prefix = finding.prefix;
  const locationLabel = finding.location?.file
    ? `${finding.location.file}${finding.location.line ? `:${finding.location.line}` : ''}`
    : 'unlocated finding';
  const securityRequired = needsSecurity(prefix);
  const dataRequired = needsData(prefix);
  const integrationRequired = needsIntegration(prefix);
  const opsRequired = needsOps(prefix);
  const verificationChecks = verificationChecksFor(finding);
  const rootCause = text(
    finding.rootCause || finding.root_cause,
    'Root cause must be confirmed through hypothesis-log experiments before verified-resolved.',
  );
  const suggestedFix = text(
    finding.suggestedFix || finding.recommendation || finding.remediation,
    'Apply the smallest root-cause fix using RED/GREEN/REFACTOR discipline.',
  );

  return {
    caseId: `FIXCASE-${String(index + 1).padStart(3, '0')}`,
    findingId: finding.id,
    sourceIds: [sourceId],
    prefix,
    severity: finding.severity,
    priority: finding.priority,
    assignedAgent: routeAgent(prefix),
    status: 'READY',
    dimensions: {
      findingSource: dimension({
        evidenceLevel: hasEvidence(finding) ? 'CODE_CONFIRMED' : 'REVIEW_CONFIRMED',
        detail: `Trace ${finding.id} back to ${sourceId} from the review or standalone recon source.`,
      }),
      severityPriority: dimension({
        evidenceLevel: 'INFERRED',
        detail: `Severity ${finding.severity}, priority ${finding.priority}; update if impact/frequency/user count changes.`,
      }),
      impact: dimension({
        evidenceLevel: finding.impact || finding.businessImpact ? 'OBSERVED' : 'INFERRED',
        detail: text(
          finding.impact || finding.businessImpact,
          `Impact is derived from ${prefix} severity and affected location ${locationLabel}. Confirm affected users or systems during preflight.`,
        ),
      }),
      reproduction: dimension({
        evidenceLevel: finding.reproductionSteps || finding.reproSteps ? 'REPRODUCED' : 'INFERRED',
        detail: text(
          Array.isArray(finding.reproductionSteps) ? finding.reproductionSteps.join(' | ') : finding.reproductionSteps,
          'Create failure-capture.json and minimal-repro.json, then replay the original failing path before marking resolved.',
        ),
        artifact: '_cobolt-output/latest/fix/failure-capture.json',
      }),
      sourceEvidence: dimension({
        evidenceLevel: hasEvidence(finding) ? 'CODE_CONFIRMED' : 'REVIEW_CONFIRMED',
        detail: hasEvidence(finding)
          ? `Finding includes ${finding.evidence.length} evidence line(s); re-read ${locationLabel} before editing.`
          : `Read and confirm the cited source at ${locationLabel} before dispatch.`,
      }),
      recentChanges: dimension({
        evidenceLevel: 'INFERRED',
        detail: `Review git log, git diff, and blame for ${finding.location?.file || 'the affected subsystem'} before editing.`,
      }),
      rootCauseHypotheses: dimension({
        evidenceLevel: finding.rootCause || finding.root_cause ? 'INFERRED' : 'SUSPECTED',
        detail: rootCause,
        artifact: '_cobolt-output/latest/fix/hypothesis-log.json',
      }),
      blastRadius: dimension({
        evidenceLevel: 'INFERRED',
        detail: `Blast radius starts with ${locationLabel}; include callers, tests, API routes, data paths, jobs, and dependent UI flows before dispatch.`,
      }),
      rollbackPlan: dimension({
        evidenceLevel: 'INFERRED',
        detail:
          finding.severity === 'critical' || finding.severity === 'high'
            ? 'Rollback requires revertable commits, data safety check, and deploy rollback note before merge.'
            : 'Rollback by reverting the scoped fix commit and associated test commit.',
      }),
      fixStrategy: dimension({
        evidenceLevel: finding.suggestedFix || finding.recommendation || finding.remediation ? 'INFERRED' : 'SUSPECTED',
        detail: suggestedFix,
      }),
      testPlan: dimension({
        evidenceLevel: 'INFERRED',
        detail:
          finding.severity === 'critical' || finding.severity === 'high'
            ? `Write RED regression test for ${finding.id}, prove it fails before fix, then run affected + full regression checks.`
            : `Add or update a targeted regression test for ${finding.id}; document if test is not practical.`,
      }),
      securityPrivacy: securityRequired
        ? dimension({
            evidenceLevel: 'INFERRED',
            detail:
              'Map remediation to secure coding guidance, run security retest, and verify no new auth/data exposure.',
          })
        : dimension({
            status: 'n/a',
            evidenceLevel: 'INFERRED',
            detail: `N/A - ${prefix} finding does not directly change security or privacy controls; reclassify if code path proves otherwise.`,
          }),
      dataMigration: dataRequired
        ? dimension({
            evidenceLevel: 'INFERRED',
            detail:
              'Plan schema/query/data integrity checks, rollback SQL, migration ordering, and backup safety before editing.',
          })
        : dimension({
            status: 'n/a',
            evidenceLevel: 'INFERRED',
            detail: `N/A - no persisted data change is expected from ${prefix}; update if the fix touches storage.`,
          }),
      integrations: integrationRequired
        ? dimension({
            evidenceLevel: 'INFERRED',
            detail:
              'Replay API/integration contract, retry/fallback behavior, webhook/idempotency, and external error paths.',
          })
        : dimension({
            status: 'n/a',
            evidenceLevel: 'INFERRED',
            detail: `N/A - no external or API integration change is expected from ${prefix}; update if the fix crosses a boundary.`,
          }),
      observability: dimension({
        evidenceLevel: 'INFERRED',
        detail: opsRequired
          ? 'Verify logs, metrics, traces, alerts, and operator-visible failure modes around this fix.'
          : 'Confirm the fix leaves enough logs/metrics to diagnose recurrence without leaking sensitive data.',
      }),
      deployment: dimension({
        evidenceLevel: 'INFERRED',
        detail:
          finding.severity === 'critical' || finding.severity === 'high'
            ? 'Use controlled rollout, health checks, and rollback plan for critical/high remediation.'
            : 'Deploy through standard pipeline after tests and scoped review pass.',
      }),
      verification: dimension({
        evidenceLevel: 'INFERRED',
        detail: `Required checks: ${verificationChecks.join(', ')}.`,
        artifact: '_cobolt-output/latest/fix/fix-validation-plan.json',
      }),
      rcaPrevention: dimension({
        evidenceLevel: 'INFERRED',
        detail: 'RCA must record root cause, why it escaped, prevention action, owner, and follow-up verification.',
      }),
    },
  };
}

function summarizeRisk(caseEntry) {
  const highSeverity = caseEntry.severity === 'critical' || caseEntry.severity === 'high';
  const hasCrossBoundary =
    caseEntry.dimensions.integrations.status !== 'n/a' ||
    caseEntry.dimensions.dataMigration.status !== 'n/a' ||
    caseEntry.dimensions.securityPrivacy.status !== 'n/a';
  const riskLevel = highSeverity && hasCrossBoundary ? 'high' : highSeverity ? 'medium-high' : 'medium';
  return {
    caseId: caseEntry.caseId,
    findingId: caseEntry.findingId,
    severity: caseEntry.severity,
    priority: caseEntry.priority,
    riskLevel,
    blastRadius: caseEntry.dimensions.blastRadius.detail,
    rollbackPlan: caseEntry.dimensions.rollbackPlan.detail,
    riskControls: [
      'revertable commits',
      'original failure replay',
      'scoped re-review',
      ...(caseEntry.dimensions.securityPrivacy.status !== 'n/a' ? ['security retest'] : []),
      ...(caseEntry.dimensions.dataMigration.status !== 'n/a' ? ['data integrity verification'] : []),
      ...(caseEntry.dimensions.integrations.status !== 'n/a' ? ['integration contract replay'] : []),
    ],
  };
}

function buildGeneratedArtifacts(findings, options) {
  const sourceRegistry = buildSourceRegistry(findings, options);
  const cases = sourceRegistry.entries.map((entry, index) =>
    buildCaseForFinding(findings[index], entry.sourceId, index),
  );
  const generatedAt = new Date().toISOString();
  const riskRegister = {
    version: '1.0.0',
    generatedAt,
    generatedBy: 'cobolt-fix-readiness',
    risks: cases.map(summarizeRisk),
  };
  const remediationPlan = {
    version: '1.0.0',
    generatedAt,
    generatedBy: 'cobolt-fix-readiness',
    mode: options.mode,
    milestone: options.milestone || null,
    tasks: cases.map((caseEntry) => ({
      caseId: caseEntry.caseId,
      findingId: caseEntry.findingId,
      assignedAgent: caseEntry.assignedAgent,
      severity: caseEntry.severity,
      priority: caseEntry.priority,
      fixStrategy: caseEntry.dimensions.fixStrategy.detail,
      testPlan: caseEntry.dimensions.testPlan.detail,
      rollbackPlan: caseEntry.dimensions.rollbackPlan.detail,
      prerequisites: [
        'confirm source evidence',
        'validate at least one root-cause hypothesis',
        'capture or document reproduction path',
      ],
    })),
  };
  const validationPlan = {
    version: '1.0.0',
    generatedAt,
    generatedBy: 'cobolt-fix-readiness',
    cases: cases.map((caseEntry) => ({
      caseId: caseEntry.caseId,
      findingId: caseEntry.findingId,
      requiredChecks: verificationChecksFor(caseEntry),
      acceptance: [
        'original finding no longer reproduces',
        'regression test proves the fixed behavior',
        'scoped re-review confirms the finding is resolved',
        'fix-verdict exits successfully or records carry-forward accurately',
      ],
    })),
  };
  const sourceFingerprint = fileFingerprint(options.sourcePath);
  const sourceAgeMs = sourceFingerprint ? Date.parse(generatedAt) - Date.parse(sourceFingerprint.mtime) : null;
  const maxSourceAgeMs = Number.isFinite(options.maxSourceAgeMs) ? options.maxSourceAgeMs : DEFAULT_SOURCE_MAX_AGE_MS;
  const sourceStale = sourceAgeMs !== null && sourceAgeMs > maxSourceAgeMs;
  const sourceProofIssues = [];
  if (options.requireSourceProof && !sourceFingerprint) {
    sourceProofIssues.push('missing-source-fingerprint');
  }
  if (options.requireSourceProof && sourceStale) {
    sourceProofIssues.push('stale-source');
  }
  if (findings.length === 0 && options.requireSourceProof && !options.zeroCaseReason && !sourceFingerprint) {
    sourceProofIssues.push('missing-zero-case-reason');
  }
  const sourceProof = {
    version: '1.0.0',
    generatedAt,
    generatedBy: 'cobolt-fix-readiness',
    mode: options.mode,
    milestone: options.milestone || null,
    sourcePath: options.sourcePath || null,
    sourcePresent: Boolean(sourceFingerprint),
    sourceFingerprint,
    sourceAgeMs,
    maxSourceAgeMs,
    sourceStale,
    requireSourceProof: Boolean(options.requireSourceProof),
    proofStatus:
      sourceProofIssues.length > 0 ? 'fail' : !sourceFingerprint && findings.length === 0 ? 'waived' : 'pass',
    issues: sourceProofIssues,
    findingCount: findings.length,
    zeroCase: findings.length === 0,
    zeroCaseReason:
      findings.length === 0
        ? options.zeroCaseReason ||
          (options.sourcePath
            ? 'source file was present but contained no actionable findings'
            : 'no finding source was present and allow-empty was explicitly requested')
        : null,
    expectedSourceFiles: [
      '_cobolt-output/latest/review/review-findings.json',
      '_cobolt-output/latest/review/verified-findings.json',
      '_cobolt-output/latest/fix/finding-tracker.json',
    ],
    freshnessPolicy: 'zero-case success requires an explicit source fingerprint or allow-empty proof',
  };
  const blastRadius = {
    version: '1.0.0',
    generatedAt,
    generatedBy: 'cobolt-fix-readiness',
    mode: options.mode,
    milestone: options.milestone || null,
    cases: cases.map((caseEntry, index) => {
      const finding = findings[index] || {};
      const surfaces = impactedSurfaceFor(finding);
      return {
        caseId: caseEntry.caseId,
        findingId: caseEntry.findingId,
        severity: caseEntry.severity,
        priority: caseEntry.priority,
        seedFiles: surfaces.filter((surface) => surface.kind === 'file').map((surface) => surface.id),
        impactedSurfaces: surfaces,
        impactedRequirements: Array.isArray(finding.requirementIds) ? finding.requirementIds : [],
        verificationObligations: verificationChecksFor(caseEntry),
        releaseRisk: caseEntry.severity === 'critical' || caseEntry.severity === 'high' ? 'release-blocking' : 'scoped',
      };
    }),
  };
  const touchedSurfaceGates = {
    version: '1.0.0',
    generatedAt,
    generatedBy: 'cobolt-fix-readiness',
    status: findings.length === 0 ? 'not_applicable' : 'pending-changed-file-classification',
    changedFiles: [],
    surfaces: [],
    requiredChecks: [],
    missingEvidence: [],
    note: 'Run cobolt-fix-surface-gates.js after each fix iteration with the actual changed file set.',
  };
  const learningPacket = {
    version: '1.0.0',
    generatedAt,
    generatedBy: 'cobolt-fix-readiness',
    status: findings.length === 0 ? 'not_applicable' : 'pending-post-fix-update',
    memoryUpdateRequired: findings.length > 0,
    cases: cases.map((caseEntry) => ({
      caseId: caseEntry.caseId,
      findingId: caseEntry.findingId,
      rootCauseCategory: caseEntry.prefix,
      preventionAction: caseEntry.dimensions.rcaPrevention.detail,
      standardsFeedback: [],
      regressionBacklog: [],
    })),
  };
  const riskAcceptance = {
    version: '1.0.0',
    generatedAt,
    generatedBy: 'cobolt-fix-readiness',
    policy: {
      requiredFor:
        'unresolved critical/high security, compliance, supply-chain, data, authz, integration, or NFR findings before release',
      requiredFields: ['owner', 'expiry', 'scope', 'severity', 'compensatingControl', 'evidence', 'approvalSignature'],
    },
    acceptances: [],
    pending: cases
      .filter((caseEntry) => caseEntry.severity === 'critical' || caseEntry.severity === 'high')
      .map((caseEntry) => ({
        caseId: caseEntry.caseId,
        findingId: caseEntry.findingId,
        severity: caseEntry.severity,
        riskDomains: riskDomainFor(caseEntry),
        status: 'not-accepted',
      })),
  };
  const architectureMutationApproval = {
    version: '1.0.0',
    generatedAt,
    generatedBy: 'cobolt-fix-readiness',
    required: false,
    status: 'not_requested',
    gate: 'cobolt-arch-mutation-gate.js',
    proposalArtifact: '_cobolt-output/latest/fix/arch-mutation-proposal.md',
    approvalArtifact: 'arch-mutation-proposal.md frontmatter',
    note: 'Architecture mutation remains gated by cobolt-arch-propose.js apply plus two-agent quorum or human approval; this contract surfaces the decision for RCA/release evidence.',
  };
  const rollbackPlan = {
    version: '1.0.0',
    generatedAt,
    generatedBy: 'cobolt-fix-readiness',
    cases: cases.map((caseEntry) => ({
      caseId: caseEntry.caseId,
      findingId: caseEntry.findingId,
      strategy: caseEntry.dimensions.rollbackPlan.detail,
      rehearsalRequired:
        caseEntry.severity === 'critical' ||
        caseEntry.severity === 'high' ||
        caseEntry.dimensions.dataMigration.status !== 'n/a',
      rehearsalEvidence: null,
      noRollbackRationale: null,
    })),
  };
  const hotfixReleaseContract = {
    version: '1.0.0',
    generatedAt,
    generatedBy: 'cobolt-fix-readiness',
    required: options.mode === 'hotfix',
    status: options.mode === 'hotfix' ? 'pending' : 'not_applicable',
    incidentId: options.incidentId || null,
    minimumEvidence: [
      'approval',
      'minimal verification',
      'rollback',
      'communication',
      'deploy window',
      'post-deploy monitoring',
      'RCA deadline',
      'retrospective or dream update',
    ],
  };

  return {
    sourceRegistry,
    caseRegistry: {
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      generatedBy: 'cobolt-fix-readiness',
      mode: options.mode,
      milestone: options.milestone || null,
      cases,
    },
    riskRegister,
    remediationPlan,
    validationPlan,
    sourceProof,
    blastRadius,
    touchedSurfaceGates,
    learningPacket,
    riskAcceptance,
    architectureMutationApproval,
    rollbackPlan,
    hotfixReleaseContract,
  };
}

function writeGeneratedArtifacts(outputDir, artifacts) {
  fs.mkdirSync(outputDir, { recursive: true });
  writeJson(path.join(outputDir, 'fix-source-registry.json'), artifacts.sourceRegistry);
  writeJson(path.join(outputDir, 'fix-case-registry.json'), artifacts.caseRegistry);
  writeJson(path.join(outputDir, 'fix-risk-register.json'), artifacts.riskRegister);
  writeJson(path.join(outputDir, 'fix-remediation-plan.json'), artifacts.remediationPlan);
  writeJson(path.join(outputDir, 'fix-validation-plan.json'), artifacts.validationPlan);
  writeJson(path.join(outputDir, 'fix-source-proof.json'), artifacts.sourceProof);
  writeJson(path.join(outputDir, 'fix-blast-radius.json'), artifacts.blastRadius);
  writeJson(path.join(outputDir, 'fix-touched-surface-gates.json'), artifacts.touchedSurfaceGates);
  writeJson(path.join(outputDir, 'fix-learning-packet.json'), artifacts.learningPacket);
  writeJson(path.join(outputDir, 'risk-acceptance.json'), artifacts.riskAcceptance);
  writeJson(path.join(outputDir, 'architecture-mutation-approval.json'), artifacts.architectureMutationApproval);
  writeJson(path.join(outputDir, 'fix-rollback-plan.json'), artifacts.rollbackPlan);
  writeJson(path.join(outputDir, 'hotfix-release-contract.json'), artifacts.hotfixReleaseContract);
}

function writeZeroCaseRuntimeArtifacts(outputDir, options = {}) {
  const generatedAt = new Date().toISOString();
  const tracker = {
    version: '1.0.0',
    generatedAt,
    generatedBy: 'cobolt-fix-readiness',
    mode: options.mode || 'pipeline',
    milestone: options.milestone || null,
    status: 'no-findings',
    findings: [],
    summary: {
      total: 0,
      actionable: 0,
      criticalHigh: 0,
    },
  };
  const completeness = {
    version: '1.0.0',
    generatedAt,
    generatedBy: 'cobolt-fix-readiness',
    mode: options.mode || 'pipeline',
    milestone: options.milestone || null,
    status: 'no-findings',
    regressionTestResult: 'not_applicable',
    fixIntroducedRegressions: 0,
    completenessScore: 1,
    summary: {
      totalFindings: 0,
      resolved: 0,
      unresolvedCriticalHigh: 0,
    },
  };

  writeJson(path.join(outputDir, 'finding-tracker.json'), tracker);
  writeJson(path.join(outputDir, 'fix-completeness-report.json'), completeness);
  return { tracker, completeness };
}

function writeActiveRuntimeArtifacts(outputDir, findings, options = {}) {
  const generatedAt = new Date().toISOString();
  const criticalHigh = findings.filter((finding) => ['critical', 'high'].includes(finding.severity)).length;
  const tracker = {
    version: '1.0.0',
    generatedAt,
    generatedBy: 'cobolt-fix-readiness',
    mode: options.mode || 'pipeline',
    milestone: options.milestone || null,
    status: 'active',
    findings,
    summary: {
      total: findings.length,
      actionable: findings.length,
      criticalHigh,
    },
  };
  const completeness = {
    version: '1.0.0',
    generatedAt,
    generatedBy: 'cobolt-fix-readiness',
    mode: options.mode || 'pipeline',
    milestone: options.milestone || null,
    status: 'in-progress',
    regressionTestResult: 'pending',
    fixIntroducedRegressions: 0,
    completenessScore: 0,
    summary: {
      totalFindings: findings.length,
      resolved: 0,
      unresolvedCriticalHigh: criticalHigh,
    },
  };

  writeJson(path.join(outputDir, 'finding-tracker.json'), tracker);
  writeJson(path.join(outputDir, 'fix-completeness-report.json'), completeness);
  return { tracker, completeness };
}

function dimensionIssues(caseEntry) {
  const issues = [];
  for (const dimensionId of REQUIRED_DIMENSIONS) {
    const entry = caseEntry.dimensions?.[dimensionId];
    if (!entry) {
      issues.push({ dimension: dimensionId, type: 'missing-dimension' });
      continue;
    }
    const status = String(entry.status || '').toLowerCase();
    if (!status) {
      issues.push({ dimension: dimensionId, type: 'blank-status' });
    }
    if (!['covered', 'n/a'].includes(status)) {
      issues.push({ dimension: dimensionId, type: `invalid-status:${entry.status}` });
    }
    if (!String(entry.detail || '').trim()) {
      issues.push({ dimension: dimensionId, type: 'blank-detail' });
    }
    if (!EVIDENCE_LEVELS.has(entry.evidenceLevel)) {
      issues.push({ dimension: dimensionId, type: `invalid-evidence:${entry.evidenceLevel || 'blank'}` });
    } else if (!PROCEED_EVIDENCE_LEVELS.has(entry.evidenceLevel)) {
      issues.push({ dimension: dimensionId, type: `blocking-evidence:${entry.evidenceLevel}` });
    }
  }
  return issues;
}

function runCheck(outputDir, options = {}) {
  const caseRegistryPath = path.join(outputDir, 'fix-case-registry.json');
  const caseRegistry = readJson(caseRegistryPath);
  const cases = Array.isArray(caseRegistry?.cases) ? caseRegistry.cases : [];
  const matrix = [];
  const caseReports = [];

  for (const caseEntry of cases) {
    const issues = dimensionIssues(caseEntry);
    const status =
      issues.length === 0
        ? 'READY'
        : issues.some((issue) => issue.type.includes('blocking'))
          ? 'DRAFT_ONLY'
          : 'BLOCKED';
    caseReports.push({
      caseId: caseEntry.caseId,
      findingId: caseEntry.findingId,
      status,
      issues,
    });
    for (const dimensionId of REQUIRED_DIMENSIONS) {
      const entry = caseEntry.dimensions?.[dimensionId] || {};
      matrix.push({
        caseId: caseEntry.caseId,
        findingId: caseEntry.findingId,
        dimension: dimensionId,
        status: entry.status || 'blank',
        evidenceLevel: entry.evidenceLevel || 'blank',
        detailPresent: Boolean(String(entry.detail || '').trim()),
      });
    }
  }

  const missingCaseRegistry = !caseRegistry;
  const missingCases = cases.length === 0;
  const ready = caseReports.filter((entry) => entry.status === 'READY').length;
  const blocked = caseReports.filter((entry) => entry.status === 'BLOCKED').length;
  const draftOnly = caseReports.filter((entry) => entry.status === 'DRAFT_ONLY').length;
  const zeroCase = !missingCaseRegistry && missingCases && options.allowEmpty === true;
  const contractChecks = REQUIRED_FIX_CONTRACTS.map((fileName) => ({
    fileName,
    present: fs.existsSync(path.join(outputDir, fileName)),
  }));
  const missingContracts = contractChecks.filter((entry) => !entry.present).map((entry) => entry.fileName);
  const sourceProof = readJson(path.join(outputDir, 'fix-source-proof.json'));
  const sourceProofIssues = [];
  if (!sourceProof) {
    sourceProofIssues.push('missing-fix-source-proof');
  } else {
    if (sourceProof.proofStatus === 'fail') sourceProofIssues.push(...(sourceProof.issues || ['source-proof-failed']));
    if (options.requireSourceProof && sourceProof.proofStatus !== 'pass') {
      sourceProofIssues.push(`source-proof-not-pass:${sourceProof.proofStatus || 'blank'}`);
    }
  }
  const passed =
    !missingCaseRegistry &&
    (zeroCase || !missingCases) &&
    blocked === 0 &&
    draftOnly === 0 &&
    ready === cases.length &&
    missingContracts.length === 0 &&
    sourceProofIssues.length === 0;
  const report = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-fix-readiness',
    passed,
    zeroCase,
    summary: {
      totalCases: cases.length,
      ready,
      blocked,
      draftOnly,
      matrixCells: matrix.length,
      missingCaseRegistry,
      missingCases,
      missingContracts,
      sourceProofStatus: sourceProof?.proofStatus || 'missing',
      sourceProofIssues,
    },
    contracts: contractChecks,
    cases: caseReports,
  };

  const matrixPayload = {
    version: '1.0.0',
    generatedAt: report.generatedAt,
    generatedBy: 'cobolt-fix-readiness',
    requiredDimensions: REQUIRED_DIMENSIONS,
    rows: matrix,
  };

  writeJson(path.join(outputDir, 'fix-readiness-report.json'), report);
  writeJson(path.join(outputDir, 'fix-coverage-matrix.json'), matrixPayload);
  const fidelity = buildFixResolutionFidelity(outputDir, {
    milestone: options.milestone || caseRegistry?.milestone || sourceProof?.milestone || null,
    projectRoot: inferProjectRoot(outputDir, options),
    readiness: report,
  });
  return { report, matrix: matrixPayload, fidelity: fidelity.fidelity };
}

function runInit(options) {
  const sourcePath = options.sourcePath || detectDefaultSourcePath(options.outputDir);
  if (!sourcePath) {
    if (!options.allowEmpty) {
      throw new Error('No finding source found. Provide --source or create review-findings.json/finding-tracker.json.');
    }
    const artifacts = buildGeneratedArtifacts([], { ...options, sourcePath: null });
    writeGeneratedArtifacts(options.outputDir, artifacts);
    const { report, matrix } = runCheck(options.outputDir, {
      allowEmpty: true,
      requireSourceProof: options.requireSourceProof,
      sourcePath: options.sourcePath,
      milestone: options.milestone,
    });
    writeZeroCaseRuntimeArtifacts(options.outputDir, options);
    const fidelity = buildFixResolutionFidelity(options.outputDir, {
      milestone: options.milestone,
      projectRoot: inferProjectRoot(options.outputDir, options),
      readiness: report,
    });
    return { ...artifacts, report, matrix, fidelity: fidelity.fidelity };
  }
  const payload = readJson(sourcePath);
  if (!payload) {
    if (!options.allowEmpty) {
      throw new Error(`Finding source not found or unreadable: ${sourcePath}`);
    }
    const artifacts = buildGeneratedArtifacts([], { ...options, sourcePath });
    writeGeneratedArtifacts(options.outputDir, artifacts);
    const { report, matrix } = runCheck(options.outputDir, {
      allowEmpty: true,
      requireSourceProof: options.requireSourceProof,
      sourcePath: sourcePath,
      milestone: options.milestone,
    });
    writeZeroCaseRuntimeArtifacts(options.outputDir, options);
    const fidelity = buildFixResolutionFidelity(options.outputDir, {
      milestone: options.milestone,
      projectRoot: inferProjectRoot(options.outputDir, { ...options, sourcePath }),
      readiness: report,
    });
    return { ...artifacts, report, matrix, fidelity: fidelity.fidelity };
  }
  const findings = normalizeFindings(payload);
  if (findings.length === 0) {
    if (!options.allowEmpty) {
      throw new Error(`No actionable findings found in ${sourcePath}`);
    }
  }

  const artifacts = buildGeneratedArtifacts(findings, { ...options, sourcePath });
  writeGeneratedArtifacts(options.outputDir, artifacts);
  if (findings.length > 0) {
    writeActiveRuntimeArtifacts(options.outputDir, findings, options);
  }
  const { report, matrix } = runCheck(options.outputDir, {
    allowEmpty: options.allowEmpty,
    requireSourceProof: options.requireSourceProof,
    sourcePath: sourcePath,
    milestone: options.milestone,
  });
  if (options.allowEmpty && findings.length === 0) {
    writeZeroCaseRuntimeArtifacts(options.outputDir, options);
  }
  const fidelity = buildFixResolutionFidelity(options.outputDir, {
    milestone: options.milestone,
    projectRoot: inferProjectRoot(options.outputDir, { ...options, sourcePath }),
    readiness: report,
  });
  return { ...artifacts, report, matrix, fidelity: fidelity.fidelity };
}

function printUsage() {
  console.log(`
CoBolt Fix Readiness

Usage:
  node tools/cobolt-fix-readiness.js init [--source <file>] [--output-dir <dir>] [--mode pipeline|standalone|hotfix] [--milestone M1] [--incident-id INC-1] [--require-source-proof] [--max-source-age-ms <n>] [--zero-case-reason <text>] [--allow-empty] [--json]
  node tools/cobolt-fix-readiness.js check [--output-dir <dir>] [--require-source-proof] [--allow-empty] [--json]
`);
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = parseArgs(args);
  try {
    if (command === 'init') {
      const result = runInit(options);
      if (options.jsonMode) {
        console.log(JSON.stringify(result.report, null, 2));
      } else {
        console.log(
          `[cobolt-fix-readiness] ${result.report.summary.ready}/${result.report.summary.totalCases} fix case(s) ready`,
        );
      }
      process.exit(result.report.passed ? 0 : 1);
    }
    if (command === 'check') {
      const result = runCheck(options.outputDir, { allowEmpty: options.allowEmpty });
      if (options.jsonMode) {
        console.log(JSON.stringify(result.report, null, 2));
      } else {
        console.log(
          `[cobolt-fix-readiness] ${result.report.summary.ready}/${result.report.summary.totalCases} fix case(s) ready`,
        );
      }
      process.exit(result.report.passed ? 0 : 1);
    }
    printUsage();
    process.exit(command ? 2 : 0);
  } catch (error) {
    if (options.jsonMode) {
      console.log(
        JSON.stringify(
          {
            passed: false,
            error: error.message,
            generatedBy: 'cobolt-fix-readiness',
          },
          null,
          2,
        ),
      );
    } else {
      console.error(`[cobolt-fix-readiness] ${error.message}`);
    }
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  ACTIONABLE_STATUSES,
  DEFAULT_SOURCE_MAX_AGE_MS,
  EVIDENCE_LEVELS,
  PROCEED_EVIDENCE_LEVELS,
  REQUIRED_FIX_CONTRACTS,
  REQUIRED_DIMENSIONS,
  buildGeneratedArtifacts,
  buildSourceRegistry,
  dimensionIssues,
  normalizeFindings,
  runCheck,
  runInit,
  verificationChecksFor,
  writeActiveRuntimeArtifacts,
  writeZeroCaseRuntimeArtifacts,
};
