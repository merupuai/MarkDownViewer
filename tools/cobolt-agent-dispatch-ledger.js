#!/usr/bin/env node

// CoBolt Agent Dispatch Ledger (v0.19.1+)
//
// Append-only census ledger for every agent/team dispatch that writes files.
// Required by source/skills/_shared/escalation-protocol.md § Evidence Ledger,
// but historically not implemented — v0.19 audit showed zero pipelines actually
// appending to _cobolt-output/audit/agent-dispatch-ledger.jsonl.
//
// Purpose:
//   - Census verification ("did every expected dispatch actually occur?")
//   - Escalation reconstruction ("which leads received which failures?")
//   - Cost/latency post-hoc analysis per agent/skill/stage
//
// Never modifies or rewrites prior lines — strictly append-only.
//
// Usage:
//   node tools/cobolt-agent-dispatch-ledger.js append \
//     --skill cobolt-build --stage S5 --agent backend-dev \
//     --team build-team-1 --attempt 1 \
//     --verdict pass|fail|escalate|degraded \
//     --files-written 12 --findings-resolved 0 \
//     --failure-artifact _cobolt-output/audit/backend-dev-failure.json \
//     --escalation-target build-lead
//
//   node tools/cobolt-agent-dispatch-ledger.js list [--skill X] [--verdict fail] [--since <iso>]
//   node tools/cobolt-agent-dispatch-ledger.js census --skill cobolt-build --expected 8
//
// Exit codes:
//   0 = ok
//   1 = usage error
//   2 = ledger write failed (disk / permission)
//   3 = census mismatch (actual < expected)

const fs = require('node:fs');
const path = require('node:path');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_IO = 2;
const EXIT_CENSUS_FAIL = 3;
const USAGE_TEXT = [
  'Usage:',
  '  cobolt-agent-dispatch-ledger append --skill X --stage Y --agent Z --verdict pass|fail|escalate|degraded|phantom|timeout [...options]',
  '  cobolt-agent-dispatch-ledger list [--skill X] [--stage Y] [--verdict V] [--agent A] [--since ISO] [--limit N] [--json]',
  '  cobolt-agent-dispatch-ledger census --skill X --expected N [--since ISO] [--json]',
  '',
  'Required on append: --skill, --stage, --agent, --verdict',
  'Required on fail/escalate verdict: --escalation-target',
  'Optional: --team, --attempt, --files-written, --findings-resolved, --failure-artifact, --evidence-ref, --context-<key> <val>',
].join('\n');

const REQUIRED = ['skill', 'stage', 'agent', 'verdict'];
const VERDICTS = new Set(['pass', 'fail', 'escalate', 'degraded', 'phantom', 'timeout']);

