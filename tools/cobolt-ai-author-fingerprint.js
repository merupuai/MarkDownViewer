#!/usr/bin/env node

// cobolt-ai-author-fingerprint — PR-2 Batch B (v0.53.0).
//
// Per-file stylometric fingerprint emitting ai-author-fingerprint.schema.json.
// Tier-3 advisory only — no gate consumes the verdict directly. Governance
// can promote later via explicit policy decision; the schema documents that
// staying advisory permanently is intentional.
//
// Signals:
//   - tokenEntropy: Shannon entropy of identifier tokens (lower = boilerplate-like)
//   - commentRatio: comment lines / total non-empty lines
//   - boilerplateRatio: matches against a small set of common AI-prompt
//     patterns (e.g. "TODO: implement", "// Initialize the X")
//   - identifierVarianceScore: variance of identifier-naming conventions
//     (snake_case vs camelCase vs PascalCase mix)
//
// Usage:
//   node tools/cobolt-ai-author-fingerprint.js scan [--cwd PATH] [--root DIR] [--milestone Mn] [--story SID] [--json]
//   node tools/cobolt-ai-author-fingerprint.js --help
//
// Exit codes: 0 ok (always — advisory), 1 invalid arguments, 2 no source files.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.rs', '.ex', '.exs', '.go']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '_cobolt-output', '.cobolt-backups']);

const BOILERPLATE_PATTERNS = [
  /\bTODO:\s*implement\b/i,
  /\bInitialize the\b/,
  /\bThis function\s+(does|handles|returns|creates)\b/i,
  /\bThis (class|function|module) is responsible for\b/i,
  /\bIn a real (production|world) (implementation|scenario)\b/i,
  /\bFor demonstration purposes\b/i,
  /\bAs you can see\b/i,
  /\bplease note\b/i,
  /\bensure that\b/i,
  /\bAccording to (the )?(spec|requirements|documentation)\b/i,
];

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

function shannonEntropy(tokens) {
  if (!tokens.length) return 0;
  const counts = new Map();
  for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
  const n = tokens.length;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

function extractIdentifiers(src) {
  // Unicode-aware identifier-ish scan; conservative.
  const ids = src.match(/[A-Za-z_][A-Za-z0-9_]{1,}/g) || [];
  const KEYWORDS = new Set([
    'const',
    'let',
    'var',
    'function',
    'return',
    'if',
    'else',
    'for',
    'while',
    'do',
    'switch',
    'case',
    'break',
    'continue',
    'throw',
    'try',
    'catch',
    'finally',
    'class',
    'extends',
    'import',
    'export',
    'from',
    'default',
    'new',
    'this',
    'super',
    'true',
    'false',
    'null',
    'undefined',
    'async',
    'await',
    'yield',
    'typeof',
    'instanceof',
    'def',
    'pass',
    'lambda',
    'fn',
    'pub',
    'mut',
    'use',
    'mod',
    'crate',
    'self',
    'impl',
    'trait',
    'struct',
    'enum',
    'package',
    'interface',
    'public',
    'private',
    'protected',
    'static',
    'void',
  ]);
  return ids.filter((id) => !KEYWORDS.has(id));
}

function commentRatio(src, ext) {
  const lines = src.split('\n');
  let comments = 0;
  let nonEmpty = 0;
  for (const ln of lines) {
    const t = ln.trim();
    if (!t) continue;
    nonEmpty += 1;
    if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.go', '.rs'].includes(ext)) {
      if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) comments += 1;
    } else if (ext === '.py') {
      if (t.startsWith('#') || t.startsWith('"""') || t.startsWith("'''")) comments += 1;
    } else if (['.ex', '.exs'].includes(ext)) {
      if (t.startsWith('#') || t.startsWith('@doc')) comments += 1;
    }
  }
  return nonEmpty > 0 ? comments / nonEmpty : 0;
}

function boilerplateRatio(src) {
  const lines = src.split('\n');
  let hits = 0;
  for (const ln of lines) {
    for (const re of BOILERPLATE_PATTERNS) {
      if (re.test(ln)) {
        hits += 1;
        break;
      }
    }
  }
  return lines.length > 0 ? hits / lines.length : 0;
}

function identifierVarianceScore(ids) {
  if (!ids.length) return 0;
  let snake = 0;
  let camel = 0;
  let pascal = 0;
  let upper = 0;
  for (const id of ids) {
    if (/^[A-Z][A-Z0-9_]+$/.test(id)) upper += 1;
    else if (/^[A-Z][a-z]/.test(id)) pascal += 1;
    else if (/_/.test(id) && !/[A-Z]/.test(id)) snake += 1;
    else if (/^[a-z][A-Za-z0-9]*$/.test(id)) camel += 1;
  }
  const total = snake + camel + pascal + upper;
  if (total === 0) return 0;
  // Normalized Gini-like dispersion: 0 when all-one-style, ~1 when even mix.
  const fractions = [snake, camel, pascal, upper].map((n) => n / total);
  const max = Math.max(...fractions);
  return 1 - max;
}

