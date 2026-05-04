#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { getPlanningDir, getStoryCoverage } = require('../lib/cobolt-planning-artifacts');
const { noDeclaredInfrastructure } = require('./cobolt-infra-check');

const BUILD_INGESTION_OVERRIDES = Object.freeze({
  'milestone-execution-obligations': {
    gateTier: 'hard-block',
    carriers: ['build-ready-gate', 'build-setup-step', 'build-packet', 'task-manifest', 'review-packet'],
  },
  'capability-contract': {
    gateTier: 'hard-block',
    carriers: ['build-ready-gate', 'build-setup-step', 'task-manifest', 'validate-capability-gate'],
  },
  'capability-contracts-index': {
    gateTier: 'hard-block',
    carriers: [
      'build-ready-gate',
      'build-setup-step',
      'build-packet',
      'task-manifest',
      'review-packet',
      'validate-capability-gate',
    ],
  },
  'compliance-register': {
    gateTier: 'skip-and-report',
    carriers: ['build-ready-gate', 'build-setup-step', 'build-packet', 'review-packet', 'review-governance'],
  },
  'compliance-register-json': {
    gateTier: 'skip-and-report',
    carriers: ['build-ready-gate', 'build-setup-step', 'build-packet', 'review-packet', 'review-governance'],
  },
  'domain-knowledge-base': {
    gateTier: 'skip-and-report',
    carriers: ['build-ready-gate', 'build-setup-step', 'build-packet', 'review-packet'],
  },
  'wireframes-and-user-flows': {
    gateTier: 'skip-and-report',
    carriers: ['build-ready-gate', 'build-setup-step', 'build-packet', 'review-packet'],
  },
  'ux-state-matrix': {
    gateTier: 'hard-block',
    carriers: ['build-ready-gate', 'milestone-execution-obligations', 'build-packet', 'review-packet'],
  },
  'acceptance-example-pack': {
    gateTier: 'hard-block',
    carriers: ['build-ready-gate', 'milestone-execution-obligations', 'build-packet', 'task-manifest'],
  },
  'test-data-fixture-plan': {
    gateTier: 'hard-block',
    carriers: ['build-ready-gate', 'milestone-execution-obligations', 'build-packet', 'task-manifest'],
  },
  'observability-contract': {
    gateTier: 'hard-block',
    carriers: ['build-ready-gate', 'milestone-execution-obligations', 'build-packet', 'validate-observability'],
  },
  'performance-accessibility-budgets': {
    gateTier: 'hard-block',
    carriers: ['build-ready-gate', 'milestone-execution-obligations', 'build-packet', 'deep-verification'],
  },
  'runtime-operations-pack': {
    gateTier: 'hard-block',
    carriers: ['build-ready-gate', 'milestone-execution-obligations', 'build-packet', 'milestone-complete'],
  },
  'security-abuse-case-pack': {
    gateTier: 'hard-block',
    carriers: ['build-ready-gate', 'milestone-execution-obligations', 'build-packet', 'nfr-enforce'],
  },
  'architecture-fitness-checks': {
    gateTier: 'hard-block',
    carriers: ['build-ready-gate', 'milestone-execution-obligations', 'build-packet', 'deep-verification'],
  },
  'launch-quality-gate': {
    gateTier: 'hard-block',
    carriers: ['build-ready-gate', 'milestone-execution-obligations', 'build-packet', 'milestone-complete'],
  },
  'product-quality-scorecard': {
    gateTier: 'skip-and-report',
    carriers: ['build-ready-gate', 'build-packet', 'review-packet', 'milestone-complete'],
  },
  'planning-loop-verdict': {
    gateTier: 'hard-block',
    carriers: ['build-ready-gate', 'build-setup-step', 'build-packet', 'plan-ingestion-manifest', 'review-packet'],
  },
  'planning-evidence-signature': {
    gateTier: 'hard-block',
    carriers: ['build-ready-gate', 'build-setup-step', 'build-packet', 'plan-ingestion-manifest', 'review-packet'],
  },
  'planning-control-map': {
    gateTier: 'skip-and-report',
    carriers: ['build-ready-gate', 'build-setup-step', 'build-packet', 'plan-ingestion-manifest', 'review-packet'],
  },
  'planning-external-source-ledger': {
    gateTier: 'skip-and-report',
    carriers: ['build-ready-gate', 'build-setup-step', 'build-packet', 'plan-ingestion-manifest', 'review-packet'],
  },
  'planning-risk-model': {
    gateTier: 'skip-and-report',
    carriers: ['build-ready-gate', 'build-setup-step', 'build-packet', 'plan-ingestion-manifest', 'review-packet'],
  },
  'agentic-threat-model': {
    gateTier: 'skip-and-report',
    carriers: ['build-ready-gate', 'build-setup-step', 'build-packet', 'plan-ingestion-manifest', 'review-packet'],
  },
  'planning-performance-profile': {
    gateTier: 'skip-and-report',
    carriers: ['build-ready-gate', 'build-setup-step', 'build-packet', 'plan-ingestion-manifest', 'review-packet'],
  },
  'planning-replay-calibration': {
    gateTier: 'skip-and-report',
    carriers: ['build-ready-gate', 'build-setup-step', 'build-packet', 'plan-ingestion-manifest', 'review-packet'],
  },
});

