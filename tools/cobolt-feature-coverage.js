#!/usr/bin/env node

// CoBolt Feature Coverage - deterministic feature dossier and per-feature readiness gate.
//
// This tool validates the mandatory feature-analysis packet produced after PRD
// validation. It is intentionally strict: every feature must have source
// traceability, evidence levels, cross-layer coverage, a dossier, and a service
// blueprint. In final mode it also checks that downstream spec-first planning
// artifacts mention each feature before stories/build are authorized.

const fs = require('node:fs');
const path = require('node:path');
const {
  extractRequirementDefinitions,
  normalizeRequirementId,
  canonicalizeRequirementId,
} = require('../lib/cobolt-requirements');
const { getPlanningDir } = require('../lib/cobolt-planning-artifacts');
const { getSourceRequirementSet } = require('./cobolt-source-coverage');

const ALLOWED_EVIDENCE_LEVELS = new Set(['STATED', 'INFERRED', 'DOMAIN_DEFAULT', 'RECOMMENDED', 'ASSUMPTION']);

const REQUIRED_LAYERS = [
  {
    key: 'productIntent',
    label: 'Product intent',
    aliases: ['productIntent', 'intent', 'userGoal', 'userValue'],
  },
  {
    key: 'userFlow',
    label: 'User flow / journey map',
    aliases: ['userFlow', 'userFlows', 'journey', 'journeys', 'journeyMap'],
  },
  {
    key: 'ui',
    label: 'UI surfaces',
    aliases: ['ui', 'uiScreens', 'screens', 'frontend'],
  },
  {
    key: 'uiStates',
    label: 'UI states',
    aliases: ['uiStates', 'states', 'emptyLoadingErrorStates'],
  },
  {
    key: 'wireframes',
    label: 'Wireframes',
    aliases: ['wireframes', 'wireframe', 'screenSequences'],
  },
  {
    key: 'backend',
    label: 'Backend services',
    aliases: ['backend', 'backendServices', 'services', 'serviceLayer'],
  },
  {
    key: 'middleware',
    label: 'Middleware / entrypoint wiring',
    aliases: ['middleware', 'entrypointWiring', 'routing', 'router'],
  },
  {
    key: 'api',
    label: 'API contracts',
    aliases: ['api', 'apiContracts', 'endpoints', 'openapi'],
  },
  {
    key: 'data',
    label: 'Data model',
    aliases: ['data', 'dataModel', 'entities', 'database'],
  },
  {
    key: 'integrations',
    label: 'Integrations',
    aliases: ['integrations', 'externalSystems', 'dependencies'],
  },
  {
    key: 'auth',
    label: 'Authentication / authorization',
    aliases: ['auth', 'authn', 'authz', 'authorization', 'rbac'],
  },
  {
    key: 'security',
    label: 'Security controls',
    aliases: ['security', 'securityControls', 'threatModel', 'asvs'],
  },
  {
    key: 'privacy',
    label: 'Privacy / compliance',
    aliases: ['privacy', 'compliance', 'dataProtection'],
  },
  {
    key: 'nfrs',
    label: 'Non-functional requirements',
    aliases: ['nfrs', 'nonFunctionalRequirements', 'performance', 'resilience'],
  },
  {
    key: 'observability',
    label: 'Observability',
    aliases: ['observability', 'logging', 'metrics', 'alerts', 'telemetry'],
  },
  {
    key: 'tests',
    label: 'Tests',
    aliases: ['tests', 'testScenarios', 'testStrategy', 'acceptanceTests'],
  },
  {
    key: 'rollout',
    label: 'Rollout / release',
    aliases: ['rollout', 'delivery', 'release', 'featureFlags'],
  },
  {
    key: 'acceptanceCriteria',
    label: 'Executable acceptance criteria',
    aliases: ['acceptanceCriteria', 'bdd', 'gherkin', 'scenarios'],
  },
  {
    key: 'serviceBlueprint',
    label: 'Service blueprint',
    aliases: ['serviceBlueprint', 'blueprint', 'supportFlow'],
  },
  {
    key: 'specContracts',
    label: 'Spec-first contracts',
    aliases: ['specContracts', 'contracts', 'contractTargets'],
  },
  {
    key: 'accessibility',
    label: 'Accessibility',
    aliases: ['accessibility', 'a11y', 'wcag'],
  },
  {
    key: 'architecture',
    label: 'Architecture coverage',
    aliases: ['architecture', 'c4', 'components', 'containers'],
  },
];

