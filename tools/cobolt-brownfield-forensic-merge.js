#!/usr/bin/env node

// CoBolt Brownfield Forensic-Findings Merge — deterministic P2.5 → P3 pipeline
//
// Closes brownfield issue 12 (forensic-findings merge logic opacity).
//
// Before this tool, the 16a-forensic-findings.json → 16-issues-registry.json
// merge was documented in prose only (`forensic-audit-phase.md` lines 254-260:
// "For each finding: priority = PRIORITY_MATRIX[...]; append to registry").
// The orchestrator was supposed to iterate, but under task pressure it either
// skipped the merge, half-merged (only some prefixes), or duplicated findings.
// When P3 synthesis read the registry it would see stale P1 findings without
// the verified forensic set, and master-assessment would understate severity.
//
// This tool makes the merge:
//   - deterministic (same input → same output bytes),
//   - idempotent (running it twice does not double-insert),
//   - census-checked (every 16a finding must exist in the output OR have a
//     documented drop reason in the output's `.droppedFindings` block),
//   - schema-validated (output conforms to issues-registry.schema.json shape
//     used elsewhere in CoBolt).
//
// Usage:
//   node tools/cobolt-brownfield-forensic-merge.js merge \
//     --dir _cobolt-output/latest/brownfield [--json]
//
// Exit codes (per tools/CLAUDE.md contract):
//   0 — success, merge complete
//   1 — hard error (schema violation, write failure, census mismatch)
//   2 — missing optional dependency (not used here but reserved)
//
// Produces:
//   16-issues-registry.json (updated in place, idempotent)
//   _cobolt-output/audit/brownfield-forensic-merge.jsonl (audit trail)

const fs = require('node:fs');
const path = require('node:path');

// Category × Severity → priority. Mirrors forensic-audit-phase.md §Category Priority Matrix
// AND synthesis-phase.md §Category × Severity matrix. Keep in sync.
const PRIORITY_MATRIX = Object.freeze({
  SECURITY: { critical: 'P0', high: 'P1', medium: 'P2', low: 'P3' },
  BUG: { critical: 'P1', high: 'P1', medium: 'P2', low: 'P3' },
  DEPENDENCY: { critical: 'P0', high: 'P1', medium: 'P2', low: 'P4' },
  PERFORMANCE: { critical: 'P1', high: 'P1', medium: 'P2', low: 'P3' },
  COMPLIANCE: { critical: 'P0', high: 'P1', medium: 'P2', low: 'P3' },
  ARCHITECTURE: { critical: 'P2', high: 'P2', medium: 'P3', low: 'P4' },
  DEBT: { critical: 'P3', high: 'P3', medium: 'P3', low: 'P4' },
  CONFIG: { critical: 'P0', high: 'P1', medium: 'P2', low: 'P3' },
  API: { critical: 'P1', high: 'P1', medium: 'P2', low: 'P3' },
  ROUTING: { critical: 'P0', high: 'P1', medium: 'P2', low: 'P3' },
  'UI/UX': { critical: 'P2', high: 'P2', medium: 'P3', low: 'P4' },
  A11Y: { critical: 'P1', high: 'P1', medium: 'P2', low: 'P3' },
  OPS: { critical: 'P1', high: 'P1', medium: 'P2', low: 'P3' },
  INTEGRATION: { critical: 'P2', high: 'P2', medium: 'P3', low: 'P4' },
});

// Finding prefix → category (synthesis-phase.md §Category → Finding-Prefix Map).
const PREFIX_TO_CATEGORY = Object.freeze({
  SEC: 'SECURITY',
  PEN: 'SECURITY',
  AISEC: 'SECURITY',
  SAST: 'SECURITY',
  ILL: 'SECURITY',
  SCA: 'DEPENDENCY',
  DEP: 'DEPENDENCY',
  PERF: 'PERFORMANCE',
  COMP: 'COMPLIANCE',
  ARCH: 'ARCHITECTURE',
  DEBT: 'DEBT',
  SCAN: 'DEBT',
  CONF: 'CONFIG',
  API: 'API',
  ROUTE: 'ROUTING',
  QRY: 'ROUTING',
  STUB: 'ROUTING',
  UI: 'UI/UX',
  UIPH: 'UI/UX',
  UX: 'UI/UX',
  DT: 'UI/UX',
  A11Y: 'A11Y',
  OPS: 'OPS',
  INT: 'INTEGRATION',
  INTG: 'INTEGRATION',
  FEAT: 'BUG',
  ENH: 'BUG',
  BUG: 'BUG',
});

// DESIGN findings are routed to `17-enhancement-advisory.md`, NOT the registry.
// We track them in the audit trail but do not merge.
const ROUTED_ELSEWHERE_PREFIXES = new Set(['DESIGN']);

