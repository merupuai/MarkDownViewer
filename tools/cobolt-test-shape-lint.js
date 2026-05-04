#!/usr/bin/env node

// CoBolt Test-Shape Lint (v0.51+) — RC-1 fix.
//
// Closes the failure class observed in the RawDrive042026 / Identity-Service
// M1 build (2026-04-25): all 5 TDD rounds passed (1,572 tests) against stub
// modules whose only assertions were Elixir's existence triad
// `Code.ensure_loaded?/1` + `function_exported?/3`. Step 03A then found 662
// spec-code gaps. The pipeline reached "GREEN" because tests *executed*
// successfully, not because they *proved behavior*.
//
// `cobolt-tautology-scan.js` catches *syntactic* always-true assertions
// (`assert!(x || !x)`, `expect(x).toBe(x)`). It does NOT catch tests whose
// dominant assertion shape is a behaviorally-vacuous existence check that
// passes against any module containing the named symbol.
//
// What this tool detects (per-language existence-only patterns):
//
//   Elixir:
//     - assert Code.ensure_loaded?(Mod)
//     - assert function_exported?(Mod, :func, /<arity>)
//     - assert is_atom(Mod) / is_function(...) without invocation
//
//   JS/TS:
//     - expect(typeof X).toBe('function')
//     - expect(X).toBeDefined()
//     - expect(X).not.toBeUndefined()
//     - expect(X).toBeTruthy() when X is a top-level imported symbol
//
//   Python:
//     - assert hasattr(mod, 'name')
//     - assert callable(mod.func)
//     - assert inspect.isfunction(mod.func)
//
//   Go:
//     - reflect.TypeOf(X).Kind() comparisons without invocation
//
// Behavioral assertions are anything else (eq comparisons against
// non-identity expressions, pattern matches against literals, side-effect
// observations, error returns, snapshot diffs, mock-call expectations …).
//
// Scoring: per file, ratio = existenceOnlyCount / totalAssertionCount.
// Per round (or per scan), if the cross-file ratio crosses --threshold (default
// 0.30) the run reports findings and exits 3.
//
// Usage:
//   node tools/cobolt-test-shape-lint.js scan [--path <dir>] [--threshold 0.30]
//                                              [--language elixir|js|ts|py|go|all]
//                                              [--json] [--out <file>]
//
//   node tools/cobolt-test-shape-lint.js check-file <path>     # single-file
//                                                                 ratio probe
//
// Exit codes (per tools/CLAUDE.md exit contract):
//   0 = no findings (ratio under threshold OR no test files)
//   1 = usage / unhandled error
//   2 = no test files under path (skipped)
//   3 = findings (block — ratio >= threshold)

const fs = require('node:fs');
const path = require('node:path');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_SKIPPED = 2;
const EXIT_FINDINGS = 3;

const DEFAULT_THRESHOLD = 0.3;

// Skip directories during walk.
const WALK_SKIP = new Set([
  'node_modules',
  'target',
  'dist',
  'build',
  '_build',
  'deps',
  '.git',
  '.cobolt',
  '_cobolt-output',
  '.cobolt-backups',
  'coverage',
  '.next',
  '.svelte-kit',
]);

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    if (WALK_SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) {
      if (isTestFile(e.name)) out.push(p);
    }
  }
}

function isTestFile(filename) {
  return (
    /_test\.exs$/.test(filename) || // Elixir: foo_test.exs
    /\.test\.(js|ts|tsx|jsx|mjs|cjs)$/i.test(filename) ||
    /\.spec\.(js|ts|tsx|jsx|mjs|cjs)$/i.test(filename) ||
    /(^test_|_test\.py$)/.test(filename) || // Python: test_foo.py / foo_test.py
    /_test\.go$/.test(filename) // Go: foo_test.go
  );
}

function languageOf(filePath) {
  if (filePath.endsWith('.exs') || filePath.endsWith('.ex')) return 'elixir';
  if (/\.(ts|tsx)$/.test(filePath)) return 'ts';
  if (/\.(js|jsx|mjs|cjs)$/.test(filePath)) return 'js';
  if (/\.py$/.test(filePath)) return 'python';
  if (filePath.endsWith('.go')) return 'go';
  return null;
}

// --- Per-language detectors. Each returns
//     { existenceOnly: [{line, code, pattern}], assertions: [{line, code, kind}] }

