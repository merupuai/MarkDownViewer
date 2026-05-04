#!/usr/bin/env node

// CoBolt Agent-Output Replay Harness (P1.5 / v0.61+).
//
// Captures every agent dispatch (prompt + output digests + truncated
// content) into an append-only JSONL audit log so we can:
//   1. Replay a past dispatch against the current model and diff outputs
//      (detects model drift — Phase 3.6's foundation).
//   2. Investigate a fabricated/hallucinated agent claim post-hoc.
//   3. Generate compliance evidence for AI governance audits
//      (NIST AI RMF MEASURE.2.5, MEASURE.2.7; OWASP LLM-09 Misinformation).
//
// Storage: _cobolt-output/audit/agent-replay.jsonl (mode 0o600).
// Retention: 90 days default; controlled by `purge --older-than`.
// Truncation: prompt/output truncated to 500-char head + 500-char tail; full
//             content available only via SHA-256 digest correlation against
//             the agent's working files at dispatch time.
//
// Public API:
//   capture(record, { projectRoot? }) -> entry
//   list({ projectRoot?, agent?, model?, since?, dispatchId? }) -> entries
//   diff(dispatchIdA, dispatchIdB, { projectRoot? }) -> { promptIdentical, outputIdentical, similarity }
//   purge({ projectRoot?, olderThanDays? }) -> { kept, purged }
//   summarise({ projectRoot?, since? }) -> { dispatches, byAgent, byModel }
//
// CLI:
//   node tools/cobolt-agent-replay.js capture <jsonFile>
//   node tools/cobolt-agent-replay.js list [--agent X] [--model Y] [--since DATE]
//   node tools/cobolt-agent-replay.js summary [--since DATE] [--json]
//   node tools/cobolt-agent-replay.js purge --older-than 90d
//   node tools/cobolt-agent-replay.js drift-report [--threshold 0.85]
//
// Exit codes per tools/CLAUDE.md:
//   0 — success
//   1 — hard error
//   2 — missing optional dep (e.g. semantic-similarity model when added)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LEDGER_REL = path.join('_cobolt-output', 'audit', 'agent-replay.jsonl');
const TRUNCATE_HEAD = 500;
const TRUNCATE_TAIL = 500;
const DEFAULT_RETENTION_DAYS = 90;
const STORAGE_BUDGET_MB = 100;

function _ledgerPath(projectRoot) {
  return path.join(projectRoot || process.cwd(), LEDGER_REL);
}

function _ensureAuditDir(projectRoot) {
  fs.mkdirSync(path.dirname(_ledgerPath(projectRoot)), { recursive: true, mode: 0o700 });
}

function _truncate(text) {
  if (typeof text !== 'string') return '';
  if (text.length <= TRUNCATE_HEAD + TRUNCATE_TAIL) return text;
  return `${text.slice(0, TRUNCATE_HEAD)}\n…[truncated ${text.length - TRUNCATE_HEAD - TRUNCATE_TAIL} chars]…\n${text.slice(-TRUNCATE_TAIL)}`;
}

function _sha256(text) {
  return crypto
    .createHash('sha256')
    .update(String(text || ''))
    .digest('hex');
}

