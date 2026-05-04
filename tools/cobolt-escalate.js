#!/usr/bin/env node

// CoBolt Escalate CLI (CRK Slice 4 / Phase A).
//
// The single entry point skills invoke to consult the resilience kernel.
// Per CoBolt invariant #14, skills cannot `require('../lib/...')` because
// they run in user projects where lib/ does not exist — they must call
// $COBOLT_TOOLS/cobolt-escalate.js instead. This tool is that bridge.
//
// Subcommands:
//   route       Run the kernel and persist a signed escalation event
//   shadow      Run the kernel WITHOUT writing — for parity-mode replay
//   census      Audit (skill, milestone) dispatches vs declared escalations
//
// Skills typically invoke as:
//   node "$COBOLT_TOOLS/cobolt-escalate.js" route \
//     --skill cobolt-build --stage tdd-green \
//     --agent backend-dev --attempt 2 \
//     --error-text "ECONNREFUSED" --json
//
// Stdout: JSON EscalationDecision (with --json) or human summary
// Stdin:  optional rich rawReturn JSON via --stdin (for transcript /
//         claimedFilesWritten / verdict; CLI flags only cover the basics)
//
// Exit codes (per tools/CLAUDE.md):
//   0  success — decision issued
//   1  input error / kernel exception
//   2  missing dep (lib/cobolt-resilience-kernel.js unreachable)
//   3  missing infra (registry not deployed in user project)

const fs = require('node:fs');
const path = require('node:path');

function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const sub = argv[0];
  const rest = argv.slice(1);

  try {
    switch (sub) {
      case 'route':
        cmdRoute(rest, { shadow: false });
        break;
      case 'shadow':
        cmdRoute(rest, { shadow: true });
        break;
      case 'census':
        cmdCensus(rest);
        break;
      default:
        process.stderr.write(`[cobolt-escalate] Unknown subcommand: ${sub}\n`);
        printUsage();
        process.exit(1);
    }
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      process.stderr.write(`[cobolt-escalate] missing-dep: ${err.message}\n`);
      process.exit(2);
    }
    if (err?.message?.includes('registry not found')) {
      process.stderr.write(`[cobolt-escalate] missing-infra: ${err.message}\n`);
      process.exit(3);
    }
    process.stderr.write(`[cobolt-escalate] error: ${err.message}\n`);
    if (process.env.COBOLT_ESCALATE_DEBUG) process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  }
}

// Only run when invoked directly. Tests that require() this file for its
// programmatic API must not trigger the CLI execution path.
if (require.main === module) {
  main();
}

module.exports = { main };

// ── Subcommand implementations ───────────────────────────────────────────

function cmdRoute(args, { shadow }) {
  // Late-require the kernel so MODULE_NOT_FOUND can be classified by the
  // top-level catch. Same pattern as cobolt-bypass.js for late ledger-load.
  const kernel = require(path.resolve(__dirname, '..', 'lib', 'cobolt-resilience-kernel.js'));

  const ctx = {
    skill: requiredFlag(args, '--skill'),
    stage: requiredFlag(args, '--stage'),
    agent: requiredFlag(args, '--agent'),
    attempt: Number(requiredFlag(args, '--attempt')),
    milestone: optionalFlag(args, '--milestone') ?? null,
    pipelineRun: optionalFlag(args, '--pipeline-run') ?? undefined,
    projectRoot: optionalFlag(args, '--project-root') ?? process.cwd(),
  };

  if (!Number.isInteger(ctx.attempt) || ctx.attempt < 1) {
    throw new Error(`--attempt must be a positive integer (got '${ctx.attempt}')`);
  }

  // Build rawReturn from --error-text and --evidence flags. Rich payloads
  // (transcript, claimedFilesWritten, verdict) come via --stdin so callers
  // can pipe agent output without escaping shell metacharacters.
  let rawReturn = {};
  const errorText = optionalFlag(args, '--error-text');
  if (errorText) rawReturn.errorText = errorText;

  if (hasFlag(args, '--stdin')) {
    const stdin = fs.readFileSync(0, 'utf8');
    if (stdin.trim()) {
      try {
        rawReturn = { ...rawReturn, ...JSON.parse(stdin) };
      } catch (e) {
        throw new Error(`--stdin: expected JSON, got parse error: ${e.message}`);
      }
    }
  }

  // Optional injected hints (L2 / L3 layers).
  const criticVerdict = optionalFlag(args, '--critic-verdict');
  if (criticVerdict) ctx.criticVerdict = { verdict: criticVerdict };
  const plateauKind = optionalFlag(args, '--plateau');
  if (plateauKind) ctx.convergenceMetric = { kind: plateauKind };
  if (hasFlag(args, '--dead-end-known')) ctx.deadEndKnown = true;

  const decision = shadow ? kernel.shadow(rawReturn, ctx) : kernel.routeFailure(rawReturn, ctx);

  if (hasFlag(args, '--json')) {
    process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
  } else {
    process.stdout.write(
      `[${shadow ? 'shadow' : 'route'}] action=${decision.action} target=${decision.target} strike=${decision.strikeIndex}\n` +
        `  policy=${decision.policyType} version=${decision.policyVersion}\n` +
        `  reasoning: ${decision.reasoning}\n`,
    );
  }
}

