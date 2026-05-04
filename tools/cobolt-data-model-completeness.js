#!/usr/bin/env node

// CoBolt Data Model Completeness — enforces that data-model-spec.md is
// actually build-ready.
//
// Closes Blocker #7 from the Meru readiness review: the spec listed 12
// specified tables and dumped the rest under "Other required tables" without
// columns/indexes/RLS, while security-requirements.md mandated RLS for every
// tenant-scoped table and the actual spec enabled RLS on only three (two
// without policy definitions).
//
// Invariants enforced:
//   1. No "Other required tables" / "Additional tables" / "TBD tables"
//      section in data-model-spec.md containing identifiers without
//      corresponding ## <table> specification blocks.
//   2. Every table listed in security-requirements.md under RLS/tenant-scope
//      must have ENABLE ROW LEVEL SECURITY in data-model-spec.md.
//   3. Every table with RLS enabled must also have a CREATE POLICY block.
//   4. PRD-referenced entities (tenants.lifecycle_state, config_versions,
//      kill_switches, gateway_nodes, certificates, etc.) must be present if
//      the PRD mentions them.
//
// Exit codes:
//   0 = build-ready
//   1 = usage
//   2 = missing source artifacts
//   3 = data model violations — Tier 1 block

const fs = require('node:fs');
const path = require('node:path');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_MISSING = 2;
const EXIT_VIOLATION = 3;

function planningDir(cwd = process.cwd()) {
  const p = path.join(cwd, '_cobolt-output', 'latest', 'planning');
  return fs.existsSync(p) ? p : null;
}

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

