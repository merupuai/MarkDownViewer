#!/usr/bin/env node

// CoBolt Task-Shaped Context Router — Phase 1+2+3 first implementation slice.
//
// Builds an optional `contextRoute` plan that ranks small path-backed context
// cells by deterministic signals (requirement ids, finding ids, story ids,
// current milestone, changed files, failing tests, evidence-graph links).
// The plan is additive to existing packets; consumers fall back to
// context.artifacts when no route is present.
//
// Usage:
//   node tools/cobolt-context-router.js route <stage> [--milestone M1] [--item E1-S1]
//     [--requirement FR-001] [--finding SEC-001] [--story E1-S1]
//     [--query "..."] [--changed a.ts,b.ts] [--failing-test path/to/test]
//     [--mode observe|enforce] [--max-selected 12] [--max-excerpt-chars 2400]
//     [--output file] [--write] [--json]
//   node tools/cobolt-context-router.js explain --route <path>
//
// Programmatic:
//   const { buildContextRoute, writeContextRoute, explainContextRoute,
//           defaultRouteOutputPath } = require('./cobolt-context-router');

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWriteJSON } = require('../lib/cobolt-atomic-write');
// Optional deps — tolerate absence so the router fails-open.
function safeRequire(modulePath) {
  try {
    return require(modulePath);
  } catch {
    return null;
  }
}

const pathsMod = safeRequire('../lib/cobolt-paths');
const graphMod = safeRequire('./cobolt-knowledge-graph');
const impactMod = safeRequire('./cobolt-evidence-impact');
const executionLedgerMod = safeRequire('../lib/cobolt-execution-ledger');

const ROUTE_SCHEMA_VERSION = '1.0.0';
const DEFAULT_MAX_SELECTED = 12;
const DEFAULT_MAX_EXCERPT_CHARS = 2400;
const SELECT_THRESHOLD = 3;
const PARK_THRESHOLD = 1;
const STALE_DAYS = 30;
const RECENT_DAYS = 7;
const MAX_GRAPH_CELLS = 50; // cap evidence-graph neighbour expansion

// ── Path helpers ─────────────────────────────────────────────

function latestDir(projectRoot) {
  const root = path.resolve(projectRoot);
  if (typeof pathsMod === 'function') {
    try {
      const p = pathsMod(root);
      if (p?.latestOutputDir) return p.latestOutputDir();
    } catch {
      /* fall through */
    }
  }
  return path.join(root, '_cobolt-output', 'latest');
}

function relPath(projectRoot, abs) {
  const root = path.resolve(projectRoot);
  const r = path.relative(root, abs).replace(/\\/g, '/');
  return r || '.';
}

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function statFreshness(filePath) {
  try {
    const st = fs.statSync(filePath);
    const ageDays = (Date.now() - st.mtimeMs) / (1000 * 60 * 60 * 24);
    if (ageDays <= RECENT_DAYS) return { freshness: 'current', updatedAt: st.mtime.toISOString(), size: st.size };
    if (ageDays <= STALE_DAYS) return { freshness: 'recent', updatedAt: st.mtime.toISOString(), size: st.size };
    return { freshness: 'stale', updatedAt: st.mtime.toISOString(), size: st.size };
  } catch {
    return { freshness: 'unknown', updatedAt: null, size: null };
  }
}

function checksumOf(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const hex = crypto.createHash('sha256').update(buf).digest('hex');
    return `sha256:${hex}`;
  } catch {
    return null;
  }
}

// ── Signal extractors ────────────────────────────────────────

function parseList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function readRtmCells(projectRoot, requirementIds, milestone, stage, diagnostics) {
  if (requirementIds.length === 0) return [];
  const rtmPath = path.join(latestDir(projectRoot), 'planning', 'rtm.json');
  const rtm = safeReadJson(rtmPath);
  if (!rtm) {
    diagnostics.push({
      level: 'info',
      message: 'rtm.json not found — requirement cells will be path-only',
      path: relPath(projectRoot, rtmPath),
    });
    return requirementIds.map((id) =>
      makeCell({
        id: `requirement:${id}`,
        kind: 'requirement',
        path: relPath(projectRoot, rtmPath),
        stage,
        milestone,
        priority: 'medium',
        reasonCodes: ['same-requirement'],
        freshness: 'unknown',
        expandMode: 'path-only',
        label: id,
      }),
    );
  }
  const fresh = statFreshness(rtmPath);
  const checksum = checksumOf(rtmPath);
  return requirementIds.map((id) => {
    const entry = rtm.requirements?.[id];
    const entryMilestone = Array.isArray(entry?.milestones) ? entry.milestones[0] : entry?.milestone || null;
    const reasonCodes = ['same-requirement'];
    if (milestone && entryMilestone === milestone) reasonCodes.push('current-milestone');
    if (fresh.freshness === 'stale') reasonCodes.push('stale');
    return makeCell({
      id: `requirement:${id}`,
      kind: 'requirement',
      path: relPath(projectRoot, rtmPath),
      stage,
      milestone: entryMilestone || milestone,
      priority: entry?.priority || 'medium',
      reasonCodes,
      freshness: fresh.freshness,
      checksum,
      size: fresh.size,
      updatedAt: fresh.updatedAt,
      expandMode: 'path-only',
      label: entry?.title || id,
    });
  });
}

