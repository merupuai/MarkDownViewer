#!/usr/bin/env node

// Deterministic Plan quality-amplifier artifact generator/checker.
//
// This tool turns the canonical planning packet into first-class build inputs:
// product quality scoring, UX state coverage, acceptance examples, test data,
// observability, performance/accessibility budgets, runtime operations, abuse
// cases, architecture fitness checks, and the launch quality gate.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJSON } = require('../lib/cobolt-atomic-write');
const { resolveReadablePlanningDir, safeReadJson } = require('../lib/cobolt-planning-artifacts');

const QUALITY_ARTIFACTS = Object.freeze([
  {
    id: 'product-quality-scorecard',
    title: 'Product Quality Scorecard',
    file: 'quality/product-quality-scorecard.json',
  },
  {
    id: 'ux-state-matrix',
    title: 'UX State Matrix',
    file: 'quality/ux-state-matrix.json',
  },
  {
    id: 'acceptance-example-pack',
    title: 'Acceptance Example Pack',
    file: 'quality/acceptance-example-pack.json',
  },
  {
    id: 'test-data-fixture-plan',
    title: 'Test Data and Fixture Plan',
    file: 'quality/test-data-fixture-plan.json',
  },
  {
    id: 'observability-contract',
    title: 'Observability Contract',
    file: 'quality/observability-contract.json',
  },
  {
    id: 'performance-accessibility-budgets',
    title: 'Performance and Accessibility Budgets',
    file: 'quality/performance-accessibility-budgets.json',
  },
  {
    id: 'runtime-operations-pack',
    title: 'Runtime Operations Pack',
    file: 'quality/runtime-operations-pack.json',
  },
  {
    id: 'security-abuse-case-pack',
    title: 'Security Abuse-Case Pack',
    file: 'quality/security-abuse-case-pack.json',
  },
  {
    id: 'architecture-fitness-checks',
    title: 'Architecture Fitness Checks',
    file: 'quality/architecture-fitness-checks.json',
  },
  {
    id: 'launch-quality-gate',
    title: 'Launch Quality Gate',
    file: 'quality/launch-quality-gate.json',
  },
]);

const QUALITY_BY_ID = new Map(QUALITY_ARTIFACTS.map((artifact) => [artifact.id, artifact]));

const SOURCE_FILES = Object.freeze([
  { key: 'prd', file: 'prd.md', required: true },
  { key: 'rtm', file: 'rtm.json', required: true, json: true },
  { key: 'featureRegistry', file: 'feature-registry.json', json: true },
  { key: 'executablePrd', file: 'executable-prd.json', json: true },
  { key: 'trd', file: 'trd.md', required: true },
  { key: 'securityRequirements', file: 'security-requirements.md', required: true },
  { key: 'secureCoding', file: 'secure-coding-standard.md' },
  { key: 'engineeringStandards', file: 'engineering-quality-standards.md', required: true },
  { key: 'architecture', file: 'architecture.md', required: true },
  { key: 'systemArchitecture', file: 'system-architecture.md' },
  { key: 'dataModel', file: 'data-model-spec.md' },
  { key: 'apiContracts', file: 'api-contracts.md' },
  { key: 'eventSchemas', file: 'event-schemas.md' },
  { key: 'uxDesign', file: 'ux-design-specification.md' },
  { key: 'wireframes', file: 'wireframes-and-user-flows.md' },
  { key: 'deliveryPlan', file: 'delivery-plan.md', required: true },
  { key: 'testStrategy', file: 'test-strategy.md', required: true },
  { key: 'deterministicGates', file: 'deterministic-quality-gates.json', json: true },
  { key: 'releaseReadiness', file: 'release-readiness-checklist.md', required: true },
  { key: 'readinessReport', file: 'readiness-report.json', json: true },
  { key: 'milestones', file: 'milestones.md', required: true },
  { key: 'epics', file: 'epics.md', required: true },
  { key: 'sourceCoverage', file: 'source-coverage-report.json', json: true },
  { key: 'capabilityContracts', file: 'capability-contracts-index.json', json: true },
]);

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/');
}

function sha256File(filePath) {
  try {
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
  } catch {
    return null;
  }
}

