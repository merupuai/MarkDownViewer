#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { writeReviewFileManifest } = require('../lib/cobolt-file-manifest');
const { defaultReviewDir, maybePrintHelpAndExit } = require('./_review-readiness-utils');

const USAGE = `Usage: node tools/cobolt-review-packet.js build [--dir <path>] [--review-dir <path>] [--review-id <id>] [--milestone <id>] [--mode standalone|pipeline] [--json]

Commands:
  build    Build review packet (markdown + JSON), source manifest, and review-manifest bootstrap

Flags:
  --dir <path>          Project root (default: cwd)
  --review-dir <path>   Override review dir
  --review-id <id>      Review id (defaults to milestone)
  --milestone <id>      Milestone id (e.g. M1)
  --mode standalone|pipeline   Packet mode
  --json                Emit machine-readable JSON
  --help, -h            Show this help and exit
`;

const PLANNING_ARTIFACTS = [
  { name: 'prd.md', candidates: ['prd.md'] },
  { name: 'architecture.md', candidates: ['architecture.md'] },
  { name: 'system-architecture.md', candidates: ['system-architecture.md'] },
  { name: 'data-model-spec.md', candidates: ['data-model-spec.md', 'data-model.md'] },
  { name: 'api-contracts.md', candidates: ['api-contracts.md'] },
  { name: 'security-requirements.md', candidates: ['security-requirements.md'] },
  { name: 'ux-design-specification.md', candidates: ['ux-design-specification.md', 'ux-design.md'] },
  { name: 'traceability-matrix.md', candidates: ['traceability-matrix.md'] },
  { name: 'dependency-register.md', candidates: ['dependency-register.md'] },
  { name: 'test-strategy.md', candidates: ['test-strategy.md'] },
  { name: 'domain-knowledge-base.md', candidates: ['domain-knowledge-base.md', 'domain-knowledge.md'] },
  { name: 'compliance-register.md', candidates: ['compliance-register.md'] },
  { name: 'compliance-register.json', candidates: ['compliance-register.json'] },
  { name: 'wireframes-and-user-flows.md', candidates: ['wireframes-and-user-flows.md'] },
  { name: 'capability-contracts-index.json', candidates: ['capability-contracts-index.json'] },
  { name: 'milestone-execution-obligations.json', candidates: ['milestone-execution-obligations.json'] },
  { name: 'planning-manifest.json', candidates: ['planning-manifest.json'] },
  { name: 'planning-loop-verdict.json', candidates: ['planning-loop-verdict.json'] },
  { name: 'planning-evidence-signature.json', candidates: ['planning-evidence-signature.json'] },
  { name: 'planning-control-map.json', candidates: ['planning-control-map.json'] },
  { name: 'planning-external-source-ledger.json', candidates: ['planning-external-source-ledger.json'] },
  { name: 'planning-risk-model.json', candidates: ['planning-risk-model.json'] },
  { name: 'agentic-threat-model.json', candidates: ['agentic-threat-model.json'] },
  { name: 'planning-performance-profile.json', candidates: ['planning-performance-profile.json'] },
  { name: 'planning-replay-calibration.json', candidates: ['planning-replay-calibration.json'] },
  { name: 'product-quality-scorecard.json', candidates: ['quality/product-quality-scorecard.json'] },
  { name: 'ux-state-matrix.json', candidates: ['quality/ux-state-matrix.json'] },
  { name: 'acceptance-example-pack.json', candidates: ['quality/acceptance-example-pack.json'] },
  { name: 'test-data-fixture-plan.json', candidates: ['quality/test-data-fixture-plan.json'] },
  { name: 'observability-contract.json', candidates: ['quality/observability-contract.json'] },
  {
    name: 'performance-accessibility-budgets.json',
    candidates: ['quality/performance-accessibility-budgets.json'],
  },
  { name: 'runtime-operations-pack.json', candidates: ['quality/runtime-operations-pack.json'] },
  { name: 'security-abuse-case-pack.json', candidates: ['quality/security-abuse-case-pack.json'] },
  { name: 'architecture-fitness-checks.json', candidates: ['quality/architecture-fitness-checks.json'] },
  { name: 'launch-quality-gate.json', candidates: ['quality/launch-quality-gate.json'] },
];

const REVIEW_PACKET_CARRIER = 'review-packet';

