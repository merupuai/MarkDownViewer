#!/usr/bin/env node

// cobolt-cyclomatic-complexity — PR-2 Batch B (v0.53.0).
//
// Per-function cyclomatic complexity scan. Counts decision points (if, else if,
// for, while, switch case, &&, ||, ?:, catch). Heuristic single-pass — does NOT
// build a real AST; intended as a fast Tier-3 advisory signal feeding
// cobolt-code-quality-check, not an authoritative metric.
//
// Usage:
//   node tools/cobolt-cyclomatic-complexity.js scan [--cwd PATH] [--root DIR] [--threshold N] [--json]
//   node tools/cobolt-cyclomatic-complexity.js --help
//
// Exit codes: 0 ok, 1 violations (threshold), 2 no source files found, 3 unreadable root.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.rs', '.ex', '.exs', '.go', '.rb']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '_cobolt-output', '.cobolt-backups']);

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

function strip(line) {
  return line
    .replace(/\/\*.*?\*\//g, ' ')
    .replace(/\/\/.*$/, ' ')
    .replace(/#.*$/, ' ')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

function countDecisions(src) {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const lines = noComments.split('\n').map(strip);
  let count = 1;
  for (const ln of lines) {
    count += (ln.match(/\bif\b/g) || []).length;
    count -= (ln.match(/\belse\s+if\b/g) || []).length;
    count += (ln.match(/\bfor\b/g) || []).length;
    count += (ln.match(/\bwhile\b/g) || []).length;
    count += (ln.match(/\bcase\b/g) || []).length;
    count += (ln.match(/\bcatch\b/g) || []).length;
    count += (ln.match(/&&/g) || []).length;
    count += (ln.match(/\|\|/g) || []).length;
    count += (ln.match(/\?[^?:]/g) || []).length;
  }
  return Math.max(1, count);
}

function leadingIndent(line) {
  const m = line.match(/^\s*/);
  return m ? m[0].length : 0;
}

function splitFunctions(src, ext) {
  const lines = src.split('\n');
  const fns = [];
  if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.go'].includes(ext)) {
    const fnHeaderRe =
      /(?:^|\s)(?:async\s+)?(?:function\s+(\w+)|(?:export\s+(?:default\s+)?)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(|(\w+)\s*\([^)]*\)\s*\{|class\s+(\w+))/;
    let i = 0;
    while (i < lines.length) {
      const m = lines[i].match(fnHeaderRe);
      if (!m) {
        i += 1;
        continue;
      }
      const name = m[1] || m[2] || m[3] || m[4] || '<anonymous>';
      let depth = 0;
      let started = false;
      const startLine = i + 1;
      const buf = [];
      while (i < lines.length) {
        const ln = lines[i];
        buf.push(ln);
        for (const c of ln) {
          if (c === '{') {
            depth += 1;
            started = true;
          } else if (c === '}') {
            depth -= 1;
          }
        }
        i += 1;
        if (started && depth <= 0) break;
      }
      fns.push({ name, startLine, source: buf.join('\n') });
    }
    return fns;
  }
  if (ext === '.py') {
    let i = 0;
    while (i < lines.length) {
      const m = lines[i].match(/^(\s*)def\s+(\w+)/);
      if (!m) {
        i += 1;
        continue;
      }
      const indent = m[1].length;
      const name = m[2];
      const startLine = i + 1;
      const buf = [lines[i]];
      i += 1;
      while (i < lines.length) {
        const ln = lines[i];
        if (ln.trim() && leadingIndent(ln) <= indent) break;
        buf.push(ln);
        i += 1;
      }
      fns.push({ name, startLine, source: buf.join('\n') });
    }
    return fns;
  }
  return [{ name: '<file>', startLine: 1, source: src }];
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

function scan({ cwd, root = 'src', threshold = null } = {}) {
  cwd = cwd || process.cwd();
  const rootPaths = resolveRootPaths(cwd, root);
  const existingRoots = rootPaths.filter((rootPath) => fs.existsSync(rootPath));
  if (existingRoots.length === 0) {
    return { schema: 'cobolt-cyclomatic-complexity@1', verdict: 'no-source', root: formatRoot(rootPaths), _exit: 2 };
  }
  const files = uniqueFiles(existingRoots.flatMap((rootPath) => walk(rootPath, DEFAULT_EXTS, [])));
  if (files.length === 0) {
    return {
      schema: 'cobolt-cyclomatic-complexity@1',
      verdict: 'no-source',
      root: formatRoot(existingRoots),
      files: 0,
      _exit: 2,
    };
  }
  const findings = [];
  let totalFns = 0;
  let maxComplexity = 0;
  for (const file of files) {
    let src;
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const ext = path.extname(file);
    const fns = splitFunctions(src, ext);
    totalFns += fns.length;
    for (const fn of fns) {
      const c = countDecisions(fn.source);
      if (c > maxComplexity) maxComplexity = c;
      if (threshold === null || c > threshold) {
        findings.push({
          file: path.relative(cwd, file),
          function: fn.name,
          startLine: fn.startLine,
          complexity: c,
          threshold,
          severity: threshold !== null && c > threshold ? 'error' : 'info',
        });
      }
    }
  }
  findings.sort((a, b) => b.complexity - a.complexity);
  const errorCount = findings.filter((f) => f.severity === 'error').length;
  return {
    schema: 'cobolt-cyclomatic-complexity@1',
    cwd,
    root: formatRoot(existingRoots),
    sourceRoots: existingRoots.map((rootPath) => path.relative(cwd, rootPath).replace(/\\/g, '/')),
    generatedAt: new Date().toISOString(),
    files: files.length,
    functions: totalFns,
    maxComplexity,
    threshold,
    verdict: errorCount === 0 ? 'pass' : 'fail',
    errorCount,
    findings,
  };
}

function printHelp() {
  process.stdout.write(
    `cobolt-cyclomatic-complexity — per-function complexity scan (heuristic)\n\n` +
      `Usage: node tools/cobolt-cyclomatic-complexity.js scan [--root DIR] [--threshold N] [--cwd PATH] [--json]\n` +
      `Exit: 0 pass, 1 violations (threshold exceeded), 2 no source, 3 unreadable\n`,
  );
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--cwd') args.cwd = argv[++i];
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
      `complexity: ${result.verdict} (${result.files ?? 0} files, ${result.functions ?? 0} fns, max=${result.maxComplexity ?? 0}, errors=${result.errorCount ?? 0})\n`,
    );
    if (result.findings) {
      for (const f of result.findings.slice(0, 10)) {
        process.stdout.write(`  - [${f.severity}] ${f.file}:${f.startLine} ${f.function} complexity=${f.complexity}\n`);
      }
    }
  }
  if (result._exit) return result._exit;
  return result.verdict === 'fail' ? 1 : 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { scan, countDecisions, splitFunctions, walk, leadingIndent, resolveRootPaths };