function _readFindingCells(projectRoot, findingIds, milestone, stage, diagnostics) {
  if (findingIds.length === 0) return [];
  const base = path.join(latestDir(projectRoot), 'review');
  const trackerPath = milestone ? path.join(latestDir(projectRoot), 'fix', milestone, 'finding-tracker.json') : null;
  const altTracker = path.join(base, 'finding-tracker.json');
  const trackerPathResolved = trackerPath && fs.existsSync(trackerPath) ? trackerPath : altTracker;
  const tracker = safeReadJson(trackerPathResolved);
  if (!tracker) {
    diagnostics.push({
      level: 'info',
      message: 'finding-tracker.json not found — finding cells will be path-only',
      path: relPath(projectRoot, trackerPathResolved),
    });
    return findingIds.map((id) =>
      makeCell({
        id: `finding:${id}`,
        kind: 'finding',
        path: relPath(projectRoot, trackerPathResolved),
        stage,
        milestone,
        priority: 'high',
        reasonCodes: ['same-finding'],
        freshness: 'unknown',
        expandMode: 'path-only',
        label: id,
      }),
    );
  }
  const fresh = statFreshness(trackerPathResolved);
  const checksum = checksumOf(trackerPathResolved);
  const findings = Array.isArray(tracker.findings) ? tracker.findings : [];
  return findingIds.map((id) => {
    const entry = findings.find((f) => f.id === id);
    const reasonCodes = ['same-finding'];
    if (entry?.severity === 'critical' || entry?.severity === 'high') reasonCodes.push('high-severity');
    if (fresh.freshness === 'stale') reasonCodes.push('stale');
    return makeCell({
      id: `finding:${id}`,
      kind: 'finding',
      path: relPath(projectRoot, trackerPathResolved),
      stage,
      milestone: entry?.milestone || milestone,
      priority: mapSeverityToPriority(entry?.severity),
      reasonCodes,
      freshness: fresh.freshness,
      checksum,
      size: fresh.size,
      updatedAt: fresh.updatedAt,
      expandMode: 'path-only',
      label: entry?.title || id,
    });
  });
}

function mapSeverityToPriority(severity) {
  const s = String(severity || '').toLowerCase();
  if (s === 'critical') return 'critical';
  if (s === 'high') return 'high';
  if (s === 'low') return 'low';
  if (s === 'info') return 'info';
  return 'medium';
}

function _readStoryCells(projectRoot, storyIds, milestone, stage, diagnostics) {
  if (storyIds.length === 0) return [];
  const trackerPath = milestone
    ? path.join(latestDir(projectRoot), 'build', milestone, 'story-tracker.json')
    : path.join(latestDir(projectRoot), 'planning', 'story-tracker.json');
  const tracker = safeReadJson(trackerPath);
  if (!tracker) {
    diagnostics.push({
      level: 'info',
      message: 'story-tracker.json not found — story cells will be path-only',
      path: relPath(projectRoot, trackerPath),
    });
    return storyIds.map((id) =>
      makeCell({
        id: `story:${id}`,
        kind: 'story',
        path: relPath(projectRoot, trackerPath),
        stage,
        milestone,
        priority: 'medium',
        reasonCodes: ['same-story'],
        freshness: 'unknown',
        expandMode: 'path-only',
        label: id,
      }),
    );
  }
  const fresh = statFreshness(trackerPath);
  const checksum = checksumOf(trackerPath);
  const stories = Array.isArray(tracker.stories) ? tracker.stories : Array.isArray(tracker) ? tracker : [];
  return storyIds.map((id) => {
    const entry = stories.find((s) => s.id === id || s.storyId === id);
    const reasonCodes = ['same-story'];
    if (milestone && entry?.milestone === milestone) reasonCodes.push('current-milestone');
    if (fresh.freshness === 'stale') reasonCodes.push('stale');
    return makeCell({
      id: `story:${id}`,
      kind: 'story',
      path: relPath(projectRoot, trackerPath),
      stage,
      milestone: entry?.milestone || milestone,
      priority: entry?.priority || 'medium',
      reasonCodes,
      freshness: fresh.freshness,
      checksum,
      size: fresh.size,
      updatedAt: fresh.updatedAt,
      expandMode: 'path-only',
      label: entry?.title || id,
    });
  });
}

