#!/usr/bin/env node

// cobolt-hook-latency — hook latency & failure budget rollup (v0.24).
//
// Reads _cobolt-output/audit/hook-latency.jsonl and source/config/hook-budgets.json
// to produce a per-hook p50/p95/p99 rollup plus breach report.
//
// Usage:
//   node tools/cobolt-hook-latency.js rollup [--window N]
//   node tools/cobolt-hook-latency.js list   [--class fast|medium|slow|heavy] [--breaches]
//   node tools/cobolt-hook-latency.js check  [--tier 1]   # exit 1 if Tier <= N in breach
//
// Output:
//   _cobolt-output/audit/hook-latency-summary.json

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
const CWD = process.cwd();
const LATENCY_PATH = path.join(CWD, '_cobolt-output', 'audit', 'hook-latency.jsonl');
const CRASH_PATH = path.join(CWD, '_cobolt-output', 'audit', 'hook-crash-log.jsonl');
const SUMMARY_PATH = path.join(CWD, '_cobolt-output', 'audit', 'hook-latency-summary.json');

function resolveBudgets() {
  const candidates = [
    path.join(CWD, '.claude', 'config', 'hook-budgets.json'),
    path.join(CWD, 'source', 'config', 'hook-budgets.json'),
    path.join(__dirname, '..', 'source', 'config', 'hook-budgets.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      /* fall through */
    }
  }
  return {
    version: 'fallback',
    classes: {},
    hooks: {},
    breachPolicy: { windowSamples: 50, toleranceRatio: 0.25, graceInvocations: 20 },
  };
}

