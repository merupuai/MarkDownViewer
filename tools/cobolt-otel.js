#!/usr/bin/env node

// CoBolt OpenTelemetry Tracer (P3.2 / v0.66+).
//
// Records pipeline-stage spans to a local OTLP-format JSONL file. Spans are
// emitted via the `lib/cobolt-otel-context` helpers; this tool provides the
// CLI surface for inspection + the file-emit transport. Consumers can:
//   - Tail _cobolt-output/audit/traces.otlp.jsonl into a Jaeger / Tempo /
//     Honeycomb collector configured for OTLP-JSON file ingest.
//   - Use `cobolt-otel summary` to read the trace tree directly.
//
// Span lifecycle:
//   1. Caller invokes startSpan() / withSpan() from cobolt-otel-context.
//   2. On end(), the span object is passed to emit() in this tool.
//   3. emit() formats per OTLP-JSON spec and appends one line.
//
// OTLP-JSON shape (simplified):
//   { "resourceSpans": [{ "resource": {...}, "scopeSpans": [{ "scope": {...}, "spans": [span] }] }] }
//
// Standards mapping (Inv-21):
//   OpenTelemetry Specification 1.x — span shape + W3C Trace Context.
//   ISO/IEC 27001 A.12.4.1 — event logging.
//   NIST 800-53 AU-2 — audit events.
//   SRE Workbook §9 — distributed tracing.
//
// Public API:
//   emit(span, { cwd? }) -> void
//   listSpans({ cwd?, traceId?, since? }) -> spans[]
//   summary({ cwd?, since? }) -> { traceCount, spanCount, byName, ... }
//   purge({ cwd?, olderThanDays? }) -> { kept, purged }
//
// CLI:
//   node tools/cobolt-otel.js emit <span.json>
//   node tools/cobolt-otel.js list [--trace <traceId>] [--since 30d] [--json]
//   node tools/cobolt-otel.js summary [--since 7d] [--json]
//   node tools/cobolt-otel.js purge --older-than 30d
//
// Exit codes per tools/CLAUDE.md:
//   0 — success
//   1 — hard error (parse / write failure)

const fs = require('node:fs');
const path = require('node:path');
const otelCtx = require('../lib/cobolt-otel-context');

const TRACES_REL = path.join('_cobolt-output', 'audit', 'traces.otlp.jsonl');

function _tracesPath(cwd) {
  return path.join(cwd || process.cwd(), TRACES_REL);
}

function _ensureDir(cwd) {
  fs.mkdirSync(path.dirname(_tracesPath(cwd)), { recursive: true, mode: 0o700 });
}

function _readSpans(cwd) {
  const file = _tracesPath(cwd);
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const env = JSON.parse(line);
      const spans = env.resourceSpans?.[0]?.scopeSpans?.[0]?.spans || [];
      for (const s of spans) out.push(s);
    } catch {
      // Skip malformed lines — never fail the read pass.
    }
  }
  return out;
}

// ── public emit ───────────────────────────────────────────────────────