const PATH_ALIASES = Object.freeze({
  'data-model-spec': ['_cobolt-output/latest/planning/data-model.md'],
  'domain-knowledge-base': ['_cobolt-output/latest/planning/domain-knowledge.md'],
});

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, ''));
  } catch {
    return fallback;
  }
}

function sha256File(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

function normalizeRelative(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function loadDependencySchema(projectRoot) {
  const candidates = [
    path.join(projectRoot, 'source', 'schemas', 'artifact-dependencies.json'),
    path.resolve(__dirname, '..', 'source', 'schemas', 'artifact-dependencies.json'),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const parsed = readJson(candidate, null);
    if (parsed) return { path: candidate, schema: parsed };
  }
  return { path: candidates[0], schema: null };
}

function relativeOutputPath(projectRoot, absolutePath) {
  return normalizeRelative(path.relative(projectRoot, absolutePath));
}

function readPlanningManifest(projectRoot, planningDir) {
  const manifestFile = path.join(planningDir, 'planning-manifest.json');
  const present = fs.existsSync(manifestFile) && fs.statSync(manifestFile).isFile();
  const document = present ? readJson(manifestFile, null) : null;
  const summary = document?.summary || {};
  return {
    present,
    path: relativeOutputPath(projectRoot, manifestFile),
    sha256: present ? sha256File(manifestFile) : null,
    verdict: summary.verdict || 'missing',
    buildAuthorization: summary.buildAuthorization || (present ? 'unknown' : 'blocked'),
    critical: Number(summary.critical || 0),
    advisory: Number(summary.advisory || 0),
    artifacts: Number(summary.artifacts || 0),
    inputs: Number(summary.inputs || 0),
    requirements: Number(summary.requirements || 0),
    stories: Number(summary.stories || 0),
    generatedAt: document?.generatedAt || null,
  };
}

function pathCandidatesForArtifact(projectRoot, artifactId, artifact) {
  const candidates = [];
  if (artifact?.path) candidates.push(normalizeRelative(artifact.path));
  for (const alias of PATH_ALIASES[artifactId] || []) candidates.push(normalizeRelative(alias));
  return [...new Set(candidates)].map((candidate) => path.join(projectRoot, candidate.replaceAll('/', path.sep)));
}

function matchPatternFiles(projectRoot, _artifactId, artifact) {
  const pattern = normalizeRelative(artifact?.pathPattern || artifact?.path || '');
  if (!pattern.includes('*')) return [];

  const dirPath = path.join(projectRoot, path.dirname(pattern).replaceAll('/', path.sep));
  if (!fs.existsSync(dirPath)) return [];

  const fileNamePattern = artifact?.filenamePattern ? new RegExp(artifact.filenamePattern) : null;
  const suffix = path.basename(pattern).replace('*', '');
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dirPath, entry.name))
    .filter((absolutePath) => {
      const fileName = path.basename(absolutePath);
      if (fileNamePattern) return fileNamePattern.test(fileName);
      return suffix ? fileName.endsWith(suffix) : true;
    })
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .map((absolutePath) => ({
      path: relativeOutputPath(projectRoot, absolutePath),
      absolutePath,
      size: fs.statSync(absolutePath).size,
      aliasUsed: false,
      viaPattern: true,
    }));
}