function scanElixir(text) {
  const lines = text.split('\n');
  const existenceOnly = [];
  const assertions = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    // Pure existence checks
    if (/^assert\s+Code\.ensure_loaded\?\s*\(/.test(trimmed)) {
      existenceOnly.push({ line: i + 1, code: trimmed, pattern: 'assert Code.ensure_loaded?(Mod)' });
      assertions.push({ line: i + 1, code: trimmed, kind: 'existence' });
      continue;
    }
    if (/^assert\s+function_exported\?\s*\(/.test(trimmed)) {
      existenceOnly.push({ line: i + 1, code: trimmed, pattern: 'assert function_exported?(M,:f,N)' });
      assertions.push({ line: i + 1, code: trimmed, kind: 'existence' });
      continue;
    }
    if (/^assert\s+(?:is_atom|is_function|is_map|is_list)\s*\([^)]*\)\s*$/.test(trimmed)) {
      existenceOnly.push({ line: i + 1, code: trimmed, pattern: 'assert is_*(X) shape-only' });
      assertions.push({ line: i + 1, code: trimmed, kind: 'existence' });
      continue;
    }
    // General Elixir assertions
    if (/^(assert|refute|assert_(?:raise|received|in_delta))\b/.test(trimmed)) {
      assertions.push({ line: i + 1, code: trimmed, kind: 'behavioral' });
    }
  }
  return { existenceOnly, assertions };
}

