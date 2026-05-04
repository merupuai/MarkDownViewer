#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { CoboltPaths } = require('../lib/cobolt-paths');
const { reviewAgentFailures } = require('./cobolt-agent-failure-review');

const VERSION = 1;
const MAX_FILE_BYTES = 512 * 1024;

const DEFAULT_PRINCIPLES = [
  [
    'ARCH-P01',
    'Evidence before claims',
    'Planning, build, review, and release decisions must cite durable artifacts.',
    ['rtm', 'review', 'proof', 'evidence'],
  ],
  [
    'ARCH-P02',
    'Deterministic gates own promotion',
    'Promotion depends on repeatable gates, not narrative confidence.',
    ['delivery', 'release', 'gate', 'quality'],
  ],
  [
    'ARCH-P03',
    'Runtime-neutral context',
    'Core pipeline artifacts must be portable across supported agent runtimes.',
    ['context', 'runtime-neutral', 'handoff'],
  ],
  [
    'ARCH-P04',
    'Security and privacy by construction',
    'Security, privacy, and data lifecycle controls are design inputs.',
    ['security', 'privacy', 'classification', 'retention', 'audit'],
  ],
  [
    'ARCH-P05',
    'Contract-backed integration',
    'Interfaces need explicit contracts, failure modes, and verification evidence.',
    ['api', 'contract', 'schema', 'dependency'],
  ],
  [
    'ARCH-P06',
    'Milestone slices are independently verifiable',
    'Each milestone needs scoped requirements, proofs, and closeout criteria.',
    ['milestone', 'story', 'acceptance', 'proof'],
  ],
  [
    'ARCH-P07',
    'Operability is part of design',
    'Observability, rollout, rollback, and support paths must be defined before production.',
    ['observability', 'rollback', 'deploy', 'sla', 'health'],
  ],
  [
    'ARCH-P08',
    'User experience must be proven when UI exists',
    'User-facing workflows require browser, accessibility, and visual evidence.',
    ['uat', 'browser', 'playwright', 'accessibility', 'screenshot'],
  ],
].map(([id, name, statement, requiredEvidence]) => ({ id, name, statement, requiredEvidence }));

const ROLE_PACKS = [
  [
    'cto',
    'CTO',
    ['architecture principles', 'maturity scorecard', 'release blockers'],
    ['governance-summary.json', 'maturity-scorecard.json', 'principles-conformance.json'],
  ],
  [
    'engineering-lead',
    'Engineering Lead',
    ['implementation sequencing', 'open findings', 'agent escalation'],
    ['next-advisor.json', 'agent-escalation-summary.json'],
  ],
  [
    'product-lead',
    'Product Lead',
    ['capability strategy', 'requirements gaps', 'stakeholder readiness'],
    ['capability-strategy-map.json', 'governance-preflight.json'],
  ],
  [
    'qa-lead',
    'QA Lead',
    ['evidence quality', 'acceptance coverage', 'release readiness'],
    ['maturity-scorecard.json', 'evidence-portal.json'],
  ],
  [
    'security-lead',
    'Security Lead',
    ['privacy impact', 'data controls', 'compliance evidence'],
    ['privacy-impact-assessment.json', 'procurement-decision-support.json'],
  ],
  [
    'platform-lead',
    'Platform Lead',
    ['operability', 'rollout controls', 'dependency resilience'],
    ['procurement-decision-support.json', 'maturity-scorecard.json'],
  ],
  [
    'modernization-lead',
    'Modernization Lead',
    ['template overrides', 'brownfield inputs', 'capability sequencing'],
    ['template-overrides.json', 'capability-strategy-map.json'],
  ],
  [
    'governance-reviewer',
    'Governance Reviewer',
    ['auditability', 'decision traceability', 'production risk'],
    ['governance-summary.json', 'evidence-portal.json'],
  ],
].map(([id, name, focus, entryArtifacts]) => ({ id, name, focus, entryArtifacts }));

const COMMANDS = new Set([
  'all',
  'preflight',
  'principles',
  'conformance',
  'strategy-map',
  'privacy',
  'procurement',
  'portal',
  'templates',
  'roles',
  'maturity',
  'next',
  'failures',
  'summary',
]);

function parseArgs(argv = process.argv.slice(2)) {
  const flags = { command: 'all', cwd: process.cwd(), json: false, failOnBlocker: false, limit: 500 };
  let commandSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd') flags.cwd = path.resolve(argv[++i] || flags.cwd);
    else if (arg === '--json') flags.json = true;
    else if (arg === '--fail-on-blocker') flags.failOnBlocker = true;
    else if (arg === '--limit') flags.limit = Number(argv[++i] || flags.limit);
    else if (!commandSeen && COMMANDS.has(arg)) {
      flags.command = arg;
      commandSeen = true;
    }
  }
  return flags;
}

function projectDirs(cwd) {
  const paths = new CoboltPaths(cwd);
  const latest = paths.latest();
  const governance = ensureDir(path.join(latest, 'governance'));
  const planning =
    typeof paths.findLatestPlanningRun === 'function'
      ? paths.findLatestPlanningRun({ strict: false }) || path.join(latest, 'planning')
      : path.join(latest, 'planning');
  return {
    paths,
    latest,
    governance,
    planning,
    build: path.join(latest, 'build'),
    review: path.join(latest, 'review'),
    fix: path.join(latest, 'fix'),
    deploy: path.join(latest, 'deploy'),
    health: path.join(latest, 'health'),
    productionReadiness: path.join(latest, 'production-readiness'),
  };
}

