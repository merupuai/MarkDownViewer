#!/usr/bin/env node

// CoBolt Degradation CLI — surface and manage the degradation ledger.
//
// Usage:
//   node tools/cobolt-degradation.js status           # active degradations
//   node tools/cobolt-degradation.js summary          # rolled-up counts
//   node tools/cobolt-degradation.js tail [--n 20]    # recent events
//   node tools/cobolt-degradation.js clear <layer>    # clear a layer (e.g. after fix verified)
//   node tools/cobolt-degradation.js record --layer X --from A --to B --risk HIGH --reason "…" --remediation "…"

const fs = require('node:fs');
const path = require('node:path');

const lib = require(path.resolve(__dirname, '..', 'lib', 'cobolt-degradation.js'));

const LEDGER = path.join('_cobolt-output', 'audit', 'degradation.jsonl');
const SUMMARY = path.join('_cobolt-output', 'audit', 'degradation-summary.json');

const [, , cmd, ...rest] = process.argv;

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) out[k.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

function main() {
  switch (cmd) {
    case 'status': {
      const active = lib.listActive();
      const entries = Object.entries(active);
      if (entries.length === 0) {
        console.log('No active degradations. Pipeline operating at full capability.');
        return 0;
      }
      console.log(`Active degradations (${entries.length}):\n`);
      for (const [layer, e] of entries) {
        console.log(`  [${e.risk}] ${layer}: ${e.from} → ${e.to}`);
        console.log(`    Reason: ${e.reason}`);
        console.log(`    Fix:    ${e.remediation}`);
        console.log(`    Since:  ${e.since}\n`);
      }
      return lib.hasCritical() ? 2 : 0;
    }
    case 'summary': {
      try {
        const s = JSON.parse(fs.readFileSync(SUMMARY, 'utf8'));
        console.log(JSON.stringify(s, null, 2));
      } catch {
        console.log('{}');
      }
      return 0;
    }
    case 'tail': {
      const flags = parseFlags(rest);
      const n = parseInt(flags.n, 10) || 20;
      try {
        const rows = fs.readFileSync(LEDGER, 'utf8').trim().split('\n').slice(-n);
        for (const r of rows) console.log(r);
      } catch {
        console.log('(no degradation events yet)');
      }
      return 0;
    }
    case 'clear': {
      const layer = rest[0];
      if (!layer) {
        console.error('Usage: clear <layer>');
        return 1;
      }
      const ok = lib.clearDegradation(layer);
      console.log(ok ? `cleared: ${layer}` : `not found: ${layer}`);
      return ok ? 0 : 1;
    }
    case 'record': {
      const f = parseFlags(rest);
      const row = lib.recordDegradation({
        layer: f.layer,
        from: f.from,
        to: f.to,
        risk: f.risk,
        reason: f.reason,
        remediation: f.remediation,
      });
      console.log(JSON.stringify(row, null, 2));
      return 0;
    }
    default:
      console.log('Usage: cobolt-degradation.js {status|summary|tail|clear|record} [flags]');
      return 1;
  }
}

if (require.main === module) process.exit(main());
module.exports = { main };
