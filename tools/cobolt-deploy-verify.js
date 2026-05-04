#!/usr/bin/env node
/**
 * cobolt-deploy-verify.js — Post-deploy probe gauntlet + auto-rollback.
 *
 * Reads infra-manifest.json to determine target (k8s | ecs | cloudrun | fly |
 * compose), dispatches to the matching probe module under
 * source/plugins/deploy-probes/, writes a health report, and (on failure)
 * invokes platform-native rollback. Appends a rollback audit record.
 *
 * Usage:
 *   node tools/cobolt-deploy-verify.js --milestone M3 [--auto-rollback] [--timeout 120000] [--json]
 *   node tools/cobolt-deploy-verify.js --manifest path/to/infra-manifest.json --milestone M3
 *
 * Exit codes:
 *   0 — verify passed (or probe target unknown + --non-strict)
 *   1 — verify failed, rollback executed
 *   2 — verify failed, rollback skipped (compose / --no-auto-rollback)
 *   3 — unrecoverable error (missing manifest, unknown target in strict mode)
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
const { stalenessReport } = require('../lib/cobolt-infra-manifest');
const PROBE_DIR_CANDIDATES = [
  path.join(__dirname, '..', 'source', 'plugins', 'deploy-probes'),
  path.join(__dirname, '..', 'plugins', 'deploy-probes'),
  path.join(__dirname, 'plugins', 'deploy-probes'),
];

const TARGET_MAP = {
  'docker-compose': 'compose',
  compose: 'compose',
  k8s: 'k8s',
  eks: 'k8s',
  gke: 'k8s',
  aks: 'k8s',
  kubernetes: 'k8s',
  ecs: 'ecs',
  'ecs-fargate': 'ecs',
  'cloud-run': 'cloudrun',
  cloudrun: 'cloudrun',
  'gcloud-run': 'cloudrun',
  fly: 'fly',
  'fly-machines': 'fly',
};

function parseArgs(argv) {
  const out = {
    cwd: process.cwd(),
    autoRollback: true,
    strict: true,
    timeoutMs: 120000,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--milestone') out.milestone = argv[++i];
    else if (k === '--manifest') out.manifestPath = argv[++i];
    else if (k === '--cwd') out.cwd = argv[++i];
    else if (k === '--timeout') out.timeoutMs = Number.parseInt(argv[++i], 10) || out.timeoutMs;
    else if (k === '--no-auto-rollback') out.autoRollback = false;
    else if (k === '--auto-rollback') out.autoRollback = true;
    else if (k === '--non-strict') out.strict = false;
    else if (k === '--json') out.json = true;
  }
  return out;
}

function resolveProbeModule(targetKey) {
  for (const dir of PROBE_DIR_CANDIDATES) {
    const p = path.join(dir, `${targetKey}.js`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function loadProbe(target) {
  const key = TARGET_MAP[String(target || '').toLowerCase()];
  if (!key) return { error: `unknown deploy target: ${target}` };
  const modPath = resolveProbeModule(key);
  if (!modPath) return { error: `probe module not found on disk for target "${key}"` };
  try {
    return { module: require(modPath), key };
  } catch (e) {
    return { error: `failed to load probe module ${modPath}: ${e.message}` };
  }
}

function readManifest({ cwd, manifestPath }) {
  const p = manifestPath || path.join(cwd, '_cobolt-output', 'latest', 'infra', 'infra-manifest.json');
  if (!fs.existsSync(p)) return { error: `infra-manifest.json not found at ${p}` };
  try {
    return { manifest: JSON.parse(fs.readFileSync(p, 'utf8')), path: p };
  } catch (e) {
    return { error: `infra-manifest.json malformed: ${e.message}`, path: p };
  }
}

function resolveTarget(manifest) {
  return manifest?.compute?.target || manifest?.platform?.type || manifest?.compute?.orchestrator || '';
}

/**
 * Parse a connection URL into { host, port }. Accepts postgres://, redis://,
 * http(s)://, or a bare "host:port" string. Returns null when unparseable.
 */
