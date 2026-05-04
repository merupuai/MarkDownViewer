#!/usr/bin/env node
// cobolt-recovery-stats — aggregate escalation, failure, and debt telemetry
// into a rollup that operators and maintainers can use to spot patterns.
//
// Every halt/debt/escalation event leaves durable evidence on disk. Nothing
// aggregates those signals across runs. This tool fills that gap — it is
// read-only, it never mutates state, and it is safe to run at any time.
//
// Usage:
//   node tools/cobolt-recovery-stats.js                # human-readable rollup
//   node tools/cobolt-recovery-stats.js --json         # machine-readable envelope
//   node tools/cobolt-recovery-stats.js --since 7d     # filter to last 7 days
//   node tools/cobolt-recovery-stats.js --per-agent    # group by failing agent
//   node tools/cobolt-recovery-stats.js --per-pipeline # group by pipeline
//
// Exit codes:
//   0 — always. This is a read-only inspector and exits 0 even when there
//       are zero events to aggregate.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const AUDIT_DIR = path.join(ROOT, '_cobolt-output', 'audit');

const FAILURE_LEDGERS = [
  'planning-agent-failures.jsonl',
  'build-agent-failures.jsonl',
  'fix-agent-failures.jsonl',
  'brownfield-agent-failures.jsonl',
  'architecture-agent-failures.jsonl',
  'review-reviewer-failures.jsonl',
];

const ESCALATION_LOG = path.join(AUDIT_DIR, 'escalation-log.jsonl');
const DEBT_LEDGER = path.join(AUDIT_DIR, 'planning-debt.jsonl');
const GATE_SKIP_LOG = path.join(AUDIT_DIR, 'gate-skip-log.jsonl');
const DISPATCH_LEDGER = path.join(AUDIT_DIR, 'agent-dispatch-ledger.jsonl');

function parseSince(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d+)([dhm])$/);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2];
  const ms = unit === 'd' ? n * 86400000 : unit === 'h' ? n * 3600000 : n * 60000;
  return new Date(Date.now() - ms);
}

function readJsonLines(filePath, sinceDate) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const entries = raw
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
    if (!sinceDate) return entries;
    return entries.filter((e) => {
      const ts = e.ts || e.timestamp || e.recordedAt || e.at;
      if (!ts) return true;
      const d = new Date(ts);
      return !Number.isNaN(d.getTime()) && d >= sinceDate;
    });
  } catch {
    return [];
  }
}