function emit(span, { cwd } = {}) {
  if (!span?.traceId || !span.spanId || !span.name) {
    throw new Error('emit: span must have traceId, spanId, name');
  }
  const root = cwd || process.cwd();
  _ensureDir(root);
  // Wrap in OTLP-JSON envelope.
  const envelope = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'cobolt' } },
            { key: 'service.version', value: { stringValue: '0.66.0' } },
            { key: 'host.name', value: { stringValue: require('node:os').hostname() } },
            { key: 'process.pid', value: { intValue: String(process.pid) } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'cobolt-pipeline', version: '0.66.0' },
            spans: [_otlpSpan(span)],
          },
        ],
      },
    ],
  };
  fs.appendFileSync(_tracesPath(root), `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
}

function _otlpSpan(s) {
  return {
    traceId: s.traceId,
    spanId: s.spanId,
    parentSpanId: s.parentSpanId || '',
    name: s.name,
    kind: s.kind || 1,
    startTimeUnixNano: s.startTimeUnixNano,
    endTimeUnixNano: s.endTimeUnixNano || s.startTimeUnixNano,
    attributes: Object.entries(s.attributes || {}).map(([k, v]) => ({
      key: k,
      value: _otlpValue(v),
    })),
    status: s.status || { code: 1 },
    events: (s.events || []).map((e) => ({
      timeUnixNano: e.timeUnixNano,
      name: e.name,
      attributes: Object.entries(e.attributes || {}).map(([k, v]) => ({
        key: k,
        value: _otlpValue(v),
      })),
    })),
  };
}

function _otlpValue(v) {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number' && Number.isInteger(v)) return { intValue: String(v) };
  if (typeof v === 'number') return { doubleValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(_otlpValue) } };
  return { stringValue: JSON.stringify(v) };
}

// ── public list / summary ────────────────────────────────────────────

function listSpans({ cwd, traceId, since } = {}) {
  const all = _readSpans(cwd);
  const sinceNs = since ? BigInt(_parseDuration(since)) * 1_000_000n : null;
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  return all.filter((s) => {
    if (traceId && s.traceId !== traceId) return false;
    if (sinceNs !== null) {
      const start = BigInt(s.startTimeUnixNano);
      if (nowNs - start > sinceNs) return false;
    }
    return true;
  });
}

function summary({ cwd, since } = {}) {
  const spans = listSpans({ cwd, since });
  const traceIds = new Set();
  const byName = {};
  let totalDurationNs = 0n;
  let errorSpans = 0;
  for (const s of spans) {
    traceIds.add(s.traceId);
    byName[s.name] = (byName[s.name] || 0) + 1;
    if (s.status?.code === 2) errorSpans += 1;
    if (s.endTimeUnixNano && s.startTimeUnixNano) {
      totalDurationNs += BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano);
    }
  }
  return {
    traceCount: traceIds.size,
    spanCount: spans.length,
    errorSpans,
    byName,
    totalDurationMs: Number(totalDurationNs / 1_000_000n),
    generatedAt: new Date().toISOString(),
  };
}

function purge({ cwd, olderThanDays = 30 } = {}) {
  const file = _tracesPath(cwd);
  if (!fs.existsSync(file)) return { kept: 0, purged: 0 };
  const cutoffNs = BigInt(Date.now() - olderThanDays * 86400 * 1000) * 1_000_000n;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const kept = [];
  for (const line of lines) {
    try {
      const env = JSON.parse(line);
      const span = env.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0];
      if (span?.startTimeUnixNano && BigInt(span.startTimeUnixNano) >= cutoffNs) {
        kept.push(line);
      }
    } catch {
      kept.push(line); // keep unparseable lines on the side of caution
    }
  }
  const purged = lines.length - kept.length;
  if (purged > 0) {
    fs.writeFileSync(file, kept.length > 0 ? `${kept.join('\n')}\n` : '', { mode: 0o600 });
  }
  return { kept: kept.length, purged };
}

function _parseDuration(spec) {
  const m = String(spec || '').match(/^(\d+)([dhwm]?)$/);
  if (!m) return 30 * 86400 * 1000;
  const n = Number(m[1]);
  const unit = m[2] || 'd';
  const ms = unit === 'h' ? 3600 : unit === 'd' ? 86400 : unit === 'w' ? 7 * 86400 : 30 * 86400;
  return n * ms * 1000;
}

module.exports = {
  emit,
  listSpans,
  summary,
  purge,
  // Re-exports from cobolt-otel-context so callers can `require('./cobolt-otel')`
  // and get everything they need.
  startSpan: otelCtx.startSpan,
  withSpan: otelCtx.withSpan,
  newTraceId: otelCtx.newTraceId,
  newSpanId: otelCtx.newSpanId,
  parseTraceparent: otelCtx.parseTraceparent,
  formatTraceparent: otelCtx.formatTraceparent,
  currentContext: otelCtx.currentContext,
};

// ── CLI ──────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log('Usage: node tools/cobolt-otel.js <command> [args]');
    console.log('Commands:');
    console.log('  emit <span.json>                       Append a span to traces.otlp.jsonl');
    console.log('  list [--trace ID] [--since 30d] [--json]');
    console.log('  summary [--since 7d] [--json]');
    console.log('  purge --older-than 30d');
    process.exit(0);
  }
  try {
    if (cmd === 'emit') {
      if (!argv[1]) {
        console.error('Usage: emit <span.json>');
        process.exit(1);
      }
      const span = JSON.parse(fs.readFileSync(argv[1], 'utf8'));
      emit(span);
      console.log(`[cobolt-otel] emitted span ${span.spanId.slice(0, 8)} for trace ${span.traceId.slice(0, 8)}`);
      process.exit(0);
    }
    if (cmd === 'list') {
      const opts = {};
      let json = false;
      for (let i = 1; i < argv.length; i += 1) {
        if (argv[i] === '--trace') opts.traceId = argv[++i];
        else if (argv[i] === '--since') opts.since = argv[++i];
        else if (argv[i] === '--cwd') opts.cwd = argv[++i];
        else if (argv[i] === '--json') json = true;
      }
      const spans = listSpans(opts);
      if (json) console.log(JSON.stringify(spans, null, 2));
      else for (const s of spans) console.log(`  ${s.traceId.slice(0, 8)} ${s.spanId.slice(0, 8)} ${s.name}`);
      process.exit(0);
    }
    if (cmd === 'summary') {
      const opts = {};
      let json = false;
      for (let i = 1; i < argv.length; i += 1) {
        if (argv[i] === '--since') opts.since = argv[++i];
        else if (argv[i] === '--cwd') opts.cwd = argv[++i];
        else if (argv[i] === '--json') json = true;
      }
      const s = summary(opts);
      if (json) console.log(JSON.stringify(s, null, 2));
      else {
        console.log(`[cobolt-otel] ${s.traceCount} trace(s), ${s.spanCount} span(s), ${s.errorSpans} error(s)`);
        for (const [n, c] of Object.entries(s.byName)) console.log(`  ${n.padEnd(40)} ${c}`);
      }
      process.exit(0);
    }
    if (cmd === 'purge') {
      let olderThanDays = 30;
      for (let i = 1; i < argv.length; i += 1) {
        if (argv[i] === '--older-than') {
          const m = String(argv[++i]).match(/^(\d+)d?$/);
          if (m) olderThanDays = Number(m[1]);
        }
      }
      const r = purge({ olderThanDays });
      console.log(`[cobolt-otel] kept=${r.kept} purged=${r.purged}`);
      process.exit(0);
    }
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
  } catch (err) {
    console.error(`[cobolt-otel] ${err.message}`);
    process.exit(1);
  }
}
