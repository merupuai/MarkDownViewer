#!/usr/bin/env node

// CoBolt Seed-Shape Emitter (v0.12.0 Phase 1C)
//
// Produces _cobolt-output/latest/planning/milestones/M{x}/seed-shape.json from
// the current architecture artifacts:
//   - data-model.md (primary — human-authored schema spec)
//   - migrations/**     (fallback — parse CREATE TABLE statements)
//
// This closes the #1 emitter gap in v0.11.0: the seed-gate reads these files
// but no tool ever wrote them. Without this emitter the gate stays permissive
// and cumulative seed drift ships silently.
//
// Usage:
//   node tools/cobolt-seed-shape-emit.js emit --milestone M1
//   node tools/cobolt-seed-shape-emit.js emit --all     # all declared milestones
//   node tools/cobolt-seed-shape-emit.js check          # exit 1 if any milestone missing a seed-shape
//
// Algorithm:
//   1. Read milestones.md → get list of M1..Mn.
//   2. Read data-model.md → parse tables+columns+FKs.
//   3. Read each milestone-architecture-delta (if present) to attribute
//      newly-introduced tables to their owning milestone.
//   4. For each milestone M(k): inherits M(k-1..1). Tables owned by M(k) are
//      written with their shape; earlier tables inherited by reference.
//   5. Emit one seed-shape.json per milestone.
//
// Idempotent — rewrites the same file on repeat runs; does not clobber
// existing manual edits when `--preserve-manual` is set (default: overwrite).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = '1.0.0';