function readFindingCells(projectRoot, findingIds, milestone, stage, diagnostics) {
  if (findingIds.length === 0) return [];
  const projectionPath = executionLedgerMod?.executionPaths
    ? executionLedgerMod.executionPaths(projectRoot).findingsProjectionPath
    : path.join(latestDir(projectRoot), 'execution', 'projections', 'findings.json');
  const projection = executionLedgerMod?.readExecutionProjection
    ? executionLedgerMod.readExecutionProjection(projectRoot, 'findings')
    : safeReadJson(projectionPath);

  if (!projection) {
    diagnostics.push({
      level: 'info',
      message: 'execution findings projection not found â€” finding cells will be path-only',
      path: relPath(projectRoot, projectionPath),
    });
    return findingIds.map((id) =>
      makeCell({
        id: `finding:${id}`,
        kind: 'finding',
        path: relPath(projectRoot, projectionPath),
        stage,
        milestone,
        priority: 'high',
        reasonCodes: ['same-finding'],
        freshness: 'unknown',
        expandMode: 'path-only',
        label: id,
      }),
    );
  }

  const fresh = statFreshness(projectionPath);
  const checksum = checksumOf(projectionPath);
  const findings = Array.isArray(projection.findings) ? projection.findings : [];
  return findingIds.map((id) => {
    const entry = findings.find((finding) => finding.id === id || finding.findingId === id);
    const reasonCodes = ['same-finding'];
    if (milestone && entry?.milestone === milestone) reasonCodes.push('current-milestone');
    if (entry?.priority === 'critical' || entry?.priority === 'high' || entry?.metadata?.severity === 'critical') {
      reasonCodes.push('high-severity');
    }
    if (fresh.freshness === 'stale') reasonCodes.push('stale');
    return makeCell({
      id: `finding:${id}`,
      kind: 'finding',
      path: relPath(projectRoot, projectionPath),
      stage,
      milestone: entry?.milestone || milestone,
      priority: entry?.priority || mapSeverityToPriority(entry?.metadata?.severity),
      reasonCodes,
      freshness: fresh.freshness,
      checksum,
      size: fresh.size,
      updatedAt: fresh.updatedAt,
      expandMode: 'path-only',
      label: entry?.title || id,
    });
  });
}

function readStoryCells(projectRoot, storyIds, milestone, stage, diagnostics) {
  if (storyIds.length === 0) return [];
  const ledgerPath = executionLedgerMod?.executionPaths
    ? executionLedgerMod.executionPaths(projectRoot).ledgerPath
    : path.join(latestDir(projectRoot), 'execution', 'ledger.json');
  const ledger = executionLedgerMod?.readExecutionLedger
    ? executionLedgerMod.readExecutionLedger(projectRoot)
    : safeReadJson(ledgerPath);

  if (!ledger || !Array.isArray(ledger.items)) {
    diagnostics.push({
      level: 'info',
      message: 'execution ledger not found â€” story cells will be path-only',
      path: relPath(projectRoot, ledgerPath),
    });
    return storyIds.map((id) =>
      makeCell({
        id: `story:${id}`,
        kind: 'story',
        path: relPath(projectRoot, ledgerPath),
        stage,
        milestone,
        priority: 'medium',
        reasonCodes: ['same-story'],
        freshness: 'unknown',
        expandMode: 'path-only',
        label: id,
      }),
    );
  }

  const fresh = statFreshness(ledgerPath);
  const checksum = checksumOf(ledgerPath);
  const stories = ledger.items.filter((item) => item.kind === 'story');
  return storyIds.map((id) => {
    const entry = stories.find((story) => story.storyId === id || story.id === `story:${id}`);
    const reasonCodes = ['same-story'];
    if (milestone && entry?.milestone === milestone) reasonCodes.push('current-milestone');
    if (fresh.freshness === 'stale') reasonCodes.push('stale');
    return makeCell({
      id: `story:${id}`,
      kind: 'story',
      path: relPath(projectRoot, ledgerPath),
      stage,
      milestone: entry?.milestone || milestone,
      priority: entry?.priority || 'medium',
      reasonCodes,
      freshness: fresh.freshness,
      checksum,
      size: fresh.size,
      updatedAt: fresh.updatedAt,
      expandMode: 'path-only',
      label: entry?.title || entry?.storyId || id,
    });
  });
}

