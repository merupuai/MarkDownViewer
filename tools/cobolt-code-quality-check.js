#!/usr/bin/env node

// cobolt-code-quality-check — PR-2 Batch B (v0.53.0).
//
// Orchestrator that runs cobolt-cyclomatic-complexity + cobolt-code-duplication-detect
// against per-language thresholds from code-quality-thresholds.schema.json.
// Per-story waivers are honored. Tier-3 shadow at day-1 (PR-4 wires it as a
// gate); promoted to Tier-2 once project median is below thresholds, Tier-1
// once 95th percentile is below.
//
// Usage:
//   node tools/cobolt-code-quality-check.js check [--cwd PATH] [--policy PATH] [--root DIR] [--story SID] [--milestone M1] [--json]
//   node tools/cobolt-code-quality-check.js --help
//
// Exit codes: 0 ok, 1 thresholds exceeded (no waiver), 2 missing policy file,
// 3 source root unreadable.

const fs = require('node:fs');
const path = require('node:path');

const complexityTool = require('./cobolt-cyclomatic-complexity');
const dupTool = require('./cobolt-code-duplication-detect');
const fingerprintTool = require('./cobolt-ai-author-fingerprint');

const DEFAULT_THRESHOLDS = {
  default: { duplicationPercent: 3, complexityCeiling: 85 },
  languages: {
    rs: { duplicationPercent: 5, complexityCeiling: 110 },
    ex: { duplicationPercent: 4, complexityCeiling: 95 },
    exs: { duplicationPercent: 4, complexityCeiling: 95 },
  },
};

const COMMON_SOURCE_ROOTS = [
  'src',
  'app',
  'server',
  'client',
  'frontend/src',
  'backend/src',
  'backend/app',
  'lib',
  'pages',
  'components',
];

function normalizeRelPath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/g, '');
}

function readJsonIfExists(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function addExistingRoot(cwd, roots, value) {
  const rel = normalizeRelPath(value);
  if (!rel || rel === '.') return;
  const absolutePath = path.resolve(cwd, rel);
  if (!fs.existsSync(absolutePath)) return;
  try {
    if (!fs.statSync(absolutePath).isDirectory()) return;
  } catch {
    return;
  }
  roots.add(path.relative(cwd, absolutePath).replace(/\\/g, '/') || rel);
}

function addEntrypointRoot(cwd, roots, entrypoint) {
  const rel = normalizeRelPath(entrypoint);
  if (!rel) return;
  addExistingRoot(cwd, roots, path.dirname(rel));
}

function addSelectedStackRoots(cwd, roots) {
  const contract = readJsonIfExists(
    path.join(cwd, '_cobolt-output', 'latest', 'planning', 'selected-stack-contract.json'),
  );
  if (!contract || typeof contract !== 'object') return;
  for (const section of [contract.frontend, contract.backend]) {
    if (!section || typeof section !== 'object') continue;
    for (const folder of section.requiredFolders || []) addExistingRoot(cwd, roots, folder);
    addEntrypointRoot(cwd, roots, section.entrypoint);
  }
}

function workspacePatterns(pkg) {
  if (Array.isArray(pkg?.workspaces)) return pkg.workspaces;
  if (Array.isArray(pkg?.workspaces?.packages)) return pkg.workspaces.packages;
  return [];
}

function expandWorkspacePattern(cwd, pattern) {
  const normalized = normalizeRelPath(pattern).replace(/\/\*\*$/u, '/*');
  if (!normalized.includes('*')) return [normalized];
  const parts = normalized.split('/');
  const starIndex = parts.indexOf('*');
  if (starIndex === -1) return [];
  const base = path.join(cwd, ...parts.slice(0, starIndex));
  const suffix = parts.slice(starIndex + 1);
  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(...parts.slice(0, starIndex), entry.name, ...suffix).replace(/\\/g, '/'));
}

function addPackageWorkspaceRoots(cwd, roots) {
  const pkg = readJsonIfExists(path.join(cwd, 'package.json'));
  if (!pkg || typeof pkg !== 'object') return;
  for (const pattern of workspacePatterns(pkg)) {
    for (const workspaceRoot of expandWorkspacePattern(cwd, pattern)) {
      const srcRoot = path.join(workspaceRoot, 'src');
      if (fs.existsSync(path.join(cwd, srcRoot))) addExistingRoot(cwd, roots, srcRoot);
      else if (fs.existsSync(path.join(cwd, workspaceRoot, 'package.json'))) addExistingRoot(cwd, roots, workspaceRoot);
    }
  }
  if (pkg.directories?.lib) addExistingRoot(cwd, roots, pkg.directories.lib);
}

