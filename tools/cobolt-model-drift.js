#!/usr/bin/env node

// CoBolt Model-Drift Detector (P3.6 / v0.63+).
//
// Reads the agent-replay log produced by tools/cobolt-agent-replay.js
// (P1.5 Inv-24) and detects drift in agent outputs over time. Two flavours:
//
//   1. Cross-model drift — same prompt was dispatched to multiple models;
//      output similarity below threshold suggests provider behaviour change.
//   2. Cross-time drift — same prompt dispatched repeatedly to the same
//      model over time; similarity decay suggests upstream model upgrades
//      (Anthropic publishes minor updates without bumping version IDs).
//
// Similarity scoring:
//   v0.63 ships Jaccard token-set similarity (cheap, deterministic, no
//   external deps). Phase 4 will upgrade to BERTScore for semantic-aware
//   comparisons; the API surface is stable so the upgrade is transparent.
//
// Tier 3 advisory — surfaces alerts to
// _cobolt-output/audit/model-drift-alerts.jsonl. Does NOT auto-quarantine
// or block; drift may be intentional (a deliberate model upgrade).
//
// Standards mapping (Inv-21):
//   NIST AI RMF 1.0 — MEASURE.2.5 (AI risk metrics) and MEASURE.2.7
//                     (security/resilience metrics).
//   OWASP LLM-09 — Misinformation (model output drift can produce
//                  hallucinated content downstream).
//   ISO/IEC 27001 A.8.16 — monitoring activities.
//
// Public API:
//   report({ cwd?, since?, threshold? }) -> { groups, drifts, summary }
//   detectFor({ cwd?, dispatchId, threshold? }) -> { drifts }
//   alertHistory({ cwd?, since? }) -> entries
//   write({ cwd?, since?, threshold? }) -> { jsonPath, mdPath, summary }
//
// CLI:
//   node tools/cobolt-model-drift.js report [--since 30d] [--threshold 0.85]
//   node tools/cobolt-model-drift.js detect <dispatchId> [--threshold 0.85]
//   node tools/cobolt-model-drift.js alerts [--since 30d]
//   node tools/cobolt-model-drift.js write [--since 30d]

const fs = require('node:fs');
const path = require('node:path');

const REPLAY_REL = path.join('_cobolt-output', 'audit', 'agent-replay.jsonl');
const ALERTS_REL = path.join('_cobolt-output', 'audit', 'model-drift-alerts.jsonl');
const DEFAULT_THRESHOLD = 0.85;
const DEFAULT_WINDOW_DAYS = 30;

function _parseDuration(spec) {
  const m = String(spec || '').match(/^(\d+)([dhwm]?)$/);
  if (!m) return DEFAULT_WINDOW_DAYS * 86400 * 1000;
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

function _tokenSet(text) {
  if (!text) return new Set();
  return new Set(
    String(text)
      .toLowerCase()
      .match(/[a-z0-9]+/g) || [],
  );
}

function _jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 1 : inter / union;
}

// ── public API ────────────────────────────────────────────────────────

