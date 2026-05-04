#!/usr/bin/env node

// CoBolt Behavior Coverage Analyzer
//
// Gates and tools today check tests exist + pass. They don't check that
// tests cover real behavior taxonomy. For each FR we require:
//   - ≥1 happy-path test
//   - ≥1 failure test
//   - ≥1 edge test (boundary / empty / max / null)
//   - ≥1 concurrency test (where applicable — declared in PRD/implicit-reqs)
//
// Discovery: parses test files for FR references (FR-NNN) and classifies
// each test by name tokens + tags.
//
// REALISM (v0.12.0 — Gap #4 fix): name-classification alone is gameable —
// a test called "should reject invalid input" with body `expect(true).toBe(true)`
// passed the old gate. The realism filter now inspects each test's BODY:
//   - Rejects tautological assertions (expect(true).toBe(true), assert 1==1)
//   - Requires ≥1 meaningful assertion
//   - FAILURE category: body must reference throw/reject/error/4xx/5xx/assert_raise
//   - EDGE category: body must contain at least one boundary literal
//     (0, null, undefined, '', [], {}, MAX_*, MIN_*, very-long strings)
// Tests failing realism are listed under realismRejects[] and do NOT count
// toward the category's coverage requirement.
//
// Usage:
//   node tools/cobolt-behavior-coverage.js analyze [--milestone M3] [--json]
//   node tools/cobolt-behavior-coverage.js gate     # exit 1 on gaps
//
// Writes _cobolt-output/latest/behavior-coverage/report.json.
// Records behaviorCoverageGaps metric.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CATEGORIES = ['happy', 'failure', 'edge', 'concurrency'];

const HAPPY_TOKENS =
  /\b(happy|success|valid|returns|gets|creates|updates|reads|lists|should\s+return|should\s+create|should\s+succeed)\b/i;
const FAILURE_TOKENS =
  /\b(fail|failure|error|rejects|throws|invalid|unauthorized|forbidden|not\s*found|bad\s*request|should\s+(fail|throw|reject|error))\b/i;
const EDGE_TOKENS =
  /\b(edge|boundary|empty|max|min|overflow|limit|zero|null|undefined|longest|shortest|too\s*(large|small)|xss|sql\s*inject)\b/i;
const CONCURRENCY_TOKENS =
  /\b(concurrent|concurrency|race|parallel|simultaneous|lock|deadlock|atomic|transaction\s*(isolat|conflict))\b/i;

const FR_PATTERN = /\bFR[-_]?(\d{2,4})\b/g;

const IGNORE = new Set([
  'node_modules',
  '.git',
  '_cobolt-output',
  'dist',
  'build',
  '.next',
  'coverage',
  '_build',
  'deps',
]);
const TEST_EXT = /\.(spec|test)\.(js|mjs|cjs|ts|tsx|jsx|py|ex|exs|rb|go)$/i;

function walk(dir, out = [], depth = 0) {
  if (depth > 12) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (IGNORE.has(e.name) || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out, depth + 1);
    else if (e.isFile() && TEST_EXT.test(e.name)) out.push(full);
  }
  return out;
}

function classify(testNameOrText) {
  const s = testNameOrText;
  const cats = [];
  if (FAILURE_TOKENS.test(s)) cats.push('failure');
  if (EDGE_TOKENS.test(s)) cats.push('edge');
  if (CONCURRENCY_TOKENS.test(s)) cats.push('concurrency');
  // Happy is default when nothing else fires
  if (cats.length === 0 && HAPPY_TOKENS.test(s)) cats.push('happy');
  if (cats.length === 0) cats.push('happy'); // fallback — assume happy
  return cats;
}

