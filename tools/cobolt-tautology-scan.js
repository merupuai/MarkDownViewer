#!/usr/bin/env node

// CoBolt Tautology Scanner (v0.24+) — C-5 fix
//
// Deterministic detector for no-op / always-true assertions in test files.
// Catches the failure mode where test-writer emits assert!(x || !x) style
// tautologies that survive review because the assertion string contains the
// word "assert" (gameable by shallow greps).
//
// Tautology patterns detected (per-language):
//
//   Rust:     assert!(x)      where x parses as "A || !A" or "A && !A"
//             assert_eq!(a, a) where a is syntactically identical on both sides
//   JS/TS:    expect(x).toBe(x) / toEqual(x) with identical operands
//             expect(true).toBe(true), expect(1).toBe(1)
//   Python:   assert a == a
//             self.assertEqual(a, a)
//   Go:       if got != want { t.Errorf(...) } where got and want are the
//             same expression string-wise
//
// Usage:
//   node tools/cobolt-tautology-scan.js scan [--path <dir>] [--json] [--out <file>]
//
// Exit codes:
//   0 = no tautologies
//   1 = usage
//   2 = no test files found (skipped)
//   3 = tautologies found (block)

const fs = require('node:fs');
const path = require('node:path');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_SKIPPED = 2;
const EXIT_FINDINGS = 3;

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'target' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) {
      if (
        /\.(spec|test)\.(js|ts|tsx|jsx|mjs|cjs)$/i.test(e.name) ||
        /_test\.go$/.test(e.name) ||
        /^test_|_test\.py$/.test(e.name) ||
        /\.rs$/.test(e.name) || // scan rust files too (tests live inline)
        // v0.65.3 — Java/JUnit: src/test/java/**/*Test.java, src/test/java/**/*Tests.java, *IT.java
        /(?:Test|Tests|IT)\.java$/.test(e.name)
      ) {
        out.push(p);
      }
    }
  }
}

// Tautology detectors. Each returns [{line, code, pattern}].
function detectRust(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // assert!(A || !A)  — where !A is negation of A (same identifier/expr)
    // Handles nested parens conservatively.
    let m = line.match(/assert!\s*\(\s*(.+?)\s*\|\|\s*!\s*\(?\s*(.+?)\s*\)?\s*\)\s*;/);
    if (m && normalizeExpr(m[1]) === normalizeExpr(m[2])) {
      out.push({ line: i + 1, code: line.trim(), pattern: 'assert!(X || !X)' });
      continue;
    }
    m = line.match(/assert!\s*\(\s*!\s*\(?\s*(.+?)\s*\)?\s*\|\|\s*(.+?)\s*\)\s*;/);
    if (m && normalizeExpr(m[1]) === normalizeExpr(m[2])) {
      out.push({ line: i + 1, code: line.trim(), pattern: 'assert!(!X || X)' });
      continue;
    }
    // assert_eq!(a, a)
    m = line.match(/assert_eq!\s*\(\s*(.+?)\s*,\s*(.+?)\s*\)\s*;/);
    if (m && normalizeExpr(m[1]) === normalizeExpr(m[2]) && m[1].trim().length > 0) {
      out.push({ line: i + 1, code: line.trim(), pattern: 'assert_eq!(x, x)' });
    }
    // assert!(true)
    if (/\bassert!\s*\(\s*true\s*\)\s*;/.test(line)) {
      out.push({ line: i + 1, code: line.trim(), pattern: 'assert!(true)' });
    }
  }
  return out;
}