// Best-effort table-name extraction from data-model-spec.md.
// Looks for `## tables/foo`, `### Table: foo`, `CREATE TABLE foo`, or
// `Table name: foo`.
function extractSpecifiedTables(content) {
  const tables = new Map(); // name -> {hasColumns, hasRls, hasPolicy, raw}
  if (!content) return tables;
  const sections = content.split(/(?=^##+\s)/m);
  for (const section of sections) {
    // Try to find a table name at the section head
    let name = null;
    const mTable = section.match(/^##+\s+(?:Table\s*:\s*|(?:tables[./])?)([a-z][a-z0-9_]{1,40})\b/im);
    const mCreate = section.match(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+"?([a-z][a-z0-9_]{1,40})"?/i);
    if (mTable) name = mTable[1];
    if (!name && mCreate) name = mCreate[1];
    if (!name) continue;

    const hasColumns =
      /\|\s*column\s*\|/i.test(section) || /column\s*definition/i.test(section) || (mCreate && /\(/.test(section));
    const hasRls = /ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(section) || /rls\s*:\s*(?:true|enabled|yes)/i.test(section);
    const hasPolicy = /CREATE\s+POLICY/i.test(section) || /POLICY\s+["']?\w+/i.test(section);
    const hasIndexes = /CREATE\s+INDEX/i.test(section) || /indexes?\s*:/i.test(section);
    const existing = tables.get(name) || {};
    tables.set(name, {
      hasColumns: Boolean(existing.hasColumns || hasColumns),
      hasRls: Boolean(existing.hasRls || hasRls),
      hasPolicy: Boolean(existing.hasPolicy || hasPolicy),
      hasIndexes: Boolean(existing.hasIndexes || hasIndexes),
    });
  }
  return tables;
}

// Find an "other required tables" dumping-ground section and list identifiers.
function extractOtherRequiredTables(content) {
  if (!content) return [];
  // JavaScript regex has no \Z — use (?=^## |$) with the m flag and manual EOF
  // handling. Split on section boundaries, then inspect each relevant header.
  const sections = content.split(/(?=^##+\s)/m);
  const names = new Set();
  for (const section of sections) {
    if (
      !/^##+\s+(?:Other\s+Required\s+Tables|Additional\s+Tables|TBD\s+Tables|Remaining\s+Tables|Tables?\s+To\s+Define)\b/i.test(
        section,
      )
    ) {
      continue;
    }
    // Capture backtick-quoted and bare identifiers from list items
    for (const m of section.matchAll(/(?:^|\s)[`*-]?`?([a-z][a-z0-9_]{2,40})`?/gim)) {
      const w = m[1];
      if (
        /^(other|required|tables?|additional|tbd|remaining|to|define|list|the|and|or|etc|per|see|ref|need|needs|following|be|defined|later)$/i.test(
          w,
        )
      )
        continue;
      if (w.length < 3) continue;
      names.add(w);
    }
  }
  return [...names];
}

// Parse tenant-scoped tables from security-requirements.md.
function extractTenantScopedTables(secContent) {
  if (!secContent) return new Set();
  const tables = new Set();
  // Look for explicit lists like "every tenant-scoped table", and any table
  // name inside sections about RLS.
  const rlsSections = secContent.match(/(?:##+\s+.*?(?:Row[- ]Level|RLS|Tenant[- ]Scope).*?(?:\n.*?)+?)(?=^##|Z)/gim);
  const content = (rlsSections || []).join('\n') || secContent;
  for (const m of content.matchAll(/[`*]{1,2}([a-z][a-z0-9_]{1,40})[`*]{0,2}/g)) {
    const w = m[1];
    if (/^(every|all|must|each|the|and|or|with|rls|row|level|security|scope|scoped|policy|table|tables)$/i.test(w))
      continue;
    if (w.length < 4) continue;
    tables.add(w);
  }
  return tables;
}

// PRD-mentioned entities we expect to see as tables or explicit non-persistent notes.
function extractPrdEntities(prdContent) {
  if (!prdContent) return [];
  const patterns = [
    'tenants',
    'projects',
    'providers',
    'model_catalog',
    'model_catalog_entries',
    'roles',
    'mcp_servers',
    'mcp_tools',
    'agents',
    'cli_tools',
    'kill_switches',
    'config_versions',
    'tenant_export_bundles',
    'gateway_nodes',
    'certificates',
  ];
  const found = [];
  for (const p of patterns) {
    const re = new RegExp(`\\b${p}\\b`, 'i');
    if (re.test(prdContent)) found.push(p);
  }
  return found;
}

function check({ dir }) {
  const pd = dir || planningDir();
  if (!pd) return { exitCode: EXIT_MISSING, error: 'no planning directory' };

  const dm = readFileSafe(path.join(pd, 'data-model-spec.md'));
  const alt = readFileSafe(path.join(pd, 'data-model.md'));
  const content = dm || alt;
  if (!content) {
    return { exitCode: EXIT_MISSING, error: 'data-model-spec.md missing', planningDir: pd };
  }
  const sec = readFileSafe(path.join(pd, 'security-requirements.md'));
  const prd = readFileSafe(path.join(pd, 'prd.md'));

  const specified = extractSpecifiedTables(content);
  const others = extractOtherRequiredTables(content);
  const tenantScoped = extractTenantScopedTables(sec);
  const prdEntities = extractPrdEntities(prd);

  const violations = [];

  // Invariant 1: no "other required" dump with no spec
  for (const name of others) {
    if (!specified.has(name)) {
      violations.push({
        type: 'unspecified-other-required-table',
        table: name,
        hint: 'Either specify columns/keys/indexes for this table or remove from "Other Required Tables" list.',
      });
    }
  }

  // Invariant 2: tenant-scoped tables must have RLS enabled
  for (const name of tenantScoped) {
    const spec = specified.get(name);
    if (!spec) continue; // not yet a real table — caught by invariant 1 or 4
    if (!spec.hasRls) {
      violations.push({
        type: 'tenant-scoped-table-without-rls',
        table: name,
        hint: 'Enable ENABLE ROW LEVEL SECURITY on this tenant-scoped table per security-requirements.md.',
      });
    }
  }

  // Invariant 3: RLS-enabled tables must have CREATE POLICY
  for (const [name, spec] of specified.entries()) {
    if (spec.hasRls && !spec.hasPolicy) {
      violations.push({
        type: 'rls-without-policy',
        table: name,
        hint: 'Add a CREATE POLICY block — enabling RLS without a policy blocks all access.',
      });
    }
  }

  // Invariant 4: PRD-mentioned entities must be specified or explicitly marked
  // non-persistent. We only flag entities mentioned >=2 times in the PRD to
  // avoid incidental noise.
  if (prd) {
    for (const entity of prdEntities) {
      const reCount = new RegExp(`\\b${entity}\\b`, 'gi');
      const count = (prd.match(reCount) || []).length;
      if (count < 2) continue;
      if (!specified.has(entity) && !others.includes(entity)) {
        const markedNonPersistent = new RegExp(
          `\\b${entity}\\b.*?(non[- ]persistent|in[- ]memory|transient|not\\s+persisted)`,
          'i',
        ).test(content);
        if (!markedNonPersistent) {
          violations.push({
            type: 'prd-entity-not-in-data-model',
            entity,
            mentions: count,
            hint: 'Either add a table specification for this entity or mark it explicitly non-persistent in data-model-spec.md.',
          });
        }
      }
    }
  }

  return {
    exitCode: violations.length > 0 ? EXIT_VIOLATION : EXIT_OK,
    planningDir: pd,
    summary: {
      specifiedTables: specified.size,
      otherRequiredTables: others.length,
      tenantScopedTables: tenantScoped.size,
      prdEntities: prdEntities.length,
      violations: violations.length,
    },
    violations,
  };
}

function formatText(r) {
  const lines = ['== Data Model Completeness =='];
  lines.push(`  planningDir: ${r.planningDir || '(missing)'}`);
  if (r.summary) for (const [k, v] of Object.entries(r.summary)) lines.push(`  ${k}: ${v}`);
  if (r.violations?.length) {
    lines.push('  violations:');
    for (const v of r.violations.slice(0, 30)) {
      lines.push(`    - [${v.type}] ${v.table || v.entity}${v.mentions ? ` (mentions=${v.mentions})` : ''}`);
    }
  }
  lines.push(`verdict: ${r.exitCode === EXIT_OK ? 'PASS' : 'VIOLATION'}`);
  return lines.join('\n');
}

function main(argv = process.argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'check';
  const json = args.includes('--json');
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('Usage: cobolt-data-model-completeness.js check [--json]');
    process.exit(EXIT_OK);
  }
  if (cmd !== 'check' && cmd !== 'report') {
    console.error('Usage: cobolt-data-model-completeness.js check [--json]');
    process.exit(EXIT_USAGE);
  }
  const r = check({});
  if (json) console.log(JSON.stringify(r, null, 2));
  else console.log(formatText(r));
  process.exit(cmd === 'report' ? EXIT_OK : r.exitCode);
}

if (require.main === module) main();

module.exports = {
  check,
  extractSpecifiedTables,
  extractOtherRequiredTables,
  extractTenantScopedTables,
  EXIT_OK,
  EXIT_VIOLATION,
};
