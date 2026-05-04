#!/usr/bin/env node

// CoBolt Context Route Usage Telemetry — Phase 5 of docs/cobolt-context-routing-plan.md.
//
// Records routing quality signals to _cobolt-output/audit/context-route-usage.jsonl:
//   - selected paths count
//   - parked paths later expanded
//   - omitted paths later needed
//   - prompt size before/after routing
//   - runtime cost difference
//   - test pass/fail outcome
//   - review finding count
//   - fix loop attempts
//
// Purely additive. No gate consumes this yet — it's input to the future
// Phase 7 promotion decision. Fail-open: every call silently no-ops on
// error so the pipeline is never blocked by telemetry.
//
// Usage:
//   node tools/cobolt-context-route-usage.js record --stage fix --milestone M1 ...
//   node tools/cobolt-context-route-usage.js summary [--stage fix] [--since ISO]
//   node tools/cobolt-context-route-usage.js tail [--n 20]

const fs = require('node:fs');
const path = require('node:path');

const USAGE_SCHEMA_VERSION = '1.0.0';

function safeRequire(modulePath) {
  try {
    return require(modulePath);
  } catch {
    return null;
  }
}
const pathsMod = safeRequire('../lib/cobolt-paths');

function auditPath(projectRoot) {
  const root = path.resolve(projectRoot || process.cwd());
  if (typeof pathsMod === 'function') {
    try {
      const p = pathsMod(root);
      if (p?.auditDir) return path.join(p.auditDir(), 'context-route-usage.jsonl');
    } catch {
      /* fall through */
    }
  }
  return path.join(root, '_cobolt-output', 'audit', 'context-route-usage.jsonl');
}

// ── Recording ────────────────────────────────────────────────

const WARN_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

function warnIfLarge(outPath) {
  try {
    const st = fs.statSync(outPath);
    if (st.size > WARN_SIZE_BYTES && process.env.COBOLT_CONTEXT_ROUTER_QUIET !== '1') {
      // One-time signal per process to avoid log spam on high-frequency callers.
      if (!warnIfLarge._warned) {
        warnIfLarge._warned = new Set();
      }
      if (!warnIfLarge._warned.has(outPath)) {
        warnIfLarge._warned.add(outPath);
        console.error(
          `  [context-route-usage] ${outPath} is ${Math.round(st.size / (1024 * 1024))}MB — consider archival; routing telemetry is append-only`,
        );
      }
    }
  } catch {
    /* no stat — file may not exist yet; no warning needed */
  }
}

function recordUsage(projectRoot, entry) {
  try {
    const outPath = auditPath(projectRoot);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    warnIfLarge(outPath);
    const payload = {
      ts: new Date().toISOString(),
      version: USAGE_SCHEMA_VERSION,
      ...sanitizeEntry(entry || {}),
    };
    fs.appendFileSync(outPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    return { ok: true, path: outPath };
  } catch (err) {
    // Fail-open: telemetry must never break the pipeline.
    if (process.env.COBOLT_CONTEXT_ROUTER_DEBUG === '1') {
      console.error(`  [context-route-usage] record failed: ${err.message}`);
    }
    return { ok: false, error: err.message };
  }
}

function sanitizeEntry(entry) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const nullableInt = (v) => (Number.isFinite(Number.parseInt(v, 10)) ? Number.parseInt(v, 10) : null);
  return {
    stage: entry.stage ? String(entry.stage) : null,
    milestone: entry.milestone ? String(entry.milestone) : null,
    skill: entry.skill ? String(entry.skill) : null,
    agent: entry.agent ? String(entry.agent) : null,
    routePath: entry.routePath ? String(entry.routePath) : null,
    mode: entry.mode === 'enforce' ? 'enforce' : entry.mode === 'observe' ? 'observe' : null,
    selectedCount: nullableInt(entry.selectedCount),
    parkedCount: nullableInt(entry.parkedCount),
    omittedCount: nullableInt(entry.omittedCount),
    parkedExpanded: nullableInt(entry.parkedExpanded),
    omittedNeeded: nullableInt(entry.omittedNeeded),
    promptCharsBefore: nullableInt(entry.promptCharsBefore),
    promptCharsAfter: nullableInt(entry.promptCharsAfter),
    costUsdBefore: num(entry.costUsdBefore),
    costUsdAfter: num(entry.costUsdAfter),
    testsPassed: toBool(entry.testsPassed),
    reviewFindings: nullableInt(entry.reviewFindings),
    fixAttempts: nullableInt(entry.fixAttempts),
    outcome: entry.outcome ? String(entry.outcome) : null,
    note: entry.note ? String(entry.note).slice(0, 500) : null,
  };
}

