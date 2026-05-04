#!/usr/bin/env node
/**
 * CoBolt Infra Liveness Probe
 *
 * Between-round infrastructure health check. Step 00 preflight runs a full
 * docker health check once at build entry; this probe re-verifies that the
 * declared compose stack is still alive across long TDD rounds so a silent
 * service crash is caught immediately instead of surfacing as mysterious
 * test failures mid-round.
 *
 * Usage:
 *   node tools/cobolt-infra-liveness.js check [--milestone M1] [--round N]
 *   node tools/cobolt-infra-liveness.js check --quiet     # exit-code only
 *
 * Exit codes:
 *   0  — healthy, or no compose file present (native setup is its own concern)
 *   1  — at least one service is not "running"/"healthy"
 *   2  — docker CLI unreachable or compose parse error
 *
 * Side effects:
 *   Writes `_cobolt-output/latest/build/{M}/infra-liveness-{round|timestamp}.json`
 *   when --milestone is supplied. Appends a one-line summary to
 *   `_cobolt-output/audit/infra-liveness.jsonl` in all cases.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
const COMPOSE_CANDIDATES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

function parseArgs(argv) {
  const args = { command: argv[2] || 'check', milestone: null, round: null, quiet: false };
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--milestone' || a === '-m') args.milestone = argv[++i];
    else if (a === '--round' || a === '-r') args.round = argv[++i];
    else if (a === '--quiet' || a === '-q') args.quiet = true;
  }
  return args;
}

function findComposeFile(cwd) {
  for (const name of COMPOSE_CANDIDATES) {
    const full = path.join(cwd, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function dockerPs(composeFile) {
  // `docker compose ps --format json` emits one JSON object per line in newer
  // Compose versions (v2.21+), or a single JSON array in older versions.
  const out = execFileSync('docker', ['compose', '-f', composeFile, 'ps', '--format', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
  });
  const trimmed = out.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }
  return trimmed
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

function classify(services) {
  const unhealthy = [];
  for (const svc of services) {
    const state = (svc.State || svc.state || '').toLowerCase();
    const health = (svc.Health || svc.health || '').toLowerCase();
    const name = svc.Service || svc.Name || svc.name || 'unknown';
    // "running" without declared healthcheck is fine. "running" + "unhealthy" is not.
    if (state !== 'running') {
      unhealthy.push({ name, state, health, reason: `state=${state}` });
      continue;
    }
    if (health && health !== 'healthy' && health !== 'starting') {
      unhealthy.push({ name, state, health, reason: `health=${health}` });
    }
  }
  return unhealthy;
}

function writeArtifact(cwd, milestone, round, payload) {
  if (!milestone) return;
  try {
    const dir = path.join(cwd, '_cobolt-output', 'latest', 'build', milestone);
    const stamp = round ? `round-${round}` : `t-${Date.now()}`;
    atomicWrite(path.join(dir, `infra-liveness-${stamp}.json`), JSON.stringify(payload, null, 2), {
      mode: 0o600,
    });
  } catch {
    /* artifact write is best-effort — audit log still records the result */
  }
}

function appendAudit(cwd, payload) {
  try {
    const dir = path.join(cwd, '_cobolt-output', 'audit');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(dir, 'infra-liveness.jsonl'), `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  } catch {
    /* audit log is best-effort */
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (args.command !== 'check') {
    process.stderr.write(`usage: cobolt-infra-liveness.js check [--milestone M1] [--round N] [--quiet]\n`);
    process.exit(2);
  }

  const cwd = process.cwd();
  const composeFile = findComposeFile(cwd);
  const base = { milestone: args.milestone, round: args.round, at: new Date().toISOString() };

  if (!composeFile) {
    const payload = { ...base, status: 'n/a', reason: 'no compose file present', services: [] };
    appendAudit(cwd, payload);
    if (!args.quiet) process.stderr.write('[infra-liveness] no compose file — skipping probe\n');
    process.exit(0);
  }

  let services;
  try {
    services = dockerPs(composeFile);
  } catch (err) {
    const payload = { ...base, status: 'error', reason: err.message, composeFile };
    appendAudit(cwd, payload);
    writeArtifact(cwd, args.milestone, args.round, payload);
    if (!args.quiet) process.stderr.write(`[infra-liveness] docker compose ps failed: ${err.message}\n`);
    process.exit(2);
  }

  const unhealthy = classify(services);
  const payload = {
    ...base,
    status: unhealthy.length === 0 ? 'healthy' : 'degraded',
    serviceCount: services.length,
    unhealthyCount: unhealthy.length,
    unhealthy,
    composeFile: path.relative(cwd, composeFile),
  };

  appendAudit(cwd, payload);
  writeArtifact(cwd, args.milestone, args.round, payload);

  if (unhealthy.length > 0) {
    if (!args.quiet) {
      process.stderr.write(
        `[infra-liveness] DEGRADED — ${unhealthy.length}/${services.length} services unhealthy:\n` +
          unhealthy.map((u) => `  - ${u.name}: ${u.reason}`).join('\n') +
          '\n',
      );
    }
    process.exit(1);
  }

  if (!args.quiet) {
    process.stderr.write(`[infra-liveness] healthy — ${services.length} services running\n`);
  }
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { findComposeFile, classify };
