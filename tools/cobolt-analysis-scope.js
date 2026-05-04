#!/usr/bin/env node

// cobolt-analysis-scope.js
//
// Deterministic feature-scope discovery for cobolt-analyse.
//
// Given a feature query string (or --from-prd / --from-story seed), this tool:
//   1. Loads the source file manifest (via lib/cobolt-file-manifest.js)
//   2. Derives seed terms from the query
//   3. Matches files against seed terms using filename, path-segment,
//      and (optionally) content grep
//   4. Reads planning artifacts (prd.md, architecture.md, epics.md, stories,
//      rtm.json) and links matching requirement / story IDs
//   5. Applies --include / --exclude refinements
//   6. Scores per-file confidence and partitions into in-scope vs candidates
//   7. Computes an overall scope confidence
//   8. Writes analysis-scope.json to _cobolt-output/latest/analysis/<id>/
//
// No LLM calls. Pure Node. Safe for CI.

const fs = require('node:fs');
const path = require('node:path');

const { buildSourceFileManifest } = require('../lib/cobolt-file-manifest');
const { resolveReadablePlanningDir, resolveRtmFile } = require('../lib/cobolt-planning-artifacts');

const DEFAULT_CONFIDENCE_THRESHOLD = 70;
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'end',
  'flow',
  'for',
  'from',
  'in',
  'into',
  'is',
  'of',
  'on',
  'or',
  'out',
  'over',
  'the',
  'to',
  'with',
]);

