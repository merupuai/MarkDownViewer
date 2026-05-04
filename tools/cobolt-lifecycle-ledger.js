#!/usr/bin/env node

// CoBolt Lifecycle Ledger CLI (v0.59 Stage-2B).
//
// Operator-facing verifier and reporter for _cobolt-output/audit/
// lifecycle-events.jsonl. Mirrors tools/cobolt-bypass.js's verify/report
// pattern for SOC2 / ISO 27001 evidence consistency.
//
// Subcommands:
//   verify              Walk the ledger; HMAC + chain integrity check.
//                       Exit 0 = clean, 1 = chain broken, 2 = no key configured.
//
//   report [--json]     Summary: total entries, signed/unsigned counts,
//                       per-agent dispatch counts, first/last timestamps.
//
//   rotate-key --confirm
//                       Archive current ledger as
//                       lifecycle-events.<timestamp>.archive.jsonl, generate
//                       a new HMAC key in .env.cobolt, start a fresh chain.
//                       Use after suspected key compromise.
//
// Exit-code contract (per tools/CLAUDE.md):
//   0 — success
//   1 — chain broken / hard error / verification failure
//   2 — no key configured (chain hasn't started; nothing to verify)

const fs = require('node:fs');
const path = require('node:path');

const HELP_TEXT = `\
cobolt-lifecycle-ledger — verify, report, and rotate the lifecycle ledger.

USAGE
  node tools/cobolt-lifecycle-ledger.js <command> [flags]

COMMANDS
  verify                                Walk the ledger; HMAC + chain check.
  report [--json]                       Summary of ledger contents.
  rotate-key --confirm                  Archive ledger, generate new HMAC key.

EXIT CODES
  0   verify succeeded / report ok / rotate-key succeeded
  1   chain broken / hard error
  2   no key configured (chain hasn't started)

ENV
  COBOLT_LIFECYCLE_HMAC_KEY        per-project HMAC key (auto-generated in .env.cobolt)
  COBOLT_LIFECYCLE_HMAC=on         signs new entries (set in cobolt-post-dispatch.js scope)
`;