const FINAL_LAYER_ARTIFACTS = {
  architecture: ['architecture.md', 'system-architecture.md'],
  backend: ['architecture.md', 'system-architecture.md'],
  middleware: ['system-architecture.md', 'api-contracts.md'],
  api: ['api-contracts.md'],
  data: ['data-model-spec.md'],
  auth: ['security-requirements.md', 'api-contracts.md'],
  security: ['security-requirements.md'],
  privacy: ['security-requirements.md', 'domain-knowledge-base.md'],
  integrations: ['dependency-register.md', 'system-architecture.md'],
  observability: ['trd.md', 'delivery-plan.md', 'test-strategy.md'],
  tests: ['test-strategy.md', 'epics.md'],
  rollout: ['delivery-plan.md', 'release-readiness-checklist.md'],
  ui: ['ux-design-specification.md'],
  uiStates: ['ux-design-specification.md', 'implicit-requirements.md'],
  wireframes: ['wireframes-and-user-flows.md'],
  accessibility: ['ux-design-specification.md', 'wireframes-and-user-flows.md'],
  serviceBlueprint: ['feature-service-blueprints.md', 'system-architecture.md'],
  specContracts: ['api-contracts.md', 'data-model-spec.md', 'security-requirements.md', 'ux-design-specification.md'],
};

function resolvePlanningDir(projectRoot = process.cwd(), explicitPlanningDir = null) {
  if (explicitPlanningDir) return path.resolve(projectRoot, explicitPlanningDir);
  return (
    getPlanningDir(projectRoot, { create: false, strict: false, fallbackToLatest: true }) ||
    path.join(projectRoot, '_cobolt-output', 'latest', 'planning')
  );
}

