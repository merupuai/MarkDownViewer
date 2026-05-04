#!/usr/bin/env node

// CoBolt Seed Shape Emitter
//
// Scaffolds per-milestone seed-shape.json files that cobolt-seed-verify
// checks at every M(n) boundary. Without these files, the seed-gate is
// permissive.
//
// Usage:
//   # Scaffold from migrations — one seed-shape.json per milestone.
//   # Infers tables created within each milestone's migration range.
//   node tools/cobolt-seed-shape.js scaffold --milestone M1 [--min-rows 1]
//
//   # Add an explicit expectation
//   node tools/cobolt-seed-shape.js set --milestone M1 users 3
//
//   # Show
//   node tools/cobolt-seed-shape.js show --milestone M1
//
// Output: _cobolt-output/latest/planning/milestones/{M}/seed-shape.json
// Shape:
//   { "milestone": "M1", "tables": { "users": 1, "roles": 1 } }
//
// Tier 2.1 I2b — v0.11.0

const fs = require('node:fs');
const path = require('node:path');

function milestoneDir(m) {
  const d = path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'milestones', m);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

function shapePath(m) {
  return path.join(milestoneDir(m), 'seed-shape.json');
}

function readShape(m) {
  const fp = shapePath(m);
  if (!fs.existsSync(fp)) return { milestone: m, tables: {} };
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return { milestone: m, tables: {} };
  }
}

function writeShape(m, shape) {
  fs.writeFileSync(
    shapePath(m),
    JSON.stringify({ ...shape, milestone: m, updatedAt: new Date().toISOString() }, null, 2),
  );
}

function findMigrations() {
  const out = [];
  const walk = (p) => {
    let entries;
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(sql|exs|ex|rb)$/i.test(e.name)) out.push(full);
    }
  };
  for (const d of ['migrations', 'priv/repo/migrations', 'db/migrate']) {
    const dir = path.join(process.cwd(), d);
    if (!fs.existsSync(dir)) continue;
    walk(dir);
  }
  return out.sort();
}

function inferTablesForMilestone(_milestone, minRows) {
  // Naive approach: scan ALL migrations, extract CREATE TABLE. The user
  // must manually curate the per-milestone split if migrations don't
  // carry milestone markers (common). We include ALL tables as a
  // starting point — reviewer trims.
  const createPat = /create\s+table\s+(?:if\s+not\s+exists\s+)?[`"']?(\w+)[`"']?/gi;
  const tables = {};
  for (const f of findMigrations()) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8').toLowerCase();
    } catch {
      continue;
    }
    let m;
    createPat.lastIndex = 0;
    while ((m = createPat.exec(text)) !== null) {
      tables[m[1]] = Math.max(minRows, tables[m[1]] || 0);
    }
  }
  return tables;
}

function scaffold(opts) {
  if (!opts.milestone) {
    console.error('--milestone <Mx> required');
    return 1;
  }
  const minRows = Number(opts.minRows || 1);
  const existing = readShape(opts.milestone);
  const inferred = inferTablesForMilestone(opts.milestone, minRows);
  existing.tables = { ...existing.tables, ...inferred };
  writeShape(opts.milestone, existing);
  console.log(
    JSON.stringify(
      {
        ok: true,
        milestone: opts.milestone,
        tables: existing.tables,
        file: shapePath(opts.milestone),
        note: 'Scaffolded from ALL migrations. Review and trim to the subset actually created in this milestone.',
      },
      null,
      2,
    ),
  );
  return 0;
}

function set(opts) {
  if (!opts.milestone || !opts._[0] || !opts._[1]) {
    console.error('Usage: set --milestone Mx <table> <minRows>');
    return 1;
  }
  const n = Number(opts._[1]);
  if (!Number.isFinite(n) || n < 0) {
    console.error('minRows must be non-negative number');
    return 1;
  }
  const shape = readShape(opts.milestone);
  shape.tables ||= {};
  shape.tables[opts._[0]] = n;
  writeShape(opts.milestone, shape);
  console.log(JSON.stringify({ ok: true, milestone: opts.milestone, table: opts._[0], minRows: n }, null, 2));
  return 0;
}

function show(opts) {
  if (!opts.milestone) {
    console.error('--milestone <Mx> required');
    return 1;
  }
  console.log(JSON.stringify(readShape(opts.milestone), null, 2));
  return 0;
}

function parseFlags(args) {
  const out = { _: [], milestone: null, minRows: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--milestone') out.milestone = args[++i];
    else if (args[i] === '--min-rows') out.minRows = args[++i];
    else out._.push(args[i]);
  }
  return out;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (cmd) {
    case 'scaffold':
      return scaffold(flags);
    case 'set':
      return set(flags);
    case 'show':
      return show(flags);
    default:
      console.error(
        'Usage: cobolt-seed-shape.js {scaffold --milestone Mx [--min-rows N] | set --milestone Mx <table> <n> | show --milestone Mx}',
      );
      return 1;
  }
}

if (require.main === module) process.exit(main());

module.exports = { scaffold, set, show };
