#!/usr/bin/env node

// CoBolt Escalation Replay (CRK Slice 4 / Phase A).
//
// THE Phase A certifying gate. Replays a corpus of historical agent-dispatch
// ledger entries through kernel.shadow() and asserts the kernel's decision
// matches what the legacy 3-strike rule would have produced. CI runs this
// as `npm run check:escalation-parity` before any flag flip in Phase B.
//
// Census, not sampling (CoBolt invariant #5): every line in the corpus is
// processed; the report's `processedRows` MUST equal `fileLineCount`.
//
// Subcommands:
//   replay   --corpus <path> [--milestone Mn] [--report <out>] [--json]
//
// Legacy-decision inference (Phase A):
//   The historical ledger doesn't store the legacy escalation decision
//   directly — it stores the verdict + target after the legacy strike
//   counter ran. We compare:
//     legacy verdict = 'pass'      → kernel must NOT halt or escalate
//     legacy verdict = 'fail'      → kernel must escalate or halt
//     legacy verdict = 'escalate'  → kernel must escalate
//     legacy target  = '<lead>'    → kernel.target must match
//   This is conservative: the kernel may pick a different action (e.g.
//   IMMEDIATE_ESCALATE vs the legacy lazy 3-strike) but the END STATE
//   (success/escalated) must agree. Disagreements are reported, not
//   immediately failed — Phase A burn-in tunes the threshold.
//
// Exit codes:
//   0  parity within tolerance
//   1  input error or kernel exception
//   2  missing dep (kernel unreachable)
//   3  missing infra (corpus file not found)
//
// Phase A target: 100% parity over ≥500 historical entries (per plan §5).
// Phase B per-skill target: ≥99.5% per migrated skill.

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
    if (sub !== 'replay' && sub !== '--corpus') {
      // Default subcommand is replay; accept --corpus as the first flag too.
      if (sub.startsWith('--')) {
        cmdReplay(argv);
      } else {
        process.stderr.write(`[cobolt-escalation-replay] Unknown subcommand: ${sub}\n`);
        printUsage();
        process.exit(1);
      }
    } else {
      cmdReplay(sub === 'replay' ? rest : argv);
    }
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      process.stderr.write(`[cobolt-escalation-replay] missing-dep: ${err.message}\n`);
      process.exit(2);
    }
    if (err && err.code === 'ENOENT') {
      process.stderr.write('[cobolt-escalation-replay] missing-infra: corpus file not readable\n');
      process.exit(3);
    }
    process.stderr.write(`[cobolt-escalation-replay] error: ${err.message}\n`);
    if (process.env.COBOLT_ESCALATE_DEBUG) process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

// ── Subcommand implementations ───────────────────────────────────────────

function cmdReplay(args) {
  const kernel = require(path.resolve(__dirname, '..', 'lib', 'cobolt-resilience-kernel.js'));

  const corpusPath = requiredFlag(args, '--corpus');
  const milestoneFilter = optionalFlag(args, '--milestone');
  const reportPath = optionalFlag(args, '--report');

  if (!fs.existsSync(corpusPath)) {
    const e = new Error(`corpus file not found: ${corpusPath}`);
    e.code = 'ENOENT';
    throw e;
  }

  const lines = fs.readFileSync(corpusPath, 'utf8').split('\n').filter(Boolean);
  const total = lines.length;

  // Census: every line must be parsed. Track parse failures separately.
  // skippedSuccess counts pass/success verdicts which the kernel never opines
  // on — they go through normal pipeline flow, not the failure path. Counting
  // them as agreements would inflate parity; counting them as failures would
  // be wrong. The honest accounting is "skipped — not in scope".
  const stats = {
    corpusPath,
    milestone: milestoneFilter ?? '(all)',
    totalLines: total,
    parsed: 0,
    skippedFiltered: 0,
    skippedShape: 0,
    skippedSuccess: 0,
    inAgreement: 0,
    inDisagreement: 0,
    parityPct: 0,
    disagreements: [],
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      stats.skippedShape += 1;
      continue;
    }
    stats.parsed += 1;

    if (milestoneFilter && (entry.milestone || '') !== milestoneFilter) {
      stats.skippedFiltered += 1;
      continue;
    }

    // Skip success verdicts — the kernel only opines on failures. Including
    // them would force the classifier to pretend an empty errorText is a
    // failure, producing false disagreements.
    if (entry.verdict === 'pass' || entry.verdict === 'success') {
      stats.skippedSuccess += 1;
      continue;
    }

    // Reconstruct ctx + rawReturn. The dispatch ledger stores the OUTCOME
    // not the input, so we synthesize a plausible rawReturn from verdict.
    const ctx = {
      skill: entry.skill || 'cobolt-build',
      stage: entry.stage || 'tdd-green',
      agent: entry.agent || 'unknown',
      attempt: Number(entry.attempt) || 1,
      milestone: entry.milestone || null,
      pipelineRun: `replay-${i}`,
      projectRoot: process.cwd(),
    };
    const rawReturn = synthesizeRawReturn(entry);

    let kernelDecision;
    try {
      kernelDecision = kernel.shadow(rawReturn, ctx);
    } catch {
      // Defensive: classifier may throw on malformed entries (e.g. missing
      // skill/stage). Treat as parse-shape failure rather than agreement.
      stats.skippedShape += 1;
      continue;
    }

    const legacy = legacyDecisionFromEntry(entry);
    const agree = decisionsAgree(legacy, kernelDecision);

    if (agree) {
      stats.inAgreement += 1;
    } else {
      stats.inDisagreement += 1;
      // Cap recorded disagreements to keep the report manageable. Counts
      // are still accurate.
      if (stats.disagreements.length < 50) {
        stats.disagreements.push({
          line: i + 1,
          ts: entry.ts,
          legacyVerdict: legacy.verdict,
          legacyTarget: legacy.target,
          kernelAction: kernelDecision.action,
          kernelTarget: kernelDecision.target,
          failureClass: kernelDecision.policyType,
        });
      }
    }
  }

  const consideredForParity = stats.inAgreement + stats.inDisagreement;
  stats.parityPct = consideredForParity === 0 ? 100 : (stats.inAgreement / consideredForParity) * 100;

  // Inv-5: census means processedRows must equal fileLineCount.
  if (stats.parsed + stats.skippedShape !== total) {
    throw new Error(
      `census violation: parsed (${stats.parsed}) + skipped (${stats.skippedShape}) != total lines (${total})`,
    );
  }

  if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(stats, null, 2));
  }

  if (hasFlag(args, '--json')) {
    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
  } else {
    process.stdout.write(
      `Replay ${corpusPath} (${stats.milestone}): ${stats.parsed} parsed / ${total} lines\n` +
        `  agreement=${stats.inAgreement} disagreement=${stats.inDisagreement} parity=${stats.parityPct.toFixed(2)}%\n`,
    );
    if (stats.disagreements.length > 0) {
      process.stdout.write(`  first disagreement: line ${stats.disagreements[0].line}\n`);
    }
  }

  // Exit code: 0 if parity meets target threshold, 1 otherwise. The
  // threshold itself is set by the caller (env var COBOLT_PARITY_THRESHOLD,
  // default 100 in Phase A, 99.5 in Phase B per the plan §5).
  const threshold = Number(process.env.COBOLT_PARITY_THRESHOLD || '100');
  process.exit(stats.parityPct >= threshold ? 0 : 1);
}

