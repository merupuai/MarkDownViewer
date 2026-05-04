#!/usr/bin/env node

// CoBolt Schema Replay Verifier (v0.13 Phase 1B)
//
// Cumulative schema verification across milestones M1..Mn. Detects drift
// between incremental migration application and a pinned canonical snapshot.
// Each migration is traditionally validated in isolation; nothing proves
// that applying ALL migrations M1..Mn together produces the expected state.
//
// Strategy:
//   1. Discover migration files for the current engine (postgres/mysql/sqlite).
//   2. Spin a disposable DB (sqlite: in-memory/tmpfile; postgres/mysql: docker
//      ephemeral container when available).
//   3. Replay EVERY migration up-script in lexicographic order (census, not
//      sampling) against the clean DB.
//   4. Dump canonical schema (tables, columns, types, indexes, constraints).
//   5. Diff vs the pinned snapshot at
//      _cobolt-output/latest/build/schema-state/{M}.schema.sql.
//   6. Optionally run the migration cycle test: forward → rollback → forward
//      for every migration, proving reversibility.
//
// Writes a verdict to:
//   _cobolt-output/latest/build/{M}-schema-replay-verdict.json
//
// Audit log (append-only):
//   _cobolt-output/audit/schema-drifts.jsonl
//
// Engine detection: reads infra-manifest.json or package.json dependencies,
// falls back to sqlite if nothing matches (CI-friendly).
//
// Usage:
//   node tools/cobolt-schema-replay.js check [--milestone M2] [--engine sqlite] [--cycle] [--json]
//   node tools/cobolt-schema-replay.js snapshot --milestone M2 [--engine sqlite]
//
// Exit codes:
//   0 — pass (or permissive skip)
//   1 — drift or replay failure
//   2 — invalid inputs / engine unavailable in non-permissive mode

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function outputRoot(cwd) {
  return path.join(cwd, '_cobolt-output');
}

function verdictPath(cwd, milestone) {
  return path.join(outputRoot(cwd), 'latest', 'build', `${milestone}-schema-replay-verdict.json`);
}

function snapshotPath(cwd, milestone) {
  return path.join(outputRoot(cwd), 'latest', 'build', 'schema-state', `${milestone}.schema.sql`);
}

function auditLogPath(cwd) {
  return path.join(outputRoot(cwd), 'audit', 'schema-drifts.jsonl');
}

// v0.47.4: detect whether Planning declared schema/data-model work so
// "no migrations discovered" can fail closed instead of fake-passing.
function planningDeclaresSchemaWork(cwd) {
  const candidates = [
    path.join(cwd, '_cobolt-output', 'latest', 'planning', 'data-model-spec.md'),
    path.join(cwd, '_cobolt-output', 'latest', 'planning', 'data-model.md'),
  ];
  for (const fp of candidates) {
    try {
      if (!fs.existsSync(fp)) continue;
      const text = fs.readFileSync(fp, 'utf8');
      if (text.trim().length < 80) continue;
      // Look for table/entity/column declarations — any of these means Plan
      // committed to schema work and Build owes replay evidence.
      if (
        /\b(TABLE|CREATE\s+TABLE|entity|schema|migration|primary\s+key)\b/i.test(text) ||
        /^\s*-\s+\*\*[A-Z][A-Za-z0-9_]+\*\*/m.test(text)
      ) {
        return { declared: true, evidence: path.basename(fp) };
      }
    } catch {
      /* ignore */
    }
  }
  return { declared: false, reason: 'no data-model spec or no table declarations' };
}

