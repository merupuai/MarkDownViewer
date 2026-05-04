#!/usr/bin/env node
//
// CoBolt healthcheck-wait (Issue 4, v0.40.5).
//
// Provisioner agents (cloud-provisioner, k8s-provisioner, vm-provisioner)
// previously returned "provisioned" before the underlying services accepted
// connections, causing deploy steps to fail. This tool polls service
// readiness and exits only when ALL requested services respond or the
// timeout expires.
//
// Supported services:
//   --postgres <url>       pg_isready against DATABASE_URL (or raw URL)
//   --redis <url>          PING against REDIS_URL
//   --http <url>           GET <url>, expect 2xx/3xx
//   --tcp <host:port>      TCP connect
//
// Shared options:
//   --timeout-sec <N>      Total budget across all services (default 180s)
//   --interval-ms <N>      Poll interval (default 2000ms)
//   --output <path>        Write JSON report (default stdout-only)
//   --json                 Force JSON output on stdout even with --output set
//
// Exit codes:
//   0 all services ready
//   1 timeout / at least one service never responded
//   2 missing optional dep (psql / redis-cli) for that service — tier 2 skip
//   3 missing infra (docker / kubectl unreachable — propagated by caller)
//
// Per tools/CLAUDE.md: tools must never exit 0 on silent stub. This tool
// ALWAYS runs probes — there is no stub-on-missing code path.

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const { URL } = require('node:url');

function now() {
  return Date.now();
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function hasCliTool(name) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
    stdio: 'ignore',
  });
  return result.status === 0;
}

function probePostgres(url) {
  if (!hasCliTool('pg_isready')) {
    return { ready: false, reason: 'pg_isready-missing', missingDep: 'pg_isready' };
  }
  try {
    const parsed = new URL(url);
    const args = [
      '-h',
      parsed.hostname,
      '-p',
      parsed.port || '5432',
      '-d',
      (parsed.pathname || '/postgres').slice(1) || 'postgres',
      '-U',
      parsed.username || 'postgres',
      '-t',
      '2',
    ];
    const result = spawnSync('pg_isready', args, { encoding: 'utf8' });
    return {
      ready: result.status === 0,
      reason: result.status === 0 ? null : `exit-${result.status}`,
      stdoutTail: (result.stdout || '').trim().slice(-200),
    };
  } catch (err) {
    return { ready: false, reason: `url-parse-error: ${err.message}` };
  }
}

function probeRedis(url) {
  if (!hasCliTool('redis-cli')) {
    return { ready: false, reason: 'redis-cli-missing', missingDep: 'redis-cli' };
  }
  try {
    const parsed = new URL(url);
    const args = ['-h', parsed.hostname, '-p', parsed.port || '6379'];
    if (parsed.password) args.push('-a', parsed.password);
    args.push('PING');
    const result = spawnSync('redis-cli', args, { encoding: 'utf8' });
    return {
      ready: result.status === 0 && /PONG/i.test(result.stdout || ''),
      reason: result.status === 0 ? null : `exit-${result.status}`,
      stdoutTail: (result.stdout || '').trim().slice(-200),
    };
  } catch (err) {
    return { ready: false, reason: `url-parse-error: ${err.message}` };
  }
}

function probeTcp(hostPort, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const [host, portStr] = String(hostPort).split(':');
    const port = Number.parseInt(portStr, 10);
    if (!host || !Number.isFinite(port)) {
      resolve({ ready: false, reason: `invalid-host:port "${hostPort}"` });
      return;
    }
    const sock = net.createConnection({ host, port, timeout: timeoutMs });
    const done = (ready, reason) => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve({ ready, reason });
    };
    sock.once('connect', () => done(true, null));
    sock.once('timeout', () => done(false, 'tcp-timeout'));
    sock.once('error', (err) => done(false, `tcp-error: ${err.code || err.message}`));
  });
}

