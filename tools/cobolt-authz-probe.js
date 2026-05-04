#!/usr/bin/env node
/**
 * cobolt-authz-probe.js — Runtime authorization probe.
 *
 * For every endpoint in authz-matrix.json, issue a request with
 * (1) no auth, (2) authenticated-but-unprivileged token, and for admin-only
 * endpoints assert the response is 401/403, never 2xx. Writes a report and
 * exits non-zero if any admin-only endpoint leaks to a non-admin caller.
 *
 * Uses Node's built-in fetch (>= 20). Token sources in priority order:
 *   COBOLT_PROBE_ANON_TOKEN (optional) — treat as no auth if absent
 *   COBOLT_PROBE_USER_TOKEN (required) — unprivileged authenticated user
 *
 * Probing uses GET only for idempotent methods; POST/PUT/PATCH/DELETE are
 * probed with an empty body to avoid side effects. Failures to reach the
 * app are reported as errors and block the gate (fail-closed).
 *
 * Usage:
 *   node tools/cobolt-authz-probe.js --matrix <path> --app-url <url> --out <path>
 */

const fs = require('node:fs');
const path = require('node:path');
const { validateURL } = require('../lib/cobolt-ssrf');

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--help' || k === '-h') {
      args.help = true;
      continue;
    }
    if (k.startsWith('--')) args[k.slice(2)] = argv[++i];
  }
  return args;
}

function printHelp() {
  process.stdout.write(
    `cobolt-authz-probe — runtime cross-tenant access probe\n\n` +
      `USAGE\n` +
      `  node tools/cobolt-authz-probe.js --matrix <path> --app-url <url> --out <path>\n` +
      `  node tools/cobolt-authz-probe.js --help\n\n` +
      `ENV\n` +
      `  COBOLT_PROBE_ANON_TOKEN  optional anonymous token (treated as no-auth if unset)\n` +
      `  COBOLT_PROBE_USER_TOKEN  required non-admin token for cross-tenant verification\n\n` +
      `EXIT CODES\n` +
      `  0 — all admin-only endpoints correctly reject anon + non-admin\n` +
      `  1 — admin leak detected (hard policy failure) or runtime reach failure\n` +
      `  2 — usage error (missing --matrix / --app-url / --out)\n` +
      `  3 — infrastructure unreachable (app-url returns 0 on every probe)\n`,
  );
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function writeJson(p, d) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(d, null, 2));
}

async function probeOnce(url, method, token) {
  // v0.40.12 DEFECT-07: SSRF validate before every outbound probe. Prevents
  // --app-url or path-substitution tokens from steering probes at cloud
  // metadata (169.254.169.254), RFC1918, loopback, or link-local hosts.
  // COBOLT_ALLOW_SSRF_FOR_TESTS=1 bypasses for integration tests that spin
  // up a localhost app (which the validator rejects by default).
  if (process.env.COBOLT_ALLOW_SSRF_FOR_TESTS !== '1') {
    const verdict = await validateURL(url);
    if (!verdict.safe) {
      return { status: 0, ok: false, error: `ssrf-blocked: ${verdict.reason}` };
    }
  }
  const init = {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    redirect: 'manual',
  };
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    init.headers['Content-Type'] = 'application/json';
    init.body = '{}';
  }
  try {
    const res = await fetch(url, init);
    return { status: res.status, ok: res.ok };
  } catch (e) {
    return { status: 0, ok: false, error: e.message };
  }
}

function isAdminOnly(ep) {
  if (ep.visibility === 'admin-only') return true;
  return Array.isArray(ep.allowedRoles) && ep.allowedRoles.some((r) => /admin|superuser|root/i.test(r));
}

function substitutePath(p) {
  // Replace {id}/:id tokens with a disposable sentinel. Authorization checks
  // should fire on middleware, not requiring a valid resource id.
  return p.replace(/:(?:[A-Za-z_][\w]*)/g, '1').replace(/\{[^}]+\}/g, '1');
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.matrix || !args['app-url'] || !args.out) {
    printHelp();
    process.stderr.write('error: missing required --matrix / --app-url / --out\n');
    process.exit(2);
  }

  const matrix = readJson(args.matrix);
  const appUrl = args['app-url'].replace(/\/$/, '');
  const userToken = process.env.COBOLT_PROBE_USER_TOKEN || '';

  const results = [];
  let adminLeaks = 0;
  let reachFailures = 0;

  for (const ep of matrix.endpoints || []) {
    const url = `${appUrl}${substitutePath(ep.path)}`;
    const admin = isAdminOnly(ep);

    const anon = await probeOnce(url, ep.method, null);
    const user = userToken ? await probeOnce(url, ep.method, userToken) : { status: -1, note: 'no-user-token' };

    const verdict = { id: ep.id, method: ep.method, path: ep.path, admin, anon, user };

    if (admin) {
      // Admin-only endpoints MUST reject both anon and non-admin user.
      if ([200, 201, 202, 204].includes(anon.status)) {
        verdict.leak = 'anon-allowed';
        adminLeaks++;
      } else if (userToken && [200, 201, 202, 204].includes(user.status)) {
        verdict.leak = 'non-admin-allowed';
        adminLeaks++;
      }
    }

    if (anon.status === 0) reachFailures++;

    results.push(verdict);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    appUrl,
    totalEndpoints: results.length,
    adminLeaks,
    reachFailures,
    passed: adminLeaks === 0 && reachFailures === 0,
    results,
  };
  writeJson(args.out, report);

  console.log(`authz-probe: admin-leaks=${adminLeaks} reach-failures=${reachFailures} endpoints=${results.length}`);
  // v0.40.12 DEFECT-04 fix: exit-code contract alignment.
  //   0 = all passed
  //   1 = admin leak (hard policy failure) OR mixed reach failures
  //   3 = every probe hit unreachable (infra missing)
  if (report.passed) process.exit(0);
  const allUnreachable = results.length > 0 && reachFailures === results.length;
  process.exit(allUnreachable ? 3 : 1);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
module.exports = { main, isAdminOnly, substitutePath };