function outputPath(planningDir, fileName) {
  return path.join(planningDir, fileName);
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return '';
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(readText(filePath));
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizeFeatureId(value) {
  const match = String(value || '')
    .trim()
    .match(/FEAT-\d+/i);
  return match ? match[0].toUpperCase() : '';
}

function normalizeEvidenceLevel(value) {
  if (Array.isArray(value)) {
    const normalized = value.map((entry) => normalizeEvidenceLevel(entry)).filter(Boolean);
    return normalized[0] || '';
  }
  if (value && typeof value === 'object') {
    return normalizeEvidenceLevel(value.evidenceLevel || value.level || value.sourceType || value.type);
  }
  const normalized = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  if (normalized === 'DOMAIN') return 'DOMAIN_DEFAULT';
  if (normalized === 'DOMAIN_DEFAULTS') return 'DOMAIN_DEFAULT';
  if (normalized === 'ASSUMED') return 'ASSUMPTION';
  // v0.46 — docs-driven plan aliases. A source-driven planning pack
  // (--from-folder) writes "source-documented" / "documented" / "from-source"
  // because the PRD/TRD/feature-dossier is the authoritative stated source.
  // Map these to STATED so the feature-coverage gate passes for docs-driven
  // runs without forcing the user to know the internal allowlist.
  if (normalized === 'SOURCE_DOCUMENTED') return 'STATED';
  if (normalized === 'DOCUMENTED') return 'STATED';
  if (normalized === 'FROM_SOURCE') return 'STATED';
  if (normalized === 'SRC') return 'STATED';
  return ALLOWED_EVIDENCE_LEVELS.has(normalized) ? normalized : '';
}

function normalizeStatus(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (['n/a', 'na', 'not_applicable', 'notapplicable'].includes(normalized)) return 'not_applicable';
  if (['covered', 'ready', 'specified', 'planned', 'complete', 'present', 'yes'].includes(normalized)) return 'covered';
  if (['missing', 'blank', 'todo', 'unknown', 'gap'].includes(normalized)) return 'missing';
  return normalized;
}

function isBlank(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return value
      .split(/[,;\n]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function collectFeatureSourceIds(feature) {
  return [
    ...asArray(feature.sourceIds),
    ...asArray(feature.sourceIDs),
    ...asArray(feature.requirementIds),
    ...asArray(feature.frIds),
    ...asArray(feature.nfrIds),
    ...asArray(feature.trIds),
    ...asArray(feature.irIds),
  ]
    .map(
      // v0.66.5 (Wave 1 B-2): canonicalize requirement-grammar ids (FR/NFR/TR/IR/TRD/ADR)
      // to 3-digit form at producer time so brownfield-derived FR-01 inputs match
      // PRD-derived FR-001 lookups. Falls back to normalizeRequirementId for non-grammar
      // ids (SRC-NNN, custom prefixes) which canonicalize() returns null for.
      (id) =>
        canonicalizeRequirementId(id) ||
        normalizeRequirementId(id) ||
        String(id || '')
          .trim()
          .toUpperCase(),
    )
    .filter(Boolean);
}

/**
 * Detect common feature-registry schema-drift field names and emit a
 * diagnostic hint. Closes CB-OBS-05 surfaced in Rdrive101 end-to-end run:
 * when a producer uses `sources` (plural, unscoped) instead of the canonical
 * `sourceIds`, the tool falls back to coverage analysis and emits 150+
 * cryptic "unmapped SRC-NNN" errors. A single field-drift hint lets the
 * producer fix the root cause in one edit instead of guessing. Schema:
 * source/schemas/feature-registry.schema.json ($defs.feature) — sourceIds
 * is explicitly pinned NOT srcIds / sources.
 */
function detectFeatureRegistryFieldDrift(registry) {
  if (!registry || !Array.isArray(registry.features)) return null;
  const drifts = [];
  const knownAliases = ['sourceIds', 'sourceIDs', 'requirementIds', 'frIds', 'nfrIds', 'trIds', 'irIds'];
  const driftCandidates = ['sources', 'srcIds', 'srcIDs', 'prdRefs', 'prdIds', 'requirementIDs', 'reqIds'];
  for (const feat of registry.features) {
    if (!feat || typeof feat !== 'object') continue;
    // Does this feature have any source IDs under any canonical alias?
    const hasCanonical = knownAliases.some((k) => Array.isArray(feat[k]) && feat[k].length > 0);
    if (hasCanonical) continue;
    // None canonical — check for drift candidates.
    for (const candidate of driftCandidates) {
      if (Array.isArray(feat[candidate]) && feat[candidate].length > 0) {
        drifts.push({
          featureId: feat.featureId || feat.id || '<unidentified>',
          usedField: candidate,
          canonicalField: 'sourceIds',
          schema: 'source/schemas/feature-registry.schema.json ($defs.feature.properties.sourceIds)',
        });
        break;
      }
    }
  }
  return drifts.length > 0 ? drifts : null;
}

function getLayerValue(feature, layer) {
  const containers = [feature.coverage, feature.layers, feature.layerCoverage].filter(Boolean);
  for (const container of containers) {
    for (const alias of layer.aliases) {
      if (Object.hasOwn(container, alias)) return container[alias];
    }
    if (Object.hasOwn(container, layer.key)) return container[layer.key];
  }
  for (const alias of layer.aliases) {
    if (Object.hasOwn(feature, alias)) return feature[alias];
  }
  return undefined;
}

function summarizeLayerValue(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value))
    return value.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('; ');
  if (value && typeof value === 'object') {
    return value.summary || value.details || value.description || value.reason || value.status || JSON.stringify(value);
  }
  return '';
}

function analyzeLayer(feature, layer) {
  const value = getLayerValue(feature, layer);
  if (isBlank(value)) {
    return {
      key: layer.key,
      label: layer.label,
      status: 'missing',
      present: false,
      issues: [`${layer.label} is blank`],
      evidenceLevel: '',
      assumption: false,
      notApplicable: false,
      summary: '',
    };
  }

  let status = '';
  let evidenceLevel = '';
  let reason = '';
  const summary = summarizeLayerValue(value);

  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (/^(n\/a|na|not applicable)\b/.test(lowered)) {
      status = 'not_applicable';
      reason = value.replace(/^(n\/a|na|not applicable)\s*[:-]?\s*/i, '').trim();
    } else {
      status = 'covered';
    }
  } else if (Array.isArray(value)) {
    status = value.length > 0 ? 'covered' : 'missing';
    evidenceLevel = normalizeEvidenceLevel(value.map((entry) => entry?.evidenceLevel || entry?.level));
  } else if (value && typeof value === 'object') {
    status = normalizeStatus(value.status || value.coverage || value.state || value.readiness);
    evidenceLevel = normalizeEvidenceLevel(value.evidenceLevel || value.level || value.sourceType);
    reason = String(value.reason || value.naReason || value.notApplicableReason || '').trim();
    if (!status) {
      status = value.notApplicable === true || value.na === true ? 'not_applicable' : 'covered';
    }
  }

  const issues = [];
  const notApplicable = status === 'not_applicable';
  if (status === 'missing') issues.push(`${layer.label} is explicitly marked missing`);
  if (notApplicable && reason.length < 8) {
    issues.push(`${layer.label} is N/A but has no concrete reason`);
  }
  const assumption =
    evidenceLevel === 'ASSUMPTION' || (value && typeof value === 'object' && value.assumption === true);

  return {
    key: layer.key,
    label: layer.label,
    status: notApplicable ? 'not_applicable' : status || 'covered',
    present: status !== 'missing',
    issues,
    evidenceLevel,
    assumption,
    notApplicable,
    summary,
  };
}