function discoverSourceRoots(cwd) {
  const roots = new Set();
  addSelectedStackRoots(cwd, roots);
  addPackageWorkspaceRoots(cwd, roots);
  for (const candidate of COMMON_SOURCE_ROOTS) addExistingRoot(cwd, roots, candidate);
  return [...roots];
}

function resolveQualityRoots(cwd, root) {
  if (root !== undefined && root !== null && root !== '') return Array.isArray(root) ? root : [root];
  const discovered = discoverSourceRoots(cwd);
  return discovered.length > 0 ? discovered : ['src'];
}

function loadPolicy(cwd, policyPath) {
  const candidates = policyPath
    ? [policyPath]
    : [
        path.join(cwd, '_cobolt-output', 'latest', 'planning', 'code-quality-thresholds.json'),
        path.join(cwd, 'code-quality-thresholds.json'),
      ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        return { policy: JSON.parse(fs.readFileSync(p, 'utf8')), source: p };
      } catch (err) {
        return { policy: null, error: `policy parse error: ${err.message}`, _exit: 1 };
      }
    }
  }
  if (policyPath) return { policy: null, error: `policy not found: ${policyPath}`, _exit: 2 };
  return { policy: { version: '1.0.0', ...DEFAULT_THRESHOLDS }, source: '<default>' };
}

function thresholdsForLanguage(policy, ext) {
  const lang = (ext || '').replace('.', '').toLowerCase();
  return policy.languages?.[lang] || policy.default;
}

function isWaived(policy, storyId, metric) {
  if (!storyId || !Array.isArray(policy.perStoryWaivers)) return false;
  return policy.perStoryWaivers.some((w) => w.storyId === storyId && w.metric === metric);
}

function buildRoot(cwd, milestoneId) {
  return path.join(cwd, '_cobolt-output', 'latest', 'build', milestoneId);
}

function checkpointRoot(cwd) {
  return path.join(cwd, '_cobolt-output', 'latest', 'build', 'checkpoints');
}