function tallyByKey(entries, keyFn) {
  const tally = new Map();
  for (const entry of entries) {
    const key = keyFn(entry) || 'unknown';
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  return [...tally.entries()].sort((a, b) => b[1] - a[1]);
}

function collectFailures(sinceDate) {
  const all = [];
  for (const ledger of FAILURE_LEDGERS) {
    const entries = readJsonLines(path.join(AUDIT_DIR, ledger), sinceDate);
    const pipeline = ledger.replace(/-agent-failures\.jsonl$/, '').replace(/-reviewer-failures\.jsonl$/, '-review');
    for (const entry of entries) {
      all.push({ ...entry, _pipeline: pipeline, _source: ledger });
    }
  }
  return all;
}

function buildEnvelope(options) {
  const sinceDate = parseSince(options.since);
  const failures = collectFailures(sinceDate);
  const escalations = readJsonLines(ESCALATION_LOG, sinceDate);
  const debtEntries = readJsonLines(DEBT_LEDGER, sinceDate);
  const gateSkips = readJsonLines(GATE_SKIP_LOG, sinceDate);
  const dispatches = readJsonLines(DISPATCH_LEDGER, sinceDate);

  const unresolvedDebt = debtEntries.filter((e) => !e.resolved);
  const haltEvents = escalations.filter((e) => e.action === 'human-halt');

  const byAgent = tallyByKey(failures, (e) => e.agent);
  const byErrorClass = tallyByKey(failures, (e) => e.error_class);
  const byEscalationTarget = tallyByKey(failures, (e) => e.escalation_target);
  const byPipeline = tallyByKey(failures, (e) => e._pipeline);
  const gateSkipsByGate = tallyByKey(gateSkips, (e) => e.gate || e.hook);
  const advisorVerdicts = tallyByKey(
    escalations.filter((e) => e.advisor_verdict),
    (e) => e.advisor_verdict,
  );

  const topHaltedArtifacts = tallyByKey(haltEvents, (e) => e.artifact).slice(0, 10);
  const oldestUnresolvedDebt = unresolvedDebt
    .slice()
    .sort((a, b) => {
      const aT = Date.parse(a.recordedAt || 0) || 0;
      const bT = Date.parse(b.recordedAt || 0) || 0;
      return aT - bT;
    })
    .slice(0, 5);

  return {
    since: sinceDate ? sinceDate.toISOString() : 'all-time',
    generatedAt: new Date().toISOString(),
    totals: {
      failures: failures.length,
      escalations: escalations.length,
      humanHalts: haltEvents.length,
      unresolvedDebt: unresolvedDebt.length,
      resolvedDebt: debtEntries.filter((e) => e.resolved).length,
      gateSkips: gateSkips.length,
      dispatches: dispatches.length,
    },
    topFailingAgents: byAgent.slice(0, 10),
    byErrorClass: byErrorClass.slice(0, 10),
    byEscalationTarget,
    byPipeline,
    gateSkipsByGate: gateSkipsByGate.slice(0, 10),
    advisorVerdicts,
    topHaltedArtifacts,
    oldestUnresolvedDebt: oldestUnresolvedDebt.map((e) => ({
      artifact: e.artifact,
      recordedAt: e.recordedAt,
      failureClass: e.failureClass,
    })),
  };
}

function renderTable(rows, _labels, indent = '  ') {
  if (rows.length === 0) return `${indent}(none)\n`;
  const maxLen = Math.max(...rows.map(([k]) => String(k).length));
  return rows
    .map(([k, v]) => `${indent}${String(k).padEnd(maxLen + 2)} ${String(v).padStart(6)}`)
    .concat([''])
    .join('\n');
}

function renderHuman(envelope) {
  const lines = [];
  lines.push('');
  lines.push(`CoBolt Recovery Stats — ${envelope.since === 'all-time' ? 'all-time' : `since ${envelope.since}`}`);
  lines.push('='.repeat(60));
  lines.push('');
  lines.push('TOTALS');
  lines.push('-'.repeat(60));
  lines.push(`  Agent failures:     ${envelope.totals.failures}`);
  lines.push(`  Escalations:        ${envelope.totals.escalations}`);
  lines.push(`  Human halts:        ${envelope.totals.humanHalts}`);
  lines.push(`  Unresolved debt:    ${envelope.totals.unresolvedDebt}`);
  lines.push(`  Resolved debt:      ${envelope.totals.resolvedDebt}`);
  lines.push(`  Gate skips:         ${envelope.totals.gateSkips}`);
  lines.push(`  Agent dispatches:   ${envelope.totals.dispatches}`);
  lines.push('');

  if (envelope.topFailingAgents.length > 0) {
    lines.push('TOP FAILING AGENTS');
    lines.push('-'.repeat(60));
    lines.push(renderTable(envelope.topFailingAgents));
  }

  if (envelope.byErrorClass.length > 0) {
    lines.push('BY ERROR CLASS');
    lines.push('-'.repeat(60));
    lines.push(renderTable(envelope.byErrorClass));
  }

  if (envelope.byEscalationTarget.length > 0) {
    lines.push('BY ESCALATION TARGET');
    lines.push('-'.repeat(60));
    lines.push(renderTable(envelope.byEscalationTarget));
  }

  if (envelope.byPipeline.length > 0) {
    lines.push('BY PIPELINE');
    lines.push('-'.repeat(60));
    lines.push(renderTable(envelope.byPipeline));
  }

  if (envelope.advisorVerdicts.length > 0) {
    lines.push('ADVISOR VERDICTS');
    lines.push('-'.repeat(60));
    lines.push(renderTable(envelope.advisorVerdicts));
  }

  if (envelope.gateSkipsByGate.length > 0) {
    lines.push('TOP GATE EVENTS');
    lines.push('-'.repeat(60));
    lines.push(renderTable(envelope.gateSkipsByGate));
  }

  if (envelope.topHaltedArtifacts.length > 0) {
    lines.push('TOP HALTED ARTIFACTS');
    lines.push('-'.repeat(60));
    lines.push(renderTable(envelope.topHaltedArtifacts));
  }

  if (envelope.oldestUnresolvedDebt.length > 0) {
    lines.push('OLDEST UNRESOLVED DEBT');
    lines.push('-'.repeat(60));
    for (const d of envelope.oldestUnresolvedDebt) {
      lines.push(`  ${d.recordedAt || '(no ts)'}  ${d.artifact}  (${d.failureClass || 'unknown'})`);
    }
    lines.push('');
  }

  lines.push('INSIGHTS');
  lines.push('-'.repeat(60));
  lines.push(insights(envelope));
  lines.push('');
  lines.push('See docs/ESCALATION-FLOW.md for the escalation protocol and');
  lines.push('docs/PLANNING-RECOVERY.md for operator recovery guidance.');
  lines.push('');
  return lines.join('\n');
}

function insights(envelope) {
  const notes = [];
  const t = envelope.totals;

  if (t.failures === 0 && t.escalations === 0 && t.unresolvedDebt === 0 && t.humanHalts === 0) {
    notes.push('  No failure events in window. Pipeline is clean.');
    return notes.join('\n');
  }

  if (t.humanHalts > 0) {
    notes.push(
      `  ${t.humanHalts} human halt${t.humanHalts === 1 ? '' : 's'} recorded. Use /cobolt-unblock to convert to tracked debt.`,
    );
  }
  if (t.unresolvedDebt > 0) {
    notes.push(
      `  ${t.unresolvedDebt} unresolved debt ${t.unresolvedDebt === 1 ? 'entry' : 'entries'} will block release until cleared.`,
    );
  }
  if (t.dispatches > 0) {
    const failureRate = ((t.failures / t.dispatches) * 100).toFixed(1);
    notes.push(`  Failure rate: ${failureRate}% (${t.failures} failures / ${t.dispatches} dispatches)`);
  }
  if (envelope.topFailingAgents.length > 0 && envelope.topFailingAgents[0][1] >= 3) {
    const [agent, count] = envelope.topFailingAgents[0];
    notes.push(`  Agent "${agent}" has ${count} failures — candidate for prompt tuning or task re-scoping.`);
  }
  if (envelope.advisorVerdicts.length > 0) {
    const skipWithDebt = envelope.advisorVerdicts.find(([v]) => v === 'skip-with-debt');
    if (skipWithDebt && skipWithDebt[1] >= 3) {
      notes.push(
        `  Advisor returned skip-with-debt ${skipWithDebt[1]} times — upstream source material may be ambiguous or incomplete.`,
      );
    }
  }

  return notes.length > 0 ? notes.join('\n') : '  No actionable patterns detected.';
}

function main() {
  const argv = process.argv.slice(2);
  const jsonOut = argv.includes('--json');
  const sinceIdx = argv.indexOf('--since');
  const since = sinceIdx !== -1 ? argv[sinceIdx + 1] : null;

  const envelope = buildEnvelope({ since });

  if (jsonOut) {
    console.log(JSON.stringify(envelope, null, 2));
  } else {
    process.stdout.write(renderHuman(envelope));
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = { buildEnvelope, parseSince, insights };
