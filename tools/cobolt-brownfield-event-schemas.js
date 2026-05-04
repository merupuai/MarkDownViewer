#!/usr/bin/env node

// CoBolt Brownfield Event-Schemas Synthesizer
//
// Closes the silent-death class observed during brownfield --scan full runs:
// 30a-modernization-event-schemas.md was referenced by the planning-sync
// COPY_MAP but had NO deterministic producer. Every modernization run for a
// project with event-driven integrations would either skip the artifact (if
// the orchestrator silently dropped it) or pause for manual authoring.
//
// This tool is the authoritative producer. It reads the upstream event
// signals (API contracts, integration map, dependency register, optional
// planning-side event-schemas.md) and emits 30a-modernization-event-schemas.md
// in one of two shapes:
//
//   1. Event-driven: a structured event catalog populated from upstream
//      detection — producers, consumers, schema scaffolding, idempotency,
//      ordering, retention, replay/DLQ — ready for the architect to fill in.
//   2. Not-applicable: an explicit N/A stub explaining no event signals
//      were detected. Downstream consumers (planning-sync, build-handoff)
//      treat this as legitimate absence rather than missing-producer.
//
// Inputs (_cobolt-output/latest/brownfield/):
//   30-modernization-api-contracts.md             — primary (REQUIRED) event mention source
//   06-integration-map.md                          — optional integration discovery
//   33-modernization-dependency-and-integration-register.md — optional dependency context
//   ../planning/event-schemas.md                   — optional planning-side prior art
//
// Output:
//   30a-modernization-event-schemas.md             — synthesized doc (>=500 bytes)
//
// Exit codes (per tools/CLAUDE.md):
//   0 — report written successfully
//   1 — hard error (unwritable, invalid input)
//   2 — usage error
//   3 — required input missing (30-modernization-api-contracts.md is mandatory)

const fs = require('node:fs');
const path = require('node:path');

const TOOL_NAME = 'cobolt-brownfield-event-schemas';
const OUTPUT_FILE = '30a-modernization-event-schemas.md';
const REQUIRED = ['30-modernization-api-contracts.md'];
const OPTIONAL = ['06-integration-map.md', '33-modernization-dependency-and-integration-register.md'];

const EVENT_SIGNAL_PATTERNS = Object.freeze([
  { label: 'webhook', pattern: /\bwebhook(?:s|ing)?\b/i },
  { label: 'pub-sub', pattern: /\bpub[-/]?sub\b|\bpublish(?:er|ed)?\b|\bsubscribe(?:r|d)?\b/i },
  { label: 'message-queue', pattern: /\bmessage queue|\bMQ\b|\bqueue listener\b|\bqueue consumer\b/i },
  { label: 'kafka', pattern: /\bkafka\b/i },
  { label: 'rabbitmq', pattern: /\brabbit(?:mq)?\b|\bamqp\b/i },
  { label: 'sns-sqs', pattern: /\b(?:aws[- ])?sns\b|\b(?:aws[- ])?sqs\b/i },
  { label: 'eventbridge', pattern: /\beventbridge\b/i },
  { label: 'redis-pubsub', pattern: /\bredis\b.*\bpub[-/]?sub|\bredis\b.*\bstream/i },
  { label: 'nats', pattern: /\bnats\b/i },
  { label: 'event-driven', pattern: /\bevent[- ]driven\b|\bevent stream\b|\bdomain event\b/i },
  { label: 'cdc', pattern: /\bCDC\b|change data capture/i },
  { label: 'eventbus', pattern: /\bevent bus\b|\beventbus\b/i },
]);

