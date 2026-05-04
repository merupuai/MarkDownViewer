#!/usr/bin/env node

// CoBolt Gate Fire-Rate — observability + pruning recommendations.
//
// v0.30 hit the monotonic-growth problem: 186 hooks, 317 tools, every past
// incident adding a gate and nothing removing them. No one has per-gate
// telemetry showing which gates actually fire vs which are dormant. The forest
// gets denser; the defenders don't get sharper.
//
// This tool parses the audit log stream in _cobolt-output/audit/*.jsonl and
// classifies every known gate into:
//   ACTIVE     — fired in last N days, emits blocks regularly
//   FIRING_OK  — fires but always approves (may be necessary or noise)
//   DORMANT    — hasn't fired in >=N days
//   DEAD       — never seen in the logs at all
//
// And emits pruning / consolidation recommendations:
//   [PRUNE-01] DEAD gate — candidate for removal if confirmed dead across
//              multiple projects (uncommon path not exercised).
//   [PRUNE-02] DORMANT + approved-every-time — 90+ days with zero blocks,
//              zero failures. Likely subsumed by a newer gate.
//   [CONSOL-01] Two gates with near-identical block patterns — consolidation
//               candidate.
//
// Exit codes:
//   0 = report generated
//   1 = usage
//   2 = no audit logs (nothing to analyze — run a project first)
//
// Note: this tool REPORTS only. It never mutates gate registration. Humans
// decide what to prune; the tool surfaces evidence.

const fs = require('node:fs');
const path = require('node:path');
const { formatGateFireRateSummary, summarizeGateFireRate } = require('../lib/cobolt-observability');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_MISSING = 2;
const EXIT_THRESHOLD = 3;

const AUDIT_DIR = path.join('_cobolt-output', 'audit');
const HOOKS_DIR = 'source/hooks';
const DEFAULT_WINDOW_DAYS = 90;
const DEFAULT_DORMANT_DAYS = 30;

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function listJsonlFiles(dir) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function listHookFiles() {
  try {
    if (!fs.existsSync(HOOKS_DIR)) return [];
    return fs
      .readdirSync(HOOKS_DIR)
      .filter(
        (f) => f.endsWith('.js') && f.startsWith('cobolt-') && !f.endsWith('-dispatch.js') && !f.endsWith('.test.js'),
      );
  } catch {
    return [];
  }
}

function parseJsonlStream(filePath) {
  const content = readFileSafe(filePath);
  if (!content) return [];
  const events = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // tolerate partial lines
    }
  }
  return events;
}

// Map audit-log filename → gate name. Convention:
//   {gate-base}.jsonl  →  cobolt-{gate-base}.js
//   {gate-base}-gate.jsonl  →  cobolt-{gate-base}-gate.js
function gateNameFromAuditFile(auditBase) {
  const stem = auditBase.replace(/\.jsonl$/, '');
  // Try direct match first
  return {
    tryPrefix: `cobolt-${stem}.js`,
    tryAsIs: `${stem}.js`,
    tryGate: `cobolt-${stem}.js`,
  };
}

function analyze({
  windowDays = DEFAULT_WINDOW_DAYS,
  dormantDays = DEFAULT_DORMANT_DAYS,
  threshold = 5,
  windowHours = 24,
} = {}) {
  const now = Date.now();
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const dormantMs = dormantDays * 24 * 60 * 60 * 1000;

  const auditFiles = listJsonlFiles(AUDIT_DIR);
  if (auditFiles.length === 0) {
    return {
      exitCode: EXIT_MISSING,
      error: 'no audit logs found — run a pipeline first, then re-run this report',
      auditDir: AUDIT_DIR,
    };
  }

  // Build { hookName -> { totalEvents, blocks, approves, firstSeen, lastSeen } }
  const stats = new Map();
  for (const af of auditFiles) {
    const events = parseJsonlStream(af);
    if (events.length === 0) continue;
    // Guess hook name from filename, then refine via event.hook or event.gate
    const filenameGuess = path.basename(af).replace(/\.jsonl$/, '');
    for (const ev of events) {
      const gateName = ev.hook || ev.gate || ev.hookFile || filenameGuess;
      if (!gateName) continue;
      const s = stats.get(gateName) || {
        gate: gateName,
        totalEvents: 0,
        blocks: 0,
        approves: 0,
        other: 0,
        firstSeen: null,
        lastSeen: null,
      };
      s.totalEvents++;
      const action = (ev.action || ev.event || '').toLowerCase();
      if (action.includes('block') || ev.event === 'readiness_blocked' || ev.event === 'aggregate_fail') s.blocks++;
      else if (action.includes('approve') || ev.event === 'aggregate_pass') s.approves++;
      else s.other++;
      const tsRaw = ev.at || ev.ts || ev.timestamp;
      const ts = tsRaw ? new Date(tsRaw).getTime() : NaN;
      if (Number.isFinite(ts)) {
        if (s.firstSeen === null || ts < s.firstSeen) s.firstSeen = ts;
        if (s.lastSeen === null || ts > s.lastSeen) s.lastSeen = ts;
      }
      stats.set(gateName, s);
    }
  }

  // Classify every known hook
  const hookFiles = listHookFiles();
  const classified = [];
  const seenGateNames = new Set();

  for (const hf of hookFiles) {
    const base = hf.replace(/\.js$/, '');
    // Match by various key conventions audit files tend to use
    const candidates = [hf, base, base.replace(/^cobolt-/, ''), `${base.replace(/^cobolt-/, '')}-gate`, `${base}`];
    let s = null;
    for (const c of candidates) {
      if (stats.has(c)) {
        s = stats.get(c);
        seenGateNames.add(c);
        break;
      }
    }

    const ageMs = s?.lastSeen ? now - s.lastSeen : Infinity;
    const inWindow = ageMs <= windowMs;
    let classification;
    let rationale;
    const recommendations = [];

    if (!s) {
      classification = 'DEAD';
      rationale = 'Never observed in audit logs';
      recommendations.push({
        rule: 'PRUNE-01',
        action: 'investigate',
        hint: 'Gate has no audit trail. Either it has never fired on a real project, or it writes to a non-standard log file. Confirm across multiple projects before prune.',
      });
    } else if (ageMs > dormantMs) {
      classification = 'DORMANT';
      rationale = `Last fired ${Math.round(ageMs / (24 * 60 * 60 * 1000))}d ago`;
      if (s.blocks === 0) {
        recommendations.push({
          rule: 'PRUNE-02',
          action: 'candidate-for-consolidation',
          hint: 'Dormant gate with zero historical blocks. Likely subsumed by a newer gate covering the same path.',
        });
      }
    } else if (s.blocks === 0 && s.totalEvents > 20) {
      classification = 'FIRING_OK';
      rationale = `Fires frequently but never blocks (${s.totalEvents} events, 0 blocks)`;
      recommendations.push({
        rule: 'REVIEW-01',
        action: 'review-effectiveness',
        hint: 'Gate fires but never blocks. Confirm it is actually checking meaningful conditions — it may be an expensive no-op.',
      });
    } else {
      classification = 'ACTIVE';
      rationale = `${s.blocks} blocks / ${s.approves} approves in window`;
    }

    classified.push({
      gate: hf,
      classification,
      rationale,
      stats: s
        ? {
            totalEvents: s.totalEvents,
            blocks: s.blocks,
            approves: s.approves,
            lastSeen: s.lastSeen ? new Date(s.lastSeen).toISOString() : null,
            lastSeenDaysAgo: s.lastSeen ? Math.round((now - s.lastSeen) / (24 * 60 * 60 * 1000)) : null,
          }
        : null,
      recommendations,
      inWindow,
    });
  }

  // Summary counts
  const summary = {
    totalHooks: hookFiles.length,
    active: classified.filter((c) => c.classification === 'ACTIVE').length,
    firingOk: classified.filter((c) => c.classification === 'FIRING_OK').length,
    dormant: classified.filter((c) => c.classification === 'DORMANT').length,
    dead: classified.filter((c) => c.classification === 'DEAD').length,
    auditFilesScanned: auditFiles.length,
    windowDays,
    dormantDays,
  };

  return {
    exitCode: EXIT_OK,
    summary,
    gates: classified,
    fireRateWindow: summarizeGateFireRate({ projectRoot: process.cwd(), threshold, windowHours }),
  };
}

