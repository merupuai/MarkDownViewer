#!/usr/bin/env node

// CoBolt Migration Safety Analyzer — database migration risk detection
//
// Validates database migrations for safety: locking risks, data loss,
// rollback capability, and migration ordering.
//
// Supports: Ecto (Elixir), Sequelize/Knex/Prisma (JS/TS), Alembic/Django (Python), Goose (Go)
//
// No LLM inference. Pure regex/pattern scanning.
//
// Usage:
//   node tools/cobolt-migration-safety.js scan [--dir priv/repo/migrations] [--json] [--save]
//
// Exit codes:  0 = no high-severity risks, 1 = migration risks detected

const fs = require('node:fs');
const path = require('node:path');

const { paths: _paths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();

// ── Migration File Discovery ──────────────────────────────

const MIGRATION_DIRS = [
  'priv/repo/migrations', // Ecto
  'app/priv/repo/migrations', // Ecto (nested)
  'migrations', // Knex, Sequelize, Django, Alembic
  'db/migrate', // Rails-style
  'db/migrations', // Generic
  'prisma/migrations', // Prisma
  'alembic/versions', // Alembic
];

const MIGRATION_EXTENSIONS = new Set(['.exs', '.ex', '.js', '.ts', '.py', '.sql', '.go']);

function findMigrationFiles(projectDir, customDir) {
  const files = [];

  const dirs = customDir ? [path.resolve(projectDir, customDir)] : MIGRATION_DIRS.map((d) => path.join(projectDir, d));

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Prisma: each migration has its own directory
          const sqlFile = path.join(dir, entry.name, 'migration.sql');
          if (fs.existsSync(sqlFile)) files.push(sqlFile);
          continue;
        }
        if (MIGRATION_EXTENSIONS.has(path.extname(entry.name))) {
          files.push(path.join(dir, entry.name));
        }
      }
    } catch {}
  }

  return files;
}

// ── Dangerous Operation Patterns ──────────────────────────

