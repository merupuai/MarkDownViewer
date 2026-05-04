#!/usr/bin/env node

// CoBolt Change Register (v0.44.0).
//
// Append-only ledger of every change that leaves build — milestone
// completions, deploys, rollbacks, hotfixes, incidents, postmortems, risk
// acceptances. Kept at _cobolt-output/audit/change-register.jsonl.
//
// Consumed by cobolt-dora (CFR + lead-time denominator), cobolt-dream
// (learning feed), and cobolt-release-readiness-check (change-window
// guardrail).
//
// Commands:
//   append <type> [--milestone M1] [--ref <id>] [--owner <who>] [--note <text>]
//   list   [--type <type>] [--since <iso>] [--json]
//   stats  [--since <iso>] [--json]
//   help

const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_TYPES = Object.freeze(
  new Set([
    'milestone-complete',
    'deploy',
    'deploy-rollback',
    'hotfix',
    'incident-open',
    'incident-resolve',
    'postmortem-open',
    'postmortem-close',
    'risk-accept',
    'release-cut',
    'feature-flag-toggle',
  ]),
);

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    command: argv[0] && !argv[0].startsWith('-') ? argv[0] : 'help',
    root: process.cwd(),
    type: null,
    milestone: null,
    ref: null,
    owner: null,
    note: null,
    since: null,
    json: false,
  };
  if (args.command === 'append' && argv[1] && !argv[1].startsWith('-')) {
    args.type = argv[1];
  }
  const start = args.command === argv[0] ? 1 : 0;
  for (let i = start; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') args.root = argv[++i] || args.root;
    else if (arg === '--type') args.type = argv[++i];
    else if (arg === '--milestone' || arg === '-m') args.milestone = normalizeMilestone(argv[++i]);
    else if (arg === '--ref') args.ref = argv[++i];
    else if (arg === '--owner') args.owner = argv[++i];
    else if (arg === '--note') args.note = argv[++i];
    else if (arg === '--since') args.since = argv[++i];
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.command = 'help';
  }
  return args;
}

function normalizeMilestone(value) {
  const match = String(value || '')
    .trim()
    .match(/^M?(\d+)$/i);
  return match ? `M${Number.parseInt(match[1], 10)}` : null;
}

function registerPath(projectRoot) {
  return path.join(projectRoot, '_cobolt-output', 'audit', 'change-register.jsonl');
}

function appendRecord(projectRoot, entry) {
  const dir = path.join(projectRoot, '_cobolt-output', 'audit');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = registerPath(projectRoot);
  const preExisting = fs.existsSync(target);
  fs.appendFileSync(target, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
  if (preExisting) {
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      // best-effort
    }
  }
}

function readRegister(projectRoot) {
  const target = registerPath(projectRoot);
  if (!fs.existsSync(target)) return [];
  return fs
    .readFileSync(target, 'utf8')
    .split(/\r?\n/)
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

function cmdAppend(args) {
  if (!args.type) return { ok: false, reason: 'append-requires-type', allowedTypes: [...ALLOWED_TYPES] };
  if (!ALLOWED_TYPES.has(args.type)) {
    return { ok: false, reason: 'unknown-type', type: args.type, allowedTypes: [...ALLOWED_TYPES] };
  }
  const entry = {
    at: new Date().toISOString(),
    type: args.type,
    milestone: args.milestone || null,
    ref: args.ref || null,
    owner: args.owner || null,
    note: args.note || null,
  };
  appendRecord(args.root, entry);
  return { ok: true, reason: 'recorded', entry, ledgerPath: registerPath(args.root) };
}

function filterSince(records, sinceIso) {
  if (!sinceIso) return records;
  const ts = Date.parse(sinceIso);
  if (Number.isNaN(ts)) return records;
  return records.filter((r) => Date.parse(r.at) >= ts);
}

function cmdList(args) {
  const records = filterSince(readRegister(args.root), args.since);
  const filtered = args.type ? records.filter((r) => r.type === args.type) : records;
  return { ok: true, reason: 'ok', count: filtered.length, records: filtered };
}

function cmdStats(args) {
  const records = filterSince(readRegister(args.root), args.since);
  const byType = {};
  for (const r of records) {
    byType[r.type] = (byType[r.type] || 0) + 1;
  }
  const deployments = records.filter((r) => r.type === 'deploy');
  const rollbacks = records.filter((r) => r.type === 'deploy-rollback');
  const hotfixes = records.filter((r) => r.type === 'hotfix');
  const cfrNumerator = rollbacks.length + hotfixes.length;
  const changeFailureRate = deployments.length === 0 ? null : cfrNumerator / deployments.length;
  return {
    ok: true,
    reason: 'ok',
    since: args.since || null,
    totalRecords: records.length,
    byType,
    deployments: deployments.length,
    rollbacks: rollbacks.length,
    hotfixes: hotfixes.length,
    changeFailureRate,
  };
}

function run(args = parseArgs()) {
  if (args.command === 'help') {
    return {
      ok: true,
      usage: [
        'node tools/cobolt-change-register.js append <type> [--milestone M1] [--ref <id>] [--owner <who>] [--note <text>]',
        'node tools/cobolt-change-register.js list  [--type <type>] [--since <iso>] [--json]',
        'node tools/cobolt-change-register.js stats [--since <iso>] [--json]',
        '',
        `Types: ${[...ALLOWED_TYPES].join(', ')}`,
      ].join('\n'),
    };
  }
  if (args.command === 'append') return cmdAppend(args);
  if (args.command === 'list') return cmdList(args);
  if (args.command === 'stats') return cmdStats(args);
  return { ok: false, reason: 'unknown-command', command: args.command };
}

if (require.main === module) {
  const args = parseArgs();
  const result = run(args);
  if (args.json || result.usage) console.log(JSON.stringify(result, null, 2));
  else if (!result.ok) console.error(result.reason || 'change-register failed');
  process.exit(result.ok ? 0 : 1);
}

module.exports = {
  ALLOWED_TYPES,
  appendRecord,
  cmdAppend,
  cmdList,
  cmdStats,
  parseArgs,
  readRegister,
  registerPath,
  run,
};