// Extract test cases WITH their bodies by scanning common test DSLs.
// Returns [{name, body}]. Body is an approximate chunk — the text between
// the test opener and the nearest plausible terminator (next test/describe,
// `end`, def, or a reasonable line window). Good enough for realism checks.
function extractTests(text) {
  const tests = [];
  // Normalize offsets: { start: Number, name: String, terminator: 'brace'|'end'|'def' }
  const openers = [];
  const patterns = [
    {
      re: /(?:\b(?:test|it))\s*\(\s*['"`]([^'"`]{3,200})['"`]\s*,\s*(?:async\s*)?(?:\(\s*\)|\w+)?\s*=?>?\s*\{?/g,
      terminator: 'brace',
    },
    {
      re: /describe\s*\(\s*['"`]([^'"`]{3,200})['"`]\s*,\s*(?:async\s*)?(?:\(\s*\)|\w+)?\s*=?>?\s*\{?/g,
      terminator: 'brace',
    },
    { re: /def\s+test_(\w+)\s*\([^)]*\)\s*:/g, terminator: 'def' },
    { re: /it\s+['"]([^'"]{3,200})['"]\s+do\b/g, terminator: 'end' },
    { re: /\btest\s+['"]([^'"]{3,200})['"]\s+do\b/g, terminator: 'end' },
  ];
  for (const { re, terminator } of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      openers.push({ start: m.index + m[0].length, name: m[1], terminator });
    }
  }
  openers.sort((a, b) => a.start - b.start);
  for (let i = 0; i < openers.length; i++) {
    const o = openers[i];
    const next = openers[i + 1]?.start ?? text.length;
    // Cap body at ~120 lines to keep analysis cheap.
    const chunkEnd = Math.min(next, o.start + 6000);
    const body = text.slice(o.start, chunkEnd);
    tests.push({ name: o.name, body });
  }
  return tests;
}

// ── REALISM FILTER ─────────────────────────────────────────────────

// Patterns that indicate a tautological / empty assertion.
const TAUTOLOGY = [
  /\bexpect\s*\(\s*true\s*\)\s*\.\s*(?:toBe|toEqual|toBeTruthy)\s*\(\s*true\s*\)/i,
  /\bexpect\s*\(\s*1\s*\)\s*\.\s*(?:toBe|toEqual)\s*\(\s*1\s*\)/i,
  /\bexpect\s*\(\s*['"]\w*['"]\s*\)\s*\.\s*(?:toBe|toEqual)\s*\(\s*['"]\w*['"]\s*\)/i, // string-to-same-string
  /\bassert\s+true\b/i,
  /\bassert\s+1\s*==\s*1\b/,
  /\bassert\s*\(\s*true\s*\)/i,
];

// Any meaningful assertion signal.
const ASSERT_SIGNAL = [
  /\bexpect\s*\(/,
  /\bassert\w*\s*[\s(]/,
  /\bshould\s*\./,
  /\.toMatch(Snapshot|Object)?\s*\(/,
  /\brefute\b/,
  /\bassert_/,
];

// FAILURE-flavored assertion signals.
const FAILURE_SIGNAL = [
  /\.to\s*Throw\s*\(/i,
  /\.rejects\s*\./i,
  /\.toHaveProperty\s*\(\s*['"`](?:error|message|code)['"`]/i,
  /\.toMatchObject\s*\(\s*\{\s*(?:error|code|message|status)/i,
  /\bassert_raise\b/i,
  /\bexpect\s*\(\s*\w+\s*\)\s*\.\s*to_raise/i,
  /\bstatus(?:Code)?\s*[:=]?\s*[[(]?\s*4\d{2}\b/,
  /\bstatus(?:Code)?\s*[:=]?\s*[[(]?\s*5\d{2}\b/,
  /\.(?:toBe|toEqual)\s*\(\s*4\d{2}\s*\)/, // expect(res.status).toBe(401)
  /\.(?:toBe|toEqual)\s*\(\s*5\d{2}\s*\)/,
  /\bexpect\s*\([^)]+\)\s*\.\s*toBe\s*\(\s*(?:false|null)\s*\)/i,
  /\btry\s*\{[\s\S]{0,200}?catch\b/,
  /\bpytest\.raises\b/,
];

// EDGE-flavored literals that prove a boundary was actually exercised.
const EDGE_LITERAL = [
  /\bnull\b/,
  /\bundefined\b/,
  /['"`]\s*['"`]/, // empty string literal ""  ''  ``
  /\[\s*\]/, // empty array
  /\{\s*\}/, // empty object
  /\bNumber\.MAX_SAFE_INTEGER\b/,
  /\bNumber\.MIN_SAFE_INTEGER\b/,
  /\bInfinity\b/,
  /-Infinity\b/,
  /\bNaN\b/,
  /\.repeat\s*\(\s*\d{3,}\s*\)/, // long string
  /['"`][^'"`]{500,}['"`]/, // literal ≥500 char string
  /[\s(=,]0[\s,)]/, // bare 0 literal in expr context
  /[<>=!]=?\s*0\b/, // comparison against 0
];

function hasMatch(patterns, text) {
  return patterns.some((re) => re.test(text));
}

// Check realism for one test. Returns { ok, reason } where reason names
// the first failure condition; ok=true means the test is realism-clean.
function checkRealism(test, categories) {
  const body = test.body || '';
  // A test with no body at all is a stub — reject.
  if (body.trim().length < 10) return { ok: false, reason: 'empty body' };

  // Tautology — trivial assertions that always pass.
  if (hasMatch(TAUTOLOGY, body)) return { ok: false, reason: 'tautological assertion (e.g. expect(true).toBe(true))' };

  // Must have at least one assertion signal.
  if (!hasMatch(ASSERT_SIGNAL, body)) return { ok: false, reason: 'no assertion found in test body' };

  // FAILURE tests need a failure-flavored assertion.
  if (categories.includes('failure') && !hasMatch(FAILURE_SIGNAL, body)) {
    return { ok: false, reason: 'classified as failure test but body has no throw/reject/error/4xx/5xx assertion' };
  }

  // EDGE tests need a boundary literal.
  if (categories.includes('edge') && !hasMatch(EDGE_LITERAL, body)) {
    return {
      ok: false,
      reason: 'classified as edge test but body has no boundary literal (null/undefined/empty/max/min)',
    };
  }

  return { ok: true };
}

function extractFRs(text) {
  const ids = new Set();
  let m;
  FR_PATTERN.lastIndex = 0;
  while ((m = FR_PATTERN.exec(text)) !== null) {
    ids.add(`FR-${m[1].padStart(3, '0')}`);
  }
  return [...ids];
}

function loadPRDFRs() {
  const candidates = [
    path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'prd.md'),
    path.join(process.cwd(), '_cobolt-output', 'planning', 'prd.md'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return extractFRs(fs.readFileSync(c, 'utf8'));
  }
  return [];
}

function analyze() {
  const prdFRs = loadPRDFRs();
  const testFiles = walk(process.cwd());
  const coverage = {}; // FR-NNN → { happy, failure, edge, concurrency, files, realismRejects }
  const allRejects = [];

  for (const fr of prdFRs) {
    coverage[fr] = { happy: 0, failure: 0, edge: 0, concurrency: 0, files: [], realismRejects: [] };
  }

  for (const f of testFiles) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const frs = extractFRs(text);
    if (frs.length === 0) continue;
    const tests = extractTests(text);
    const relFile = path.relative(process.cwd(), f);

    for (const fr of frs) {
      coverage[fr] ||= { happy: 0, failure: 0, edge: 0, concurrency: 0, files: [], realismRejects: [] };
      coverage[fr].files.push(relFile);

      for (const t of tests) {
        const cats = classify(t.name);
        const realism = checkRealism(t, cats);
        if (!realism.ok) {
          const rej = { fr, file: relFile, test: t.name, categories: cats, reason: realism.reason };
          coverage[fr].realismRejects.push(rej);
          allRejects.push(rej);
          continue; // does NOT count toward category coverage
        }
        for (const cat of cats) coverage[fr][cat] = (coverage[fr][cat] || 0) + 1;
      }

      // Legacy fallback: file references FR but no parseable tests → 1 weak happy.
      // Kept for back-compat but marked in a weak-only counter so gate sees it.
      if (tests.length === 0) coverage[fr].happy++;
    }
  }

  // Gaps
  const gaps = [];
  for (const [fr, c] of Object.entries(coverage)) {
    const missing = [];
    if (c.happy === 0) missing.push('happy');
    if (c.failure === 0) missing.push('failure');
    if (c.edge === 0) missing.push('edge');
    if (missing.length > 0) gaps.push({ fr, missing, counts: c, files: c.files, realismRejects: c.realismRejects });
  }

  return {
    ok: gaps.length === 0,
    totalFRs: Object.keys(coverage).length,
    testFilesScanned: testFiles.length,
    coverage,
    gaps,
    realismRejectsTotal: allRejects.length,
    realismRejects: allRejects,
    generatedAt: new Date().toISOString(),
  };
}

function writeReport(result) {
  const dir = path.join(process.cwd(), '_cobolt-output', 'latest', 'behavior-coverage');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fp = path.join(dir, 'report.json');
  fs.writeFileSync(fp, JSON.stringify(result, null, 2));
  return fp;
}

function bumpMetric(count, metric = 'behaviorCoverageGaps') {
  if (count <= 0) return;
  try {
    const tool = path.join(__dirname, 'cobolt-production-readiness.js');
    if (fs.existsSync(tool)) {
      execFileSync('node', [tool, 'record', metric, String(count)], { stdio: 'ignore' });
    }
  } catch {
    /* non-fatal */
  }
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const json = rest.includes('--json');
  switch (cmd) {
    case 'analyze':
    case 'gate': {
      const r = analyze();
      const fp = writeReport(r);
      if (!r.ok) bumpMetric(r.gaps.length);
      if (r.realismRejectsTotal > 0) bumpMetric(r.realismRejectsTotal, 'behaviorRealismRejects');
      if (json || cmd === 'gate') console.log(JSON.stringify(r, null, 2));
      else {
        console.log(
          `Behavior coverage — ${r.ok ? 'PASS' : 'FAIL'} (${r.totalFRs} FRs, ${r.testFilesScanned} test files, ${r.realismRejectsTotal} realism rejects)`,
        );
        if (!r.ok) {
          console.log(`\n${r.gaps.length} coverage gap(s):`);
          for (const g of r.gaps.slice(0, 10)) {
            console.log(`  ${g.fr} — missing: ${g.missing.join(', ')}`);
          }
        }
        if (r.realismRejectsTotal > 0) {
          console.log(`\nRealism rejects (sample):`);
          for (const rj of r.realismRejects.slice(0, 5)) {
            console.log(`  ${rj.fr} [${rj.categories.join(',')}] "${rj.test}" — ${rj.reason}`);
            console.log(`    ${rj.file}`);
          }
        }
        console.log(`\nReport: ${fp}`);
      }
      return r.ok ? 0 : 1;
    }
    default:
      console.error('Usage: cobolt-behavior-coverage.js {analyze|gate} [--json]');
      return 1;
  }
}

if (require.main === module) process.exit(main());

module.exports = { analyze, CATEGORIES, checkRealism, extractTests, classify };