function readProjectContext(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  const dirs = projectDirs(root);
  const files = {
    packageJson: findFirst([path.join(root, 'package.json')]),
    state: findFirst([path.join(root, 'cobolt-state.json')]),
    prd: findFirst([
      path.join(dirs.planning, 'prd.md'),
      path.join(root, 'docs', 'product', 'PRD.md'),
      path.join(root, 'prd.md'),
      path.join(root, 'README.md'),
    ]),
    trd: findFirst([path.join(dirs.planning, 'trd.md'), path.join(dirs.planning, 'technical-requirements.md')]),
    architecture: findFirst([
      path.join(dirs.planning, 'architecture.md'),
      path.join(dirs.planning, 'system-architecture.md'),
      path.join(root, 'docs', 'ARCHITECTURE.md'),
    ]),
    architectureDecisions: findFirst([
      path.join(dirs.planning, 'architecture-decisions.md'),
      path.join(dirs.planning, 'adrs.md'),
    ]),
    apiContracts: findFirst([path.join(dirs.planning, 'api-contracts.md'), path.join(dirs.planning, 'openapi.yaml')]),
    dataModel: findFirst([path.join(dirs.planning, 'data-model-spec.md'), path.join(dirs.planning, 'data-model.md')]),
    security: findFirst([
      path.join(dirs.planning, 'security-requirements.md'),
      path.join(dirs.planning, 'security.md'),
      path.join(root, 'docs', 'product', 'SECURITY-PRIVACY.md'),
      path.join(root, 'docs', 'PRODUCTION-EVIDENCE-GATE.md'),
      path.join(root, 'docs', 'STANDARDS.md'),
    ]),
    delivery: findFirst([
      path.join(dirs.planning, 'delivery-plan.md'),
      path.join(dirs.planning, 'release-plan.md'),
      path.join(root, 'docs', 'CLIENT-DELIVERY-CHECKLIST.md'),
      path.join(root, 'docs', 'PRODUCTION-READINESS-STABILIZATION-SEQUENCE.md'),
      path.join(root, 'docs', 'COBOLT_PIPELINE_GUIDE.md'),
    ]),
    dependencyRegister: findFirst([
      path.join(dirs.planning, 'dependency-register.md'),
      path.join(dirs.planning, 'dependencies.md'),
    ]),
    milestones: findFirst([
      path.join(dirs.planning, 'milestones.md'),
      path.join(dirs.planning, 'milestone-plan.md'),
      path.join(root, 'docs', 'COBOLT_PIPELINE_GUIDE.md'),
      path.join(root, 'docs', 'COBOLT-CLI-GUIDE.md'),
    ]),
    rtm: findFirst([path.join(dirs.planning, 'rtm.json'), path.join(dirs.latest, 'rtm', 'rtm.json')]),
    featureRegistry: findFirst([
      path.join(dirs.planning, 'feature-registry.json'),
      path.join(dirs.planning, 'features.json'),
    ]),
    capabilityGraph: findFirst([
      path.join(dirs.planning, 'capability-graph.json'),
      path.join(dirs.latest, 'capability-graph', 'capability-graph.json'),
    ]),
    boundedContexts: findFirst([path.join(dirs.planning, 'bounded-contexts.json')]),
    releaseReadiness: findFirst([
      path.join(dirs.latest, 'release-readiness', 'release-readiness.json'),
      path.join(dirs.productionReadiness, 'check-report.json'),
    ]),
    productionQuality: findFirst([path.join(dirs.latest, 'production-quality', 'quality-report.json')]),
    agentFailureReview: findFirst([path.join(dirs.productionReadiness, 'agent-failure-review.json')]),
  };
  const json = {};
  const text = {};
  for (const [key, file] of Object.entries(files)) {
    if (!file) continue;
    if (file.endsWith('.json')) json[key] = readJson(file, null);
    else {
      try {
        text[key] = fs.readFileSync(file, 'utf8').slice(0, MAX_FILE_BYTES);
      } catch {
        text[key] = '';
      }
    }
  }
  const findingFiles = [
    path.join(dirs.review, 'review-findings.json'),
    path.join(dirs.review, 'all-findings.json'),
    path.join(dirs.review, 'deduped-findings.json'),
    path.join(dirs.review, 'finding-tracker.json'),
    path.join(dirs.fix, 'finding-tracker.json'),
  ].filter(fs.existsSync);
  const findings = findingFiles.flatMap((file) => extractFindings(readJson(file, null), file, root));
  const combinedText = Object.values(text).join('\n\n');
  const packageData = json.packageJson || {};
  const dependencyNames = [
    ...Object.keys(packageData.dependencies || {}),
    ...Object.keys(packageData.devDependencies || {}),
    ...extractDependencyNames(text.dependencyRegister || ''),
  ];
  return {
    cwd: root,
    generatedAt: new Date().toISOString(),
    dirs,
    files,
    json,
    text,
    combinedText,
    combinedJson: JSON.stringify(json),
    artifactRecords: Object.entries(files)
      .filter(([, file]) => file)
      .map(([name, file]) => artifactRecord(root, name, file)),
    requirementIds: extractRequirementIds(combinedText, json.rtm),
    headings: extractHeadings(combinedText),
    capabilities: deriveCapabilitiesFromArtifacts(text, json),
    dataTerms: detectDataTerms(`${combinedText}\n${JSON.stringify(json)}`),
    dependencyNames: unique(dependencyNames).slice(0, 100),
    findings,
    sourceAgents: listSourceAgents(root),
    openFindings: findings.filter(isOpenFinding),
  };
}

function generateAll(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  buildAgentFailureEscalation(cwd, options);
  let context = readProjectContext(cwd);
  const artifacts = {
    preflight: buildGovernancePreflight(cwd, context),
    principles: buildArchitecturePrinciples(cwd, context),
    conformance: buildPrinciplesConformance(cwd, context),
    strategyMap: buildCapabilityStrategyMap(cwd, context),
    privacy: buildPrivacyImpactAssessment(cwd, context),
    procurement: buildProcurementDecisionSupport(cwd, context),
    templates: buildTemplateOverrides(cwd, context),
  };
  context = readProjectContext(cwd);
  artifacts.roles = buildRoleGuidance(cwd, context);
  artifacts.maturity = buildMaturityScorecard(cwd, context);
  artifacts.next = buildNextAdvisor(cwd, context);
  artifacts.portal = buildEvidencePortal(cwd, readProjectContext(cwd));
  artifacts.summary = buildGovernanceSummary(cwd, readProjectContext(cwd));
  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    status: artifacts.summary.status,
    governanceDir: rel(cwd, projectDirs(cwd).governance),
    artifacts,
  };
}

function runCommand(flags = parseArgs()) {
  const cwd = path.resolve(flags.cwd || process.cwd());
  if (flags.command === 'preflight') return buildGovernancePreflight(cwd);
  if (flags.command === 'principles') return buildArchitecturePrinciples(cwd);
  if (flags.command === 'conformance') return buildPrinciplesConformance(cwd);
  if (flags.command === 'strategy-map') return buildCapabilityStrategyMap(cwd);
  if (flags.command === 'privacy') return buildPrivacyImpactAssessment(cwd);
  if (flags.command === 'procurement') return buildProcurementDecisionSupport(cwd);
  if (flags.command === 'portal') return buildEvidencePortal(cwd);
  if (flags.command === 'templates') return buildTemplateOverrides(cwd);
  if (flags.command === 'roles') return buildRoleGuidance(cwd);
  if (flags.command === 'maturity') return buildMaturityScorecard(cwd);
  if (flags.command === 'next') return buildNextAdvisor(cwd);
  if (flags.command === 'failures') return buildAgentFailureEscalation(cwd, flags);
  if (flags.command === 'summary') return buildGovernanceSummary(cwd);
  return generateAll(flags);
}