function resolvePlanningDir(projectRoot, options = {}) {
  const root = path.resolve(projectRoot || process.cwd());
  const planningDir = resolveReadablePlanningDir(root, { allowLatestFallback: options.create === true });
  if (planningDir && options.create === true) {
    fs.mkdirSync(planningDir, { recursive: true, mode: 0o700 });
  }
  return planningDir;
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function readJson(filePath) {
  return safeReadJson(filePath);
}

function readSource(planningDir, spec) {
  const absolutePath = path.join(planningDir, spec.file);
  const exists = fs.existsSync(absolutePath);
  const stat = exists ? fs.statSync(absolutePath) : null;
  return {
    key: spec.key,
    file: spec.file,
    path: absolutePath,
    exists,
    required: spec.required === true,
    json: spec.json === true,
    bytes: stat?.size || 0,
    sha256: exists ? sha256File(absolutePath) : null,
    text: exists && spec.json !== true ? readText(absolutePath) : '',
    jsonData: exists && spec.json === true ? readJson(absolutePath) : null,
  };
}

function collectInputs(planningDir) {
  const sources = SOURCE_FILES.map((spec) => readSource(planningDir, spec));
  const evidence = sources.map((source) => ({
    key: source.key,
    path: toPosix(path.relative(planningDir, source.path)),
    exists: source.exists,
    required: source.required,
    bytes: source.bytes,
    sha256: source.sha256,
  }));
  const byKey = new Map(sources.map((source) => [source.key, source]));
  const missingRequired = evidence.filter((entry) => entry.required && !entry.exists).map((entry) => entry.path);

  return { sources, byKey, evidence, missingRequired };
}

function titleFrom(value, fallback) {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeRequirement(raw, index = 0, source = 'unknown') {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || raw.requirementId || raw.reqId || raw.key || raw.fr || raw.code || '').trim();
  if (!id) return null;
  const normalizedId = id.toUpperCase().replace(/^FR(\d)/, 'FR-$1');
  return {
    id: normalizedId,
    title: titleFrom(raw.title || raw.name || raw.summary || raw.description, `${normalizedId} acceptance contract`),
    source,
    index,
    featureId: raw.featureId || raw.feature || raw.capability || null,
    milestone: raw.milestone || raw.milestoneId || raw.release || null,
    priority: raw.priority || raw.mustShouldCould || raw.moscow || 'required',
  };
}

function requirementsFromRtm(rtm) {
  if (!rtm || typeof rtm !== 'object') return [];
  const candidates = [];
  if (Array.isArray(rtm.requirements)) candidates.push(...rtm.requirements);
  if (Array.isArray(rtm.items)) candidates.push(...rtm.items);
  if (Array.isArray(rtm.traces)) candidates.push(...rtm.traces);
  if (rtm.requirements && typeof rtm.requirements === 'object' && !Array.isArray(rtm.requirements)) {
    for (const [id, value] of Object.entries(rtm.requirements)) {
      candidates.push(typeof value === 'object' && value ? { id, ...value } : { id, title: String(value || id) });
    }
  }
  if (rtm.matrix && typeof rtm.matrix === 'object') {
    for (const [id, value] of Object.entries(rtm.matrix)) {
      candidates.push(typeof value === 'object' && value ? { id, ...value } : { id });
    }
  }
  return candidates.map((item, index) => normalizeRequirement(item, index, 'rtm.json')).filter(Boolean);
}

function requirementsFromExecutablePrd(executablePrd) {
  if (!executablePrd || typeof executablePrd !== 'object') return [];
  const candidates = [];
  for (const key of ['requirements', 'functionalRequirements', 'frs', 'features']) {
    if (Array.isArray(executablePrd[key])) candidates.push(...executablePrd[key]);
  }
  return candidates.map((item, index) => normalizeRequirement(item, index, 'executable-prd.json')).filter(Boolean);
}

function requirementsFromText(text) {
  const requirements = [];
  const seen = new Set();
  const rx = /\bFR-?(\d{1,5})\b(?::|\s+-|\s+--)?\s*([^\r\n]{0,160})/gi;
  for (const match of String(text || '').matchAll(rx)) {
    const id = `FR-${String(parseInt(match[1], 10)).padStart(3, '0')}`;
    if (seen.has(id)) continue;
    seen.add(id);
    requirements.push({
      id,
      title: titleFrom(match[2], `${id} acceptance contract`),
      source: 'prd.md',
      index: requirements.length,
      featureId: null,
      milestone: null,
      priority: 'required',
    });
  }
  return requirements;
}

function extractRequirements(inputs) {
  const byId = new Map();
  for (const req of [
    ...requirementsFromRtm(inputs.byKey.get('rtm')?.jsonData),
    ...requirementsFromExecutablePrd(inputs.byKey.get('executablePrd')?.jsonData),
    ...requirementsFromText(inputs.byKey.get('prd')?.text),
  ]) {
    if (!byId.has(req.id)) byId.set(req.id, req);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

function extractFeatures(inputs, requirements) {
  const registry = inputs.byKey.get('featureRegistry')?.jsonData;
  const candidates = [];
  if (Array.isArray(registry?.features)) candidates.push(...registry.features);
  if (Array.isArray(registry?.items)) candidates.push(...registry.items);
  if (registry?.features && typeof registry.features === 'object' && !Array.isArray(registry.features)) {
    for (const [id, value] of Object.entries(registry.features)) {
      candidates.push(typeof value === 'object' && value ? { id, ...value } : { id, title: String(value || id) });
    }
  }
  const features = candidates
    .map((item, index) => ({
      id: String(item.id || item.featureId || item.key || `FEAT-${String(index + 1).padStart(3, '0')}`).trim(),
      title: titleFrom(item.title || item.name || item.summary || item.description, `Feature ${index + 1}`),
      requirementIds: Array.isArray(item.requirementIds)
        ? item.requirementIds
        : Array.isArray(item.requirements)
          ? item.requirements.map((req) => (typeof req === 'string' ? req : req.id)).filter(Boolean)
          : [],
      evidenceLevel: item.evidenceLevel || item.confidence || 'source-backed',
    }))
    .filter((feature) => feature.id);

  if (features.length > 0) return features;

  return requirements.map((req, index) => ({
    id: req.featureId || `FEAT-${String(index + 1).padStart(3, '0')}`,
    title: req.title,
    requirementIds: [req.id],
    evidenceLevel: 'derived-from-requirement',
  }));
}

function hasSource(inputs, key) {
  return inputs.byKey.get(key)?.exists === true;
}

function detectUiScope(inputs, features) {
  if (hasSource(inputs, 'uxDesign') || hasSource(inputs, 'wireframes')) return true;
  const combined = [
    inputs.byKey.get('prd')?.text,
    inputs.byKey.get('epics')?.text,
    ...features.map((feature) => `${feature.id} ${feature.title}`),
  ].join('\n');
  return /\b(ui|ux|screen|page|form|button|dashboard|mobile|responsive|accessib|wcag|keyboard|focus)\b/i.test(combined);
}

function blockersFor(inputs, requirements) {
  const blockers = inputs.missingRequired.map((file) => ({
    code: 'MISSING_REQUIRED_INPUT',
    message: `Required planning input is missing: ${file}`,
  }));
  if (requirements.length === 0) {
    blockers.push({
      code: 'NO_REQUIREMENTS',
      message: 'No FR requirements found in rtm.json, executable-prd.json, or prd.md',
    });
  }
  return blockers;
}

function baseArtifact(artifactId, inputs, requirements, extra = {}) {
  const artifact = QUALITY_BY_ID.get(artifactId);
  const blockers = extra.blockers || blockersFor(inputs, requirements);
  return {
    version: 1,
    artifactId,
    title: artifact?.title || artifactId,
    generatedAt: new Date().toISOString(),
    generator: 'cobolt-plan-quality-artifacts',
    status: blockers.length === 0 ? 'pass' : 'fail',
    blockers,
    sourceEvidence: inputs.evidence,
    requirementCount: requirements.length,
    ...extra,
  };
}

function statusFor(keys, inputs) {
  const missing = keys.filter((key) => !hasSource(inputs, key));
  return {
    status: missing.length === 0 ? 'pass' : 'fail',
    missingInputs: missing,
  };
}

function buildProductQualityScorecard(inputs, requirements) {
  const categoryDefs = [
    ['functional-fit', 'Functional fit', ['prd', 'rtm', 'featureRegistry']],
    ['ux-completeness', 'UX completeness', ['uxDesign', 'wireframes']],
    ['acceptance-depth', 'Acceptance depth', ['testStrategy', 'rtm']],
    ['testability', 'Testability', ['testStrategy', 'deterministicGates']],
    ['security', 'Security posture', ['securityRequirements', 'secureCoding']],
    ['performance', 'Performance posture', ['trd', 'testStrategy']],
    ['reliability', 'Reliability posture', ['trd', 'deliveryPlan']],
    ['observability', 'Observability posture', ['trd', 'deliveryPlan']],
    ['operability', 'Runtime operability', ['deliveryPlan', 'releaseReadiness']],
    ['launch-readiness', 'Launch readiness', ['readinessReport', 'releaseReadiness']],
  ];
  const categories = categoryDefs.map(([id, label, keys]) => {
    const result = statusFor(keys, inputs);
    return {
      id,
      label,
      status: result.status,
      score: result.status === 'pass' ? 10 : Math.max(0, 10 - result.missingInputs.length * 4),
      requiredInputs: keys,
      missingInputs: result.missingInputs,
      criteria: [
        `${label} has source-backed requirements, implementation expectations, and verification evidence.`,
        `${label} can be checked by build/review gates without relying on prompt-only claims.`,
      ],
    };
  });
  const score = Math.round(
    (categories.reduce((sum, category) => sum + category.score, 0) / (categories.length * 10)) * 100,
  );
  return baseArtifact('product-quality-scorecard', inputs, requirements, {
    score,
    threshold: 85,
    categories,
    requiredRemediation: categories
      .filter((category) => category.status !== 'pass')
      .map((category) => ({ category: category.id, missingInputs: category.missingInputs })),
  });
}

function buildUxStateMatrix(inputs, requirements, features) {
  const uiScope = detectUiScope(inputs, features);
  const states = [
    'empty',
    'loading',
    'success',
    'error',
    'permissionDenied',
    'offline',
    'largeDataset',
    'mobile',
    'keyboardFocus',
  ];
  const rows = features.map((feature) => {
    const requirementIds =
      feature.requirementIds.length > 0
        ? feature.requirementIds
        : requirements.filter((req) => req.featureId === feature.id).map((req) => req.id);
    return {
      featureId: feature.id,
      featureTitle: feature.title,
      requirementIds,
      states: states.map((stateName) => ({
        state: stateName,
        expectedHandling: uiScope
          ? `${feature.id} must define ${stateName} UI behavior, copy, interaction affordance, and test coverage.`
          : `${feature.id} has no UI surface; service/client contract must still define ${stateName} handling semantics.`,
        evidenceRequired: uiScope
          ? ['ux-design-specification.md', 'wireframes-and-user-flows.md', 'story spec acceptance checks']
          : ['api-contracts.md', 'test-strategy.md', 'story spec acceptance checks'],
      })),
    };
  });
  return baseArtifact('ux-state-matrix', inputs, requirements, {
    uiScope,
    rows,
    stateCount: states.length,
    notApplicable: !uiScope,
  });
}

function buildAcceptanceExamplePack(inputs, requirements) {
  const examples = requirements.map((req) => ({
    requirementId: req.id,
    title: req.title,
    examples: [
      {
        id: `${req.id}-HAPPY`,
        type: 'happy-path',
        given: `A valid actor has the required permission and valid data for ${req.id}.`,
        when: `The actor performs the primary ${req.title} workflow.`,
        expectedThen:
          'The system completes the workflow, persists/audits the expected state, and exposes the success evidence.',
      },
      {
        id: `${req.id}-NEGATIVE`,
        type: 'negative-path',
        given: `An actor lacks permission, submits invalid input, or triggers an upstream failure for ${req.id}.`,
        when: `The actor attempts the ${req.title} workflow.`,
        expectedThen:
          'The system rejects the action with a typed error, no partial unsafe side effects, and observable failure evidence.',
      },
      {
        id: `${req.id}-EDGE`,
        type: 'edge-path',
        given: `The ${req.id} workflow runs at boundary conditions such as empty data, duplicate requests, retries, or large inputs.`,
        when: `The actor repeats or stresses the ${req.title} workflow.`,
        expectedThen: 'The system remains idempotent, bounded, accessible, and traceable.',
      },
    ],
  }));
  return baseArtifact('acceptance-example-pack', inputs, requirements, {
    examples,
    exampleCount: examples.reduce((sum, entry) => sum + entry.examples.length, 0),
  });
}

function buildTestDataFixturePlan(inputs, requirements) {
  const fixtureTypes = [
    'baseline',
    'edge-boundary',
    'permission-denied',
    'upstream-failure',
    'migration-compatibility',
  ];
  const fixtures = requirements.flatMap((req) =>
    fixtureTypes.map((type) => ({
      id: `${req.id}-${type}`.toUpperCase(),
      requirementId: req.id,
      type,
      seedName: `${req.id.toLowerCase()}-${type}.fixture`,
      deterministic: true,
      dataContract: 'Fixture must be valid against API/data model contracts and contain no real personal data.',
      resetRule: 'Fixture setup and teardown must be idempotent per test run.',
    })),
  );
  return baseArtifact('test-data-fixture-plan', inputs, requirements, {
    fixtureTypes,
    fixtures,
    seedPolicy: {
      deterministicSeedsOnly: true,
      noProductionData: true,
      teardownRequired: true,
      piiHandling: 'Synthetic or anonymized values only; regulated data classes must be explicitly labeled.',
    },
  });
}

function buildObservabilityContract(inputs, requirements, features) {
  const featureContracts = features.map((feature) => ({
    featureId: feature.id,
    logs: [
      { event: `${feature.id}.started`, level: 'info', requiredFields: ['requestId', 'actorId', 'featureId'] },
      { event: `${feature.id}.failed`, level: 'error', requiredFields: ['requestId', 'errorType', 'upstreamRef'] },
    ],
    metrics: [
      {
        name: `${feature.id.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_latency_ms`,
        type: 'histogram',
        budget: 'p95 <= plan budget',
      },
      {
        name: `${feature.id.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_error_total`,
        type: 'counter',
        budget: 'alert on sustained increase',
      },
    ],
    traces: [{ span: feature.id, requiredAttributes: ['request.id', 'actor.role', 'feature.id'] }],
    alerts: [{ name: `${feature.id} failure-rate`, condition: 'error rate breaches SLO for two consecutive windows' }],
    dashboards: [
      { name: `${feature.id} health`, panels: ['latency', 'errors', 'throughput', 'dependency saturation'] },
    ],
  }));
  return baseArtifact('observability-contract', inputs, requirements, {
    featureContracts,
    requiredCorrelationFields: ['requestId', 'traceId', 'actorId', 'featureId', 'requirementId'],
    failureRecordLinkage:
      'Failures must include typed error, stack/state/input/upstream refs, attempted fixes, and next action.',
  });
}

function buildPerformanceAccessibilityBudgets(inputs, requirements) {
  return baseArtifact('performance-accessibility-budgets', inputs, requirements, {
    performanceBudgets: [
      {
        surface: 'api',
        metric: 'p95 latency',
        budget: '<= 500ms unless TRD sets a stricter value',
        gate: 'integration/perf smoke',
      },
      {
        surface: 'api',
        metric: 'p99 latency',
        budget: '<= 1000ms unless TRD sets a stricter value',
        gate: 'load/perf smoke',
      },
      {
        surface: 'database',
        metric: 'critical query latency',
        budget: '<= 100ms p95 for primary read paths',
        gate: 'query plan review',
      },
      { surface: 'frontend', metric: 'LCP', budget: '<= 2.5s on target profile', gate: 'browser evidence' },
      { surface: 'frontend', metric: 'interaction latency', budget: '<= 200ms p95', gate: 'browser evidence' },
      {
        surface: 'frontend',
        metric: 'initial bundle',
        budget: '<= 250KB gzip per route without explicit waiver',
        gate: 'bundle analysis',
      },
    ],
    accessibilityBudgets: [
      { standard: 'WCAG', level: '2.2 AA', gate: 'a11y scan and keyboard walkthrough' },
      { standard: 'contrast', level: 'AA or better for text/icons conveying meaning', gate: 'contrast checker' },
      {
        standard: 'keyboard',
        level: 'all interactive controls reachable and visible focus shown',
        gate: 'keyboard walkthrough',
      },
      {
        standard: 'screen-reader',
        level: 'semantic names, roles, live regions for async states',
        gate: 'assistive tech review',
      },
    ],
  });
}

function buildRuntimeOperationsPack(inputs, requirements) {
  const runbooks = [
    'startup-and-smoke',
    'rollback',
    'dependency-outage',
    'data-backup-restore',
    'incident-triage',
    'degraded-mode',
    'secret-rotation',
  ].map((id) => ({
    id,
    owner: 'release lead',
    requiredInputs: ['delivery-plan.md', 'release-readiness-checklist.md', 'trd.md'],
    minimumSections: ['trigger', 'diagnostics', 'operator steps', 'rollback or containment', 'success verification'],
  }));
  return baseArtifact('runtime-operations-pack', inputs, requirements, {
    runbooks,
    operationalSloInputs: ['availability', 'latency', 'error rate', 'backup recovery point', 'backup recovery time'],
    releaseControls: ['feature flags', 'canary or staged rollout', 'rollback command', 'post-deploy verification'],
  });
}

function buildSecurityAbuseCasePack(inputs, requirements) {
  const abuseTypes = [
    'authorization-bypass',
    'injection',
    'sensitive-data-exposure',
    'rate-limit-or-resource-exhaustion',
    'csrf-or-session-abuse',
    'tenant-isolation-break',
    'supply-chain-or-config-tampering',
  ];
  const cases = requirements.flatMap((req) =>
    abuseTypes.map((type) => ({
      id: `${req.id}-${type}`.toUpperCase(),
      requirementId: req.id,
      abuseCase: type,
      attackerGoal: `Violate ${req.id} by exploiting ${type}.`,
      expectedDefense:
        'Prevent or contain the abuse with explicit validation, authorization, audit, and typed error behavior.',
      acceptanceEvidence: ['security-requirements.md', 'secure-coding-standard.md', 'negative test or review finding'],
    })),
  );
  return baseArtifact('security-abuse-case-pack', inputs, requirements, {
    abuseTypes,
    cases,
    minimumEvidence: ['authz matrix where applicable', 'negative acceptance tests', 'audit log expectations'],
  });
}

function buildArchitectureFitnessChecks(inputs, requirements) {
  const checks = [
    [
      'bounded-context-integrity',
      'Every requirement maps to an owning bounded context or explicit single-context rationale.',
    ],
    [
      'api-contract-integrity',
      'Every external call surface has request, response, auth, error, timeout, and idempotency semantics.',
    ],
    ['data-contract-integrity', 'Every persisted entity has lifecycle, migration, retention, and privacy posture.'],
    [
      'event-contract-integrity',
      'Events/webhooks declare producer, consumer, schema, versioning, ordering, and retry behavior or N/A.',
    ],
    [
      'security-boundary-integrity',
      'Authn/authz, tenancy, secrets, audit, and data classes are explicit at each boundary.',
    ],
    [
      'failure-mode-integrity',
      'Retries, fallbacks, degraded modes, terminal errors, and escalation routes are bounded.',
    ],
    [
      'observability-integrity',
      'Logs, metrics, traces, dashboards, and alerts are linked to requirements and runbooks.',
    ],
    [
      'dependency-integrity',
      'External dependency contracts include owner, SLA, failure mode, and replacement/rollback path.',
    ],
  ].map(([id, rule]) => ({
    id,
    rule,
    requiredInputs: [
      'architecture.md',
      'system-architecture.md',
      'api-contracts.md',
      'data-model-spec.md',
      'delivery-plan.md',
    ],
    status: 'defined',
  }));
  return baseArtifact('architecture-fitness-checks', inputs, requirements, {
    checks,
    enforcementStage: 'planning finalizer, build preflight, review gate',
  });
}

function buildLaunchQualityGate(inputs, requirements, generated) {
  const artifactChecks = QUALITY_ARTIFACTS.filter((artifact) => artifact.id !== 'launch-quality-gate').map(
    (artifact) => {
      const document = generated[artifact.id];
      return {
        artifactId: artifact.id,
        path: artifact.file,
        status: document?.status === 'pass' ? 'pass' : 'fail',
        blockers: document?.blockers || [{ code: 'NOT_GENERATED', message: `${artifact.id} was not generated` }],
      };
    },
  );
  const externalChecks = [
    { id: 'readiness-report', required: true, status: hasSource(inputs, 'readinessReport') ? 'available' : 'missing' },
    {
      id: 'release-readiness',
      required: true,
      status: hasSource(inputs, 'releaseReadiness') ? 'available' : 'missing',
    },
    {
      id: 'deterministic-quality-gates',
      required: false,
      status: hasSource(inputs, 'deterministicGates') ? 'available' : 'missing',
    },
  ];
  const blockers = [
    ...blockersFor(inputs, requirements),
    ...artifactChecks
      .filter((check) => check.status !== 'pass')
      .flatMap((check) => check.blockers.map((blocker) => ({ ...blocker, artifactId: check.artifactId }))),
    ...externalChecks
      .filter((check) => check.required && check.status !== 'available')
      .map((check) => ({ code: 'MISSING_EXTERNAL_GATE_INPUT', message: `${check.id} is missing` })),
  ];
  return baseArtifact('launch-quality-gate', inputs, requirements, {
    blockers,
    artifactChecks,
    externalChecks,
    terminalCondition:
      'Build authorization requires every quality artifact to pass and every required external launch input to be available.',
  });
}

function buildArtifacts(inputs, requirements, features) {
  const generated = {};
  generated['product-quality-scorecard'] = buildProductQualityScorecard(inputs, requirements);
  generated['ux-state-matrix'] = buildUxStateMatrix(inputs, requirements, features);
  generated['acceptance-example-pack'] = buildAcceptanceExamplePack(inputs, requirements);
  generated['test-data-fixture-plan'] = buildTestDataFixturePlan(inputs, requirements);
  generated['observability-contract'] = buildObservabilityContract(inputs, requirements, features);
  generated['performance-accessibility-budgets'] = buildPerformanceAccessibilityBudgets(inputs, requirements);
  generated['runtime-operations-pack'] = buildRuntimeOperationsPack(inputs, requirements);
  generated['security-abuse-case-pack'] = buildSecurityAbuseCasePack(inputs, requirements);
  generated['architecture-fitness-checks'] = buildArchitectureFitnessChecks(inputs, requirements);
  generated['launch-quality-gate'] = buildLaunchQualityGate(inputs, requirements, generated);
  return generated;
}

function artifactPath(planningDir, artifact) {
  return path.join(planningDir, artifact.file);
}

function validateArtifactShape(artifactId, document) {
  if (!document || typeof document !== 'object') return 'not valid JSON object';
  if (document.version !== 1) return 'version must be 1';
  if (document.artifactId !== artifactId) return `artifactId must be ${artifactId}`;
  if (document.status !== 'pass') {
    const blockerCount = Array.isArray(document.blockers) ? document.blockers.length : 0;
    return `status=${document.status || 'missing'} blockers=${blockerCount}`;
  }
  if (!Array.isArray(document.sourceEvidence) || document.sourceEvidence.length === 0) return 'sourceEvidence missing';
  if (typeof document.requirementCount !== 'number' || document.requirementCount < 1) return 'requirementCount missing';

  const checks = {
    'product-quality-scorecard': () => Array.isArray(document.categories) && document.categories.length >= 8,
    'ux-state-matrix': () => Array.isArray(document.rows) && typeof document.uiScope === 'boolean',
    'acceptance-example-pack': () =>
      Array.isArray(document.examples) && document.exampleCount >= document.requirementCount,
    'test-data-fixture-plan': () =>
      Array.isArray(document.fixtures) && document.fixtures.length >= document.requirementCount,
    'observability-contract': () => Array.isArray(document.featureContracts) && document.featureContracts.length > 0,
    'performance-accessibility-budgets': () =>
      Array.isArray(document.performanceBudgets) && Array.isArray(document.accessibilityBudgets),
    'runtime-operations-pack': () => Array.isArray(document.runbooks) && document.runbooks.length >= 5,
    'security-abuse-case-pack': () =>
      Array.isArray(document.cases) && document.cases.length >= document.requirementCount,
    'architecture-fitness-checks': () => Array.isArray(document.checks) && document.checks.length >= 6,
    'launch-quality-gate': () => Array.isArray(document.artifactChecks) && document.artifactChecks.length === 9,
  };
  const checker = checks[artifactId];
  if (checker && !checker()) return 'artifact-specific contract failed';
  return null;
}

function generateQualityArtifacts(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const planningDir = resolvePlanningDir(projectRoot, { create: true });
  if (!planningDir) {
    return {
      passed: false,
      projectRoot,
      planningDir: null,
      message: 'No canonical planning directory could be resolved',
      written: [],
      missing: QUALITY_ARTIFACTS.map((artifact) => artifact.file),
    };
  }

  const inputs = collectInputs(planningDir);
  const requirements = extractRequirements(inputs);
  const features = extractFeatures(inputs, requirements);
  const generated = buildArtifacts(inputs, requirements, features);
  const written = [];

  for (const artifact of QUALITY_ARTIFACTS) {
    const filePath = artifactPath(planningDir, artifact);
    atomicWriteJSON(filePath, generated[artifact.id], { indent: 2 });
    written.push({
      artifactId: artifact.id,
      path: toPosix(path.relative(projectRoot, filePath)),
      status: generated[artifact.id].status,
    });
  }

  const check = checkQualityArtifacts({ projectRoot });

  // v0.61 (D12): the top-level `passed` flag previously reflected only the
  // shape check (file exists + ≥100 bytes + valid schema). Individual
  // artifacts could carry status:'fail' with content-level blockers and
  // still get rolled up as passed:true — operators saw "PASS / Written: N"
  // when the underlying quality gate had genuinely failed. Now we
  // distinguish two signals: `artifactsWritten` (file IO succeeded) and
  // `qualityGatePassed` (every generated artifact reports status:'pass').
  // `passed` collapses both — it is true only when files wrote AND every
  // artifact's content gate is green.
  const failingArtifacts = written.filter((entry) => entry.status && entry.status !== 'pass');
  const qualityGatePassed = failingArtifacts.length === 0;
  const artifactsWritten = check.passed; // shape check — files exist and parse

  return {
    passed: artifactsWritten && qualityGatePassed,
    artifactsWritten,
    qualityGatePassed,
    failingArtifacts,
    projectRoot,
    planningDir,
    requirementCount: requirements.length,
    featureCount: features.length,
    written,
    check,
  };
}

function checkQualityArtifacts(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const planningDir = resolvePlanningDir(projectRoot, { create: false });
  const missing = [];
  const invalid = [];
  const artifacts = [];

  if (!planningDir) {
    return {
      passed: false,
      projectRoot,
      planningDir: null,
      missing: QUALITY_ARTIFACTS.map((artifact) => artifact.file),
      invalid,
      artifacts,
      message: 'No readable planning directory found',
    };
  }

  for (const artifact of QUALITY_ARTIFACTS) {
    const filePath = artifactPath(planningDir, artifact);
    if (!fs.existsSync(filePath)) {
      missing.push(artifact.file);
      continue;
    }
    const stat = fs.statSync(filePath);
    if (stat.size < 100) {
      invalid.push({ artifactId: artifact.id, path: artifact.file, reason: `undersized ${stat.size}/100 bytes` });
      continue;
    }
    const document = readJson(filePath);
    const reason = validateArtifactShape(artifact.id, document);
    if (reason) {
      invalid.push({ artifactId: artifact.id, path: artifact.file, reason });
      continue;
    }
    artifacts.push({
      artifactId: artifact.id,
      path: toPosix(path.relative(projectRoot, filePath)),
      bytes: stat.size,
      sha256: sha256File(filePath),
      status: document.status,
    });
  }

  return {
    passed: missing.length === 0 && invalid.length === 0,
    projectRoot,
    planningDir,
    expected: QUALITY_ARTIFACTS.length,
    valid: artifacts.length,
    missing,
    invalid,
    artifacts,
  };
}

function parseArgs(argv) {
  const options = {
    command: null,
    projectRoot: process.cwd(),
    json: false,
    strict: false,
  };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (!options.command && !arg.startsWith('-')) {
      options.command = arg;
    } else if (arg === '--project' || arg === '--cwd' || arg === '--dir') {
      options.projectRoot = args.shift() || options.projectRoot;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--strict') {
      options.strict = true;
    } else if (arg === '--help' || arg === '-h') {
      options.command = 'help';
    }
  }
  if (!options.command) options.command = 'check';
  return options;
}

function printHuman(result, command) {
  const status = result.passed ? 'PASS' : 'FAIL';
  console.log(`CoBolt Plan quality artifacts ${command}: ${status}`);
  if (result.planningDir) console.log(`Planning dir: ${result.planningDir}`);
  if (Array.isArray(result.written) && result.written.length > 0) {
    // v0.61 (D12): label the file-IO count separately from the quality-gate
    // verdict. "Written: N" means N artifacts were emitted to disk; the
    // PASS/FAIL on the previous line reflects the content-quality gate.
    console.log(`Written: ${result.written.length} file(s) to disk`);
  }
  if (command === 'generate' && Array.isArray(result.failingArtifacts) && result.failingArtifacts.length > 0) {
    console.log(`Quality gate: FAIL — ${result.failingArtifacts.length} artifact(s) report content-level blockers:`);
    for (const artifact of result.failingArtifacts) {
      console.log(`  - ${artifact.artifactId} (status=${artifact.status})`);
    }
  } else if (command === 'generate') {
    console.log('Quality gate: PASS — all artifacts report status=pass');
  }
  if (Array.isArray(result.missing) && result.missing.length > 0) {
    console.log(`Missing: ${result.missing.join(', ')}`);
  }
  if (Array.isArray(result.invalid) && result.invalid.length > 0) {
    for (const item of result.invalid) console.log(`Invalid: ${item.path} - ${item.reason}`);
  }
}

function usage() {
  return [
    'Usage: node tools/cobolt-plan-quality-artifacts.js <generate|check> [--project <dir>] [--json] [--strict]',
    '',
    'Commands:',
    '  generate  Generate all Plan quality-amplifier artifacts, then validate them.',
    '  check     Validate existing Plan quality-amplifier artifacts.',
  ].join('\n');
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === 'help') {
    console.log(usage());
    return 0;
  }
  if (!['generate', 'check'].includes(options.command)) {
    console.error(`Unknown command: ${options.command}`);
    console.error(usage());
    return 2;
  }
  const result =
    options.command === 'generate'
      ? generateQualityArtifacts({ projectRoot: options.projectRoot })
      : checkQualityArtifacts({ projectRoot: options.projectRoot });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printHuman(result, options.command);
  }
  if (!result.passed && (options.strict || options.command === 'check')) return 1;
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  QUALITY_ARTIFACTS,
  checkQualityArtifacts,
  generateQualityArtifacts,
  main,
};