function _appendLine(projectRoot, entry) {
  _ensureAuditDir(projectRoot);
  fs.appendFileSync(_ledgerPath(projectRoot), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

function _readEntries(projectRoot) {
  const file = _ledgerPath(projectRoot);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
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

// ── public API ────────────────────────────────────────────────────────

function capture(record, { projectRoot } = {}) {
  if (!record || typeof record !== 'object') throw new Error('capture: record required');
  if (!record.dispatchId) throw new Error('capture: dispatchId required');
  if (!record.agent) throw new Error('capture: agent required');
  const root = projectRoot || process.cwd();
  const entry = {
    dispatchId: String(record.dispatchId),
    agent: String(record.agent),
    model: record.model || null,
    promptSha256: _sha256(record.prompt || ''),
    promptTruncated: _truncate(record.prompt),
    outputSha256: _sha256(record.output || ''),
    outputTruncated: _truncate(record.output),
    success: record.success !== false,
    ts: record.ts || new Date().toISOString(),
    controlIds: ['NIST.AI.RMF.MEASURE.2.5', 'NIST.AI.RMF.MEASURE.2.7'],
    durationMs: typeof record.durationMs === 'number' ? record.durationMs : null,
  };
  if (record.tags) entry.tags = record.tags;
  if (record.dispatchedBy) entry.dispatchedBy = record.dispatchedBy;
  _appendLine(root, entry);
  return entry;
}

function list({ projectRoot, agent, model, since, dispatchId } = {}) {
  const entries = _readEntries(projectRoot);
  const sinceTs = since ? new Date(since).getTime() : null;
  return entries.filter((e) => {
    if (agent && e.agent !== agent) return false;
    if (model && e.model !== model) return false;
    if (dispatchId && e.dispatchId !== dispatchId) return false;
    if (sinceTs && new Date(e.ts).getTime() < sinceTs) return false;
    return true;
  });
}

function getByDispatchId(dispatchId, options = {}) {
  return list({ ...options, dispatchId });
}

function summarise({ projectRoot, since } = {}) {
  const entries = list({ projectRoot, since });
  const byAgent = {};
  const byModel = {};
  let success = 0;
  let failure = 0;
  for (const e of entries) {
    byAgent[e.agent] = (byAgent[e.agent] || 0) + 1;
    if (e.model) byModel[e.model] = (byModel[e.model] || 0) + 1;
    if (e.success) success += 1;
    else failure += 1;
  }
  return {
    dispatches: entries.length,
    success,
    failure,
    successRate: entries.length === 0 ? null : Math.round((1000 * success) / entries.length) / 1000,
    byAgent,
    byModel,
  };
}

function diff(idA, idB, { projectRoot } = {}) {
  const a = getByDispatchId(idA, { projectRoot })[0];
  const b = getByDispatchId(idB, { projectRoot })[0];
  if (!a) throw new Error(`diff: dispatchId not found: ${idA}`);
  if (!b) throw new Error(`diff: dispatchId not found: ${idB}`);
  const promptIdentical = a.promptSha256 === b.promptSha256;
  const outputIdentical = a.outputSha256 === b.outputSha256;
  // Cheap text-similarity (Jaccard over token sets) on truncated views.
  // Phase 3.6 may upgrade this to BERTScore; for now Jaccard is enough to
  // distinguish "rewording drift" from "structural drift".
  const tokensA = new Set(
    String(a.outputTruncated || '')
      .toLowerCase()
      .match(/[a-z0-9]+/g) || [],
  );
  const tokensB = new Set(
    String(b.outputTruncated || '')
      .toLowerCase()
      .match(/[a-z0-9]+/g) || [],
  );
  const inter = [...tokensA].filter((t) => tokensB.has(t)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  const similarity = union === 0 ? 1 : inter / union;
  return {
    a: { dispatchId: a.dispatchId, ts: a.ts, model: a.model },
    b: { dispatchId: b.dispatchId, ts: b.ts, model: b.model },
    promptIdentical,
    outputIdentical,
    similarity,
  };
}

function driftReport({ projectRoot, threshold = 0.85, since } = {}) {
  const entries = list({ projectRoot, since });
  // Group by promptSha256: each prompt that has been dispatched multiple
  // times under different models is a candidate for drift detection.
  const byPrompt = new Map();
  for (const e of entries) {
    if (!byPrompt.has(e.promptSha256)) byPrompt.set(e.promptSha256, []);
    byPrompt.get(e.promptSha256).push(e);
  }
  const drifts = [];
  for (const group of byPrompt.values()) {
    if (group.length < 2) continue;
    // Compare each pair within the group.
    for (let i = 0; i < group.length - 1; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i];
        const b = group[j];
        if (a.outputSha256 === b.outputSha256) continue; // identical — no drift
        const tokensA = new Set(
          String(a.outputTruncated || '')
            .toLowerCase()
            .match(/[a-z0-9]+/g) || [],
        );
        const tokensB = new Set(
          String(b.outputTruncated || '')
            .toLowerCase()
            .match(/[a-z0-9]+/g) || [],
        );
        const inter = [...tokensA].filter((t) => tokensB.has(t)).length;
        const union = new Set([...tokensA, ...tokensB]).size;
        const similarity = union === 0 ? 1 : inter / union;
        if (similarity < threshold) {
          drifts.push({
            promptSha256: a.promptSha256,
            a: { dispatchId: a.dispatchId, ts: a.ts, model: a.model },
            b: { dispatchId: b.dispatchId, ts: b.ts, model: b.model },
            similarity: Math.round(similarity * 10000) / 10000,
          });
        }
      }
    }
  }
  drifts.sort((x, y) => x.similarity - y.similarity);
  return { threshold, totalGroups: byPrompt.size, drifts };
}

function purge({ projectRoot, olderThanDays = DEFAULT_RETENTION_DAYS } = {}) {
  const file = _ledgerPath(projectRoot);
  if (!fs.existsSync(file)) return { kept: 0, purged: 0 };
  const cutoff = Date.now() - olderThanDays * 24 * 3600 * 1000;
  const entries = _readEntries(projectRoot);
  const kept = entries.filter((e) => new Date(e.ts).getTime() >= cutoff);
  const purged = entries.length - kept.length;
  if (purged > 0) {
    const newContent = kept.map((e) => JSON.stringify(e)).join('\n');
    fs.writeFileSync(file, newContent ? `${newContent}\n` : '', { mode: 0o600 });
  }
  return { kept: kept.length, purged };
}

function storageReport({ projectRoot } = {}) {
  const file = _ledgerPath(projectRoot);
  if (!fs.existsSync(file)) return { sizeBytes: 0, sizeMb: 0, withinBudget: true };
  const stat = fs.statSync(file);
  const sizeMb = Math.round((stat.size / (1024 * 1024)) * 100) / 100;
  return {
    sizeBytes: stat.size,
    sizeMb,
    budgetMb: STORAGE_BUDGET_MB,
    withinBudget: sizeMb <= STORAGE_BUDGET_MB,
  };
}

module.exports = {
  capture,
  list,
  getByDispatchId,
  diff,
  driftReport,
  purge,
  storageReport,
  summarise,
  TRUNCATE_HEAD,
  TRUNCATE_TAIL,
  DEFAULT_RETENTION_DAYS,
};

// ── CLI ──────────────────────────────────────────────────────────────

function _printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log('Usage: node tools/cobolt-agent-replay.js <command> [args]');
    console.log('Commands:');
    console.log('  capture <jsonFile>                  Capture a dispatch from JSON');
    console.log('  list [--agent X] [--model Y] [--since DATE] [--json]');
    console.log('  summary [--since DATE] [--json]     Aggregate stats');
    console.log('  diff <idA> <idB> [--json]           Compare two dispatches');
    console.log('  drift-report [--threshold 0.85] [--json]  Cross-prompt drift detection');
    console.log('  purge --older-than 90d              Drop entries older than N days');
    console.log('  storage [--json]                    Storage size + budget status');
    process.exit(0);
  }
  try {
    if (cmd === 'capture') {
      if (!argv[1]) {
        console.error('Usage: capture <jsonFile>');
        process.exit(1);
      }
      const record = JSON.parse(fs.readFileSync(argv[1], 'utf8'));
      const entry = capture(record);
      _printJson({ ok: true, dispatchId: entry.dispatchId });
      process.exit(0);
    }
    if (cmd === 'list' || cmd === 'summary') {
      const opts = {};
      let json = false;
      for (let i = 1; i < argv.length; i += 1) {
        if (argv[i] === '--agent') opts.agent = argv[++i];
        else if (argv[i] === '--model') opts.model = argv[++i];
        else if (argv[i] === '--since') opts.since = argv[++i];
        else if (argv[i] === '--json') json = true;
      }
      if (cmd === 'list') {
        const entries = list(opts);
        if (json) _printJson(entries);
        else for (const e of entries) console.log(`[${e.ts}] ${e.dispatchId}\t${e.agent}\t${e.model || '?'}`);
      } else {
        _printJson(summarise(opts));
      }
      process.exit(0);
    }
    if (cmd === 'diff') {
      if (!argv[1] || !argv[2]) {
        console.error('Usage: diff <idA> <idB>');
        process.exit(1);
      }
      _printJson(diff(argv[1], argv[2]));
      process.exit(0);
    }
    if (cmd === 'drift-report') {
      let threshold = 0.85;
      let since = null;
      for (let i = 1; i < argv.length; i += 1) {
        if (argv[i] === '--threshold') threshold = Number(argv[++i]);
        else if (argv[i] === '--since') since = argv[++i];
      }
      _printJson(driftReport({ threshold, since }));
      process.exit(0);
    }
    if (cmd === 'purge') {
      let olderThanDays = DEFAULT_RETENTION_DAYS;
      for (let i = 1; i < argv.length; i += 1) {
        if (argv[i] === '--older-than') {
          const m = String(argv[++i]).match(/^(\d+)d?$/);
          if (m) olderThanDays = Number(m[1]);
        }
      }
      _printJson(purge({ olderThanDays }));
      process.exit(0);
    }
    if (cmd === 'storage') {
      _printJson(storageReport({}));
      process.exit(0);
    }
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
  } catch (err) {
    console.error(`[cobolt-agent-replay] ${err.message}`);
    process.exit(1);
  }
}