async function probeHttp(url, timeoutMs = 3000) {
  try {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? require('node:https') : require('node:http');
    return await new Promise((resolve) => {
      const req = mod.get(url, { timeout: timeoutMs }, (res) => {
        const ok = res.statusCode >= 200 && res.statusCode < 400;
        res.resume();
        resolve({ ready: ok, reason: ok ? null : `http-${res.statusCode}` });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve({ ready: false, reason: 'http-timeout' });
      });
      req.on('error', (err) => resolve({ ready: false, reason: `http-error: ${err.code || err.message}` }));
    });
  } catch (err) {
    return { ready: false, reason: `url-parse-error: ${err.message}` };
  }
}

function parseArgs(argv) {
  const services = [];
  let timeoutSec = 180;
  let intervalMs = 2000;
  let outputPath = null;
  let forceJson = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--postgres' && next) {
      services.push({ kind: 'postgres', url: next });
      i += 1;
    } else if (a === '--redis' && next) {
      services.push({ kind: 'redis', url: next });
      i += 1;
    } else if (a === '--http' && next) {
      services.push({ kind: 'http', url: next });
      i += 1;
    } else if (a === '--tcp' && next) {
      services.push({ kind: 'tcp', target: next });
      i += 1;
    } else if (a === '--timeout-sec' && next) {
      timeoutSec = Number.parseInt(next, 10);
      i += 1;
    } else if (a === '--interval-ms' && next) {
      intervalMs = Number.parseInt(next, 10);
      i += 1;
    } else if (a === '--output' && next) {
      outputPath = next;
      i += 1;
    } else if (a === '--json') {
      forceJson = true;
    }
  }
  return { services, timeoutSec, intervalMs, outputPath, forceJson };
}

function printUsage() {
  process.stdout.write(
    [
      'Usage: cobolt-healthcheck-wait [--postgres URL] [--redis URL] [--http URL] [--tcp HOST:PORT] ...',
      '',
      'Options:',
      '  --timeout-sec N     Overall timeout (default 180)',
      '  --interval-ms N     Poll interval (default 2000)',
      '  --output PATH       Write JSON report',
      '  --json              Force JSON on stdout',
      '',
    ].join('\n'),
  );
}

async function runOnce(services) {
  const out = [];
  for (const svc of services) {
    if (svc.kind === 'postgres') out.push({ svc, ...probePostgres(svc.url) });
    else if (svc.kind === 'redis') out.push({ svc, ...probeRedis(svc.url) });
    else if (svc.kind === 'tcp') out.push({ svc, ...(await probeTcp(svc.target)) });
    else if (svc.kind === 'http') out.push({ svc, ...(await probeHttp(svc.url)) });
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    process.exit(argv.length === 0 ? 1 : 0);
  }
  const { services, timeoutSec, intervalMs, outputPath, forceJson } = parseArgs(argv);
  if (services.length === 0) {
    process.stderr.write('healthcheck-wait: at least one service required\n');
    printUsage();
    process.exit(1);
  }

  const deadline = now() + timeoutSec * 1000;
  let latest = [];
  let missingDep = false;
  while (now() < deadline) {
    latest = await runOnce(services);
    missingDep = latest.some((r) => r.missingDep);
    const allReady = latest.length > 0 && latest.every((r) => r.ready);
    if (allReady) break;
    await sleep(intervalMs);
  }

  const allReady = latest.length > 0 && latest.every((r) => r.ready);
  const report = {
    schemaVersion: 'cobolt-healthcheck-wait/v1',
    startedAt: new Date(now() - timeoutSec * 1000).toISOString(),
    completedAt: new Date().toISOString(),
    timeoutSec,
    intervalMs,
    verdict: allReady ? 'READY' : missingDep ? 'DEP_MISSING' : 'TIMEOUT',
    services: latest,
  };

  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  if (forceJson || !outputPath) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }

  if (allReady) process.exit(0);
  if (missingDep) process.exit(2);
  process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`healthcheck-wait: unexpected error: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { _internal: { probePostgres, probeRedis, probeTcp, probeHttp } };
