#!/usr/bin/env node

// CoBolt Perf Mandatory Verifier
//
// Verifies a fresh, passing perf verdict exists for a milestone at
//   _cobolt-output/latest/perf/{M}-perf-verdict.json
//
// Required shape:
//   {
//     measuredAt:    ISO timestamp (<= 72h stale)
//     gitSha:        matches current HEAD
//     milestone:     "M<n>"
//     measurements:  { p50, p95, p99, rps, bundleSizeKb } all numeric
//     budget:        object (present, non-empty)
//     verdict:       "PASS" | "FAIL"
//   }
//
// Usage:
//   node tools/cobolt-perf-mandatory.js --check [--milestone M2] [--json]
//
// Programmatic:
//   const { checkPerfMandatory } = require('./cobolt-perf-mandatory');
//   checkPerfMandatory({ milestone: 'M2', cwd: process.cwd() })
//     => { ok, reason, verdict }

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const STALE_MS = 72 * 60 * 60 * 1000;
const REQUIRED_METRICS = ['p50', 'p95', 'p99', 'rps', 'bundleSizeKb'];

function readJson(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

function currentGitSha(cwd) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function currentMilestone(cwd) {
  try {
    const sp = path.join(cwd, 'cobolt-state.json');
    if (!fs.existsSync(sp)) return null;
    const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
    return s.pipeline?.currentMilestone || s.currentMilestone || null;
  } catch {
    return null;
  }
}

function verdictPath(cwd, milestone) {
  return path.join(cwd, '_cobolt-output', 'latest', 'perf', `${milestone}-perf-verdict.json`);
}

function checkPerfMandatory(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const milestone = opts.milestone || currentMilestone(cwd);
  if (!milestone) {
    return {
      ok: false,
      reason: 'no current milestone determined (pass --milestone or init cobolt-state.json)',
      verdict: null,
    };
  }

  const fp = verdictPath(cwd, milestone);
  if (!fs.existsSync(fp)) {
    return {
      ok: false,
      reason: `perf verdict missing: ${fp}. Run \`npm run test:perf\` and record via cobolt-perf-measure.`,
      verdict: null,
    };
  }

  const v = readJson(fp);
  if (!v || typeof v !== 'object') {
    return { ok: false, reason: `perf verdict unreadable or invalid JSON: ${fp}`, verdict: null };
  }

  if (!v.measuredAt) {
    return { ok: false, reason: 'perf verdict missing "measuredAt" timestamp', verdict: v };
  }
  const measuredMs = Date.parse(v.measuredAt);
  if (!Number.isFinite(measuredMs)) {
    return { ok: false, reason: `perf verdict has invalid "measuredAt": ${v.measuredAt}`, verdict: v };
  }
  const ageMs = Date.now() - measuredMs;
  if (ageMs > STALE_MS) {
    const hours = Math.round(ageMs / 3600000);
    return {
      ok: false,
      reason: `perf verdict stale (${hours}h old, limit 72h). Re-run \`npm run test:perf\`.`,
      verdict: v,
    };
  }

  const m = v.measurements || {};
  const missing = REQUIRED_METRICS.filter((k) => typeof m[k] !== 'number' || !Number.isFinite(m[k]));
  if (missing.length) {
    return { ok: false, reason: `perf verdict missing numeric measurements: ${missing.join(', ')}`, verdict: v };
  }

  if (!v.budget || typeof v.budget !== 'object' || Object.keys(v.budget).length === 0) {
    return { ok: false, reason: 'perf verdict missing "budget" section (must match TRD)', verdict: v };
  }

  if (v.verdict !== 'PASS' && v.verdict !== 'FAIL') {
    return {
      ok: false,
      reason: `perf verdict field must be "PASS" or "FAIL", got ${JSON.stringify(v.verdict)}`,
      verdict: v,
    };
  }
  if (v.verdict === 'FAIL') {
    return { ok: false, reason: 'perf verdict is FAIL — measured performance does not meet budget', verdict: v };
  }

  const headSha = currentGitSha(cwd);
  if (headSha && v.gitSha && v.gitSha !== headSha) {
    return {
      ok: false,
      reason: `perf verdict gitSha mismatch (verdict=${v.gitSha.slice(0, 8)} HEAD=${headSha.slice(0, 8)}). Re-run perf on current commit.`,
      verdict: v,
    };
  }
  if (!v.gitSha) {
    return { ok: false, reason: 'perf verdict missing "gitSha" (cannot confirm measurement is current)', verdict: v };
  }

  return { ok: true, reason: 'perf verdict present, fresh, matches HEAD, and PASS', verdict: v };
}

function parseArgs(argv) {
  const out = { check: false, milestone: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') out.check = true;
    else if (argv[i] === '--milestone') out.milestone = argv[++i];
    else if (argv[i] === '--json') out.json = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = checkPerfMandatory({ milestone: args.milestone });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.ok ? 'OK' : 'FAIL'}: ${result.reason}`);
  }
  return result.ok ? 0 : 1;
}

if (require.main === module) process.exit(main());

module.exports = { checkPerfMandatory, STALE_MS, REQUIRED_METRICS };