function planningDir() {
  const candidates = [
    path.join(process.cwd(), '_cobolt-output', 'latest', 'planning'),
    path.join(process.cwd(), '_cobolt-output', 'planning'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0];
}

function readIfExists(fp) {
  try {
    return fs.readFileSync(fp, 'utf8');
  } catch {
    return null;
  }
}

// ── Milestone discovery ──────────────────────────────────────────────

function discoverMilestones() {
  const pdir = planningDir();
  const mfile = path.join(pdir, 'milestones.md');
  const text = readIfExists(mfile) || '';
  const ids = new Set();
  const re = /\bM(\d+)\b/g;
  let m;
  while ((m = re.exec(text)) !== null) ids.add(Number(m[1]));
  // Also look at disk — any pre-existing milestone dirs imply the milestone is real
  const mdir = path.join(pdir, 'milestones');
  if (fs.existsSync(mdir)) {
    for (const e of fs.readdirSync(mdir)) {
      const mm = /^M(\d+)$/.exec(e);
      if (mm) ids.add(Number(mm[1]));
    }
  }
  return [...ids].sort((a, b) => a - b).map((n) => `M${n}`);
}

// ── Data-model parsing ───────────────────────────────────────────────

// Parse CREATE TABLE statements from SQL-flavored or markdown-embedded sources.
// Returns { tableName: { columns: [..], foreignKeys: [..], uniqueOn: [..] } }
function parseCreateTables(sqlText) {
  const tables = {};
  if (!sqlText) return tables;

  const ctRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?[`"']?(\w+)[`"']?\s*\(([\s\S]*?)\);/gi;
  let m;
  while ((m = ctRe.exec(sqlText)) !== null) {
    const name = m[1].toLowerCase();
    const body = m[2];
    const columns = [];
    const fks = [];
    const uniques = [];

    for (const rawLine of body.split(/,(?![^()]*\))/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const lower = line.toLowerCase();
      if (lower.startsWith('foreign key')) {
        const fkm =
          /foreign\s+key\s*\(\s*([^)]+)\s*\)\s+references\s+[`"']?(\w+)[`"']?\s*\(\s*([^)]+)\s*\)(?:\s+on\s+delete\s+(\w+(?:\s+\w+)?))?/i.exec(
            line,
          );
        if (fkm) {
          fks.push({
            column: fkm[1].replace(/[`"']/g, '').trim(),
            references: `${fkm[2]}.${fkm[3].replace(/[`"']/g, '').trim()}`,
            onDelete: fkm[4] ? fkm[4].toLowerCase() : undefined,
          });
        }
        continue;
      }
      if (lower.startsWith('unique')) {
        const uniqm = /unique\s*\(\s*([^)]+)\s*\)/i.exec(line);
        if (uniqm) uniques.push(uniqm[1].split(',').map((c) => c.replace(/[`"']/g, '').trim()));
        continue;
      }
      if (lower.startsWith('primary key') || lower.startsWith('constraint') || lower.startsWith('check')) continue;

      const colm = /^[`"']?(\w+)[`"']?\s+/.exec(line);
      if (colm) columns.push(colm[1]);
    }

    tables[name] = { columns, foreignKeys: fks, uniqueOn: uniques, sourceLine: m.index };
  }
  return tables;
}

// Parse markdown tables that describe schemas (common in data-model.md):
// | Column | Type | Notes |
// |--------|------|-------|
// | id     | uuid | pk    |
function parseMarkdownTables(mdText) {
  const out = {};
  if (!mdText) return out;
  // Heading style: "## users table" or "### Table: users"
  const sectionRe = /^#{2,4}\s+(?:Table\s*:\s*)?[`"']?(\w+)[`"']?\s*(?:table)?\s*$/gim;
  let m;
  const sections = [];
  while ((m = sectionRe.exec(mdText)) !== null) sections.push({ name: m[1].toLowerCase(), start: m.index });
  for (let i = 0; i < sections.length; i++) {
    const { name } = sections[i];
    const start = sections[i].start;
    const end = i + 1 < sections.length ? sections[i + 1].start : mdText.length;
    const block = mdText.slice(start, end);
    // Extract first markdown table
    const rowsRe = /^\s*\|\s*([^|]+?)\s*\|[^\n]*$/gm;
    const columns = [];
    let rm;
    let rowCount = 0;
    while ((rm = rowsRe.exec(block)) !== null) {
      rowCount++;
      const cell = rm[1].trim();
      if (rowCount <= 2) continue; // header + separator
      if (/^[-:]+$/.test(cell)) continue;
      if (cell.toLowerCase() === 'column' || cell.toLowerCase() === 'field') continue;
      if (/\w/.test(cell)) columns.push(cell.split(/\s+/)[0].toLowerCase());
    }
    if (columns.length > 0) out[name] = { columns, foreignKeys: [], uniqueOn: [] };
  }
  return out;
}

function mergeTables(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (!out[k]) {
      out[k] = v;
      continue;
    }
    out[k] = {
      columns: Array.from(new Set([...(out[k].columns || []), ...(v.columns || [])])),
      foreignKeys: [...(out[k].foreignKeys || []), ...(v.foreignKeys || [])],
      uniqueOn: [...(out[k].uniqueOn || []), ...(v.uniqueOn || [])],
    };
  }
  return out;
}

function fingerprint(table) {
  const str = JSON.stringify({
    cols: [...(table.columns || [])].sort(),
    fks: [...(table.foreignKeys || [])].sort((a, b) => (a.column || '').localeCompare(b.column || '')),
  });
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

// ── Attribution: which milestone introduced which table? ────────────

// v0.12.1 fix #8: improved attribution. Order of precedence:
//   1. architecture-delta.md per milestone (most accurate — explicit)
//   2. milestones.md body scan for "introduces table X" / entity mentions
//      under a milestone heading
//   3. rtm.json: if any FR that introduces the entity is assigned to Mk,
//      attribute to Mk
//   4. Fall back to earliest milestone (M1) — previous behavior
function milestoneForTable(tableName, pdir, allMilestones, rtmCache) {
  // 1. Per-milestone deltas
  const mdir = path.join(pdir, 'milestones');
  if (fs.existsSync(mdir)) {
    let earliest = null;
    for (const e of fs.readdirSync(mdir)) {
      const mm = /^M(\d+)$/.exec(e);
      if (!mm) continue;
      const delta = readIfExists(path.join(mdir, e, 'architecture-delta.md')) || '';
      const re = new RegExp(`\\b${tableName}\\b`, 'i');
      if (re.test(delta)) {
        const n = Number(mm[1]);
        if (earliest === null || n < earliest) earliest = n;
      }
    }
    if (earliest !== null) return `M${earliest}`;
  }

  // 2. milestones.md section scan — look for "M2" header, find table mentions in that section
  const milestonesText = readIfExists(path.join(pdir, 'milestones.md'));
  if (milestonesText) {
    const sections = [];
    const headerRe = /^#{1,6}\s+(?:Milestone\s+)?M(\d+)\b/gim;
    let m;
    while ((m = headerRe.exec(milestonesText)) !== null) {
      sections.push({ m: Number(m[1]), start: m.index });
    }
    sections.sort((a, b) => a.start - b.start);
    for (let i = 0; i < sections.length; i++) {
      const start = sections[i].start;
      const end = i + 1 < sections.length ? sections[i + 1].start : milestonesText.length;
      const body = milestonesText.slice(start, end);
      if (new RegExp(`\\b${tableName}\\b`, 'i').test(body)) return `M${sections[i].m}`;
    }
  }

  // 3. RTM cross-reference — look for FR whose description mentions the table
  if (rtmCache?.requirements) {
    for (const req of Object.values(rtmCache.requirements)) {
      const hay = `${req.title || ''} ${req.description || ''} ${(req.acceptance_criteria || []).join(' ')}`;
      if (new RegExp(`\\b${tableName}\\b`, 'i').test(hay) && req.milestone) return req.milestone;
    }
  }

  // 4. Fallback to earliest declared milestone
  return allMilestones[0] || null;
}

// ── Emission ─────────────────────────────────────────────────────────

function buildShapeFor(milestone, allMilestones, tables, pdir, rtmCache) {
  const mi = allMilestones.indexOf(milestone);
  const inheritsFrom = allMilestones.slice(0, mi);
  const ownedTables = {};
  for (const [name, tab] of Object.entries(tables)) {
    const introducedBy = milestoneForTable(name, pdir, allMilestones, rtmCache) || allMilestones[0];
    if (introducedBy !== milestone) continue;
    ownedTables[name] = {
      minRows: 0,
      requiredColumns: [...(tab.columns || [])],
      foreignKeys: tab.foreignKeys || [],
      uniqueOn: tab.uniqueOn || [],
      schemaFingerprint: fingerprint(tab),
      introducedBy,
    };
  }
  return {
    milestone,
    version: VERSION,
    inheritsFrom,
    tables: ownedTables,
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-seed-shape-emit',
  };
}

function emit(options = {}) {
  const pdir = planningDir();
  const milestones = discoverMilestones();
  if (milestones.length === 0) {
    return { ok: false, reason: 'no milestones declared' };
  }
  const dataModelText =
    readIfExists(path.join(pdir, 'data-model.md')) ||
    readIfExists(path.join(pdir, 'architecture', 'data-model.md')) ||
    '';
  // Migration SQL (fallback/augment)
  const migRoots = ['migrations', 'priv/repo/migrations', 'db/migrate'];
  let migrationSql = '';
  for (const r of migRoots) {
    const d = path.join(process.cwd(), r);
    if (!fs.existsSync(d)) continue;
    for (const e of fs.readdirSync(d)) {
      const ext = path.extname(e).toLowerCase();
      if (!['.sql', '.ex', '.exs', '.rb', '.py', '.ts', '.js'].includes(ext)) continue;
      migrationSql += `\n${readIfExists(path.join(d, e)) || ''}`;
    }
  }
  const tables = mergeTables(
    parseCreateTables(`${dataModelText}\n${migrationSql}`),
    parseMarkdownTables(dataModelText),
  );

  // v0.12.1 fix #8: load RTM once to enable FR-based attribution
  const rtmCache = readIfExists(path.join(pdir, 'rtm.json'))
    ? (() => {
        try {
          return JSON.parse(readIfExists(path.join(pdir, 'rtm.json')));
        } catch {
          return null;
        }
      })()
    : null;

  const targets = options.all ? milestones : options.milestone ? [options.milestone] : milestones;
  const written = [];
  for (const m of targets) {
    if (!milestones.includes(m)) continue;
    const shape = buildShapeFor(m, milestones, tables, pdir, rtmCache);
    const outDir = path.join(pdir, 'milestones', m);
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, 'seed-shape.json');
    if (options.preserveManual && fs.existsSync(outFile)) continue;
    fs.writeFileSync(outFile, JSON.stringify(shape, null, 2));
    written.push(outFile);
  }
  return { ok: true, written, milestones, tablesDetected: Object.keys(tables).length };
}

function check() {
  const pdir = planningDir();
  const milestones = discoverMilestones();
  const missing = [];
  for (const m of milestones) {
    const fp = path.join(pdir, 'milestones', m, 'seed-shape.json');
    if (!fs.existsSync(fp)) missing.push(m);
  }
  return { ok: missing.length === 0, milestones, missing };
}

function parseFlags(args) {
  const out = { _: [], milestone: null, all: false, preserveManual: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--milestone') out.milestone = args[++i];
    else if (a === '--all') out.all = true;
    else if (a === '--preserve-manual') out.preserveManual = true;
    else out._.push(a);
  }
  return out;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (cmd) {
    case 'emit': {
      const r = emit(flags);
      console.log(JSON.stringify(r, null, 2));
      return r.ok ? 0 : 1;
    }
    case 'check': {
      const r = check();
      console.log(JSON.stringify(r, null, 2));
      return r.ok ? 0 : 1;
    }
    default:
      console.error('Usage: cobolt-seed-shape-emit.js {emit|check} [--milestone M1] [--all] [--preserve-manual]');
      return 1;
  }
}

if (require.main === module) process.exit(main());

module.exports = { emit, check, parseCreateTables, parseMarkdownTables, fingerprint, discoverMilestones };