function readChangedFileCells(projectRoot, changedFiles, stage) {
  return changedFiles.map((fileRel) => {
    const abs = path.isAbsolute(fileRel) ? fileRel : path.join(projectRoot, fileRel);
    const fresh = statFreshness(abs);
    const reasonCodes = ['changed-file'];
    if (fresh.freshness === 'current') reasonCodes.push('recent-and-valid');
    if (fresh.freshness === 'stale') reasonCodes.push('stale');
    return makeCell({
      id: `file:${fileRel}`,
      kind: 'file',
      path: fileRel.replace(/\\/g, '/'),
      stage,
      priority: 'medium',
      reasonCodes,
      freshness: fresh.freshness,
      checksum: checksumOf(abs),
      size: fresh.size,
      updatedAt: fresh.updatedAt,
      expandMode: 'excerpt',
      label: path.basename(fileRel),
    });
  });
}

function readFailingTestCells(projectRoot, failingTests, stage) {
  return failingTests.map((testRel) => {
    const abs = path.isAbsolute(testRel) ? testRel : path.join(projectRoot, testRel);
    const fresh = statFreshness(abs);
    const reasonCodes = ['failing-test-surface'];
    if (fresh.freshness === 'current') reasonCodes.push('recent-and-valid');
    return makeCell({
      id: `test:${testRel}`,
      kind: 'test',
      path: testRel.replace(/\\/g, '/'),
      stage,
      priority: 'high',
      reasonCodes,
      freshness: fresh.freshness,
      checksum: checksumOf(abs),
      size: fresh.size,
      updatedAt: fresh.updatedAt,
      expandMode: 'excerpt',
      label: path.basename(testRel),
    });
  });
}

function readEvidenceGraphCells(projectRoot, requirementIds, findingIds, storyIds, stage, diagnostics) {
  if (!graphMod || typeof graphMod.readKnowledgeGraph !== 'function') return [];
  let graph;
  try {
    graph = graphMod.readKnowledgeGraph(projectRoot);
  } catch (err) {
    diagnostics.push({ level: 'warn', message: `knowledge graph read failed: ${err.message}`, path: null });
    return [];
  }
  if (!graph?.nodes || !graph?.edges) {
    diagnostics.push({
      level: 'info',
      message: 'knowledge graph not built — evidence-graph signals skipped',
      path: null,
    });
    return [];
  }
  const anchors = new Set(
    [
      ...requirementIds.map((id) => `requirement:${id}`),
      ...findingIds.map((id) => `finding:${id}`),
      ...storyIds.map((id) => `story:${id}`),
    ].map((s) => s.toLowerCase()),
  );
  if (anchors.size === 0) return [];

  const nodeById = new Map();
  for (const n of graph.nodes) nodeById.set(String(n.id).toLowerCase(), n);

  const linked = new Set();
  for (const edge of graph.edges) {
    const from = String(edge.from).toLowerCase();
    const to = String(edge.to).toLowerCase();
    if (anchors.has(from)) linked.add(to);
    if (anchors.has(to)) linked.add(from);
  }

  const cells = [];
  let clipped = 0;
  for (const nodeId of linked) {
    if (anchors.has(nodeId)) continue;
    const node = nodeById.get(nodeId);
    if (!node) continue;
    const nodePath = node.path || null;
    if (!nodePath) continue;
    if (cells.length >= MAX_GRAPH_CELLS) {
      clipped += 1;
      continue;
    }
    const abs = path.isAbsolute(nodePath) ? nodePath : path.join(projectRoot, nodePath);
    const fresh = statFreshness(abs);
    cells.push(
      makeCell({
        id: `${node.type || 'evidence'}:${node.id}`,
        kind: normalizeKind(node.type),
        path: String(nodePath).replace(/\\/g, '/'),
        stage,
        priority: 'medium',
        reasonCodes: ['evidence-graph-link'],
        freshness: fresh.freshness,
        checksum: checksumOf(abs),
        size: fresh.size,
        updatedAt: fresh.updatedAt,
        expandMode: 'path-only',
        label: node.label || String(node.id),
      }),
    );
  }
  if (clipped > 0) {
    diagnostics.push({
      level: 'info',
      message: `evidence graph returned ${clipped} additional cell(s) beyond MAX_GRAPH_CELLS=${MAX_GRAPH_CELLS}; consider narrowing anchors`,
      path: null,
    });
  }
  return cells;
}