function resolveArtifactFiles(projectRoot, artifactId, artifact) {
  const exactCandidates = pathCandidatesForArtifact(projectRoot, artifactId, artifact).map((absolutePath, index) => ({
    absolutePath,
    aliasUsed: index > 0,
  }));
  const matches = [];
  for (const candidate of exactCandidates) {
    if (!fs.existsSync(candidate.absolutePath)) continue;
    const stat = fs.statSync(candidate.absolutePath);
    if (!stat.isFile()) continue;
    matches.push({
      path: relativeOutputPath(projectRoot, candidate.absolutePath),
      absolutePath: candidate.absolutePath,
      size: stat.size,
      aliasUsed: candidate.aliasUsed,
      viaPattern: false,
    });
  }
  for (const match of matchPatternFiles(projectRoot, artifactId, artifact)) matches.push(match);
  return matches;
}

function buildStoryCoverageArtifact(projectRoot, planningDir, _artifact) {
  const trackerPath = path.join(projectRoot, '_cobolt-output', 'latest', 'planning', 'story-tracker.json');
  const trackerExists = fs.existsSync(trackerPath);
  const coverage = getStoryCoverage(projectRoot, { planningDir });
  const present = trackerExists && coverage.expectedStoryIds.length > 0 && coverage.missingStoryIds.length === 0;
  return {
    present,
    size: coverage.actualFiles.length,
    skipped: false,
    reason: null,
    actualStories: coverage.actualFiles.length,
    expectedStories: coverage.expectedStoryIds.length,
    missingStoryIds: coverage.missingStoryIds,
    resolvedFiles: coverage.actualFiles.map((entry) => ({
      path: `_cobolt-output/latest/planning/${entry.relativePath}`,
      size: entry.size,
      aliasUsed: false,
      viaPattern: false,
    })),
  };
}

function buildInfraManifestArtifact(projectRoot, resolvedFiles) {
  if (resolvedFiles.length > 0) {
    return {
      present: true,
      size: resolvedFiles.reduce((sum, entry) => sum + Number(entry.size || 0), 0),
      skipped: false,
      reason: null,
      resolvedFiles,
    };
  }

  const scan = noDeclaredInfrastructure(projectRoot);
  if (scan.ok) {
    return {
      present: true,
      size: 0,
      skipped: true,
      reason: 'No infrastructure dependencies are declared by architecture.md; infra-manifest is not required.',
      architectureSource: scan.source,
      resolvedFiles: [],
    };
  }

  return {
    present: false,
    size: 0,
    skipped: false,
    reason: null,
    architectureSource: scan.source || null,
    resolvedFiles,
  };
}

function defaultGateTier(artifact, required) {
  if (artifact?.critical === true) return 'hard-block';
  if (required) return 'skip-and-report';
  return 'warn-continue';
}

function defaultCarriers(artifact, required) {
  if (artifact?.category === 'infra') return ['build-ready-gate', 'build-setup-step'];
  if (required) return ['build-ready-gate', 'build-setup-step'];
  return ['build-ready-gate'];
}

function resolveBuildIngestionContract(artifactId, artifact, required) {
  const explicit = BUILD_INGESTION_OVERRIDES[artifactId];
  if (explicit) {
    return {
      gateTier: explicit.gateTier,
      carriers: [...explicit.carriers],
      source: 'explicit',
    };
  }
  return {
    gateTier: defaultGateTier(artifact, required),
    carriers: defaultCarriers(artifact, required),
    source: 'derived',
  };
}

function listBuildArtifacts(schema) {
  const build = schema?.skills?.['cobolt-build'] || {};
  const required = Array.isArray(build.requires) ? build.requires : [];
  const optional = Array.isArray(build.optionalContext) ? build.optionalContext : [];
  return [
    ...required.map((artifactId) => ({ artifactId, required: true })),
    ...optional.map((artifactId) => ({ artifactId, required: false })),
  ];
}

