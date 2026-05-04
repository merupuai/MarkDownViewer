#!/usr/bin/env node

// CoBolt Gate SLO Reporter (P3.7 / v0.63+).
//
// Consumes _cobolt-output/audit/gate-skip-log.jsonl (and gate-bypass-ledger
// when available) and computes per-gate fire-rates over a rolling window.
// Compares each rate against the gate's declared SLO from
// lib/cobolt-gate-registry.js (GATE_SLOS) and surfaces over-budget gates as
// advisory verdicts. Inv-25: persistent over-budget firing is a signal,
// never an automatic tier-degrade.
//
// What "fire-rate" means here:
//   fire-rate = (BLOCK or BYPASSED entries for this gate) / (total pipeline runs in window)
// where "total pipeline runs" is approximated by the number of distinct
// milestone-close lifecycle events in the window. This is conservative:
// it treats every milestone close as one pipeline run regardless of how
// many gates fired during it.
//
// Standards mapping (Inv-21):
//   Beyer et al. *SRE Book* (2016) §4 — Service Level Objectives.
//   Lipovaca, *Implementing SLOs* (2020) — error-budget burn semantics.
//   ISO/IEC 27001:2022 A.8.16 — monitoring activities.
//   SOC 2 CC7.2 — system monitoring for anomalies.
//
// Public API:
//   summary({ cwd?, since?, until? }) -> { window, gates: [{id, fired, runs, fireRate, slo, status, ...}] }
//   report({ cwd?, since?, format? }) -> string
//   write({ cwd?, since? }) -> { jsonPath, mdPath, summary }
//
// CLI:
//   node tools/cobolt-gate-slo.js summary [--since 30d] [--json]
//   node tools/cobolt-gate-slo.js report  [--since 30d] [--format md|json]
//   node tools/cobolt-gate-slo.js write   [--since 30d]
//
// Exit codes per tools/CLAUDE.md:
//   0 — summary computed (regardless of advisory verdicts within)
//   1 — hard error (parse failure, write failure)

const fs = require('node:fs');
const path = require('node:path');
const registry = require('../lib/cobolt-gate-registry');

function _parseDuration(spec) {
  if (!spec) return 30 * 86400 * 1000;
  const m = String(spec).match(/^(\d+)([dhwm]?)$/);
  if (!m) return 30 * 86400 * 1000;
  const n = Number(m[1]);
  const unit = m[2] || 'd';
  const ms = unit === 'h' ? 3600 : unit === 'd' ? 86400 : unit === 'w' ? 7 * 86400 : 30 * 86400;
  return n * ms * 1000;
}