function buildGovernancePreflight(cwd = process.cwd(), context = readProjectContext(cwd)) {
  const gates = [
    gate('scope-defined', 'Source scope and product intent are documented', Boolean(context.files.prd), 'blocker', [
      rel(context.cwd, context.files.prd),
    ]),
    gate(
      'requirements-traceable',
      'Requirements have durable identifiers or an RTM',
      context.requirementIds.length > 0,
      'blocker',
      [rel(context.cwd, context.files.rtm), rel(context.cwd, context.files.prd)],
    ),
    gate(
      'decision-owners',
      'Stakeholders, owners, or decision roles are captured',
      hasAny(context.combinedText, ['stakeholder', 'owner', 'decision', 'approver', 'responsible']),
      'warning',
      [rel(context.cwd, context.files.prd)],
    ),
    gate(
      'success-metrics',
      'Success metrics or acceptance outcomes are explicit',
      hasAny(context.combinedText, ['success metric', 'kpi', 'acceptance criteria', 'outcome', 'measurable']),
      'warning',
      [rel(context.cwd, context.files.prd)],
    ),
    gate(
      'risk-register',
      'Risks, assumptions, and dependency failure modes are recorded',
      Boolean(context.files.dependencyRegister) || hasAny(context.combinedText, ['risk', 'assumption', 'failure mode']),
      'warning',
      [rel(context.cwd, context.files.dependencyRegister)],
    ),
    gate(
      'architecture-recorded',
      'Architecture and ADR evidence exists',
      Boolean(context.files.architecture),
      'blocker',
      [rel(context.cwd, context.files.architecture), rel(context.cwd, context.files.architectureDecisions)],
    ),
    gate('security-recorded', 'Security requirements are documented', Boolean(context.files.security), 'blocker', [
      rel(context.cwd, context.files.security),
    ]),
    gate(
      'delivery-recorded',
      'Delivery, rollback, or release path is documented',
      Boolean(context.files.delivery),
      'warning',
      [rel(context.cwd, context.files.delivery)],
    ),
    gate(
      'agent-failure-review',
      'Agent failure review and review-lead escalation packet are available',
      Boolean(context.files.agentFailureReview),
      'warning',
      [rel(context.cwd, context.files.agentFailureReview)],
    ),
  ];
  const result = {
    version: VERSION,
    generatedAt: context.generatedAt,
    status: statusFromGates(gates),
    summary: {
      gates: gates.length,
      blockers: gates.filter((item) => item.status === 'blocked').length,
      warnings: gates.filter((item) => item.status === 'warning').length,
      requirementIds: context.requirementIds.length,
      sourceAgents: context.sourceAgents.length,
    },
    gates,
    recommendedAction: gates.some((item) => item.status === 'blocked')
      ? 'Resolve blocked governance gates before production promotion.'
      : 'Use this packet as governance evidence for the next stage gate.',
  };
  return writeNamedArtifact(
    context,
    'governance-preflight',
    result,
    renderGateMarkdown('Governance Preflight', result),
  );
}

function buildArchitecturePrinciples(cwd = process.cwd(), context = readProjectContext(cwd)) {
  const result = {
    version: VERSION,
    generatedAt: context.generatedAt,
    status: 'ready',
    scope: 'CoBolt-native architecture governance principles generated from current project artifacts.',
    sourceSignals: context.artifactRecords.map((item) => item.path),
    principles: DEFAULT_PRINCIPLES.map((principle) => ({
      ...principle,
      sourceSignals: principle.requiredEvidence.flatMap((keyword) => evidenceForKeyword(context, keyword)).slice(0, 5),
    })),
    copyrightBoundary: 'Original CoBolt governance language; no external templates, prompts, or command text reused.',
  };
  return writeNamedArtifact(
    context,
    'architecture-principles',
    result,
    renderPrinciplesMarkdown('Architecture Principles', result),
  );
}

function buildPrinciplesConformance(cwd = process.cwd(), context = readProjectContext(cwd)) {
  const checks = [
    conformanceCheck(
      'ARCH-P01',
      'Evidence before claims',
      context.requirementIds.length > 0 || hasArtifact(context, 'rtm'),
      ['rtm', 'review', 'proof'],
    ),
    conformanceCheck(
      'ARCH-P02',
      'Deterministic gates own promotion',
      Boolean(context.files.delivery || context.files.releaseReadiness),
      ['delivery', 'release-readiness'],
    ),
    conformanceCheck(
      'ARCH-P03',
      'Runtime-neutral context',
      hasAny(context.combinedText, ['runtime-neutral', 'context', 'handoff']) ||
        fs.existsSync(path.join(context.cwd, 'docs', 'runtime-neutral-context-architecture.md')),
      ['runtime-neutral-context-architecture.md', 'context'],
    ),
    conformanceCheck('ARCH-P04', 'Security and privacy by construction', Boolean(context.files.security), [
      'security-requirements',
      'privacy-impact-assessment',
    ]),
    conformanceCheck(
      'ARCH-P05',
      'Contract-backed integration',
      Boolean(
        context.files.apiContracts ||
          context.files.dependencyRegister ||
          collectFiles(path.join(context.cwd, 'source', 'schemas'), { maxFiles: 1 }).length,
      ),
      ['api-contracts', 'dependency-register', 'source/schemas'],
    ),
    conformanceCheck('ARCH-P06', 'Milestone slices are independently verifiable', Boolean(context.files.milestones), [
      'milestones',
      'proofs',
    ]),
    conformanceCheck('ARCH-P07', 'Operability is part of design', Boolean(context.files.delivery), [
      'delivery-plan',
      'observability',
      'rollback',
    ]),
    conformanceCheck(
      'ARCH-P08',
      'User experience must be proven when UI exists',
      !detectUiSurface(context) || hasAny(context.combinedText, ['uat', 'playwright', 'accessibility', 'screenshot']),
      ['uat', 'browser-evidence', 'accessibility'],
      detectUiSurface(context) ? 'required' : 'not-applicable',
    ),
  ];
  const status = checks.some((item) => item.status === 'blocked')
    ? 'blocked'
    : checks.some((item) => item.status === 'warning')
      ? 'needs-review'
      : 'conformant';
  const result = {
    version: VERSION,
    generatedAt: context.generatedAt,
    status,
    summary: {
      checks: checks.length,
      conformant: checks.filter((item) => item.status === 'conformant').length,
      warnings: checks.filter((item) => item.status === 'warning').length,
      blocked: checks.filter((item) => item.status === 'blocked').length,
    },
    checks,
  };
  return writeNamedArtifact(
    context,
    'principles-conformance',
    result,
    renderChecksMarkdown('Principles Conformance', result),
  );
}

function buildCapabilityStrategyMap(cwd = process.cwd(), context = readProjectContext(cwd)) {
  const capabilities = context.capabilities.length
    ? context.capabilities
    : [{ id: 'CAP-001', name: 'Project delivery workflow', source: 'fallback', evidence: [] }];
  const mapped = capabilities.slice(0, 50).map((capability, index) => {
    const text = `${capability.name} ${JSON.stringify(capability)}`.toLowerCase();
    const core = hasAny(text, [
      'agent',
      'pipeline',
      'governance',
      'architecture',
      'requirements',
      'review',
      'evidence',
    ]);
    const commodity = hasAny(text, ['email', 'payment', 'notification', 'storage', 'auth provider', 'analytics']);
    return {
      id: capability.id || `CAP-${String(index + 1).padStart(3, '0')}`,
      name: capability.name,
      source: capability.source || 'artifact',
      evidence: capability.evidence || [],
      valueSignal: inferValueSignal(text),
      maturity: inferCapabilityMaturity(capability, context),
      differentiation: core ? 'differentiating' : commodity ? 'commodity' : 'supporting',
      recommendedPosture: core ? 'build-ground-up' : commodity ? 'evaluate-vendor' : 'build-or-adapt',
      riskNotes: capabilityRiskNotes(text, context),
    };
  });
  const result = {
    version: VERSION,
    generatedAt: context.generatedAt,
    status: mapped.length ? 'ready' : 'needs-input',
    summary: {
      capabilities: mapped.length,
      differentiating: mapped.filter((item) => item.differentiation === 'differentiating').length,
      vendorCandidates: mapped.filter((item) => item.recommendedPosture === 'evaluate-vendor').length,
    },
    capabilities: mapped,
    note: 'CoBolt-native advisory map; no external template or method implementation copied.',
  };
  return writeNamedArtifact(context, 'capability-strategy-map', result, renderCapabilitiesMarkdown(result));
}

