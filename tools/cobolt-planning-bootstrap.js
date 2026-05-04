#!/usr/bin/env node
// cobolt-planning-bootstrap — deterministic creation of source-document-consolidation.md
// and prd.md frontmatter patch. Runs when the cobolt-analyze-features LLM step fails
// to create the source packet or Claude Code Write tool errors on the canonical path.
//
// Idempotent: safe to run multiple times. Only writes what's missing.

const fs = require('node:fs');
const path = require('node:path');

const { atomicWrite } = require('../lib/cobolt-atomic-write');

const PLANNING_DIR = path.resolve('_cobolt-output/latest/planning');
const PRD = path.join(PLANNING_DIR, 'prd.md');
const PACKET = path.join(PLANNING_DIR, 'source-document-consolidation.md');
const INTAKE = path.join(PLANNING_DIR, 'source-intake.json');
const CONFLICTS = path.join(PLANNING_DIR, 'source-conflicts.json');
const GAP_SUMMARY = path.join(PLANNING_DIR, 'source-gap-summary.md');
const ASSUMPTIONS = path.join(PLANNING_DIR, 'assumptions-log.md');

function splitFrontmatter(text) {
  if (!text.startsWith('---\n')) return { frontmatter: '', body: text };
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return { frontmatter: '', body: text };
  return { frontmatter: text.slice(4, end), body: text.slice(end + 5) };
}

function ensurePrdFrontmatter(repairs) {
  if (!fs.existsSync(PRD)) {
    repairs.push({ file: 'prd.md', action: 'skipped-missing' });
    return;
  }
  const raw = fs.readFileSync(PRD, 'utf8');
  const { frontmatter, body } = splitFrontmatter(raw);

  const has = (key) => new RegExp(`^\\s*${key}\\s*:`, 'm').test(frontmatter);
  const additions = [];
  if (!has('sourceDocumentPacket'))
    additions.push("sourceDocumentPacket: '_cobolt-output/latest/planning/source-document-consolidation.md'");
  if (!has('primaryInputDocument')) additions.push("primaryInputDocument: 'prd.md'");
  if (!has('inputDocuments')) additions.push("inputDocuments: ['prd.md']");

  if (additions.length === 0) return;

  const newFrontmatter = (frontmatter ? `${frontmatter}\n` : '') + additions.join('\n');
  atomicWrite(PRD, `---\n${newFrontmatter}\n---\n${body}`, { encoding: 'utf8' });
  repairs.push({ file: 'prd.md', action: 'frontmatter-patched', added: additions });
}

function extractRequirementsFromPrd(prdBody) {
  const rows = [];
  const lines = prdBody.split('\n');
  let currentSection = 'general';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      currentSection = heading[1].toLowerCase().trim();
      continue;
    }
    const bullet = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.+)$/);
    if (!bullet) continue;
    const summary = bullet[1].trim().replace(/\s+/g, ' ');
    if (summary.length < 10) continue;
    let category = 'FR';
    if (/nfr|performance|latency|throughput|availability|security|privacy|compliance/i.test(currentSection))
      category = 'NFR';
    if (/business rule|constraint|assumption/i.test(currentSection)) category = 'BR';
    rows.push({
      id: `SRC-${String(rows.length + 1).padStart(3, '0')}`,
      source: `prd.md:L${i + 1}`,
      summary: summary.slice(0, 200),
      category,
      status: 'included',
    });
  }
  return rows;
}

function ensureSourcePacket(repairs) {
  if (fs.existsSync(PACKET)) {
    const existing = fs.readFileSync(PACKET, 'utf8');
    if (/## Source Requirement Registry/i.test(existing) && /\|\s*SRC-\d+\s*\|/.test(existing)) {
      return;
    }
    repairs.push({ file: 'source-document-consolidation.md', action: 'has-no-registry-regenerating' });
  }
  if (!fs.existsSync(PRD)) {
    repairs.push({ file: 'source-document-consolidation.md', action: 'skipped-no-prd' });
    return;
  }
  const prdRaw = fs.readFileSync(PRD, 'utf8');
  const { body: prdBody } = splitFrontmatter(prdRaw);
  const rows = extractRequirementsFromPrd(prdBody);

  const header = `# Source Document Consolidation

**Generated:** ${new Date().toISOString()}
**Source:** prd.md (deterministic extraction via cobolt-planning-bootstrap)

This packet preserves every meaningful requirement, feature, constraint, and business rule from the primary input document. Edit this file to add manually curated SRC-NNN rows or adjust status values.

## Source Requirement Registry

| ID | Source File | Requirement Summary | Category | Status |
|----|------------|---------------------|----------|--------|
`;
  const rowLines = rows
    .map((r) => `| ${r.id} | ${r.source} | ${r.summary.replace(/\|/g, '\\|')} | ${r.category} | ${r.status} |`)
    .join('\n');
  const footer = `\n\n## Status Legend\n\n- \`included\` — in scope for the current milestone set\n- \`excluded:<reason>\` — explicitly out of scope\n- \`deferred:<milestone>\` — planned for a later milestone\n`;

  atomicWrite(PACKET, header + rowLines + footer, { encoding: 'utf8' });
  repairs.push({
    file: 'source-document-consolidation.md',
    action: 'generated',
    rowCount: rows.length,
  });
}

