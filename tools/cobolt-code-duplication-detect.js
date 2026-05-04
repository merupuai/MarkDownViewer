#!/usr/bin/env node

// cobolt-code-duplication-detect — PR-2 Batch B (v0.53.0).
//
// Heuristic line-block clone detector. Builds rolling-hash buckets over
// normalized source-line windows and reports blocks duplicated across files.
// Output dup% = duplicated-lines / total-source-lines. Tier-3 advisory in
// PR-2; promoted via cobolt-code-quality-check thresholds in later PRs.
//
// Block size (default 5 lines), normalization (strip leading whitespace +
// inline comments + numeric/string literals collapsed to placeholders) is
// chosen to suppress trivial false positives while keeping the algorithm
// O(N).
//
// Usage:
//   node tools/cobolt-code-duplication-detect.js scan [--cwd PATH] [--root DIR] [--block N] [--threshold P] [--json]
//   node tools/cobolt-code-duplication-detect.js --help
//
// Exit codes: 0 ok, 1 dup% above threshold, 2 no source files, 3 unreadable root.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_EXTS = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rs',
  '.ex',
  '.exs',
  '.go',
  '.rb',
  '.java',
]);
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '_cobolt-output',
  '.cobolt-backups',
  'tests/__fixtures__',
]);

function walk(root, exts, out, depth = 0) {
  if (depth > 20) return out;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) walk(full, exts, out, depth + 1);
    else if (e.isFile() && exts.has(path.extname(e.name))) out.push(full);
  }
  return out;
}

function normalize(line) {
  return line
    .replace(/\/\/.*$/, '')
    .replace(/#.*$/, '')
    .replace(/\/\*.*?\*\//g, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '"S"')
    .replace(/'(?:[^'\\]|\\.)*'/g, "'S'")
    .replace(/`(?:[^`\\]|\\.)*`/g, '`S`')
    .replace(/\b\d+(\.\d+)?\b/g, '0')
    .trim()
    .replace(/\s+/g, ' ');
}

function hashBlock(lines) {
  const h = crypto.createHash('sha256');
  for (const l of lines) h.update(`${l}\n`);
  return h.digest('hex').slice(0, 16);
}

// Detect duplicated blocks. Returns:
//   { dupLines, totalLines, blocks: [{hash, occurrences:[{file, startLine}]}] }
function detect(files, blockSize = 5) {
  const buckets = new Map(); // hash → [{file, startLine}]
  const fileLines = new Map();
  let totalLines = 0;
  for (const file of files) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const rawLines = raw.split('\n');
    const norm = rawLines.map(normalize);
    fileLines.set(file, { rawLines, norm });
    totalLines += rawLines.length;
    for (let i = 0; i + blockSize <= norm.length; i++) {
      const window = norm.slice(i, i + blockSize);
      // skip mostly-empty windows
      const filled = window.filter((l) => l.length > 0).length;
      if (filled < Math.ceil(blockSize / 2)) continue;
      const h = hashBlock(window);
      if (!buckets.has(h)) buckets.set(h, []);
      buckets.get(h).push({ file, startLine: i + 1 });
    }
  }
  const dupLineSet = new Map(); // file → Set of duplicated line numbers
  const blocks = [];
  for (const [hash, occs] of buckets) {
    if (occs.length < 2) continue;
    blocks.push({
      hash,
      blockSize,
      occurrences: occs.map((o) => ({ file: o.file, startLine: o.startLine })),
      occurrenceCount: occs.length,
    });
    for (const o of occs) {
      if (!dupLineSet.has(o.file)) dupLineSet.set(o.file, new Set());
      for (let k = 0; k < blockSize; k++) dupLineSet.get(o.file).add(o.startLine + k);
    }
  }
  let dupLines = 0;
  for (const set of dupLineSet.values()) dupLines += set.size;
  return { dupLines, totalLines, blocks };
}

function resolveRootPaths(cwd, root) {
  const roots = Array.isArray(root) ? root : [root || 'src'];
  return roots.map((entry) => (path.isAbsolute(entry) ? entry : path.join(cwd, entry)));
}

function uniqueFiles(files) {
  const seen = new Set();
  const out = [];
  for (const file of files) {
    const key = path.resolve(file);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

function formatRoot(rootPaths) {
  return rootPaths.length === 1 ? rootPaths[0] : rootPaths;
}

function scan({ cwd, root = 'src', blockSize = 5, threshold = null } = {}) {
  cwd = cwd || process.cwd();
  const rootPaths = resolveRootPaths(cwd, root);
  const existingRoots = rootPaths.filter((rootPath) => fs.existsSync(rootPath));
  if (existingRoots.length === 0) {
    return { schema: 'cobolt-code-duplication-detect@1', verdict: 'no-source', root: formatRoot(rootPaths), _exit: 2 };
  }
  const files = uniqueFiles(existingRoots.flatMap((rootPath) => walk(rootPath, DEFAULT_EXTS, [])));
  if (files.length === 0) {
    return {
      schema: 'cobolt-code-duplication-detect@1',
      verdict: 'no-source',
      root: formatRoot(existingRoots),
      files: 0,
      _exit: 2,
    };
  }
  const { dupLines, totalLines, blocks } = detect(files, blockSize);
  const dupPercent = totalLines > 0 ? (dupLines / totalLines) * 100 : 0;
  const verdict = threshold === null ? 'info' : dupPercent > threshold ? 'fail' : 'pass';
  // Surface top-N blocks for human inspection
  blocks.sort((a, b) => b.occurrenceCount - a.occurrenceCount);
  const top = blocks.slice(0, 25).map((b) => ({
    ...b,
    occurrences: b.occurrences.slice(0, 10).map((o) => ({
      file: path.relative(cwd, o.file),
      startLine: o.startLine,
    })),
  }));
  return {
    schema: 'cobolt-code-duplication-detect@1',
    cwd,
    root: formatRoot(existingRoots),
    sourceRoots: existingRoots.map((rootPath) => path.relative(cwd, rootPath).replace(/\\/g, '/')),
    generatedAt: new Date().toISOString(),
    blockSize,
    threshold,
    files: files.length,
    totalLines,
    dupLines,
    dupPercent: Number(dupPercent.toFixed(2)),
    verdict,
    blocks: top,
    blockCount: blocks.length,
  };
}

function printHelp() {
  process.stdout.write(
    `cobolt-code-duplication-detect — line-block clone scan\n\n` +
      `Usage: node tools/cobolt-code-duplication-detect.js scan [--root DIR] [--block N] [--threshold P] [--cwd PATH] [--json]\n` +
      `Exit: 0 pass, 1 dup% > threshold, 2 no source, 3 unreadable\n`,
  );
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--cwd') args.cwd = argv[++i];
    else if (a === '--block') args.blockSize = Number(argv[++i]);
    else if (a === '--threshold') args.threshold = Number(argv[++i]);
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
  if (argv[0] !== 'scan') {
    process.stderr.write(`unknown command: ${argv[0]}\n`);
    return 1;
  }
  const args = parseArgs(argv.slice(1));
  const result = scan(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `duplication: ${result.verdict} (${result.dupPercent ?? 0}% across ${result.files ?? 0} files, ${result.blockCount ?? 0} blocks)\n`,
    );
  }
  if (result._exit) return result._exit;
  return result.verdict === 'fail' ? 1 : 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { scan, detect, normalize, hashBlock, walk, resolveRootPaths };