function relativePath(cwd, filePath) {
  return path.relative(cwd, filePath).replace(/\\/g, '/');
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

function summarizeFingerprint(fingerprint) {
  const counts = {};
  for (const file of fingerprint.files || []) {
    counts[file.verdict] = (counts[file.verdict] || 0) + 1;
  }
  return {
    fileCount: Array.isArray(fingerprint.files) ? fingerprint.files.length : 0,
    verdictCounts: counts,
    error: fingerprint.error || null,
  };
}

function writeMilestoneArtifacts(cwd, milestoneId, result, { root, storyId } = {}) {
  const qualityPath = path.join(buildRoot(cwd, milestoneId), `${milestoneId}-code-quality.json`);
  const fingerprintPath = path.join(buildRoot(cwd, milestoneId), `${milestoneId}-ai-author-fingerprint.json`);
  const checkpointPath = path.join(checkpointRoot(cwd), `${milestoneId}-04a0-code-quality.json`);
  try {
    const fingerprint = fingerprintTool.scan({ cwd, root, milestoneId, storyId });
    writeJson(fingerprintPath, fingerprint);
    const enriched = {
      ...result,
      milestoneId,
      fingerprint: {
        artifact: relativePath(cwd, fingerprintPath),
        ...summarizeFingerprint(fingerprint),
      },
    };
    writeJson(qualityPath, enriched);
    writeJson(checkpointPath, {
      checkpoint: 'code-quality',
      milestone: milestoneId,
      status: result.verdict === 'pass' ? 'completed' : 'failed',
      verdict: result.verdict,
      generatedAt: result.generatedAt || new Date().toISOString(),
      generatedBy: 'cobolt-code-quality-check',
      artifacts: [qualityPath, fingerprintPath].map((filePath) => relativePath(cwd, filePath)),
      metrics: {
        dupPercent: result.dup?.dupPercent ?? null,
        maxComplexity: result.complexity?.maxComplexity ?? null,
        errorCount: result.errorCount ?? null,
        policy: result.policy || null,
        fingerprintFileCount: enriched.fingerprint.fileCount,
      },
      nextStep: '03a-code-gap-analysis',
    });
    return {
      ...enriched,
      artifactPath: qualityPath,
      fingerprintPath,
      checkpointPath,
    };
  } catch (err) {
    return {
      ...result,
      milestoneId,
      verdict: 'write-failed',
      error: `could not write code-quality artifacts: ${err.message}`,
      _exit: 3,
    };
  }
}

function finalizeCheckResult(result, options) {
  if (!options?.milestoneId) return result;
  return writeMilestoneArtifacts(options.cwd || process.cwd(), options.milestoneId, result, options);
}

function check({ cwd, root, policyPath, storyId, milestoneId } = {}) {
  cwd = cwd || process.cwd();
  const sourceRoots = resolveQualityRoots(cwd, root);
  const policyLoad = loadPolicy(cwd, policyPath);
  if (!policyLoad.policy) {
    return finalizeCheckResult(
      {
        schema: 'cobolt-code-quality-check@1',
        verdict: 'policy-missing',
        error: policyLoad.error,
        _exit: policyLoad._exit,
      },
      { cwd, root: sourceRoots, storyId, milestoneId },
    );
  }
  const policy = policyLoad.policy;
  const dup = dupTool.scan({ cwd, root: sourceRoots, blockSize: 5, threshold: policy.default.duplicationPercent });
  const complexity = complexityTool.scan({ cwd, root: sourceRoots, threshold: policy.default.complexityCeiling });
  if (dup._exit && dup._exit !== 1) {
    return finalizeCheckResult(
      {
        schema: 'cobolt-code-quality-check@1',
        verdict: dup.verdict,
        error: 'duplication scan failed',
        _exit: dup._exit,
      },
      { cwd, root: sourceRoots, storyId, milestoneId },
    );
  }
  if (complexity._exit && complexity._exit !== 1) {
    return finalizeCheckResult(
      {
        schema: 'cobolt-code-quality-check@1',
        verdict: complexity.verdict,
        error: 'complexity scan failed',
        _exit: complexity._exit,
      },
      { cwd, root: sourceRoots, storyId, milestoneId },
    );
  }
  // Re-evaluate complexity findings against per-language thresholds + waivers.
  const complexityViolations = [];
  for (const f of complexity.findings || []) {
    const ext = path.extname(f.file);
    const t = thresholdsForLanguage(policy, ext);
    if (f.complexity > t.complexityCeiling) {
      const waived = isWaived(policy, storyId, 'complexityCeiling');
      complexityViolations.push({ ...f, ceiling: t.complexityCeiling, waived });
    }
  }
  const dupViolation =
    dup.dupPercent > policy.default.duplicationPercent
      ? {
          dupPercent: dup.dupPercent,
          threshold: policy.default.duplicationPercent,
          waived: isWaived(policy, storyId, 'duplicationPercent'),
        }
      : null;
  const errorCount =
    (dupViolation && !dupViolation.waived ? 1 : 0) + complexityViolations.filter((v) => !v.waived).length;
  return finalizeCheckResult(
    {
      schema: 'cobolt-code-quality-check@1',
      cwd,
      root: sourceRoots.length === 1 ? sourceRoots[0] : sourceRoots,
      sourceRoots,
      generatedAt: new Date().toISOString(),
      policy: policyLoad.source,
      storyId,
      dup: {
        dupPercent: dup.dupPercent,
        threshold: policy.default.duplicationPercent,
        files: dup.files,
        blockCount: dup.blockCount,
      },
      complexity: {
        maxComplexity: complexity.maxComplexity,
        ceiling: policy.default.complexityCeiling,
        files: complexity.files,
        functions: complexity.functions,
      },
      violations: { duplication: dupViolation, complexity: complexityViolations },
      errorCount,
      verdict: errorCount === 0 ? 'pass' : 'fail',
    },
    { cwd, root: sourceRoots, storyId, milestoneId },
  );
}

function printHelp() {
  process.stdout.write(
    `cobolt-code-quality-check — orchestrate dup + complexity vs thresholds\n\n` +
      `Usage: node tools/cobolt-code-quality-check.js check [--root DIR] [--policy PATH] [--story SID] [--milestone M1] [--cwd PATH] [--json]\n` +
      `Exit: 0 pass, 1 thresholds exceeded, 2 missing policy, 3 unreadable root\n`,
  );
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--cwd') args.cwd = argv[++i];
    else if (a === '--policy') args.policyPath = argv[++i];
    else if (a === '--story') args.storyId = argv[++i];
    else if (a === '--milestone') args.milestoneId = argv[++i];
    else if (a === '--json') args.json = true;
  }
  return args;
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return 0;
  }
  if (!argv[0]) {
    printHelp();
    return 0;
  }
  if (argv[0] !== 'check') {
    process.stderr.write(`unknown command: ${argv[0]}\n`);
    return 1;
  }
  const args = parseArgs(argv.slice(1));
  const result = check(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `code-quality: ${result.verdict} (dup=${result.dup?.dupPercent ?? '?'}% / max-complexity=${result.complexity?.maxComplexity ?? '?'}, errors=${result.errorCount ?? '?'})\n`,
    );
  }
  if (result._exit) return result._exit;
  return result.verdict === 'fail' ? 1 : 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  check,
  discoverSourceRoots,
  resolveQualityRoots,
  loadPolicy,
  thresholdsForLanguage,
  isWaived,
  writeMilestoneArtifacts,
  DEFAULT_THRESHOLDS,
};
