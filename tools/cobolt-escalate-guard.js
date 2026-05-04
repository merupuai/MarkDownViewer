#!/usr/bin/env node
// cobolt-escalate-guard — silent auto-retry before writing a human halt file.
//
// When the recovery-advisor returns `escalate` in interactive mode, a human
// halt is written immediately today. That can be premature — the advisor has
// better signal on a second pass (it sees the full prior retry history), and
// in practice frequently flips to `retry-with-context` when given a richer
// payload and a larger budget.
//
// This guard inserts a one-time silent retry with a bumped redispatch budget
// before the halt file is written. Per-artifact ledger prevents infinite
// loops — an artifact that has already been bumped once proceeds straight to
// halt the second time `escalate` is returned.
//
// Usage:
//   cobolt-escalate-guard check-or-bump <artifact> [--bump N] [--base M]
//     Atomically: if <artifact> has not been bumped yet, record the bump and
//     emit verdict `budget-bump-retry`. Otherwise emit `proceed-to-halt`.
//     --bump sets the delta (default 2)
//     --base sets the current budget (default COBOLT_PLAN_REDISPATCH_MAX or 2)
//
//   cobolt-escalate-guard list
//     List all recorded bumps as JSON.
//
//   cobolt-escalate-guard status <artifact>
//     Read-only: is <artifact> bumped? No state change.
//
// Exit codes:
//   0 — always (verdict carried in JSON payload)

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const AUDIT_DIR = path.join(ROOT, '_cobolt-output', 'audit');
const LEDGER = path.join(AUDIT_DIR, 'budget-bumps.jsonl');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v.startsWith('--')) {
      const key = v.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(v);
    }
  }
  return args;
}

function readLedger() {
  if (!fs.existsSync(LEDGER)) return [];
  try {
    return fs
      .readFileSync(LEDGER, 'utf8')
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
  } catch {
    return [];
  }
}

function appendLedger(entry) {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  fs.appendFileSync(LEDGER, `${JSON.stringify(entry)}\n`);
}

function priorBump(artifact) {
  const entries = readLedger();
  return entries.find((e) => e.artifact === artifact) || null;
}

function resolveBase(args) {
  if (args.base) {
    const n = Number(args.base);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const env = Number(process.env.COBOLT_PLAN_REDISPATCH_MAX);
  if (Number.isFinite(env) && env > 0) return env;
  return 2;
}

function resolveBump(args) {
  if (args.bump) {
    const n = Number(args.bump);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 2;
}

function cmdCheckOrBump(args) {
  const artifact = args.artifact || args._[0];
  if (!artifact) {
    process.stderr.write('usage: cobolt-escalate-guard check-or-bump <artifact>\n');
    process.exit(2);
  }
  const existing = priorBump(artifact);
  if (existing) {
    console.log(
      JSON.stringify({
        action: 'proceed-to-halt',
        artifact,
        reason: 'artifact already received a budget bump',
        priorBumpAt: existing.at,
        priorBudget: existing.newBudget,
      }),
    );
    return;
  }
  const base = resolveBase(args);
  const bump = resolveBump(args);
  const newBudget = base + bump;
  const entry = {
    at: new Date().toISOString(),
    artifact,
    baseBudget: base,
    delta: bump,
    newBudget,
  };
  appendLedger(entry);
  console.log(
    JSON.stringify({
      action: 'budget-bump-retry',
      artifact,
      baseBudget: base,
      delta: bump,
      newBudget,
      reason: 'first escalation for this artifact; silent retry with larger budget before halt',
    }),
  );
}

function cmdStatus(args) {
  const artifact = args.artifact || args._[0];
  if (!artifact) {
    process.stderr.write('usage: cobolt-escalate-guard status <artifact>\n');
    process.exit(2);
  }
  const existing = priorBump(artifact);
  console.log(
    JSON.stringify({
      artifact,
      bumped: Boolean(existing),
      entry: existing,
    }),
  );
}

function cmdList() {
  const entries = readLedger();
  console.log(JSON.stringify({ total: entries.length, entries }, null, 2));
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (cmd === 'check-or-bump') return cmdCheckOrBump(args);
  if (cmd === 'status') return cmdStatus(args);
  if (cmd === 'list') return cmdList();
  process.stderr.write(
    'usage: cobolt-escalate-guard {check-or-bump <artifact> [--bump N] [--base M] | status <artifact> | list}\n',
  );
  process.exit(2);
}

if (require.main === module) main();

module.exports = { cmdCheckOrBump, cmdStatus, cmdList, priorBump, resolveBase, resolveBump };