function buildPrivacyImpactAssessment(cwd = process.cwd(), context = readProjectContext(cwd)) {
  const controls = [
    control(
      'data-classification',
      'Data classification documented',
      hasAny(context.combinedText, ['data classification', 'classified data', 'sensitive data']),
    ),
    control(
      'data-minimization',
      'Data minimization documented',
      hasAny(context.combinedText, ['data minimization', 'minimum necessary', 'least data']),
    ),
    control(
      'retention',
      'Retention and deletion documented',
      hasAny(context.combinedText, ['retention', 'deletion', 'delete data', 'purge']),
    ),
    control(
      'access-control',
      'Access control documented',
      hasAny(context.combinedText, ['rbac', 'authorization', 'access control', 'least privilege']),
    ),
    control(
      'audit-logging',
      'Audit logging documented',
      hasAny(context.combinedText, ['audit log', 'audit trail', 'security event']),
    ),
    control(
      'encryption',
      'Encryption documented',
      hasAny(context.combinedText, ['encrypt', 'encryption', 'at rest', 'in transit']),
    ),
    control(
      'third-party-transfer',
      'Third-party data transfer reviewed',
      hasAny(context.combinedText, ['third party', 'vendor', 'subprocessor', 'data transfer']),
    ),
  ];
  const missingRequiredControls = controls.filter((item) => item.status === 'missing');
  const status =
    context.dataTerms.length && missingRequiredControls.length
      ? 'needs-privacy-review'
      : context.dataTerms.length
        ? 'privacy-controls-present'
        : 'no-sensitive-data-detected';
  const result = {
    version: VERSION,
    generatedAt: context.generatedAt,
    status,
    detectedDataTerms: context.dataTerms,
    controls,
    riskLevel:
      context.dataTerms.length && missingRequiredControls.length > 2
        ? 'high'
        : context.dataTerms.length
          ? 'medium'
          : 'low',
    recommendedActions: privacyActions(context.dataTerms, missingRequiredControls),
  };
  return writeNamedArtifact(context, 'privacy-impact-assessment', result, renderPrivacyMarkdown(result));
}

function buildProcurementDecisionSupport(cwd = process.cwd(), context = readProjectContext(cwd)) {
  const capabilityPostures = context.capabilities.slice(0, 30).map((capability) => {
    const text = capability.name.toLowerCase();
    const commodity = hasAny(text, ['email', 'payment', 'storage', 'analytics', 'notification', 'sms']);
    const core = hasAny(text, ['agent', 'pipeline', 'governance', 'review', 'requirements']);
    return {
      capability: capability.name,
      posture: core ? 'build-ground-up' : commodity ? 'buy-or-integrate' : 'evaluate',
      rationale: core
        ? 'Close to CoBolt differentiation and should stay source-backed.'
        : commodity
          ? 'Commodity capability that can be evaluated with vendor criteria.'
          : 'Insufficient evidence for a fixed decision.',
    };
  });
  const result = {
    version: VERSION,
    generatedAt: context.generatedAt,
    status: context.dependencyNames.length || capabilityPostures.length ? 'ready' : 'needs-input',
    dependencies: context.dependencyNames.map((name) => ({ name, reviewNeeded: true })),
    capabilityPostures,
    vendorScorecardCriteria: [
      'security posture and vulnerability disclosure process',
      'data handling, retention, and deletion controls',
      'SLA, support response, and incident communication',
      'export path and lock-in risk',
      'integration complexity and fallback behavior',
      'total cost at expected scale',
      'license compatibility and procurement approval',
    ],
    requiredEvidenceBeforeAdoption: [
      'approved dependency register entry',
      'security and privacy review',
      'rollback or removal plan',
      'contract or integration test evidence',
    ],
  };
  return writeNamedArtifact(context, 'procurement-decision-support', result, renderProcurementMarkdown(result));
}

function buildTemplateOverrides(cwd = process.cwd(), context = readProjectContext(cwd)) {
  const candidateDirs = [
    path.join(context.cwd, 'cobolt-templates'),
    path.join(context.cwd, '__COBOLT_CONFIG_DIR__', 'templates'),
    path.join(context.cwd, '_cobolt-output', 'config', 'templates'),
  ];
  const configFile = path.join(context.cwd, '_cobolt-output', 'config', 'template-overrides.json');
  const overrideFiles = candidateDirs.flatMap((dir) => collectFiles(dir, { maxFiles: 250 }));
  const config = readJson(configFile, null);
  const warnings = [];
  const allowedExtensions = new Set(['.md', '.json', '.yaml', '.yml', '.txt']);
  const files = overrideFiles.map((file) => {
    const ext = path.extname(file).toLowerCase();
    const content = readText(file);
    const fileWarnings = [];
    if (!allowedExtensions.has(ext)) fileWarnings.push('Unsupported override extension.');
    if (ext === '.md' && !hasAny(content, ['evidence', 'source', 'verification', 'requirement'])) {
      fileWarnings.push('Markdown override lacks evidence/source/verification language.');
    }
    warnings.push(...fileWarnings.map((warning) => ({ file: rel(context.cwd, file), warning })));
    return {
      path: rel(context.cwd, file),
      extension: ext,
      sizeBytes: safeStat(file)?.size || 0,
      warnings: fileWarnings,
    };
  });
  const result = {
    version: VERSION,
    generatedAt: context.generatedAt,
    status: warnings.length ? 'needs-review' : files.length || config ? 'ready' : 'no-overrides-detected',
    configPath: fs.existsSync(configFile) ? rel(context.cwd, configFile) : null,
    config,
    candidateDirs: candidateDirs.map((dir) => ({ path: rel(context.cwd, dir), exists: fs.existsSync(dir) })),
    files,
    warnings,
    guardrails: [
      'Project overrides may change wording and structure only inside the local project.',
      'Overrides must preserve requirement IDs, evidence fields, and verification expectations.',
      'Runtime deployment copies remain generated outputs and should not be edited for source changes.',
    ],
  };
  return writeNamedArtifact(context, 'template-overrides', result, renderTemplatesMarkdown(result));
}

function buildRoleGuidance(cwd = process.cwd(), context = readProjectContext(cwd)) {
  const packs = ROLE_PACKS.map((pack) => ({
    ...pack,
    currentSignals: pack.entryArtifacts.map((artifact) => ({
      artifact,
      exists: fs.existsSync(path.join(context.dirs.governance, artifact)),
    })),
    recommendedFirstQuestion: firstQuestionForRole(pack.id, context),
  }));
  const result = { version: VERSION, generatedAt: context.generatedAt, status: 'ready', packs };
  return writeNamedArtifact(context, 'role-guidance', result, renderRolesMarkdown(result));
}