function summarizeByCarrier(artifacts) {
  const summary = {};
  for (const artifact of artifacts) {
    for (const carrier of artifact.buildConsumers || []) {
      if (!summary[carrier]) {
        summary[carrier] = { artifacts: 0, missingRequired: 0, critical: 0 };
      }
      summary[carrier].artifacts += 1;
      if (artifact.required && !artifact.present) summary[carrier].missingRequired += 1;
      if (artifact.critical) summary[carrier].critical += 1;
    }
  }
  return Object.fromEntries(
    Object.entries(summary).sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true })),
  );
}

function buildPlanIngestionManifest(projectRoot = process.cwd(), options = {}) {
  const root = path.resolve(projectRoot);
  const { schemaPath, planningDir } = (() => {
    const dependencySchema = loadDependencySchema(root);
    return {
      schemaPath: dependencySchema.path,
      schema: dependencySchema.schema,
      planningDir:
        options.planningDir ||
        getPlanningDir(root, { strict: false, fallbackToLatest: true }) ||
        path.join(root, '_cobolt-output', 'latest', 'planning'),
    };
  })();
  const dependencySchema = loadDependencySchema(root);
  const schema = dependencySchema.schema;
  const milestone = options.milestone || null;

  if (!schema) {
    return {
      passed: false,
      generatedAt: new Date().toISOString(),
      generatedBy: 'cobolt-plan-ingestion-manifest',
      projectRoot: root,
      planningDir: relativeOutputPath(root, planningDir),
      milestone,
      summary: {
        requiredArtifacts: 0,
        optionalArtifacts: 0,
        presentArtifacts: 0,
        missingRequired: 0,
        contractGaps: 1,
      },
      issues: ['artifact-dependencies.json could not be loaded'],
      artifacts: [],
    };
  }

  const artifacts = listBuildArtifacts(schema).map(({ artifactId, required }) => {
    const artifact = schema.artifacts?.[artifactId] || null;
    const contract = resolveBuildIngestionContract(artifactId, artifact, required);
    const resolvedFiles = artifact ? resolveArtifactFiles(root, artifactId, artifact) : [];
    const minBytes = Number.isFinite(Number(artifact?.minBytes)) ? Number(artifact.minBytes) : 1;
    let specialResult = null;
    if (artifactId === 'story-file') {
      specialResult = buildStoryCoverageArtifact(root, planningDir, artifact);
    } else if (artifactId === 'infra-manifest') {
      specialResult = buildInfraManifestArtifact(root, resolvedFiles);
    }
    const size = specialResult
      ? specialResult.size
      : resolvedFiles.reduce((sum, entry) => sum + Number(entry.size || 0), 0);
    const present = specialResult
      ? specialResult.present
      : resolvedFiles.some((entry) => Number(entry.size || 0) >= minBytes);
    return {
      artifactId,
      required,
      defined: Boolean(artifact),
      description: artifact?.description || artifactId,
      category: artifact?.category || 'unknown',
      producer: artifact?.producedBy || null,
      expectedPath: normalizeRelative(artifact?.path || artifact?.pathPattern || ''),
      planningDir: relativeOutputPath(root, planningDir),
      minBytes,
      present,
      size,
      skipped: specialResult?.skipped === true,
      critical: artifact?.critical === true,
      buildConsumers: contract.carriers,
      gateTier: contract.gateTier,
      contractSource: contract.source,
      sourceStage: artifact?.stage || null,
      reason: specialResult?.reason || null,
      architectureSource: specialResult?.architectureSource || null,
      actualStories: specialResult?.actualStories || null,
      expectedStories: specialResult?.expectedStories || null,
      missingStoryIds: specialResult?.missingStoryIds || [],
      resolvedFiles: (specialResult?.resolvedFiles || resolvedFiles).map((entry) => ({
        path: entry.path,
        size: entry.size,
        aliasUsed: entry.aliasUsed,
        viaPattern: entry.viaPattern,
      })),
    };
  });

  const missingRequired = artifacts
    .filter((artifact) => artifact.required && !artifact.present)
    .map((artifact) => artifact.artifactId);
  const contractGaps = artifacts
    .filter((artifact) => artifact.buildConsumers.length === 0)
    .map((artifact) => artifact.artifactId);
  const planningManifest = readPlanningManifest(root, planningDir);
  const issues = [];
  if (missingRequired.length > 0) {
    issues.push(`Missing build-required planning artifacts: ${missingRequired.join(', ')}`);
  }
  if (contractGaps.length > 0) {
    issues.push(`Artifacts lack build ingestion contracts: ${contractGaps.join(', ')}`);
  }
  if (planningManifest.present && planningManifest.buildAuthorization === 'blocked') {
    issues.push(
      `Planning manifest blocks build: ${planningManifest.critical} critical, ${planningManifest.advisory} advisory`,
    );
  }

  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-plan-ingestion-manifest',
    projectRoot: root,
    planningDir: relativeOutputPath(root, planningDir),
    milestone,
    dependencySchemaPath: relativeOutputPath(root, schemaPath),
    passed: issues.length === 0,
    summary: {
      requiredArtifacts: artifacts.filter((artifact) => artifact.required).length,
      optionalArtifacts: artifacts.filter((artifact) => !artifact.required).length,
      presentArtifacts: artifacts.filter((artifact) => artifact.present).length,
      missingRequired: missingRequired.length,
      criticalArtifacts: artifacts.filter((artifact) => artifact.critical).length,
      contractGaps: contractGaps.length,
      planningManifestVerdict: planningManifest.verdict,
      planningManifestCritical: planningManifest.critical,
      planningManifestAdvisory: planningManifest.advisory,
      carriers: summarizeByCarrier(artifacts),
    },
    planningManifest,
    issues,
    artifacts,
  };
}

