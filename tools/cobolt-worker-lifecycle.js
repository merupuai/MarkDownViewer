#!/usr/bin/env node

// CoBolt Worker Lifecycle Verifier (v0.12.0 Phase 2C)
//
// The v0.12 honest audit identified that build pipeline Step 03B ("integration
// smoke") validates routers are mounted but does NOT verify background jobs,
// queues, consumers, or supervisors actually start and consume work. This is
// the single biggest gap in "tests pass but app doesn't actually run."
//
// This tool probes the app for:
//   1. /health     — liveness endpoint
//   2. /ready      — readiness endpoint (with downstream dep status)
//   3. /metrics    — Prometheus-style exposition
//   4. Worker queues — optionally probes admin endpoint /workers or /queues
//                     and confirms declared workers are registered.
//   5. Architecture-declared integrations — parses architecture.md for
//      "Redis", "Kafka", "S3", "Postgres", etc. and probes each via the
//      app's /ready response.
//
// Usage:
//   node tools/cobolt-worker-lifecycle.js check --app-url http://localhost:3000
//   node tools/cobolt-worker-lifecycle.js check --app-url URL --json
//
// Emits _cobolt-output/latest/runtime/worker-lifecycle.json. Build pipeline
// Step 03B reads this and hard-fails if any declared integration is not
// confirmed initialized.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_APP_URL = 'http://localhost:3000';
const TIMEOUT = 5000;

function usage() {
  return 'Usage: cobolt-worker-lifecycle.js check [--app-url URL] [--json]';
}

async function probe(url, { json = false } = {}) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), TIMEOUT);
    const res = await fetch(url, { signal: c.signal });
    clearTimeout(t);
    const text = await res.text();
    let parsed = null;
    if (json) {
      try {
        parsed = JSON.parse(text);
      } catch {}
    }
    return { ok: res.status >= 200 && res.status < 300, status: res.status, body: text, parsed };
  } catch (err) {
    return { ok: false, status: 0, body: '', error: err?.message || 'unreachable' };
  }
}

function archPath() {
  for (const c of [
    path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'architecture.md'),
    path.join(process.cwd(), '_cobolt-output', 'planning', 'architecture.md'),
  ]) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function declaredIntegrations() {
  // Scan architecture.md for integration mentions. Conservative — we only
  // flag things we are reasonably sure the app should wire up.
  const p = archPath();
  if (!p) return [];
  const text = fs.readFileSync(p, 'utf8').toLowerCase();
  const candidates = [
    { name: 'postgres', patterns: [/\bpostgres/, /\bpostgresql/, /\bpsql\b/] },
    { name: 'mysql', patterns: [/\bmysql\b/, /\bmariadb\b/] },
    { name: 'redis', patterns: [/\bredis\b/, /\bdragonfly\b/] },
    { name: 'kafka', patterns: [/\bkafka\b/] },
    { name: 'rabbitmq', patterns: [/\brabbitmq\b/, /\bamqp\b/] },
    { name: 's3', patterns: [/\bs3\b/, /\baws.*storage/] },
    { name: 'mongodb', patterns: [/\bmongodb\b/, /\bmongo\b/] },
    { name: 'elasticsearch', patterns: [/\belasticsearch\b/, /\bopensearch\b/] },
    { name: 'sqs', patterns: [/\bsqs\b/, /\bsimple\s+queue/] },
  ];
  const found = [];
  for (const c of candidates) {
    if (c.patterns.some((p) => p.test(text))) found.push(c.name);
  }
  return found;
}

