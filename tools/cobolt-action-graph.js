#!/usr/bin/env node

// CoBolt Action Graph (P3.1 / v0.66+).
//
// CLI for the content-addressed action cache (lib/cobolt-action-cache.js).
// Stages declare inputs (files + params), the graph computes a stable key,
// and downstream runs skip when the key matches a cached entry. Bazel-style
// in spirit, Node-only in implementation.
//
// Wiring contract for stages that opt in:
//   1. Construct an inputs declaration: { stage, params, files, envVars }.
//   2. Call `computeKey(inputs)` → cache key.
//   3. If `has(key)`: call `restore(key, outputMap)` → skip the work.
//   4. If miss: do the work, then `put(key, { inputs, outputs })` to cache.
//   5. Cache lookups + writes append to evidence-ledger as CHECK_RESULT
//      with attribute cache.hit = true | false.
//
// Stages that MUST NOT cache (Inv-9 + Inv-23 producer-side):
//   - Agent dispatches (output is non-deterministic).
//   - Stages that emit lifecycle events to the central ledger.
//   - Stages that touch the bypass ledger or evidence ledger.
//
// Standards mapping (Inv-21):
//   Software Engineering at Google §22 — action graph + content-addressed
//                                        cache pattern.
//   ISO/IEC 27001 A.8.16 — cache-hit telemetry (monitoring activities).
//
// Public API:
//   computeKey(inputs) -> hex key
//   tryCache(inputs, { outputMap, cwd? }) -> { hit, key, manifest? }
//   recordOutput(inputs, { outputs, metadata?, cwd? }) -> { key, manifest }
//   stats() / clear() / evictLru()
//
// CLI:
//   node tools/cobolt-action-graph.js stats
//   node tools/cobolt-action-graph.js clear
//   node tools/cobolt-action-graph.js evict [--budget 1073741824]
//   node tools/cobolt-action-graph.js compute-key <inputs.json>
//
// Exit codes per tools/CLAUDE.md:
//   0 — success
//   1 — hard error (parse failure, write failure)

const fs = require('node:fs');
const _path = require('node:path');
const cache = require('../lib/cobolt-action-cache');

function _evLedger() {
  try {
    return require('../lib/cobolt-evidence-ledger');
  } catch {
    return null;
  }
}

function _appendEvidence({ cwd, key, hit, stage }) {
  const evLedger = _evLedger();
  if (!evLedger) return null;
  try {
    return evLedger.append(
      {
        kind: evLedger.KINDS.CHECK_RESULT,
        producer: 'cobolt-action-graph/v0.66.0',
        controlIds: ['ISO.27001.A.8.16'],
        payload: { stage, key: key.slice(0, 16), hit, ts: new Date().toISOString() },
      },
      { projectRoot: cwd || process.cwd() },
    );
  } catch {
    return null;
  }
}

function tryCache(inputs, { outputMap = {}, cwd } = {}) {
  const key = cache.computeKey(inputs);
  if (!cache.has(key)) {
    _appendEvidence({ cwd, key, hit: false, stage: inputs.stage });
    return { hit: false, key };
  }
  const manifest = cache.restore(key, outputMap);
  _appendEvidence({ cwd, key, hit: true, stage: inputs.stage });
  return { hit: true, key, manifest };
}

function recordOutput(inputs, { outputs, metadata = {}, cwd } = {}) {
  const key = cache.computeKey(inputs);
  const manifest = cache.put(key, { inputs, outputs, metadata });
  _appendEvidence({ cwd, key, hit: false, stage: inputs.stage });
  return { key, manifest };
}

module.exports = {
  computeKey: cache.computeKey,
  tryCache,
  recordOutput,
  stats: cache.stats,
  clear: cache.clear,
  evictLru: cache.evictLru,
};

// ── CLI ──────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log('Usage: node tools/cobolt-action-graph.js <command> [args]');
    console.log('Commands:');
    console.log('  stats                          Show cache size + entry count');
    console.log('  clear                          Clear all cache entries (DESTRUCTIVE)');
    console.log('  evict [--budget <bytes>]       LRU evict to fit budget (default 1 GiB)');
    console.log('  compute-key <inputs.json>      Print key for a given inputs declaration');
    process.exit(0);
  }
  try {
    if (cmd === 'stats') {
      const s = cache.stats();
      console.log(`[cobolt-action-graph] Dir:     ${s.dir}`);
      console.log(`[cobolt-action-graph] Entries: ${s.entries}`);
      console.log(`[cobolt-action-graph] Bytes:   ${s.totalBytes} (${(s.totalBytes / 1024 / 1024).toFixed(2)} MiB)`);
      process.exit(0);
    }
    if (cmd === 'clear') {
      const r = cache.clear();
      console.log(`[cobolt-action-graph] cleared=${r.cleared} entries`);
      process.exit(0);
    }
    if (cmd === 'evict') {
      let budget = cache.DEFAULT_CACHE_BUDGET_BYTES;
      for (let i = 1; i < argv.length; i += 1) {
        if (argv[i] === '--budget') budget = Number(argv[++i]);
      }
      const r = cache.evictLru({ budgetBytes: budget });
      console.log(`[cobolt-action-graph] evicted=${r.evicted} kept=${r.kept} bytes=${r.totalBytes}`);
      process.exit(0);
    }
    if (cmd === 'compute-key') {
      if (!argv[1]) {
        console.error('Usage: compute-key <inputs.json>');
        process.exit(1);
      }
      const inputs = JSON.parse(fs.readFileSync(argv[1], 'utf8'));
      console.log(cache.computeKey(inputs));
      process.exit(0);
    }
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
  } catch (err) {
    console.error(`[cobolt-action-graph] ${err.message}`);
    process.exit(1);
  }
}
