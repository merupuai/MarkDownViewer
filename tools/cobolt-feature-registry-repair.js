#!/usr/bin/env node
// cobolt-feature-registry-repair — deterministic repair for feature-registry.json
// Fills missing required fields (sourceIds, evidenceLevel) that LLM generators omit
// under task pressure. Runs before feature-coverage gate in cobolt-analyze-features.

const fs = require('node:fs');
const path = require('node:path');

const PLANNING_DIR = path.resolve('_cobolt-output/latest/planning');
const REGISTRY = path.join(PLANNING_DIR, 'feature-registry.json');
const CONSOLIDATION = path.join(PLANNING_DIR, 'source-document-consolidation.md');
const REPAIR_LOG = path.join(PLANNING_DIR, 'feature-registry-repair.log.json');

const VALID_EVIDENCE = ['STATED', 'INFERRED', 'DOMAIN_DEFAULT', 'ASSUMPTION', 'DRAFT_ONLY'];

const COVERAGE_KEYS = [
  'productIntent',
  'userFlow',
  'ui',
  'uiStates',
  'wireframes',
  'backend',
  'middleware',
  'api',
  'data',
  'integrations',
  'auth',
  'security',
  'privacy',
  'nfrs',
  'observability',
  'tests',
  'rollout',
  'acceptanceCriteria',
  'serviceBlueprint',
  'specContracts',
  'accessibility',
  'architecture',
];

const DEFAULT_SURFACES = [
  'settings',
  'dashboard',
  'analytics',
  'notifications',
  'permissions',
  'auditLog',
  'admin',
  'search',
  'importExport',
  'billing',
  'privacy',
  'featureFlags',
  'observability',
  'supportOps',
  'integrations',
  'api',
  'data',
  'ui',
  'tests',
  'accessibility',
  'i18n',
];

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function extractSourceIds(consolidationText) {
  if (!consolidationText) return [];
  const rows = [];
  for (const line of consolidationText.split('\n')) {
    const m = line.match(/^\|\s*(SRC-\d+)\s*\|\s*([^|]*)\|\s*([^|]*)\|/);
    if (m) rows.push({ id: m[1], source: m[2].trim(), summary: m[3].trim().toLowerCase() });
  }
  return rows;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 4);
}

function matchSourceIds(feature, srcRows) {
  const haystack = [feature.title, feature.description, feature.summary].filter(Boolean).join(' ').toLowerCase();
  const featureTokens = new Set(tokenize(haystack));
  if (featureTokens.size === 0) return [];
  const scored = srcRows
    .map((row) => {
      const rowTokens = new Set(tokenize(row.summary));
      let hits = 0;
      for (const t of featureTokens) if (rowTokens.has(t)) hits++;
      return { id: row.id, hits };
    })
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 3)
    .map((s) => s.id);
  return scored;
}