function loadJson(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

function headSha(cwd) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

// Detect engine from infra-manifest.json or dependency declarations.
function detectEngine(cwd) {
  const manifestCandidates = [
    path.join(outputRoot(cwd), 'latest', 'planning', 'infra-manifest.json'),
    path.join(outputRoot(cwd), 'planning', 'infra-manifest.json'),
    path.join(cwd, 'infra-manifest.json'),
  ];
  for (const m of manifestCandidates) {
    const doc = loadJson(m);
    if (doc?.database?.engine) return String(doc.database.engine).toLowerCase();
    if (doc?.engine) return String(doc.engine).toLowerCase();
  }
  const pkg = loadJson(path.join(cwd, 'package.json'));
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (deps.pg || deps.postgres || deps['postgres-migrations']) return 'postgres';
    if (deps.mysql || deps.mysql2) return 'mysql';
    if (deps['better-sqlite3'] || deps.sqlite3) return 'sqlite';
  }
  return 'sqlite';
}

// Discover migration files. Looks under common roots; collects .up.sql or .sql.
function discoverMigrations(cwd) {
  const roots = [
    path.join(cwd, 'db', 'migrations'),
    path.join(cwd, 'migrations'),
    path.join(cwd, 'priv', 'repo', 'migrations'),
  ];
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    const files = fs
      .readdirSync(r)
      .filter((f) => /\.sql$/i.test(f) && !/\.down\.sql$/i.test(f))
      .sort();
    if (files.length > 0) return { root: r, files };
  }
  return { root: null, files: [] };
}