function detectJsTs(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Jest/Vitest: expect(X).toBe(X) / .toEqual(X) / .toStrictEqual(X) / .toMatchObject(X)
    const m = line.match(/expect\s*\(\s*(.+?)\s*\)\s*\.\s*to(?:Be|Equal|StrictEqual|MatchObject)\s*\(\s*(.+?)\s*\)/);
    if (m && normalizeExpr(m[1]) === normalizeExpr(m[2]) && m[1].trim().length > 0) {
      out.push({ line: i + 1, code: line.trim(), pattern: 'expect(x).toBe(x)' });
      continue;
    }
    // expect(literal).toBe(sameLiteral)
    if (/expect\s*\(\s*(true|false|\d+|"[^"]*"|'[^']*')\s*\)\s*\.\s*toBe\s*\(\s*\1\s*\)/.test(line)) {
      out.push({ line: i + 1, code: line.trim(), pattern: 'expect(literal).toBe(sameLiteral)' });
      continue;
    }
    // v0.65.3 — Chai: expect(X).to.equal(X) / .to.eql(X) / .to.deep.equal(X)
    const chai = line.match(/expect\s*\(\s*(.+?)\s*\)\s*\.\s*to(?:\.\s*deep)?\s*\.\s*(?:equal|eql)\s*\(\s*(.+?)\s*\)/);
    if (chai && normalizeExpr(chai[1]) === normalizeExpr(chai[2]) && chai[1].trim().length > 0) {
      out.push({ line: i + 1, code: line.trim(), pattern: 'expect(x).to.equal(x)' });
      continue;
    }
    // Mocha/Node assert: assert.equal(x, x) / assert.strictEqual / assert.deepEqual / assert.deepStrictEqual
    const mocha = line.match(
      /\bassert\s*\.\s*(?:equal|strictEqual|deepEqual|deepStrictEqual)\s*\(\s*(.+?)\s*,\s*(.+?)\s*\)/,
    );
    if (mocha && normalizeExpr(mocha[1]) === normalizeExpr(mocha[2]) && mocha[1].trim().length > 0) {
      out.push({ line: i + 1, code: line.trim(), pattern: 'assert.equal(x, x)' });
      continue;
    }
    // assert(true) / assert.ok(true) / assert.isTrue(true)
    if (/\bassert(?:\s*\.\s*(?:ok|isTrue))?\s*\(\s*true\s*\)/.test(line)) {
      out.push({ line: i + 1, code: line.trim(), pattern: 'assert(true)' });
    }
  }
  return out;
}

// v0.65.3 — Go: detect literal-tautology assertions in _test.go files.
// Patterns: `if got != want` where got==want literally; `if x == x`; `t.Errorf` after `if false`.
function detectGo(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // if x == x { ... }  /  if x != x { ... }
    const m = line.match(/^\s*if\s+(.+?)\s*(==|!=)\s*(.+?)\s*\{/);
    if (m && normalizeExpr(m[1]) === normalizeExpr(m[3]) && m[1].trim().length > 0) {
      out.push({
        line: i + 1,
        code: line.trim(),
        pattern: m[2] === '==' ? 'if x == x' : 'if x != x',
      });
      continue;
    }
    // assert.Equal(t, x, x) / assert.EqualValues / require.Equal — testify
    const testify = line.match(
      /\b(?:assert|require)\s*\.\s*(?:Equal(?:Values)?|Same)\s*\(\s*[^,]+,\s*(.+?)\s*,\s*(.+?)\s*[,)]/,
    );
    if (testify && normalizeExpr(testify[1]) === normalizeExpr(testify[2]) && testify[1].trim().length > 0) {
      out.push({ line: i + 1, code: line.trim(), pattern: 'assert.Equal(t, x, x)' });
      continue;
    }
    // assert.True(t, true)
    if (/\b(?:assert|require)\s*\.\s*True\s*\(\s*[^,]+,\s*true\s*[,)]/.test(line)) {
      out.push({ line: i + 1, code: line.trim(), pattern: 'assert.True(t, true)' });
    }
  }
  return out;
}