function toBool(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'pass', 'passed'].includes(s)) return true;
  if (['0', 'false', 'no', 'fail', 'failed'].includes(s)) return false;
  return null;
}

// ── Reading / summarizing ───────────────────────────────────

function readUsage(projectRoot) {
  const outPath = auditPath(projectRoot);
  if (!fs.existsSync(outPath)) return [];
  const lines = fs.readFileSync(outPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* skip malformed line */
    }
  }
  return entries;
}

function summarizeUsage(projectRoot, options = {}) {
  const entries = readUsage(projectRoot).filter((e) => {
    if (options.stage && e.stage !== options.stage) return false;
    if (options.since && e.ts && e.ts < options.since) return false;
    return true;
  });
  const total = entries.length;
  if (total === 0) {
    return {
      total: 0,
      byStage: {},
      promptReductionMean: null,
      costReductionMean: null,
      testsPassedRate: null,
      parkedExpansionRate: null,
      omittedMissRate: null,
    };
  }
  const byStage = {};
  let promptDeltaSum = 0;
  let promptDeltaN = 0;
  let costDeltaSum = 0;
  let costDeltaN = 0;
  let testsPassedN = 0;
  let testsSeenN = 0;
  let parkedExpanded = 0;
  let parkedTotal = 0;
  let omittedNeeded = 0;
  let omittedTotal = 0;
  for (const e of entries) {
    const key = e.stage || 'unknown';
    byStage[key] = (byStage[key] || 0) + 1;
    if (Number.isFinite(e.promptCharsBefore) && Number.isFinite(e.promptCharsAfter)) {
      promptDeltaSum += e.promptCharsAfter - e.promptCharsBefore;
      promptDeltaN += 1;
    }
    if (Number.isFinite(e.costUsdBefore) && Number.isFinite(e.costUsdAfter)) {
      costDeltaSum += e.costUsdAfter - e.costUsdBefore;
      costDeltaN += 1;
    }
    if (typeof e.testsPassed === 'boolean') {
      testsSeenN += 1;
      if (e.testsPassed) testsPassedN += 1;
    }
    if (Number.isFinite(e.parkedCount) && Number.isFinite(e.parkedExpanded)) {
      parkedTotal += e.parkedCount;
      parkedExpanded += e.parkedExpanded;
    }
    if (Number.isFinite(e.omittedCount) && Number.isFinite(e.omittedNeeded)) {
      omittedTotal += e.omittedCount;
      omittedNeeded += e.omittedNeeded;
    }
  }
  return {
    total,
    byStage,
    promptReductionMean: promptDeltaN > 0 ? promptDeltaSum / promptDeltaN : null,
    costReductionMean: costDeltaN > 0 ? costDeltaSum / costDeltaN : null,
    testsPassedRate: testsSeenN > 0 ? testsPassedN / testsSeenN : null,
    parkedExpansionRate: parkedTotal > 0 ? parkedExpanded / parkedTotal : null,
    omittedMissRate: omittedTotal > 0 ? omittedNeeded / omittedTotal : null,
  };
}

function tailUsage(projectRoot, n = 20) {
  const entries = readUsage(projectRoot);
  const slice = entries.slice(-Math.max(1, Number(n) || 20));
  return slice;
}

// ── CLI ──────────────────────────────────────────────────────

function flagValue(args, flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : null;
}

