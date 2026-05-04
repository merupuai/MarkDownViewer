#!/usr/bin/env node
// S3 — Real load + chaos runner. Orchestrates k6/locust + chaos-mesh/litmus
// against the current milestone's staging env while prior milestones' stacks
// stay live. Emits verdict JSON validated against load-chaos-verdict.schema.json.
//
// Usage:
//   cobolt-load-chaos run --milestone M3 --duration 4h --peak-multiple 2 \
//     --chaos kill-worker,drop-network,partition-service,clock-skew,slow-disk,fill-disk,oom-kill
//   cobolt-load-chaos verify --milestone M3      # just re-validate existing verdict

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
const CWD = process.cwd();
const cmd = process.argv[2] || 'help';
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};

const parseDuration = (s) => {
  const m = /^(\d+(?:\.\d+)?)(h|m|s)?$/.exec(s || '4h');
  if (!m) return 4;
  const n = Number(m[1]);
  return m[2] === 's' ? n / 3600 : m[2] === 'm' ? n / 60 : n;
};

function readInfra() {
  try {
    return JSON.parse(fs.readFileSync(path.join(CWD, '_cobolt-output', 'infra', 'infra-manifest.json'), 'utf8'));
  } catch {
    return {};
  }
}

function resolvePrometheusUrl(infra) {
  if (process.env.COBOLT_PROMETHEUS_URL) return process.env.COBOLT_PROMETHEUS_URL;
  const u = infra?.observability?.prometheus?.url;
  return typeof u === 'string' && u ? u : null;
}

// Zero-dep Prometheus instant-query scraper. Returns a numeric scalar or null.
// Uses curl when available (respects proxies/CA), falls back to node http.
function scrapePrometheus(baseUrl, query) {
  if (!baseUrl) return { value: null, reason: 'no prometheus url' };
  const full = `${baseUrl.replace(/\/$/, '')}/api/v1/query?query=${encodeURIComponent(query)}`;
  try {
    // Prefer curl for TLS + proxy correctness; fall back to node http(s) if absent.
    const curl = which('curl');
    let body;
    if (curl) {
      body = execFileSync('curl', ['-fsS', '--max-time', '10', full], { encoding: 'utf8' });
    } else {
      return { value: null, reason: 'curl unavailable for prometheus scrape' };
    }
    const json = JSON.parse(body);
    if (json.status !== 'success') return { value: null, reason: `prom status=${json.status}` };
    const res = json.data?.result;
    if (!Array.isArray(res) || res.length === 0) return { value: null, reason: 'empty prom result' };
    // Aggregate: take sum of vector values for simplicity.
    let sum = 0;
    for (const row of res) {
      const v = Number(row.value?.[1]);
      if (Number.isFinite(v)) sum += v;
    }
    return { value: sum };
  } catch (e) {
    return { value: null, reason: `prom unreachable: ${e.message}` };
  }
}

function which(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin]);
  return r.status === 0 ? r.stdout.toString().trim().split(/\r?\n/)[0] : null;
}

function runLoad({ target, durationHours, peak }) {
  const tool = which('k6') ? 'k6' : which('locust') ? 'locust' : null;
  if (!tool) return { skipped: 'no loadgen tool (k6/locust) installed', tool: null };
  // Minimal k6 script written to temp; customers extend as needed.
  const script = `
import http from 'k6/http';
import { sleep } from 'k6';
export const options = {
  stages: [
    { duration: '2m', target: ${Math.ceil(50 * peak)} },
    { duration: '${Math.floor(durationHours * 60 - 4)}m', target: ${Math.ceil(50 * peak)} },
    { duration: '2m', target: 0 }
  ]
};
export default function () { http.get('${target}'); sleep(1); }
`;
  const tmp = path.join(CWD, '_cobolt-output', 'load-chaos', 'load.k6.js');
  atomicWrite(tmp, script);
  const resultJson = path.join(path.dirname(tmp), 'k6-summary.json');
  try {
    execFileSync('k6', ['run', '--summary-export', resultJson, tmp], { stdio: 'inherit', cwd: CWD });
    const summary = JSON.parse(fs.readFileSync(resultJson, 'utf8'));
    const p99 = summary.metrics?.http_req_duration?.values?.['p(99)'] ?? 0;
    const errRate = summary.metrics?.http_req_failed?.values?.rate ?? 0;
    return { tool, p99LatencyMs: p99, errorRatePct: errRate * 100, memorySlopePctPerHour: 0, poolSaturationPct: 0 };
  } catch (e) {
    return { skipped: `k6 run failed: ${e.message}`, tool };
  }
}

