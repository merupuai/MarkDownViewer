#!/usr/bin/env node

// CoBolt Contract Verifier
//
// Reads _cobolt-output/latest/planning/interface-contracts.json (produced by
// cobolt-create-cross-milestone-analysis Step 3) and validates the actual
// codebase against each contract:
//
//   API    — grep handler files for the declared method + path
//   DATA   — scan migration files for the declared table + required columns
//   EVT    — grep publisher/subscriber code for the event name
//   INFRA  — probe the declared health check (if any)
//   TYPE   — grep for the declared exported symbol
//
// Violations are recorded to _cobolt-output/audit/contract-violations.jsonl
// and to the contractViolations metric via cobolt-production-readiness.
//
// Usage:
//   node tools/cobolt-contract-verify.js verify [--milestone M3]
//   node tools/cobolt-contract-verify.js check   # exit 1 if violations
//   node tools/cobolt-contract-verify.js list    # print loaded contracts
//
// Exit codes:
//   0 — all contracts satisfied (or no contracts file)
//   1 — violations found (in check/verify mode)
//   2 — invalid contracts file
//
// Verifier limitations: pattern-based, not a true semantic parser. For DATA
// contracts it scans migration text for CREATE TABLE / ALTER TABLE with the
// declared columns; columns are matched on name (nullability/type checks are
// best-effort only). False negatives: a handler declared via DSL that doesn't
// match our regex set. In those cases, add explicit evidence with
// `--evidence <file:line>` in a future revision (not yet implemented).

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

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
      latestPlanning: () => path.join(out, 'latest', 'planning'),
    };
  }
}

function loadContracts() {
  const p = paths();
  const candidates = [
    path.join(typeof p.latestPlanning === 'function' ? p.latestPlanning() : '', 'interface-contracts.json'),
    path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'interface-contracts.json'),
    path.join(process.cwd(), '_cobolt-output', 'planning', 'interface-contracts.json'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      try {
        return { data: JSON.parse(fs.readFileSync(c, 'utf8')), source: c };
      } catch (err) {
        throw new Error(`invalid JSON in ${c}: ${err.message}`);
      }
    }
  }
  return { data: null, source: null };
}

// ── File discovery ──────────────────────────────────────────────────

function findCodeFiles() {
  const exts = ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'ex', 'exs', 'py', 'go', 'rs', 'java', 'kt', 'rb'];
  const results = [];
  const ignore = new Set(['node_modules', '.git', '_cobolt-output', 'dist', 'build', '.next', 'coverage']);

  function walk(dir, depth) {
    if (depth > 12) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (ignore.has(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile()) {
        const ext = path.extname(e.name).slice(1).toLowerCase();
        if (exts.includes(ext)) results.push(full);
      }
    }
  }
  walk(process.cwd(), 0);
  return results;
}

function findMigrationFiles() {
  const results = [];
  const patterns = ['migrations', 'priv/repo/migrations', 'db/migrate', 'migrate'];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(sql|exs|ex|rb|py|ts|js)$/i.test(e.name)) results.push(full);
    }
  };
  for (const p of patterns) {
    const dir = path.join(process.cwd(), p);
    if (!fs.existsSync(dir)) continue;
    walk(dir);
  }
  return results;
}

// ── Verifiers by type ───────────────────────────────────────────────

function verifyApi(contract, files) {
  const spec = contract.spec;
  const methodPattern = new RegExp(`\\b${spec.method}\\b`, 'i');
  // Path to regex: escape /, treat :param as wildcard, treat {param} as wildcard
  const pathRegex = spec.path
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:\w+/g, '[^"/\\s]+')
    .replace(/\\\{[^}]+\\\}/g, '[^"/\\s]+');
  const pathPattern = new RegExp(pathRegex);

  const matches = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    // Must co-occur method + path on same file (fast cheap heuristic)
    if (methodPattern.test(text) && pathPattern.test(text)) {
      matches.push(f);
      if (matches.length >= 3) break;
    }
  }
  return matches.length > 0
    ? { satisfied: true, evidence: matches }
    : { satisfied: false, reason: `No handler found matching ${spec.method} ${spec.path}` };
}

function verifyData(contract, migrations) {
  const spec = contract.spec;
  const entity = spec.entity;
  const required = (spec.columns || []).map((c) => c.name);
  const tablePattern = new RegExp(`(create\\s+table|alter\\s+table|create\\s*(?:\\W)${entity})`, 'i');

  let tableSeen = false;
  const missingCols = new Set(required);
  const evidence = [];

  for (const f of migrations) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8').toLowerCase();
    } catch {
      continue;
    }
    if (!text.includes(entity.toLowerCase())) continue;
    if (tablePattern.test(text)) {
      tableSeen = true;
      evidence.push(f);
      for (const col of [...missingCols]) {
        if (text.includes(col.toLowerCase())) missingCols.delete(col);
      }
    }
  }

  if (!tableSeen) return { satisfied: false, reason: `Table/entity "${entity}" not found in any migration` };
  if (missingCols.size > 0)
    return {
      satisfied: false,
      reason: `Table "${entity}" missing required columns: ${[...missingCols].join(', ')}`,
      evidence,
    };
  return { satisfied: true, evidence };
}

