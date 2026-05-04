#!/usr/bin/env node

// CoBolt Production-Readiness Telemetry
//
// Writes structured events to _cobolt-output/audit/production-readiness.jsonl
// and maintains 6 composite metrics under cobolt-state.json:metrics.
//
// Events:
//   record <metric> <value> [--milestone M1] [--meta '{"...":"..."}']
//   score <milestone> <0-100>              # composite productionReadyScore
//   show                                    # print current metrics
//   export                                  # raw jsonl stream
//
// Metrics tracked:
//   crossMilestoneSmokeFailures, contractViolations, behaviorCoverageGaps,
//   fixLoopPlateaus, perfBudgetExceeded, productionReadyScore (map)
//
// Used by: Tier 1 gates (contract, smoke, behavior-coverage, perf-budget),
//          fix loop plateau detector, milestone-report.

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJSON } = require('../lib/cobolt-atomic-write');
const METRICS = [
  'crossMilestoneSmokeFailures',
  'contractViolations',
  'contractInventions',
  'behaviorCoverageGaps',
  'behaviorRealismRejects',
  'fixLoopPlateaus',
  'perfBudgetExceeded',
  // ── v0.13 rigorous-mode metrics (plan §5 / §S12) ───────────
  'humanApprovalRate',
  'humanRejectionCount',
  'mutationScore',
  'independentTestPassRate',
  'loadChaosVerdict',
  'invariantViolationsCaught',
  'crossMilestoneRegressionCaught',
  'rigorousCompositeScore',
];

// Numeric metrics accept a non-negative delta via `record`.
// String/enum metrics (loadChaosVerdict) are written via `setMetric`.
const NUMERIC_METRICS = new Set([
  'crossMilestoneSmokeFailures',
  'contractViolations',
  'contractInventions',
  'behaviorCoverageGaps',
  'behaviorRealismRejects',
  'fixLoopPlateaus',
  'perfBudgetExceeded',
  'humanRejectionCount',
  'invariantViolationsCaught',
  'crossMilestoneRegressionCaught',
]);

// Rate metrics (0..1) that are set (not accumulated).
const RATE_METRICS = new Set(['humanApprovalRate', 'mutationScore', 'independentTestPassRate']);

function paths() {
  try {
    const mod = require('../lib/cobolt-paths');
    const p = typeof mod === 'function' ? mod() : typeof mod.paths === 'function' ? mod.paths() : mod;
    return p;
  } catch {
    const out = path.join(process.cwd(), '_cobolt-output');
    return {
      outputRoot: out,
      audit: () => path.join(out, 'audit'),
      productionReadinessLog: () => path.join(out, 'audit', 'production-readiness.jsonl'),
    };
  }
}

function stateFile() {
  return path.join(process.cwd(), 'cobolt-state.json');
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  atomicWriteJSON(stateFile(), state, { mode: 0o600 });
}

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
}