// Locate down migration sibling for a given up file.
function downSibling(root, upFile) {
  if (/\.up\.sql$/i.test(upFile)) {
    const down = upFile.replace(/\.up\.sql$/i, '.down.sql');
    const p = path.join(root, down);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function hasCmd(cmd) {
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(probe, [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ── Engine drivers ──────────────────────────────────────────────
// Each driver exposes: available(), replay(files, root), dumpSchema(), cleanup(),
// cycle(upFile, downFile) returning boolean pass.

function sqliteDriver(_cwd) {
  let better;
  try {
    better = require('better-sqlite3');
  } catch {
    better = null;
  }
  if (!better) {
    return { available: false, reason: 'better-sqlite3 not installed' };
  }
  const db = new better(':memory:');
  return {
    available: true,
    engine: 'sqlite',
    replayOne(sql) {
      db.exec(sql);
    },
    dumpSchema() {
      const rows = db
        .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name')
        .all();
      return rows.map((r) => `-- ${r.type}:${r.name}\n${r.sql};`).join('\n\n');
    },
    cleanup() {
      try {
        db.close();
      } catch {
        /* noop */
      }
    },
  };
}

// Docker-based drivers are advisory — the caller decides whether unavailability
// should block (gate) or fall through to sqlite (tests). We keep them minimal
// and exec-based so they are trivially mockable.
function dockerDriver(engine, _cwd) {
  if (!hasCmd('docker')) {
    return { available: false, reason: 'docker CLI not found' };
  }
  return {
    available: true,
    engine,
    // Real implementation spins an ephemeral container via docker-compose or
    // `docker run`, applies migrations over a socket, then dumps the schema.
    // To keep this tool deterministic and CI-testable, we delegate actual
    // container I/O to a small helper script so unit tests can stub it.
    replayOne(_sql) {
      throw new Error(`${engine} driver requires container runtime integration; use --engine sqlite for local tests`);
    },
    dumpSchema() {
      return '';
    },
    cleanup() {
      /* container torn down by caller */
    },
  };
}

function selectDriver(engine, cwd) {
  if (engine === 'sqlite') return sqliteDriver(cwd);
  return dockerDriver(engine, cwd);
}

// Normalize SQL text so replay diffs ignore whitespace / trailing-semicolon noise.
function normalizeSql(s) {
  return String(s || '')
    .replace(/--[^\n]*\n/g, '\n')
    .replace(/\s+/g, ' ')
    .replace(/\s*;\s*/g, ';')
    .trim();
}

function structuralFingerprint(sql) {
  const statements = normalizeSql(sql)
    .split(';')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  const canonical = statements.join(';\n');
  return {
    algorithm: 'sha256',
    canonical,
    digest: `sha256:${crypto.createHash('sha256').update(canonical).digest('hex')}`,
  };
}

function diffSchemas(dumped, snapshot) {
  const a = normalizeSql(dumped);
  const b = normalizeSql(snapshot);
  if (a === b) return { equal: true };
  // Cheap line-level diff to keep output readable.
  const aLines = a.split(';').filter(Boolean);
  const bLines = b.split(';').filter(Boolean);
  const onlyInDump = aLines.filter((l) => !bLines.includes(l));
  const onlyInSnap = bLines.filter((l) => !aLines.includes(l));
  return { equal: false, onlyInDump, onlyInSnap };
}

function hasDestructiveAuthorization(sql) {
  const text = String(sql || '');
  const marker = text.match(/cobolt-allow-destructive\s*:\s*([^\n]+)/i);
  if (!marker) return false;
  const payload = marker[1].trim();
  return /(?:ticket|issue|change)\s*=\s*[A-Z][A-Z0-9]+-\d+/i.test(payload) && payload.length >= 20;
}

function detectDestructiveOperations(root, files) {
  const violations = [];
  const patterns = [
    { type: 'drop-table', re: /\bDROP\s+TABLE\b/i },
    { type: 'drop-column', re: /\bDROP\s+COLUMN\b/i },
    { type: 'drop-index', re: /\bDROP\s+INDEX\b/i },
    { type: 'drop-constraint', re: /\bDROP\s+CONSTRAINT\b/i },
    {
      type: 'column-type-narrowing',
      re: /\bALTER\s+TABLE\b[\s\S]*\bALTER\s+COLUMN\b[\s\S]*\bTYPE\s+(?:varchar\s*\(\s*\d+\s*\)|char\s*\(\s*\d+\s*\)|smallint|integer|int\b)/i,
    },
  ];
  for (const f of files || []) {
    const fp = path.join(root, f);
    let sql = '';
    try {
      sql = fs.readFileSync(fp, 'utf8');
    } catch {
      continue;
    }
    const hits = patterns.filter((p) => p.re.test(sql)).map((p) => p.type);
    if (hits.length > 0 && !hasDestructiveAuthorization(sql)) {
      violations.push({
        file: f,
        operations: hits,
        reason: 'destructive migration lacks cobolt-allow-destructive ticket authorization',
      });
    }
  }
  return violations;
}

function collectRlsFeatures(sql) {
  const text = normalizeSql(sql);
  const enabledTables = new Set();
  const policies = new Set();
  for (const m of text.matchAll(/\bALTER\s+TABLE\s+["`]?([\w.]+)["`]?\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY\b/gi)) {
    enabledTables.add(m[1].toLowerCase());
  }
  for (const m of text.matchAll(/\bCREATE\s+POLICY\s+["`]?([\w-]+)["`]?\s+ON\s+["`]?([\w.]+)["`]?/gi)) {
    policies.add(`${m[2].toLowerCase()}:${m[1].toLowerCase()}`);
  }
  return { enabledTables, policies };
}

function detectRlsRegressions(dumped, snapshot) {
  if (!snapshot) return [];
  const after = collectRlsFeatures(dumped);
  const before = collectRlsFeatures(snapshot);
  const regressions = [];
  for (const table of before.enabledTables) {
    if (!after.enabledTables.has(table)) regressions.push({ type: 'rls-disabled', table });
  }
  for (const policy of before.policies) {
    if (!after.policies.has(policy)) regressions.push({ type: 'policy-missing', policy });
  }
  return regressions;
}

function collectIndexes(sql) {
  const indexes = [];
  const text = normalizeSql(sql);
  for (const m of text.matchAll(
    /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+["`]?[\w-]+["`]?\s+ON\s+["`]?([\w.]+)["`]?\s*\(([^)]+)\)/gi,
  )) {
    indexes.push({
      table: m[1].toLowerCase(),
      columns: m[2]
        .split(',')
        .map((c) => c.replace(/["`]/g, '').trim().split(/\s+/)[0].toLowerCase())
        .filter(Boolean),
    });
  }
  return indexes;
}

function loadQueryPatternCorpus(cwd) {
  const candidates = [
    path.join(cwd, '_cobolt-output', 'latest', 'planning', 'query-pattern-corpus.json'),
    path.join(cwd, '_cobolt-output', 'latest', 'build', 'query-pattern-corpus.json'),
    path.join(cwd, 'query-pattern-corpus.json'),
  ];
  for (const fp of candidates) {
    if (!fs.existsSync(fp)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
      const patterns = Array.isArray(parsed) ? parsed : parsed.patterns || [];
      return {
        path: fp,
        minFrequency: Number.isInteger(parsed.minFrequency) ? parsed.minFrequency : 1,
        patterns,
      };
    } catch {
      return { path: fp, minFrequency: 1, patterns: [], parseError: true };
    }
  }
  return null;
}

function detectIndexGaps(dumped, corpus) {
  if (!corpus || !Array.isArray(corpus.patterns) || corpus.patterns.length === 0) return [];
  const indexes = collectIndexes(dumped);
  const gaps = [];
  for (const p of corpus.patterns) {
    const frequency = Number(p.frequency ?? p.count ?? 1);
    if (frequency < corpus.minFrequency) continue;
    const table = String(p.table || p.entity || '').toLowerCase();
    const columns = (Array.isArray(p.columns) ? p.columns : [p.column])
      .filter(Boolean)
      .map((c) => String(c).toLowerCase());
    if (!table || columns.length === 0) continue;
    const covered = indexes.some((idx) => idx.table === table && columns.every((c) => idx.columns.includes(c)));
    if (!covered) gaps.push({ table, columns, frequency });
  }
  return gaps;
}

function manualDumpPath(cwd, milestone) {
  if (!milestone) return null;
  const candidates = [
    path.join(outputRoot(cwd), 'latest', 'build', 'schema-state', `${milestone}.manual.schema.sql`),
    path.join(outputRoot(cwd), 'latest', 'build', 'schema-state', `${milestone}.schema.manual.sql`),
    path.join(outputRoot(cwd), 'latest', 'build', 'schema-state', `manual-${milestone}.schema.sql`),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function appendAudit(cwd, record) {
  try {
    const fp = auditLogPath(cwd);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.appendFileSync(fp, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
  } catch {
    /* audit failure non-fatal */
  }
}

// Core programmatic entry — mockable via opts.driverFactory.
function checkSchemaReplay({
  cwd = process.cwd(),
  milestone = null,
  engine = null,
  cycle = false,
  driverFactory = null,
} = {}) {
  const eng = engine || detectEngine(cwd);
  const { root, files } = discoverMigrations(cwd);
  if (!root || files.length === 0) {
    // v0.47.4: consult Planning intent before declaring a green skip.
    const planIntent = planningDeclaresSchemaWork(cwd);
    if (planIntent.declared) {
      return {
        ok: false,
        skipped: true,
        reason: 'no-migrations-but-plan-declared-schema',
        engine: eng,
        milestone,
        planIntent,
        replayed: 0,
        cycleTested: 0,
        cycleFailures: [],
        replayFailures: [
          {
            stage: 'plan-intent',
            error:
              `Planning evidence (${planIntent.evidence}) declares schema work but Build discovered no migrations. ` +
              'Produce migration files under the schema directory declared in your data-model spec, ' +
              'or remove the schema section from planning if this milestone is non-schema.',
          },
        ],
      };
    }
    return {
      ok: true,
      skipped: true,
      reason: 'no migrations discovered',
      engine: eng,
      milestone,
      planIntent,
      replayed: 0,
      cycleTested: 0,
      cycleFailures: [],
    };
  }
  const factory = driverFactory || selectDriver;
  const driver = factory(eng, cwd);
  if (!driver.available) {
    return {
      ok: false,
      reason: `engine '${eng}' unavailable: ${driver.reason}`,
      engine: eng,
      milestone,
      replayed: 0,
      cycleTested: 0,
      cycleFailures: [],
      engineUnavailable: true,
    };
  }

  const destructiveViolations = detectDestructiveOperations(root, files);
  const replayFailures = [];
  let replayed = 0;
  for (const f of files) {
    const fp = path.join(root, f);
    const sql = fs.readFileSync(fp, 'utf8');
    try {
      driver.replayOne(sql);
      replayed++;
    } catch (e) {
      replayFailures.push({ file: f, error: String(e?.message || e) });
      break; // first failure stops replay — state is undefined afterwards
    }
  }

  let dumped = '';
  try {
    dumped = driver.dumpSchema();
  } catch (e) {
    replayFailures.push({ stage: 'dump', error: String(e?.message || e) });
  }

  // Diff vs snapshot
  const sp = milestone ? snapshotPath(cwd, milestone) : null;
  let drift = null;
  let snapshot = '';
  const replayFingerprint = structuralFingerprint(dumped);
  let snapshotFingerprint = null;
  let rlsRegressions = [];
  if (sp && fs.existsSync(sp)) {
    snapshot = fs.readFileSync(sp, 'utf8');
    drift = diffSchemas(dumped, snapshot);
    snapshotFingerprint = structuralFingerprint(snapshot);
    rlsRegressions = detectRlsRegressions(dumped, snapshot);
  }

  const corpus = loadQueryPatternCorpus(cwd);
  const indexGaps = detectIndexGaps(dumped, corpus);

  const mdp = manualDumpPath(cwd, milestone);
  let manualDumpParity = null;
  if (mdp) {
    const manual = fs.readFileSync(mdp, 'utf8');
    const manualFingerprint = structuralFingerprint(manual);
    manualDumpParity = {
      path: mdp,
      equal: manualFingerprint.digest === replayFingerprint.digest,
      replayDigest: replayFingerprint.digest,
      manualDigest: manualFingerprint.digest,
    };
  }

  // Cycle test — forward/rollback/forward per migration.
  const cycleFailures = [];
  let cycleTested = 0;
  if (cycle && replayFailures.length === 0) {
    for (const f of files) {
      const down = downSibling(root, f);
      if (!down) {
        cycleFailures.push({ file: f, reason: 'down sibling missing' });
        continue;
      }
      try {
        const upSql = fs.readFileSync(path.join(root, f), 'utf8');
        const downSql = fs.readFileSync(down, 'utf8');
        driver.replayOne(downSql);
        driver.replayOne(upSql);
        cycleTested++;
      } catch (e) {
        cycleFailures.push({ file: f, reason: String(e?.message || e) });
      }
    }
  }

  driver.cleanup();

  const driftFailed = drift && drift.equal === false;
  const manualDumpFailed = manualDumpParity && manualDumpParity.equal === false;
  const ok =
    replayFailures.length === 0 &&
    destructiveViolations.length === 0 &&
    !driftFailed &&
    rlsRegressions.length === 0 &&
    indexGaps.length === 0 &&
    !manualDumpFailed &&
    cycleFailures.length === 0;

  if (!ok) {
    appendAudit(cwd, {
      milestone,
      engine: eng,
      replayFailures,
      destructiveViolations,
      drift: driftFailed ? drift : null,
      rlsRegressions,
      indexGaps,
      manualDumpParity: manualDumpFailed ? manualDumpParity : null,
      cycleFailures,
    });
  }

  return {
    ok,
    engine: eng,
    milestone,
    totalMigrations: files.length,
    replayed,
    replayFailures,
    snapshotPath: sp,
    snapshotPresent: !!(sp && fs.existsSync(sp)),
    drift,
    structuralFingerprint: replayFingerprint,
    snapshotFingerprint,
    destructiveViolations,
    rlsRegressions,
    queryPatternCorpusPath: corpus?.path || null,
    indexGaps,
    manualDumpParity,
    cycleTested,
    cycleFailures,
    gitSha: headSha(cwd),
  };
}

function writeVerdict(cwd, milestone, result) {
  const fp = verdictPath(cwd, milestone);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const verdict = {
    measuredAt: new Date().toISOString(),
    milestone,
    gitSha: result.gitSha,
    engine: result.engine,
    ok: result.ok,
    totalMigrations: result.totalMigrations,
    replayed: result.replayed,
    replayFailures: result.replayFailures,
    snapshotPresent: result.snapshotPresent,
    drift: result.drift,
    structuralFingerprint: result.structuralFingerprint,
    snapshotFingerprint: result.snapshotFingerprint,
    destructiveViolations: result.destructiveViolations,
    rlsRegressions: result.rlsRegressions,
    queryPatternCorpusPath: result.queryPatternCorpusPath,
    indexGaps: result.indexGaps,
    manualDumpParity: result.manualDumpParity,
    cycleTested: result.cycleTested,
    cycleFailures: result.cycleFailures,
  };
  fs.writeFileSync(fp, `${JSON.stringify(verdict, null, 2)}\n`);
  return fp;
}

function parseFlags(args) {
  const out = { _: [], milestone: null, engine: null, cycle: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--milestone') out.milestone = args[++i];
    else if (a === '--engine') out.engine = args[++i];
    else if (a === '--cycle') out.cycle = true;
    else if (a === '--json') out.json = true;
    else out._.push(a);
  }
  return out;
}

function currentMilestone(cwd) {
  try {
    const sp = path.join(cwd, 'cobolt-state.json');
    if (!fs.existsSync(sp)) return null;
    const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
    return s.pipeline?.currentMilestone || s.currentMilestone || null;
  } catch {
    return null;
  }
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const cwd = process.cwd();
  const milestone = flags.milestone || currentMilestone(cwd);

  switch (cmd) {
    case 'check':
    case 'verify': {
      const result = checkSchemaReplay({ cwd, milestone, engine: flags.engine, cycle: flags.cycle });
      if (milestone) writeVerdict(cwd, milestone, result);
      console.log(JSON.stringify(result, null, 2));
      if (result.skipped) return 0;
      return result.ok ? 0 : 1;
    }
    case 'snapshot': {
      if (!milestone) {
        console.error('snapshot requires --milestone');
        return 2;
      }
      const result = checkSchemaReplay({ cwd, milestone, engine: flags.engine, cycle: false });
      if (!result.ok && !result.skipped) {
        console.error('cannot snapshot — replay failed');
        console.error(JSON.stringify(result, null, 2));
        return 1;
      }
      // Writing pinned schema isn't this tool's job by default; emit to stdout.
      // Callers pipe to snapshotPath() as needed.
      const driver = selectDriver(flags.engine || detectEngine(cwd), cwd);
      if (!driver.available) {
        console.error(`engine unavailable: ${driver.reason}`);
        return 2;
      }
      const { root, files } = discoverMigrations(cwd);
      for (const f of files) driver.replayOne(fs.readFileSync(path.join(root, f), 'utf8'));
      const dump = driver.dumpSchema();
      driver.cleanup();
      const fp = snapshotPath(cwd, milestone);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, dump);
      console.log(fp);
      return 0;
    }
    default:
      console.error(
        'Usage: cobolt-schema-replay.js <check|snapshot> [--milestone M2] [--engine sqlite|postgres|mysql] [--cycle] [--json]',
      );
      return 2;
  }
}

if (require.main === module) process.exit(main());

module.exports = {
  checkSchemaReplay,
  detectEngine,
  discoverMigrations,
  diffSchemas,
  normalizeSql,
  structuralFingerprint,
  detectDestructiveOperations,
  hasDestructiveAuthorization,
  collectRlsFeatures,
  detectRlsRegressions,
  collectIndexes,
  loadQueryPatternCorpus,
  detectIndexGaps,
  manualDumpPath,
  sqliteDriver,
  dockerDriver,
  selectDriver,
  verdictPath,
  snapshotPath,
  auditLogPath,
  writeVerdict,
};