function writePlanIngestionManifest(projectRoot = process.cwd(), options = {}) {
  const manifest = buildPlanIngestionManifest(projectRoot, options);
  const root = path.resolve(projectRoot);
  const milestone = options.milestone || 'M1';
  const outputPath =
    options.outputPath ||
    path.join(root, '_cobolt-output', 'latest', 'build', milestone, `${milestone}-plan-ingestion-manifest.json`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { manifest, outputPath };
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    command: argv[0] || 'build',
    json: false,
    milestone: null,
    outputPath: null,
    projectRoot: process.cwd(),
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') args.json = true;
    else if (arg === '--milestone') args.milestone = argv[++index] || null;
    else if (arg === '--output') args.outputPath = argv[++index] || null;
    else if (arg === '--project') args.projectRoot = path.resolve(argv[++index] || args.projectRoot);
  }
  return args;
}

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(
    'Usage: node tools/cobolt-plan-ingestion-manifest.js build|check [--milestone M1] [--project <dir>] [--output <path>] [--json]\n',
  );
  process.exit(exitCode);
}

function main() {
  const rawArgv = process.argv.slice(2);
  if (rawArgv.includes('--help') || rawArgv.includes('-h') || rawArgv[0] === 'help') usage(0);

  const args = parseArgs(rawArgv);
  if (!['build', 'check'].includes(args.command)) {
    usage(1);
  }

  const result =
    args.command === 'build'
      ? writePlanIngestionManifest(args.projectRoot, { milestone: args.milestone, outputPath: args.outputPath })
      : { manifest: buildPlanIngestionManifest(args.projectRoot, { milestone: args.milestone }), outputPath: null };

  if (args.json || args.command === 'check') {
    console.log(JSON.stringify(result.manifest, null, 2));
  } else {
    console.log(
      `[cobolt-plan-ingestion-manifest] required=${result.manifest.summary.requiredArtifacts} missing=${result.manifest.summary.missingRequired}`,
    );
  }
  process.exit(result.manifest.passed ? 0 : 1);
}

if (require.main === module) main();

module.exports = {
  BUILD_INGESTION_OVERRIDES,
  buildPlanIngestionManifest,
  loadDependencySchema,
  readPlanningManifest,
  resolveBuildIngestionContract,
  writePlanIngestionManifest,
};
