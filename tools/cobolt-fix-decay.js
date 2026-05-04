#!/usr/bin/env node

// CoBolt Fix-Loop Decay Analyzer (v0.12.0 Phase 3C)
//
// The existing fix loop detects plateau (flat finding count over N iterations)
// and escalates via LOOP_PIVOT / LOOP_ARCH_ESCALATE / LOOP_ARCH_MUTATE. What
// was missing: **decay analysis** — detecting when fix iterations are making
// the codebase WORSE (finding count rising, not flat). Plateau is "stuck";
// decay is "regressing." Both should trigger escalation but decay should do
// it sooner because continuing wastes budget creating new bugs.
//
// This tool reads fix-verdict-iter-*.json files, computes per-iteration
// finding counts, and classifies the trajectory:
//
//   improving:  counts strictly decreasing
//   plateau:    counts equal for N>=threshold iterations (existing behavior)
//   decay:      counts increasing for 2+ consecutive iterations
//   volatile:   oscillating (up, down, up) — sign of flaky tests or race
//   complete:   counts reached 0
//
// v0.13.1 adds per-finding plateau tracking via classifyPerFinding().
//
// Usage:
//   node tools/cobolt-fix-decay.js analyze [--milestone M3]
//   node tools/cobolt-fix-decay.js analyze --json
//   node tools/cobolt-fix-decay.js analyze-findings [--milestone M3] [--json]
//
// Env:
//   COBOLT_PLATEAU_THRESHOLD   iterations of equal count before plateau (default: 3)
//   COBOLT_DECAY_THRESHOLD     iterations of rising count before decay (default: 2)

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PLATEAU = Number(process.env.COBOLT_PLATEAU_THRESHOLD || 3);
const DEFAULT_DECAY = Number(process.env.COBOLT_DECAY_THRESHOLD || 2);

function findVerdicts(milestone) {
  const cwd = process.cwd();
  const dirs = [];
  if (milestone) {
    dirs.push(path.join(cwd, '_cobolt-output', 'latest', 'fix', milestone));
    dirs.push(path.join(cwd, '_cobolt-output', 'fix', milestone));
  } else {
    const root = path.join(cwd, '_cobolt-output', 'latest', 'fix');
    if (fs.existsSync(root)) {
      for (const e of fs.readdirSync(root)) {
        const full = path.join(root, e);
        try {
          if (fs.statSync(full).isDirectory()) dirs.push(full);
        } catch {}
      }
    }
  }
  const verdicts = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      const m = /^fix-verdict-iter-(\d+)\.json$/.exec(f);
      if (!m) continue;
      const full = path.join(d, f);
      try {
        const data = JSON.parse(fs.readFileSync(full, 'utf8'));
        verdicts.push({ iter: Number(m[1]), file: full, data });
      } catch (e) {
        // v0.16.1: surface corruption instead of silently skipping. A run of
        // corrupted verdict files causes decay classification to return
        // 'unknown' which callers treat as safe-to-continue — a silent stall.
        try {
          const auditDir = path.join(cwd, '_cobolt-output', 'audit');
          fs.mkdirSync(auditDir, { recursive: true });
          fs.appendFileSync(
            path.join(auditDir, 'fix-artifact-corruption.jsonl'),
            `${JSON.stringify({ at: new Date().toISOString(), file: full, error: e.message, stage: 'fix-decay' })}\n`,
          );
        } catch {
          /* best-effort */
        }
      }
    }
  }
  verdicts.sort((a, b) => a.iter - b.iter);
  return verdicts;
}

function extractCount(verdict) {
  const d = verdict.data || {};
  if (typeof d.findingsRemaining === 'number') return d.findingsRemaining;
  if (typeof d.remaining === 'number') return d.remaining;
  if (Array.isArray(d.findings)) return d.findings.length;
  if (d.counts && typeof d.counts.remaining === 'number') return d.counts.remaining;
  return null;
}

function classify(verdicts, opts = {}) {
  const plateau = opts.plateauThreshold || DEFAULT_PLATEAU;
  const decay = opts.decayThreshold || DEFAULT_DECAY;
  const series = verdicts.map((v) => ({ iter: v.iter, count: extractCount(v) })).filter((s) => s.count !== null);

  if (series.length === 0) {
    // Distinguish "never ran" from "all corrupted" — callers need to know
    // whether no-data is a silent stall or a pre-iteration clean state.
    const auditFile = path.join(process.cwd(), '_cobolt-output', 'audit', 'fix-artifact-corruption.jsonl');
    const hasCorruption = fs.existsSync(auditFile);
    return {
      verdict: hasCorruption ? 'corruption-detected' : 'no-data',
      series: [],
      corruptionLog: hasCorruption ? auditFile : null,
    };
  }
  if (series[series.length - 1].count === 0) return { verdict: 'complete', series };

  let risingStreak = 0;
  let maxRise = 0;
  for (let i = 1; i < series.length; i++) {
    if (series[i].count > series[i - 1].count) {
      risingStreak++;
      maxRise = Math.max(maxRise, risingStreak);
    } else risingStreak = 0;
  }
  if (maxRise >= decay) {
    return {
      verdict: 'decay',
      recommendation: 'LOOP_ARCH_MUTATE',
      reason: `finding count rose for ${maxRise} consecutive iterations — fixes are regressing codebase`,
      series,
    };
  }

  const last = series.slice(-plateau);
  const flat = last.length >= plateau && last.every((s) => s.count === last[0].count);
  if (flat) {
    return {
      verdict: 'plateau',
      recommendation: 'LOOP_ARCH_ESCALATE',
      reason: `finding count flat at ${last[0].count} for ${plateau} iterations`,
      series,
    };
  }

  if (series.length >= 3) {
    const [a, b, c] = series.slice(-3).map((s) => s.count);
    if ((a < b && b > c) || (a > b && b < c)) {
      return {
        verdict: 'volatile',
        recommendation: 'LOOP_PIVOT',
        reason: `count oscillating ${a}→${b}→${c} — likely flaky tests or race conditions`,
        series,
      };
    }
  }

  if (series.length >= 3) {
    const [a, b, c] = series.slice(-3).map((s) => s.count);
    if (a > b && b > c) return { verdict: 'improving', series };
  }

  return { verdict: 'progressing', series };
}