function loadFeatureRegistry(planningDir) {
  const registryPath = outputPath(planningDir, 'feature-registry.json');
  const registry = readJson(registryPath);
  if (!registry) {
    return {
      registryPath,
      registry: null,
      features: [],
      issues: ['feature-registry.json is missing or invalid JSON'],
    };
  }

  const features = Array.isArray(registry)
    ? registry
    : Array.isArray(registry.features)
      ? registry.features
      : Array.isArray(registry.featureRegistry)
        ? registry.featureRegistry
        : [];

  return {
    registryPath,
    registry,
    features,
    issues: features.length === 0 ? ['feature-registry.json has no features array'] : [],
  };
}

function loadDossier(planningDir, feature) {
  const featureId = normalizeFeatureId(feature.featureId || feature.id);
  const configuredPath = feature.dossierPath || feature.featureDossierPath || null;
  const candidates = [
    configuredPath ? path.resolve(planningDir, configuredPath) : null,
    path.join(planningDir, 'feature-dossiers', `${featureId}.md`),
    path.join(planningDir, 'feature-dossiers', `${featureId.toLowerCase()}.md`),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const content = readText(candidate);
    return {
      path: candidate,
      relativePath: path.relative(planningDir, candidate).replaceAll('\\', '/'),
      exists: true,
      size: Buffer.byteLength(content),
      content,
    };
  }

  return {
    path: candidates[0],
    relativePath: candidates[0] ? path.relative(planningDir, candidates[0]).replaceAll('\\', '/') : '',
    exists: false,
    size: 0,
    content: '',
  };
}

function loadServiceBlueprints(planningDir) {
  const blueprintPath = outputPath(planningDir, 'feature-service-blueprints.md');
  const content = readText(blueprintPath);
  return {
    path: blueprintPath,
    exists: fs.existsSync(blueprintPath),
    size: Buffer.byteLength(content),
    content,
  };
}

function loadRequiredSourceIds(projectRoot, planningDir) {
  const issues = [];
  const required = new Map();
  const sourceSet = getSourceRequirementSet({ projectRoot, planningDir });

  if (sourceSet.skipped) {
    issues.push(
      'Source Requirement Registry is mandatory for feature analysis. Create source-document-consolidation.md with SRC-NNN rows before continuing.',
    );
  } else if (!sourceSet.passed) {
    issues.push(sourceSet.reason || 'Source requirement set could not be loaded.');
    for (const issue of sourceSet.issues || []) issues.push(issue);
  } else {
    for (const entry of sourceSet.entries || []) {
      required.set(entry.id.toUpperCase(), {
        id: entry.id.toUpperCase(),
        source: 'source-document-consolidation',
        summary: entry.summary || '',
      });
    }
  }

  const prdPath = outputPath(planningDir, 'prd.md');
  if (fs.existsSync(prdPath)) {
    for (const definition of extractRequirementDefinitions(readText(prdPath))) {
      // v0.66.5 (Wave 1 B-2): canonicalize PRD-extracted requirement ids so the
      // required-set keys match the canonical form emitted by collectFeatureSourceIds.
      // Without this, PRD `FR-1` and feature-registry `FR-001` keyed two different
      // entries in `required` and downstream `unmapped` reported phantom misses.
      const id = canonicalizeRequirementId(definition.id) || normalizeRequirementId(definition.id);
      if (!id) continue;
      if (/^(FR|NFR)(?:-[A-Z0-9]{1,8})?-\d+/i.test(id)) {
        required.set(id, {
          id,
          source: 'prd',
          summary: definition.title || definition.description || '',
        });
      }
    }
  }

  return {
    ids: [...required.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    entries: [...required.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })),
    issues,
    sourceSet,
  };
}