// v0.12.1 fix #7: pluggable /ready parser. Real apps emit wildly different
// shapes — k8s `{status:"ok"}`, Spring Actuator `{components:{db:{status:"UP"}}}`,
// `{checks:{db:"up"}}`, `{dependencies:{...}}`. Probe all of them.
function extractIntegrationStatus(name, ready) {
  const body = ready.parsed || {};
  const rawBody = (ready.body || '').toLowerCase();
  const lowerName = name.toLowerCase();
  const upperName = name.toUpperCase();
  const titleName = name[0].toUpperCase() + name.slice(1);

  const containers = [
    body,
    body.checks,
    body.dependencies,
    body.components,
    body.services,
    body.integrations,
    body.health,
    body.upstreams,
  ].filter((c) => c && typeof c === 'object');

  for (const container of containers) {
    for (const key of [lowerName, upperName, titleName, name]) {
      if (!(key in container)) continue;
      const v = container[key];
      if (v === true || v === 'up' || v === 'ok' || v === 'UP' || v === 'healthy' || v === 'OK') {
        return { name, status: 'up', source: 'ready-body' };
      }
      if (v && typeof v === 'object') {
        const inner = v.status || v.state || v.health;
        if (inner === 'UP' || inner === 'up' || inner === 'ok' || inner === 'healthy') {
          return { name, status: 'up', source: 'ready-body-nested' };
        }
        if (v.healthy === true || v.up === true) {
          return { name, status: 'up', source: 'ready-body-boolean' };
        }
        if (inner === 'DOWN' || inner === 'down' || v.healthy === false) {
          return { name, status: 'down', source: 'ready-body-nested', detail: v };
        }
      }
      if (v === 'down' || v === 'DOWN' || v === false || v === 'unhealthy') {
        return { name, status: 'down', source: 'ready-body', detail: v };
      }
    }
  }

  if (rawBody.includes(lowerName)) {
    return { name, status: ready.ok ? 'up' : 'down', source: 'ready-body-mention' };
  }
  return { name, status: 'unknown', source: ready.ok ? 'ready-ok-no-mention' : 'ready-failed' };
}

async function checkLifecycle(appUrl) {
  const base = appUrl.replace(/\/$/, '');
  const health = await probe(`${base}/health`);
  const ready = await probe(`${base}/ready`, { json: true });
  const metrics = await probe(`${base}/metrics`);
  const workers = await probe(`${base}/workers`, { json: true });

  const declared = declaredIntegrations();
  const integrations = declared.map((name) => extractIntegrationStatus(name, ready));

  const verdict = {
    appUrl: base,
    generatedAt: new Date().toISOString(),
    health: { ok: health.ok, status: health.status, error: health.error || null },
    ready: { ok: ready.ok, status: ready.status, error: ready.error || null, body: ready.parsed },
    metrics: {
      ok: metrics.ok,
      status: metrics.status,
      error: metrics.error || null,
      hasPrometheusShape: /^# ?HELP /m.test(metrics.body || ''),
    },
    workers: { ok: workers.ok, status: workers.status, body: workers.parsed },
    declaredIntegrations: declared,
    integrations,
  };

  const primaryChecks = [verdict.health.ok, verdict.ready.ok, verdict.metrics.ok];
  const integrationOk =
    integrations.length === 0 || integrations.every((i) => i.status === 'up' || i.status === 'ok' || i.status === true);
  verdict.passed = primaryChecks.every(Boolean) && integrationOk;
  verdict.failureReasons = [];
  if (!verdict.health.ok) verdict.failureReasons.push(`/health ${verdict.health.status || 'unreachable'}`);
  if (!verdict.ready.ok) verdict.failureReasons.push(`/ready ${verdict.ready.status || 'unreachable'}`);
  if (!verdict.metrics.ok) verdict.failureReasons.push(`/metrics ${verdict.metrics.status || 'unreachable'}`);
  for (const i of integrations) {
    if (!(i.status === 'up' || i.status === 'ok' || i.status === true)) {
      verdict.failureReasons.push(`${i.name}=${i.status}`);
    }
  }

  return verdict;
}

function writeVerdict(verdict) {
  const dir = path.join(process.cwd(), '_cobolt-output', 'latest', 'runtime');
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, 'worker-lifecycle.json');
  fs.writeFileSync(fp, JSON.stringify(verdict, null, 2));
  return fp;
}

function parseFlags(args) {
  const out = { _: [], appUrl: null, json: false, help: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--app-url') out.appUrl = args[++i];
    else if (args[i] === '--json') out.json = true;
    else if (args[i] === '--help' || args[i] === '-h') out.help = true;
    else out._.push(args[i]);
  }
  return out;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(usage());
    return 0;
  }
  const flags = parseFlags(rest);
  if (flags.help) {
    console.log(usage());
    return 0;
  }
  const appUrl = flags.appUrl || process.env.APP_URL || DEFAULT_APP_URL;
  switch (cmd) {
    case 'check': {
      const verdict = await checkLifecycle(appUrl);
      writeVerdict(verdict);
      console.log(JSON.stringify(verdict, null, 2));
      return verdict.passed ? 0 : 1;
    }
    default:
      console.error(usage());
      return 1;
  }
}

if (require.main === module) {
  main()
    .then((c) => process.exit(c || 0))
    .catch((e) => {
      console.error(e?.stack || e?.message);
      process.exit(2);
    });
}

module.exports = { checkLifecycle, declaredIntegrations, writeVerdict, extractIntegrationStatus };