const BUILD_HANDOFF_ARTIFACTS = [
  { id: 'planning-context', file: (m) => `${m}-planning-context.json`, kind: 'json', required: true },
  { id: 'plan-ingestion-manifest', file: (m) => `${m}-plan-ingestion-manifest.json`, kind: 'json', required: true },
  { id: 'build-packet', file: (m) => `${m}-build-packet.md`, kind: 'text', required: true },
  { id: 'build-packet-sources', file: (m) => `${m}-build-packet-sources.json`, kind: 'json', required: true },
  { id: 'build-packet-rank', file: (m) => `${m}-build-packet-rank.json`, kind: 'json', required: true },
  { id: 'build-packet-fidelity', file: (m) => `${m}-build-packet-fidelity.json`, kind: 'json', required: true },
  { id: 'build-task-manifest', file: (m) => `${m}-task-manifest.json`, kind: 'json', required: true },
  { id: 'build-test-manifest', file: (m) => `${m}-test-manifest.json`, kind: 'json', required: true },
  { id: 'build-artifacts', file: (m) => `${m}-build-artifacts.json`, kind: 'json', required: true },
  { id: 'build-gate-results', file: (m) => `${m}-gate-results.json`, kind: 'json', required: true },
  { id: 'integration-smoke', file: (m) => `${m}-integration-smoke.json`, kind: 'json', required: true },
  { id: 'deep-verification', file: (m) => `${m}-deep-verification.json`, kind: 'json', required: true },
  { id: 'illusion-report', file: (m) => `${m}-illusion-report.json`, kind: 'json', required: true },
  { id: 'build-issue-registry', file: (m) => `${m}-issues-registry.json`, kind: 'json', required: true },
];

function loadJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function loadText(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  try {
    return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return '';
  }
}

function sha256File(filePath) {
  try {
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
  } catch {
    return null;
  }
}

function normalizeRelative(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function resolvePlanningArtifact(planningDir, artifact) {
  const entry = typeof artifact === 'string' ? { name: artifact, candidates: [artifact] } : artifact;
  for (const candidate of entry.candidates || []) {
    const artifactPath = path.join(planningDir, candidate);
    if (!fs.existsSync(artifactPath)) continue;
    const stat = fs.statSync(artifactPath);
    return {
      name: entry.name,
      resolvedName: candidate,
      absolutePath: artifactPath,
      path: normalizeRelative(candidate),
      exists: true,
      size: stat.size,
    };
  }
  const fallback = entry.candidates?.[0] || entry.name;
  return {
    name: entry.name,
    resolvedName: fallback,
    absolutePath: path.join(planningDir, fallback),
    path: normalizeRelative(fallback),
    exists: false,
    size: 0,
  };
}

function readState(projectRoot) {
  return loadJson(path.join(projectRoot, 'cobolt-state.json')) || {};
}

function determineMilestone(projectRoot, options = {}) {
  if (options.milestone) return options.milestone;
  const state = readState(projectRoot);
  return state?.review?.currentMilestone || state?.build?.currentMilestone || state?.currentMilestone || null;
}

function determineReviewId(projectRoot, options = {}) {
  return options.reviewId || determineMilestone(projectRoot, options) || 'codebase';
}

function getBuildArtifacts(projectRoot, milestone) {
  if (!milestone) return null;

  const candidates = [
    path.join(projectRoot, '_cobolt-output', 'latest', 'build', milestone, `${milestone}-build-artifacts.json`),
    path.join(projectRoot, '_cobolt-output', 'latest', 'build', `${milestone}-build-artifacts.json`),
  ];

  for (const candidate of candidates) {
    const payload = loadJson(candidate);
    if (payload) {
      return {
        path: candidate,
        payload,
      };
    }
  }

  return null;
}

function getBuildPacketFidelity(projectRoot, milestone) {
  if (!milestone) return null;

  const candidate = path.join(
    projectRoot,
    '_cobolt-output',
    'latest',
    'build',
    milestone,
    `${milestone}-build-packet-fidelity.json`,
  );
  const payload = loadJson(candidate);
  if (!payload) return null;

  return {
    path: candidate,
    payload,
  };
}

function summarizeJsonPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const summary = payload.summary && typeof payload.summary === 'object' ? payload.summary : {};
  return {
    passed: payload.passed ?? payload.valid ?? payload.ok ?? summary.passed ?? null,
    status: payload.status || payload.verdict || summary.status || summary.verdict || null,
    issueCount: Array.isArray(payload.issues)
      ? payload.issues.length
      : Array.isArray(payload.findings)
        ? payload.findings.length
        : Number.isFinite(Number(summary.issues))
          ? Number(summary.issues)
          : null,
  };
}