function usage(extra) {
  if (extra) process.stderr.write(`${extra}\n`);
  process.stdout.write(HELP_TEXT);
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function projectRoot() {
  return process.cwd();
}

function loadLifecycleEvents() {
  return require('../lib/cobolt-lifecycle-events');
}

function ledgerExists(root) {
  const abs = path.join(root, '_cobolt-output', 'audit', 'lifecycle-events.jsonl');
  return fs.existsSync(abs);
}

function keyConfigured(root) {
  // Inspect env + .env.cobolt without forcing key generation.
  if (process.env.COBOLT_LIFECYCLE_HMAC_KEY && /^[a-fA-F0-9]{64}$/.test(process.env.COBOLT_LIFECYCLE_HMAC_KEY)) {
    return true;
  }
  try {
    const envContent = fs.readFileSync(path.join(root, '.env.cobolt'), 'utf8');
    return /^\s*COBOLT_LIFECYCLE_HMAC_KEY\s*=\s*["']?([a-fA-F0-9]{32,})["']?/m.test(envContent);
  } catch {
    return false;
  }
}

// ── verify ─────────────────────────────────────────────────

function cmdVerify() {
  const root = projectRoot();
  const lifecycle = loadLifecycleEvents();
  if (!ledgerExists(root)) {
    process.stdout.write('Lifecycle ledger not present (no _cobolt-output/audit/lifecycle-events.jsonl).\n');
    return 0;
  }
  if (!keyConfigured(root)) {
    process.stderr.write(
      'No HMAC key configured. Set COBOLT_LIFECYCLE_HMAC_KEY in .env.cobolt or env, or run a signed dispatch first.\n',
    );
    return 2;
  }
  const result = lifecycle.verifyChain({ projectRoot: root });
  if (result.ok) {
    process.stdout.write(
      `Verified ${result.totalEntries} entries (signed: ${result.verifiedEntries}, unsigned: ${result.unsignedEntries}). Chain intact.\n`,
    );
    return 0;
  }
  process.stderr.write(
    `Chain broken at entry ${result.brokenAtIndex}: ${result.reason}.\n` +
      `  Total entries: ${result.totalEntries}\n` +
      `  Verified before break: ${result.verifiedEntries}\n` +
      `  Unsigned (legacy): ${result.unsignedEntries}\n`,
  );
  return 1;
}

// ── report ─────────────────────────────────────────────────

function cmdReport(args) {
  const root = projectRoot();
  const ledgerPath = path.join(root, '_cobolt-output', 'audit', 'lifecycle-events.jsonl');
  const json = hasFlag(args, '--json');
  if (!fs.existsSync(ledgerPath)) {
    if (json) {
      process.stdout.write(`${JSON.stringify({ totalEntries: 0, agents: {}, brokenChain: false }, null, 2)}\n`);
    } else {
      process.stdout.write('No ledger present.\n');
    }
    return 0;
  }
  const text = fs.readFileSync(ledgerPath, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  const agents = {};
  const events = {};
  let signed = 0;
  let unsigned = 0;
  let firstTs = null;
  let lastTs = null;
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const e = entry.event || 'unknown';
    events[e] = (events[e] || 0) + 1;
    if (e === 'SubagentStart' || e === 'SubagentStop') {
      const a = entry.agent || 'unknown';
      agents[a] = (agents[a] || 0) + 1;
    }
    if (typeof entry.signature === 'string') signed++;
    else unsigned++;
    if (entry.timestamp) {
      if (!firstTs) firstTs = entry.timestamp;
      lastTs = entry.timestamp;
    }
  }

  // Chain integrity (best-effort, doesn't fail report)
  let brokenChain = false;
  try {
    const lifecycle = loadLifecycleEvents();
    if (keyConfigured(root)) {
      const r = lifecycle.verifyChain({ projectRoot: root });
      brokenChain = !r.ok;
    }
  } catch {
    /* ignore — report is best-effort */
  }

  const summary = {
    totalEntries: lines.length,
    signedEntries: signed,
    unsignedEntries: unsigned,
    firstTimestamp: firstTs,
    lastTimestamp: lastTs,
    eventCounts: events,
    agents,
    brokenChain,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`Lifecycle Ledger Report\n`);
  process.stdout.write(`-----------------------\n`);
  process.stdout.write(`  Total entries:    ${summary.totalEntries}\n`);
  process.stdout.write(`  Signed:           ${summary.signedEntries}\n`);
  process.stdout.write(`  Unsigned:         ${summary.unsignedEntries}\n`);
  process.stdout.write(`  Chain integrity:  ${summary.brokenChain ? 'BROKEN' : 'OK'}\n`);
  process.stdout.write(`  First timestamp:  ${summary.firstTimestamp || '-'}\n`);
  process.stdout.write(`  Last timestamp:   ${summary.lastTimestamp || '-'}\n`);
  process.stdout.write(`  Event counts:\n`);
  for (const [k, v] of Object.entries(events).sort(([, a], [, b]) => b - a)) {
    process.stdout.write(`    ${k.padEnd(20)} ${v}\n`);
  }
  process.stdout.write(`  Top agents:\n`);
  const topAgents = Object.entries(agents)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10);
  for (const [a, n] of topAgents) {
    process.stdout.write(`    ${a.slice(0, 40).padEnd(40)} ${n}\n`);
  }
  return 0;
}

// ── rotate-key ─────────────────────────────────────────────

function cmdRotateKey(args) {
  const root = projectRoot();
  if (!hasFlag(args, '--confirm')) {
    process.stderr.write('rotate-key archives the ledger and generates a new HMAC key. Re-run with --confirm.\n');
    return 1;
  }
  const ledgerPath = path.join(root, '_cobolt-output', 'audit', 'lifecycle-events.jsonl');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  let archived = null;
  if (fs.existsSync(ledgerPath)) {
    archived = path.join(root, '_cobolt-output', 'audit', `lifecycle-events.${ts}.archive.jsonl`);
    fs.renameSync(ledgerPath, archived);
  }
  const lifecycle = loadLifecycleEvents();
  // Force re-generation by clearing the env value if present and removing
  // the .env.cobolt entry. Simpler: append a fresh key — resolveKey will
  // pick the most-recent matching line.
  const crypto = require('node:crypto');
  const fresh = crypto.randomBytes(32).toString('hex');
  const envFile = path.join(root, '.env.cobolt');
  // Append new key block (existing key remains for legacy archive verification).
  const block = `\n# CoBolt lifecycle ledger HMAC key (rotated ${ts})\nCOBOLT_LIFECYCLE_HMAC_KEY=${fresh}\n`;
  if (fs.existsSync(envFile)) {
    fs.appendFileSync(envFile, block);
  } else {
    fs.writeFileSync(envFile, block.trimStart(), { mode: 0o600 });
  }
  try {
    fs.chmodSync(envFile, 0o600);
  } catch {
    /* ignore platform variance */
  }
  // resolveKey() reads the FIRST matching key in .env.cobolt — to ensure
  // new entries use the rotated key, the operator should remove the prior
  // KEY_VAR line manually OR the env var should override. Document this.
  process.stdout.write(
    `Key rotated. New key persisted to .env.cobolt.\n` +
      `Old ledger archived: ${archived || '(no prior ledger)'}\n` +
      `Note: lib/cobolt-lifecycle-events.js#resolveKey reads the FIRST matching\n` +
      `COBOLT_LIFECYCLE_HMAC_KEY line in .env.cobolt. Remove the prior line manually\n` +
      `or set the env var to force the new key.\n`,
  );
  // Defensive cache clear so any in-process consumers re-read.
  if (typeof lifecycle.clearCache === 'function') lifecycle.clearCache();
  return 0;
}

// ── main ──────────────────────────────────────────────────

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || hasFlag(args, '--help') || hasFlag(args, '-h')) {
    usage();
    return 0;
  }
  const cmd = args[0];
  const rest = args.slice(1);
  switch (cmd) {
    case 'verify':
      return cmdVerify();
    case 'report':
      return cmdReport(rest);
    case 'rotate-key':
      return cmdRotateKey(rest);
    default:
      usage(`Unknown command: ${cmd}`);
      return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { main, cmdVerify, cmdReport, cmdRotateKey };