function cmdCensus(args) {
  // Census mode (Inv-5 — census not sampling): cross-reference the
  // dispatch ledger against the escalation-events ledger for one milestone
  // and report any dispatch whose verdict ≠ success that lacks a
  // corresponding event entry. This is the post-milestone audit hook.
  const events = require(path.resolve(__dirname, '..', 'lib', 'cobolt-escalation-events.js'));
  const projectRoot = optionalFlag(args, '--project-root') ?? process.cwd();
  const milestoneFilter = optionalFlag(args, '--milestone');

  const dispatchLedger = path.join(projectRoot, '_cobolt-output', 'audit', 'agent-dispatch-ledger.jsonl');
  const dispatches = readJsonl(dispatchLedger).filter((d) => {
    if (!milestoneFilter) return true;
    return (d.milestone || d.currentMilestone || '') === milestoneFilter;
  });

  const escalationEvents = events.readEvents({ projectRoot }).filter((e) => {
    if (!milestoneFilter) return true;
    return (e.milestone || '') === milestoneFilter;
  });

  // Build a set of (skill, agent, ts±60s) keys present in escalation-events.
  const eventKeys = new Set();
  for (const e of escalationEvents) {
    eventKeys.add(`${e.skill}:${e.agent}:${Math.floor(new Date(e.ts).getTime() / 60000)}`);
  }

  const orphans = [];
  for (const d of dispatches) {
    const verdict = d.verdict || 'unknown';
    if (verdict === 'pass' || verdict === 'success') continue;
    const key = `${d.skill || ''}:${d.agent || ''}:${Math.floor(new Date(d.ts || 0).getTime() / 60000)}`;
    if (!eventKeys.has(key)) {
      orphans.push({ skill: d.skill, agent: d.agent, attempt: d.attempt, verdict, ts: d.ts });
    }
  }

  const report = {
    milestone: milestoneFilter ?? '(all)',
    totalDispatches: dispatches.length,
    nonSuccess: dispatches.filter((d) => d.verdict !== 'pass' && d.verdict !== 'success').length,
    escalationEvents: escalationEvents.length,
    orphans,
    ok: orphans.length === 0,
  };

  if (hasFlag(args, '--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `Census ${report.milestone}: ${report.nonSuccess} non-success dispatches, ${report.escalationEvents} escalation events, ${orphans.length} orphans\n`,
    );
    if (orphans.length > 0) {
      process.stdout.write('Orphans (non-success dispatches without escalation events):\n');
      for (const o of orphans) {
        process.stdout.write(`  - ${o.skill}/${o.agent} attempt=${o.attempt} verdict=${o.verdict} ts=${o.ts}\n`);
      }
    }
  }

  // Inv-5: census mode exits non-zero when the audit finds gaps so callers
  // (release preflight, milestone close) can fail-closed deterministically.
  process.exit(orphans.length === 0 ? 0 : 1);
}

// ── Helpers ──────────────────────────────────────────────────────────────

function flagValue(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const next = args[i + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function optionalFlag(args, name) {
  const v = flagValue(args, name);
  if (v === undefined || v === true) return undefined;
  return v;
}

function requiredFlag(args, name) {
  const v = optionalFlag(args, name);
  if (v === undefined) throw new Error(`${name} is required`);
  return v;
}

function readJsonl(file) {
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

function printUsage() {
  process.stdout.write(
    [
      'cobolt-escalate — CoBolt Resilience Kernel CLI (CRK Slice 4)',
      '',
      'Usage:',
      '  cobolt-escalate route   --skill X --stage Y --agent Z --attempt N [--error-text "..."] [--json]',
      '  cobolt-escalate shadow  (same flags as route; does NOT write event ledger)',
      '  cobolt-escalate census  [--milestone Mn] [--project-root .] [--json]',
      '',
      'Optional ctx hints:',
      '  --milestone Mn',
      '  --pipeline-run <id>',
      '  --project-root <path>      defaults to process.cwd()',
      '  --critic-verdict <v>       L3 hint (e.g. "needs-revision")',
      '  --plateau <kind>           L2 hint (e.g. "plateau", "regression")',
      '  --dead-end-known           L2 hint',
      '  --stdin                    read rich rawReturn JSON from stdin (overlays --error-text)',
      '',
      'Exit codes:',
      '  0  decision issued / census ok',
      '  1  input error / kernel exception / census found orphans',
      '  2  missing dep (kernel module unreachable)',
      '  3  missing infra (registry not deployed)',
      '',
    ].join('\n'),
  );
}