function ensureSidecarFiles(repairs) {
  if (!fs.existsSync(INTAKE)) {
    atomicWrite(
      INTAKE,
      JSON.stringify(
        { generatedAt: new Date().toISOString(), requiresConsolidation: true, primarySource: 'prd.md' },
        null,
        2,
      ),
      { encoding: 'utf8' },
    );
    repairs.push({ file: 'source-intake.json', action: 'generated' });
  }
  if (!fs.existsSync(CONFLICTS)) {
    atomicWrite(
      CONFLICTS,
      JSON.stringify({ generatedAt: new Date().toISOString(), blockingCount: 0, conflicts: [] }, null, 2),
      { encoding: 'utf8' },
    );
    repairs.push({ file: 'source-conflicts.json', action: 'generated' });
  }
  if (!fs.existsSync(GAP_SUMMARY)) {
    atomicWrite(
      GAP_SUMMARY,
      `# Source Gap Summary\n\nNo named compliance framework captured; baseline security and coding standards still apply.\n`,
      { encoding: 'utf8' },
    );
    repairs.push({ file: 'source-gap-summary.md', action: 'generated' });
  }
  if (!fs.existsSync(ASSUMPTIONS)) {
    atomicWrite(
      ASSUMPTIONS,
      `# Assumptions Log\n\nNo named compliance framework captured; baseline security and coding standards still apply.\n`,
      { encoding: 'utf8' },
    );
    repairs.push({ file: 'assumptions-log.md', action: 'generated' });
  }
}

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write('Usage: node tools/cobolt-planning-bootstrap.js [--json]\n');
  process.exit(exitCode);
}

// REVERT(v0.14.5-stub): feature-dossier / feature-service-blueprints / enriched-requirements
// stub-content generators removed in v0.15.0. These artifacts are CONTENT, not structure,
// and must be LLM-authored with self-critique — see source/skills/_shared/self-critique-protocol.md.
// Previous stub functions passed size gates with placeholder prose, silently shipping
// placeholders into downstream build. The recovery ladder (self-critique → targeted
// redispatch → recovery-advisor → HUMAN-REVIEW-REQUIRED) now handles genuine gaps.

function main() {
  const rawArgv = process.argv.slice(2);
  if (rawArgv.includes('--help') || rawArgv.includes('-h') || rawArgv[0] === 'help') usage(0);
  const unknownArgs = rawArgv.filter((arg) => arg !== '--json');
  if (unknownArgs.length > 0) {
    process.stderr.write(`[bootstrap] unknown argument(s): ${unknownArgs.join(', ')}\n`);
    usage(1);
  }

  const repairs = [];
  fs.mkdirSync(PLANNING_DIR, { recursive: true });
  ensurePrdFrontmatter(repairs);
  ensureSourcePacket(repairs);
  ensureSidecarFiles(repairs);

  const jsonOut = rawArgv.includes('--json');
  if (jsonOut) {
    console.log(JSON.stringify({ planningDir: PLANNING_DIR, repairCount: repairs.length, repairs }, null, 2));
  } else if (repairs.length === 0) {
    console.log('[bootstrap] planning packet already complete');
  } else {
    console.log(`[bootstrap] ${repairs.length} repair(s):`);
    for (const r of repairs) console.log(`  - ${r.file}: ${r.action}${r.rowCount ? ` (${r.rowCount} rows)` : ''}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  splitFrontmatter,
  ensurePrdFrontmatter,
  extractRequirementsFromPrd,
  ensureSourcePacket,
  ensureSidecarFiles,
  main,
};