const SURFACE_HINTS = [
  { surface: 'api', pathPatterns: [/\/api\//i, /\/routes?\//i, /\/handlers?\//i, /\/controllers?\//i] },
  { surface: 'backend', pathPatterns: [/\/server\//i, /\/services?\//i, /\/backend\//i, /\/workers?\//i] },
  {
    surface: 'frontend',
    pathPatterns: [
      /\/components?\//i,
      /\/pages?\//i,
      /\/views?\//i,
      /\/ui\//i,
      /\.tsx?$/i,
      /\.jsx$/i,
      /\.vue$/i,
      /\.svelte$/i,
    ],
  },
  { surface: 'wireframes', pathPatterns: [/wireframe/i, /design-tokens/i, /\/stitch\//i, /\/figma\//i] },
  { surface: 'db', pathPatterns: [/\/migrations?\//i, /\/schema\//i, /\/db\//i, /\.sql$/i] },
  { surface: 'config', pathPatterns: [/\.env/i, /config/i, /\.ya?ml$/i, /\.toml$/i] },
  { surface: 'integrations', pathPatterns: [/\/clients?\//i, /\/integrations?\//i, /webhook/i, /\/queues?\//i] },
  { surface: 'tests', pathPatterns: [/\/tests?\//i, /\/spec\//i, /\.test\./i, /\.spec\./i] },
  { surface: 'ops', pathPatterns: [/\/ops\//i, /deploy/i, /ci\./i, /\.github\//i, /docker/i] },
];

const PLANNING_ARTIFACT_FILES = [
  'prd.md',
  'architecture.md',
  'trd.md',
  'implicit-requirements.md',
  'epics.md',
  'ux-design-specification.md',
  'api-contracts.md',
  'data-model-spec.md',
  'security-requirements.md',
  'master-plan.md',
  'milestones.md',
  'stories.md',
];

function slugify(value) {
  return (
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'feature'
  );
}

function generateSeedTerms(query) {
  const normalized = String(query || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/[\s_-]+/)
    .filter(Boolean);

  const terms = new Set();
  for (const token of normalized) {
    if (STOP_WORDS.has(token) || token.length < 3) continue;
    terms.add(token);
    // simple plural stemming
    if (token.endsWith('ies') && token.length > 4) terms.add(`${token.slice(0, -3)}y`);
    if (token.endsWith('es') && token.length > 4) terms.add(token.slice(0, -2));
    if (token.endsWith('s') && token.length > 3) terms.add(token.slice(0, -1));
  }

  if (terms.size === 0 && normalized[0]) {
    terms.add(normalized[0]);
  }
  return [...terms];
}

function generateAnalysisId(feature, now = new Date()) {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const HH = String(now.getUTCHours()).padStart(2, '0');
  const MM = String(now.getUTCMinutes()).padStart(2, '0');
  const SS = String(now.getUTCSeconds()).padStart(2, '0');
  return `FA-${yyyy}${mm}${dd}-${HH}${MM}${SS}-${slugify(feature)}`;
}

function detectSurface(filePath) {
  for (const hint of SURFACE_HINTS) {
    if (hint.pathPatterns.some((re) => re.test(filePath))) {
      return hint.surface;
    }
  }
  return 'backend';
}

function normalizePathList(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) =>
      String(value || '')
        .replace(/\\/g, '/')
        .replace(/^\.\//, ''),
    )
    .filter(Boolean);
}

function matchesAnyPath(filePath, prefixes) {
  const normalized = filePath.replace(/\\/g, '/');
  return prefixes.some((prefix) => {
    const clean = prefix.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    return normalized === clean || normalized.startsWith(`${clean}/`) || normalized.includes(clean);
  });
}

function loadJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function uniqueExistingPaths(paths) {
  const seen = new Set();
  const results = [];

  for (const candidate of paths) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    if (fs.existsSync(candidate)) results.push(candidate);
  }

  return results;
}

function planningArtifactDirs(projectRoot) {
  const readablePlanningDir = resolveReadablePlanningDir(projectRoot, { allowLatestFallback: true });
  return uniqueExistingPaths([
    readablePlanningDir,
    path.join(projectRoot, '_cobolt-output', 'latest', 'planning'),
    path.join(projectRoot, '_cobolt-output', 'planning'),
    // Backward-compatible read-only fallback for artifacts created before the
    // canonical planning directory name was standardized.
    path.join(projectRoot, '_cobolt-output', 'latest', 'plan'),
  ]);
}

function readPlanningArtifacts(projectRoot) {
  const docsDir = path.join(projectRoot, 'docs');
  const candidates = [];

  for (const dir of uniqueExistingPaths([docsDir, ...planningArtifactDirs(projectRoot)])) {
    if (!fs.existsSync(dir)) continue;
    for (const file of PLANNING_ARTIFACT_FILES) {
      const fullPath = path.join(dir, file);
      if (fs.existsSync(fullPath)) candidates.push(fullPath);
    }
  }

  const artifacts = [];
  for (const candidate of candidates) {
    try {
      const content = fs.readFileSync(candidate, 'utf8');
      artifacts.push({
        path: path.relative(projectRoot, candidate).replace(/\\/g, '/'),
        content,
      });
    } catch {
      /* ignore read errors */
    }
  }
  return artifacts;
}

function readRtm(projectRoot) {
  const candidates = [
    resolveRtmFile(projectRoot, 'read'),
    path.join(projectRoot, '_cobolt-output', 'latest', 'plan', 'rtm.json'),
    path.join(projectRoot, '_cobolt-output', 'rtm.json'),
  ];
  for (const candidate of uniqueExistingPaths(candidates)) {
    const payload = loadJson(candidate);
    if (payload) return { path: candidate, data: payload };
  }
  return null;
}

function readStoryTracker(projectRoot) {
  const candidates = [
    ...planningArtifactDirs(projectRoot).map((dir) => path.join(dir, 'story-tracker.json')),
    path.join(projectRoot, '_cobolt-output', 'story-tracker.json'),
  ];
  for (const candidate of uniqueExistingPaths(candidates)) {
    const payload = loadJson(candidate);
    if (payload) return { path: candidate, data: payload };
  }
  return null;
}

function collectRequirementMatches(seedTerms, planningArtifacts) {
  const requirements = [];
  const pattern = /\b(FR|NFR|TR|IR)-\d{3,}\b/gi;
  const lowerSeeds = seedTerms.map((t) => t.toLowerCase());

  for (const artifact of planningArtifacts) {
    const lines = artifact.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lower = line.toLowerCase();
      if (!lowerSeeds.some((term) => lower.includes(term))) continue;
      const ids = line.match(pattern);
      if (!ids) continue;
      for (const id of ids) {
        const normalized = id.toUpperCase();
        if (!requirements.some((entry) => entry.id === normalized)) {
          requirements.push({
            id: normalized,
            source: 'prd',
            title: line.trim().slice(0, 120),
          });
        }
      }
    }
  }
  return requirements;
}

function seedFromRtm(rtmData, seedId) {
  if (!rtmData || !seedId) return null;
  const idUpper = String(seedId).toUpperCase();
  const entries = Array.isArray(rtmData.entries) ? rtmData.entries : [];
  for (const entry of entries) {
    if (String(entry.id || '').toUpperCase() === idUpper) {
      return {
        id: idUpper,
        title: entry.title || entry.description || idUpper,
        files: Array.isArray(entry.files) ? entry.files : [],
        stories: Array.isArray(entry.stories) ? entry.stories : [],
        source: 'rtm',
      };
    }
  }
  return null;
}

function seedFromStoryTracker(tracker, storyId) {
  if (!tracker || !storyId) return null;
  const stories = Array.isArray(tracker.stories) ? tracker.stories : [];
  const target = stories.find((s) => String(s.id || '').toUpperCase() === String(storyId).toUpperCase());
  if (!target) return null;
  return {
    id: String(storyId).toUpperCase(),
    title: target.title || target.summary || target.id,
    files: Array.isArray(target.files) ? target.files : [],
    requirements: Array.isArray(target.requirements) ? target.requirements : [],
    source: 'story-tracker',
  };
}

function scoreFile(evidence) {
  if (!evidence || evidence.length === 0) return 0;
  // Base score: 20 per distinct evidence kind, capped at 100
  const kinds = new Set(evidence.map((e) => e.kind));
  const kindScore = Math.min(100, kinds.size * 22);
  // Bonus: user-include is authoritative
  if (kinds.has('user-include')) return 100;
  // Bonus: planning-artifact + filename-match is high-signal
  if (kinds.has('planning-artifact') && (kinds.has('filename-match') || kinds.has('path-segment-match'))) {
    return Math.min(100, kindScore + 20);
  }
  return kindScore;
}

const CONTENT_GREP_MAX_FILES = 600;
const CONTENT_GREP_MAX_BYTES = 200 * 1024;

function contentContainsTerm(projectRoot, relPath, lowerTerms) {
  try {
    const full = path.join(projectRoot, relPath);
    const stat = fs.statSync(full);
    if (stat.size > CONTENT_GREP_MAX_BYTES) return null;
    const content = fs.readFileSync(full, 'utf8').toLowerCase();
    for (const term of lowerTerms) {
      if (content.includes(term)) return term;
    }
    return null;
  } catch {
    return null;
  }
}

function computeFileScope(manifest, seedTerms, refinements, seededFilesFromRtm, projectRoot) {
  const includes = normalizePathList(refinements.includes);
  const excludes = normalizePathList(refinements.excludes);
  const seededFiles = new Set(normalizePathList(seededFilesFromRtm));
  const lowerTerms = seedTerms.map((t) => t.toLowerCase());

  const results = [];
  let contentScans = 0;
  for (const file of manifest.files) {
    if (excludes.length > 0 && matchesAnyPath(file, excludes)) continue;

    const evidence = [];
    const lowerFile = file.toLowerCase();
    const baseName = path.basename(file).toLowerCase();

    // Filename match
    for (const term of seedTerms) {
      if (baseName.includes(term)) {
        evidence.push({ kind: 'filename-match', reason: `filename contains "${term}"`, source: file });
        break;
      }
    }
    // Path segment match (distinct from filename to avoid double-counting the same term)
    for (const term of seedTerms) {
      const segments = lowerFile.split('/').slice(0, -1);
      if (segments.some((seg) => seg.includes(term))) {
        evidence.push({ kind: 'path-segment-match', reason: `path segment contains "${term}"`, source: file });
        break;
      }
    }
    // User include (authoritative)
    if (includes.length > 0 && matchesAnyPath(file, includes)) {
      evidence.push({ kind: 'user-include', reason: '--include refinement', source: file });
    }
    // RTM/story-seeded file
    if (seededFiles.has(file)) {
      evidence.push({ kind: 'rtm-link', reason: 'linked via RTM or story seed', source: file });
    }
    // Content grep — only run when the file already has a weak hit OR we're within the scan budget.
    // This bounds I/O for large repos while still catching symbol-level mentions.
    if (projectRoot && (evidence.length > 0 || contentScans < CONTENT_GREP_MAX_FILES)) {
      const hit = contentContainsTerm(projectRoot, file, lowerTerms);
      if (hit) {
        evidence.push({ kind: 'content-match', reason: `content mentions "${hit}"`, source: file });
      }
      contentScans += 1;
    }

    if (evidence.length === 0) continue;

    const confidence = scoreFile(evidence);
    results.push({
      path: file,
      surface: detectSurface(file),
      confidence,
      graphDepth: 0,
      scopeEvidence: evidence,
    });
  }

  // Force-include any user-specified paths that were not in the manifest (e.g. directories)
  for (const inc of includes) {
    if (results.some((r) => r.path === inc)) continue;
    // If caller asked for a directory prefix that did produce matches above, skip
    if (results.some((r) => matchesAnyPath(r.path, [inc]))) continue;
    results.push({
      path: inc,
      surface: detectSurface(inc),
      confidence: 100,
      graphDepth: 0,
      scopeEvidence: [{ kind: 'user-include', reason: '--include forced path', source: inc }],
    });
  }

  return results;
}

function computeOverallConfidence(fileScope, planningArtifacts, requirements) {
  if (fileScope.length === 0) {
    return {
      overall: 0,
      inputs: {
        evidenceCount: 0,
        evidenceDiversity: 0,
        planningArtifacts: planningArtifacts.length,
        runtimeEvidence: false,
      },
    };
  }

  const totalEvidence = fileScope.reduce((acc, file) => acc + file.scopeEvidence.length, 0);
  const kinds = new Set();
  for (const file of fileScope) {
    for (const ev of file.scopeEvidence) kinds.add(ev.kind);
  }
  const diversity = Math.min(1, kinds.size / 6); // 6 = a good spread of distinct evidence kinds
  const avgFileScore = fileScope.reduce((acc, f) => acc + f.confidence, 0) / fileScope.length;

  // Weighted blend: file score weight 0.6, diversity 0.25, planning/rtm presence 0.15
  const planningBonus = Math.min(1, (planningArtifacts.length + requirements.length) / 4);
  const overall = Math.round(avgFileScore * 0.6 + diversity * 100 * 0.25 + planningBonus * 100 * 0.15);

  return {
    overall: Math.max(0, Math.min(100, overall)),
    inputs: {
      evidenceCount: totalEvidence,
      evidenceDiversity: Number(diversity.toFixed(2)),
      planningArtifacts: planningArtifacts.length,
      runtimeEvidence: false,
    },
  };
}

function deriveSurfaces(fileScope) {
  const surfaces = new Set();
  for (const file of fileScope) surfaces.add(file.surface);
  return [...surfaces].sort();
}

function partitionScope(fileScope, threshold) {
  const files = [];
  const candidateFiles = [];
  for (const entry of fileScope) {
    if (entry.confidence >= threshold) {
      files.push(entry);
    } else {
      candidateFiles.push(entry);
    }
  }
  return { files, candidateFiles };
}

function analysisDir(projectRoot, analysisId) {
  return path.join(projectRoot, '_cobolt-output', 'latest', 'analysis', analysisId);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Build the feature scope and persist analysis-scope.json.
 * @param {object} options
 * @param {string} options.query           - Feature query string
 * @param {string} [options.analysisId]    - Reuse an existing analysis ID
 * @param {string} [options.projectRoot]   - Defaults to cwd
 * @param {string[]} [options.includes]    - --include paths
 * @param {string[]} [options.excludes]    - --exclude paths
 * @param {number} [options.threshold]     - Confidence threshold, defaults to 70
 * @param {string} [options.seedFromPrd]   - FR-###/NFR-###/TR-###/IR-### seed
 * @param {string} [options.seedFromStory] - Story ID seed
 * @param {boolean} [options.forceLowConfidence]
 * @returns {object} scope payload written to disk
 */
function discoverFeatureScope(options) {
  const query = String(options.query || '').trim();
  if (!query && !options.seedFromPrd && !options.seedFromStory) {
    throw new Error('discoverFeatureScope requires options.query, seedFromPrd, or seedFromStory');
  }

  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const analysisId = options.analysisId || generateAnalysisId(query || options.seedFromPrd || options.seedFromStory);
  const threshold = Number.isFinite(options.threshold) ? options.threshold : DEFAULT_CONFIDENCE_THRESHOLD;

  const manifest = buildSourceFileManifest(projectRoot, { maxFiles: 20000 });
  const seedTerms = generateSeedTerms(query);

  // Seed expansions
  let seededFiles = [];
  let seedSource = 'text';
  const seededRequirements = [];

  if (options.seedFromPrd) {
    const rtm = readRtm(projectRoot);
    const match = seedFromRtm(rtm?.data, options.seedFromPrd);
    if (match) {
      seededFiles = match.files;
      seededRequirements.push({ id: match.id, source: 'rtm', title: match.title });
      seedSource = 'from-prd';
      seedTerms.push(...generateSeedTerms(match.title));
    }
  }
  if (options.seedFromStory) {
    const tracker = readStoryTracker(projectRoot);
    const match = seedFromStoryTracker(tracker?.data, options.seedFromStory);
    if (match) {
      seededFiles = [...seededFiles, ...match.files];
      seedSource = seedSource === 'text' ? 'from-story' : seedSource;
      seedTerms.push(...generateSeedTerms(match.title));
    }
  }

  const uniqueSeedTerms = [...new Set(seedTerms)];
  const planningArtifacts = readPlanningArtifacts(projectRoot);
  const requirementMatches = collectRequirementMatches(uniqueSeedTerms, planningArtifacts);
  const allRequirements = [...seededRequirements];
  for (const req of requirementMatches) {
    if (!allRequirements.some((r) => r.id === req.id)) allRequirements.push(req);
  }

  const refinements = {
    includes: normalizePathList(options.includes),
    excludes: normalizePathList(options.excludes),
    forceLowConfidence: Boolean(options.forceLowConfidence),
  };

  const rawScope = computeFileScope(manifest, uniqueSeedTerms, refinements, seededFiles, projectRoot);

  // FIX (#1 confidence calc): compute overall confidence from ALL evidence-bearing
  // files BEFORE partitioning. Doing it after partitioning produced a chicken-and-egg
  // at the default threshold (70): every file scored 44, nothing cleared the bar,
  // `files` was empty, overall confidence was 0 — which then blocked reviewer dispatch.
  // The threshold is a dispatch/display filter, not an input to confidence measurement.
  const confidence = computeOverallConfidence(rawScope, planningArtifacts, allRequirements);
  confidence.threshold = threshold;
  confidence.belowThreshold = confidence.overall < threshold && !refinements.forceLowConfidence;

  const { files, candidateFiles } = partitionScope(rawScope, threshold);

  // Surfaces derived from the *combined* scope so that refinement suggestions
  // reflect what was actually found, not only what cleared the threshold.
  const allScopedFiles = [...files, ...candidateFiles];

  // Staleness: only include sourceCommit when we actually know it. Writing
  // `null` failed analysis-scope.schema.json (type: string, null not allowed).
  const staleness = {
    fileCount: manifest.totalFiles,
    lastCheckedAt: new Date().toISOString(),
  };
  if (manifest.truncated) {
    staleness.truncated = true;
  }

  const payload = {
    version: '1.0.0',
    analysisId,
    feature: {
      query: query || options.seedFromPrd || options.seedFromStory,
      slug: slugify(query || options.seedFromPrd || options.seedFromStory),
      aliases: [],
    },
    generatedAt: new Date().toISOString(),
    sourceRoot: projectRoot,
    seedSource,
    seedTerms: uniqueSeedTerms,
    surfaces: deriveSurfaces(allScopedFiles),
    files,
    candidateFiles,
    requirements: allRequirements,
    routes: [],
    apiContracts: allScopedFiles
      .filter((f) => f.path.includes('api-contracts') || f.path.endsWith('.openapi.yaml'))
      .map((f) => f.path),
    uiRoutes: [],
    wireframes: allScopedFiles.filter((f) => f.surface === 'wireframes').map((f) => f.path),
    integrations: allScopedFiles.filter((f) => f.surface === 'integrations').map((f) => f.path),
    configs: allScopedFiles.filter((f) => f.surface === 'config').map((f) => f.path),
    tests: allScopedFiles.filter((f) => f.surface === 'tests').map((f) => f.path),
    confidence,
    refinements,
    staleness,
  };

  const outputPath = path.join(analysisDir(projectRoot, analysisId), 'analysis-scope.json');
  writeJson(outputPath, payload);

  return { payload, outputPath, analysisId, manifestTruncated: manifest.truncated };
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      [
        'cobolt-analysis-scope — feature scope discovery',
        '',
        'Usage:',
        '  cobolt-analysis-scope "<feature>" [--path <dir>] [--include <p>]... [--exclude <p>]...',
        '  cobolt-analysis-scope --from-prd FR-012 [--path <dir>]',
        '  cobolt-analysis-scope --from-story E3-S2 [--path <dir>]',
        '',
      ].join('\n'),
    );
    return 0;
  }

  const options = { includes: [], excludes: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--path' && next) {
      options.projectRoot = next;
      i++;
    } else if (arg === '--include' && next) {
      options.includes.push(next);
      i++;
    } else if (arg === '--exclude' && next) {
      options.excludes.push(next);
      i++;
    } else if (arg === '--from-prd' && next) {
      options.seedFromPrd = next;
      i++;
    } else if (arg === '--from-story' && next) {
      options.seedFromStory = next;
      i++;
    } else if (arg === '--analysis-id' && next) {
      options.analysisId = next;
      i++;
    } else if (arg === '--force-low-confidence') {
      options.forceLowConfidence = true;
    } else if (!arg.startsWith('--')) {
      options.query = options.query ? `${options.query} ${arg}` : arg;
    }
  }

  try {
    const result = discoverFeatureScope(options);
    process.stdout.write(
      `${JSON.stringify({ analysisId: result.analysisId, outputPath: result.outputPath, confidence: result.payload.confidence.overall, filesInScope: result.payload.files.length, candidateFiles: result.payload.candidateFiles.length }, null, 2)}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`cobolt-analysis-scope failed: ${err.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = {
  DEFAULT_CONFIDENCE_THRESHOLD,
  discoverFeatureScope,
  generateAnalysisId,
  generateSeedTerms,
  slugify,
  detectSurface,
  computeFileScope,
  computeOverallConfidence,
  partitionScope,
  scoreFile,
  _main: main,
};