function buildMaturityScorecard(cwd = process.cwd(), context = readProjectContext(cwd)) {
  const agentFailure = context.json.agentFailureReview || {};
  const dimensions = [
    maturityDimension(
      'governance',
      'Governance readiness',
      scoreBoolean(Boolean(context.files.prd && context.files.architecture)),
    ),
    maturityDimension('traceability', 'Requirements traceability', scoreCount(context.requirementIds.length, 5, 20)),
    maturityDimension(
      'architecture',
      'Architecture evidence',
      context.files.architecture && context.files.architectureDecisions ? 100 : context.files.architecture ? 75 : 35,
    ),
    maturityDimension(
      'securityPrivacy',
      'Security and privacy evidence',
      scoreBoolean(Boolean(context.files.security)) - privacyPenalty(context),
    ),
    maturityDimension(
      'deliveryReadiness',
      'Delivery and rollback evidence',
      scoreBoolean(Boolean(context.files.delivery || context.files.releaseReadiness)),
    ),
    maturityDimension('evidenceQuality', 'Review and proof evidence', evidenceQualityScore(context)),
    maturityDimension(
      'operations',
      'Operational readiness',
      scoreBoolean(hasAny(context.combinedText, ['observability', 'health check', 'rollback', 'sla'])),
    ),
    maturityDimension(
      'agentReliability',
      'Agent failure escalation',
      agentFailure.failureCount > 0 ? 25 : context.files.agentFailureReview ? 100 : 55,
    ),
  ].map((dimension) => ({ ...dimension, score: clamp(dimension.score, 0, 100) }));
  const score = Math.round(dimensions.reduce((sum, dimension) => sum + dimension.score, 0) / dimensions.length);
  const blockers = [
    ...dimensions.filter((dimension) => dimension.score < 50).map((dimension) => `${dimension.id}: ${dimension.label}`),
    ...(agentFailure.failureCount > 0
      ? [`agent-failures: ${agentFailure.failureCount} failure(s) require review-lead escalation`]
      : []),
  ];
  const result = {
    version: VERSION,
    generatedAt: context.generatedAt,
    status: blockers.length ? 'blocked' : score >= 85 ? 'production-candidate' : 'needs-hardening',
    score,
    grade: gradeForScore(score),
    dimensions,
    blockers,
    residualRisk: blockers.length
      ? 'Production transition should wait until blockers have durable fix and verification evidence.'
      : 'No blocking governance risk detected by this deterministic advisory pass.',
  };
  return writeNamedArtifact(context, 'maturity-scorecard', result, renderMaturityMarkdown(result));
}

function buildNextAdvisor(cwd = process.cwd(), context = readProjectContext(cwd)) {
  const agentFailure = context.json.agentFailureReview || {};
  const actions = [];
  if (agentFailure.failureCount > 0) {
    actions.push({
      priority: 1,
      action: 'Escalate agent failures to review-lead',
      command: 'node tools/cobolt-agent-failure-review.js --json',
      rationale: 'Runtime agent failures must be routed with full source event context before another fix loop.',
      context: agentFailure.escalation || { leadAgent: 'review-lead', advisorRequired: true },
    });
  }
  if (!context.files.prd)
    actions.push({
      priority: 2,
      action: 'Create or restore planning artifacts',
      command: 'cobolt-cli plan project . --auto',
      rationale: 'Governance cannot prove readiness without a PRD and planning packet.',
    });
  if (!context.files.architecture)
    actions.push({
      priority: 3,
      action: 'Create architecture evidence',
      command: 'cobolt-cli plan feature . --auto',
      rationale: 'Architecture decisions are required before production promotion.',
    });
  if (context.dataTerms.length && !context.files.security)
    actions.push({
      priority: 4,
      action: 'Complete security and privacy requirements',
      command: 'node tools/cobolt-governance.js privacy --json',
      rationale: 'Sensitive data terms were detected without security requirements evidence.',
    });
  if (context.openFindings.length > 0)
    actions.push({
      priority: 5,
      action: 'Resolve open findings',
      command: 'cobolt-cli fix M{x}',
      rationale: `${context.openFindings.length} open finding(s) remain in review/fix artifacts.`,
    });
  if (!context.files.delivery)
    actions.push({
      priority: 6,
      action: 'Define delivery and rollback path',
      command: 'node tools/cobolt-governance.js preflight --json',
      rationale: 'Production transition needs rollback and gate evidence.',
    });
  if (!actions.length)
    actions.push({
      priority: 1,
      action: 'Run release readiness gate',
      command: 'npm run check:release-readiness',
      rationale: 'Governance advisory did not detect blockers; run the deterministic release gate.',
    });
  const result = {
    version: VERSION,
    generatedAt: context.generatedAt,
    status: actions.some((item) => item.priority <= 2) ? 'action-required' : 'ready',
    actions: actions.sort((a, b) => a.priority - b.priority),
  };
  return writeNamedArtifact(context, 'next-advisor', result, renderNextMarkdown(result));
}

function buildAgentFailureEscalation(cwd = process.cwd(), options = {}) {
  const root = path.resolve(cwd);
  const review = reviewAgentFailures({ cwd: root, limit: options.limit || 500 });
  const context = readProjectContext(root);
  const result = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    status: review.status,
    sourceAgentsChecked: review.sourceAgentCount,
    failureCount: review.failureCount,
    escalation: review.escalation,
    productionReadinessArtifact: rel(root, path.join(context.dirs.productionReadiness, 'agent-failure-review.json')),
    reviewLeadPacket: rel(root, path.join(context.dirs.productionReadiness, 'review-lead-escalation-packet.json')),
    failures: review.failures,
  };
  return writeNamedArtifact(context, 'agent-escalation-summary', result, renderAgentEscalationMarkdown(result));
}

function buildEvidencePortal(cwd = process.cwd(), context = readProjectContext(cwd)) {
  const artifactFiles = collectFiles(context.dirs.latest, {
    maxFiles: 1000,
    skip: (file) => file.includes(`${path.sep}node_modules${path.sep}`),
  });
  const governanceFiles = collectFiles(context.dirs.governance, { maxFiles: 250 });
  const result = {
    version: VERSION,
    generatedAt: context.generatedAt,
    status: 'ready',
    artifactCount: artifactFiles.length,
    governanceArtifactCount: governanceFiles.length,
    artifacts: artifactFiles.map((file) => ({
      path: rel(context.cwd, file),
      sizeBytes: safeStat(file)?.size || 0,
      kind: fileKind(file),
    })),
  };
  const jsonPath = path.join(context.dirs.governance, 'evidence-portal.json');
  const mdPath = path.join(context.dirs.governance, 'evidence-portal.md');
  const htmlPath = path.join(ensureDir(path.join(context.dirs.governance, 'evidence-portal')), 'index.html');
  result.artifactPaths = {
    json: rel(context.cwd, jsonPath),
    markdown: rel(context.cwd, mdPath),
    html: rel(context.cwd, htmlPath),
  };
  writeJson(jsonPath, result);
  writeText(mdPath, renderPortalMarkdown(result));
  writeText(htmlPath, renderPortalHtml(result));
  return result;
}

