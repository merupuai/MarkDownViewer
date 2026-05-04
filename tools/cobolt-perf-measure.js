#!/usr/bin/env node

// CoBolt Perf Measurement Tool (v0.12.0 Phase 2B)
//
// Fills the missing emitter identified in the v0.12 honest audit: the perf-
// budget gate reads _cobolt-output/latest/perf/perf-results.json, but no
// pipeline step ever wrote it. This tool runs HTTP load, measures bundle
// size, and writes perf-results.json so the gate can enforce the budget.
//
// Zero external dependencies — uses Node's built-in fetch + Performance API.
// For deeper profiling (Lighthouse / webpack analyzer) see cobolt-perf-deep.
//
// Commands:
//   node tools/cobolt-perf-measure.js api --url http://localhost:3000/api/health --requests 200 --concurrency 8
//   node tools/cobolt-perf-measure.js bundle --dist dist/ [--dist .next/]
//   node tools/cobolt-perf-measure.js all --url http://localhost:3000 --dist dist/
//
// Writes to _cobolt-output/latest/perf/perf-results.json. Records via
// cobolt-perf-budget.js for schema consistency.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const DEFAULT_REQUESTS = 100;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT = 8000;

function perfDir() {
  const d = path.join(process.cwd(), '_cobolt-output', 'latest', 'perf');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.floor((p / 100) * sortedArr.length));
  return sortedArr[idx];
}

// ── API load runner ─────────────────────────────────────────────────

async function loadOne(url, timeout) {
  const started = performance.now();
  let status = 0;
  let error = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    status = res.status;
    // Drain to avoid leaving sockets open
    try {
      await res.text();
    } catch {}
  } catch (err) {
    error = err?.message || 'fetch_failed';
  }
  return { ms: performance.now() - started, status, error };
}

async function runLoad(
  url,
  { requests = DEFAULT_REQUESTS, concurrency = DEFAULT_CONCURRENCY, timeout = DEFAULT_TIMEOUT } = {},
) {
  const latencies = [];
  const errors = [];
  let done = 0;
  const started = performance.now();

  async function worker() {
    while (done < requests) {
      done++;
      const r = await loadOne(url, timeout);
      if (r.error || r.status >= 500) errors.push({ status: r.status, error: r.error });
      latencies.push(r.ms);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, requests)) }, () => worker());
  await Promise.all(workers);
  const durationMs = performance.now() - started;

  latencies.sort((a, b) => a - b);
  return {
    requests: latencies.length,
    errors: errors.length,
    errorRate: latencies.length === 0 ? 0 : errors.length / latencies.length,
    durationMs,
    rps: latencies.length / (durationMs / 1000),
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    p99Ms: percentile(latencies, 99),
    maxMs: latencies[latencies.length - 1] || 0,
    minMs: latencies[0] || 0,
  };
}

// ── Bundle size ─────────────────────────────────────────────────────

function dirSizeKb(dir) {
  if (!fs.existsSync(dir)) return { exists: false, kb: 0, files: 0 };
  let bytes = 0;
  let files = 0;
  function walk(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        try {
          bytes += fs.statSync(full).size;
          files++;
        } catch {}
      }
    }
  }
  walk(dir);
  return { exists: true, kb: Math.round(bytes / 1024), files };
}

function measureBundles(dists) {
  const out = {};
  let totalKb = 0;
  for (const d of dists) {
    const res = dirSizeKb(d);
    out[d] = res;
    if (res.exists) totalKb += res.kb;
  }
  return { totalKb, perDist: out };
}

// ── Writer: integrates with cobolt-perf-budget.js `record` ───────────

// v0.12.1 fix #9: keys allowed by cobolt-perf-budget.js record (kept in sync).
// We filter to these before delegating, otherwise one invalid key fails the
// whole record call and no measurements get persisted.
const BUDGET_VALID_KEYS = new Set([
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
  'errorRate',
]);

function recordResults(metrics) {
  // Always write to perf-results.json (so non-budget metrics still land).
  const file = path.join(perfDir(), 'perf-results.json');
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const next = { ...existing, ...metrics, measuredAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(next, null, 2));

  // Also call the budget tool with valid-keys-only (so budget compare works).
  const tool = path.join(__dirname, 'cobolt-perf-budget.js');
  if (!fs.existsSync(tool)) return;
  const args = ['record'];
  for (const [k, v] of Object.entries(metrics)) {
    if (!BUDGET_VALID_KEYS.has(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) {
      args.push(k, String(Math.round(v * 100) / 100));
    }
  }
  if (args.length === 1) return;
  try {
    execFileSync('node', [tool, ...args], { stdio: 'ignore' });
  } catch {
    /* direct file write above is the fallback — already done */
  }
}

// ── CLI ─────────────────────────────────────────────────────────────

function parseFlags(args) {
  const out = {
    _: [],
    url: null,
    requests: DEFAULT_REQUESTS,
    concurrency: DEFAULT_CONCURRENCY,
    timeout: DEFAULT_TIMEOUT,
    dist: [],
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--url') out.url = args[++i];
    else if (a === '--requests') out.requests = Number(args[++i]);
    else if (a === '--concurrency') out.concurrency = Number(args[++i]);
    else if (a === '--timeout') out.timeout = Number(args[++i]);
    else if (a === '--dist') out.dist.push(args[++i]);
    else out._.push(a);
  }
  return out;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (cmd) {
    case 'api': {
      if (!flags.url) {
        console.error('--url required for api command');
        return 1;
      }
      const r = await runLoad(flags.url, flags);
      recordResults({ p50Ms: r.p50Ms, p95Ms: r.p95Ms, p99Ms: r.p99Ms, rpsP50: r.rps, errorRate: r.errorRate });
      console.log(JSON.stringify({ url: flags.url, ...r }, null, 2));
      return r.errorRate > 0.05 ? 1 : 0;
    }
    case 'bundle': {
      const dists = flags.dist.length > 0 ? flags.dist : ['dist', '.next', 'build'];
      const r = measureBundles(dists);
      if (r.totalKb > 0) recordResults({ bundleKb: r.totalKb });
      console.log(JSON.stringify(r, null, 2));
      return r.totalKb > 0 ? 0 : 1;
    }
    case 'all': {
      const result = { api: null, bundle: null };
      if (flags.url) {
        result.api = await runLoad(flags.url, flags);
        recordResults({
          p50Ms: result.api.p50Ms,
          p95Ms: result.api.p95Ms,
          p99Ms: result.api.p99Ms,
          rpsP50: result.api.rps,
          errorRate: result.api.errorRate,
        });
      }
      const dists = flags.dist.length > 0 ? flags.dist : ['dist', '.next', 'build'];
      result.bundle = measureBundles(dists);
      if (result.bundle.totalKb > 0) recordResults({ bundleKb: result.bundle.totalKb });
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    default:
      console.error(
        'Usage: cobolt-perf-measure.js {api|bundle|all} [--url URL] [--requests 100] [--concurrency 4] [--dist dist/]',
      );
      return 1;
  }
}

if (require.main === module) {
  main()
    .then((c) => process.exit(c || 0))
    .catch((err) => {
      console.error(err?.stack || err?.message);
      process.exit(2);
    });
}

module.exports = { runLoad, measureBundles, dirSizeKb, percentile, recordResults };