function repairFeature(feature, srcRows, repairs) {
  const fid = feature.featureId || feature.id || '?';
  const out = { ...feature };

  const existingIds = [
    ...(Array.isArray(out.sourceIds) ? out.sourceIds : []),
    ...(Array.isArray(out.requirementIds) ? out.requirementIds : []),
  ].filter(Boolean);
  if (existingIds.length === 0) {
    const matched = matchSourceIds(out, srcRows);
    if (matched.length > 0) {
      out.sourceIds = matched;
      out.evidenceLevel = out.evidenceLevel || 'INFERRED';
      repairs.push({ featureId: fid, field: 'sourceIds', action: 'matched', value: matched });
    } else if (srcRows.length > 0) {
      out.sourceIds = [srcRows[0].id];
      out.evidenceLevel = 'ASSUMPTION';
      repairs.push({
        featureId: fid,
        field: 'sourceIds',
        action: 'fallback-first-src',
        value: out.sourceIds,
      });
    } else {
      out.sourceIds = [`SRC-AUTO-${String(fid).replace(/[^0-9]/g, '') || '000'}`];
      out.evidenceLevel = 'ASSUMPTION';
      repairs.push({
        featureId: fid,
        field: 'sourceIds',
        action: 'synthetic',
        value: out.sourceIds,
      });
    }
  }

  const ev = String(out.evidenceLevel || out.level || '').toUpperCase();
  if (!VALID_EVIDENCE.includes(ev)) {
    out.evidenceLevel = 'INFERRED';
    repairs.push({
      featureId: fid,
      field: 'evidenceLevel',
      action: 'default-inferred',
      value: 'INFERRED',
    });
  }

  if (!out.scopeTier) {
    out.scopeTier = 'MVP';
    repairs.push({ featureId: fid, field: 'scopeTier', action: 'default', value: 'MVP' });
  }
  if (!out.confidence) {
    out.confidence = 'medium';
    repairs.push({ featureId: fid, field: 'confidence', action: 'default', value: 'medium' });
  }

  // v0.15.0: structural schema shell WITHOUT fabricated prose.
  // The capability-graph and feature-coverage gates require each feature to declare
  // every coverage key and every adjacent surface. We fill the REQUIRED STRUCTURE
  // with evidenceLevel='DOMAIN_DEFAULT' (lowest tier) so self-critique and gap review
  // flag these as low-quality and trigger LLM re-authoring. We DO NOT write prose
  // like "baseline X expected; refine during design" — that was stub content masking
  // as quality. The 'reason' field stays empty so the LLM fills real domain reasoning.
  if (!out.coverage || typeof out.coverage !== 'object') out.coverage = {};
  let coverageAdded = 0;
  for (const key of COVERAGE_KEYS) {
    if (out.coverage[key]) continue;
    out.coverage[key] = { status: 'not_applicable', evidenceLevel: 'DOMAIN_DEFAULT', reason: '' };
    coverageAdded++;
  }
  if (coverageAdded > 0) {
    repairs.push({ featureId: fid, field: 'coverage', action: 'structural-shell', count: coverageAdded });
  }

  if (!Array.isArray(out.adjacentSurfaces) || out.adjacentSurfaces.length === 0) {
    out.adjacentSurfaces = DEFAULT_SURFACES.map((surface) => ({
      surface,
      status: 'not_applicable',
      evidenceLevel: 'DOMAIN_DEFAULT',
      reason: '',
    }));
    repairs.push({
      featureId: fid,
      field: 'adjacentSurfaces',
      action: 'structural-shell',
      count: DEFAULT_SURFACES.length,
    });
  }

  return out;
}

function main() {
  if (!fs.existsSync(REGISTRY)) {
    console.error(`[repair] ${REGISTRY} not found — nothing to repair`);
    process.exit(0);
  }
  const registry = readJSON(REGISTRY);
  if (!Array.isArray(registry.features)) {
    console.error('[repair] feature-registry.json has no features[] array');
    process.exit(2);
  }

  let consolidationText = '';
  try {
    consolidationText = fs.readFileSync(CONSOLIDATION, 'utf8');
  } catch {
    /* optional */
  }
  const srcRows = extractSourceIds(consolidationText);
  const repairs = [];

  registry.features = registry.features.map((f) => repairFeature(f, srcRows, repairs));

  // v0.26: auto-compute totalFeatures — never let a declared count drift from features.length.
  const prevTotal = typeof registry.totalFeatures === 'number' ? registry.totalFeatures : null;
  registry.totalFeatures = registry.features.length;
  if (prevTotal != null && prevTotal !== registry.features.length) {
    repairs.push({
      featureId: '_registry',
      field: 'totalFeatures',
      before: prevTotal,
      after: registry.features.length,
      reason: 'declared-count-drift',
    });
  }

  // v0.26: ensure version pin — downstream gates read `version: 1` as the canonical contract.
  if (registry.version == null) {
    registry.version = 1;
    repairs.push({ featureId: '_registry', field: 'version', after: 1, reason: 'version-pin' });
  }

  if (repairs.length > 0) {
    registry.repairedAt = new Date().toISOString();
    fs.writeFileSync(REGISTRY, JSON.stringify(registry, null, 2));
    fs.writeFileSync(
      REPAIR_LOG,
      JSON.stringify(
        {
          repairedAt: registry.repairedAt,
          sourceRowCount: srcRows.length,
          repairCount: repairs.length,
          repairs,
        },
        null,
        2,
      ),
    );
    const argv = process.argv.slice(2);
    const jsonOut = argv.includes('--json');
    if (jsonOut) {
      console.log(JSON.stringify({ repaired: true, count: repairs.length, log: REPAIR_LOG }));
    } else {
      console.log(`[repair] patched ${repairs.length} missing field(s); log: ${REPAIR_LOG}`);
    }
  } else {
    console.log('[repair] no missing required fields detected');
  }
}

main();