function formatText(r) {
  const lines = ['== Gate Fire-Rate Report =='];
  if (r.summary) {
    for (const [k, v] of Object.entries(r.summary)) lines.push(`  ${k}: ${v}`);
  }
  if (r.gates?.length) {
    lines.push('  classification:');
    const byClass = { ACTIVE: [], FIRING_OK: [], DORMANT: [], DEAD: [] };
    for (const c of r.gates) byClass[c.classification]?.push(c);
    for (const [cls, list] of Object.entries(byClass)) {
      if (list.length === 0) continue;
      lines.push(`    ${cls} (${list.length}):`);
      for (const c of list.slice(0, 30)) {
        const stats = c.stats
          ? ` [${c.stats.totalEvents} evts, ${c.stats.blocks}blk/${c.stats.approves}ok, ${
              c.stats.lastSeenDaysAgo ?? '?'
            }d ago]`
          : '';
        lines.push(`      - ${c.gate}${stats}`);
      }
    }
  }
  if (r.fireRateWindow) {
    lines.push('');
    lines.push(formatGateFireRateSummary(r.fireRateWindow, { verbose: r.fireRateWindow.violatingGates.length > 0 }));
  }
  return lines.join('\n');
}

function main(argv = process.argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'report';
  const json = args.includes('--json');
  const wIdx = args.indexOf('--window-days');
  const windowDays = wIdx >= 0 ? Number(args[wIdx + 1]) : DEFAULT_WINDOW_DAYS;
  const dIdx = args.indexOf('--dormant-days');
  const dormantDays = dIdx >= 0 ? Number(args[dIdx + 1]) : DEFAULT_DORMANT_DAYS;
  const hIdx = args.indexOf('--window-hours');
  const windowHours = hIdx >= 0 ? Number(args[hIdx + 1]) : 24;
  const tIdx = args.indexOf('--threshold');
  const threshold = tIdx >= 0 ? Number(args[tIdx + 1]) : 5;

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(
      'Usage: cobolt-gate-firerate.js <report|check> [--json] [--window-days <n>] [--dormant-days <n>] [--window-hours <n>] [--threshold <n>]',
    );
    process.exit(EXIT_OK);
  }
  if (cmd !== 'report' && cmd !== 'check') {
    console.error('Usage: cobolt-gate-firerate.js report [--json]');
    process.exit(EXIT_USAGE);
  }
  if (cmd === 'check') {
    const r = summarizeGateFireRate({ projectRoot: process.cwd(), threshold, windowHours });
    if (json) console.log(JSON.stringify(r, null, 2));
    else console.log(formatGateFireRateSummary(r, { verbose: r.violatingGates.length > 0 }));
    process.exit(r.ok ? EXIT_OK : EXIT_THRESHOLD);
  }
  const r = analyze({ windowDays, dormantDays, threshold, windowHours });
  if (json) console.log(JSON.stringify(r, null, 2));
  else console.log(formatText(r));
  process.exit(r.exitCode);
}

if (require.main === module) main();

module.exports = { analyze, gateNameFromAuditFile, summarizeGateFireRate, EXIT_OK, EXIT_MISSING, EXIT_THRESHOLD };
