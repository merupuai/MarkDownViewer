#!/usr/bin/env node

// CoBolt Test Impact Analysis (P3.4 / v0.65+).
//
// File-level test-affected mapping. Given a list of changed files, returns
// the minimum set of test files that *might* be affected by those changes.
// File-level = "if you changed src/foo.js, run any test that imports
// src/foo.js (transitively)". Function-level analysis (via Stryker
// mutation graph) is deferred — the file-level pass already cuts test
// runtime substantially without external infra.
//
// Test-impact decisions also leverage the Phase 4.2 semantic-diff
// classifier: if a changed file's diff is whitespace-only / comment-only /
// rename-only, it produces ZERO affected tests regardless of dependents.
// This is the precision win — pure formatter runs run no tests.
//
// Standards mapping (Inv-21):
//   ISO/IEC 27001 A.8.16 — monitoring activities (test coverage signal).
//   NIST SSDF PW.8.2 — test executable code to identify vulnerabilities
//                      (TIA preserves coverage while reducing wall time).
//
// Public API:
//   buildGraph({ cwd?, testGlobs?, sourceGlobs? }) -> { dependsOn, dependents }
//   affectedTests({ cwd?, changedFiles, oldVersions?, graph? }) -> { tests, decisions }
//   writeGraph({ cwd? }) -> { path, summary }
//
// Imports tracked:
//   - require('...')       (CommonJS literal arg)
//   - import ... from '...' (ESM static)
//   - import('...')        (dynamic — best-effort literal)
//
// Limitations:
//   - Glob/dynamic import paths NOT followed (e.g. `require(name + '.js')`).
//   - Re-exports across barrel files traverse normally.
//   - When in doubt, the affected-tests result is conservative (returns more
//     tests, never fewer). Never risk dropping a real failure.
//
// CLI:
//   node tools/cobolt-tia.js graph [--out tia-graph.json]
//   node tools/cobolt-tia.js affected --files src/foo.js,src/bar.js
//   node tools/cobolt-tia.js affected --files-from changed-files.txt
//
// Exit codes per tools/CLAUDE.md:
//   0 — success
//   1 — hard error

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TEST_GLOBS = ['tests/**/test-*.js', 'tests/**/*.test.js', 'tests/**/*.spec.js'];
const DEFAULT_SOURCE_GLOBS = ['lib/**/*.js', 'tools/**/*.js', 'source/**/*.js'];

// ── lightweight glob matcher (no glob lib dep) ────────────────────────

function _expandGlobs(cwd, globs) {
  const matched = new Set();
  for (const g of globs) {
    const m = g.match(/^([^*]+?)\/\*\*\/(.+)$/);
    if (m) {
      const [, base, suffix] = m;
      const baseAbs = path.join(cwd, base);
      _walk(baseAbs, (abs) => {
        const rel = path.relative(cwd, abs).replace(/\\/g, '/');
        if (_simpleSuffixMatch(suffix, path.basename(abs))) matched.add(rel);
      });
    } else if (g.includes('*')) {
      // Single-level glob.
      const dirPart = path.dirname(g);
      const pattern = path.basename(g);
      const dir = path.join(cwd, dirPart);
      try {
        for (const entry of fs.readdirSync(dir)) {
          if (_simpleSuffixMatch(pattern, entry)) {
            matched.add(path.relative(cwd, path.join(dir, entry)).replace(/\\/g, '/'));
          }
        }
      } catch {
        // skip
      }
    } else {
      const abs = path.join(cwd, g);
      if (fs.existsSync(abs)) matched.add(g);
    }
  }
  return [...matched];
}

function _simpleSuffixMatch(pattern, name) {
  // Convert glob-pattern (test-*.js, *.test.js, *.spec.js) → regex.
  const re = new RegExp(`^${pattern.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`);
  return re.test(name);
}

function _walk(absDir, cb) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name === '.git' || ent.name === 'node_modules' || ent.name === '_cobolt-output') continue;
    const abs = path.join(absDir, ent.name);
    if (ent.isDirectory()) _walk(abs, cb);
    else if (ent.isFile()) cb(abs);
  }
}

// ── import / require extraction ───────────────────────────────────────