function parseEndpointForProbe(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const normalized = raw
      .replace(/^postgres(ql)?:\/\//, 'http://')
      .replace(/^rediss?:\/\//, 'http://')
      .replace(/^amqps?:\/\//, 'http://')
      .replace(/^mongodb(\+srv)?:\/\//, 'http://');
    if (/^[a-z][\w+.-]*:\/\//i.test(normalized)) {
      const u = new URL(normalized);
      const port = Number.parseInt(u.port, 10) || (u.protocol === 'https:' ? 443 : 80);
      if (!u.hostname) return null;
      return { host: u.hostname, port };
    }
    const m = raw.match(/^([^:/\s]+):(\d{1,5})$/);
    if (m) return { host: m[1], port: Number.parseInt(m[2], 10) };
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Tiny synchronous TCP probe via a node subprocess.
 */
function tcpProbe(host, port, timeoutMs = 4000) {
  const script = `
    const net = require('net');
    const start = Date.now();
    const sock = net.createConnection({ host: ${JSON.stringify(host)}, port: ${Number(port)}, timeout: ${Number(timeoutMs)} });
    let done = false;
    function finish(ok, err) { if (done) return; done = true; try { sock.destroy(); } catch {} process.stdout.write(JSON.stringify({ ok, err: err || null, ms: Date.now() - start })); }
    sock.on('connect', () => finish(true));
    sock.on('error', (e) => finish(false, e.message));
    sock.on('timeout', () => finish(false, 'timeout'));
  `;
  try {
    const out = execFileSync('node', ['-e', script], {
      encoding: 'utf8',
      timeout: timeoutMs + 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(String(out).trim() || '{}');
    return { reachable: !!parsed.ok, latencyMs: parsed.ms || 0, error: parsed.err || null };
  } catch (e) {
    return { reachable: false, latencyMs: 0, error: e.message || 'probe failed' };
  }
}

/**
 * Issue 19 (v0.40.6) — re-probe user-provided services at deploy time.
 */
function reprobeUserProvidedServices(manifest) {
  const report = stalenessReport(manifest, Date.now());
  const probed = [];
  const unreachable = [];
  if (!report.reprobeRequired) {
    return { maxAgeSec: report.maxAgeSec, probed, unreachable, stale: [] };
  }
  const reprobeOnDeploy = manifest?.staleness?.reprobeOnDeploy !== false;
  if (!reprobeOnDeploy) {
    return { maxAgeSec: report.maxAgeSec, probed, unreachable, stale: report.entries, reprobeSkipped: true };
  }
  const services = manifest?.services || {};
  for (const entry of report.entries) {
    const svc = services[entry.name] || {};
    const url = svc.endpoint || svc.url || null;
    const endpoint = parseEndpointForProbe(url);
    if (!endpoint) {
      unreachable.push({ ...entry, reason: `${entry.reason}+unparseable-endpoint`, endpoint: url || null });
      probed.push({ name: entry.name, endpoint: url || null, reachable: false, error: 'unparseable endpoint' });
      continue;
    }
    const probe = tcpProbe(endpoint.host, endpoint.port, 4000);
    probed.push({
      name: entry.name,
      endpoint: `${endpoint.host}:${endpoint.port}`,
      reachable: probe.reachable,
      latencyMs: probe.latencyMs,
      error: probe.error,
    });
    if (!probe.reachable) {
      unreachable.push({
        ...entry,
        reason: `${entry.reason}+reprobe-failed`,
        endpoint: `${endpoint.host}:${endpoint.port}`,
        error: probe.error,
      });
    }
  }
  return { maxAgeSec: report.maxAgeSec, probed, unreachable, stale: report.entries };
}

function reportPath(cwd, milestone) {
  const m = milestone || 'unknown';
  return path.join(cwd, '_cobolt-output', 'latest', 'deploy', m, 'health-report.json');
}

function rollbackLogPath(cwd) {
  return path.join(cwd, '_cobolt-output', 'audit', 'deploy-rollbacks.jsonl');
}

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function writeJson(p, data) {
  atomicWrite(p, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function appendJsonl(p, record) {
  ensureDir(p);
  fs.appendFileSync(p, `${JSON.stringify(record)}\n`, 'utf8');
}

async function verifyAndMaybeRollback(opts) {
  const { cwd, milestone, autoRollback, timeoutMs, strict } = opts;

  const { manifest, error: manifestErr, path: manifestPath } = readManifest(opts);
  if (manifestErr) {
    return {
      exitCode: 3,
      report: {
        status: 'error',
        error: manifestErr,
        verifiedAt: new Date().toISOString(),
        milestone,
      },
    };
  }

  const target = resolveTarget(manifest);

  // Issue 19 (v0.40.6) — re-probe stale _source: user-provided services
  // BEFORE invoking the target probe. Infra-time liveness can rot between
  // provisioning and deploy; proceeding against a silently-unreachable DB
  // or cache is a silent production failure.
  const staleness = reprobeUserProvidedServices(manifest);
  if (staleness.unreachable.length > 0) {
    return {
      exitCode: 3,
      report: {
        status: 'error',
        error: `user-provided services unreachable at deploy-time: ${staleness.unreachable.map((s) => s.name).join(', ')}`,
        target,
        manifestPath,
        staleness,
        verifiedAt: new Date().toISOString(),
        milestone,
      },
    };
  }

  const probe = loadProbe(target);
  if (probe.error) {
    const exitCode = strict ? 3 : 0;
    return {
      exitCode,
      report: {
        status: strict ? 'error' : 'skipped',
        error: probe.error,
        target,
        manifestPath,
        staleness,
        verifiedAt: new Date().toISOString(),
        milestone,
      },
    };
  }

  const verdict = await probe.module.verify({ manifest, timeoutMs });
  const report = {
    status: verdict.passed ? 'passed' : 'failed',
    target: probe.key,
    manifestPath,
    milestone,
    verifiedAt: new Date().toISOString(),
    evidence: verdict.evidence || {},
  };

  if (verdict.passed) return { exitCode: 0, report };

  if (!autoRollback || probe.key === 'compose') {
    report.rollback = {
      executed: false,
      reason: probe.key === 'compose' ? 'compose target (dev-only) — rollback suppressed' : 'auto-rollback disabled',
    };
    return { exitCode: 2, report };
  }

  const reason = buildFailureReason(verdict.evidence);
  const rb = await probe.module.rollback({ manifest, reason });
  report.rollback = {
    executed: true,
    rolled_back: rb.rolled_back === true,
    reason,
    evidence: rb.evidence || {},
  };

  appendJsonl(rollbackLogPath(cwd), {
    ts: new Date().toISOString(),
    milestone: milestone || null,
    target: probe.key,
    reason,
    rolled_back: rb.rolled_back === true,
    evidence: rb.evidence || {},
  });

  return { exitCode: 1, report };
}

function buildFailureReason(evidence) {
  if (!evidence) return 'verify_failed';
  const parts = [];
  if (evidence.readiness && evidence.readiness.passed === false) parts.push('readiness');
  if (evidence.smoke && evidence.smoke.passed === false) parts.push('smoke');
  if (evidence.logTail && evidence.logTail.passed === false) parts.push('logTail');
  if (evidence.metrics && evidence.metrics.passed === false) parts.push('metrics');
  return parts.length > 0 ? `probe_failed:${parts.join(',')}` : 'probe_failed';
}

async function main(argv) {
  const opts = parseArgs(argv);
  const { exitCode, report } = await verifyAndMaybeRollback(opts);
  const outPath = reportPath(opts.cwd, opts.milestone);
  writeJson(outPath, report);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `[deploy-verify] status=${report.status} target=${report.target || 'n/a'} milestone=${opts.milestone || 'n/a'} report=${outPath}\n`,
    );
  }
  return exitCode;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`[deploy-verify] fatal: ${e.message}\n`);
      process.exit(3);
    });
}

module.exports = {
  verifyAndMaybeRollback,
  _internals: {
    parseArgs,
    loadProbe,
    resolveTarget,
    readManifest,
    TARGET_MAP,
    buildFailureReason,
    reprobeUserProvidedServices,
    parseEndpointForProbe,
    tcpProbe,
  },
};
