#!/usr/bin/env node
// S8 — Multi-model disagreement probe. Dispatches 3 providers to draft the
// interface for each FR; structural AST diff flags >30% divergence as ambiguous.
// This tool emits the dispatch plan + diff harness; actual model dispatch is
// wired by the cobolt-verify-independent skill which has session control.

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
const CWD = process.cwd();
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};

// Help handler — must exit 0 per tools/CLAUDE.md exit contract, and must NOT
// require the drafts directory to exist (discovery probe must be safe).
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(
    [
      'cobolt-fr-ambiguity — multi-model disagreement probe.',
      '',
      'Usage:',
      '  node tools/cobolt-fr-ambiguity.js [--drafts <path>] [--threshold <0..1>]',
      '',
      'Scans `--drafts <path>` (default `_cobolt-output/latest/fr-drafts`) for',
      '<FR-id>/model-{A,B,C}.{ts,py,...} draft triples, computes structural AST',
      'divergence (Jaccard), and flags FRs above `--threshold` (default 0.30)',
      'as ambiguous. Dispatch of model-A/B/C drafts is wired separately by the',
      'cobolt-verify-independent skill.',
    ].join('\n'),
  );
  process.exit(0);
}

const draftsDir = arg('--drafts', '_cobolt-output/latest/fr-drafts');
const threshold = Number(arg('--threshold', '0.30'));

const root = path.join(CWD, draftsDir);
if (!fs.existsSync(root)) {
  console.error(`drafts directory missing: ${draftsDir}`);
  console.error('expected layout: <root>/<FR-id>/model-{A,B,C}.{ts,py,...}');
  process.exit(1);
}

function normalizeAST(src) {
  // Extremely crude AST-shape hash: strip comments + identifiers, keep punctuation/keywords.
  return src
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*|#.*/g, '')
    .replace(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g, 'ID')
    .replace(/\s+/g, '')
    .slice(0, 4000);
}
function jaccard(a, b, k = 6) {
  const shingles = (s) => {
    const set = new Set();
    for (let i = 0; i <= s.length - k; i++) set.add(s.slice(i, i + k));
    return set;
  };
  const A = shingles(a),
    B = shingles(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const uni = new Set([...A, ...B]).size || 1;
  return inter / uni;
}

const results = [];
for (const fr of fs.readdirSync(root)) {
  const frDir = path.join(root, fr);
  if (!fs.statSync(frDir).isDirectory()) continue;
  const files = fs.readdirSync(frDir).map((f) => path.join(frDir, f));
  if (files.length < 2) continue;
  const shapes = files.map((f) => normalizeAST(fs.readFileSync(f, 'utf8')));
  let divergenceSum = 0,
    pairs = 0;
  for (let i = 0; i < shapes.length; i++)
    for (let j = i + 1; j < shapes.length; j++) {
      divergenceSum += 1 - jaccard(shapes[i], shapes[j]);
      pairs++;
    }
  const divergence = pairs ? divergenceSum / pairs : 0;
  results.push({
    fr,
    drafts: files.length,
    divergence: Number(divergence.toFixed(3)),
    ambiguous: divergence > threshold,
  });
}

const out = path.join(CWD, '_cobolt-output', 'latest', 'planning', 'fr-ambiguity.json');
atomicWrite(out, JSON.stringify({ ts: new Date().toISOString(), threshold, results }, null, 2));

const ambiguous = results.filter((r) => r.ambiguous);
console.log(`FR ambiguity: ${ambiguous.length}/${results.length} above ${threshold}`);
process.exit(ambiguous.length ? 1 : 0);