function referencesFeature(text, feature, sourceIds) {
  const haystack = String(text || '').toLowerCase();
  const title = String(feature.title || feature.name || '')
    .trim()
    .toLowerCase();
  const featureId = normalizeFeatureId(feature.featureId || feature.id).toLowerCase();
  if (featureId && haystack.includes(featureId)) return true;
  if (title && title.length > 3 && haystack.includes(title)) return true;
  return sourceIds.some((id) => haystack.includes(String(id).toLowerCase()));
}

function analyzeFinalArtifactCoverage(planningDir, feature, sourceIds, layerResults, opts = {}) {
  const issues = [];
  const coverage = {};
  const allowDeferredOuter = opts.allowDeferred === true;

  for (const layer of REQUIRED_LAYERS) {
    const layerResult = layerResults[layer.key];
    const artifacts = FINAL_LAYER_ARTIFACTS[layer.key] || [];
    if (artifacts.length === 0) continue;
    if (layerResult?.notApplicable) {
      coverage[layer.key] = { skipped: true, reason: 'Layer marked not applicable in feature registry' };
      continue;
    }

    const checked = [];
    let matched = false;
    let anyExists = false;
    for (const artifact of artifacts) {
      const artifactPath = outputPath(planningDir, artifact);
      if (!fs.existsSync(artifactPath)) {
        checked.push({ artifact, exists: false, matched: false });
        continue;
      }
      anyExists = true;
      const content = readText(artifactPath);
      const artifactMatched = referencesFeature(content, feature, sourceIds);
      checked.push({ artifact, exists: true, matched: artifactMatched });
      matched = matched || artifactMatched;
    }

    // v0.40.5: Gate runs at TWO different pipeline positions:
    //   (a) Phase 3 close (cobolt-plan step 18b) — checks traceability for
    //       layers already materialized; Phase 4-owned layers (tests, rollout
    //       target test-strategy.md/epics.md) don't exist yet and must be
    //       deferred, not blocked.
    //   (b) Phase 5 close (cobolt-plan step 28a) + milestone-validate —
    //       ALL layers must have evidence. Missing artifacts = hard failure.
    //
    // Opt in to position (a) via `--allow-deferred-layers` (or
    // COBOLT_FEATURE_COVERAGE_DEFER=1). Default is position (b) — fail hard
    // on missing artifacts, preserving the end-of-planning contract.
    const allowDeferred = allowDeferredOuter || process.env.COBOLT_FEATURE_COVERAGE_DEFER === '1';
    if (!anyExists && allowDeferred) {
      coverage[layer.key] = {
        skipped: true,
        reason: `Layer evidence artifacts not yet materialized (${artifacts.join(', ')}); deferred to later phase close`,
        checked,
      };
      continue;
    }

    coverage[layer.key] = { skipped: false, matched, checked };
    if (!matched) {
      issues.push(
        `${layer.label} is not traceable to ${normalizeFeatureId(feature.featureId || feature.id)} in ${artifacts.join(', ')}`,
      );
    }
  }

  return { coverage, issues };
}