function classify(file, ext) {
  const src = fs.readFileSync(file, 'utf8');
  const ids = extractIdentifiers(src);
  const tokenEntropy = Number(shannonEntropy(ids).toFixed(3));
  const cr = Number(commentRatio(src, ext).toFixed(3));
  const br = Number(boilerplateRatio(src).toFixed(3));
  const ivs = Number(identifierVarianceScore(ids).toFixed(3));
  // Composite: high boilerplateRatio + low tokenEntropy + low identifierVariance => ai-suspected.
  // Thresholds chosen conservatively to keep verdicts informational, not enforcement.
  const score = Math.min(
    1,
    Math.max(
      0,
      0.4 * Math.min(1, br * 10) + // boilerplate is the strongest signal
        0.25 * (1 - Math.min(1, tokenEntropy / 5)) +
        0.2 * (1 - Math.min(1, ivs * 2)) +
        0.15 * Math.min(1, cr * 3),
    ),
  );
  let verdict = 'unclassified';
  let reason = '';
  if (ids.length < 20) {
    verdict = 'unclassified';
    reason = 'too few identifiers for confident scoring';
  } else if (score >= 0.6) {
    verdict = 'ai-suspected';
    reason = `composite score ${score.toFixed(2)} (boilerplate=${br}, entropy=${tokenEntropy})`;
  } else {
    verdict = 'human';
    reason = `composite score ${score.toFixed(2)} below ai-suspected threshold`;
  }
  return {
    score: Number(score.toFixed(3)),
    verdict,
    reason,
    signals: {
      tokenEntropy,
      commentRatio: cr,
      boilerplateRatio: br,
      identifierVarianceScore: ivs,
    },
  };
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

function scan({ cwd, root = 'src', milestoneId, storyId } = {}) {
  cwd = cwd || process.cwd();
  const rootPaths = resolveRootPaths(cwd, root);
  const existingRoots = rootPaths.filter((rootPath) => fs.existsSync(rootPath));
  if (existingRoots.length === 0) {
    const formattedRoot = formatRoot(rootPaths);
    return {
      schema: 'cobolt-ai-author-fingerprint@1',
      files: [],
      _exit: 2,
      error: `no source root: ${Array.isArray(formattedRoot) ? formattedRoot.join(', ') : formattedRoot}`,
    };
  }
  const files = uniqueFiles(existingRoots.flatMap((rootPath) => walk(rootPath, DEFAULT_EXTS, [])));
  const out = [];
  for (const file of files) {
    try {
      const ext = path.extname(file);
      const r = classify(file, ext);
      out.push({ path: path.relative(cwd, file), ...r });
    } catch (err) {
      out.push({ path: path.relative(cwd, file), score: 0, verdict: 'unclassified', reason: err.message, signals: {} });
    }
  }
  return {
    schema: 'cobolt-ai-author-fingerprint@1',
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    milestoneId,
    storyId,
    root: formatRoot(existingRoots),
    sourceRoots: existingRoots.map((rootPath) => path.relative(cwd, rootPath).replace(/\\/g, '/')),
    files: out,
  };
}

function printHelp() {
  process.stdout.write(
    `cobolt-ai-author-fingerprint — Tier-3 advisory stylometric scan\n\n` +
      `Usage: node tools/cobolt-ai-author-fingerprint.js scan [--root DIR] [--milestone Mn] [--story SID] [--cwd PATH] [--json]\n` +
      `Exit: 0 ok (always — advisory only), 1 invalid args, 2 no source root\n`,
  );
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--cwd') args.cwd = argv[++i];
    else if (a === '--milestone') args.milestoneId = argv[++i];
    else if (a === '--story') args.storyId = argv[++i];
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
    const counts = result.files.reduce((acc, f) => {
      acc[f.verdict] = (acc[f.verdict] || 0) + 1;
      return acc;
    }, {});
    process.stdout.write(`ai-author-fingerprint: ${result.files.length} files (${JSON.stringify(counts)})\n`);
  }
  if (result._exit) return result._exit;
  return 0; // permanent advisory
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  scan,
  resolveRootPaths,
  classify,
  shannonEntropy,
  extractIdentifiers,
  commentRatio,
  boilerplateRatio,
  identifierVarianceScore,
  BOILERPLATE_PATTERNS,
};