// v0.13.1 perf: per-finding plateau tracking. Aggregate count classification
// answers "is the loop stuck?" but not "is THIS finding stuck?" One
// persistently-stuck finding can drag the whole loop into LOOP_PIVOT when
// 90% of findings are improving. Per-finding classification lets the
// orchestrator escalate (architect-fix dispatch) only the stuck items.
function extractFindingIds(verdict) {
  const d = verdict.data || {};
  const arr = Array.isArray(d.findings) ? d.findings : Array.isArray(d.findingsRemaining) ? d.findingsRemaining : null;
  if (!arr) return null;
  return arr
    .map((f) => (typeof f === 'string' ? f : f && (f.id || f.findingId)))
    .filter((id) => typeof id === 'string' && id.length > 0);
}

function classifyPerFinding(verdicts, opts = {}) {
  const stuckThreshold = opts.stuckThreshold || DEFAULT_PLATEAU;
  const series = verdicts.map((v) => ({ iter: v.iter, ids: extractFindingIds(v) })).filter((s) => Array.isArray(s.ids));

  if (series.length === 0) return { verdict: 'no-data', findings: [] };

  const presence = new Map();
  for (const { iter, ids } of series) {
    for (const id of ids) {
      if (!presence.has(id)) presence.set(id, []);
      presence.get(id).push(iter);
    }
  }

  const findings = [];
  for (const [id, iters] of presence.entries()) {
    iters.sort((a, b) => a - b);
    let run = 1;
    for (let i = iters.length - 1; i > 0; i--) {
      if (iters[i] - iters[i - 1] === 1) run++;
      else break;
    }
    const stuck = run >= stuckThreshold;
    findings.push({
      id,
      iterations: iters,
      consecutiveStreak: run,
      stuck,
      recommendation: stuck ? 'PER_FINDING_ARCH_ESCALATE' : null,
      reason: stuck
        ? `finding ${id} unresolved for ${run} consecutive iterations — escalate this finding only, do not pivot whole loop`
        : null,
    });
  }

  findings.sort((a, b) => Number(b.stuck) - Number(a.stuck) || b.consecutiveStreak - a.consecutiveStreak);
  const stuckCount = findings.filter((f) => f.stuck).length;
  return {
    verdict: stuckCount > 0 ? 'per-finding-plateau' : 'per-finding-progressing',
    stuckCount,
    totalTracked: findings.length,
    iterations: series.length,
    findings,
  };
}

function parseFlags(args) {
  const out = { _: [], milestone: null, json: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--milestone') out.milestone = args[++i];
    else if (args[i] === '--json') out.json = true;
    else out._.push(args[i]);
  }
  return out;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (cmd) {
    case 'analyze': {
      const verdicts = findVerdicts(flags.milestone);
      const result = classify(verdicts);
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`verdict: ${result.verdict}`);
        if (result.recommendation) console.log(`recommendation: ${result.recommendation}`);
        if (result.reason) console.log(`reason: ${result.reason}`);
        console.log('series:');
        for (const s of result.series) console.log(`  iter ${s.iter}: ${s.count}`);
      }
      return result.verdict === 'decay' ? 1 : 0;
    }
    case 'analyze-findings': {
      const verdicts = findVerdicts(flags.milestone);
      const result = classifyPerFinding(verdicts);
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`verdict: ${result.verdict}`);
        console.log(`stuck: ${result.stuckCount || 0} of ${result.totalTracked || 0} findings`);
        for (const f of (result.findings || []).filter((x) => x.stuck)) {
          console.log(`  - ${f.id} (streak=${f.consecutiveStreak}): ${f.reason}`);
        }
      }
      return result.stuckCount > 0 ? 1 : 0;
    }
    default:
      console.error('Usage: cobolt-fix-decay.js <analyze|analyze-findings> [--milestone M3] [--json]');
      return 1;
  }
}

if (require.main === module) process.exit(main());

module.exports = { classify, extractCount, findVerdicts, classifyPerFinding, extractFindingIds };