function collectBuildHandoff(projectRoot, milestone) {
  if (!milestone) {
    return {
      milestone: null,
      artifacts: [],
      cumulativeSmoke: null,
      missingRequired: [],
    };
  }

  const buildDir = path.join(projectRoot, '_cobolt-output', 'latest', 'build', milestone);
  const artifacts = BUILD_HANDOFF_ARTIFACTS.map((entry) => {
    const absolutePath = path.join(buildDir, entry.file(milestone));
    const exists = fs.existsSync(absolutePath);
    const stat = exists ? fs.statSync(absolutePath) : null;
    const payload = entry.kind === 'json' && exists ? loadJson(absolutePath) : null;
    return {
      id: entry.id,
      required: entry.required !== false,
      path: normalizeRelative(path.relative(projectRoot, absolutePath)),
      exists,
      size: stat?.size || 0,
      sha256: exists ? sha256File(absolutePath) : null,
      summary: summarizeJsonPayload(payload),
    };
  });

  const cumulativeProofPath = path.join(
    projectRoot,
    '_cobolt-output',
    'latest',
    'build',
    'proofs',
    `${milestone}-04c-cumulative-smoke.proof.json`,
  );
  const cumulativeProof = loadJson(cumulativeProofPath);
  const cumulativeSmoke = {
    id: 'cumulative-smoke',
    required: true,
    path: normalizeRelative(path.relative(projectRoot, cumulativeProofPath)),
    exists: fs.existsSync(cumulativeProofPath),
    size: fs.existsSync(cumulativeProofPath) ? fs.statSync(cumulativeProofPath).size : 0,
    sha256: fs.existsSync(cumulativeProofPath) ? sha256File(cumulativeProofPath) : null,
    summary: summarizeJsonPayload(cumulativeProof),
  };
  artifacts.push(cumulativeSmoke);

  return {
    milestone,
    artifacts,
    cumulativeSmoke,
    missingRequired: artifacts.filter((entry) => entry.required && !entry.exists).map((entry) => entry.id),
  };
}

function resolvedCarrierFiles(projectRoot, artifact) {
  return (artifact.resolvedFiles || []).map((entry) => {
    const relativePath = normalizeRelative(entry.path);
    const absolutePath = path.join(projectRoot, relativePath.replaceAll('/', path.sep));
    const exists = Boolean(relativePath && fs.existsSync(absolutePath));
    return {
      path: relativePath,
      size: Number(entry.size || 0),
      aliasUsed: entry.aliasUsed || null,
      viaPattern: Boolean(entry.viaPattern),
      exists,
      sha256: exists ? sha256File(absolutePath) : null,
    };
  });
}

function collectReviewPacketCarrier(projectRoot, planIngestion) {
  const artifacts = (Array.isArray(planIngestion?.artifacts) ? planIngestion.artifacts : [])
    .filter((artifact) => (artifact.buildConsumers || []).includes(REVIEW_PACKET_CARRIER))
    .map((artifact) => {
      const hardBlock = artifact.gateTier === 'hard-block' || (artifact.required && artifact.critical);
      const present = artifact.present === true;
      return {
        artifactId: artifact.artifactId,
        required: artifact.required === true,
        present,
        gateTier: artifact.gateTier || null,
        hardBlock,
        status: present
          ? hardBlock
            ? 'hard-block-present'
            : 'advisory-present'
          : hardBlock
            ? 'hard-block-missing'
            : 'advisory-missing',
        critical: artifact.critical === true,
        contractSource: artifact.contractSource || null,
        sourceStage: artifact.sourceStage || null,
        buildConsumers: artifact.buildConsumers || [],
        reason: artifact.reason || null,
        resolvedFiles: resolvedCarrierFiles(projectRoot, artifact),
      };
    })
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId, undefined, { numeric: true }));

  return {
    carrier: REVIEW_PACKET_CARRIER,
    totalArtifacts: artifacts.length,
    presentArtifacts: artifacts.filter((entry) => entry.present).length,
    missingRequired: artifacts.filter((entry) => entry.required && !entry.present).map((entry) => entry.artifactId),
    hardBlockMissing: artifacts.filter((entry) => entry.hardBlock && !entry.present).map((entry) => entry.artifactId),
    advisoryMissing: artifacts.filter((entry) => !entry.hardBlock && !entry.present).map((entry) => entry.artifactId),
    artifacts,
  };
}