const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const IMPORT_RE = /\bimport\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function _extractImports(text) {
  const out = new Set();
  for (const m of text.matchAll(REQUIRE_RE)) out.add(m[1]);
  for (const m of text.matchAll(IMPORT_RE)) out.add(m[1]);
  for (const m of text.matchAll(DYNAMIC_IMPORT_RE)) out.add(m[1]);
  return [...out];
}

function _resolveImport(fromFile, importPath, cwd) {
  // Only resolve relative paths. Skip node:builtins, npm packages, absolute paths.
  if (!importPath.startsWith('.') && !importPath.startsWith('/')) return null;
  const fromDir = path.dirname(fromFile);
  const abs = path.resolve(fromDir, importPath);
  // Try direct + .js + /index.js.
  const candidates = [abs, `${abs}.js`, `${abs}.mjs`, `${abs}.cjs`, path.join(abs, 'index.js')];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
      return path.relative(cwd, c).replace(/\\/g, '/');
    }
  }
  return null;
}

// ── public buildGraph ────────────────────────────────────────────────

function buildGraph({ cwd, testGlobs = DEFAULT_TEST_GLOBS, sourceGlobs = DEFAULT_SOURCE_GLOBS } = {}) {
  const root = cwd ? path.resolve(cwd) : process.cwd();
  const tests = _expandGlobs(root, testGlobs);
  const sources = _expandGlobs(root, sourceGlobs);
  const allFiles = new Set([...tests, ...sources]);

  // dependsOn: file → set of files it imports (relative paths).
  // dependents: file → set of files that import it.
  const dependsOn = new Map();
  const dependents = new Map();

  for (const rel of allFiles) {
    const abs = path.join(root, rel);
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const imports = _extractImports(text);
    const resolved = imports.map((imp) => _resolveImport(abs, imp, root)).filter(Boolean);
    dependsOn.set(rel, new Set(resolved));
    for (const r of resolved) {
      if (!dependents.has(r)) dependents.set(r, new Set());
      dependents.get(r).add(rel);
    }
  }

  return {
    dependsOn,
    dependents,
    tests: new Set(tests),
    sources: new Set(sources),
    summary: { testCount: tests.length, sourceCount: sources.length, totalFiles: allFiles.size },
  };
}

// ── public affectedTests ──────────────────────────────────────────────

function affectedTests({ cwd, changedFiles, oldVersions = null, graph } = {}) {
  if (!Array.isArray(changedFiles)) throw new Error('affectedTests: changedFiles must be an array');
  const root = cwd ? path.resolve(cwd) : process.cwd();
  const g = graph || buildGraph({ cwd: root });

  // Pre-filter: skip files whose diff is whitespace/comment/rename-only via
  // P4.2 semantic-diff classifier — those produce ZERO affected tests.
  const decisions = [];
  let semanticDiffMod = null;
  try {
    semanticDiffMod = require('../lib/cobolt-semantic-diff');
  } catch {
    // Fallback: no semantic-diff available, every changed file counts.
  }

  const trulyChanged = [];
  for (const rel of changedFiles) {
    const oldText = oldVersions?.[rel];
    const newText = (() => {
      try {
        return fs.readFileSync(path.join(root, rel), 'utf8');
      } catch {
        return null;
      }
    })();

    if (oldText != null && newText != null && semanticDiffMod) {
      const cls = semanticDiffMod.classifyFile(rel, oldText, newText);
      if (
        cls.category === 'identical' ||
        cls.category === 'whitespace-only' ||
        cls.category === 'comment-only' ||
        cls.category === 'rename-only'
      ) {
        decisions.push({ file: rel, decision: 'skip', reason: cls.category, confidence: cls.confidence });
        continue;
      }
      decisions.push({ file: rel, decision: 'include', reason: cls.category, confidence: cls.confidence });
    } else {
      decisions.push({ file: rel, decision: 'include', reason: 'no-baseline-or-classifier' });
    }
    trulyChanged.push(rel);
  }

  // BFS up the dependents graph from each truly-changed file. Tests that
  // are reachable get included in the affected set.
  const visited = new Set();
  const stack = [...trulyChanged];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (visited.has(cur)) continue;
    visited.add(cur);
    const deps = g.dependents.get(cur);
    if (!deps) continue;
    for (const d of deps) {
      if (!visited.has(d)) stack.push(d);
    }
  }

  const tests = [...visited].filter((f) => g.tests.has(f));
  tests.sort();

  return {
    affectedTests: tests,
    affectedCount: tests.length,
    totalTests: g.tests.size,
    skippedTests: g.tests.size - tests.length,
    decisions,
    changedFilesAnalysed: changedFiles.length,
    changedFilesIncluded: trulyChanged.length,
    changedFilesSkipped: changedFiles.length - trulyChanged.length,
  };
}