function report({ cwd, since, threshold = DEFAULT_THRESHOLD } = {}) {
  const root = cwd || process.cwd();
  const replays = _readJsonl(path.join(root, REPLAY_REL));
  const sinceMs = _parseDuration(since);
  const sinceTs = since ? Date.now() - sinceMs : 0;
  const filtered = replays.filter((r) => new Date(r.ts).getTime() >= sinceTs);

  // Group by promptSha256 — identical prompts are the natural drift unit.
  const byPrompt = new Map();
  for (const r of filtered) {
    if (!r.promptSha256) continue;
    if (!byPrompt.has(r.promptSha256)) byPrompt.set(r.promptSha256, []);
    byPrompt.get(r.promptSha256).push(r);
  }

  const drifts = [];
  let driftPairs = 0;
  let comparedPairs = 0;
  for (const [promptSha, group] of byPrompt) {
    if (group.length < 2) continue;
    // Compare each pair within the group; cap at 50 pairs per group to
    // avoid quadratic blowup on hot prompts.
    const sortedByTs = group.slice().sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    const pairsForGroup = [];
    for (let i = 0; i < sortedByTs.length - 1; i += 1) {
      for (let j = i + 1; j < sortedByTs.length; j += 1) {
        if (pairsForGroup.length >= 50) break;
        const a = sortedByTs[i];
        const b = sortedByTs[j];
        comparedPairs += 1;
        if (a.outputSha256 === b.outputSha256) continue; // identical
        const sim = _jaccard(_tokenSet(a.outputTruncated), _tokenSet(b.outputTruncated));
        if (sim < threshold) {
          driftPairs += 1;
          drifts.push({
            promptSha256: promptSha,
            agent: a.agent,
            a: { dispatchId: a.dispatchId, ts: a.ts, model: a.model, outputSha: a.outputSha256?.slice(0, 12) },
            b: { dispatchId: b.dispatchId, ts: b.ts, model: b.model, outputSha: b.outputSha256?.slice(0, 12) },
            similarity: Math.round(sim * 10000) / 10000,
            crossModel: a.model !== b.model,
            crossTimeMs: new Date(b.ts).getTime() - new Date(a.ts).getTime(),
          });
          pairsForGroup.push({ a, b, sim });
        }
      }
    }
  }

  // Worst drifts first.
  drifts.sort((a, b) => a.similarity - b.similarity);

  return {
    window: {
      since: sinceTs > 0 ? new Date(sinceTs).toISOString() : null,
      until: new Date().toISOString(),
    },
    threshold,
    summary: {
      replays: filtered.length,
      uniquePrompts: byPrompt.size,
      comparedPairs,
      driftPairs,
      crossModelDrifts: drifts.filter((d) => d.crossModel).length,
      crossTimeDrifts: drifts.filter((d) => !d.crossModel).length,
    },
    drifts,
    generatedAt: new Date().toISOString(),
  };
}

function detectFor({ cwd, dispatchId, threshold = DEFAULT_THRESHOLD } = {}) {
  if (!dispatchId) throw new Error('detectFor: dispatchId required');
  const root = cwd || process.cwd();
  const replays = _readJsonl(path.join(root, REPLAY_REL));
  const target = replays.find((r) => r.dispatchId === dispatchId);
  if (!target) throw new Error(`detectFor: dispatchId not found: ${dispatchId}`);
  const peers = replays.filter((r) => r.dispatchId !== dispatchId && r.promptSha256 === target.promptSha256);
  const drifts = [];
  for (const peer of peers) {
    if (peer.outputSha256 === target.outputSha256) continue;
    const sim = _jaccard(_tokenSet(target.outputTruncated), _tokenSet(peer.outputTruncated));
    if (sim < threshold) {
      drifts.push({
        peerDispatchId: peer.dispatchId,
        peerTs: peer.ts,
        peerModel: peer.model,
        similarity: Math.round(sim * 10000) / 10000,
        crossModel: peer.model !== target.model,
      });
    }
  }
  return { dispatchId, target: { ts: target.ts, model: target.model }, drifts };
}

function alertHistory({ cwd, since } = {}) {
  const root = cwd || process.cwd();
  const sinceMs = _parseDuration(since);
  const sinceTs = since ? Date.now() - sinceMs : 0;
  return _readJsonl(path.join(root, ALERTS_REL)).filter((a) => new Date(a.ts).getTime() >= sinceTs);
}