function ledgerPath(root = process.cwd()) {
  const dir = path.join(root, '_cobolt-output', 'audit');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    /* best effort */
  }
  return path.join(dir, 'agent-dispatch-ledger.jsonl');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function camel(dashKey) {
  return dashKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function buildEntry(args) {
  const entry = {
    ts: new Date().toISOString(),
    skill: args.skill,
    stage: args.stage,
    agent: args.agent,
    team: args.team || null,
    attempt: Number.parseInt(args.attempt || '1', 10),
    verdict: args.verdict,
    filesWritten: Number.parseInt(args['files-written'] || '0', 10),
    findingsResolved: Number.parseInt(args['findings-resolved'] || '0', 10),
    failureArtifact: args['failure-artifact'] || null,
    escalationTarget: args['escalation-target'] || null,
    evidenceRef: args['evidence-ref'] || null,
    pid: process.pid,
  };
  // Allow callers to attach arbitrary scalar context via --context-KEY <value>.
  for (const [k, v] of Object.entries(args)) {
    if (!k.startsWith('context-')) continue;
    entry[camel(k)] = typeof v === 'string' ? v : String(v);
  }
  return entry;
}

function validate(entry) {
  const errors = [];
  for (const field of REQUIRED) {
    if (!entry[field]) errors.push(`missing required field: --${field}`);
  }
  if (entry.verdict && !VERDICTS.has(entry.verdict)) {
    errors.push(`invalid verdict "${entry.verdict}" — must be one of: ${[...VERDICTS].join(', ')}`);
  }
  if (entry.verdict === 'fail' || entry.verdict === 'escalate') {
    if (!entry.escalationTarget) {
      errors.push(`verdict=${entry.verdict} requires --escalation-target`);
    }
  }
  return errors;
}

function cmdAppend(args) {
  const parsed = parseArgs(args);
  const entry = buildEntry(parsed);
  const errors = validate(entry);
  if (errors.length > 0) {
    process.stderr.write('[agent-dispatch-ledger] usage errors:\n');
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.exit(EXIT_USAGE);
  }
  const p = ledgerPath();
  try {
    fs.appendFileSync(p, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    process.stderr.write(`[agent-dispatch-ledger] FAILED to write ${p}: ${err.message}\n`);
    process.exit(EXIT_IO);
  }
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, appended: entry, ledger: p }, null, 2)}\n`);
  } else {
    process.stdout.write(`[agent-dispatch-ledger] +1 ${entry.skill}/${entry.stage} ${entry.agent} ${entry.verdict}\n`);
  }
  process.exit(EXIT_OK);
}

function readAll(root = process.cwd()) {
  const p = ledgerPath(root);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function cmdList(args) {
  const parsed = parseArgs(args);
  const entries = readAll();
  let filtered = entries;
  if (parsed.skill) filtered = filtered.filter((e) => e.skill === parsed.skill);
  if (parsed.stage) filtered = filtered.filter((e) => e.stage === parsed.stage);
  if (parsed.verdict) filtered = filtered.filter((e) => e.verdict === parsed.verdict);
  if (parsed.agent) filtered = filtered.filter((e) => e.agent === parsed.agent);
  if (parsed.since) {
    const floor = Date.parse(parsed.since);
    if (!Number.isNaN(floor)) filtered = filtered.filter((e) => Date.parse(e.ts) >= floor);
  }
  const limit = Number.parseInt(parsed.limit || '200', 10);
  const recent = filtered.slice(-limit);
  if (parsed.json) {
    process.stdout.write(
      `${JSON.stringify({ count: recent.length, totalInLedger: entries.length, entries: recent }, null, 2)}\n`,
    );
  } else {
    for (const e of recent) {
      process.stdout.write(
        `${e.ts} ${e.skill}/${e.stage} ${e.agent}${e.team ? ` (${e.team})` : ''} → ${e.verdict}` +
          `${e.filesWritten ? ` files=${e.filesWritten}` : ''}` +
          `${e.escalationTarget ? ` esc=${e.escalationTarget}` : ''}\n`,
      );
    }
    process.stdout.write(`\n  ${recent.length} of ${filtered.length} matching (${entries.length} total in ledger)\n`);
  }
  process.exit(EXIT_OK);
}

function cmdCensus(args) {
  const parsed = parseArgs(args);
  if (!parsed.skill || !parsed.expected) {
    process.stderr.write('[agent-dispatch-ledger] census requires --skill <name> --expected <count>\n');
    process.exit(EXIT_USAGE);
  }
  const expected = Number.parseInt(parsed.expected, 10);
  const entries = readAll().filter((e) => e.skill === parsed.skill);
  const sinceFloor = parsed.since ? Date.parse(parsed.since) : null;
  const scoped = sinceFloor ? entries.filter((e) => Date.parse(e.ts) >= sinceFloor) : entries;
  const passed = scoped.filter((e) => e.verdict === 'pass').length;
  const failed = scoped.filter(
    (e) => e.verdict === 'fail' || e.verdict === 'escalate' || e.verdict === 'phantom',
  ).length;
  const degraded = scoped.filter((e) => e.verdict === 'degraded' || e.verdict === 'timeout').length;
  const totalDispatches = scoped.length;
  const ok = totalDispatches >= expected;
  const result = {
    skill: parsed.skill,
    expected,
    actual: totalDispatches,
    passed,
    failed,
    degraded,
    ok,
  };
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `[agent-dispatch-ledger] census ${parsed.skill}: expected ${expected}, actual ${totalDispatches} (pass=${passed} fail=${failed} degraded=${degraded}) — ${ok ? 'OK' : 'SHORT'}\n`,
    );
  }
  process.exit(ok ? EXIT_OK : EXIT_CENSUS_FAIL);
}

function usage(code = EXIT_USAGE) {
  const stream = code === EXIT_OK ? process.stdout : process.stderr;
  stream.write(`${USAGE_TEXT}\n`);
  process.exit(code);
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd) return usage(EXIT_USAGE);
  if (cmd === '-h' || cmd === '--help' || cmd === 'help') return usage(EXIT_OK);
  const rest = args.slice(1);
  if (cmd === 'append') return cmdAppend(rest);
  if (cmd === 'list') return cmdList(rest);
  if (cmd === 'census') return cmdCensus(rest);
  usage();
}

if (require.main === module) main();

module.exports = { ledgerPath, readAll, buildEntry, validate };