// v0.65.3 — Java/JUnit: assertEquals(a, a), assertSame(a, a), assertTrue(true).
function detectJava(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // assertEquals(expected, actual) — JUnit5 (2-arg) or JUnit4 (2-arg). Optional message arg.
    const m = line.match(/\bassert(?:Equals|Same)\s*\(\s*(?:"[^"]*"\s*,\s*)?(.+?)\s*,\s*(.+?)\s*\)/);
    if (m && normalizeExpr(m[1]) === normalizeExpr(m[2]) && m[1].trim().length > 0 && !/^[A-Z_]+$/.test(m[1].trim())) {
      out.push({ line: i + 1, code: line.trim(), pattern: 'assertEquals(x, x)' });
      continue;
    }
    if (/\bassertTrue\s*\(\s*(?:"[^"]*"\s*,\s*)?true\s*\)/.test(line)) {
      out.push({ line: i + 1, code: line.trim(), pattern: 'assertTrue(true)' });
      continue;
    }
    if (/\bassertFalse\s*\(\s*(?:"[^"]*"\s*,\s*)?false\s*\)/.test(line)) {
      out.push({ line: i + 1, code: line.trim(), pattern: 'assertFalse(false)' });
    }
  }
  return out;
}

function detectPython(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = line.match(/^\s*assert\s+(.+?)\s*==\s*(.+?)\s*(?:,.*)?$/);
    if (m && normalizeExpr(m[1]) === normalizeExpr(m[2]) && m[1].trim().length > 0 && !m[1].includes('(')) {
      out.push({ line: i + 1, code: line.trim(), pattern: 'assert a == a' });
    }
    const m2 = line.match(/self\.assertEqual\s*\(\s*(.+?)\s*,\s*(.+?)\s*\)/);
    if (m2 && normalizeExpr(m2[1]) === normalizeExpr(m2[2]) && m2[1].trim().length > 0) {
      out.push({ line: i + 1, code: line.trim(), pattern: 'assertEqual(x, x)' });
    }
    if (/^\s*assert\s+True\s*(?:,.*)?$/i.test(line)) {
      out.push({ line: i + 1, code: line.trim(), pattern: 'assert True' });
    }
  }
  return out;
}

function normalizeExpr(s) {
  return String(s || '')
    .replace(/\s+/g, '')
    .replace(/^\(+|\)+$/g, '')
    .toLowerCase();
}

function detectFile(p) {
  const text = (() => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  })();
  if (!text) return [];
  if (p.endsWith('.rs')) return detectRust(text);
  if (/\.(py)$/.test(p)) return detectPython(text);
  if (/\.(js|ts|tsx|jsx|mjs|cjs)$/.test(p)) return detectJsTs(text);
  if (/\.go$/.test(p)) return detectGo(text);
  if (/\.java$/.test(p)) return detectJava(text);
  return [];
}

function runAll(cwd, opts) {
  const root = opts.path ? path.resolve(cwd, opts.path) : cwd;
  const files = [];
  walk(root, files);
  if (files.length === 0) {
    return { status: 'skipped', reason: 'no test files under path', findings: [] };
  }
  const findings = [];
  for (const f of files) {
    const rel = path.relative(cwd, f);
    for (const hit of detectFile(f)) {
      findings.push({
        class: 'tautological-assertion',
        severity: 'high',
        file: rel,
        line: hit.line,
        code: hit.code,
        pattern: hit.pattern,
        message: `${rel}:${hit.line} — tautological assertion (${hit.pattern}) — always true regardless of code under test`,
      });
    }
  }
  return { status: findings.length === 0 ? 'pass' : 'fail', filesScanned: files.length, findings };
}

function emit(result, opts) {
  if (opts.json) {
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (opts.out) {
      fs.mkdirSync(path.dirname(path.resolve(process.cwd(), opts.out)), { recursive: true });
      fs.writeFileSync(path.resolve(process.cwd(), opts.out), json, 'utf8');
    }
    process.stdout.write(json);
    return;
  }
  const badge = result.status === 'pass' ? 'PASS' : result.status === 'skipped' ? 'SKIP' : 'FAIL';
  process.stdout.write(
    `[${badge}] cobolt-tautology-scan — ${result.findings.length} finding(s) across ${result.filesScanned || 0} file(s)\n`,
  );
  for (const f of result.findings.slice(0, 20)) {
    process.stdout.write(`  • ${f.message}\n`);
  }
  if (result.findings.length > 20) {
    process.stdout.write(`  … ${result.findings.length - 20} more (use --json for full output)\n`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const pi = args.indexOf('--path');
  const oi = args.indexOf('--out');
  const opts = {
    json: args.includes('--json') || oi >= 0,
    path: pi >= 0 ? args[pi + 1] : null,
    out: oi >= 0 ? args[oi + 1] : null,
  };
  // v0.65.3 (audit S3-D, restoring v0.40.2 exit-code contract):
  // --help / -h / help / no-args  → stdout + exit 0.
  // unknown command                → stderr + exit 1.
  const helpText = `${[
    'Usage: cobolt-tautology-scan scan [--path <dir>] [--json] [--out <file>]',
    '',
    'Detects always-true assertions in test files (Rust, JS/TS, Python, Go, Java).',
    'Exit codes: 0 OK | 1 usage | 2 skipped | 3 findings',
  ].join('\n')}\n`;
  if (cmd === 'help' || cmd === '-h' || cmd === '--help' || !cmd) {
    process.stdout.write(helpText);
    process.exit(0);
  }
  if (cmd !== 'scan') {
    process.stderr.write(`Unknown command: ${cmd}\n${helpText}`);
    process.exit(EXIT_USAGE);
  }
  try {
    const result = runAll(process.cwd(), opts);
    emit(result, opts);
    if (result.status === 'pass') process.exit(EXIT_OK);
    if (result.status === 'skipped') process.exit(EXIT_SKIPPED);
    process.exit(EXIT_FINDINGS);
  } catch (err) {
    process.stderr.write(`[cobolt-tautology-scan] ERROR: ${err.message}\n`);
    process.exit(EXIT_USAGE);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  runAll,
  detectFile,
  detectRust,
  detectJsTs,
  detectPython,
  normalizeExpr,
};