const DANGER_PATTERNS = [
  // Data loss operations
  {
    id: 'MIG-DROP-TABLE',
    pattern: /\bdrop\s+table\b/i,
    severity: 'high',
    message: 'DROP TABLE — irreversible data loss',
    suggestion: 'Consider renaming table first, then dropping after verification period.',
  },
  {
    id: 'MIG-DROP-COL',
    pattern: /\balter\s+table\s+\S+\s+drop\s+(?:column\s+)?\w+/i,
    severity: 'high',
    message: 'DROP COLUMN — data loss on column removal',
    suggestion: 'Backup column data before dropping. Use multi-step migration.',
  },
  {
    id: 'MIG-TRUNCATE',
    pattern: /\btruncate\s+(?:table\s+)?\w+/i,
    severity: 'high',
    message: 'TRUNCATE — irreversible data deletion',
    suggestion: 'Use soft delete or archive pattern instead.',
  },
  // Ecto-specific drops
  {
    id: 'MIG-ECTO-DROP',
    pattern: /\bdrop\s+(?:table|index|constraint)\s*\(/i,
    severity: 'high',
    message: 'Ecto drop operation — verify data backup exists',
    suggestion: 'Add a comment documenting the data impact.',
  },

  // Locking risks
  {
    id: 'MIG-ADD-INDEX',
    pattern: /\badd\s+index\b(?!.*concurrently)/i,
    severity: 'high',
    message: 'ADD INDEX without CONCURRENTLY — locks table during creation',
    suggestion: 'Use CREATE INDEX CONCURRENTLY (or Ecto :concurrently option) to avoid locking.',
  },
  {
    id: 'MIG-CREATE-INDEX',
    pattern: /\bcreate\s+(?:unique\s+)?index\b(?!.*concurrently)/i,
    severity: 'high',
    message: 'CREATE INDEX without CONCURRENTLY — table lock risk on large tables',
    suggestion: 'Use CREATE INDEX CONCURRENTLY for zero-downtime index creation.',
  },
  // Ecto: create index without concurrently
  {
    id: 'MIG-ECTO-INDEX',
    pattern: /create\s*\(\s*index\s*\([^)]*\)(?!.*concurrently)/,
    severity: 'medium',
    message: 'Ecto index creation — consider :concurrently option for large tables',
    suggestion: 'Add concurrently: true and disable_ddl_transaction for safe index creation.',
  },
  {
    id: 'MIG-ALTER-TYPE',
    pattern: /\balter\s+table\s+\S+\s+alter\s+(?:column\s+)?\w+\s+(?:set\s+data\s+)?type/i,
    severity: 'medium',
    message: 'ALTER COLUMN TYPE — may require full table rewrite and lock',
    suggestion: 'For large tables, create new column, migrate data, then swap.',
  },
  {
    id: 'MIG-NOT-NULL',
    pattern: /\balter\s+table\s+\S+\s+alter\s+(?:column\s+)?\w+\s+set\s+not\s+null/i,
    severity: 'medium',
    message: 'SET NOT NULL — requires full table scan to validate',
    suggestion: 'Add CHECK constraint first (NOT VALID), then validate separately.',
  },

  // Rename risks
  {
    id: 'MIG-RENAME-TABLE',
    pattern: /\brename\s+table\b|\balter\s+table\s+\S+\s+rename\s+to/i,
    severity: 'high',
    message: 'RENAME TABLE — breaks all references unless coordinated',
    suggestion: 'Create new table, copy data, update references, then drop old.',
  },
  {
    id: 'MIG-RENAME-COL',
    pattern: /\brename\s+column\b|\balter\s+table\s+\S+\s+rename\s+column/i,
    severity: 'medium',
    message: 'RENAME COLUMN — breaks code referencing old name',
    suggestion: 'Add new column, migrate data, update code, then drop old column.',
  },
  // Ecto rename
  {
    id: 'MIG-ECTO-RENAME',
    pattern: /\brename\s+table\s*\(|rename\s*\(\s*table\s*\(/,
    severity: 'high',
    message: 'Ecto table rename — coordinate with all query references',
    suggestion: 'Multi-step: add alias, update queries, remove old name.',
  },

  // Mixed data+schema migration (anti-pattern)
  {
    id: 'MIG-MIXED',
    pattern: /(?:Repo\.(insert|update|delete|query)|execute\s*\(\s*["'](?:INSERT|UPDATE|DELETE))/i,
    severity: 'medium',
    message: 'Data migration mixed with schema migration — anti-pattern',
    suggestion: 'Separate schema changes from data migrations for safer rollback.',
  },

  // Raw SQL execution
  {
    id: 'MIG-RAW-SQL',
    pattern: /execute\s*\(\s*["'`](?:DROP|TRUNCATE|DELETE\s+FROM)/i,
    severity: 'high',
    message: 'Raw SQL with destructive operation in migration',
    suggestion: 'Use ORM migration DSL when possible. Document destructive raw SQL.',
  },
];

// ── Missing Down Migration Detection ──────────────────────

function checkReversibility(content, filePath) {
  const findings = [];
  const ext = path.extname(filePath);

  // Ecto: check for both `up` and `down` functions, or `change`
  if (ext === '.exs' || ext === '.ex') {
    const hasChange = /\bdef\s+change\b/.test(content);
    const hasUp = /\bdef\s+up\b/.test(content);
    const hasDown = /\bdef\s+down\b/.test(content);

    if (hasUp && !hasDown && !hasChange) {
      findings.push({
        id: 'MIG-NO-DOWN',
        type: 'missing-down',
        severity: 'high',
        message: 'Migration has `up` but no `down` — irreversible migration',
        suggestion: 'Add a `down` function or use `change` (auto-reversible).',
      });
    }
  }

  // Sequelize/Knex: check for both up/down exports
  if (ext === '.js' || ext === '.ts') {
    const hasUp = /exports\.up|module\.exports.*up\s*[:=]/.test(content);
    const hasDown = /exports\.down|module\.exports.*down\s*[:=]/.test(content);

    if (hasUp && !hasDown) {
      findings.push({
        id: 'MIG-NO-DOWN',
        type: 'missing-down',
        severity: 'high',
        message: 'Migration has `up` but no `down` — irreversible migration',
        suggestion: 'Add a `down` export for rollback capability.',
      });
    }
  }

  // Alembic: check for upgrade/downgrade
  if (ext === '.py') {
    const hasUpgrade = /\bdef\s+upgrade\b/.test(content);
    const hasDowngrade = /\bdef\s+downgrade\b/.test(content);
    const downgradeEmpty = /def\s+downgrade\b[^:]*:\s*(?:\n\s+)?pass\s*$/m.test(content);

    if (hasUpgrade && !hasDowngrade) {
      findings.push({
        id: 'MIG-NO-DOWN',
        type: 'missing-down',
        severity: 'high',
        message: 'Migration has `upgrade` but no `downgrade` — irreversible',
        suggestion: 'Add a `downgrade` function for rollback capability.',
      });
    }
    if (downgradeEmpty) {
      findings.push({
        id: 'MIG-EMPTY-DOWN',
        type: 'empty-down',
        severity: 'medium',
        message: 'Downgrade function is empty (pass) — no-op rollback',
        suggestion: 'Implement actual rollback logic in downgrade.',
      });
    }
  }

  return findings;
}

// ── Migration Ordering Check ──────────────────────────────

function checkOrdering(files) {
  const findings = [];
  const timestamps = [];

  for (const file of files) {
    const basename = path.basename(file);
    // Extract timestamp: 20240101120000, 001_, V1__, etc.
    const tsMatch = basename.match(/^(\d{10,14})/);
    if (tsMatch) {
      timestamps.push({ file: basename, ts: tsMatch[1] });
    }
  }

  // Check for duplicate timestamps
  const seen = new Map();
  for (const { file, ts } of timestamps) {
    if (seen.has(ts)) {
      findings.push({
        id: 'MIG-DUP-TS',
        type: 'duplicate-timestamp',
        severity: 'medium',
        file,
        message: `Duplicate migration timestamp "${ts}" — conflicts with "${seen.get(ts)}"`,
        suggestion: 'Rename one migration to use a unique timestamp.',
      });
    }
    seen.set(ts, file);
  }

  return findings;
}

// ── Main Scanner ──────────────────────────────────────────

// Cross-milestone FK validation (Tier 2.2 — v0.11.0)
// Detect foreign keys that reference tables which are never created in the
// cumulative schema, or are dropped before the referring migration runs.
function checkForeignKeyResolution(files, projectDir) {
  const createdTables = new Map(); // table → earliestFile
  const droppedTables = new Map(); // table → dropFile
  const fkRefs = []; // { fromFile, fromTable, toTable }

  // SQL + Ecto + Rails create/drop detection
  const createPatterns = [
    /create\s+table\s+(?:if\s+not\s+exists\s+)?[`"']?(\w+)[`"']?/gi, // SQL
    /create\s+table\s*\(\s*:(\w+)/gi, // Ecto: create table(:users)
    /create_table\s+:(\w+)/gi, // Rails: create_table :users
  ];
  const dropPatterns = [
    /drop\s+table\s+(?:if\s+exists\s+)?[`"']?(\w+)[`"']?/gi, // SQL
    /drop\s+table\s*\(\s*:(\w+)/gi, // Ecto
    /drop_table\s+:(\w+)/gi, // Rails
  ];
  // Match common FK syntaxes across SQL dialects + Ecto + AR
  const fkPatterns = [
    // SQL: REFERENCES users(id) / REFERENCES users
    /references\s+[`"']?(\w+)[`"']?\s*\(/gi,
    /foreign\s+key\s*\([^)]+\)\s*references\s+[`"']?(\w+)[`"']?/gi,
    // Ecto migration DSL: add :user_id, references(:users) / references(:users, type: :uuid)
    /references\s*\(\s*:(\w+)/gi,
    // Ecto schema: belongs_to :user — FK to :users (naive pluralization)
    /belongs_to\s+:(\w+)/gi,
    // Rails migration DSL: add_foreign_key :orders, :users / t.references :user
    /add_foreign_key\s+:\w+\s*,\s*:(\w+)/gi,
    /t\.references\s+:(\w+)/gi,
    // Legacy colon form (covered above more precisely)
    /references?\s*:\s*?[`"']?(\w+)[`"']?/gi,
  ];

  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lower = text.toLowerCase();
    let m;
    for (const pat of createPatterns) {
      pat.lastIndex = 0;
      while ((m = pat.exec(lower)) !== null) {
        const t = m[1].toLowerCase();
        if (!createdTables.has(t)) createdTables.set(t, file);
      }
    }
    for (const pat of dropPatterns) {
      pat.lastIndex = 0;
      while ((m = pat.exec(lower)) !== null) {
        droppedTables.set(m[1].toLowerCase(), file);
      }
    }
    for (const pat of fkPatterns) {
      pat.lastIndex = 0;
      while ((m = pat.exec(lower)) !== null) {
        fkRefs.push({ file, toTable: m[1].toLowerCase() });
      }
    }
  }

  const findings = [];
  // Ruby/Rails/Ecto symbols are commonly the singular form of the table name
  // (e.g. `belongs_to :user` → table `users`). Try pluralized fallback.
  function resolveTable(name) {
    if (createdTables.has(name)) return name;
    if (createdTables.has(`${name}s`)) return `${name}s`;
    if (name.endsWith('y') && createdTables.has(`${name.slice(0, -1)}ies`)) return `${name.slice(0, -1)}ies`;
    return null;
  }

  for (const ref of fkRefs) {
    const rel = path.relative(projectDir, ref.file);
    const resolved = resolveTable(ref.toTable);
    if (!resolved) {
      findings.push({
        id: `FK-ORPHAN-${String(findings.length + 1).padStart(3, '0')}`,
        type: 'FK_ORPHAN',
        severity: 'high',
        file: rel,
        line: 0,
        message: `Foreign key references table "${ref.toTable}" which is not created by any migration`,
        snippet: `references ${ref.toTable}`,
        suggestion: `Ensure the migration that creates "${ref.toTable}" runs before this one; check milestone ordering.`,
      });
      continue;
    }
    // Ordering: referenced table must be created in an earlier (or same) file
    const toFile = createdTables.get(resolved);
    if (toFile > ref.file) {
      findings.push({
        id: `FK-ORDER-${String(findings.length + 1).padStart(3, '0')}`,
        type: 'FK_ORDER',
        severity: 'high',
        file: rel,
        line: 0,
        message: `Foreign key to "${ref.toTable}" references a table created in a later migration (${path.relative(projectDir, toFile)})`,
        snippet: `references ${ref.toTable}`,
        suggestion:
          'Reorder migrations so the referenced table is created first. Cross-milestone: bump the referring migration to a later milestone.',
      });
    }
    // Drop-before-reference: referenced table dropped before this migration's timestamp
    const dropFile = droppedTables.get(resolved);
    if (dropFile && dropFile < ref.file) {
      findings.push({
        id: `FK-DROPPED-${String(findings.length + 1).padStart(3, '0')}`,
        type: 'FK_DROPPED',
        severity: 'high',
        file: rel,
        line: 0,
        message: `Foreign key references "${ref.toTable}" which was dropped by an earlier migration (${path.relative(projectDir, dropFile)})`,
        snippet: `references ${ref.toTable}`,
        suggestion: 'Either restore the dropped table or remove the FK.',
      });
    }
  }
  return findings;
}

function scan(projectDir, options = {}) {
  const files = findMigrationFiles(projectDir, options.dir);

  if (files.length === 0) {
    return {
      findings: [],
      summary: { total: 0, migrationsScanned: 0, bySeverity: {} },
      score: 100,
      verdict: 'PASS',
      timestamp: new Date().toISOString(),
    };
  }

  const allFindings = [];

  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const relFile = path.relative(projectDir, file);
    const lines = content.split('\n');

    // Check dangerous patterns
    for (const pattern of DANGER_PATTERNS) {
      for (let i = 0; i < lines.length; i++) {
        if (pattern.pattern.test(lines[i])) {
          allFindings.push({
            id: `${pattern.id}-${String(allFindings.length + 1).padStart(3, '0')}`,
            type: pattern.id,
            severity: pattern.severity,
            file: relFile,
            line: i + 1,
            message: pattern.message,
            snippet: lines[i].trim().substring(0, 120),
            suggestion: pattern.suggestion,
          });
        }
      }
    }

    // Check reversibility
    const reversibilityFindings = checkReversibility(content, file);
    for (const f of reversibilityFindings) {
      allFindings.push({ ...f, file: relFile, line: 0 });
    }
  }

  // Check ordering across all files
  const orderFindings = checkOrdering(files);
  allFindings.push(...orderFindings);

  // Cross-milestone FK validation (new v0.11.0)
  const fkFindings = checkForeignKeyResolution(files, projectDir);
  allFindings.push(...fkFindings);

  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const f of allFindings) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;

  const byType = {};
  for (const f of allFindings) byType[f.type || f.id] = (byType[f.type || f.id] || 0) + 1;

  const penalties = { high: 18, medium: 8, low: 2 };
  const score = Math.max(0, 100 - allFindings.reduce((s, f) => s + (penalties[f.severity] || 0), 0));

  return {
    findings: allFindings,
    summary: {
      total: allFindings.length,
      migrationsScanned: files.length,
      migrationDirs: [...new Set(files.map((f) => path.dirname(path.relative(projectDir, f))))],
      bySeverity,
      byType,
    },
    score,
    verdict: score >= 90 ? 'PASS' : score >= 75 ? 'WATCH' : 'FAIL',
    timestamp: new Date().toISOString(),
  };
}

function writeReport(projectDir, result) {
  const _p = typeof _paths === 'function' ? _paths(projectDir) : null;
  const outDir = _p ? _p.review() : path.join(projectDir, '_cobolt-output/latest/review');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const dest = path.join(outDir, 'migration-safety-report.json');
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, dest);
  return dest;
}

module.exports = { scan, writeReport, findMigrationFiles, DANGER_PATTERNS };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === 'scan') {
    const options = {};
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--dir' && args[i + 1]) options.dir = args[++i];
      else if (args[i] === '--json') options.json = true;
      else if (args[i] === '--save') options.save = true;
    }

    const result = scan(process.cwd(), options);

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\n  CoBolt Migration Safety — ${result.summary.migrationsScanned} migrations scanned`);
      console.log('  ══════════════════════════════════════════════');
      if (result.summary.migrationDirs) console.log(`  Dirs: ${result.summary.migrationDirs.join(', ')}`);
      console.log(
        `  High: ${result.summary.bySeverity.high || 0} | Medium: ${result.summary.bySeverity.medium || 0} | Low: ${result.summary.bySeverity.low || 0}`,
      );
      console.log(`  Score: ${result.score}% — ${result.verdict}`);
      console.log('  ══════════════════════════════════════════════');
      for (const f of result.findings.slice(0, 20)) {
        const icon = f.severity === 'high' ? '\u2717' : f.severity === 'medium' ? '\u26A0' : '\u2022';
        const loc = f.line > 0 ? `:${f.line}` : '';
        console.log(`  ${icon} ${f.file || ''}${loc} — ${f.message}`);
        if (f.snippet) console.log(`    ${f.snippet}`);
      }
    }

    if (options.save) {
      const dest = writeReport(process.cwd(), result);
      if (!options.json) console.log(`\n  Report saved: ${dest}`);
    }

    process.exit(result.findings.some((f) => f.severity === 'high') ? 1 : 0);
  } else {
    console.log('  CoBolt Migration Safety');
    console.log('  Usage: node tools/cobolt-migration-safety.js scan [--dir migrations/] [--json] [--save]');
  }
}