function _readJsonl(absPath) {
  if (!fs.existsSync(absPath)) return [];
  return fs
    .readFileSync(absPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function _gateRunsInWindow(lifecycle, since, until) {
  // Approximate "pipeline runs" as the number of distinct stage-completed
  // events in the window (build + review + fix + deploy each count once).
  // For sparse projects without lifecycle data, fall back to the number of
  // milestone-close-like events. Floor at 1 to avoid division-by-zero.
  let count = 0;
  for (const entry of lifecycle) {
    const evt = entry.event || entry.eventType;
    if (evt !== 'stage-completed') continue;
    const ts = new Date(entry.ts || entry.timestamp).getTime();
    if (ts >= since && ts <= until) count += 1;
  }
  return Math.max(1, count);
}

function _classifyStatus(fireRate, slo) {
  if (!slo || typeof slo.targetFireRate !== 'number') return 'no-slo';
  if (fireRate <= slo.targetFireRate) return 'within-budget';
  if (fireRate <= slo.targetFireRate * 2) return 'over-budget-warning';
  return 'over-budget-critical';
}

function summary({ cwd, since, until } = {}) {
  const root = cwd ? path.resolve(cwd) : process.cwd();
  const sinceMs = _parseDuration(since);
  const sinceDate = since ? new Date(Date.now() - sinceMs) : new Date(0);
  const untilDate = until ? new Date(until) : new Date();
  const sinceTs = sinceDate.getTime();
  const untilTs = untilDate.getTime();

  const skipLog = _readJsonl(path.join(root, '_cobolt-output', 'audit', 'gate-skip-log.jsonl'));
  const lifecycle = _readJsonl(path.join(root, '_cobolt-output', 'audit', 'lifecycle-events.jsonl'));
  const totalRuns = _gateRunsInWindow(lifecycle, sinceTs, untilTs);

  // Aggregate by gateId from the skip-log. Both BLOCK and BYPASSED count
  // toward fire-rate — a gate that fires-and-is-bypassed is still firing.
  const byGate = new Map();
  for (const entry of skipLog) {
    const ts = new Date(entry.timestamp || entry.ts).getTime();
    if (Number.isNaN(ts) || ts < sinceTs || ts > untilTs) continue;
    const gateId = entry.gateId || entry.hook?.replace(/^cobolt-|-gate.*$/g, '') || 'unknown';
    if (!byGate.has(gateId)) byGate.set(gateId, { fired: 0, blocks: 0, bypasses: 0, lastFiredAt: null });
    const agg = byGate.get(gateId);
    agg.fired += 1;
    if (String(entry.action || '').startsWith('BLOCK')) agg.blocks += 1;
    if (String(entry.action || '').startsWith('BYPASS')) agg.bypasses += 1;
    if (!agg.lastFiredAt || ts > new Date(agg.lastFiredAt).getTime()) {
      agg.lastFiredAt = new Date(ts).toISOString();
    }
  }

  // Iterate over every registered gate so silent (zero-fire) gates also appear
  // in the report — reassuring readers that the gate IS armed, not absent.
  const gates = [];
  for (const def of registry.BYPASSABLE_GATES) {
    if (def.id === 'master') continue; // master kill is special
    const agg = byGate.get(def.id) || { fired: 0, blocks: 0, bypasses: 0, lastFiredAt: null };
    const fireRate = agg.fired / totalRuns;
    const slo = def.slo || { targetFireRate: 0.05 };
    const status = _classifyStatus(fireRate, slo);
    const burnRate = slo.targetFireRate > 0 ? Math.round((fireRate / slo.targetFireRate) * 100) / 100 : null;
    gates.push({
      id: def.id,
      tier: def.tier,
      slo,
      runs: totalRuns,
      fired: agg.fired,
      blocks: agg.blocks,
      bypasses: agg.bypasses,
      fireRate: Math.round(fireRate * 10000) / 10000,
      burnRate,
      status,
      lastFiredAt: agg.lastFiredAt,
    });
  }

  // Sort over-budget first (critical → warning → within → no-slo), then by
  // burn-rate descending so the reader sees the worst offenders at the top.
  const order = { 'over-budget-critical': 0, 'over-budget-warning': 1, 'within-budget': 2, 'no-slo': 3 };
  gates.sort((a, b) => {
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    return (b.burnRate || 0) - (a.burnRate || 0);
  });

  return {
    window: { since: sinceDate.toISOString(), until: untilDate.toISOString(), totalRuns },
    counts: {
      gatesTracked: gates.length,
      overBudgetCritical: gates.filter((g) => g.status === 'over-budget-critical').length,
      overBudgetWarning: gates.filter((g) => g.status === 'over-budget-warning').length,
      withinBudget: gates.filter((g) => g.status === 'within-budget').length,
      noSlo: gates.filter((g) => g.status === 'no-slo').length,
    },
    gates,
    generatedAt: new Date().toISOString(),
  };
}

function report({ cwd, since, until, format = 'md' } = {}) {
  const s = summary({ cwd, since, until });
  if (format === 'json') return JSON.stringify(s, null, 2);
  const lines = [
    '# Gate SLO Report',
    '',
    `**Window:** ${s.window.since} → ${s.window.until}`,
    `**Pipeline runs:** ${s.window.totalRuns}`,
    `**Generated:** ${s.generatedAt}`,
    '',
    '## Summary',
    '',
    `- 🔴 Over budget (critical): **${s.counts.overBudgetCritical}**`,
    `- 🟡 Over budget (warning): **${s.counts.overBudgetWarning}**`,
    `- 🟢 Within budget: **${s.counts.withinBudget}**`,
    '',
    '## Gates',
    '',
    '| Gate | Tier | Fired | Rate | SLO | Burn | Status |',
    '|------|------|-------|------|-----|------|--------|',
  ];
  for (const g of s.gates) {
    if (g.fired === 0 && g.status === 'within-budget') continue; // skip silent within-budget gates in MD
    const icon = { 'over-budget-critical': '🔴', 'over-budget-warning': '🟡', 'within-budget': '🟢', 'no-slo': '⚪' }[
      g.status
    ];
    lines.push(
      `| ${g.id} | T${g.tier} | ${g.fired} (${g.blocks}b/${g.bypasses}x) | ${(g.fireRate * 100).toFixed(2)}% | ${(g.slo.targetFireRate * 100).toFixed(2)}% | ${g.burnRate ?? 'n/a'} | ${icon} ${g.status} |`,
    );
  }
  lines.push('');
  lines.push('Burn = fireRate / targetFireRate. >1 means above SLO.');
  lines.push('');
  lines.push('*Made by CoBolt — Autonomous Development Platform*');
  return lines.join('\n');
}

function write({ cwd, since, until } = {}) {
  const root = cwd ? path.resolve(cwd) : process.cwd();
  const s = summary({ cwd: root, since, until });
  const auditDir = path.join(root, '_cobolt-output', 'audit');
  fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  const jsonPath = path.join(auditDir, 'gate-slo.json');
  const mdPath = path.join(auditDir, 'gate-slo.md');
  fs.writeFileSync(jsonPath, `${JSON.stringify(s, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(mdPath, `${report({ cwd: root, since, until, format: 'md' })}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });

  // Append to evidence ledger.
  let ledgerEntryId = null;
  try {
    const evLedger = require('../lib/cobolt-evidence-ledger');
    const entry = evLedger.append(
      {
        kind: evLedger.KINDS.CHECK_RESULT,
        producer: 'cobolt-gate-slo/v0.63.0',
        controlIds: ['ISO.27001.A.8.16', 'SOC2.CC7.2', 'NIST.800-53.CA-7'],
        payload: {
          window: s.window,
          counts: s.counts,
          overBudget: s.gates
            .filter((g) => g.status.startsWith('over-budget'))
            .map((g) => ({ id: g.id, tier: g.tier, fireRate: g.fireRate, status: g.status })),
        },
      },
      { projectRoot: root },
    );
    ledgerEntryId = entry.entryId;
  } catch {
    // Tier 3 advisory.
  }
  return { jsonPath, mdPath, summary: s, ledgerEntryId };
}

module.exports = { summary, report, write };

// ── CLI ──────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log('Usage: node tools/cobolt-gate-slo.js <command> [args]');
    console.log('Commands:');
    console.log('  summary [--since 30d] [--json]            Compute per-gate fire-rates vs SLO');
    console.log('  report  [--since 30d] [--format md|json]  Human-readable report');
    console.log('  write   [--since 30d]                     Persist json+md to audit dir');
    process.exit(0);
  }
  try {
    const opts = {};
    let json = false;
    let format = 'md';
    for (let i = 1; i < argv.length; i += 1) {
      if (argv[i] === '--since') opts.since = argv[++i];
      else if (argv[i] === '--until') opts.until = argv[++i];
      else if (argv[i] === '--cwd') opts.cwd = argv[++i];
      else if (argv[i] === '--json') json = true;
      else if (argv[i] === '--format') format = argv[++i];
    }
    if (cmd === 'summary') {
      const s = summary(opts);
      console.log(json ? JSON.stringify(s, null, 2) : report({ ...opts, format: 'md' }));
      process.exit(0);
    }
    if (cmd === 'report') {
      console.log(report({ ...opts, format }));
      process.exit(0);
    }
    if (cmd === 'write') {
      const r = write(opts);
      console.log(`[cobolt-gate-slo] JSON: ${r.jsonPath}`);
      console.log(`[cobolt-gate-slo] MD:   ${r.mdPath}`);
      console.log(
        `[cobolt-gate-slo] Status: ${r.summary.counts.overBudgetCritical} critical, ${r.summary.counts.overBudgetWarning} warning, ${r.summary.counts.withinBudget} within budget`,
      );
      if (r.ledgerEntryId) console.log(`[cobolt-gate-slo] Ledger: ${r.ledgerEntryId}`);
      process.exit(0);
    }
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
  } catch (err) {
    console.error(`[cobolt-gate-slo] ${err.message}`);
    process.exit(1);
  }
}