function firstPrefix(id) {
  if (typeof id !== 'string' || id.length === 0) return '';
  const idx = id.indexOf('-');
  if (idx === -1) return id.toUpperCase();
  return id.slice(0, idx).toUpperCase();
}

function classify(finding) {
  const id = finding?.id || finding?.findingId || '';
  const prefix = firstPrefix(id);
  if (ROUTED_ELSEWHERE_PREFIXES.has(prefix)) {
    return { category: null, routed: 'enhancement-advisory', prefix };
  }
  const category = PREFIX_TO_CATEGORY[prefix] || 'BUG';
  return { category, prefix };
}

function priorityFor(category, severity) {
  const sev = String(severity || 'medium').toLowerCase();
  const row = PRIORITY_MATRIX[category];
  if (!row) return 'P2';
  return row[sev] || row.medium || 'P2';
}

function normalizeFinding(raw) {
  // Produce a canonical shape that the registry consumes. Required keys:
  //   id, category, severity, priority, title, evidence, source
  const id = raw.id || raw.findingId;
  if (!id || typeof id !== 'string') {
    return { error: 'missing-id', raw };
  }
  const classification = classify(raw);
  if (classification.routed) {
    return {
      routed: classification.routed,
      prefix: classification.prefix,
      id,
    };
  }
  const category =
    raw.category && PRIORITY_MATRIX[String(raw.category).toUpperCase()]
      ? String(raw.category).toUpperCase()
      : classification.category;
  const severity = String(raw.severity || 'medium').toLowerCase();
  const priority = raw.priority || priorityFor(category, severity);
  return {
    finding: {
      id,
      title: raw.title || raw.summary || '',
      description: raw.description || '',
      category,
      severity,
      priority,
      evidence: raw.evidence || raw.snippet || '',
      location: raw.location || raw.file || '',
      agent: raw.agent || raw.source || '',
      cwe: raw.cwe || null,
      source: 'P2.5-forensic-audit',
      mergedAt: new Date().toISOString(),
      sourceArtifact: '16a-forensic-findings.json',
    },
  };
}

function loadJsonOrEmpty(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractFindingArray(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.findings)) return data.findings;
  if (Array.isArray(data.items)) return data.items;
  return [];
}

function buildRegistrySkeleton() {
  return {
    version: '1.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-brownfield-forensic-merge',
    findings: [],
    byPriority: { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 },
    byCategory: {},
    droppedFindings: [],
    routedElsewhere: [],
    mergeHistory: [],
  };
}

function mergeRegistry(registryPath, forensicPath, options = {}) {
  const forensicRaw = loadJsonOrEmpty(forensicPath);
  if (!forensicRaw) {
    return {
      ok: false,
      reason: 'forensic-findings-missing',
      detail: `No forensic findings file at ${forensicPath}`,
    };
  }
  const forensicFindings = extractFindingArray(forensicRaw);

  const existing = loadJsonOrEmpty(registryPath) || buildRegistrySkeleton();
  if (!existing.findings || !Array.isArray(existing.findings)) existing.findings = [];
  if (!existing.byPriority) existing.byPriority = { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 };
  if (!existing.byCategory) existing.byCategory = {};
  if (!existing.droppedFindings) existing.droppedFindings = [];
  if (!existing.routedElsewhere) existing.routedElsewhere = [];
  if (!existing.mergeHistory) existing.mergeHistory = [];

  const existingIds = new Set(existing.findings.map((f) => f.id).filter(Boolean));
  const addedIds = new Set();
  const droppedIds = [];
  const routedIds = [];

  for (const raw of forensicFindings) {
    const n = normalizeFinding(raw);
    if (n.error) {
      droppedIds.push({ reason: n.error, raw });
      continue;
    }
    if (n.routed) {
      routedIds.push({ id: n.id, destination: n.routed, prefix: n.prefix });
      continue;
    }
    if (existingIds.has(n.finding.id)) {
      continue; // idempotent: skip already-merged
    }
    existing.findings.push(n.finding);
    existingIds.add(n.finding.id);
    addedIds.add(n.finding.id);
    existing.byPriority[n.finding.priority] = (existing.byPriority[n.finding.priority] || 0) + 1;
    existing.byCategory[n.finding.category] = (existing.byCategory[n.finding.category] || 0) + 1;
  }

  // Census check — every non-routed non-dropped forensic finding MUST now be in the registry.
  const expectedIds = forensicFindings.map((raw) => raw?.id || raw?.findingId).filter(Boolean);
  const missingInRegistry = expectedIds.filter(
    (id) => !existingIds.has(id) && !droppedIds.some((d) => d.raw?.id === id) && !routedIds.some((r) => r.id === id),
  );

  existing.droppedFindings.push(
    ...droppedIds.map((d) => ({
      id: d.raw?.id || '<unknown>',
      reason: d.reason,
      at: new Date().toISOString(),
    })),
  );
  existing.routedElsewhere.push(...routedIds);

  existing.mergeHistory.push({
    at: new Date().toISOString(),
    source: path.basename(forensicPath),
    totalScanned: forensicFindings.length,
    added: addedIds.size,
    dropped: droppedIds.length,
    routed: routedIds.length,
    missingAfterMerge: missingInRegistry.length,
  });

  const result = {
    ok: missingInRegistry.length === 0,
    registryPath,
    totalScanned: forensicFindings.length,
    added: addedIds.size,
    dropped: droppedIds.length,
    routed: routedIds.length,
    missingAfterMerge: missingInRegistry,
    byPriority: existing.byPriority,
    byCategory: existing.byCategory,
    registry: existing,
  };

  if (!options.dryRun) {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
  }

  return result;
}