function categorizeFiles(files) {
  const categories = {
    api: [],
    ui: [],
    database: [],
    config: [],
    tests: [],
    infra: [],
    security: [],
    docs: [],
    other: [],
  };

  for (const filePath of files || []) {
    const normalized = normalizeRelative(filePath);
    if (/(^|\/)(test|tests|spec|__tests__)(\/|$)|\.(test|spec)\./i.test(normalized)) {
      categories.tests.push(normalized);
    } else if (/(^|\/)(api|routes?|controllers?|handlers?|routers?)(\/|$)/i.test(normalized)) {
      categories.api.push(normalized);
    } else if (
      /\.(tsx|jsx|vue|svelte|html|heex|leex|css)$/i.test(normalized) ||
      /(^|\/)(components|pages|views|templates|live)(\/|$)/i.test(normalized)
    ) {
      categories.ui.push(normalized);
    } else if (/(^|\/)(migrations|schemas|models|repo|seeds)(\/|$)|\.sql$/i.test(normalized)) {
      categories.database.push(normalized);
    } else if (/(^|\/)(config|settings)(\/|$)|\.(json|ya?ml|toml|env|exs)$/i.test(normalized)) {
      categories.config.push(normalized);
    } else if (/(^|\/)(docker|k8s|helm|terraform|iac)(\/|$)|(^|\/)docker-compose|Dockerfile|\.tf$/i.test(normalized)) {
      categories.infra.push(normalized);
    } else if (/(^|\/)(auth|authorization|middleware|guards|policies|csrf|rate[-_]?limit)(\/|$)/i.test(normalized)) {
      categories.security.push(normalized);
    } else if (/(^|\/)(docs?)(\/|$)|\.md$/i.test(normalized)) {
      categories.docs.push(normalized);
    } else {
      categories.other.push(normalized);
    }
  }

  return Object.fromEntries(
    Object.entries(categories).map(([key, value]) => [key, value.sort((a, b) => a.localeCompare(b))]),
  );
}

function collectPlanningArtifacts(projectRoot) {
  const planningDir = path.join(projectRoot, '_cobolt-output', 'latest', 'planning');
  return PLANNING_ARTIFACTS.map((artifact) => {
    const resolved = resolvePlanningArtifact(planningDir, artifact);
    return {
      name: resolved.name,
      resolvedName: resolved.resolvedName,
      path: normalizeRelative(path.relative(projectRoot, resolved.absolutePath)),
      exists: resolved.exists,
      size: resolved.size,
    };
  });
}

function findPlanningArtifact(projectRoot, ...candidates) {
  const planningDir = path.join(projectRoot, '_cobolt-output', 'latest', 'planning');
  return resolvePlanningArtifact(planningDir, { name: candidates[0], candidates });
}