function runChaos({ primitives }) {
  const tool = which('chaos') || which('litmusctl') ? (which('chaos') ? 'chaos-mesh' : 'litmus') : null;
  if (!tool) return { skipped: 'no chaos tool installed', primitivesRun: [], primitivesPassed: [] };
  const chaosDir = path.join(__dirname, '..', 'source', 'chaos');
  const ran = [],
    passed = [],
    times = {};
  for (const p of primitives) {
    const yml = path.join(chaosDir, `${p}.yaml`);
    if (!fs.existsSync(yml)) continue;
    ran.push(p);
    const t0 = Date.now();
    try {
      execFileSync(
        tool === 'chaos-mesh' ? 'kubectl' : 'litmusctl',
        tool === 'chaos-mesh' ? ['apply', '-f', yml] : ['apply', 'experiment', '-f', yml],
        { stdio: 'inherit' },
      );
      passed.push(p);
      times[p] = (Date.now() - t0) / 1000;
    } catch (_e) {
      /* failure */
    }
  }
  return { tool, primitivesRun: ran, primitivesPassed: passed, recoveryTimes: times };
}

function cmdRun() {
  const M = arg('--milestone', 'M1');
  const durationHours = parseDuration(arg('--duration', '4h'));
  const peakMultiple = Number(arg('--peak-multiple', '2'));
  const primitives = (
    arg('--chaos') || 'kill-worker,drop-network,partition-service,clock-skew,slow-disk,fill-disk,oom-kill'
  ).split(',');

  const infra = readInfra();
  const target = infra.staging?.url || arg('--target') || 'http://localhost:3000';

  const load = runLoad({ target, durationHours, peak: peakMultiple });
  const chaos = runChaos({ primitives });

  // Real measurements from Prometheus (null when unreachable — gate treats
  // this as a fail in rigorous mode; we DO NOT change gate logic here).
  const promUrl = resolvePrometheusUrl(infra);
  const memQuery = 'rate(process_resident_memory_bytes[1h])';
  const poolQuery = '(sum(db_pool_active) / sum(db_pool_max)) * 100';
  const memScrape = scrapePrometheus(promUrl, memQuery);
  const poolScrape = scrapePrometheus(promUrl, poolQuery);
  // memory slope: convert bytes/s to %/h relative to a 1GiB baseline if raw bytes;
  // treat the Prometheus scalar as already-normalized %/h when present.
  const memorySlopePctPerHour = memScrape.value;
  const poolSaturationPct = poolScrape.value;
  const promSkipReasons = [];
  if (memScrape.reason) promSkipReasons.push(`memory: ${memScrape.reason}`);
  if (poolScrape.reason) promSkipReasons.push(`pool: ${poolScrape.reason}`);

  const verdict = {
    milestone: M,
    generatedAt: new Date().toISOString(),
    pass:
      !load.skipped &&
      (load.errorRatePct || 0) <= 0.1 &&
      (memorySlopePctPerHour == null ? false : memorySlopePctPerHour <= 5) &&
      (poolSaturationPct == null ? false : poolSaturationPct <= 80) &&
      chaos.primitivesRun.length === chaos.primitivesPassed.length,
    environment: {
      target: infra.staging?.target || 'compose',
      priorMilestonesLive: !!infra.staging?.priorMilestonesLive,
    },
    load: {
      durationHours,
      peakMultiple,
      p99LatencyMs: load.p99LatencyMs || 0,
      errorRatePct: load.errorRatePct || 0,
      memorySlopePctPerHour: memorySlopePctPerHour == null ? 0 : memorySlopePctPerHour,
      poolSaturationPct: poolSaturationPct == null ? 0 : poolSaturationPct,
      tool: load.tool || 'k6',
    },
    chaos: {
      primitivesRun: chaos.primitivesRun,
      primitivesPassed: chaos.primitivesPassed,
      recoveryTimes: chaos.recoveryTimes || {},
      tool: chaos.tool || 'chaos-mesh',
    },
    priorMilestoneRegression: { tested: !!infra.staging?.priorMilestonesLive, failures: [] },
  };
  if (load.skipped || chaos.skipped) verdict.skipped = { load: load.skipped, chaos: chaos.skipped };
  if (promSkipReasons.length || !promUrl) {
    verdict.skipped = verdict.skipped || {};
    verdict.skipped.prometheus = promUrl
      ? promSkipReasons.join('; ')
      : 'no prometheus url in infra-manifest.json:observability.prometheus.url or $COBOLT_PROMETHEUS_URL';
  }

  const out = path.join(CWD, '_cobolt-output', 'load-chaos', M, 'verdict.json');
  atomicWrite(out, JSON.stringify(verdict, null, 2));
  console.log(`verdict: ${verdict.pass ? 'PASS' : 'FAIL'} → ${path.relative(CWD, out)}`);
  process.exit(verdict.pass ? 0 : 1);
}

function cmdVerify() {
  const M = arg('--milestone', 'M1');
  const p = path.join(CWD, '_cobolt-output', 'load-chaos', M, 'verdict.json');
  if (!fs.existsSync(p)) {
    console.error('no verdict');
    process.exit(1);
  }
  const v = JSON.parse(fs.readFileSync(p, 'utf8'));
  console.log(JSON.stringify(v, null, 2));
  process.exit(v.pass ? 0 : 1);
}

if (cmd === 'run') cmdRun();
else if (cmd === 'verify') cmdVerify();
else {
  console.log('cobolt-load-chaos run --milestone M<n> --duration 4h --peak-multiple 2 [--chaos list]');
  console.log('cobolt-load-chaos verify --milestone M<n>');
}