function evaluateFeature(feature, context) {
  const featureId = normalizeFeatureId(feature.featureId || feature.id);
  const sourceIds = collectFeatureSourceIds(feature);
  const issues = [];

  if (!featureId) issues.push('Feature is missing a valid FEAT-NNN id');
  if (!feature.title && !feature.name) issues.push(`${featureId || 'Feature'} is missing a title`);
  if (sourceIds.length === 0) issues.push(`${featureId || 'Feature'} has no sourceIds or requirementIds`);

  const featureEvidence = normalizeEvidenceLevel(feature.evidenceLevel || feature.level || feature.sourceType);
  if (!featureEvidence) issues.push(`${featureId || 'Feature'} has no allowed evidenceLevel`);
  const assumptions = [];
  if (featureEvidence === 'ASSUMPTION') assumptions.push('Feature-level evidence is ASSUMPTION');

  const layerResults = {};
  for (const layer of REQUIRED_LAYERS) {
    const result = analyzeLayer(feature, layer);
    layerResults[layer.key] = result;
    issues.push(...result.issues);
    if (result.assumption) assumptions.push(`${layer.label} evidence is ASSUMPTION`);
  }

  const dossier = loadDossier(context.planningDir, feature);
  if (!dossier.exists) {
    issues.push(`${featureId || 'Feature'} dossier is missing at ${dossier.relativePath}`);
  } else {
    if (dossier.size < 300) issues.push(`${featureId} dossier is too small (${dossier.size}B < 300B)`);
    if (!dossier.content.includes(featureId)) issues.push(`${featureId} dossier does not mention its feature ID`);
    for (const phrase of ['Service Blueprint', 'Given', 'When', 'Then', 'Evidence']) {
      if (!new RegExp(phrase, 'i').test(dossier.content)) {
        issues.push(`${featureId} dossier is missing ${phrase}`);
      }
    }
  }

  if (!context.blueprints.exists) {
    issues.push('feature-service-blueprints.md is missing');
  } else {
    if (context.blueprints.size < 300) issues.push('feature-service-blueprints.md is too small');
    if (featureId && !context.blueprints.content.includes(featureId)) {
      issues.push(`feature-service-blueprints.md does not mention ${featureId}`);
    }
  }

  let finalArtifactCoverage = null;
  if (context.stage === 'final') {
    finalArtifactCoverage = analyzeFinalArtifactCoverage(context.planningDir, feature, sourceIds, layerResults, {
      allowDeferred: context.allowDeferred === true,
    });
    issues.push(...finalArtifactCoverage.issues);
  }

  let status = 'READY';
  if (issues.length > 0) status = 'BLOCKED';
  if (assumptions.length > 0) status = issues.length > 0 ? 'BLOCKED' : 'DRAFT_ONLY';

  return {
    featureId,
    title: feature.title || feature.name || '',
    sourceIds,
    evidenceLevel: featureEvidence,
    status,
    assumptions,
    issues,
    dossier: {
      path: dossier.relativePath,
      exists: dossier.exists,
      size: dossier.size,
    },
    layers: layerResults,
    finalArtifactCoverage: finalArtifactCoverage?.coverage || null,
  };
}

function buildGapReport(result) {
  const lines = [
    '# Feature Gap Report',
    '',
    `Generated: ${result.generatedAt}`,
    `Stage: ${result.stage}`,
    `Verdict: ${result.passed ? 'PASS' : 'FAIL'}`,
    '',
    '## Summary',
    '',
    `- Features: ${result.summary.totalFeatures}`,
    `- Ready: ${result.summary.readyFeatures}`,
    `- Draft only: ${result.summary.draftOnlyFeatures}`,
    `- Blocked: ${result.summary.blockedFeatures}`,
    `- Required source IDs mapped: ${result.sourceCoverage.mapped}/${result.sourceCoverage.total}`,
    '',
  ];

  if (result.sourceCoverage.unmapped.length > 0) {
    lines.push('## Unmapped Source Requirements', '');
    for (const entry of result.sourceCoverage.unmapped) {
      lines.push(`- ${entry.id}: ${entry.summary || '(no summary)'}`);
    }
    lines.push('');
  }

  lines.push('## Feature Readiness', '');
  for (const feature of result.features) {
    lines.push(`### ${feature.featureId || '(invalid feature)'}: ${feature.title || '(untitled)'}`);
    lines.push('');
    lines.push(`Status: ${feature.status}`);
    if (feature.assumptions.length > 0) {
      lines.push('', 'Assumptions:');
      for (const assumption of feature.assumptions) lines.push(`- ${assumption}`);
    }
    if (feature.issues.length > 0) {
      lines.push('', 'Issues:');
      for (const issue of feature.issues) lines.push(`- ${issue}`);
    }
    lines.push('');
  }

  if (result.features.length === 0) {
    lines.push('- No features found in feature-registry.json.');
  }

  return `${lines.join('\n')}\n`;
}

