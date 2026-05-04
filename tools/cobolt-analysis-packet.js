#!/usr/bin/env node

// cobolt-analysis-packet.js
//
// Build the canonical analysis packet (JSON + Markdown) and initialize
// analysis-manifest.json with a hash-based artifact registry. Consumes an
// analysis-scope.json produced by cobolt-analysis-scope.js.
//
// Pure Node — no LLM calls.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const BASELINE_REVIEWERS = [
  'feature-completeness-reviewer',
  'architecture-reviewer',
  'code-reviewer',
  'test-quality-reviewer',
  'security-reviewer',
  'integration-reviewer',
  'config-reviewer',
  'ops-readiness-reviewer',
];

const CONDITIONAL_REVIEWERS = {
  api: ['api-contract-reviewer', 'silent-failure-reviewer'],
  frontend: ['ux-reviewer', 'ui-design-reviewer', 'accessibility-reviewer', 'i18n-reviewer'],
  wireframes: ['design-token-linter', 'ui-design-reviewer', 'ux-reviewer'],
  db: ['database-reviewer', 'db-query-safety-reviewer'],
  integrations: ['integration-reviewer', 'silent-failure-reviewer'],
  ops: ['ops-readiness-reviewer'],
  security: ['security-reviewer'],
  ai: ['ai-security-reviewer'],
  compliance: ['compliance-reviewer'],
};

function loadScope(scopePath) {
  if (!fs.existsSync(scopePath)) {
    throw new Error(`analysis-scope.json not found at ${scopePath}`);
  }
  return JSON.parse(fs.readFileSync(scopePath, 'utf8').replace(/^\uFEFF/, ''));
}

function analysisDir(projectRoot, analysisId) {
  return path.join(projectRoot, '_cobolt-output', 'latest', 'analysis', analysisId);
}

function sha256File(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath);
  return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, value, { mode: 0o600 });
}

function planReviewers(surfaces) {
  const reviewers = new Set(BASELINE_REVIEWERS);
  for (const surface of surfaces) {
    const extras = CONDITIONAL_REVIEWERS[surface] || [];
    for (const reviewer of extras) reviewers.add(reviewer);
  }
  return [...reviewers];
}

function buildPacketJson(scope) {
  const plannedReviewers = planReviewers(scope.surfaces);
  return {
    version: '1.0.0',
    analysisId: scope.analysisId,
    feature: scope.feature,
    generatedAt: new Date().toISOString(),
    sourceRoot: scope.sourceRoot,
    scope: {
      filesInScope: scope.files.length,
      candidateFiles: scope.candidateFiles.length,
      surfaces: scope.surfaces,
      confidence: scope.confidence,
      refinements: scope.refinements,
    },
    seeds: {
      source: scope.seedSource || 'text',
      terms: scope.seedTerms,
      requirements: scope.requirements,
    },
    evidenceSummary: summarizeEvidence(scope.files),
    plannedReviewers: {
      baseline: BASELINE_REVIEWERS,
      conditional: plannedReviewers.filter((r) => !BASELINE_REVIEWERS.includes(r)),
      dispatched: plannedReviewers,
    },
    reviewerDispatchPolicy: {
      scopeConfidenceGate: {
        threshold: scope.confidence?.threshold ?? 70,
        belowThreshold: Boolean(scope.confidence?.belowThreshold),
        forceLowConfidence: Boolean(scope.refinements?.forceLowConfidence),
        action:
          scope.confidence?.belowThreshold && !scope.refinements?.forceLowConfidence
            ? 'refuse-dispatch-recommend-refinement'
            : 'proceed',
      },
      reviewerAddendum:
        'You are reviewing only the named feature scope. Do not report unrelated codebase issues. If you find a severe issue outside the feature scope, record it as out-of-scope advisory evidence, not as a fix-eligible analysis finding.',
    },
    filesByCategory: {
      backend: scope.files.filter((f) => f.surface === 'backend').map((f) => f.path),
      api: scope.files.filter((f) => f.surface === 'api').map((f) => f.path),
      frontend: scope.files.filter((f) => f.surface === 'frontend').map((f) => f.path),
      wireframes: scope.wireframes,
      db: scope.files.filter((f) => f.surface === 'db').map((f) => f.path),
      config: scope.configs,
      integrations: scope.integrations,
      tests: scope.tests,
    },
  };
}