function readJsonl(fp) {
  if (!fs.existsSync(fp)) return [];
  const raw = fs.readFileSync(fp, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function rollup(args) {
  const budgets = resolveBudgets();
  const policy = budgets.breachPolicy || { windowSamples: 50, toleranceRatio: 0.25, graceInvocations: 20 };
  const windowSamples = Number(args.window || policy.windowSamples);
  const tolerance = Number(args.tolerance || policy.toleranceRatio);

  const records = readJsonl(LATENCY_PATH);
  const crashes = readJsonl(CRASH_PATH);

  const byHook = new Map();
  for (const r of records) {
    if (!r?.hook || typeof r.durMs !== 'number') continue;
    if (!byHook.has(r.hook)) byHook.set(r.hook, { durs: [], outcomes: { approve: 0, block: 0, error: 0, timeout: 0 } });
    const bucket = byHook.get(r.hook);
    bucket.durs.push(r.durMs);
    if (r.outcome && bucket.outcomes[r.outcome] != null) bucket.outcomes[r.outcome]++;
  }
  const crashByHook = new Map();
  for (const c of crashes) {
    if (!c?.hook) continue;
    crashByHook.set(c.hook, (crashByHook.get(c.hook) || 0) + 1);
  }

  const hooks = [];
  for (const [hook, data] of byHook) {
    const window = data.durs.slice(-windowSamples);
    const sorted = window.slice().sort((a, b) => a - b);
    const entry = budgets.hooks[hook] || { class: 'fast', tier: 3, failPolicy: 'fail-open-silent' };
    const bud = budgets.classes?.[entry.class] || {
      p50Ms: 5,
      p95Ms: 50,
      p99Ms: 150,
      timeoutMs: 2000,
    };
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const p99 = percentile(sorted, 99);
    const limit = bud.p95Ms * (1 + tolerance);
    const breaching = p95 > limit;
    hooks.push({
      hook,
      class: entry.class,
      tier: entry.tier,
      failPolicy: entry.failPolicy,
      samples: data.durs.length,
      windowed: window.length,
      p50Ms: Math.round(p50 * 10) / 10,
      p95Ms: Math.round(p95 * 10) / 10,
      p99Ms: Math.round(p99 * 10) / 10,
      budgetP95Ms: bud.p95Ms,
      limitP95Ms: Math.round(limit),
      breaching,
      outcomes: data.outcomes,
      crashes: crashByHook.get(hook) || 0,
    });
  }
  hooks.sort((a, b) => b.p95Ms - a.p95Ms);

  const summary = {
    generatedAt: new Date().toISOString(),
    budgetsVersion: budgets.version,
    windowSamples,
    toleranceRatio: tolerance,
    totalHooks: hooks.length,
    breaching: hooks.filter((h) => h.breaching).length,
    breachingByTier: {
      tier0: hooks.filter((h) => h.breaching && h.tier === 0).length,
      tier1: hooks.filter((h) => h.breaching && h.tier === 1).length,
      tier2: hooks.filter((h) => h.breaching && h.tier === 2).length,
      tier3: hooks.filter((h) => h.breaching && h.tier === 3).length,
    },
    totalCrashes: hooks.reduce((s, h) => s + h.crashes, 0),
    hooks,
  };

  try {
    atomicWrite(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`);
  } catch (e) {
    process.stderr.write(`[cobolt-hook-latency] write failed: ${e.message}\n`);
  }
  return summary;
}

function list(args) {
  const summary = rollup(args);
  const filtered = summary.hooks.filter((h) => {
    if (args.class && h.class !== args.class) return false;
    if (args.breaches && !h.breaching) return false;
    return true;
  });
  const w = (s, n) => String(s).padEnd(n).slice(0, n);
  process.stdout.write(
    `${w('hook', 48)} ${w('cls', 6)} ${w('tier', 4)} ${w('p50', 8)} ${w('p95', 8)} ${w('p99', 8)} ${w('budget', 8)} ${w('!', 3)} ${w('crash', 6)} ${w('samples', 7)}\n`,
  );
  for (const h of filtered) {
    process.stdout.write(
      `${w(h.hook, 48)} ${w(h.class, 6)} ${w(h.tier, 4)} ${w(h.p50Ms, 8)} ${w(h.p95Ms, 8)} ${w(h.p99Ms, 8)} ${w(h.budgetP95Ms, 8)} ${w(h.breaching ? 'Y' : '', 3)} ${w(h.crashes, 6)} ${w(h.samples, 7)}\n`,
    );
  }
  process.stdout.write(
    `\n${filtered.length} shown / ${summary.totalHooks} total / ${summary.breaching} breaching / ${summary.totalCrashes} crashes\n`,
  );
}

function check(args) {
  const maxTier = Number(args.tier != null && args.tier !== true ? args.tier : 1);
  const summary = rollup(args);
  const offenders = summary.hooks.filter((h) => h.breaching && h.tier <= maxTier);
  if (offenders.length === 0) {
    process.stdout.write(`OK — 0 Tier <=${maxTier} hooks in breach (${summary.totalHooks} hooks analysed).\n`);
    process.exit(0);
  }
  process.stderr.write(`FAIL — ${offenders.length} Tier <=${maxTier} hook(s) breaching budget:\n`);
  for (const h of offenders) {
    process.stderr.write(
      `  - ${h.hook} (tier ${h.tier}, class ${h.class}): p95 ${h.p95Ms}ms > ${h.budgetP95Ms}ms budget\n`,
    );
  }
  process.exit(1);
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'rollup';
  const args = parseArgs(argv.slice(1));
  switch (cmd) {
    case 'rollup': {
      const s = rollup(args);
      process.stdout.write(
        `${JSON.stringify({ totalHooks: s.totalHooks, breaching: s.breaching, crashes: s.totalCrashes, summary: SUMMARY_PATH }, null, 2)}\n`,
      );
      return;
    }
    case 'list':
      return list(args);
    case 'check':
      return check(args);
    default:
      process.stderr.write(`Unknown command: ${cmd}\nUsage: cobolt-hook-latency.js [rollup|list|check] [options]\n`);
      process.exit(2);
  }
}

if (require.main === module) main();

module.exports = { rollup, list, check };
