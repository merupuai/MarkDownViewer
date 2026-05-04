const fs = require('node:fs');
const path = require('node:path');

const IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.next',
  '.nuxt',
  '.turbo',
  'node_modules',
  '_cobolt-output',
  '_cobolt-docker',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  '_build',
  'deps',
  'vendor',
  '__pycache__',
]);

const NON_PRODUCTION_DIRS = new Set([
  'docs',
  'doc',
  'documentation',
  'olddocs',
  'examples',
  'example',
  'samples',
  'sample',
  'fixtures',
  'fixture',
  '__fixtures__',
  'testdata',
  'tests',
  'test',
  '__tests__',
  'spec',
  'specs',
  '__mocks__',
  'snapshots',
  '__snapshots__',
  'storybook',
  'stories',
  'e2e',
  'cypress',
  'playwright',
]);

const TEST_FILE_PATTERNS = [
  /(?:^|[./\\])[^/\\]+\.test\.[^/\\]+$/i,
  /(?:^|[./\\])[^/\\]+\.spec\.[^/\\]+$/i,
  /(?:^|[./\\])[^/\\]+_test\.[^/\\]+$/i,
  /(?:^|[./\\])test-[^/\\]+$/i,
];

const GENERATED_FILE_PATTERNS = [
  /(?:^|[./\\])[^/\\]+\.generated\.[^/\\]+$/i,
  /(?:^|[./\\])[^/\\]+\.gen\.[^/\\]+$/i,
  /(?:^|[./\\])generated\.[^/\\]+$/i,
  /(?:^|[./\\])schema\.dump\.[^/\\]+$/i,
];

const MIGRATION_DIRS = new Set(['migrations', 'migration', 'migrate']);
const SEED_DIRS = new Set(['seeds', 'seed', 'seeders']);

function toRelativePath(rootDir, filePath) {
  return path.relative(path.resolve(rootDir), path.resolve(filePath)).replace(/\\/g, '/');
}

function pathSegments(relativePath) {
  return String(relativePath || '')
    .split(/[\\/]+/u)
    .filter(Boolean);
}

function addSkip(skipped, reason, kind) {
  skipped.total += 1;
  skipped[kind] += 1;
  skipped.byReason[reason] = (skipped.byReason[reason] || 0) + 1;
}

function isNonProductionPath(filePath, rootDir) {
  const relativePath = toRelativePath(rootDir, filePath);
  const segments = pathSegments(relativePath).map((segment) => segment.toLowerCase());
  if (segments.some((segment) => NON_PRODUCTION_DIRS.has(segment))) return true;
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(relativePath));
}

function isGeneratedPath(filePath, rootDir) {
  const relativePath = toRelativePath(rootDir, filePath);
  const segments = pathSegments(relativePath).map((segment) => segment.toLowerCase());
  if (segments.some((segment) => segment === 'generated' || segment === 'gen')) return true;
  return GENERATED_FILE_PATTERNS.some((pattern) => pattern.test(relativePath));
}

function isMigrationLikePath(filePath, rootDir) {
  const relativePath = rootDir ? toRelativePath(rootDir, filePath) : String(filePath || '').replace(/\\/g, '/');
  const segments = pathSegments(relativePath).map((segment) => segment.toLowerCase());
  if (segments.some((segment) => MIGRATION_DIRS.has(segment) || SEED_DIRS.has(segment))) return true;
  return /(?:^|[/\\])(?:\d+[_-].*|V\d+__.*)\.sql$/i.test(relativePath);
}

function skipDirectoryReason(entryName, options = {}) {
  const normalized = String(entryName || '').toLowerCase();
  if (IGNORED_DIRS.has(normalized)) return 'ignored-dir';
  if (options.includeNonProduction !== true && NON_PRODUCTION_DIRS.has(normalized)) return 'non-production-dir';
  if (options.includeGenerated !== true && (normalized === 'generated' || normalized === 'gen')) return 'generated-dir';
  return null;
}

function skipFileReason(filePath, rootDir, options = {}) {
  if (options.includeNonProduction !== true && isNonProductionPath(filePath, rootDir)) return 'non-production-file';
  if (options.includeGenerated !== true && isGeneratedPath(filePath, rootDir)) return 'generated-file';
  return null;
}

function walkFilteredFiles(rootDir, predicate, options = {}) {
  const resolvedRoot = path.resolve(rootDir || process.cwd());
  const collected = [];
  const skipped = { total: 0, dirs: 0, files: 0, byReason: {} };

  function walk(currentDir) {
    if (!fs.existsSync(currentDir)) return;

    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        const reason = skipDirectoryReason(entry.name, options);
        if (reason) {
          addSkip(skipped, reason, 'dirs');
          continue;
        }
        walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (typeof predicate === 'function' && !predicate(fullPath)) continue;

      const reason = skipFileReason(fullPath, resolvedRoot, options);
      if (reason) {
        addSkip(skipped, reason, 'files');
        continue;
      }

      collected.push(fullPath);
    }
  }

  walk(resolvedRoot);
  return { files: collected, skipped };
}

module.exports = {
  IGNORED_DIRS,
  NON_PRODUCTION_DIRS,
  isGeneratedPath,
  isMigrationLikePath,
  isNonProductionPath,
  toRelativePath,
  walkFilteredFiles,
};