function summarizePlanningGrounding(projectRoot, milestone) {
  const complianceJson = loadJson(findPlanningArtifact(projectRoot, 'compliance-register.json').absolutePath) || {};
  const complianceText = loadText(findPlanningArtifact(projectRoot, 'compliance-register.md').absolutePath);
  const frameworks = unique([
    ...(Array.isArray(complianceJson.frameworks)
      ? complianceJson.frameworks.map((entry) =>
          typeof entry === 'string' ? entry : entry?.id || entry?.framework || entry?.name || entry?.label,
        )
      : []),
    ...(
      complianceText.match(/\b(?:GDPR|SOC ?2|HIPAA|DPDP|PCI(?:-|\s)?DSS|FedRAMP|ISO ?27001|CCPA|LGPD)\b/gi) || []
    ).map((value) => value.replace(/\s+/g, ' ').trim()),
  ]);
  const controls = Array.isArray(complianceJson.controls) ? complianceJson.controls : [];
  const domainDoc = findPlanningArtifact(projectRoot, 'domain-knowledge-base.md', 'domain-knowledge.md');
  const domainText = loadText(domainDoc.absolutePath);
  const domainTerms = unique([
    ...(domainText.match(/\*\*([^*]{2,40})\*\*/g) || []).map((value) => value.replace(/\*\*/g, '').trim()),
    ...domainText
      .split(/\r?\n/u)
      .map((line) => line.match(/^\s*[-*]?\s*`?([A-Za-z][A-Za-z0-9/&() +_-]{2,40})`?\s*:/u)?.[1] || null),
  ]).slice(0, 10);
  const wireframesDoc = findPlanningArtifact(projectRoot, 'wireframes-and-user-flows.md');
  const wireframesText = loadText(wireframesDoc.absolutePath);
  const wireframeHeadings = wireframesText
    .split(/\r?\n/u)
    .filter((line) => /^#{2,4}\s+/.test(line))
    .map((line) => line.replace(/^#{2,4}\s+/u, '').trim())
    .slice(0, 6);
  const capabilityIndex =
    loadJson(findPlanningArtifact(projectRoot, 'capability-contracts-index.json').absolutePath) || {};
  const capabilityContracts = Array.isArray(capabilityIndex.contracts) ? capabilityIndex.contracts : [];
  const milestoneExecution =
    loadJson(findPlanningArtifact(projectRoot, 'milestone-execution-obligations.json').absolutePath) || {};
  const planIngestionPath =
    milestone &&
    path.join(projectRoot, '_cobolt-output', 'latest', 'build', milestone, `${milestone}-plan-ingestion-manifest.json`);
  const planIngestion = planIngestionPath && fs.existsSync(planIngestionPath) ? loadJson(planIngestionPath) : null;

  return {
    compliance: {
      frameworks,
      activeControls: controls.filter((control) => !/(?:not[_ -]?applicable|n\/a)/i.test(String(control.status || '')))
        .length,
      controlCount: controls.length,
      obligations: controls.slice(0, 4).map((control, index) => ({
        id: control.id || control.controlId || `CTRL-${String(index + 1).padStart(3, '0')}`,
        acceptance:
          control.acceptanceCriterion || control.acceptance || control.summary || control.implementationPattern || null,
      })),
    },
    domainVocabulary: {
      path: domainDoc.exists ? domainDoc.path : null,
      terms: domainTerms,
    },
    wireframes: {
      path: wireframesDoc.exists ? wireframesDoc.path : null,
      headings: wireframeHeadings,
    },
    capabilityContracts: {
      totalFeatures: Number(capabilityIndex.totalFeatures || capabilityContracts.length || 0),
      readyCount: capabilityContracts.filter((entry) => String(entry.status || '').toUpperCase() === 'READY').length,
      features: capabilityContracts.slice(0, 5).map((entry) => ({
        featureId: entry.featureId || null,
        status: entry.status || 'UNKNOWN',
      })),
    },
    milestoneExecution: {
      status: milestoneExecution.status || null,
      enhancementCount: Array.isArray(milestoneExecution.enhancementQueue)
        ? milestoneExecution.enhancementQueue.length
        : 0,
      driftDetectors: Array.isArray(milestoneExecution.driftDetectors) ? milestoneExecution.driftDetectors.length : 0,
    },
    planIngestion: planIngestion
      ? {
          path: normalizeRelative(path.relative(projectRoot, planIngestionPath)),
          requiredArtifacts: planIngestion.summary?.requiredArtifacts || 0,
          missingRequired: planIngestion.summary?.missingRequired || 0,
          contractGaps: planIngestion.summary?.contractGaps || 0,
          carriers: planIngestion.summary?.carriers || {},
          reviewPacketCarrier: collectReviewPacketCarrier(projectRoot, planIngestion),
        }
      : null,
  };
}

function collectGateFailures(reviewDir) {
  const payload = loadJson(path.join(reviewDir, 'gate-failures.json'));
  if (!payload) return [];
  return Array.isArray(payload.gates) ? payload.gates : [];
}

function detectBrowserEvidence(projectRoot) {
  const buildDir = path.join(projectRoot, '_cobolt-output', 'latest', 'build');
  const browserSmoke = path.join(buildDir, 'browser-smoke.json');
  const runSummary = path.join(buildDir, 'run-summary.json');
  return {
    hasBrowserSmoke: fs.existsSync(browserSmoke),
    hasRunSummary: fs.existsSync(runSummary),
    browserSmokePath: fs.existsSync(browserSmoke) ? normalizeRelative(path.relative(projectRoot, browserSmoke)) : null,
    runSummaryPath: fs.existsSync(runSummary) ? normalizeRelative(path.relative(projectRoot, runSummary)) : null,
  };
}

function collectPriorSignals(reviewDir) {
  const readiness = loadJson(path.join(reviewDir, 'review-readiness-gate.json'));
  const accuracy = loadJson(path.join(reviewDir, 'review-accuracy-report.json'));
  const crossValidation = loadJson(path.join(reviewDir, 'cross-validation-report.json'));
  return {
    readinessPassed: readiness?.passed ?? null,
    accuracyPassed: accuracy?.passed ?? null,
    priorPhantomRate: crossValidation?.phantomRate ?? null,
  };
}

function initializeReviewManifest(reviewDir, reviewId, milestone, mode) {
  const manifestPath = path.join(reviewDir, 'review-manifest.json');
  const existing = loadJson(manifestPath);
  const base = existing && typeof existing === 'object' ? existing : {};

  const manifest = {
    version: '2.0.0',
    generatedAt: base.generatedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    reviewId,
    milestone: milestone || reviewId,
    mode,
    phase: base.phase || 'P0',
    dispatched: Array.isArray(base.dispatched) ? base.dispatched : [],
    completed: Array.isArray(base.completed) ? base.completed : [],
    failed: Array.isArray(base.failed) ? base.failed : [],
    reviewedFiles: Array.isArray(base.reviewedFiles) ? base.reviewedFiles : [],
    findingsFiles: Array.isArray(base.findingsFiles) ? base.findingsFiles : [],
    waves: base.waves && typeof base.waves === 'object' ? base.waves : {},
  };

  fs.mkdirSync(reviewDir, { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return {
    manifest,
    manifestPath,
  };
}

function buildPacketMarkdown(packet, projectRoot) {
  const lines = [
    '# Review Packet',
    '',
    `Generated: ${packet.generatedAt}`,
    `Review ID: ${packet.reviewId}`,
    `Milestone: ${packet.milestone || 'none'}`,
    `Mode: ${packet.mode}`,
    '',
    '## Scope',
    '',
    `- Source manifest: ${packet.sourceManifest.path}`,
    `- Files in scope: ${packet.scope.totalFiles}`,
    `- Changed files: ${packet.scope.changedFiles.length}`,
    '',
    '## Category Counts',
    '',
  ];

  for (const [category, files] of Object.entries(packet.scope.categories)) {
    lines.push(`- ${category}: ${files.length}`);
  }

  lines.push('', '## Planning Artifacts', '');
  for (const artifact of packet.planningArtifacts) {
    lines.push(`- ${artifact.exists ? '[x]' : '[ ]'} ${artifact.name} (${artifact.path})`);
  }

  lines.push('', '## Browser Evidence', '');
  lines.push(`- Browser smoke: ${packet.browserEvidence.hasBrowserSmoke ? 'present' : 'missing'}`);
  lines.push(`- Run summary: ${packet.browserEvidence.hasRunSummary ? 'present' : 'missing'}`);

  lines.push('', '## Planning Grounding', '');
  lines.push(
    `- Compliance frameworks: ${packet.planningGrounding.compliance.frameworks.join(', ') || 'none declared'}`,
  );
  lines.push(
    `- Compliance controls: ${packet.planningGrounding.compliance.activeControls}/${packet.planningGrounding.compliance.controlCount}`,
  );
  lines.push(
    `- Capability contracts: ${packet.planningGrounding.capabilityContracts.readyCount}/${packet.planningGrounding.capabilityContracts.totalFeatures} ready`,
  );
  lines.push(
    `- Domain vocabulary terms: ${packet.planningGrounding.domainVocabulary.terms.join(', ') || 'none extracted'}`,
  );
  lines.push(
    `- Wireframe headings: ${packet.planningGrounding.wireframes.headings.join(' | ') || 'wireframes not present'}`,
  );
  lines.push(
    `- Milestone execution obligations: ${packet.planningGrounding.milestoneExecution.status || 'missing'}; enhancements=${packet.planningGrounding.milestoneExecution.enhancementCount || 0}; driftDetectors=${packet.planningGrounding.milestoneExecution.driftDetectors || 0}`,
  );
  if (packet.planningGrounding.planIngestion) {
    lines.push(
      `- Plan ingestion: required=${packet.planningGrounding.planIngestion.requiredArtifacts}; missingRequired=${packet.planningGrounding.planIngestion.missingRequired}; contractGaps=${packet.planningGrounding.planIngestion.contractGaps}`,
    );
    const carrier = packet.planningGrounding.planIngestion.reviewPacketCarrier;
    if (carrier) {
      lines.push(
        `- Review-packet carrier: artifacts=${carrier.totalArtifacts}; hardBlockMissing=${carrier.hardBlockMissing.length}; advisoryMissing=${carrier.advisoryMissing.length}`,
      );
    }
  }

  if (packet.buildHandoff) {
    lines.push('', '## Build Handoff', '');
    lines.push(`- Missing required handoff artifacts: ${packet.buildHandoff.missingRequired.join(', ') || 'none'}`);
    for (const artifact of packet.buildHandoff.artifacts) {
      lines.push(`- ${artifact.exists ? '[x]' : '[ ]'} ${artifact.id} (${artifact.path})`);
    }
  }

  if (packet.reviewPacketCarrier) {
    lines.push('', '## Review Packet Carriers', '');
    for (const artifact of packet.reviewPacketCarrier.artifacts) {
      lines.push(
        `- ${artifact.present ? '[x]' : '[ ]'} ${artifact.artifactId}: ${artifact.gateTier || 'unknown'} ${artifact.status}`,
      );
    }
  }

  lines.push('', '## Prior Signals', '');
  lines.push(`- Readiness passed: ${packet.priorSignals.readinessPassed}`);
  lines.push(`- Accuracy passed: ${packet.priorSignals.accuracyPassed}`);
  lines.push(`- Prior phantom rate: ${packet.priorSignals.priorPhantomRate}`);

  if (packet.buildPacketFidelity) {
    lines.push('', '## Build Handoff Fidelity', '');
    lines.push(`- Valid: ${packet.buildPacketFidelity.valid}`);
    lines.push(`- Missing stories: ${packet.buildPacketFidelity.missingStories.length}`);
    lines.push(`- Missing manifest fields: ${packet.buildPacketFidelity.missingManifestFields.length}`);
    lines.push(`- Missing packet signals: ${packet.buildPacketFidelity.missingPacketSignals.length}`);
    lines.push(`- Enhancement queue: ${packet.buildPacketFidelity.enhancementCount}`);
  }

  if (packet.scope.changedFiles.length > 0) {
    lines.push('', '## Changed File Preview', '');
    for (const filePath of packet.scope.changedFiles.slice(0, 50)) {
      lines.push(`- ${filePath}`);
    }
    if (packet.scope.changedFiles.length > 50) {
      lines.push(`- ... ${packet.scope.changedFiles.length - 50} more`);
    }
  }

  lines.push('', '## Grounding Reminder', '');
  lines.push(
    `- Treat ${normalizeRelative(path.relative(projectRoot, packet.sourceManifest.absolutePath))} as the canonical source list until you read more files directly.`,
  );

  return `${lines.join('\n')}\n`;
}

function buildReviewPacket(projectRoot, options = {}) {
  const root = path.resolve(projectRoot || process.cwd());
  const reviewDir = path.resolve(options.reviewDir || defaultReviewDir(root));
  const milestone = determineMilestone(root, options);
  const reviewId = determineReviewId(root, options);
  const mode = options.mode || 'standalone';

  const manifestResult = writeReviewFileManifest(root, {
    outputPath: path.join(reviewDir, '00-source-file-manifest.json'),
  });

  const buildArtifacts = getBuildArtifacts(root, milestone);
  const buildPacketFidelity = getBuildPacketFidelity(root, milestone);
  const changedFiles = [
    ...new Set([
      ...(buildArtifacts?.payload?.filesCreated || []).map(normalizeRelative),
      ...(buildArtifacts?.payload?.filesModified || []).map(normalizeRelative),
      ...(buildArtifacts?.payload?.sourceWriteProvenance || []).map(normalizeRelative),
    ]),
  ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const filesInScope = changedFiles.length > 0 ? changedFiles : manifestResult.manifest.files;
  const categories = categorizeFiles(filesInScope);
  const planningArtifacts = collectPlanningArtifacts(root);
  const planningGrounding = summarizePlanningGrounding(root, milestone);
  const buildHandoff = collectBuildHandoff(root, milestone);
  const browserEvidence = detectBrowserEvidence(root);
  const priorSignals = collectPriorSignals(reviewDir);
  const gateFailures = collectGateFailures(reviewDir);
  const reviewManifest = initializeReviewManifest(reviewDir, reviewId, milestone, mode);

  const packet = {
    version: '2.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-review-packet',
    projectRoot: root,
    reviewDir,
    reviewId,
    milestone: milestone || reviewId,
    mode,
    sourceManifest: {
      path: normalizeRelative(path.relative(root, manifestResult.outputPath)),
      absolutePath: manifestResult.outputPath,
      totalFiles: manifestResult.manifest.totalFiles,
    },
    scope: {
      totalFiles: filesInScope.length,
      changedFiles,
      filesInScope,
      categories,
      source: changedFiles.length > 0 ? 'build-artifacts' : 'source-manifest',
    },
    planningArtifacts,
    planningGrounding,
    buildHandoff,
    reviewPacketCarrier: planningGrounding.planIngestion?.reviewPacketCarrier || null,
    browserEvidence,
    gateFailures,
    priorSignals,
    reviewManifest: {
      path: normalizeRelative(path.relative(root, reviewManifest.manifestPath)),
    },
    buildArtifacts: buildArtifacts
      ? {
          path: normalizeRelative(path.relative(root, buildArtifacts.path)),
          filesCreated: (buildArtifacts.payload.filesCreated || []).length,
          filesModified: (buildArtifacts.payload.filesModified || []).length,
        }
      : null,
    buildPacketFidelity: buildPacketFidelity
      ? {
          path: normalizeRelative(path.relative(root, buildPacketFidelity.path)),
          valid: buildPacketFidelity.payload.valid !== false,
          missingStories:
            buildPacketFidelity.payload.missingStoryIds || buildPacketFidelity.payload.missingStories || [],
          missingManifestFields: buildPacketFidelity.payload.missingManifestFields || [],
          missingPacketSignals: buildPacketFidelity.payload.missingPacketSignals || [],
          enhancementCount: Number(
            buildPacketFidelity.payload.enhancementCount ??
              (Array.isArray(buildPacketFidelity.payload.enhancementQueue)
                ? buildPacketFidelity.payload.enhancementQueue.length
                : 0),
          ),
        }
      : null,
  };

  const packetPath = path.join(reviewDir, `${reviewId}-review-packet.json`);
  const markdownPath = path.join(reviewDir, `${reviewId}-review-packet.md`);

  fs.mkdirSync(reviewDir, { recursive: true });
  fs.writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, 'utf8');
  fs.writeFileSync(markdownPath, buildPacketMarkdown(packet, root), 'utf8');

  return {
    packet,
    packetPath,
    markdownPath,
    manifestPath: manifestResult.outputPath,
    reviewManifestPath: reviewManifest.manifestPath,
  };
}

function main() {
  const args = process.argv.slice(2);
  maybePrintHelpAndExit(args, USAGE);
  const command = args[0] || 'build';
  const dirIdx = args.indexOf('--dir');
  const projectRoot = dirIdx !== -1 && args[dirIdx + 1] ? path.resolve(args[dirIdx + 1]) : process.cwd();
  const reviewIdIdx = args.indexOf('--review-id');
  const milestoneIdx = args.indexOf('--milestone');
  const modeIdx = args.indexOf('--mode');
  const reviewDirIdx = args.indexOf('--review-dir');
  const jsonMode = args.includes('--json');

  if (command !== 'build') {
    console.log('CoBolt Review Packet');
    console.log('');
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }

  const result = buildReviewPacket(projectRoot, {
    reviewDir: reviewDirIdx !== -1 && args[reviewDirIdx + 1] ? args[reviewDirIdx + 1] : undefined,
    reviewId: reviewIdIdx !== -1 && args[reviewIdIdx + 1] ? args[reviewIdIdx + 1] : undefined,
    milestone: milestoneIdx !== -1 && args[milestoneIdx + 1] ? args[milestoneIdx + 1] : undefined,
    mode: modeIdx !== -1 && args[modeIdx + 1] ? args[modeIdx + 1] : undefined,
  });

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          packetPath: result.packetPath,
          markdownPath: result.markdownPath,
          manifestPath: result.manifestPath,
          reviewManifestPath: result.reviewManifestPath,
          packet: result.packet,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log('[cobolt-review-packet] Review Packet');
  console.log(`  Review ID: ${result.packet.reviewId}`);
  console.log(`  Milestone: ${result.packet.milestone}`);
  console.log(`  Packet: ${result.packetPath}`);
  console.log(`  Markdown: ${result.markdownPath}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildReviewPacket,
  categorizeFiles,
  collectBuildHandoff,
  collectPlanningArtifacts,
  collectReviewPacketCarrier,
  determineMilestone,
  determineReviewId,
};