function runCheck(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const planningDir = resolvePlanningDir(projectRoot, options.planningDir);
  const stage = options.stage === 'final' ? 'final' : 'intake';
  const generatedAt = new Date().toISOString();

  const registryLoad = loadFeatureRegistry(planningDir);
  const blueprints = loadServiceBlueprints(planningDir);
  const sourceRequirements = loadRequiredSourceIds(projectRoot, planningDir);
  const sourceIdsByFeature = new Map();

  // CB-OBS-05 (Rdrive101 end-to-end run): emit a schema-drift hint when the
  // registry uses non-canonical field names (e.g. `sources` instead of
  // `sourceIds`). Without this, producers see 150+ cryptic "unmapped SRC-NNN"
  // errors and cannot tell the root cause is a single field rename.
  const registryObject = registryLoad.raw || registryLoad.registry || null;
  const fieldDrift = registryObject ? detectFeatureRegistryFieldDrift(registryObject) : null;

  const context = {
    projectRoot,
    planningDir,
    stage,
    blueprints,
    allowDeferred: options.allowDeferred === true,
  };
  const features = registryLoad.features.map((feature) => {
    const result = evaluateFeature(feature, context);
    for (const sourceId of result.sourceIds) {
      if (!sourceIdsByFeature.has(sourceId)) sourceIdsByFeature.set(sourceId, []);
      sourceIdsByFeature.get(sourceId).push(result.featureId);
    }
    return result;
  });

  const unmapped = sourceRequirements.entries.filter((entry) => !sourceIdsByFeature.has(entry.id));
  const readyFeatures = features.filter((feature) => feature.status === 'READY').length;
  const draftOnlyFeatures = features.filter((feature) => feature.status === 'DRAFT_ONLY').length;
  const blockedFeatures = features.filter((feature) => feature.status === 'BLOCKED').length;

  const packetIssues = [...registryLoad.issues, ...sourceRequirements.issues];
  if (sourceRequirements.sourceSet && !sourceRequirements.sourceSet.skipped && !sourceRequirements.sourceSet.passed) {
    packetIssues.push('Source Requirement Registry is required before feature analysis can pass.');
  }
  if (fieldDrift && fieldDrift.length > 0) {
    for (const d of fieldDrift) {
      packetIssues.push(
        `Schema drift in feature-registry.json for ${d.featureId}: used "${d.usedField}" but canonical field is "${d.canonicalField}". See ${d.schema}.`,
      );
    }
  }

  const passed =
    packetIssues.length === 0 &&
    features.length > 0 &&
    blockedFeatures === 0 &&
    draftOnlyFeatures === 0 &&
    unmapped.length === 0;

  const result = {
    generatedAt,
    stage,
    passed,
    planningDir,
    standardsContract: [
      'ISO/IEC/IEEE 29148 information-item requirements',
      'NN/g journey mapping and service blueprinting',
      'Cucumber Gherkin executable acceptance criteria',
      'OpenAPI 3.2.0 spec-first API planning',
      'NIST SSDF and OWASP ASVS security by design',
      'WCAG 2.2 testable accessibility success criteria',
      'C4 system context/container/component/code architecture coverage',
    ],
    summary: {
      totalFeatures: features.length,
      readyFeatures,
      draftOnlyFeatures,
      blockedFeatures,
    },
    sourceCoverage: {
      total: sourceRequirements.ids.length,
      mapped: sourceRequirements.ids.length - unmapped.length,
      unmapped,
    },
    packetIssues,
    requiredLayers: REQUIRED_LAYERS.map(({ key, label }) => ({ key, label })),
    features,
  };

  const matrixPath = outputPath(planningDir, 'feature-coverage-matrix.json');
  const readinessPath = outputPath(planningDir, 'feature-readiness-report.json');
  const gapPath = outputPath(planningDir, 'feature-gap-report.md');
  writeJson(matrixPath, {
    generatedAt,
    stage,
    requiredLayers: result.requiredLayers,
    features: features.map((feature) => ({
      featureId: feature.featureId,
      status: feature.status,
      sourceIds: feature.sourceIds,
      layers: Object.fromEntries(
        Object.entries(feature.layers).map(([key, value]) => [
          key,
          {
            status: value.status,
            evidenceLevel: value.evidenceLevel,
            notApplicable: value.notApplicable,
          },
        ]),
      ),
    })),
  });
  writeJson(readinessPath, result);
  fs.writeFileSync(gapPath, buildGapReport(result), 'utf8');

  return {
    result: {
      ...result,
      artifacts: {
        featureCoverageMatrix: path.relative(projectRoot, matrixPath).replaceAll('\\', '/'),
        featureReadinessReport: path.relative(projectRoot, readinessPath).replaceAll('\\', '/'),
        featureGapReport: path.relative(projectRoot, gapPath).replaceAll('\\', '/'),
      },
    },
    exitCode: passed ? 0 : 1,
  };
}