function buildGovernanceSummary(cwd = process.cwd(), context = readProjectContext(cwd)) {
  const governanceFiles = collectFiles(context.dirs.governance, { maxFiles: 500 })
    .filter((file) => file.endsWith('.json') && path.basename(file) !== 'governance-summary.json')
    .map((file) => ({ path: rel(context.cwd, file), data: readJson(file, {}) }));
  const blockers = governanceFiles.flatMap((entry) => collectBlockers(entry.path, entry.data));
  const result = {
    version: VERSION,
    generatedAt: context.generatedAt,
    status: blockers.length ? 'blocked' : 'ready',
    artifactCount: governanceFiles.length,
    blockers,
    artifacts: governanceFiles.map((entry) => ({
      path: entry.path,
      status: entry.data.status || 'unknown',
      summary: entry.data.summary || null,
    })),
  };
  return writeNamedArtifact(context, 'governance-summary', result, renderSummaryMarkdown(result));
}

function main() {
  const flags = parseArgs();
  const result = runCommand(flags);
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Governance ${flags.command}: ${result.status || 'ready'}`);
    const artifactPath = result.artifactPaths?.json || result.governanceDir;
    if (artifactPath) console.log(`Artifact: ${artifactPath}`);
  }
  if (flags.command === 'failures' && result.failureCount > 0) return 1;
  if (flags.failOnBlocker && hasBlockingStatus(result)) return 1;
  return 0;
}

function writeNamedArtifact(context, slug, result, markdown) {
  const jsonPath = path.join(context.dirs.governance, `${slug}.json`);
  const mdPath = path.join(context.dirs.governance, `${slug}.md`);
  const output = { ...result, artifactPaths: { json: rel(context.cwd, jsonPath), markdown: rel(context.cwd, mdPath) } };
  writeJson(jsonPath, output);
  writeText(mdPath, markdown);
  return output;
}

function gate(id, label, passed, severity, evidence = []) {
  return {
    id,
    label,
    status: passed ? 'passed' : severity === 'blocker' ? 'blocked' : 'warning',
    severity: passed ? 'none' : severity,
    evidence: evidence.filter(Boolean),
  };
}

function statusFromGates(gates) {
  if (gates.some((item) => item.status === 'blocked')) return 'blocked';
  if (gates.some((item) => item.status === 'warning')) return 'needs-review';
  return 'ready';
}

function conformanceCheck(id, label, passed, expectedEvidence, requirement = 'required') {
  if (requirement === 'not-applicable') return { id, label, status: 'not-applicable', expectedEvidence };
  return {
    id,
    label,
    status: passed ? 'conformant' : requirement === 'required' ? 'blocked' : 'warning',
    expectedEvidence,
  };
}

function control(id, label, present) {
  return { id, label, status: present ? 'present' : 'missing' };
}

function privacyActions(dataTerms, missingControls) {
  if (!dataTerms.length) return ['Keep data classification evidence current as features change.'];
  return [
    'Confirm each detected data class has an owner, retention policy, and lawful processing basis.',
    ...missingControls.map((item) => `Add evidence for ${item.id}.`),
  ];
}

function maturityDimension(id, label, score) {
  return { id, label, score };
}

function scoreBoolean(value) {
  return value ? 100 : 35;
}

function scoreCount(count, partial, full) {
  if (count >= full) return 100;
  if (count >= partial) return 75;
  if (count > 0) return 55;
  return 25;
}

function evidenceQualityScore(context) {
  if (context.files.rtm || context.files.releaseReadiness) return 100;
  if (context.requirementIds.length > 0 && fs.existsSync(path.join(context.cwd, 'tests'))) return 75;
  if (context.requirementIds.length > 0) return 55;
  return 35;
}

function privacyPenalty(context) {
  return context.dataTerms.length && !hasAny(context.combinedText, ['retention', 'classification', 'audit']) ? 25 : 0;
}

function gradeForScore(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function hasBlockingStatus(result) {
  return Boolean(
    result &&
      (['blocked', 'failures-detected', 'needs-privacy-review'].includes(result.status) ||
        result.summary?.blockers > 0 ||
        (Array.isArray(result.blockers) && result.blockers.length)),
  );
}

function collectBlockers(file, data) {
  const blockers = [];
  if (!data || typeof data !== 'object') return blockers;
  if (['blocked', 'failures-detected', 'needs-privacy-review'].includes(data.status))
    blockers.push({ file, reason: `artifact status is ${data.status}` });
  if (Array.isArray(data.blockers))
    for (const blocker of data.blockers) blockers.push({ file, reason: formatBlocker(blocker) });
  if (Array.isArray(data.gates)) {
    for (const gateItem of data.gates.filter((item) => item.status === 'blocked'))
      blockers.push({ file, reason: `${gateItem.id}: ${gateItem.label}` });
  }
  return blockers;
}

function formatBlocker(blocker) {
  if (typeof blocker === 'string') return blocker;
  if (!blocker || typeof blocker !== 'object') return String(blocker);
  return blocker.reason || blocker.id || blocker.label || JSON.stringify(blocker);
}

function evidenceForKeyword(context, keyword) {
  const lower = keyword.toLowerCase();
  return context.artifactRecords
    .filter((record) => record.path.toLowerCase().includes(lower) || record.name.toLowerCase().includes(lower))
    .map((record) => record.path);
}

function hasArtifact(context, name) {
  const lower = name.toLowerCase();
  return Object.entries(context.files).some(
    ([key, file]) => file && (key.toLowerCase().includes(lower) || file.toLowerCase().includes(lower)),
  );
}

function detectUiSurface(context) {
  const pkg = context.json.packageJson || {};
  const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }).join(' ');
  return /\b(react|vue|svelte|phoenix_live_view|liveview|playwright|frontend|tailwind|shadcn)\b/i.test(
    `${context.combinedText}\n${deps}`,
  );
}

function inferValueSignal(text) {
  if (hasAny(text, ['security', 'privacy', 'compliance'])) return 'risk-reduction';
  if (hasAny(text, ['customer', 'user', 'workflow', 'experience'])) return 'user-value';
  if (hasAny(text, ['cost', 'efficiency', 'automation'])) return 'efficiency';
  if (hasAny(text, ['revenue', 'billing', 'sales'])) return 'revenue';
  return 'platform-support';
}

function inferCapabilityMaturity(capability, context) {
  const name = capability.name.toLowerCase();
  if (context.openFindings.some((finding) => JSON.stringify(finding).toLowerCase().includes(name))) return 'needs-fix';
  if ((capability.evidence || []).length > 0) return 'defined';
  return 'discovered';
}

function capabilityRiskNotes(text, context) {
  const risks = [];
  if (hasAny(text, ['payment', 'bank', 'invoice'])) risks.push('financial data review required');
  if (hasAny(text, ['auth', 'access', 'permission'])) risks.push('authorization and abuse-case testing required');
  if (context.dataTerms.length && hasAny(text, ['user', 'customer', 'account']))
    risks.push('privacy impact must be linked');
  return risks;
}

function firstQuestionForRole(roleId, context) {
  if (roleId === 'security-lead' && context.dataTerms.length)
    return 'Which detected data classes need retention, deletion, and audit evidence before launch?';
  if (roleId === 'engineering-lead' && context.openFindings.length)
    return 'Which open finding blocks the shortest safe path to production?';
  if (roleId === 'product-lead')
    return 'Which capability must ship first to prove user value with acceptance evidence?';
  if (roleId === 'qa-lead') return 'Which requirement IDs still lack executable proof?';
  return 'Which blocker needs ownership, evidence, and verification next?';
}

function deriveCapabilitiesFromArtifacts(text, json) {
  const capabilities = [];
  const add = (name, source, evidence = []) => {
    const cleaned = cleanTitle(name);
    if (!cleaned || cleaned.length < 3 || cleaned.length > 120) return;
    if (capabilities.some((item) => item.name.toLowerCase() === cleaned.toLowerCase())) return;
    capabilities.push({
      id: `CAP-${String(capabilities.length + 1).padStart(3, '0')}`,
      name: cleaned,
      source,
      evidence,
    });
  };
  visitJson(json.featureRegistry, (value, key) => {
    if (['name', 'title', 'feature', 'capability'].includes(String(key).toLowerCase()) && typeof value === 'string')
      add(value, 'feature-registry');
  });
  visitJson(json.capabilityGraph, (value, key) => {
    if (['name', 'title', 'label'].includes(String(key).toLowerCase()) && typeof value === 'string')
      add(value, 'capability-graph');
  });
  for (const heading of extractHeadings(Object.values(text).join('\n'))) {
    if (/\b(feature|capability|epic|milestone|workflow)\b/i.test(heading)) add(heading, 'heading');
  }
  for (const req of extractRequirementObjects(json.rtm).slice(0, 30))
    add(req.title || req.name || req.id, 'rtm', req.id ? [req.id] : []);
  return capabilities;
}

function extractRequirementIds(text, rtm) {
  const ids = new Set();
  const add = (value) => {
    const matches = String(value || '').match(/\b(?:FR|NFR|TR|IR|REQ|SEC|UX|ADR)-\d{1,4}\b/gi) || [];
    for (const match of matches) ids.add(match.toUpperCase());
  };
  add(text);
  visitJson(rtm, (value, key) => {
    if (key && /id/i.test(String(key))) add(value);
    if (typeof value === 'string') add(value);
  });
  return [...ids].sort();
}

function extractRequirementObjects(rtm) {
  const results = [];
  visitJson(rtm, (value) => {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value.id || value.requirementId || value.title || value.name)
    ) {
      results.push({ id: value.id || value.requirementId, title: value.title || value.name || value.summary });
    }
  });
  return results;
}

function extractDependencyNames(text) {
  return (
    text.match(
      /\b(?:AWS|Azure|GCP|OpenAI|Stripe|Twilio|SendGrid|Postgres|Redis|Supabase|Firebase|Vercel|Railway|Fly\.io)\b/gi,
    ) || []
  );
}

function detectDataTerms(text) {
  const terms = [
    'email',
    'phone',
    'address',
    'customer',
    'user profile',
    'account',
    'password',
    'token',
    'secret',
    'credential',
    'session',
    'payment',
    'invoice',
    'bank',
    'ssn',
    'date of birth',
    'pii',
    'personal data',
    'health',
    'location',
  ];
  const lower = text.toLowerCase();
  return terms.filter((term) => lower.includes(term)).sort();
}

function extractHeadings(text) {
  const headings = [];
  const regex = /^#{1,6}\s+(.+)$/gm;
  let match;
  while ((match = regex.exec(text))) headings.push(cleanTitle(match[1]));
  return unique(headings.filter(Boolean));
}

function extractFindings(value, file, cwd) {
  const findings = [];
  const visit = (node) => {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node === 'object') {
      if (node.id || node.findingId || node.severity || node.status || node.title) {
        findings.push({
          id: node.id || node.findingId || `${path.basename(file)}:${findings.length + 1}`,
          status: node.status || node.state || 'unknown',
          severity: node.severity || node.priority || 'unknown',
          title: node.title || node.message || node.summary || '',
          source: rel(cwd, file),
        });
      }
      Object.values(node).forEach(visit);
    }
  };
  visit(value);
  return findings;
}

function isOpenFinding(finding) {
  const status = String(finding.status || '').toLowerCase();
  if (['closed', 'resolved', 'fixed', 'pass', 'passed', 'accepted'].includes(status)) return false;
  if (['critical', 'high', 'blocker', 'p0', 'p1'].includes(String(finding.severity || '').toLowerCase())) return true;
  return ['open', 'failed', 'blocked', 'needs-fix', 'unknown'].includes(status);
}

function listSourceAgents(cwd) {
  const dir = path.join(cwd, 'source', 'agents');
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name.replace(/\.md$/, ''))
      .sort();
  } catch {
    return [];
  }
}

function artifactRecord(cwd, name, file) {
  return { name, path: rel(cwd, file), sizeBytes: safeStat(file)?.size || 0, kind: fileKind(file) };
}

function fileKind(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.md') return 'markdown';
  if (['.yaml', '.yml'].includes(ext)) return 'yaml';
  if (ext === '.html') return 'html';
  return ext.replace(/^\./, '') || 'file';
}

function findFirst(files) {
  return files.find((file) => file && fs.existsSync(file)) || null;
}

function readJson(file, fallback = null) {
  if (!file) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readText(file) {
  if (!file) return '';
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.length > MAX_FILE_BYTES ? text.slice(0, MAX_FILE_BYTES) : text;
  } catch {
    return '';
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function writeText(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, value, { encoding: 'utf8', mode: 0o600 });
}

function collectFiles(dir, options = {}) {
  const results = [];
  const maxFiles = options.maxFiles || 500;
  const skip = options.skip || (() => false);
  const walk = (current) => {
    if (results.length >= maxFiles || !fs.existsSync(current)) return;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      const file = path.join(current, entry.name);
      if (skip(file)) continue;
      if (entry.isDirectory()) {
        if (!['.git', 'node_modules'].includes(entry.name)) walk(file);
      } else if (entry.isFile()) {
        results.push(file);
      }
    }
  };
  walk(dir);
  return results;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function safeStat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function rel(cwd, file) {
  if (!file) return null;
  return path.relative(cwd, file).replace(/\\/g, '/');
}

function hasAny(text, terms) {
  const lower = String(text || '').toLowerCase();
  return terms.some((term) => lower.includes(String(term).toLowerCase()));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function cleanTitle(value) {
  return String(value || '')
    .replace(/^[#\s*-]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function visitJson(value, visitor, key = null, seen = new Set()) {
  if (value === null || value === undefined) return;
  visitor(value, key);
  if (typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) visitJson(value[index], visitor, index, seen);
  } else for (const [childKey, childValue] of Object.entries(value)) visitJson(childValue, visitor, childKey, seen);
}

function renderGateMarkdown(title, result) {
  return [
    `# ${title}`,
    '',
    `- Status: ${result.status}`,
    `- Blockers: ${result.summary.blockers}`,
    `- Warnings: ${result.summary.warnings}`,
    `- Requirement IDs: ${result.summary.requirementIds}`,
    '',
    '## Gates',
    '',
    ...result.gates.map((item) => `- ${item.status}: ${item.id} - ${item.label}`),
    '',
    `Recommended action: ${result.recommendedAction}`,
    '',
  ].join('\n');
}