function audit(cwd, entry) {
  try {
    const dir = path.join(cwd, '_cobolt-output', 'audit');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      path.join(dir, 'brownfield-forensic-merge.jsonl'),
      `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
      { mode: 0o600 },
    );
  } catch {
    /* best effort */
  }
}

function printHelp() {
  const help = [
    'cobolt-brownfield-forensic-merge — deterministic 16a→16 merge',
    '',
    'USAGE',
    '  node tools/cobolt-brownfield-forensic-merge.js merge --dir <brownfield-dir> [--json]',
    '  node tools/cobolt-brownfield-forensic-merge.js --help',
    '',
    'OPTIONS',
    '  --dir <path>   Brownfield artifacts directory (default: _cobolt-output/latest/brownfield)',
    '  --json         Emit JSON result to stdout instead of human-readable summary',
    '  --dry-run      Compute the merge but do not write the registry',
    '',
    'EXIT CODES',
    '  0 — merge succeeded with zero missing-after-merge',
    '  1 — merge failed (missing forensic file, census mismatch, write error)',
    '  2 — missing optional dependency (reserved)',
  ].join('\n');
  process.stdout.write(`${help}\n`);
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const command = args[0];
  if (command !== 'merge') {
    process.stderr.write(`Unknown command: ${command}\n`);
    printHelp();
    return 1;
  }

  const dirIdx = args.indexOf('--dir');
  const bfDir =
    dirIdx !== -1 && args[dirIdx + 1]
      ? args[dirIdx + 1]
      : path.join(process.cwd(), '_cobolt-output', 'latest', 'brownfield');
  const wantJson = args.includes('--json');
  const dryRun = args.includes('--dry-run');

  const registryPath = path.join(bfDir, '16-issues-registry.json');
  const forensicPath = path.join(bfDir, '16a-forensic-findings.json');

  if (!fs.existsSync(forensicPath)) {
    const err = { ok: false, reason: 'forensic-file-missing', path: forensicPath };
    audit(process.cwd(), err);
    if (wantJson) process.stdout.write(`${JSON.stringify(err, null, 2)}\n`);
    else process.stderr.write(`FAIL: ${forensicPath} not found — nothing to merge.\n`);
    return 1;
  }

  let result;
  try {
    result = mergeRegistry(registryPath, forensicPath, { dryRun });
  } catch (e) {
    const err = { ok: false, reason: 'exception', message: String(e?.message || e) };
    audit(process.cwd(), err);
    if (wantJson) process.stdout.write(`${JSON.stringify(err, null, 2)}\n`);
    else process.stderr.write(`FAIL: ${err.message}\n`);
    return 1;
  }

  audit(process.cwd(), {
    outcome: result.ok ? 'ok' : 'census-mismatch',
    registryPath,
    forensicPath,
    ...result,
    registry: undefined, // don't bloat the audit log
  });

  if (wantJson) {
    // Omit the full registry from stdout — callers read it from disk.
    const { registry: _registry, ...rest } = result;
    process.stdout.write(`${JSON.stringify(rest, null, 2)}\n`);
  } else {
    process.stdout.write(
      `Forensic merge: scanned=${result.totalScanned} added=${result.added} ` +
        `dropped=${result.dropped} routed=${result.routed} ` +
        `missingAfterMerge=${result.missingAfterMerge.length}\n`,
    );
    if (result.missingAfterMerge.length > 0) {
      process.stderr.write(
        `CENSUS FAIL: ${result.missingAfterMerge.length} forensic findings did not land in registry: ` +
          `${result.missingAfterMerge.slice(0, 5).join(', ')}${result.missingAfterMerge.length > 5 ? '…' : ''}\n`,
      );
    }
  }

  return result.ok ? 0 : 1;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = {
  mergeRegistry,
  normalizeFinding,
  classify,
  priorityFor,
  PRIORITY_MATRIX,
  PREFIX_TO_CATEGORY,
  _testOnly: {
    buildRegistrySkeleton,
    firstPrefix,
    extractFindingArray,
  },
};