function normalizeKind(type) {
  const kindMap = {
    requirement: 'requirement',
    finding: 'finding',
    story: 'story',
    milestone: 'milestone',
    file: 'file',
    document: 'document',
    section: 'section',
    symbol: 'symbol',
    module: 'file',
    evidence: 'evidence',
    chunk: 'section',
  };
  return kindMap[String(type || '').toLowerCase()] || 'other';
}

// ── Cell factory ─────────────────────────────────────────────

function makeCell({
  id,
  kind,
  path: cellPath,
  stage,
  milestone = null,
  priority = 'medium',
  reasonCodes,
  freshness = 'unknown',
  checksum = null,
  size = null,
  updatedAt = null,
  expandMode = 'path-only',
  label = null,
  line = null,
}) {
  const normalizedReasons =
    Array.isArray(reasonCodes) && reasonCodes.length > 0 ? reasonCodes : ['no-task-relationship'];
  return {
    id,
    kind,
    path: String(cellPath),
    line,
    label,
    stage,
    milestone,
    priority,
    reasonCodes: [...new Set(normalizedReasons)],
    freshness,
    checksum,
    expandMode,
    size,
    updatedAt,
  };
}

// ── Scoring ──────────────────────────────────────────────────

const POSITIVE_WEIGHTS = {
  'same-requirement': 5,
  'same-finding': 5,
  'same-story': 4,
  'current-milestone': 2,
  'evidence-graph-link': 3,
  'changed-file': 3,
  'failing-test-surface': 4,
  'canonical-source': 1,
  'recent-and-valid': 1,
  'high-severity': 2,
};

const NEGATIVE_WEIGHTS = {
  stale: -2,
  'oversized-no-link': -3,
  'prior-failed-approach': -3,
  'duplicate-of-canonical': -2,
  'no-task-relationship': -4,
};

function scoreCell(cell) {
  let score = 0;
  for (const code of cell.reasonCodes) {
    if (Object.hasOwn(POSITIVE_WEIGHTS, code)) score += POSITIVE_WEIGHTS[code];
    if (Object.hasOwn(NEGATIVE_WEIGHTS, code)) score += NEGATIVE_WEIGHTS[code];
  }
  return score;
}

// ── Deduplication ────────────────────────────────────────────