function renderPrinciplesMarkdown(title, result) {
  return [
    `# ${title}`,
    '',
    `- Status: ${result.status}`,
    `- Source signals: ${result.sourceSignals.length}`,
    '',
    ...result.principles.flatMap((item) => [
      `## ${item.id} ${item.name}`,
      '',
      item.statement,
      '',
      `Required evidence: ${item.requiredEvidence.join(', ')}`,
      '',
    ]),
  ].join('\n');
}

function renderChecksMarkdown(title, result) {
  return [
    `# ${title}`,
    '',
    `- Status: ${result.status}`,
    `- Checks: ${result.summary.checks}`,
    `- Blocked: ${result.summary.blocked}`,
    '',
    ...result.checks.map((item) => `- ${item.status}: ${item.id} - ${item.label}`),
    '',
  ].join('\n');
}

function renderCapabilitiesMarkdown(result) {
  return [
    '# Capability Strategy Map',
    '',
    `- Status: ${result.status}`,
    `- Capabilities: ${result.summary.capabilities}`,
    `- Differentiating: ${result.summary.differentiating}`,
    `- Vendor candidates: ${result.summary.vendorCandidates}`,
    '',
    ...result.capabilities.map((item) => `- ${item.id}: ${item.name} (${item.recommendedPosture}, ${item.maturity})`),
    '',
  ].join('\n');
}