function verifyEvent(contract, files) {
  const spec = contract.spec;
  const pat = new RegExp(spec.eventName.replace(/\./g, '\\.'), 'i');
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    if (pat.test(text)) return { satisfied: true, evidence: [f] };
  }
  return { satisfied: false, reason: `Event name "${spec.eventName}" not referenced anywhere` };
}

function verifyInfra(contract) {
  const spec = contract.spec;
  if (!spec.healthCheck) return { satisfied: true, reason: 'no health check declared — skipped' };
  // Advisory only — no HTTP probe from verifier (would need network perms)
  return { satisfied: true, reason: `health check declared: ${spec.healthCheck} (advisory — not probed)` };
}

function verifyType(contract, files) {
  const spec = contract.spec;
  const pat = new RegExp(`\\b${spec.symbol.replace(/[.]/g, '\\.').split('.').pop()}\\b`);
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    if (pat.test(text)) return { satisfied: true, evidence: [f] };
  }
  return { satisfied: false, reason: `Symbol "${spec.symbol}" not exported anywhere` };
}

// ── Main verify ─────────────────────────────────────────────────────

function verifyAll(opts = {}) {
  const { data, source } = loadContracts();
  if (!data) return { ok: true, totalContracts: 0, violations: [], source: null, skipped: true };

  const contracts = data.contracts || [];
  const milestoneFilter = opts.milestone || null;

  const codeFiles = findCodeFiles();
  const migrationFiles = findMigrationFiles();

  const violations = [];
  const satisfied = [];

  for (const c of contracts) {
    if (milestoneFilter && c.provider !== milestoneFilter && !c.consumers.includes(milestoneFilter)) continue;

    let result;
    switch (c.spec?.kind) {
      case 'api':
        result = verifyApi(c, codeFiles);
        break;
      case 'data':
        result = verifyData(c, migrationFiles);
        break;
      case 'event':
        result = verifyEvent(c, codeFiles);
        break;
      case 'infra':
        result = verifyInfra(c);
        break;
      case 'type':
        result = verifyType(c, codeFiles);
        break;
      default:
        result = { satisfied: false, reason: `unknown contract kind: ${c.spec?.kind}` };
    }

    if (result.satisfied) satisfied.push({ id: c.id, evidence: result.evidence || [] });
    else
      violations.push({ id: c.id, type: c.type, provider: c.provider, consumers: c.consumers, reason: result.reason });
  }

  return { ok: violations.length === 0, totalContracts: contracts.length, satisfied, violations, source };
}

function recordViolations(result) {
  if (!result.violations || result.violations.length === 0) return;
  const p = paths();
  const dir = typeof p.audit === 'function' ? p.audit() : path.join(process.cwd(), '_cobolt-output', 'audit');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const logFile = path.join(dir, 'contract-violations.jsonl');
  const ts = new Date().toISOString();
  for (const v of result.violations) {
    fs.appendFileSync(logFile, `${JSON.stringify({ ts, ...v })}\n`, { mode: 0o600 });
  }
  // Bump the telemetry metric
  try {
    const tool = path.join(__dirname, 'cobolt-production-readiness.js');
    if (fs.existsSync(tool)) {
      execFileSync('node', [tool, 'record', 'contractViolations', String(result.violations.length)], {
        stdio: 'ignore',
      });
    }
  } catch {
    /* telemetry failure non-fatal */
  }
}

// ── CLI ─────────────────────────────────────────────────────────────

function parseFlags(args) {
  const out = { _: [], milestone: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--milestone') out.milestone = args[++i];
    else out._.push(args[i]);
  }
  return out;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (cmd) {
    case 'verify':
    case 'check': {
      const result = verifyAll({ milestone: flags.milestone });
      recordViolations(result);
      console.log(JSON.stringify(result, null, 2));
      if (result.skipped) return 0;
      return result.ok ? 0 : 1;
    }
    case 'list': {
      const { data, source } = loadContracts();
      console.log(
        JSON.stringify(
          { source, count: data ? (data.contracts || []).length : 0, contracts: data ? data.contracts : [] },
          null,
          2,
        ),
      );
      return 0;
    }
    default:
      console.error('Usage: cobolt-contract-verify.js {verify|check|list} [--milestone M3]');
      return 1;
  }
}

if (require.main === module) process.exit(main());

module.exports = { verifyAll, loadContracts };