function printHelp() {
  process.stdout.write(
    `${TOOL_NAME} — synthesize 30a-modernization-event-schemas.md from upstream signals\n\n` +
      `USAGE\n` +
      `  node tools/${TOOL_NAME}.js build [--dir <bf-dir>] [--json] [--force]\n` +
      `  node tools/${TOOL_NAME}.js --help\n\n` +
      `EXIT CODES\n` +
      `  0 — report written successfully (>=500 bytes)\n` +
      `  1 — hard error (unwritable target, invalid input)\n` +
      `  2 — usage error\n` +
      `  3 — required input (30-modernization-api-contracts.md) missing\n\n` +
      `INPUTS\n` +
      `  Required: 30-modernization-api-contracts.md\n` +
      `  Optional: 06-integration-map.md, 33-modernization-dependency-and-integration-register.md\n` +
      `  Optional fallback: _cobolt-output/latest/planning/event-schemas.md\n\n` +
      `OUTPUTS\n` +
      `  When upstream signals event-driven integrations: structured event catalog template.\n` +
      `  When NO event signals are present: explicit N/A stub. The artifact still exists\n` +
      `  so downstream consumers (planning-sync COPY_MAP, build-handoff contract) do not\n` +
      `  encounter a silent missing-producer. Pass --force to overwrite an existing file.\n`,
  );
}

function readText(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function detectEventSignals(text) {
  if (!text) return [];
  const signals = [];
  const seen = new Set();
  for (const { label, pattern } of EVENT_SIGNAL_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    const idx = text.indexOf(match[0]);
    const start = Math.max(0, idx - 80);
    const end = Math.min(text.length, idx + match[0].length + 80);
    const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 200);
    signals.push({ label, snippet });
  }
  return signals;
}