function renderPrivacyMarkdown(result) {
  return [
    '# Privacy Impact Assessment',
    '',
    `- Status: ${result.status}`,
    `- Risk level: ${result.riskLevel}`,
    `- Detected data terms: ${result.detectedDataTerms.join(', ') || 'none'}`,
    '',
    '## Controls',
    '',
    ...result.controls.map((item) => `- ${item.status}: ${item.id} - ${item.label}`),
    '',
    '## Recommended Actions',
    '',
    ...result.recommendedActions.map((item) => `- ${item}`),
    '',
  ].join('\n');
}

function renderProcurementMarkdown(result) {
  return [
    '# Procurement Decision Support',
    '',
    `- Status: ${result.status}`,
    `- Dependencies: ${result.dependencies.length}`,
    '',
    '## Capability Postures',
    '',
    ...result.capabilityPostures.map((item) => `- ${item.posture}: ${item.capability} - ${item.rationale}`),
    '',
    '## Vendor Scorecard Criteria',
    '',
    ...result.vendorScorecardCriteria.map((item) => `- ${item}`),
    '',
  ].join('\n');
}

function renderTemplatesMarkdown(result) {
  return [
    '# Template Overrides',
    '',
    `- Status: ${result.status}`,
    `- Files: ${result.files.length}`,
    `- Warnings: ${result.warnings.length}`,
    '',
    ...result.files.map((item) => `- ${item.path}${item.warnings.length ? ` (${item.warnings.join('; ')})` : ''}`),
    '',
  ].join('\n');
}

function renderRolesMarkdown(result) {
  return [
    '# Role Guidance',
    '',
    `- Status: ${result.status}`,
    '',
    ...result.packs.flatMap((pack) => [
      `## ${pack.name}`,
      '',
      `Focus: ${pack.focus.join(', ')}`,
      '',
      `First question: ${pack.recommendedFirstQuestion}`,
      '',
    ]),
  ].join('\n');
}

function renderMaturityMarkdown(result) {
  return [
    '# Maturity Scorecard',
    '',
    `- Status: ${result.status}`,
    `- Score: ${result.score}`,
    `- Grade: ${result.grade}`,
    '',
    ...result.dimensions.map((item) => `- ${item.id}: ${item.score} - ${item.label}`),
    '',
    '## Blockers',
    '',
    ...(result.blockers.length ? result.blockers.map((item) => `- ${item}`) : ['- none']),
    '',
  ].join('\n');
}

function renderNextMarkdown(result) {
  return [
    '# What Next Advisor',
    '',
    `- Status: ${result.status}`,
    '',
    ...result.actions.map((item) => `- P${item.priority}: ${item.action} - ${item.command}`),
    '',
  ].join('\n');
}

function renderAgentEscalationMarkdown(result) {
  return [
    '# Agent Escalation Summary',
    '',
    `- Status: ${result.status}`,
    `- Source agents checked: ${result.sourceAgentsChecked}`,
    `- Failures: ${result.failureCount}`,
    `- Lead agent: ${result.escalation.leadAgent}`,
    `- Advisor required: ${result.escalation.advisorRequired ? 'yes' : 'no'}`,
    `- Advisor agent: ${result.escalation.advisorAgent}`,
    '',
    ...(result.failures.length
      ? result.failures.map((item) => `- ${item.agent}: ${item.message}`)
      : ['- No runtime agent failures detected.']),
    '',
  ].join('\n');
}

function renderPortalMarkdown(result) {
  return [
    '# Evidence Portal',
    '',
    `- Status: ${result.status}`,
    `- Artifacts indexed: ${result.artifactCount}`,
    `- Governance artifacts: ${result.governanceArtifactCount}`,
    '',
    ...result.artifacts.slice(0, 100).map((item) => `- ${item.path} (${item.kind}, ${item.sizeBytes} bytes)`),
    '',
  ].join('\n');
}

function renderPortalHtml(result) {
  const rows = result.artifacts
    .slice(0, 1000)
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.path)}</td><td>${escapeHtml(item.kind)}</td><td>${Number(item.sizeBytes)}</td></tr>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>CoBolt Evidence Portal</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; color: #161616; background: #fafafa; }
    table { border-collapse: collapse; width: 100%; background: #fff; }
    th, td { border: 1px solid #d7d7d7; padding: 8px; text-align: left; }
    th { background: #eeeeee; }
    .meta { margin-bottom: 16px; }
  </style>
</head>
<body>
  <h1>CoBolt Evidence Portal</h1>
  <div class="meta">Artifacts indexed: ${Number(result.artifactCount)}. Generated: ${escapeHtml(result.generatedAt)}.</div>
  <table>
    <thead><tr><th>Path</th><th>Kind</th><th>Bytes</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>
`;
}

function renderSummaryMarkdown(result) {
  return [
    '# Governance Summary',
    '',
    `- Status: ${result.status}`,
    `- Artifacts: ${result.artifactCount}`,
    `- Blockers: ${result.blockers.length}`,
    '',
    ...(result.blockers.length
      ? result.blockers.map((item) => `- ${item.file}: ${item.reason}`)
      : ['- No governance blockers detected.']),
    '',
  ].join('\n');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  VERSION,
  parseArgs,
  readProjectContext,
  runCommand,
  generateAll,
  buildGovernancePreflight,
  buildArchitecturePrinciples,
  buildPrinciplesConformance,
  buildCapabilityStrategyMap,
  buildPrivacyImpactAssessment,
  buildProcurementDecisionSupport,
  buildTemplateOverrides,
  buildRoleGuidance,
  buildMaturityScorecard,
  buildNextAdvisor,
  buildAgentFailureEscalation,
  buildEvidencePortal,
  buildGovernanceSummary,
};

if (require.main === module) {
  process.exit(main());
}