function summarizeEvidence(files) {
  const byKind = {};
  let total = 0;
  for (const file of files) {
    for (const ev of file.scopeEvidence || []) {
      byKind[ev.kind] = (byKind[ev.kind] || 0) + 1;
      total += 1;
    }
  }
  return { total, byKind };
}

function buildPacketMarkdown(scope, packetJson) {
  const lines = [];
  lines.push(`# Feature Analysis Packet — ${scope.feature.query}`);
  lines.push('');
  lines.push(`- **Analysis ID**: ${scope.analysisId}`);
  lines.push(`- **Feature slug**: ${scope.feature.slug}`);
  lines.push(`- **Generated**: ${packetJson.generatedAt}`);
  lines.push(`- **Source root**: ${scope.sourceRoot}`);
  lines.push(`- **Files in scope**: ${scope.files.length}`);
  lines.push(`- **Candidate files**: ${scope.candidateFiles.length}`);
  lines.push(`- **Scope confidence**: ${scope.confidence.overall}%`);
  lines.push(`- **Confidence threshold**: ${scope.confidence.threshold ?? 70}%`);
  lines.push(`- **Below threshold**: ${Boolean(scope.confidence.belowThreshold)}`);
  lines.push(`- **Surfaces detected**: ${scope.surfaces.join(', ') || '(none)'}`);
  lines.push(`- **Seed source**: ${scope.seedSource || 'text'}`);
  lines.push(`- **Seed terms**: ${scope.seedTerms.join(', ')}`);
  lines.push('');

  lines.push('## Planned Reviewers');
  lines.push('');
  lines.push('### Baseline');
  for (const reviewer of packetJson.plannedReviewers.baseline) lines.push(`- ${reviewer}`);
  lines.push('');
  if (packetJson.plannedReviewers.conditional.length > 0) {
    lines.push('### Conditional (based on detected surfaces)');
    for (const reviewer of packetJson.plannedReviewers.conditional) lines.push(`- ${reviewer}`);
    lines.push('');
  }

  lines.push('## Reviewer Addendum');
  lines.push('');
  lines.push(`> ${packetJson.reviewerDispatchPolicy.reviewerAddendum}`);
  lines.push('');

  lines.push('## Files in Scope');
  lines.push('');
  for (const file of scope.files.slice(0, 200)) {
    lines.push(`- \`${file.path}\` — ${file.surface}, confidence ${file.confidence}%`);
  }
  if (scope.files.length > 200) {
    lines.push(`- … ${scope.files.length - 200} more (see analysis-scope.json)`);
  }
  lines.push('');

  if (scope.candidateFiles.length > 0) {
    lines.push('## Candidate Files (below threshold — require refinement)');
    lines.push('');
    for (const file of scope.candidateFiles.slice(0, 50)) {
      lines.push(`- \`${file.path}\` — ${file.surface}, confidence ${file.confidence}%`);
    }
    if (scope.candidateFiles.length > 50) {
      lines.push(`- … ${scope.candidateFiles.length - 50} more`);
    }
    lines.push('');
  }

  if (scope.requirements.length > 0) {
    lines.push('## Linked Requirements');
    lines.push('');
    for (const req of scope.requirements) {
      lines.push(`- **${req.id}** (${req.source}) — ${req.title || ''}`);
    }
    lines.push('');
  }

  lines.push('## Dispatch Decision');
  lines.push('');
  lines.push(`- Policy: **${packetJson.reviewerDispatchPolicy.scopeConfidenceGate.action}**`);
  if (packetJson.reviewerDispatchPolicy.scopeConfidenceGate.action === 'refuse-dispatch-recommend-refinement') {
    lines.push(
      '- Scope confidence is below threshold. Rerun with `--include` / `--exclude` or `--from-prd <id>` / `--from-story <id>` to refine, or pass `--force-low-confidence` to override.',
    );
  }
  lines.push('');

  return lines.join('\n');
}

