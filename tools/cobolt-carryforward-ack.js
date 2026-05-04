#!/usr/bin/env node
//
// CoBolt carry-forward acknowledgement (Issue 6, v0.40.5).
//
// `{M}-deferred-work.json` became mandatory at milestone-close via the
// cobolt-checkpoint-write-gate. But nothing forced downstream consumers
// (release / dream / deploy) to actually READ it before acting — so a
// deferred Critical finding could silently ride through release.
//
// This tool records a read-receipt: a JSONL line proving which consumer
// stage read the deferred-work file. The paired PreToolUse hook
// `cobolt-carryforward-consumer-gate` refuses to advance the stage until
// the receipt for the current milestone exists.
//
// Commands:
//   ack --milestone M{N} --consumer <stage>
//     Reads {M}-deferred-work.json, computes the content hash, and appends
//     a receipt line.
//
//   verify --milestone M{N} --consumer <stage>
//     Exits 0 if a fresh receipt exists for the (milestone, consumer) pair
//     AND matches the current on-disk content hash. Exits 1 otherwise.
//
//   list
//     Print all receipts as JSON array.
//
// Exit codes:
//   0 receipt written / receipt verified
//   1 hard error (missing deferred-work file, stale receipt, etc.)
//   2 missing optional input (never — this tool has no optional deps)
//   3 missing infra (never)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const RECEIPT_PATH = path.join('_cobolt-output', 'audit', 'carryforward-receipts.jsonl');
const ALLOWED_CONSUMERS = new Set([
  'cobolt-deploy',
  'cobolt-release',
  'cobolt-dream',
  'cobolt-milestone-validate',
  'cobolt-audit',
]);

function deferredWorkPath(milestone) {
  return path.join('_cobolt-output', 'latest', 'build', milestone, `${milestone}-deferred-work.json`);
}

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function readReceipts() {
  const raw = readFileSafe(RECEIPT_PATH);
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
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

function appendReceipt(entry) {
  fs.mkdirSync(path.dirname(RECEIPT_PATH), { recursive: true, mode: 0o700 });
  fs.appendFileSync(RECEIPT_PATH, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

function requireMilestoneConsumer(args) {
  const milestone =
    args.find((a) => a.startsWith('--milestone='))?.split('=')[1] || args[args.indexOf('--milestone') + 1];
  const consumer = args.find((a) => a.startsWith('--consumer='))?.split('=')[1] || args[args.indexOf('--consumer') + 1];
  if (!milestone || !/^M\d+$/i.test(milestone)) {
    process.stderr.write('carryforward-ack: --milestone M{N} required\n');
    process.exit(1);
  }
  if (!consumer || !ALLOWED_CONSUMERS.has(consumer)) {
    process.stderr.write(`carryforward-ack: --consumer required, one of: ${[...ALLOWED_CONSUMERS].join(', ')}\n`);
    process.exit(1);
  }
  return { milestone, consumer };
}

function cmdAck(args) {
  const { milestone, consumer } = requireMilestoneConsumer(args);
  const dwPath = deferredWorkPath(milestone);
  const raw = readFileSafe(dwPath);
  if (!raw) {
    process.stderr.write(`carryforward-ack: ${dwPath} not found — produce it at milestone-close (Step 08) first\n`);
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`carryforward-ack: ${dwPath} is not valid JSON: ${err.message}\n`);
    process.exit(1);
  }
  const contentHash = sha256Hex(raw).slice(0, 32);
  const totalCount = Number.isInteger(parsed.totalCount) ? parsed.totalCount : null;
  const entry = {
    schemaVersion: 'cobolt-carryforward-receipt/v1',
    milestone,
    consumer,
    deferredWorkPath: dwPath,
    contentHash,
    totalCount,
    acknowledgedAt: new Date().toISOString(),
    acknowledger: process.env.COBOLT_ACKNOWLEDGER || 'main-session',
  };
  appendReceipt(entry);
  process.stdout.write(`${JSON.stringify({ ok: true, ...entry })}\n`);
  process.exit(0);
}

function cmdVerify(args) {
  const { milestone, consumer } = requireMilestoneConsumer(args);
  const dwPath = deferredWorkPath(milestone);
  const raw = readFileSafe(dwPath);
  if (!raw) {
    process.stderr.write(`carryforward-ack verify: ${dwPath} missing\n`);
    process.exit(1);
  }
  const currentHash = sha256Hex(raw).slice(0, 32);
  const receipts = readReceipts();
  const matching = receipts.filter(
    (r) => r.milestone === milestone && r.consumer === consumer && r.contentHash === currentHash,
  );
  if (matching.length === 0) {
    process.stderr.write(
      `carryforward-ack verify: no fresh receipt for ${consumer} on ${milestone} (currentHash=${currentHash})\n` +
        `Remediation: node tools/cobolt-carryforward-ack.js ack --milestone ${milestone} --consumer ${consumer}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      milestone,
      consumer,
      receiptCount: matching.length,
      latest: matching[matching.length - 1],
    })}\n`,
  );
  process.exit(0);
}

function cmdList() {
  const receipts = readReceipts();
  process.stdout.write(`${JSON.stringify(receipts, null, 2)}\n`);
  process.exit(0);
}

function printUsage() {
  process.stdout.write(
    [
      'Usage: cobolt-carryforward-ack <command> [options]',
      '',
      'Commands:',
      '  ack    --milestone M{N} --consumer <stage>   Write receipt',
      '  verify --milestone M{N} --consumer <stage>   Verify receipt matches on-disk hash',
      '  list                                         Dump all receipts as JSON',
      '',
      `Allowed consumers: ${[...ALLOWED_CONSUMERS].join(', ')}`,
      '',
    ].join('\n'),
  );
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printUsage();
    process.exit(argv.length === 0 ? 1 : 0);
  }
  const cmd = argv[0];
  const rest = argv.slice(1);
  if (cmd === 'ack') return cmdAck(rest);
  if (cmd === 'verify') return cmdVerify(rest);
  if (cmd === 'list') return cmdList();
  process.stderr.write(`carryforward-ack: unknown command "${cmd}"\n`);
  printUsage();
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  _internal: { deferredWorkPath, readReceipts, sha256Hex, ALLOWED_CONSUMERS },
};
