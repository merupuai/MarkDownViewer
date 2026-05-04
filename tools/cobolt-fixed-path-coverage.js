#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function loadJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, ''));
  } catch {
    return null;
  }
}

function normalizeRelative(filePath) {
  return String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//u, '');
}

function isTestFile(filePath) {
  return /(^|\/)(test|tests|spec|__tests__)(\/|$)|\.(test|spec)\./iu.test(normalizeRelative(filePath));
}

function isSourceFile(filePath) {
  const normalized = normalizeRelative(filePath);
  return (
    !isTestFile(normalized) &&
    /\.(js|jsx|ts|tsx|mjs|cjs|py|rb|java|kt|cs|go|rs|php|ex|exs|swift|scala|vue|svelte)$/iu.test(normalized)
  );
}

function normalizeCoverageKey(projectRoot, filePath) {
  if (!filePath) return null;
  const normalized = normalizeRelative(filePath);
  if (!path.isAbsolute(filePath)) return normalized;
  const relative = normalizeRelative(path.relative(projectRoot, filePath));
  return relative.startsWith('..') ? normalized : relative;
}

function addCoverageEntry(map, filePath, covered, total, source) {
  const key = normalizeRelative(filePath);
  if (!key) return;
  const current = map.get(key) || { file: key, covered: 0, total: 0, sources: [] };
  current.covered = Math.max(current.covered, Number(covered || 0));
  current.total = Math.max(current.total, Number(total || 0));
  if (!current.sources.includes(source)) current.sources.push(source);
  map.set(key, current);
}

function readCoverageFinal(projectRoot, filePath, map) {
  const payload = loadJson(filePath);
  if (!payload || typeof payload !== 'object') return false;
  for (const [key, entry] of Object.entries(payload)) {
    if (!entry || typeof entry !== 'object') continue;
    const normalized = normalizeCoverageKey(projectRoot, key);
    const statements = Object.values(entry.s || {});
    if (statements.length === 0) continue;
    addCoverageEntry(
      map,
      normalized,
      statements.filter((value) => Number(value) > 0).length,
      statements.length,
      normalizeRelative(path.relative(projectRoot, filePath)),
    );
  }
  return map.size > 0;
}

function readCoverageSummary(projectRoot, filePath, map) {
  const payload = loadJson(filePath);
  if (!payload || typeof payload !== 'object') return false;
  for (const [key, entry] of Object.entries(payload)) {
    if (key === 'total' || !entry || typeof entry !== 'object') continue;
    const normalized = normalizeCoverageKey(projectRoot, key);
    const total = Number(entry.lines?.total || 0);
    const covered = Number(entry.lines?.covered || 0);
    if (total <= 0) continue;
    addCoverageEntry(map, normalized, covered, total, normalizeRelative(path.relative(projectRoot, filePath)));
  }
  return map.size > 0;
}

function readLcov(projectRoot, filePath, map) {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, 'utf8');
  let currentFile = null;
  let total = 0;
  let covered = 0;
  let changed = false;

  function flush() {
    if (!currentFile || total === 0) return;
    addCoverageEntry(
      map,
      normalizeCoverageKey(projectRoot, currentFile),
      covered,
      total,
      normalizeRelative(path.relative(projectRoot, filePath)),
    );
    changed = true;
  }

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = String(rawLine || '').trim();
    if (line.startsWith('SF:')) {
      flush();
      currentFile = line.slice(3).trim();
      total = 0;
      covered = 0;
    } else if (line.startsWith('DA:')) {
      const [, hitCount] = line.slice(3).split(',');
      total += 1;
      if (Number(hitCount || 0) > 0) covered += 1;
    } else if (line === 'end_of_record') {
      flush();
      currentFile = null;
      total = 0;
      covered = 0;
    }
  }
  flush();
  return changed;
}

function collectFileCoverage(projectRoot = process.cwd()) {
  const root = path.resolve(projectRoot);
  const map = new Map();
  const candidates = [
    path.join(root, 'coverage', 'coverage-final.json'),
    path.join(root, 'coverage', 'coverage-summary.json'),
    path.join(root, 'coverage', 'lcov.info'),
  ];
  const usedArtifacts = [];

  for (const candidate of candidates) {
    let used = false;
    if (candidate.endsWith('coverage-final.json')) used = readCoverageFinal(root, candidate, map);
    else if (candidate.endsWith('coverage-summary.json')) used = readCoverageSummary(root, candidate, map);
    else if (candidate.endsWith('lcov.info')) used = readLcov(root, candidate, map);
    if (used) usedArtifacts.push(normalizeRelative(path.relative(root, candidate)));
  }

  return {
    files: [...map.values()].sort((left, right) => left.file.localeCompare(right.file, undefined, { numeric: true })),
    artifacts: usedArtifacts,
  };
}

