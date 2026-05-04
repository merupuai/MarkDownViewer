#!/usr/bin/env node
/**
 * cobolt-authz-census.js — Runtime authz census verifier.
 *
 * Reads authz-matrix.json and the test-produced authz-census.json, then
 * verifies every (endpoint x role) pair (plus 'unauthenticated') has a real
 * test entry asserting expected vs actual status. Census coverage (not
 * sampling) — requires 1.0 coverage and zero violations.
 *
 * Usage:
 *   node tools/cobolt-authz-census.js [--milestone M2] [--json] [--strict]
 */

const fs = require('node:fs');
const path = require('node:path');

const PSEUDO_UNAUTH = 'unauthenticated';
const OK_STATUSES = new Set([200, 201, 202, 204]);
const _DENY_STATUSES = new Set([401, 403, 404]);

function parseArgs(argv) {
  const args = { strict: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--milestone') args.milestone = argv[++i];
    else if (k === '--json') args.json = true;
    else if (k === '--strict') args.strict = true;
    else if (k === '--no-strict') args.strict = false;
    else if (k === '--cwd') args.cwd = argv[++i];
    else if (k === '--help' || k === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  process.stdout.write(
    `cobolt-authz-census — runtime authz census verifier (matrix vs test evidence)\n\n` +
      `USAGE\n` +
      `  node tools/cobolt-authz-census.js [--milestone M2] [--json] [--strict|--no-strict] [--cwd <dir>]\n` +
      `  node tools/cobolt-authz-census.js --help\n\n` +
      `EXIT CODES\n` +
      `  0 — all (endpoint × role) pairs have matching test evidence, OR project has no\n` +
      `      authz-matrix.json (legitimate skip), OR --no-strict + ok=false\n` +
      `  1 — strict mode: coverage < 100% or authz violations present (policy failure)\n` +
      `  2 — usage error\n` +
      `  3 — required input missing (matrix malformed, census-missing, infra absent)\n`,
  );
}

function readJsonSafe(p) {
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function matrixPath(cwd) {
  const canonical = path.join(cwd, '_cobolt-output', 'latest', 'planning', 'authz-matrix.json');
  const legacy = path.join(cwd, '_cobolt-output', 'latest', 'plan', 'authz-matrix.json');
  if (fs.existsSync(canonical) || !fs.existsSync(legacy)) return canonical;
  return legacy;
}

function censusPath(cwd, milestone) {
  const base = path.join(cwd, '_cobolt-output', 'latest', 'test-results');
  if (milestone) {
    const scoped = path.join(base, milestone, 'authz-census.json');
    if (fs.existsSync(scoped)) return scoped;
  }
  return path.join(base, 'authz-census.json');
}

function endpointKey(method, p) {
  return `${String(method || 'GET').toUpperCase()} ${p}`;
}

function enumerateRoles(matrix) {
  const set = new Set([PSEUDO_UNAUTH]);
  if (Array.isArray(matrix.roles)) {
    for (const r of matrix.roles) set.add(r);
  }
  for (const ep of matrix.endpoints || []) {
    if (Array.isArray(ep.allowedRoles)) for (const r of ep.allowedRoles) set.add(r);
    if (Array.isArray(ep.deniedRoles)) for (const r of ep.deniedRoles) set.add(r);
  }
  return set;
}

function requiredFields(entry) {
  const miss = [];
  for (const f of ['method', 'path', 'role', 'tenantScope', 'expectedStatus', 'actualStatus', 'testFile', 'testName']) {
    if (entry[f] === undefined || entry[f] === null || entry[f] === '') miss.push(f);
  }
  if (entry.tenantScope && !['own', 'cross'].includes(entry.tenantScope)) {
    miss.push('tenantScope(own|cross)');
  }
  return miss;
}

function isAdminRole(role) {
  return /admin|superuser|root/i.test(String(role || ''));
}

function checkAuthzCensus({ cwd, milestone } = {}) {
  const root = cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const mPath = matrixPath(root);
  if (!fs.existsSync(mPath)) {
    return {
      ok: true,
      skipped: true,
      reason: 'authz-matrix-absent',
      matrixPath: mPath,
      coverage: 1,
      gaps: [],
      violations: [],
    };
  }

  const m = readJsonSafe(mPath);
  if (!m.ok) {
    return {
      ok: false,
      reason: 'matrix-malformed',
      error: m.error,
      coverage: 0,
      gaps: [],
      violations: [{ type: 'matrix-malformed', detail: m.error }],
    };
  }

  const cPath = censusPath(root, milestone);
  const c = readJsonSafe(cPath);
  if (!c.ok) {
    return {
      ok: false,
      reason: 'census-missing',
      censusPath: cPath,
      error: c.error,
      coverage: 0,
      gaps: [],
      violations: [{ type: 'census-missing', path: cPath }],
    };
  }

  const matrix = m.data;
  const census = Array.isArray(c.data) ? c.data : Array.isArray(c.data?.entries) ? c.data.entries : [];

  const roles = enumerateRoles(matrix);
  const endpoints = Array.isArray(matrix.endpoints) ? matrix.endpoints : [];

  const required = new Map();
  for (const ep of endpoints) {
    const key = endpointKey(ep.method, ep.path);
    for (const role of roles) {
      required.set(`${key}::${role}`, { method: ep.method, path: ep.path, role, endpoint: ep });
    }
  }

  const covered = new Map();
  const violations = [];

  for (const entry of census) {
    const miss = requiredFields(entry);
    if (miss.length) {
      violations.push({ type: 'entry-incomplete', entry, missing: miss });
      continue;
    }
    const key = `${endpointKey(entry.method, entry.path)}::${entry.role}`;
    covered.set(key, entry);

    if (Number(entry.actualStatus) !== Number(entry.expectedStatus)) {
      violations.push({
        type: 'status-mismatch',
        method: entry.method,
        path: entry.path,
        role: entry.role,
        expected: entry.expectedStatus,
        actual: entry.actualStatus,
        testFile: entry.testFile,
        testName: entry.testName,
      });
    }

    if (entry.tenantScope === 'cross' && !isAdminRole(entry.role) && OK_STATUSES.has(Number(entry.actualStatus))) {
      violations.push({
        type: 'cross-tenant-leak',
        method: entry.method,
        path: entry.path,
        role: entry.role,
        actual: entry.actualStatus,
        testFile: entry.testFile,
        testName: entry.testName,
      });
    }
  }

  const gaps = [];
  for (const [key, need] of required) {
    if (!covered.has(key)) {
      gaps.push({ method: need.method, path: need.path, role: need.role });
    }
  }

  const total = required.size;
  const tested = total === 0 ? 0 : total - gaps.length;
  const coverage = total === 0 ? 1 : tested / total;
  const ok = coverage >= 1.0 && violations.length === 0;

  return {
    ok,
    coverage,
    total,
    tested,
    gaps,
    violations,
    matrixPath: mPath,
    censusPath: cPath,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  const result = checkAuthzCensus({ cwd: args.cwd, milestone: args.milestone });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const line = result.skipped
      ? `authz-census: skipped (${result.reason})`
      : `authz-census: coverage=${(result.coverage * 100).toFixed(1)}% tested=${result.tested}/${result.total} gaps=${result.gaps.length} violations=${result.violations.length}`;
    process.stdout.write(`${line}\n`);
    if (!result.ok && !result.skipped) {
      for (const g of result.gaps.slice(0, 10)) {
        process.stdout.write(`  gap: ${g.method} ${g.path} role=${g.role}\n`);
      }
      for (const v of result.violations.slice(0, 10)) {
        process.stdout.write(`  violation: ${v.type} ${v.method || ''} ${v.path || ''} role=${v.role || ''}\n`);
      }
    }
  }

  // v0.40.12 DEFECT-04 exit-code realignment (policy vs infra separation):
  //   skipped (no matrix)           → 0  (legitimate no-op)
  //   census-missing / matrix-bad   → 3  (missing upstream input — Tier 2 degrades)
  //   --no-strict + ok=false        → 0  (user opt-in to tolerance)
  //   strict + coverage<100%        → 1  (hard policy failure — NOT exit 2)
  if (result.skipped) process.exit(0);
  if (result.reason === 'census-missing' || result.reason === 'matrix-malformed') process.exit(3);
  if (!args.strict) process.exit(0);
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`cobolt-authz-census: ${e.message}\n`);
    process.exit(1);
  }
}

module.exports = { checkAuthzCensus, matrixPath };