function appendEvent(event) {
  const p = paths();
  const fp = p.productionReadinessLog();
  ensureDir(path.dirname(fp));
  fs.appendFileSync(fp, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

function record(metric, value, opts = {}) {
  if (!METRICS.includes(metric)) {
    throw new Error(`Unknown metric: ${metric}. Valid: ${METRICS.join(', ')}`);
  }
  if (!NUMERIC_METRICS.has(metric)) {
    // For rate/enum metrics, treat record as "set latest".
    return setMetric(metric, value, opts);
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`value must be non-negative number, got ${value}`);

  const state = readState();
  state.metrics ||= {};
  const prev = Number(state.metrics[metric] || 0);
  state.metrics[metric] = prev + n;
  writeState(state);

  appendEvent({
    ts: new Date().toISOString(),
    kind: 'metric',
    metric,
    delta: n,
    total: state.metrics[metric],
    milestone: opts.milestone || null,
    meta: opts.meta || null,
  });
  return state.metrics[metric];
}

/** Set (overwrite) a metric's latest value. For rates/enums. */
function setMetric(metric, value, opts = {}) {
  if (!METRICS.includes(metric)) {
    throw new Error(`Unknown metric: ${metric}. Valid: ${METRICS.join(', ')}`);
  }
  let v = value;
  if (RATE_METRICS.has(metric)) {
    v = Number(value);
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      throw new Error(`${metric} must be a number in [0,1], got ${value}`);
    }
  } else if (metric === 'loadChaosVerdict') {
    if (!['pass', 'fail', 'skipped'].includes(String(value))) {
      throw new Error(`loadChaosVerdict must be pass|fail|skipped, got ${value}`);
    }
    v = String(value);
  }
  const state = readState();
  state.metrics ||= {};
  state.metrics[metric] = v;
  writeState(state);
  appendEvent({
    ts: new Date().toISOString(),
    kind: 'metric-set',
    metric,
    value: v,
    milestone: opts.milestone || null,
    meta: opts.meta || null,
  });
  return v;
}

// ── Rigorous composite scoring (plan §S12) ─────────────────────

function safeReadJson(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

function listJsonl(fp) {
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Collect the 7 rigorous inputs from disk. Each returns {value, available, artifact}.
 * Missing inputs contribute 0 and are tallied in `skippedInputs`.
 */
function collectRigorousInputs(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const lastN = Number(opts.lastN || 3);
  const out = path.join(cwd, '_cobolt-output');

  // 1. humanApprovalRate — approved / (approved+rejected) over last N milestones.
  const humanLog = path.join(out, 'audit', 'human-approvals.jsonl');
  const humanEvents = listJsonl(humanLog).slice(-lastN * 10);
  let approved = 0,
    rejected = 0;
  for (const e of humanEvents) {
    const d = String(e.decision || e.verdict || '').toLowerCase();
    if (d === 'approved' || d === 'approve') approved++;
    else if (d === 'rejected' || d === 'reject') rejected++;
  }
  const humanTotal = approved + rejected;
  const humanApprovalRate = {
    value: humanTotal > 0 ? approved / humanTotal : 0,
    available: humanTotal > 0,
    artifact: humanTotal > 0 ? humanLog : null,
  };
  const humanRejectionCount = { value: rejected, available: humanTotal > 0, artifact: humanLog };

  // 2. mutationScore — last verify verdict's mutationScore field.
  const verifyDir = path.join(out, 'latest', 'verify');
  let mutationScore = { value: 0, available: false, artifact: null };
  let independentTestPassRate = { value: 0, available: false, artifact: null };
  let a11yDepthScore = { value: 0, available: false, artifact: null };
  let contractRuntimeConformance = { value: 0, available: false, artifact: null };
  if (fs.existsSync(verifyDir)) {
    const verdicts = fs
      .readdirSync(verifyDir)
      .filter((f) => f.endsWith('-verdict.json'))
      .sort()
      .reverse();
    for (const f of verdicts) {
      const fp = path.join(verifyDir, f);
      const v = safeReadJson(fp);
      if (!v) continue;
      if (!mutationScore.available && typeof v.mutationScore === 'number') {
        mutationScore = { value: clamp01(v.mutationScore), available: true, artifact: fp };
      }
      if (!independentTestPassRate.available && typeof v.independentTestPassRate === 'number') {
        independentTestPassRate = { value: clamp01(v.independentTestPassRate), available: true, artifact: fp };
      }
      if (!a11yDepthScore.available && typeof v.a11yDepthScore === 'number') {
        a11yDepthScore = { value: clamp01(v.a11yDepthScore), available: true, artifact: fp };
      }
      if (!contractRuntimeConformance.available && typeof v.contractRuntimeConformance === 'number') {
        contractRuntimeConformance = {
          value: clamp01(v.contractRuntimeConformance),
          available: true,
          artifact: fp,
        };
      }
      if (
        mutationScore.available &&
        independentTestPassRate.available &&
        a11yDepthScore.available &&
        contractRuntimeConformance.available
      )
        break;
    }
  }

  // 3. loadChaosVerdict — newest verdict.json under _cobolt-output/load-chaos/*/.
  const lcRoot = path.join(out, 'load-chaos');
  let loadChaosVerdict = { value: 'skipped', available: false, artifact: null };
  if (fs.existsSync(lcRoot)) {
    try {
      const subs = fs
        .readdirSync(lcRoot)
        .map((s) => path.join(lcRoot, s))
        .sort()
        .reverse();
      for (const s of subs) {
        const vp = path.join(s, 'verdict.json');
        if (fs.existsSync(vp)) {
          const j = safeReadJson(vp);
          if (j && typeof j.verdict === 'string') {
            loadChaosVerdict = { value: j.verdict, available: true, artifact: vp };
            break;
          }
        }
      }
    } catch {}
  }
  const loadChaosPass = loadChaosVerdict.value === 'pass' ? 1 : 0;

  // 4. invariantViolationsCaught — sum across *-violations.json, plus pass rate.
  const invDir = path.join(out, 'latest', 'invariants');
  let invariantViolationsCaught = { value: 0, available: false, artifact: null };
  let invariantPassRate = { value: 0, available: false, artifact: null };
  if (fs.existsSync(invDir)) {
    try {
      const files = fs.readdirSync(invDir).filter((f) => f.endsWith('-violations.json'));
      if (files.length) {
        let total = 0,
          checked = 0,
          caught = 0;
        const artifacts = [];
        for (const f of files) {
          const fp = path.join(invDir, f);
          const j = safeReadJson(fp) || {};
          caught += Number(j.caught || (Array.isArray(j.violations) ? j.violations.length : 0) || 0);
          checked += Number(j.checked || j.total || 0);
          total += 1;
          artifacts.push(fp);
        }
        invariantViolationsCaught = { value: caught, available: true, artifact: artifacts[0] || invDir };
        invariantPassRate = {
          value: checked > 0 ? Math.max(0, (checked - caught) / checked) : total > 0 ? 1 : 0,
          available: checked > 0,
          artifact: artifacts[0] || invDir,
        };
      }
    } catch {}
  }

  return {
    humanApprovalRate,
    humanRejectionCount,
    mutationScore,
    independentTestPassRate,
    loadChaosVerdict,
    loadChaosPass,
    invariantViolationsCaught,
    invariantPassRate,
    contractRuntimeConformance,
    a11yDepthScore,
  };
}

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return v > 1.0001 ? Math.min(1, v / 100) : 1; // tolerate 0-100 inputs
  return v;
}

/**
 * Compute rigorousCompositeScore from collected inputs. Weights per plan §S12.
 * Missing inputs contribute 0 and are tallied in `skippedInputs`.
 * Final score multiplied by 100 (0..100).
 */
function computeComposite(inputs) {
  const skipped = [];
  const input = (name, v) => {
    if (!v?.available) {
      skipped.push(name);
      return 0;
    }
    return Number(v.value) || 0;
  };
  const human = input('humanApprovalRate', inputs.humanApprovalRate);
  const mut = input('mutationScore', inputs.mutationScore);
  const ind = input('independentTestPassRate', inputs.independentTestPassRate);
  // loadChaosPass is 0|1 — available when verdict is present; otherwise skipped.
  let chaos = 0;
  if (inputs.loadChaosVerdict?.available) {
    chaos = inputs.loadChaosVerdict.value === 'pass' ? 1 : 0;
  } else {
    skipped.push('loadChaosPass');
  }
  const invP = input('invariantPassRate', inputs.invariantPassRate);
  const cRt = input('contractRuntimeConformance', inputs.contractRuntimeConformance);
  const a11y = input('a11yDepthScore', inputs.a11yDepthScore);

  const composite = 0.25 * human + 0.2 * mut + 0.15 * ind + 0.15 * chaos + 0.1 * invP + 0.1 * cRt + 0.05 * a11y;
  return { score: Math.round(composite * 100), skippedInputs: skipped };
}

/**
 * Collect rigorous inputs, persist all metrics to state.metrics, compute
 * composite, emit a `composite` event, and return the full result.
 */
function computeAndPersist(milestone, opts = {}) {
  const inputs = collectRigorousInputs(opts);
  const state = readState();
  state.metrics ||= {};
  state.metrics.humanApprovalRate = inputs.humanApprovalRate.value;
  state.metrics.humanRejectionCount = inputs.humanRejectionCount.value;
  state.metrics.mutationScore = inputs.mutationScore.value;
  state.metrics.independentTestPassRate = inputs.independentTestPassRate.value;
  state.metrics.loadChaosVerdict = inputs.loadChaosVerdict.value;
  state.metrics.invariantViolationsCaught = inputs.invariantViolationsCaught.value;
  const { score: composite, skippedInputs } = computeComposite(inputs);
  state.metrics.rigorousCompositeScore ||= {};
  if (milestone) state.metrics.rigorousCompositeScore[milestone] = composite;
  state.metrics.rigorousCompositeScore.latest = composite;
  state.metrics.skippedInputs = skippedInputs;
  writeState(state);
  appendEvent({
    ts: new Date().toISOString(),
    kind: 'composite',
    milestone: milestone || null,
    composite,
    skippedInputs,
    inputs,
  });
  return { composite, skippedInputs, inputs };
}

function score(milestone, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('score must be 0-100');
  const state = readState();
  state.metrics ||= {};
  state.metrics.productionReadyScore ||= {};
  state.metrics.productionReadyScore[milestone] = n;
  writeState(state);
  appendEvent({ ts: new Date().toISOString(), kind: 'score', milestone, score: n });
  return n;
}

function show() {
  const s = readState().metrics || {};
  const out = {
    productionReadyScore: s.productionReadyScore || {},
    rigorousCompositeScore: s.rigorousCompositeScore || {},
    skippedInputs: s.skippedInputs || [],
  };
  for (const m of METRICS) {
    if (m === 'rigorousCompositeScore') continue; // already included as map
    if (NUMERIC_METRICS.has(m) || RATE_METRICS.has(m)) {
      out[m] = Number(s[m] || 0);
    } else {
      out[m] = s[m] ?? null;
    }
  }
  return out;
}

function exportLog() {
  const fp = paths().productionReadinessLog();
  if (!fs.existsSync(fp)) return '';
  return fs.readFileSync(fp, 'utf8');
}

// ── CLI ─────────────────────────────────────────────────────

function parseFlags(args) {
  const out = { _: [], meta: null, milestone: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--milestone') out.milestone = args[++i];
    else if (a === '--meta') {
      try {
        out.meta = JSON.parse(args[++i]);
      } catch {
        out.meta = null;
      }
    } else out._.push(a);
  }
  return out;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  try {
    switch (cmd) {
      case 'record': {
        const [metric, value] = flags._;
        const total = record(metric, value, { milestone: flags.milestone, meta: flags.meta });
        console.log(JSON.stringify({ ok: true, metric, total }));
        return 0;
      }
      case 'score': {
        const [milestone, value] = flags._;
        const n = score(milestone, value);
        console.log(JSON.stringify({ ok: true, milestone, score: n }));
        return 0;
      }
      case 'set': {
        const [metric, value] = flags._;
        const v = setMetric(metric, value, { milestone: flags.milestone, meta: flags.meta });
        console.log(JSON.stringify({ ok: true, metric, value: v }));
        return 0;
      }
      case 'compute-composite':
      case 'compute': {
        const milestone = flags.milestone || flags._[0] || null;
        const r = computeAndPersist(milestone);
        console.log(JSON.stringify({ ok: true, milestone, ...r }, null, 2));
        return 0;
      }
      case 'show':
        console.log(JSON.stringify(show(), null, 2));
        return 0;
      case 'export':
        process.stdout.write(exportLog());
        return 0;
      default:
        console.error(
          'Usage: cobolt-production-readiness.js {record <metric> <value> [--milestone M] [--meta JSON] | score <M> <0-100> | show | export}',
        );
        console.error(`Metrics: ${METRICS.join(', ')}`);
        return 1;
    }
  } catch (err) {
    console.error(`[cobolt-production-readiness] ${err.message}`);
    return 1;
  }
}

if (require.main === module) process.exit(main());

module.exports = {
  record,
  setMetric,
  score,
  show,
  exportLog,
  collectRigorousInputs,
  computeComposite,
  computeAndPersist,
  METRICS,
  NUMERIC_METRICS,
  RATE_METRICS,
};