function defaultFixSurfacePath(projectRoot) {
  return path.join(projectRoot, '_cobolt-output', 'latest', 'fix', 'fix-touched-surface-gates.json');
}

function checkFixedPathCoverage(projectRoot = process.cwd(), options = {}) {
  const root = path.resolve(projectRoot);
  const fixSurfacePath = path.resolve(options.fixSurfacePath || defaultFixSurfacePath(root));
  const touchedSurface = loadJson(fixSurfacePath) || {};
  const changedFiles = Array.isArray(touchedSurface.changedFiles)
    ? touchedSurface.changedFiles.map(normalizeRelative)
    : [];
  const sourceFiles = changedFiles.filter(isSourceFile);

  if (sourceFiles.length === 0) {
    return {
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      generatedBy: 'cobolt-fixed-path-coverage',
      projectRoot: root,
      milestone: options.milestone || null,
      status: 'not_applicable',
      passed: true,
      fixSurfacePath: normalizeRelative(path.relative(root, fixSurfacePath)),
      changedFiles,
      sourceFiles,
      coverageArtifacts: [],
      coveredFiles: [],
      uncoveredFiles: [],
      reasons: ['No changed source files were recorded for the fix handoff.'],
    };
  }

  const fileCoverage = collectFileCoverage(root);
  if (fileCoverage.artifacts.length === 0) {
    return {
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      generatedBy: 'cobolt-fixed-path-coverage',
      projectRoot: root,
      milestone: options.milestone || null,
      status: 'fail',
      passed: false,
      fixSurfacePath: normalizeRelative(path.relative(root, fixSurfacePath)),
      changedFiles,
      sourceFiles,
      coverageArtifacts: [],
      coveredFiles: [],
      uncoveredFiles: sourceFiles,
      reasons: ['Changed source files exist but no file-level coverage artifact was found.'],
    };
  }

  const coverageByFile = new Map(fileCoverage.files.map((entry) => [normalizeRelative(entry.file), entry]));
  const coveredFiles = [];
  const uncoveredFiles = [];
  for (const filePath of sourceFiles) {
    const coverage = coverageByFile.get(filePath);
    if (coverage && Number(coverage.covered || 0) > 0) coveredFiles.push(filePath);
    else uncoveredFiles.push(filePath);
  }

  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-fixed-path-coverage',
    projectRoot: root,
    milestone: options.milestone || null,
    status: uncoveredFiles.length === 0 ? 'pass' : 'fail',
    passed: uncoveredFiles.length === 0,
    fixSurfacePath: normalizeRelative(path.relative(root, fixSurfacePath)),
    changedFiles,
    sourceFiles,
    coverageArtifacts: fileCoverage.artifacts,
    coveredFiles,
    uncoveredFiles,
    reasons:
      uncoveredFiles.length === 0
        ? ['Every changed source file is exercised by at least one covered line.']
        : [`${uncoveredFiles.length} changed source file(s) lack coverage evidence.`],
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    command: argv[0] || 'check',
    projectRoot: process.cwd(),
    milestone: null,
    fixSurfacePath: null,
    json: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') args.projectRoot = path.resolve(argv[++index] || args.projectRoot);
    else if (arg === '--milestone') args.milestone = argv[++index] || null;
    else if (arg === '--fix-surface') args.fixSurfacePath = argv[++index] || null;
    else if (arg === '--json') args.json = true;
  }
  return args;
}

function main() {
  const args = parseArgs();
  if (args.command !== 'check') {
    console.log(
      'Usage: node tools/cobolt-fixed-path-coverage.js check [--project <dir>] [--milestone M1] [--fix-surface <path>] [--json]',
    );
    process.exit(args.command ? 2 : 0);
  }
  const result = checkFixedPathCoverage(args.projectRoot, {
    milestone: args.milestone,
    fixSurfacePath: args.fixSurfacePath,
  });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`[cobolt-fixed-path-coverage] ${result.status}; uncovered=${result.uncoveredFiles.length}`);
  process.exit(result.passed ? 0 : 1);
}

if (require.main === module) main();

module.exports = {
  checkFixedPathCoverage,
  collectFileCoverage,
  isSourceFile,
  isTestFile,
};
