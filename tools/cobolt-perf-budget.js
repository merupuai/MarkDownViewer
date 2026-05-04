#!/usr/bin/env node

// CoBolt Performance Budget Emitter
//
// Produces the two files cobolt-perf-budget-gate.js reads:
//   _cobolt-output/latest/perf/budget.json        ← targets from TRD
//   _cobolt-output/latest/perf/perf-results.json  ← measured values
//
// Without these files, the perf-budget-gate is permissive. With them,
// deploy/release/milestone-validate block when measured exceeds budget
// by >20% (tolerance configurable via COBOLT_PERF_TOLERANCE).
//
// Usage:
//   # Extract targets from TRD (regex scan over NFR section)
//   node tools/cobolt-perf-budget.js init [--trd <path>]
//
//   # Set/update a budget field explicitly (overrides init)
//   node tools/cobolt-perf-budget.js set p95Ms 200
//   node tools/cobolt-perf-budget.js set bundleKb 300
//
//   # Record measured results (called after a benchmark run)
//   node tools/cobolt-perf-budget.js record p50Ms 45 p95Ms 180 bundleKb 260
//
//   # Show current budget + results
//   node tools/cobolt-perf-budget.js show
//
// Tier 4.1 I2a — v0.11.0

const fs = require('node:fs');
const path = require('node:path');

const VALID_KEYS = [
  'p50Ms',
  'p95Ms',
  'p99Ms',
  'p50',
  'p95',
  'p99',
  'bundleKb',
  'bundleSize',
  'rpsMin',
  'rpsP50',
  // v0.12.1 fix #9: expand to match cobolt-perf-measure emit. errorRate is
  // a real failure signal — an app returning >5% 5xx under load is broken.
  'errorRate',
];

function perfDir() {
  const d = path.join(process.cwd(), '_cobolt-output', 'latest', 'perf');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

function budgetPath() {
  return path.join(perfDir(), 'budget.json');
}

function resultsPath() {
  return path.join(perfDir(), 'perf-results.json');
}

function readJson(fp) {
  if (!fs.existsSync(fp)) return {};
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return {};
  }
}

function writeJson(fp, obj) {
  fs.writeFileSync(fp, JSON.stringify({ ...obj, updatedAt: new Date().toISOString() }, null, 2));
}

// ── init: scan TRD for explicit numeric perf budgets ───────────────

function findTRD(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  const candidates = [
    path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'trd.md'),
    path.join(process.cwd(), '_cobolt-output', 'planning', 'trd.md'),
    path.join(process.cwd(), 'docs', 'TRD.md'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function extractBudgetFromText(text) {
  const out = {};
  // "p95 latency: 200ms" / "p95: 200ms" / "p95Ms = 200"
  for (const [re, key] of [
    [/\bp50\s*(?:latency)?\s*[:=]\s*(\d+(?:\.\d+)?)\s*ms\b/i, 'p50Ms'],
    [/\bp95\s*(?:latency)?\s*[:=]\s*(\d+(?:\.\d+)?)\s*ms\b/i, 'p95Ms'],
    [/\bp99\s*(?:latency)?\s*[:=]\s*(\d+(?:\.\d+)?)\s*ms\b/i, 'p99Ms'],
    [/\bbundle\s*size\s*[:=]\s*(\d+(?:\.\d+)?)\s*kb\b/i, 'bundleKb'],
    [/\bbundle\s*size\s*[:=]\s*(\d+(?:\.\d+)?)\s*mb\b/i, 'bundleKbFromMb'],
    [/\bthroughput\s*[:=]\s*(\d+(?:\.\d+)?)\s*rps\b/i, 'rpsMin'],
    [/\bmin(?:imum)?\s*throughput\s*[:=]\s*(\d+(?:\.\d+)?)\s*rps\b/i, 'rpsMin'],
  ]) {
    const m = text.match(re);
    if (m) {
      const v = Number(m[1]);
      if (key === 'bundleKbFromMb') out.bundleKb = Math.round(v * 1024);
      else out[key] = v;
    }
  }
  return out;
}

function init(opts) {
  const trd = findTRD(opts.trd);
  if (!trd) {
    console.error('[cobolt-perf-budget] no TRD found — skipping init. Set budget with `set` command.');
    return 1;
  }
  const text = fs.readFileSync(trd, 'utf8');
  const extracted = extractBudgetFromText(text);
  if (Object.keys(extracted).length === 0) {
    console.error(
      `[cobolt-perf-budget] no numeric perf targets found in ${trd}. ` +
        `Add lines like "p95 latency: 200ms" or "bundle size: 250kb" to the TRD NFR section, or use the \`set\` command.`,
    );
    return 1;
  }
  const existing = readJson(budgetPath());
  const merged = { ...existing, ...extracted, source: trd };
  writeJson(budgetPath(), merged);
  console.log(JSON.stringify({ ok: true, budget: merged, file: budgetPath() }, null, 2));
  return 0;
}

// ── set / record: explicit key-value update ────────────────────────

function set(key, value, target) {
  if (!VALID_KEYS.includes(key)) {
    console.error(`[cobolt-perf-budget] invalid key "${key}". Valid: ${VALID_KEYS.join(', ')}`);
    return 1;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    console.error(`[cobolt-perf-budget] value must be numeric, got "${value}"`);
    return 1;
  }
  const fp = target === 'budget' ? budgetPath() : resultsPath();
  const current = readJson(fp);
  current[key] = n;
  writeJson(fp, current);
  console.log(JSON.stringify({ ok: true, target, key, value: n, file: fp }, null, 2));
  return 0;
}

function record(args) {
  // record p50Ms 45 p95Ms 180 bundleKb 260
  if (args.length === 0 || args.length % 2 !== 0) {
    console.error('Usage: record <key> <value> [<key> <value>...]');
    return 1;
  }
  const current = readJson(resultsPath());
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i];
    const v = Number(args[i + 1]);
    if (!VALID_KEYS.includes(k) || !Number.isFinite(v)) {
      console.error(`[cobolt-perf-budget] invalid pair: ${k}=${args[i + 1]}`);
      return 1;
    }
    current[k] = v;
  }
  writeJson(resultsPath(), current);
  console.log(JSON.stringify({ ok: true, results: current, file: resultsPath() }, null, 2));
  return 0;
}

function show() {
  const out = {
    budget: readJson(budgetPath()),
    results: readJson(resultsPath()),
    budgetFile: budgetPath(),
    resultsFile: resultsPath(),
  };
  console.log(JSON.stringify(out, null, 2));
  return 0;
}

function parseFlags(args) {
  const out = { _: [], trd: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--trd') out.trd = args[++i];
    else out._.push(args[i]);
  }
  return out;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (cmd) {
    case 'init':
      return init(flags);
    case 'set':
      return set(flags._[0], flags._[1], 'budget');
    case 'record':
      return record(flags._);
    case 'show':
      return show();
    default:
      console.error(
        'Usage: cobolt-perf-budget.js {init [--trd <path>] | set <key> <value> | record <k> <v> [<k> <v>]... | show}',
      );
      console.error(`Valid keys: ${VALID_KEYS.join(', ')}`);
      return 1;
  }
}

if (require.main === module) process.exit(main());

module.exports = { init, set, record, show, extractBudgetFromText };