function printUsage() {
  console.log(`  CoBolt Context Route Usage — telemetry recorder

  Usage:
    node tools/cobolt-context-route-usage.js record [flags]
    node tools/cobolt-context-route-usage.js summary [--stage NAME] [--since ISO] [--json]
    node tools/cobolt-context-route-usage.js tail [--n 20] [--json]

  Record flags (any subset):
    --stage NAME              --milestone ID            --skill NAME
    --agent NAME              --route-path PATH         --mode observe|enforce
    --selected N              --parked N                --omitted N
    --parked-expanded N       --omitted-needed N
    --prompt-before N         --prompt-after N
    --cost-before USD         --cost-after USD
    --tests-passed 1|0        --review-findings N       --fix-attempts N
    --outcome TEXT            --note TEXT
`);
}

function main(argv) {
  const args = argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    printUsage();
    process.exit(0);
  }
  if (cmd === 'record') {
    const entry = {
      stage: flagValue(args, '--stage'),
      milestone: flagValue(args, '--milestone'),
      skill: flagValue(args, '--skill'),
      agent: flagValue(args, '--agent'),
      routePath: flagValue(args, '--route-path'),
      mode: flagValue(args, '--mode'),
      selectedCount: flagValue(args, '--selected'),
      parkedCount: flagValue(args, '--parked'),
      omittedCount: flagValue(args, '--omitted'),
      parkedExpanded: flagValue(args, '--parked-expanded'),
      omittedNeeded: flagValue(args, '--omitted-needed'),
      promptCharsBefore: flagValue(args, '--prompt-before'),
      promptCharsAfter: flagValue(args, '--prompt-after'),
      costUsdBefore: flagValue(args, '--cost-before'),
      costUsdAfter: flagValue(args, '--cost-after'),
      testsPassed: flagValue(args, '--tests-passed'),
      reviewFindings: flagValue(args, '--review-findings'),
      fixAttempts: flagValue(args, '--fix-attempts'),
      outcome: flagValue(args, '--outcome'),
      note: flagValue(args, '--note'),
    };
    const result = recordUsage(process.cwd(), entry);
    if (args.includes('--json')) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.ok) {
      console.log(`  Recorded to ${path.relative(process.cwd(), result.path)}`);
    } else {
      console.error(`  Record failed: ${result.error}`);
      process.exit(1);
    }
    return;
  }
  if (cmd === 'summary') {
    const summary = summarizeUsage(process.cwd(), {
      stage: flagValue(args, '--stage'),
      since: flagValue(args, '--since'),
    });
    if (args.includes('--json')) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`  Usage summary (total=${summary.total})`);
      console.log(`    byStage: ${JSON.stringify(summary.byStage)}`);
      console.log(`    promptReductionMean: ${summary.promptReductionMean ?? 'n/a'}`);
      console.log(`    costReductionMean:   ${summary.costReductionMean ?? 'n/a'}`);
      console.log(`    testsPassedRate:     ${summary.testsPassedRate ?? 'n/a'}`);
      console.log(`    parkedExpansionRate: ${summary.parkedExpansionRate ?? 'n/a'}`);
      console.log(`    omittedMissRate:     ${summary.omittedMissRate ?? 'n/a'}`);
    }
    return;
  }
  if (cmd === 'tail') {
    const entries = tailUsage(process.cwd(), flagValue(args, '--n'));
    if (args.includes('--json')) {
      console.log(JSON.stringify(entries, null, 2));
    } else {
      for (const e of entries) {
        console.log(
          `  [${e.ts}] stage=${e.stage || '?'} m=${e.milestone || '?'} sel=${e.selectedCount ?? '?'} out=${e.outcome || '?'}`,
        );
      }
    }
    return;
  }
  console.error(`  Unknown command: ${cmd}`);
  printUsage();
  process.exit(2);
}

module.exports = {
  recordUsage,
  summarizeUsage,
  tailUsage,
  readUsage,
  auditPath,
  USAGE_SCHEMA_VERSION,
};

if (require.main === module) {
  main(process.argv);
}