function scanJsTs(text) {
  const lines = text.split('\n');
  const existenceOnly = [];
  const assertions = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    // expect(typeof X).toBe('function'|'object'|'string'|...)
    if (
      /expect\s*\(\s*typeof\s+\w[\w$.]*\s*\)\s*\.\s*toBe\s*\(\s*['"](?:function|object|string|number|boolean|undefined)['"]\s*\)/.test(
        line,
      )
    ) {
      existenceOnly.push({ line: i + 1, code: trimmed, pattern: "expect(typeof X).toBe('function')" });
      assertions.push({ line: i + 1, code: trimmed, kind: 'existence' });
      continue;
    }
    // expect(X).toBeDefined() / .not.toBeUndefined()
    if (/expect\s*\(\s*\w[\w$.]*\s*\)\s*\.\s*toBeDefined\s*\(\s*\)/.test(line)) {
      existenceOnly.push({ line: i + 1, code: trimmed, pattern: 'expect(X).toBeDefined()' });
      assertions.push({ line: i + 1, code: trimmed, kind: 'existence' });
      continue;
    }
    if (/expect\s*\(\s*\w[\w$.]*\s*\)\s*\.\s*not\s*\.\s*toBeUndefined\s*\(\s*\)/.test(line)) {
      existenceOnly.push({ line: i + 1, code: trimmed, pattern: 'expect(X).not.toBeUndefined()' });
      assertions.push({ line: i + 1, code: trimmed, kind: 'existence' });
      continue;
    }
    // expect(X).toBeTruthy() / .toBeFalsy() — when X is a bare identifier
    // (not a method call), it's an existence-style probe.
    if (/expect\s*\(\s*\w[\w$.]*\s*\)\s*\.\s*toBe(?:Truthy|Falsy)\s*\(\s*\)/.test(line)) {
      existenceOnly.push({ line: i + 1, code: trimmed, pattern: 'expect(X).toBeTruthy()' });
      assertions.push({ line: i + 1, code: trimmed, kind: 'existence' });
      continue;
    }
    // General expect(...) — anything else
    if (/\bexpect\s*\(/.test(line) && /\.\s*to\w+\s*\(/.test(line)) {
      assertions.push({ line: i + 1, code: trimmed, kind: 'behavioral' });
    } else if (/\b(?:assert|assert\.\w+)\s*\(/.test(line)) {
      assertions.push({ line: i + 1, code: trimmed, kind: 'behavioral' });
    }
  }
  return { existenceOnly, assertions };
}

function scanPython(text) {
  const lines = text.split('\n');
  const existenceOnly = [];
  const assertions = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (/^assert\s+hasattr\s*\(/.test(trimmed)) {
      existenceOnly.push({ line: i + 1, code: trimmed, pattern: 'assert hasattr(mod, "name")' });
      assertions.push({ line: i + 1, code: trimmed, kind: 'existence' });
      continue;
    }
    if (/^assert\s+callable\s*\(/.test(trimmed)) {
      existenceOnly.push({ line: i + 1, code: trimmed, pattern: 'assert callable(X)' });
      assertions.push({ line: i + 1, code: trimmed, kind: 'existence' });
      continue;
    }
    if (/^assert\s+inspect\.is(?:function|method|class|module)\s*\(/.test(trimmed)) {
      existenceOnly.push({ line: i + 1, code: trimmed, pattern: 'assert inspect.is*(X)' });
      assertions.push({ line: i + 1, code: trimmed, kind: 'existence' });
      continue;
    }
    if (/^(assert|self\.assert\w+)\b/.test(trimmed)) {
      assertions.push({ line: i + 1, code: trimmed, kind: 'behavioral' });
    }
  }
  return { existenceOnly, assertions };
}

function scanGo(text) {
  const lines = text.split('\n');
  const existenceOnly = [];
  const assertions = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    // reflect.TypeOf(X).Kind() comparison without invocation
    if (/reflect\.TypeOf\s*\([^)]+\)\s*\.\s*Kind\s*\(\s*\)/.test(line) && !/\.Call\s*\(/.test(line)) {
      existenceOnly.push({ line: i + 1, code: trimmed, pattern: 'reflect.TypeOf(X).Kind() shape-only' });
      assertions.push({ line: i + 1, code: trimmed, kind: 'existence' });
      continue;
    }
    if (/\bt\.(Errorf|Fatalf|Fatal|Error|Fail|FailNow)\b/.test(line)) {
      assertions.push({ line: i + 1, code: trimmed, kind: 'behavioral' });
    }
  }
  return { existenceOnly, assertions };
}

function scanFile(filePath, text) {
  const lang = languageOf(filePath);
  if (lang === 'elixir') return scanElixir(text);
  if (lang === 'js' || lang === 'ts') return scanJsTs(text);
  if (lang === 'python') return scanPython(text);
  if (lang === 'go') return scanGo(text);
  return { existenceOnly: [], assertions: [] };
}

function analyzeFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const { existenceOnly, assertions } = scanFile(filePath, text);
  const total = assertions.length;
  const existenceCount = existenceOnly.length;
  const ratio = total === 0 ? 0 : existenceCount / total;
  return {
    file: filePath,
    language: languageOf(filePath),
    totalAssertions: total,
    existenceOnlyCount: existenceCount,
    ratio,
    findings: existenceOnly,
  };
}

function runAll(cwd, opts) {
  const root = opts.path ? path.resolve(cwd, opts.path) : cwd;
  const langFilter = opts.language && opts.language !== 'all' ? opts.language : null;
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : DEFAULT_THRESHOLD;

  const files = [];
  walk(root, files);
  const filtered = langFilter ? files.filter((f) => languageOf(f) === langFilter) : files;

  if (filtered.length === 0) {
    return {
      status: 'skipped',
      reason: 'no test files under path',
      filesScanned: 0,
      findings: [],
      ratio: 0,
      threshold,
    };
  }

  const perFile = [];
  let aggExistence = 0;
  let aggTotal = 0;
  for (const f of filtered) {
    const r = analyzeFile(f);
    if (!r) continue;
    perFile.push(r);
    aggExistence += r.existenceOnlyCount;
    aggTotal += r.totalAssertions;
  }

  const ratio = aggTotal === 0 ? 0 : aggExistence / aggTotal;
  const findings = [];
  for (const fileResult of perFile) {
    if (fileResult.existenceOnlyCount === 0) continue;
    const rel = path.relative(cwd, fileResult.file);
    for (const hit of fileResult.findings) {
      findings.push({
        class: 'existence-only-assertion',
        severity: 'high',
        file: rel,
        line: hit.line,
        code: hit.code,
        pattern: hit.pattern,
        language: fileResult.language,
        message: `${rel}:${hit.line} — existence-only test assertion (${hit.pattern}) — passes against any stub module containing the symbol`,
      });
    }
  }

  const status = ratio >= threshold && findings.length > 0 ? 'fail' : findings.length > 0 ? 'warn' : 'pass';

  return {
    status,
    filesScanned: perFile.length,
    totalAssertions: aggTotal,
    existenceOnlyCount: aggExistence,
    ratio,
    threshold,
    perFile: perFile.map((f) => ({
      file: path.relative(cwd, f.file),
      language: f.language,
      totalAssertions: f.totalAssertions,
      existenceOnlyCount: f.existenceOnlyCount,
      ratio: f.ratio,
    })),
    findings,
  };
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
  const badge =
    result.status === 'pass'
      ? 'PASS'
      : result.status === 'skipped'
        ? 'SKIP'
        : result.status === 'warn'
          ? 'WARN'
          : 'FAIL';
  const ratioPct = (result.ratio * 100).toFixed(1);
  const thresholdPct = (result.threshold * 100).toFixed(1);
  process.stdout.write(
    `[${badge}] cobolt-test-shape-lint — existence-only ratio ${ratioPct}% (threshold ${thresholdPct}%) — ${result.findings.length} finding(s) across ${result.filesScanned || 0} file(s)\n`,
  );
  for (const f of (result.findings || []).slice(0, 20)) {
    process.stdout.write(`  • ${f.message}\n`);
  }
  if ((result.findings || []).length > 20) {
    process.stdout.write(`  … ${result.findings.length - 20} more (use --json for full output)\n`);
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args[0];
  const idx = (flag) => args.indexOf(flag);
  const get = (flag) => (idx(flag) >= 0 ? args[idx(flag) + 1] : null);
  const threshold = get('--threshold');
  return {
    cmd,
    rest: args.slice(1).filter((_a, i) => {
      const prev = args[i]; // not used; placeholder
      return prev !== undefined; // keep original list — not strictly needed
    }),
    opts: {
      json: args.includes('--json') || idx('--out') >= 0,
      path: get('--path'),
      out: get('--out'),
      language: get('--language'),
      threshold: threshold == null ? DEFAULT_THRESHOLD : Number(threshold),
    },
    positional: args.slice(1).filter((a) => !a.startsWith('--')),
  };
}

function printUsage(stream) {
  stream.write(
    `${[
      'Usage: cobolt-test-shape-lint <command> [options]',
      '',
      'Commands:',
      '  scan            Scan test files under --path (default: cwd) for existence-only assertions',
      '  check-file <p>  Single-file analysis (returns ratio + findings)',
      '',
      'Options:',
      '  --path <dir>            Root to scan (default: cwd)',
      '  --threshold <ratio>     Existence-only ratio that triggers FAIL (default: 0.30)',
      '  --language <lang>       Filter to elixir|js|ts|py|go|all (default: all)',
      '  --json                  Emit machine-readable JSON',
      '  --out <file>            Write JSON to file (implies --json)',
      '',
      'Exit codes: 0 OK | 1 usage | 2 skipped (no test files) | 3 findings (ratio >= threshold)',
    ].join('\n')}\n`,
  );
}

function main() {
  const { cmd, opts, positional } = parseArgs(process.argv);

  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    printUsage(process.stderr);
    process.exit(EXIT_USAGE);
  }

  if (cmd !== 'scan' && cmd !== 'check-file') {
    process.stderr.write(`Unknown command: ${cmd}\n`);
    printUsage(process.stderr);
    process.exit(EXIT_USAGE);
  }

  try {
    if (cmd === 'check-file') {
      const target = positional[0];
      if (!target) {
        process.stderr.write('check-file requires a file path\n');
        process.exit(EXIT_USAGE);
      }
      const abs = path.resolve(process.cwd(), target);
      if (!fs.existsSync(abs)) {
        process.stderr.write(`File not found: ${abs}\n`);
        process.exit(EXIT_USAGE);
      }
      const r = analyzeFile(abs);
      if (!r) {
        process.stderr.write(`Could not read file: ${abs}\n`);
        process.exit(EXIT_USAGE);
      }
      const output = {
        status: r.ratio >= opts.threshold && r.existenceOnlyCount > 0 ? 'fail' : 'pass',
        ...r,
        threshold: opts.threshold,
      };
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      } else {
        emit(
          {
            status: output.status,
            filesScanned: 1,
            totalAssertions: r.totalAssertions,
            existenceOnlyCount: r.existenceOnlyCount,
            ratio: r.ratio,
            threshold: opts.threshold,
            findings: r.findings.map((h) => ({
              class: 'existence-only-assertion',
              severity: 'high',
              file: path.relative(process.cwd(), r.file),
              line: h.line,
              code: h.code,
              pattern: h.pattern,
              language: r.language,
              message: `${path.relative(process.cwd(), r.file)}:${h.line} — existence-only assertion (${h.pattern})`,
            })),
          },
          opts,
        );
      }
      if (output.status === 'fail') process.exit(EXIT_FINDINGS);
      process.exit(EXIT_OK);
    }

    const result = runAll(process.cwd(), opts);
    emit(result, opts);
    if (result.status === 'pass') process.exit(EXIT_OK);
    if (result.status === 'skipped') process.exit(EXIT_SKIPPED);
    if (result.status === 'warn') process.exit(EXIT_OK); // non-fatal; below threshold
    process.exit(EXIT_FINDINGS);
  } catch (err) {
    process.stderr.write(`[cobolt-test-shape-lint] ERROR: ${err.message}\n`);
    process.exit(EXIT_USAGE);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  analyzeFile,
  runAll,
  scanFile,
  scanElixir,
  scanJsTs,
  scanPython,
  scanGo,
  isTestFile,
  languageOf,
  DEFAULT_THRESHOLD,
};