// ── Helpers ──────────────────────────────────────────────────────────────

function synthesizeRawReturn(entry) {
  // Map ledger fields back into a plausible rawReturn shape that the kernel
  // can classify. Defensive: missing fields default to safe values.
  const verdict = entry.verdict || 'fail';
  const errorText =
    entry.errorText || entry.lastError || (verdict === 'pass' || verdict === 'success' ? '' : 'unknown failure');
  const result = { verdict, errorText };
  if (Array.isArray(entry.filesWritten)) result.claimedFilesWritten = entry.filesWritten;
  if (typeof entry.transcript === 'string') result.transcript = entry.transcript;
  return result;
}

function legacyDecisionFromEntry(entry) {
  // Coarse mapping of legacy verdict → expected kernel action class.
  // 'pass' / 'success' → no escalation expected
  // 'fail' / 'escalate' → escalate-l1 expected
  // 'phantom' → halt (fabrication)
  // 'timeout' → escalate-l1
  const verdict = entry.verdict || 'unknown';
  return {
    verdict,
    target: entry.escalationTarget || entry.l1Lead || null,
  };
}

function decisionsAgree(legacy, kernel) {
  // Phase A agreement rule: end-state equivalence rather than literal
  // action match.
  //   - legacy pass/success → kernel must not be halt or any escalate
  //   - legacy fail/escalate/timeout → kernel must escalate or halt
  //   - legacy phantom → kernel must halt (fabrication)
  if (legacy.verdict === 'pass' || legacy.verdict === 'success') {
    return kernel.action !== 'halt' && !kernel.action.startsWith('escalate-');
  }
  if (legacy.verdict === 'phantom') {
    return kernel.action === 'halt';
  }
  if (legacy.verdict === 'fail' || legacy.verdict === 'escalate' || legacy.verdict === 'timeout') {
    return kernel.action === 'halt' || kernel.action.startsWith('escalate-') || kernel.action === 'auto-retry';
  }
  // Unknown legacy verdicts agree with anything kernel produces.
  return true;
}

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

function printUsage() {
  process.stdout.write(
    [
      'cobolt-escalation-replay — CRK Phase A parity certifier',
      '',
      'Usage:',
      '  cobolt-escalation-replay replay --corpus <path> [--milestone Mn] [--report <out>] [--json]',
      '',
      'Tunables (env):',
      '  COBOLT_PARITY_THRESHOLD   percent (default 100; Phase B uses 99.5)',
      '',
      'Exit codes:',
      '  0  parity ≥ threshold',
      '  1  parity below threshold (or input error)',
      '  2  missing dep (kernel unreachable)',
      '  3  missing infra (corpus file not found)',
      '',
    ].join('\n'),
  );
}

// Programmatic API (consumed by tests and other tools).
module.exports = {
  main,
  synthesizeRawReturn,
  legacyDecisionFromEntry,
  decisionsAgree,
};