function cmdCheck(args) {
  const jsonMode = args.includes('--json');
  const stageIndex = args.indexOf('--stage');
  const stage = stageIndex >= 0 && args[stageIndex + 1] ? args[stageIndex + 1] : 'intake';
  const planningIndex = args.indexOf('--planning-dir');
  const planningDir = planningIndex >= 0 && args[planningIndex + 1] ? args[planningIndex + 1] : null;
  // v0.40.5: --allow-deferred-layers opts into the Phase 3-close behavior where
  // layers whose evidence artifacts live in Phase 4 are deferred (skipped)
  // instead of blocking. Plan SKILL.md step 18b must pass this flag; step 28a
  // (Phase 5 close) and milestone-validate must NOT.
  const allowDeferred = args.includes('--allow-deferred-layers') || process.env.COBOLT_FEATURE_COVERAGE_DEFER === '1';
  const { result, exitCode } = runCheck({ stage, planningDir, allowDeferred });

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write('[feature-coverage] Feature Readiness\n');
    process.stdout.write(`  Stage: ${result.stage}\n`);
    process.stdout.write(`  Features: ${result.summary.totalFeatures}\n`);
    process.stdout.write(`  Ready: ${result.summary.readyFeatures}\n`);
    process.stdout.write(`  Draft-only: ${result.summary.draftOnlyFeatures}\n`);
    process.stdout.write(`  Blocked: ${result.summary.blockedFeatures}\n`);
    process.stdout.write(
      `  Source coverage: ${result.sourceCoverage.mapped}/${result.sourceCoverage.total} source IDs mapped\n`,
    );
    process.stdout.write(`  Result: ${result.passed ? 'PASS' : 'FAIL'}\n`);
    if (!result.passed) {
      for (const issue of result.packetIssues || []) process.stdout.write(`  Issue: ${issue}\n`);
      for (const feature of result.features.filter((entry) => entry.status !== 'READY')) {
        process.stdout.write(`  ${feature.featureId || '(invalid feature)'}: ${feature.status}\n`);
        for (const issue of feature.issues.slice(0, 5)) process.stdout.write(`    - ${issue}\n`);
        for (const assumption of feature.assumptions.slice(0, 5)) process.stdout.write(`    - ${assumption}\n`);
      }
    }
    process.stdout.write(`\n  Report: ${result.artifacts.featureReadinessReport}\n`);
  }

  process.exit(exitCode);
}

function printUsage() {
  process.stdout.write(`
CoBolt Feature Coverage - deterministic feature dossier readiness

Usage:
  node tools/cobolt-feature-coverage.js check [--stage intake|final] [--json]

Commands:
  check     Validate feature-registry.json, feature dossiers, service blueprints, source mapping, and readiness

Options:
  --stage <stage>       intake validates the feature-analysis packet; final also checks downstream spec artifacts
  --planning-dir <dir>  Planning directory override
  --json               Machine-readable JSON output

Exit codes:
  0  Feature readiness passed
  1  Feature readiness failed
  2  Usage error
`);
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'check':
      cmdCheck(args.slice(1));
      break;
    case '--help':
    case '-h':
    case undefined:
      printUsage();
      break;
    default:
      process.stderr.write(`Unknown command: ${command}\n`);
      printUsage();
      process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  ALLOWED_EVIDENCE_LEVELS,
  REQUIRED_LAYERS,
  analyzeLayer,
  loadFeatureRegistry,
  runCheck,
};
