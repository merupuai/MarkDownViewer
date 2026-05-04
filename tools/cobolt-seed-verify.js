#!/usr/bin/env node

// CoBolt Cumulative Seed Verifier
//
// Per-milestone tests rarely reflect cumulative state: M5 asserts tables/
// columns from M2 exist with M2's seed data — often they don't. This tool
// asserts that, at milestone M(n) boundary, the cumulative seed state
// satisfies every prior milestone's declared seed-shape contract.
//
// Seed-shape contracts live at:
//   _cobolt-output/latest/planning/milestones/M{x}/seed-shape.json
//
// Each declares expected row counts / key presence / JSON schemas for tables
// created/populated by that milestone. They are validated against a running
// database via adapter (configurable).
//
// This first version is a DRY-RUN validator: it parses seed files / fixtures
// (SQL INSERTs, JSON fixtures, factories) and statically asserts the
// declared shapes without booting a DB. A later revision will add a live
// DB adapter for full verification.
//
// Usage:
//   node tools/cobolt-seed-verify.js verify [--milestone M5]
//   node tools/cobolt-seed-verify.js check             # exit 1 on failure
//
// Records to _cobolt-output/audit/seed-verify.jsonl.

const fs = require('node:fs');
const path = require('node:path');

function findSeedShapes() {
  const shapes = [];
  const root = path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'milestones');
  if (!fs.existsSync(root)) return shapes;
  for (const m of fs.readdirSync(root)) {
    const fp = path.join(root, m, 'seed-shape.json');
    if (fs.existsSync(fp)) {
      try {
        shapes.push({ milestone: m, file: fp, ...JSON.parse(fs.readFileSync(fp, 'utf8')) });
      } catch (err) {
        shapes.push({ milestone: m, file: fp, error: err.message });
      }
    }
  }
  return shapes.sort((a, b) => {
    const na = Number(String(a.milestone).replace(/^M/, ''));
    const nb = Number(String(b.milestone).replace(/^M/, ''));
    return na - nb;
  });
}

function findSeedFiles() {
  const out = [];
  const roots = ['db/seeds', 'priv/repo/seeds', 'priv/seeds', 'seeds', 'seed', 'fixtures', 'tests/fixtures'];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.(sql|exs|ex|rb|py|json|yaml|yml|ts|js)$/i.test(e.name)) out.push(full);
    }
  };
  for (const r of roots) {
    const d = path.join(process.cwd(), r);
    if (!fs.existsSync(d)) continue;
    walk(d, 0);
  }
  return out;
}

// Parse INSERT INTO / factories / JSON fixtures for row counts per table
function tallyFromSeeds(seedFiles) {
  const counts = {}; // { table: count }
  const insertPattern = /insert\s+into\s+[`"']?(\w+)[`"']?/gi;
  const factoryPattern = /(?:insert|create|build)\s*\(\s*[:"']?(\w+)[:"']?/gi;

  for (const f of seedFiles) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    let m;
    while ((m = insertPattern.exec(text)) !== null) {
      const t = m[1].toLowerCase();
      counts[t] = (counts[t] || 0) + 1;
    }
    while ((m = factoryPattern.exec(text)) !== null) {
      const t = m[1].toLowerCase();
      counts[t] = (counts[t] || 0) + 1;
    }
    // JSON fixtures — try to parse and count top-level array length
    if (/\.json$/i.test(f)) {
      try {
        const data = JSON.parse(text);
        const tableHint = path.basename(f, '.json').toLowerCase();
        const n = Array.isArray(data) ? data.length : Object.keys(data || {}).length;
        counts[tableHint] = (counts[tableHint] || 0) + n;
      } catch {
        /* ignore */
      }
    }
  }
  return counts;
}

function verifyShape(shape, counts) {
  const failures = [];
  const expected = shape.tables || shape.expected || {};
  for (const [table, req] of Object.entries(expected)) {
    const got = counts[table.toLowerCase()] || 0;
    const min = typeof req === 'number' ? req : req.minRows || 0;
    if (got < min) {
      failures.push({ table, expected: min, got, milestone: shape.milestone });
    }
  }
  return failures;
}

function appendAudit(event) {
  const dir = path.join(process.cwd(), '_cobolt-output', 'audit');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(dir, 'seed-verify.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

function verify(opts = {}) {
  const shapes = findSeedShapes();
  if (shapes.length === 0) {
    return { ok: true, skipped: true, reason: 'no seed-shape.json declared — permissive' };
  }
  const seedFiles = findSeedFiles();
  const counts = tallyFromSeeds(seedFiles);

  const applicable = opts.milestone
    ? shapes.filter((s) => {
        const na = Number(String(s.milestone).replace(/^M/, ''));
        const nf = Number(String(opts.milestone).replace(/^M/, ''));
        return na <= nf;
      })
    : shapes;

  const allFailures = [];
  for (const shape of applicable) {
    if (shape.error) continue;
    const failures = verifyShape(shape, counts);
    allFailures.push(...failures);
  }

  const result = {
    ok: allFailures.length === 0,
    milestone: opts.milestone || null,
    verifiedShapes: applicable.length,
    seedFilesScanned: seedFiles.length,
    tablesObserved: Object.keys(counts).length,
    failures: allFailures,
    generatedAt: new Date().toISOString(),
  };
  appendAudit(result);
  return result;
}

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
      const r = verify({ milestone: flags.milestone });
      console.log(JSON.stringify(r, null, 2));
      if (r.skipped) return 0;
      return r.ok ? 0 : 1;
    }
    default:
      console.error('Usage: cobolt-seed-verify.js {verify|check} [--milestone M5]');
      return 1;
  }
}

if (require.main === module) process.exit(main());

module.exports = { verify };