function dedupeCells(cells) {
  const seen = new Map();
  for (const cell of cells) {
    const key = `${cell.kind}|${cell.path}|${cell.label || cell.id}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, cell);
      continue;
    }
    // Merge reason codes when two cells resolve to the same artifact.
    const mergedReasons = [...new Set([...existing.reasonCodes, ...cell.reasonCodes])];
    seen.set(key, { ...existing, reasonCodes: mergedReasons });
  }
  return [...seen.values()];
}

// ── Plan builder ─────────────────────────────────────────────

function buildContextRoute(projectRoot, options = {}) {
  const root = path.resolve(projectRoot || process.cwd());
  const stage = String(options.stage || 'build')
    .trim()
    .toLowerCase();
  const milestone = options.milestone || null;
  const mode = options.mode === 'enforce' ? 'enforce' : 'observe';
  const maxSelected =
    Number.isFinite(options.maxSelected) && options.maxSelected > 0
      ? Math.min(options.maxSelected, 200)
      : DEFAULT_MAX_SELECTED;
  const maxExcerptChars =
    Number.isFinite(options.maxExcerptChars) && options.maxExcerptChars >= 0
      ? Math.min(options.maxExcerptChars, 100000)
      : DEFAULT_MAX_EXCERPT_CHARS;

  const requirementIds = parseList(options.requirementIds || options.requirement);
  const findingIds = parseList(options.findingIds || options.finding);
  const storyIds = parseList(options.storyIds || options.story);
  const changedFiles = parseList(options.changedFiles || options.changed);
  const failingTests = parseList(options.failingTests || options.failingTest);
  const query = String(
    options.query || buildDefaultQuery(stage, milestone, options.item, requirementIds, findingIds, storyIds),
  );

  const diagnostics = [];
  let cells = [];
  try {
    cells = cells.concat(readRtmCells(root, requirementIds, milestone, stage, diagnostics));
    cells = cells.concat(readFindingCells(root, findingIds, milestone, stage, diagnostics));
    cells = cells.concat(readStoryCells(root, storyIds, milestone, stage, diagnostics));
    cells = cells.concat(readChangedFileCells(root, changedFiles, stage));
    cells = cells.concat(readFailingTestCells(root, failingTests, stage));
    cells = cells.concat(readEvidenceGraphCells(root, requirementIds, findingIds, storyIds, stage, diagnostics));
  } catch (err) {
    diagnostics.push({ level: 'error', message: `cell collection error: ${err.message}`, path: null });
  }

  cells = dedupeCells(cells);

  const decisionLog = [];
  const selected = [];
  const parked = [];
  const omitted = [];

  // Score and bucket
  const scored = cells
    .map((cell) => ({ cell: { ...cell, score: scoreCell(cell) }, score: scoreCell(cell) }))
    .sort((a, b) => b.score - a.score);

  for (const { cell, score } of scored) {
    if (selected.length < maxSelected && score >= SELECT_THRESHOLD) {
      selected.push(cell);
      decisionLog.push({ cellId: cell.id, bucket: 'selected', reason: explainReasons(cell.reasonCodes), score });
    } else if (score >= PARK_THRESHOLD) {
      parked.push(cell);
      decisionLog.push({ cellId: cell.id, bucket: 'parked', reason: explainReasons(cell.reasonCodes), score });
    } else {
      omitted.push(cell);
      decisionLog.push({ cellId: cell.id, bucket: 'omitted', reason: explainReasons(cell.reasonCodes), score });
    }
  }

  // Optional advisory impact decoration (Companion #1). Opt-in only.
  if (impactEnabled(options)) {
    enrichCellsWithImpact(root, selected, milestone, diagnostics);
    enrichCellsWithImpact(root, parked, milestone, diagnostics);
  }

  return {
    version: ROUTE_SCHEMA_VERSION,
    enabled: selected.length + parked.length > 0,
    mode,
    generatedAt: new Date().toISOString(),
    stage,
    milestone,
    skill: options.skill || null,
    agent: options.agent || null,
    item: options.item || null,
    query,
    inputs: {
      requirementIds,
      findingIds,
      storyIds,
      changedFiles,
      failingTests,
    },
    selected,
    parked,
    omitted,
    budget: { maxSelected, maxExcerptChars },
    cache: { summaryHits: 0, summaryMisses: 0 },
    decisionLog,
    diagnostics,
  };
}

function impactEnabled(options) {
  if (options.impact === true) return true;
  if (options.impact === false) return false;
  return String(process.env.COBOLT_CONTEXT_ROUTE_IMPACT || '').trim() === '1';
}

function enrichCellsWithImpact(projectRoot, cells, milestone, diagnostics) {
  if (!impactMod || typeof impactMod.scoreEvidence !== 'function') {
    diagnostics.push({
      level: 'info',
      message: 'evidence-impact unavailable — cells will not carry impact decoration',
      path: null,
    });
    return;
  }
  for (const cell of cells) {
    // Only decorate cells that naturally map to a scorable kind.
    if (cell.kind !== 'requirement' && cell.kind !== 'finding') continue;
    try {
      const id = cell.id.includes(':') ? cell.id.split(':')[1] : cell.id;
      let target = null;
      if (cell.kind === 'requirement' && typeof impactMod.hydrateFromRtm === 'function') {
        target = impactMod.hydrateFromRtm(projectRoot, id);
      } else if (cell.kind === 'finding' && typeof impactMod.hydrateFromFinding === 'function') {
        target = impactMod.hydrateFromFinding(projectRoot, id, cell.milestone || milestone);
      }
      if (!target) continue;
      const impact = impactMod.scoreEvidence(projectRoot, target, { currentMilestone: milestone });
      cell.impact = {
        score: impact.score,
        band: impact.band,
        confidence: impact.confidence,
      };
    } catch (err) {
      diagnostics.push({
        level: 'warn',
        message: `impact enrichment failed for ${cell.id}: ${err.message}`,
        path: null,
      });
    }
  }
}

function buildDefaultQuery(stage, milestone, item, requirementIds, findingIds, storyIds) {
  const parts = [stage];
  if (milestone) parts.push(milestone);
  if (item) parts.push(String(item));
  if (requirementIds.length) parts.push(requirementIds.join(','));
  if (findingIds.length) parts.push(findingIds.join(','));
  if (storyIds.length) parts.push(storyIds.join(','));
  return parts.filter(Boolean).join(' ');
}

function explainReasons(reasonCodes) {
  return reasonCodes.join(', ');
}

// ── Writer ───────────────────────────────────────────────────

function slugifyPathSegment(value, fallback) {
  const slug = String(value || '').replace(/[^a-zA-Z0-9_-]+/g, '-');
  return slug.length > 0 ? slug : fallback;
}

function defaultRouteOutputPath(projectRoot, route) {
  const root = path.resolve(projectRoot);
  // All path segments are slugified to a safe alphabet to prevent a malformed
  // packet from writing the route file outside the intended context-packets dir.
  const stage = slugifyPathSegment(route.stage, 'context');
  const milestone = slugifyPathSegment(route.milestone, 'all');
  const agentPart = route.agent ? `-${slugifyPathSegment(route.agent, 'agent')}` : '';
  const skillPart = route.skill && stage === 'planning' ? `-${slugifyPathSegment(route.skill, 'skill')}` : '';
  const dir =
    stage === 'planning'
      ? path.join(root, '_cobolt-output', 'latest', 'planning', 'context-packets')
      : path.join(root, '_cobolt-output', 'latest', stage, 'context-packets');
  return path.join(dir, `${stage}${skillPart}-${milestone}${agentPart}-route.json`);
}

function writeContextRoute(projectRoot, route, outputPath) {
  // Validate before write — prevents shipping malformed plans that consumers
  // would later reject. Fail-open: if the validator is unavailable (e.g.,
  // Ajv not installed in a stripped-down environment), we still write.
  const validate = routeSchemaValidator();
  if (validate && !validate(route)) {
    const err = new Error(`context route failed schema validation: ${JSON.stringify(validate.errors).slice(0, 300)}`);
    err.code = 'ROUTE_SCHEMA_INVALID';
    err.errors = validate.errors;
    throw err;
  }
  const target = outputPath || defaultRouteOutputPath(projectRoot, route);
  atomicWriteJSON(target, route, { mode: 0o600 });
  return target;
}

let cachedValidator = null;
function routeSchemaValidator() {
  if (cachedValidator) return cachedValidator;
  try {
    const Ajv2020 = require('ajv/dist/2020');
    const addFormats = require('ajv-formats');
    const schemaPath = path.resolve(__dirname, '..', 'source', 'schemas', 'context-route.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    cachedValidator = ajv.compile(schema);
    return cachedValidator;
  } catch (err) {
    // Validator unavailable — caller should treat absence as "cannot validate"
    // rather than "route is valid". Fail-open reads will still work.
    if (process.env.COBOLT_CONTEXT_ROUTER_DEBUG === '1') {
      console.error(`  [context-router] schema validator unavailable: ${err.message}`);
    }
    return null;
  }
}

function readContextRoute(routePath, options = {}) {
  try {
    const raw = fs.readFileSync(routePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (options.validate !== false) {
      const validate = routeSchemaValidator();
      if (validate && !validate(parsed)) {
        return { ok: false, route: null, errors: validate.errors };
      }
    }
    return { ok: true, route: parsed, errors: null };
  } catch (err) {
    return { ok: false, route: null, errors: [{ message: err.message }] };
  }
}

function explainContextRoute(route) {
  if (!route || typeof route !== 'object') return { summary: 'invalid route', entries: [] };
  const counts = {
    selected: route.selected?.length || 0,
    parked: route.parked?.length || 0,
    omitted: route.omitted?.length || 0,
  };
  return {
    summary: `stage=${route.stage || '?'} milestone=${route.milestone || '?'} selected=${counts.selected} parked=${counts.parked} omitted=${counts.omitted}`,
    stage: route.stage,
    milestone: route.milestone,
    mode: route.mode,
    counts,
    entries: route.decisionLog || [],
    diagnostics: route.diagnostics || [],
  };
}

// ── CLI ──────────────────────────────────────────────────────

function flagValue(args, flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : null;
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function collectFlagValues(args, flag) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag && args[i + 1]) values.push(args[i + 1]);
  }
  return values;
}

function printUsage() {
  console.log(`  CoBolt Context Router — task-shaped context routing

  Usage:
    node tools/cobolt-context-router.js route <stage> [flags]
    node tools/cobolt-context-router.js explain --route <path>

  Flags (route):
    --milestone M1           Current milestone
    --item ID                Current item id (story/task)
    --requirement FR-001     Add requirement id (repeatable)
    --finding SEC-001        Add finding id (repeatable)
    --story E1-S1            Add story id (repeatable)
    --changed PATH           Add changed file (repeatable, or comma list)
    --failing-test PATH      Add failing test (repeatable, or comma list)
    --query TEXT             Canonical query; default derived from inputs
    --mode MODE              observe (default) | enforce
    --max-selected N         Budget (default 12)
    --max-excerpt-chars N    Budget (default 2400)
    --skill NAME             Attach skill label
    --agent NAME             Attach agent label
    --output FILE            Write to FILE instead of default path
    --write                  Persist the route plan
    --json                   Print the route plan JSON to stdout
`);
}

function main(argv) {
  const args = argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    printUsage();
    process.exit(0);
  }

  if (cmd === 'route') {
    const stage = args[1] && !args[1].startsWith('--') ? args[1] : null;
    if (!stage) {
      console.error('  Usage: route <stage> [flags]');
      process.exit(2);
    }
    const options = {
      stage,
      milestone: flagValue(args, '--milestone'),
      item: flagValue(args, '--item'),
      requirementIds: collectFlagValues(args, '--requirement').flatMap(parseList),
      findingIds: collectFlagValues(args, '--finding').flatMap(parseList),
      storyIds: collectFlagValues(args, '--story').flatMap(parseList),
      changedFiles: collectFlagValues(args, '--changed').flatMap(parseList),
      failingTests: collectFlagValues(args, '--failing-test').flatMap(parseList),
      query: flagValue(args, '--query'),
      mode: flagValue(args, '--mode'),
      maxSelected: Number.parseInt(flagValue(args, '--max-selected') || '', 10) || undefined,
      maxExcerptChars: Number.parseInt(flagValue(args, '--max-excerpt-chars') || '', 10) || undefined,
      skill: flagValue(args, '--skill'),
      agent: flagValue(args, '--agent'),
      impact: hasFlag(args, '--impact') ? true : hasFlag(args, '--no-impact') ? false : undefined,
    };
    const route = buildContextRoute(process.cwd(), options);
    let writtenPath = null;
    if (hasFlag(args, '--write')) {
      writtenPath = writeContextRoute(process.cwd(), route, flagValue(args, '--output'));
    }
    if (hasFlag(args, '--json')) {
      console.log(
        JSON.stringify({ ...route, routePath: writtenPath ? relPath(process.cwd(), writtenPath) : null }, null, 2),
      );
    } else {
      const ex = explainContextRoute(route);
      console.log(`  Route built: ${ex.summary}`);
      if (writtenPath) console.log(`  Written: ${relPath(process.cwd(), writtenPath)}`);
    }
    return;
  }

  if (cmd === 'explain') {
    const routePath = flagValue(args, '--route');
    if (!routePath) {
      console.error('  Usage: explain --route <path>');
      process.exit(2);
    }
    const abs = path.isAbsolute(routePath) ? routePath : path.join(process.cwd(), routePath);
    const readResult = readContextRoute(abs, { validate: !hasFlag(args, '--no-validate') });
    if (!readResult.ok) {
      console.error(`  Could not read route file: ${routePath}`);
      if (readResult.errors) console.error(`  ${JSON.stringify(readResult.errors, null, 2)}`);
      process.exit(2);
    }
    const route = readResult.route;
    const ex = explainContextRoute(route);
    if (hasFlag(args, '--json')) {
      console.log(JSON.stringify(ex, null, 2));
    } else {
      console.log(`  ${ex.summary}`);
      for (const entry of ex.entries) {
        console.log(`    [${entry.bucket}] ${entry.cellId} — ${entry.reason} (score ${entry.score})`);
      }
    }
    return;
  }

  console.error(`  Unknown command: ${cmd}`);
  printUsage();
  process.exit(2);
}

module.exports = {
  buildContextRoute,
  writeContextRoute,
  readContextRoute,
  explainContextRoute,
  defaultRouteOutputPath,
  scoreCell,
  ROUTE_SCHEMA_VERSION,
  DEFAULT_MAX_SELECTED,
  DEFAULT_MAX_EXCERPT_CHARS,
};

if (require.main === module) {
  try {
    main(process.argv);
  } catch (err) {
    console.error(`  context-router error: ${err.message}`);
    process.exit(1);
  }
}