function write({ cwd, since, threshold = DEFAULT_THRESHOLD } = {}) {
  const root = cwd || process.cwd();
  const r = report({ cwd: root, since, threshold });
  const auditDir = path.join(root, '_cobolt-output', 'audit');
  fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  const jsonPath = path.join(auditDir, 'model-drift-report.json');
  const mdPath = path.join(auditDir, 'model-drift-report.md');
  fs.writeFileSync(jsonPath, `${JSON.stringify(r, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  const lines = [
    '# Model Drift Report',
    '',
    `Threshold: similarity < **${threshold}**`,
    `Window: ${r.window.since || 'all-time'} → ${r.window.until}`,
    `Compared pairs: ${r.summary.comparedPairs}`,
    `Drift pairs: **${r.summary.driftPairs}** (cross-model: ${r.summary.crossModelDrifts}, cross-time: ${r.summary.crossTimeDrifts})`,
    '',
  ];
  if (r.drifts.length === 0) {
    lines.push('_No drift detected at this threshold._');
  } else {
    lines.push('| Agent | A | B | Similarity | Cross-Model | Δt (h) |');
    lines.push('|-------|---|---|------------|-------------|--------|');
    for (const d of r.drifts.slice(0, 20)) {
      lines.push(
        `| ${d.agent || '—'} | \`${d.a.dispatchId}\` (${d.a.model || '?'}) | \`${d.b.dispatchId}\` (${d.b.model || '?'}) | ${d.similarity} | ${d.crossModel ? 'yes' : 'no'} | ${Math.round(d.crossTimeMs / 3600000)} |`,
      );
    }
    if (r.drifts.length > 20) lines.push(`| _… ${r.drifts.length - 20} more …_ |`);
  }
  fs.writeFileSync(mdPath, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });

  // Append per-drift alerts for trend tracking.
  for (const d of r.drifts) {
    fs.appendFileSync(
      path.join(root, ALERTS_REL),
      `${JSON.stringify({
        ts: r.generatedAt,
        promptSha256: d.promptSha256,
        agent: d.agent,
        peerA: d.a.dispatchId,
        peerB: d.b.dispatchId,
        similarity: d.similarity,
        crossModel: d.crossModel,
      })}\n`,
      { mode: 0o600 },
    );
  }

  // Append to evidence ledger.
  let ledgerEntryId = null;
  try {
    const evLedger = require('../lib/cobolt-evidence-ledger');
    const entry = evLedger.append(
      {
        kind: evLedger.KINDS.CHECK_RESULT,
        producer: 'cobolt-model-drift/v0.63.0',
        controlIds: ['NIST.AI.RMF.MEASURE.2.5', 'NIST.AI.RMF.MEASURE.2.7', 'OWASP.LLM.09', 'ISO.27001.A.8.16'],
        payload: {
          threshold,
          window: r.window,
          summary: r.summary,
          worstSimilarity: r.drifts.length > 0 ? r.drifts[0].similarity : null,
        },
      },
      { projectRoot: root },
    );
    ledgerEntryId = entry.entryId;
  } catch {
    // Tier 3 advisory.
  }

  return { jsonPath, mdPath, summary: r.summary, ledgerEntryId };
}

module.exports = {
  report,
  detectFor,
  alertHistory,
  write,
  DEFAULT_THRESHOLD,
  DEFAULT_WINDOW_DAYS,
  // Internals exposed for tests only.
  _internal: { _jaccard, _tokenSet },
};

// ── CLI ──────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log('Usage: node tools/cobolt-model-drift.js <command> [args]');
    console.log('Commands:');
    console.log('  report   [--since 30d] [--threshold 0.85] [--json]');
    console.log('  detect   <dispatchId> [--threshold 0.85]');
    console.log('  alerts   [--since 30d]');
    console.log('  write    [--since 30d] [--threshold 0.85]');
    process.exit(0);
  }
  try {
    const opts = {};
    let json = false;
    for (let i = 1; i < argv.length; i += 1) {
      if (argv[i] === '--since') opts.since = argv[++i];
      else if (argv[i] === '--threshold') opts.threshold = Number(argv[++i]);
      else if (argv[i] === '--cwd') opts.cwd = argv[++i];
      else if (argv[i] === '--json') json = true;
    }
    if (cmd === 'report') {
      const r = report(opts);
      console.log(
        json ? JSON.stringify(r, null, 2) : `Drift pairs: ${r.summary.driftPairs} / ${r.summary.comparedPairs}`,
      );
      process.exit(0);
    }
    if (cmd === 'detect') {
      const id = argv[1];
      if (!id) {
        console.error('Usage: detect <dispatchId>');
        process.exit(1);
      }
      const r = detectFor({ ...opts, dispatchId: id });
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    }
    if (cmd === 'alerts') {
      const a = alertHistory(opts);
      console.log(JSON.stringify(a, null, 2));
      process.exit(0);
    }
    if (cmd === 'write') {
      const r = write(opts);
      console.log(`[cobolt-model-drift] JSON:  ${r.jsonPath}`);
      console.log(`[cobolt-model-drift] MD:    ${r.mdPath}`);
      console.log(`[cobolt-model-drift] Pairs: ${r.summary.driftPairs} drift / ${r.summary.comparedPairs} compared`);
      if (r.ledgerEntryId) console.log(`[cobolt-model-drift] Ledger: ${r.ledgerEntryId}`);
      process.exit(0);
    }
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
  } catch (err) {
    console.error(`[cobolt-model-drift] ${err.message}`);
    process.exit(1);
  }
}