function buildEventDrivenReport(signals, sources, planningPriorArt) {
  const lines = [];
  lines.push('# 30a — Modernization Event Schemas');
  lines.push('');
  lines.push(
    'Event-driven integration surface detected in upstream artifacts. This document captures the modernization-target event catalog for downstream architect, build, and ops teams.',
  );
  lines.push('');
  lines.push('## Detected Event Signals');
  lines.push('');
  lines.push('| Signal | Source artifact | Evidence snippet |');
  lines.push('| ------ | --------------- | ---------------- |');
  for (const s of signals) {
    const sourceLabel = sources.find((src) => src.signals.includes(s))?.file || 'unknown';
    lines.push(`| \`${s.label}\` | \`${sourceLabel}\` | ${s.snippet.replace(/\|/g, '\\|')} |`);
  }
  lines.push('');

  if (planningPriorArt) {
    lines.push('## Planning-side prior art');
    lines.push('');
    lines.push(
      'A planning-side `event-schemas.md` exists. Reconcile its event catalog with the modernization plan before publishing this document to downstream consumers.',
    );
    lines.push('');
    lines.push('```markdown');
    lines.push(planningPriorArt.slice(0, 4000));
    if (planningPriorArt.length > 4000)
      lines.push('… (planning event-schemas.md continues — read in full before reconciliation)');
    lines.push('```');
    lines.push('');
  }

  lines.push('## Event Catalog Template');
  lines.push('');
  lines.push(
    'Populate one entry per domain event. Every event MUST have a producer, at least one consumer, an explicit schema, an idempotency key, and a retention/replay policy.',
  );
  lines.push('');
  lines.push('### Event: `<bounded-context>.<entity>.<verb>` (TODO: rename per signal above)');
  lines.push('');
  lines.push('- **Producer**: `<service or component>`');
  lines.push('- **Consumers**: `<list of services / projections / side-effects>`');
  lines.push('- **Trigger**: `<command, state transition, or external signal>`');
  lines.push('- **Transport**: `<webhook | kafka | sns | rabbitmq | eventbridge | nats | redis stream>`');
  lines.push('- **Topic / channel / endpoint**: `<concrete name>`');
  lines.push('- **Schema**:');
  lines.push('');
  lines.push('  ```json');
  lines.push('  {');
  lines.push('    "eventId": "<uuid>",');
  lines.push('    "occurredAt": "<RFC3339 timestamp>",');
  lines.push('    "schemaVersion": "1.0.0",');
  lines.push('    "idempotencyKey": "<deterministic dedup key>",');
  lines.push('    "data": {}');
  lines.push('  }');
  lines.push('  ```');
  lines.push('');
  lines.push('- **Idempotency**: `<how consumers detect replays — eventId | natural key | composite>`');
  lines.push('- **Ordering**: `<per-key | global | none>`');
  lines.push('- **At-least-once vs exactly-once**: `<at-least-once + idempotency | exactly-once via outbox>`');
  lines.push('- **Retention**: `<7d | 30d | log-compaction>`');
  lines.push('- **Replay / DLQ**: `<replay strategy and dead-letter routing>`');
  lines.push('- **Error handling**: `<retry budget, poison-pill behavior>`');
  lines.push('');
  lines.push('## Cross-Cutting Concerns');
  lines.push('');
  lines.push(
    '- **Schema registry**: declare whether modernization adopts a registry (Confluent / AWS Glue / SchemaStore) or inlines schemas in a versioned contracts package.',
  );
  lines.push(
    '- **Versioning**: every event MUST carry `schemaVersion`. Producer changes that break consumers require a new schema version, not silent in-place edits.',
  );
  lines.push(
    '- **Observability**: every event emit and consume MUST produce a structured log line with `eventId`, `correlationId`, `idempotencyKey`, and outcome.',
  );
  lines.push(
    '- **PII / sensitive payload**: classify every event payload field. Flag any that carry regulated data and capture the encryption/redaction policy.',
  );
  lines.push('');
  lines.push('## Status');
  lines.push('');
  lines.push(
    `- **Producer**: \`${TOOL_NAME}\` (deterministic synthesis from upstream signals; architect to flesh out concrete events).`,
  );
  lines.push(`- **Detection signals**: ${signals.map((s) => `\`${s.label}\``).join(', ') || 'none'}`);
  lines.push(`- **Sources read**: ${sources.map((s) => `\`${s.file}\``).join(', ')}`);
  lines.push('');
  return lines.join('\n');
}

function buildNotApplicableReport(sources) {
  const lines = [];
  lines.push('# 30a — Modernization Event Schemas');
  lines.push('');
  lines.push('## Status: Not Applicable');
  lines.push('');
  lines.push(
    'No event-driven integration signals were detected in the upstream brownfield modernization artifacts. This document is therefore an explicit not-applicable record so downstream consumers (planning-sync, build-handoff contract, deploy gate) do not encounter a silent missing-producer.',
  );
  lines.push('');
  lines.push('## Sources Inspected');
  lines.push('');
  for (const source of sources) {
    lines.push(
      `- \`${source.file}\` — ${source.bytes} bytes, signals: ${source.signals.length === 0 ? 'none' : source.signals.map((s) => s.label).join(', ')}`,
    );
  }
  lines.push('');
  lines.push('## When This Changes');
  lines.push('');
  lines.push(
    'If the modernization plan introduces event-driven integrations (webhooks, message queues, pub/sub, event streams, CDC, change data capture, EventBridge, Kafka, RabbitMQ, Redis Streams, NATS, SNS/SQS, etc.), re-run the synthesizer with `--force`:',
  );
  lines.push('');
  lines.push('```bash');
  lines.push(`node tools/${TOOL_NAME}.js build --dir _cobolt-output/latest/brownfield --force`);
  lines.push('```');
  lines.push('');
  lines.push(
    'Or replace this document by hand. The brownfield-to-build handoff contract requires it; an empty file would block the milestone.',
  );
  lines.push('');
  lines.push('## Detection Lexicon');
  lines.push('');
  lines.push('The synthesizer looked for these event-shaped tokens in upstream artifacts:');
  lines.push('');
  for (const { label } of EVENT_SIGNAL_PATTERNS) {
    lines.push(`- \`${label}\``);
  }
  lines.push('');
  lines.push(`## Status`);
  lines.push('');
  lines.push(`- **Producer**: \`${TOOL_NAME}\` (deterministic — no event signals detected, N/A stub emitted).`);
  lines.push(`- **Detection signals**: none`);
  lines.push(`- **Sources read**: ${sources.map((s) => `\`${s.file}\``).join(', ')}`);
  lines.push('');
  return lines.join('\n');
}

function resolveBrownfieldDir(args) {
  const idx = args.indexOf('--dir');
  if (idx !== -1 && args[idx + 1]) return path.resolve(args[idx + 1]);
  return path.join(process.cwd(), '_cobolt-output', 'latest', 'brownfield');
}

function build(bfDir, options = {}) {
  if (!fs.existsSync(bfDir)) {
    return { ok: false, code: 3, reason: 'brownfield-dir-missing', bfDir };
  }

  const required = REQUIRED.map((file) => ({
    file,
    path: path.join(bfDir, file),
    present: fs.existsSync(path.join(bfDir, file)),
  }));
  const missingRequired = required.filter((r) => !r.present);
  if (missingRequired.length > 0) {
    return {
      ok: false,
      code: 3,
      reason: 'required-input-missing',
      bfDir,
      missing: missingRequired.map((r) => r.file),
    };
  }

  const sources = [];
  const combinedSignals = [];

  for (const file of [...REQUIRED, ...OPTIONAL]) {
    const filePath = path.join(bfDir, file);
    const text = readText(filePath);
    if (!text) continue;
    const signals = detectEventSignals(text);
    sources.push({ file, bytes: Buffer.byteLength(text, 'utf8'), signals });
    combinedSignals.push(...signals);
  }

  const planningPath = path.join(path.dirname(bfDir), 'planning', 'event-schemas.md');
  const planningPriorArt = readText(planningPath);
  if (planningPriorArt) {
    const planningSignals = detectEventSignals(planningPriorArt);
    sources.push({
      file: '../planning/event-schemas.md',
      bytes: Buffer.byteLength(planningPriorArt, 'utf8'),
      signals: planningSignals,
    });
    combinedSignals.push(...planningSignals);
  }

  const seen = new Set();
  const uniqueSignals = [];
  for (const s of combinedSignals) {
    if (seen.has(s.label)) continue;
    seen.add(s.label);
    uniqueSignals.push(s);
  }

  const outputPath = path.join(bfDir, OUTPUT_FILE);
  if (fs.existsSync(outputPath) && options.force !== true) {
    return {
      ok: true,
      code: 0,
      action: 'skipped-exists',
      outputPath,
      reason: 'output exists; pass --force to regenerate',
      detectedSignals: uniqueSignals.map((s) => s.label),
      sources: sources.map((s) => ({ file: s.file, bytes: s.bytes, signalCount: s.signals.length })),
    };
  }

  const content =
    uniqueSignals.length > 0
      ? buildEventDrivenReport(uniqueSignals, sources, planningPriorArt)
      : buildNotApplicableReport(sources);

  try {
    fs.writeFileSync(outputPath, content, 'utf8');
  } catch (err) {
    return { ok: false, code: 1, reason: `write-failed: ${err.message}`, outputPath };
  }

  return {
    ok: true,
    code: 0,
    action: uniqueSignals.length > 0 ? 'generated-event-driven' : 'generated-not-applicable',
    outputPath,
    bytes: Buffer.byteLength(content, 'utf8'),
    detectedSignals: uniqueSignals.map((s) => s.label),
    sources: sources.map((s) => ({ file: s.file, bytes: s.bytes, signalCount: s.signals.length })),
  };
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return 0;
  }

  const command = argv[0];
  if (command !== 'build') {
    process.stderr.write(`Unknown command: ${command}\n`);
    printHelp();
    return 2;
  }

  const bfDir = resolveBrownfieldDir(argv);
  const jsonMode = argv.includes('--json');
  const force = argv.includes('--force');

  const result = build(bfDir, { force });
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(
      `[${TOOL_NAME}] ${result.action} -> ${result.outputPath} (${result.bytes || 0} bytes, signals: ${(result.detectedSignals || []).join(', ') || 'none'})\n`,
    );
  } else {
    process.stderr.write(`[${TOOL_NAME}] FAIL ${result.reason || 'unknown error'}\n`);
    if (result.missing) for (const m of result.missing) process.stderr.write(`  - missing: ${m}\n`);
  }
  return result.code;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  build,
  detectEventSignals,
  EVENT_SIGNAL_PATTERNS,
  OUTPUT_FILE,
  REQUIRED,
  OPTIONAL,
};