function buildFeatureMap(scope) {
  return {
    version: '1.0.0',
    analysisId: scope.analysisId,
    feature: scope.feature,
    aliases: scope.feature.aliases || [],
    generatedAt: new Date().toISOString(),
    sourceRoot: scope.sourceRoot,
    sourceCommit: scope.staleness?.sourceCommit || null,
    files: scope.files.map((f) => ({ path: f.path, surface: f.surface, confidence: f.confidence })),
    candidateFiles: scope.candidateFiles.map((f) => ({ path: f.path, surface: f.surface, confidence: f.confidence })),
    routes: scope.routes,
    requirements: scope.requirements,
    stories: [],
    tests: scope.tests,
    configs: scope.configs,
    integrations: scope.integrations,
    uiRoutes: scope.uiRoutes,
    wireframes: scope.wireframes,
    edges: [],
    confidence: scope.confidence,
    staleness: scope.staleness,
  };
}

function initializeManifest(analysisId, artifacts, projectRoot) {
  const manifest = {
    version: '1.0.0',
    analysisId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stepsCompleted: ['01', '02'],
    dispatchedReviewers: [],
    completedReviewers: [],
    failedReviewers: [],
    skippedReviewers: [],
    artifacts: {},
  };
  for (const artifactPath of artifacts) {
    if (!fs.existsSync(artifactPath)) continue;
    const relativePath = path.relative(projectRoot, artifactPath).replace(/\\/g, '/');
    manifest.artifacts[relativePath] = {
      step: relativePath.endsWith('analysis-scope.json') ? '01' : '02',
      path: relativePath,
      hash: sha256File(artifactPath),
      size: fs.statSync(artifactPath).size,
      updatedAt: new Date().toISOString(),
    };
  }
  return manifest;
}

/**
 * Build packet + feature-map + manifest from an existing analysis-scope.json.
 * @param {object} options
 * @param {string} [options.projectRoot]
 * @param {string} options.analysisId
 * @returns {object} output paths
 */
function buildAnalysisPacket(options) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const analysisId = options.analysisId;
  if (!analysisId) throw new Error('buildAnalysisPacket requires options.analysisId');

  const dir = analysisDir(projectRoot, analysisId);
  const scopePath = path.join(dir, 'analysis-scope.json');
  const scope = loadScope(scopePath);

  const packetJson = buildPacketJson(scope);
  const packetJsonPath = path.join(dir, `${analysisId}-analysis-packet.json`);
  writeJson(packetJsonPath, packetJson);

  const packetMd = buildPacketMarkdown(scope, packetJson);
  const packetMdPath = path.join(dir, `${analysisId}-analysis-packet.md`);
  writeText(packetMdPath, packetMd);

  const featureMap = buildFeatureMap(scope);
  const featureMapPath = path.join(dir, 'feature-map.json');
  writeJson(featureMapPath, featureMap);

  const manifest = initializeManifest(
    analysisId,
    [scopePath, packetJsonPath, packetMdPath, featureMapPath],
    projectRoot,
  );
  const manifestPath = path.join(dir, 'analysis-manifest.json');
  writeJson(manifestPath, manifest);

  return {
    analysisId,
    packetJsonPath,
    packetMdPath,
    featureMapPath,
    manifestPath,
    filesInScope: scope.files.length,
    confidence: scope.confidence.overall,
  };
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('--help')) {
    process.stdout.write('cobolt-analysis-packet --analysis-id <id> [--path <dir>]\n');
    return 0;
  }
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--analysis-id' && args[i + 1]) {
      options.analysisId = args[++i];
    } else if (args[i] === '--path' && args[i + 1]) {
      options.projectRoot = args[++i];
    }
  }
  try {
    const result = buildAnalysisPacket(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`cobolt-analysis-packet failed: ${err.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = {
  BASELINE_REVIEWERS,
  CONDITIONAL_REVIEWERS,
  buildAnalysisPacket,
  buildPacketJson,
  buildPacketMarkdown,
  buildFeatureMap,
  planReviewers,
  summarizeEvidence,
  _main: main,
};