// ── persistence ──────────────────────────────────────────────────────

function writeGraph({ cwd } = {}) {
  const root = cwd ? path.resolve(cwd) : process.cwd();
  const g = buildGraph({ cwd: root });
  // Serialise dependents map as plain object (JSONL would be huge for big repos).
  const dependentsObj = {};
  for (const [k, v] of g.dependents) dependentsObj[k] = [...v].sort();
  const auditDir = path.join(root, '_cobolt-output', 'audit');
  fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  const outPath = path.join(auditDir, 'tia-graph.json');
  fs.writeFileSync(
    outPath,
    `${JSON.stringify({ summary: g.summary, generatedAt: new Date().toISOString(), dependents: dependentsObj }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  return { path: outPath, summary: g.summary };
}

module.exports = {
  buildGraph,
  affectedTests,
  writeGraph,
  DEFAULT_TEST_GLOBS,
  DEFAULT_SOURCE_GLOBS,
  // Internals exposed for tests.
  _internal: { _extractImports, _resolveImport, _expandGlobs },
};

// ── CLI ──────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log('Usage: node tools/cobolt-tia.js <command> [args]');
    console.log('Commands:');
    console.log('  graph   [--out path]                 Write file-dependency graph to disk');
    console.log('  affected --files A,B,C [--json]      Print affected test files');
    console.log('  affected --files-from list.txt       Read changed files from a file (one per line)');
    process.exit(0);
  }
  try {
    if (cmd === 'graph') {
      const opts = {};
      let outPath = null;
      for (let i = 1; i < argv.length; i += 1) {
        if (argv[i] === '--out') outPath = argv[++i];
        else if (argv[i] === '--cwd') opts.cwd = argv[++i];
      }
      if (outPath) {
        const r = writeGraph(opts);
        console.log(`[cobolt-tia] Graph: ${r.path}`);
        console.log(`[cobolt-tia] Tests: ${r.summary.testCount}, Sources: ${r.summary.sourceCount}`);
      } else {
        const g = buildGraph(opts);
        console.log(`[cobolt-tia] Tests: ${g.summary.testCount}, Sources: ${g.summary.sourceCount}`);
      }
      process.exit(0);
    }
    if (cmd === 'affected') {
      let files = [];
      let json = false;
      for (let i = 1; i < argv.length; i += 1) {
        if (argv[i] === '--files')
          files = String(argv[++i])
            .split(/[,\n]/)
            .map((f) => f.trim())
            .filter(Boolean);
        else if (argv[i] === '--files-from') {
          const list = fs.readFileSync(argv[++i], 'utf8');
          files = list.split(/\r?\n/).filter(Boolean);
        } else if (argv[i] === '--json') json = true;
      }
      if (files.length === 0) {
        console.error('Usage: affected --files A,B,C  OR  --files-from list.txt');
        process.exit(1);
      }
      const r = affectedTests({ changedFiles: files });
      if (json) {
        console.log(JSON.stringify(r, null, 2));
      } else {
        console.log(`[cobolt-tia] Affected: ${r.affectedCount}/${r.totalTests} tests`);
        console.log(
          `[cobolt-tia] Changed:  ${r.changedFilesIncluded}/${r.changedFilesAnalysed} files (${r.changedFilesSkipped} cosmetic-only)`,
        );
        for (const t of r.affectedTests) console.log(`  ${t}`);
      }
      process.exit(0);
    }
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
  } catch (err) {
    console.error(`[cobolt-tia] ${err.message}`);
    process.exit(1);
  }
}
