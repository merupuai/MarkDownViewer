#!/usr/bin/env node

// CoBolt Planning Integrity Gate --- Tier 1
//
// Single census gate that verifies the 15 cross-artifact integrity contracts
// violated by the v0.23 defect audit. Runs at plan-close, brownfield-handoff,
// and before any downstream consumer (build, review, deploy).
//
// Exit codes:
//   0  — all contracts satisfied
//   4  — Tier 1 hard failure (contract violation); block pipeline
//   2  — Tier 2 soft failure (populate warnings, continue with degraded grade)
//   3  — invocation error (missing planning dir, bad flags)
//
// Usage:
//   node tools/cobolt-planning-integrity.js check              # full census
//   node tools/cobolt-planning-integrity.js check --json       # JSON output
//   node tools/cobolt-planning-integrity.js check --tier 2     # only warn, never block
//   node tools/cobolt-planning-integrity.js check --skip diagrams,versioning
//
// Contracts enforced (D-N maps to the v0.23 audit finding):
//   C1  (D-8)  : story-tracker.json has .stories as an array (not object)
//   C2  (D-2)  : every milestone with epics has storyCount > 0
//   C3  (D-5)  : every story has taskCount matching tasks.length
//   C4  (D-1)  : every mapped FR has .stories populated when story-tracker links it
//   C5  (D-3)  : story-specs coverage >= threshold (default 100% at plan-close)
//   C6  (D-4)  : no mermaid diagram is a placeholder ("No nodes" stub) if graph has real nodes
//   C7  (D-6)  : diagram-manifest.json reports edgeCount > 0 on diagrams that should have edges
//   C8  (D-7)  : no two diagrams of different kind have identical node sets
//   C9  (D-10) : every planning phase artifact has at least one snapshot in _versions/
//   C10 (D-12) : capability-graph edges overlap architecture-graph edges (not disjoint)
//   C11 (D-13) : epic IDs consistent across epics.md / rtm.json / story-tracker / sprint / milestones
//   C12 (D-11) : if any NFR declares RLS, data-model-spec.md contains CREATE POLICY
//   C13 (D-14) : user-journeys.md entries link to at least one FR
//   C14 (D-15) : readiness report references _cobolt-output/audit/ state
//   C15 (D-9)  : no story file matches the canonical E[A-Z0-9_]+-S\d+ pattern but is missing from trackers

const fs = require('node:fs');
const path = require('node:path');

const { canonicalTrackerStories, getPlanningDir, normalizeStoryId } = require('../lib/cobolt-planning-artifacts');

const CONTRACT_CATALOG = [
  { id: 'C1', defect: 'D-8', name: 'story-tracker-shape', tier: 1, group: 'shape' },
  { id: 'C2', defect: 'D-2', name: 'milestone-storycount', tier: 1, group: 'population' },
  { id: 'C3', defect: 'D-5', name: 'story-taskcount', tier: 2, group: 'population' },
  { id: 'C4', defect: 'D-1', name: 'rtm-story-linkage', tier: 1, group: 'rtm' },
  { id: 'C5', defect: 'D-3', name: 'spec-coverage', tier: 2, group: 'specs' },
  { id: 'C6', defect: 'D-4', name: 'diagram-stubs', tier: 1, group: 'diagrams' },
  // v0.28: promoted to Tier 1 with kind-aware scoping (EDGE_REQUIRED_KINDS)
  { id: 'C7', defect: 'D-6', name: 'diagram-edges', tier: 1, group: 'diagrams' },
  // v0.28: promoted to Tier 1 with kind-grouped signature matching
  { id: 'C8', defect: 'D-7', name: 'diagram-duplicates', tier: 1, group: 'diagrams' },
  { id: 'C9', defect: 'D-10', name: 'version-snapshots', tier: 2, group: 'versioning' },
  { id: 'C10', defect: 'D-12', name: 'capability-graph-merge', tier: 2, group: 'graph' },
  { id: 'C11', defect: 'D-13', name: 'epic-id-consistency', tier: 1, group: 'consistency' },
  { id: 'C12', defect: 'D-11', name: 'rls-policies', tier: 2, group: 'data' },
  { id: 'C13', defect: 'D-14', name: 'journey-fr-linkage', tier: 3, group: 'ux' },
  { id: 'C14', defect: 'D-15', name: 'readiness-audit-ingest', tier: 3, group: 'readiness' },
  { id: 'C15', defect: 'D-9', name: 'story-tracker-census', tier: 1, group: 'population' },
  // v0.26 — planning-quality gates (close Meru incident class)
  { id: 'C16', defect: 'D-16', name: 'counts-reconcile', tier: 1, group: 'population' },
  { id: 'C17', defect: 'D-17', name: 'trace-tag-coverage', tier: 1, group: 'rtm' },
  { id: 'C18', defect: 'D-18', name: 'feature-registry-schema', tier: 1, group: 'features' },
  { id: 'C19', defect: 'D-19', name: 'rtm-mapped-without-ac', tier: 1, group: 'rtm' },
  // v0.28 — post-v0.26 incident class (AC quality, UX depth, ID grammar, TR parity, semantic coverage)
  { id: 'C20', defect: 'D-20', name: 'rtm-ac-executability', tier: 1, group: 'rtm' },
  { id: 'C21', defect: 'D-21', name: 'ux-spec-completeness', tier: 1, group: 'ux' },
  { id: 'C22', defect: 'D-22', name: 'source-semantic-coverage', tier: 2, group: 'rtm' },
  { id: 'C23', defect: 'D-23', name: 'tr-coverage-evenness', tier: 1, group: 'rtm' },
];

// ── helpers ─────────────────────────────────────────────────────────────

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function getFlag(args, flag, fallback = null) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

function emitFinding(findings, contract, severity, detail) {
  findings.push({
    contractId: contract.id,
    defect: contract.defect,
    name: contract.name,
    tier: contract.tier,
    group: contract.group,
    severity,
    detail,
  });
}

// ── contract implementations ───────────────────────────────────────────

function contractStoryTrackerShape(ctx, findings) {
  const contract = ctx.contract('C1');
  const trackerPath = path.join(ctx.planningDir, 'story-tracker.json');
  if (!fs.existsSync(trackerPath)) {
    emitFinding(findings, contract, 'block', `story-tracker.json not found at ${trackerPath}`);
    return;
  }
  const tracker = readJson(trackerPath);
  if (!tracker || typeof tracker !== 'object') {
    emitFinding(findings, contract, 'block', 'story-tracker.json is not valid JSON');
    return;
  }
  if (!Array.isArray(tracker.stories)) {
    emitFinding(
      findings,
      contract,
      'block',
      `story-tracker.json has .stories as ${Array.isArray(tracker.stories) ? 'array' : typeof tracker.stories} — expected array. D-8 shape mismatch.`,
    );
  }
}

function contractMilestoneStoryCount(ctx, findings) {
  const contract = ctx.contract('C2');
  const mt = readJson(path.join(ctx.planningDir, 'milestone-tracker.json'));
  const st = readJson(path.join(ctx.planningDir, 'story-tracker.json'));
  if (!mt || !Array.isArray(mt.milestones)) {
    emitFinding(findings, contract, 'block', 'milestone-tracker.json missing or malformed');
    return;
  }
  const stories = canonicalTrackerStories(st?.stories);
  const storiesByMilestone = new Map();
  for (const story of stories) {
    const ms = story?.milestone;
    if (!ms) continue;
    storiesByMilestone.set(ms, (storiesByMilestone.get(ms) || 0) + 1);
  }

  for (const ms of mt.milestones) {
    const epicCount = Number(ms.epicCount ?? 0);
    const declared = Number(ms.storyCount ?? 0);
    const actual = storiesByMilestone.get(ms.id) || 0;

    if (epicCount > 0 && declared === 0 && actual === 0) {
      emitFinding(
        findings,
        contract,
        'block',
        `milestone ${ms.id} has ${epicCount} epic(s) but storyCount is 0 and no stories reference it in story-tracker`,
      );
      continue;
    }
    if (declared !== actual) {
      emitFinding(
        findings,
        contract,
        'warn',
        `milestone ${ms.id} storyCount=${declared} but ${actual} stories reference it in story-tracker`,
      );
    }
  }
}

function contractStoryTaskCount(ctx, findings) {
  const contract = ctx.contract('C3');
  const st = readJson(path.join(ctx.planningDir, 'story-tracker.json'));
  if (!st || !Array.isArray(st.stories)) return;
  for (const story of st.stories) {
    const tasks = Array.isArray(story?.tasks) ? story.tasks : [];
    const declared = Number(story?.taskCount ?? 0);
    if (declared !== tasks.length) {
      emitFinding(
        findings,
        contract,
        'warn',
        `story ${story.id} taskCount=${declared} but tasks.length=${tasks.length}`,
      );
    }
  }
}

function contractRtmStoryLinkage(ctx, findings) {
  const contract = ctx.contract('C4');
  const rtm = readJson(path.join(ctx.planningDir, 'rtm.json'));
  const st = readJson(path.join(ctx.planningDir, 'story-tracker.json'));
  if (!rtm?.requirements) {
    emitFinding(findings, contract, 'block', 'rtm.json missing or malformed');
    return;
  }
  const stories = Array.isArray(st?.stories) ? st.stories : [];

  // Build reverse index: requirementId -> [stories]
  const storiesByReq = new Map();
  for (const story of stories) {
    const allReqs = [
      ...(story.requirementIds || []),
      ...(story.frIds || []),
      ...(story.nfrIds || []),
      ...(story.trIds || []),
      ...(story.irIds || []),
    ];
    for (const reqId of allReqs) {
      const key = String(reqId).toUpperCase();
      if (!storiesByReq.has(key)) storiesByReq.set(key, []);
      storiesByReq.get(key).push(story.id);
    }
  }

  let orphans = 0;
  let totalMapped = 0;
  for (const [reqId, req] of Object.entries(rtm.requirements)) {
    const isMapped = ['mapped', 'coded', 'tested', 'covered'].includes(req?.status);
    if (!isMapped) continue;
    totalMapped += 1;
    const declaredStories = Array.isArray(req.stories) ? req.stories : [];
    const expectedStories = storiesByReq.get(String(reqId).toUpperCase()) || [];

    if (expectedStories.length > 0 && declaredStories.length === 0) {
      orphans += 1;
      if (orphans <= 10) {
        emitFinding(
          findings,
          contract,
          'block',
          `rtm ${reqId} has status=${req.status} but .stories is empty — story-tracker links ${expectedStories.length} stories (${expectedStories.slice(0, 3).join(', ')})`,
        );
      }
    }
  }
  if (orphans > 10) {
    emitFinding(
      findings,
      contract,
      'block',
      `... and ${orphans - 10} more requirements with empty .stories despite story-tracker linkage`,
    );
  }

  // AC linkage: every FR with status=mapped should have non-empty acceptance_criteria
  let missingAc = 0;
  for (const [, req] of Object.entries(rtm.requirements)) {
    if (!['mapped', 'coded', 'tested', 'covered'].includes(req?.status)) continue;
    if (!Array.isArray(req.acceptance_criteria) || req.acceptance_criteria.length === 0) {
      missingAc += 1;
    }
  }
  if (missingAc > 0 && totalMapped > 0) {
    const ratio = missingAc / totalMapped;
    if (ratio > 0.5) {
      emitFinding(
        findings,
        contract,
        'block',
        `${missingAc} of ${totalMapped} mapped requirements have empty acceptance_criteria (${(ratio * 100).toFixed(0)}% — threshold 50%). D-1 AC backfill missing.`,
      );
    } else if (missingAc > 0) {
      emitFinding(
        findings,
        contract,
        'warn',
        `${missingAc} of ${totalMapped} mapped requirements have empty acceptance_criteria`,
      );
    }
  }
}

function contractSpecCoverage(ctx, findings) {
  const contract = ctx.contract('C5');
  const st = readJson(path.join(ctx.planningDir, 'story-tracker.json'));
  const specsDir = path.join(ctx.planningDir, 'story-specs');
  if (!st || !Array.isArray(st.stories)) return;
  if (!fs.existsSync(specsDir)) {
    emitFinding(findings, contract, 'warn', `story-specs directory not found at ${specsDir}`);
    return;
  }
  const specFiles = fs.readdirSync(specsDir).filter((f) => f.endsWith('-impl-spec.md'));
  const specIds = new Set(specFiles.map((f) => normalizeStoryId(f.replace('-impl-spec.md', ''))));
  const storyIds = st.stories.map((s) => normalizeStoryId(s.id));
  const missing = storyIds.filter((id) => id && !specIds.has(id));
  const ratio = storyIds.length > 0 ? (storyIds.length - missing.length) / storyIds.length : 1;
  const threshold = Number(ctx.options.specThreshold ?? 1.0);
  if (ratio < threshold) {
    const severity = ratio < 0.5 ? 'block' : 'warn';
    emitFinding(
      findings,
      contract,
      severity,
      `story-spec coverage ${(ratio * 100).toFixed(0)}% (${storyIds.length - missing.length}/${storyIds.length}); threshold ${(threshold * 100).toFixed(0)}%. Missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` …+${missing.length - 5} more` : ''}`,
    );
  }
}

function contractDiagramStubs(ctx, findings) {
  const contract = ctx.contract('C6');
  const diagramsRoot = findDiagramsRoot(ctx);
  if (!diagramsRoot) return; // no diagrams in this run
  const mermaidDir = path.join(diagramsRoot, 'mermaid');
  if (!fs.existsSync(mermaidDir)) return;
  const stubs = [];
  for (const file of fs.readdirSync(mermaidDir)) {
    if (!file.endsWith('.mmd')) continue;
    const content = fs.readFileSync(path.join(mermaidDir, file), 'utf8');
    if (/No nodes — see gap report/i.test(content) || content.length < 400) {
      stubs.push({ file, size: content.length });
    }
  }
  const graphPath = path.join(diagramsRoot, 'architecture-graph.json');
  const graph = readJson(graphPath);
  const realNodes = Array.isArray(graph?.nodes) ? graph.nodes.length : 0;
  if (stubs.length > 0 && realNodes >= 5) {
    emitFinding(
      findings,
      contract,
      'block',
      `${stubs.length} mermaid diagram(s) are placeholder stubs despite architecture-graph.json having ${realNodes} real nodes: ${stubs
        .slice(0, 3)
        .map((s) => `${s.file}(${s.size}b)`)
        .join(', ')}`,
    );
  }
}

// v0.28: kind-aware edge enforcement. Some diagram kinds (context, capability-map,
// governance-map, cost-topology, risk-map) legitimately have zero edges; they are
// taxonomy/attribute views. Kinds listed here MUST have edges when nodeCount >= 5
// because their semantic is relationships, not enumeration.
const EDGE_REQUIRED_KINDS = new Set([
  'c4-container',
  'c4-component',
  'data-flow',
  'value-stream',
  'api-map',
  'runtime-topology',
  'observability-map',
  'identity-flow',
  'erd',
  'component-map',
  'domain-map',
  'sequence',
  'deployment',
]);

function contractDiagramEdges(ctx, findings) {
  const contract = ctx.contract('C7');
  const manifestPath = findDiagramManifest(ctx);
  if (!manifestPath) return;
  const manifest = readJson(manifestPath);
  if (!manifest || !Array.isArray(manifest.diagrams)) return;

  const offenders = manifest.diagrams.filter((d) => {
    const edges = typeof d.edgeCount === 'number' ? d.edgeCount : 0;
    const nodes = typeof d.nodeCount === 'number' ? d.nodeCount : 0;
    const kind = (d.kind || '').toLowerCase();
    // Block only when kind REQUIRES edges and graph has >=5 nodes with zero edges.
    return edges === 0 && nodes >= 5 && EDGE_REQUIRED_KINDS.has(kind);
  });

  if (offenders.length > 0) {
    emitFinding(
      findings,
      contract,
      'block',
      `${offenders.length} edge-required diagram(s) have no edges: ${offenders
        .slice(0, 5)
        .map((d) => `${d.id || d.name}(${d.kind})`)
        .join(', ')}. D-6.`,
    );
  }

  // Secondary advisory: any remaining zero-edge diagrams outside the required
  // kind list — still useful to know but not a hard fail.
  const softZero = manifest.diagrams.filter(
    (d) =>
      typeof d.edgeCount === 'number' &&
      d.edgeCount === 0 &&
      (d.nodeCount || 0) >= 5 &&
      !EDGE_REQUIRED_KINDS.has((d.kind || '').toLowerCase()),
  );
  if (softZero.length >= 3) {
    emitFinding(
      findings,
      contract,
      'warn',
      `${softZero.length} non-edge-required diagrams have no edges (advisory only): ${softZero
        .slice(0, 3)
        .map((d) => `${d.id || d.name}(${d.kind || 'unknown'})`)
        .join(', ')}.`,
    );
  }
}

function contractDiagramDuplicates(ctx, findings) {
  const contract = ctx.contract('C8');
  const diagramsRoot = findDiagramsRoot(ctx);
  if (!diagramsRoot) return;
  const specsDir = path.join(diagramsRoot, 'specs');
  if (!fs.existsSync(specsDir)) return;

  // v0.28: group by (kind, signature). Two diagrams of the SAME kind with
  // identical nodes = unintentional duplication (block). Different kinds
  // sharing nodes = expected hierarchy (e.g., c4-context nodes nest under
  // c4-container) and is ignored.
  const byKind = new Map();
  for (const file of fs.readdirSync(specsDir)) {
    if (!file.endsWith('.json')) continue;
    const spec = readJson(path.join(specsDir, file));
    if (!spec || !Array.isArray(spec.nodes)) continue;
    const sig = spec.nodes
      .map((n) => n.id)
      .sort()
      .join(',');
    if (!sig || spec.nodes.length < 5) continue;
    const kind = (spec.kind || 'unknown').toLowerCase();
    const key = `${kind}::${sig}`;
    if (!byKind.has(key)) byKind.set(key, { kind, sig, names: [] });
    byKind.get(key).names.push(file.replace('.json', ''));
  }
  for (const { kind, sig, names } of byKind.values()) {
    if (names.length >= 2) {
      emitFinding(
        findings,
        contract,
        'block',
        `${names.length} ${kind} diagrams share identical node set (${sig.split(',').length} nodes): ${names.join(', ')} — unintentional duplication (D-7)`,
      );
    }
  }
}

function contractVersionSnapshots(ctx, findings) {
  const contract = ctx.contract('C9');
  const versionsDir = path.join(ctx.planningDir, '_versions');
  const phaseArtifacts = ['prd.md', 'trd.md', 'architecture.md', 'ux-design-specification.md', 'data-model-spec.md'];
  const missing = [];
  for (const phase of phaseArtifacts) {
    const artifactPath = path.join(ctx.planningDir, phase);
    if (!fs.existsSync(artifactPath)) continue;
    if (!fs.existsSync(versionsDir)) {
      missing.push(phase);
      continue;
    }
    const versioned = fs.readdirSync(versionsDir).some((f) => f.includes(phase.replace('.md', '')));
    if (!versioned) missing.push(phase);
  }
  if (missing.length > 0) {
    emitFinding(
      findings,
      contract,
      'warn',
      `${missing.length} phase artifact(s) lack a snapshot in _versions/: ${missing.join(', ')}. D-10.`,
    );
  }
}

function contractCapabilityGraphMerge(ctx, findings) {
  const contract = ctx.contract('C10');
  const capabilityGraphPath = path.join(ctx.planningDir, 'capability-graph.json');
  const diagramsRoot = findDiagramsRoot(ctx);
  if (!fs.existsSync(capabilityGraphPath) || !diagramsRoot) return;
  const capGraph = readJson(capabilityGraphPath);
  const archGraph = readJson(path.join(diagramsRoot, 'architecture-graph.json'));
  if (!capGraph || !archGraph) return;
  const capEdges = Array.isArray(capGraph.edges) ? capGraph.edges : [];
  if (capEdges.length === 0) return;
  const archNodes = new Set((archGraph.nodes || []).map((n) => String(n.id || n.name)));
  const overlap = capEdges.filter(
    (e) => archNodes.has(String(e.from || e.source)) || archNodes.has(String(e.to || e.target)),
  ).length;
  const ratio = overlap / capEdges.length;
  if (ratio < 0.2 && capEdges.length >= 5) {
    emitFinding(
      findings,
      contract,
      'warn',
      `capability-graph has ${capEdges.length} edges but only ${overlap} touch architecture-graph nodes (${(ratio * 100).toFixed(0)}%). D-12 disjoint graphs.`,
    );
  }
}

function contractEpicIdConsistency(ctx, findings) {
  const contract = ctx.contract('C11');
  const epicsMd = readFile(path.join(ctx.planningDir, 'epics.md'));
  const st = readJson(path.join(ctx.planningDir, 'story-tracker.json'));
  const mt = readJson(path.join(ctx.planningDir, 'milestone-tracker.json'));
  const rtm = readJson(path.join(ctx.planningDir, 'rtm.json'));
  if (!epicsMd) return;
  const epicIds = new Set([...epicsMd.matchAll(/^##\s+(?:Epic\s+)?(E[A-Z0-9_]+)\b/gim)].map((m) => m[1].toUpperCase()));
  const storyTrackerEpics = new Set(
    canonicalTrackerStories(st?.stories)
      .map((story) => String(story.epic || '').toUpperCase())
      .filter(Boolean),
  );
  const rtmEpics = new Set(
    rtm?.requirements
      ? Object.values(rtm.requirements)
          .map((r) => String(r.epic || '').toUpperCase())
          .filter(Boolean)
      : [],
  );

  const orphansInTracker = [...storyTrackerEpics].filter((e) => !epicIds.has(e));
  const orphansInRtm = [...rtmEpics].filter((e) => !epicIds.has(e));

  if (orphansInTracker.length > 0) {
    emitFinding(
      findings,
      contract,
      'block',
      `story-tracker references epic IDs not in epics.md: ${orphansInTracker.join(', ')} (D-13 rename not propagated)`,
    );
  }
  if (orphansInRtm.length > 0) {
    emitFinding(
      findings,
      contract,
      'block',
      `rtm.json references epic IDs not in epics.md: ${orphansInRtm.join(', ')} (D-13 rename not propagated)`,
    );
  }
  if (mt) {
    const msEpicRefs = new Set(
      (Array.isArray(mt.milestones) ? mt.milestones : []).flatMap((m) =>
        (m.epics || []).map((e) => String(e).toUpperCase()),
      ),
    );
    const orphansInMs = [...msEpicRefs].filter((e) => !epicIds.has(e));
    if (orphansInMs.length > 0) {
      emitFinding(
        findings,
        contract,
        'block',
        `milestone-tracker references epic IDs not in epics.md: ${orphansInMs.join(', ')}`,
      );
    }
  }
}

function contractRlsPolicies(ctx, findings) {
  const contract = ctx.contract('C12');
  const dataModelPath = path.join(ctx.planningDir, 'data-model-spec.md');
  const prdPath = path.join(ctx.planningDir, 'prd.md');
  if (!fs.existsSync(dataModelPath)) return;
  const dataModel = fs.readFileSync(dataModelPath, 'utf8');
  const prd = fs.existsSync(prdPath) ? fs.readFileSync(prdPath, 'utf8') : '';
  const rlsRequired =
    /row[-\s]?level\s+security|RLS\b/i.test(prd) || /row[-\s]?level\s+security|RLS\b/i.test(dataModel);
  if (!rlsRequired) return;
  if (!/CREATE\s+POLICY/i.test(dataModel)) {
    emitFinding(
      findings,
      contract,
      'warn',
      'RLS declared as NFR but data-model-spec.md contains no CREATE POLICY statements (D-11)',
    );
  }
}

function contractJourneyFrLinkage(ctx, findings) {
  const contract = ctx.contract('C13');
  const journeyPath = path.join(ctx.planningDir, 'user-journeys.md');
  if (!fs.existsSync(journeyPath)) return;
  const content = fs.readFileSync(journeyPath, 'utf8');
  const journeyHeaders = [...content.matchAll(/^###\s+(?:Journey\s+)?(.+)$/gim)];
  if (journeyHeaders.length === 0) return;
  const frHits = content.match(/\bFR-\d+\b/gi) || [];
  const ratio = frHits.length / journeyHeaders.length;
  if (ratio < 1) {
    emitFinding(
      findings,
      contract,
      'warn',
      `user-journeys.md has ${journeyHeaders.length} journey(s) but only ${frHits.length} FR reference(s) — some journeys lack FR linkage (D-14)`,
    );
  }
}

function contractReadinessAuditIngest(ctx, findings) {
  const contract = ctx.contract('C14');
  const readinessPath = path.join(ctx.planningDir, 'release-readiness-checklist.md');
  if (!fs.existsSync(readinessPath)) return;
  const content = fs.readFileSync(readinessPath, 'utf8');
  if (!/_cobolt-output\/audit|\/audit\//i.test(content) && !/audit (trail|events|ledger)/i.test(content)) {
    emitFinding(
      findings,
      contract,
      'warn',
      'release-readiness-checklist.md does not surface audit artifacts (_cobolt-output/audit/). D-15.',
    );
  }
}

// ── v0.26 contracts ─────────────────────────────────────────────────────

function contractCountsReconcile(ctx, findings) {
  const contract = ctx.contract('C16');
  const epicsPath = path.join(ctx.planningDir, 'epics.md');
  const trackerPath = path.join(ctx.planningDir, 'story-tracker.json');
  const msPath = path.join(ctx.planningDir, 'milestones.md');
  if (!fs.existsSync(epicsPath) || !fs.existsSync(trackerPath) || !fs.existsSync(msPath)) return;

  const epicText = readFile(epicsPath) || '';
  const epicIds = new Set([...epicText.matchAll(/^#{1,4}\s+E(\d+)[\s:—–-]/gm)].map((m) => `E${parseInt(m[1], 10)}`));
  const tracker = readJson(trackerPath);
  const stories = Array.isArray(tracker?.stories) ? tracker.stories : [];
  const msText = readFile(msPath) || '';

  const totalRow = msText.match(/\|\s*\*?\*?Total\*?\*?\s*\|([^|]+)\|([^|]+)\|/i);
  let declaredEpics = null;
  let declaredStories = null;
  if (totalRow) {
    const nums = [totalRow[1], totalRow[2]]
      .map((s) => parseInt(String(s).match(/\d+/)?.[0] ?? '', 10))
      .filter((n) => Number.isFinite(n));
    if (nums.length >= 2) {
      declaredEpics = nums[0];
      declaredStories = nums[1];
    }
  } else {
    const prose = msText.match(/(\d+)\s+epics?\s*(?:->|→|and|,)\s*(\d+)\s+stor(?:y|ies)/i);
    if (prose) {
      declaredEpics = parseInt(prose[1], 10);
      declaredStories = parseInt(prose[2], 10);
    }
  }

  if (declaredEpics != null && declaredEpics !== epicIds.size) {
    emitFinding(
      findings,
      contract,
      'block',
      `milestones.md declares ${declaredEpics} epics but epics.md contains ${epicIds.size}`,
    );
  }
  if (declaredStories != null && declaredStories !== stories.length) {
    emitFinding(
      findings,
      contract,
      'block',
      `milestones.md declares ${declaredStories} stories but story-tracker.json contains ${stories.length}`,
    );
  }
}

function contractTraceTagCoverage(ctx, findings) {
  const contract = ctx.contract('C17');
  const rtmPath = path.join(ctx.planningDir, 'rtm.json');
  const rtm = readJson(rtmPath);
  if (!rtm?.requirements) return;

  const downstream = [
    'system-architecture.md',
    'architecture.md',
    'api-contracts.md',
    'ux-design-specification.md',
    'data-model-spec.md',
    'data-model.md',
    'epics.md',
  ];
  const cited = new Set();
  const requirements = Object.values(rtm.requirements || {});
  for (const name of downstream) {
    const fp = path.join(ctx.planningDir, name);
    if (!fs.existsSync(fp)) continue;
    const text = readFile(fp) || '';
    for (const citedRequirementId of collectRequirementCitations(text, requirements)) cited.add(citedRequirementId);
  }

  const advanced = new Set(['mapped', 'coded', 'tested', 'covered']);
  const uncited = Object.values(rtm.requirements)
    .filter((r) => advanced.has(r.status))
    .filter((r) => !cited.has(r.id))
    .map((r) => r.id);
  if (uncited.length > 0) {
    emitFinding(
      findings,
      contract,
      'block',
      `${uncited.length} advanced-status requirement(s) uncited in downstream artifacts: ${uncited.slice(0, 5).join(', ')}${uncited.length > 5 ? '...' : ''}`,
    );
  }
}

function escapeRegex(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectRequirementCitations(text, requirements) {
  const cited = [];
  for (const requirement of requirements || []) {
    const candidateIds = [...new Set([requirement.id, requirement.canonicalId].filter(Boolean))];
    for (const candidateId of candidateIds) {
      const pattern = new RegExp(`\\b${escapeRegex(candidateId)}\\b`);
      if (pattern.test(text)) {
        cited.push(requirement.id);
        break;
      }
    }
  }
  return cited;
}

function requirementTypeBucket(requirement) {
  switch (requirement?.type) {
    case 'functional':
      return 'FR';
    case 'non-functional':
      return 'NFR';
    case 'technical':
      return 'TR';
    case 'implicit':
      return 'IR';
    default:
      return null;
  }
}

function contractFeatureRegistrySchema(ctx, findings) {
  const contract = ctx.contract('C18');
  const fp = path.join(ctx.planningDir, 'feature-registry.json');
  if (!fs.existsSync(fp)) return;
  const data = readJson(fp);
  if (!data) {
    emitFinding(findings, contract, 'block', 'feature-registry.json present but unparseable');
    return;
  }
  if (!Array.isArray(data.features)) {
    emitFinding(findings, contract, 'block', 'feature-registry.json missing features[] array');
    return;
  }
  if (typeof data.totalFeatures === 'number' && data.totalFeatures !== data.features.length) {
    emitFinding(
      findings,
      contract,
      'block',
      `feature-registry.json totalFeatures=${data.totalFeatures} but features.length=${data.features.length}`,
    );
  }
  const forbidden = ['srcIds', 'prdRefs', 'srcIDs'];
  const offenders = [];
  data.features.forEach((f, i) => {
    for (const field of forbidden) {
      if (f[field] !== undefined) offenders.push(`feature[${i}].${field}`);
    }
  });
  if (offenders.length > 0) {
    emitFinding(
      findings,
      contract,
      'block',
      `feature-registry.json uses forbidden field names (use sourceIds/requirementIds): ${offenders.slice(0, 5).join(', ')}`,
    );
  }
}

// ── v0.28 contracts ─────────────────────────────────────────────────────

function contractRtmAcExecutability(ctx, findings) {
  const contract = ctx.contract('C20');
  const rtmPath = path.join(ctx.planningDir, 'rtm.json');
  const rtm = readJson(rtmPath);
  if (!rtm?.requirements) return;
  const advanced = new Set(['mapped', 'coded', 'tested', 'covered']);
  const EXEC = [
    /\b(given|when|then|and|but)\b/i,
    /\b(must|may|should|shall)(?:\s+not)?\b/i,
    /\b(verify|assert|check|expect|ensure|validate|require)s?\b/i,
    /\b\d+\s*(?:ms|s|min|%|rps|req\/s|mb|gb|kb|req)\b/i,
  ];
  const STUB = [/^tbd$/i, /^todo$/i, /^n\/a$/i, /^(the\s+)?feature\s+works$/i];
  const offenders = [];
  for (const reqId of Object.keys(rtm.requirements)) {
    const req = rtm.requirements[reqId];
    if (!advanced.has(req.status)) continue;
    const acs = Array.isArray(req.acceptance_criteria) ? req.acceptance_criteria : [];
    for (let i = 0; i < acs.length; i++) {
      const s = String(acs[i] || '').trim();
      if (s.length < 20 || STUB.some((r) => r.test(s)) || !EXEC.some((r) => r.test(s))) {
        offenders.push(`${reqId}[${i}]`);
        break;
      }
    }
  }
  if (offenders.length > 0) {
    emitFinding(
      findings,
      contract,
      'block',
      `${offenders.length} advanced-status requirement(s) have non-executable AC: ${offenders.slice(0, 5).join(', ')}${offenders.length > 5 ? '...' : ''}`,
    );
  }
}

function contractUxSpecCompleteness(ctx, findings) {
  const contract = ctx.contract('C21');
  const candidates = ['ux-design-specification.md', 'ux-design.md', path.join('ux', 'ux-design-specification.md')];
  let found = null;
  for (const c of candidates) {
    const fp = path.join(ctx.planningDir, c);
    if (fs.existsSync(fp)) {
      found = fp;
      break;
    }
  }
  if (!found) return;
  const text = readFile(found) || '';
  const REQUIRED = [
    { label: 'State Matrix', patterns: [/state matrix/i, /component states?/i] },
    { label: 'Data Binding Map', patterns: [/data binding/i, /field(?:\s+to\s+source)?\s+mapping/i] },
    { label: 'Error Content Specification', patterns: [/error content/i, /error messag(?:e|ing)/i] },
    {
      label: 'Interaction Timing',
      patterns: [/interaction timing/i, /animation (?:timing|spec)/i, /motion (?:spec|tokens?)/i],
    },
    {
      label: 'Responsive Collapse Strategy',
      patterns: [/responsive (?:collapse|strategy|behavior)/i, /breakpoint(?:s|\s+behavior)?/i],
    },
  ];
  const sections = text.split(/^##\s+/m).slice(1);
  const headings = sections.map((s) => s.split(/\r?\n/)[0].trim());
  const missing = REQUIRED.filter((r) => !headings.some((h) => r.patterns.some((re) => re.test(h))));
  if (missing.length > 0) {
    emitFinding(
      findings,
      contract,
      'block',
      `ux-design-specification.md missing required sections: ${missing.map((m) => m.label).join(', ')}`,
    );
  }
}

function contractSourceSemanticCoverage(ctx, findings) {
  const contract = ctx.contract('C22');
  // Tier 2 — detects citation-only SRC-* entries. Implemented inline as a
  // lightweight overlap check; full tool is tools/cobolt-source-semantic-coverage.js.
  const srcFp = path.join(ctx.planningDir, 'source-document-consolidation.md');
  if (!fs.existsSync(srcFp)) return;
  const text = readFile(srcFp) || '';
  const STOP = new Set([
    'the',
    'a',
    'an',
    'of',
    'for',
    'in',
    'on',
    'at',
    'by',
    'to',
    'from',
    'with',
    'and',
    'or',
    'is',
    'are',
    'be',
    'feature',
    'requirement',
    'system',
    'user',
    'users',
    'screen',
    'page',
    'flow',
    'data',
    'api',
    'service',
    'this',
    'that',
    'these',
    'those',
  ]);
  const tokenize = (t) => {
    if (!t) return new Set();
    const w = t.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];
    return new Set(w.filter((x) => !STOP.has(x)));
  };
  const entryRe = /^(?:#{1,4}\s+|[-*+]\s+)?\**\s*(SRC-[A-Z0-9-]+)\s*\**\s*[:\u2013\u2014|-]\s*(.+?)\s*$/gim;
  const entries = [];
  for (const m of text.matchAll(entryRe)) {
    if (!entries.find((e) => e.id === m[1].toUpperCase()))
      entries.push({ id: m[1].toUpperCase(), intent: m[2].trim() });
  }
  const downstream = ['epics.md', 'prd.md'];
  const bag = downstream.map((n) => readFile(path.join(ctx.planningDir, n)) || '').join('\n');
  const citationOnly = [];
  for (const e of entries) {
    if (!e.intent || e.intent.length < 20) continue;
    if (!bag.includes(e.id)) continue;
    const src = tokenize(e.intent);
    const dst = tokenize(bag);
    let overlap = 0;
    for (const t of src) if (dst.has(t)) overlap++;
    if (overlap < 3) citationOnly.push(`${e.id}(${overlap})`);
  }
  if (citationOnly.length > 0) {
    emitFinding(
      findings,
      contract,
      'warn',
      `${citationOnly.length} SRC entries appear citation-only in epics/prd (overlap<3 terms): ${citationOnly.slice(0, 5).join(', ')}`,
    );
  }
}

function contractTrCoverageEvenness(ctx, findings) {
  const contract = ctx.contract('C23');
  const rtmPath = path.join(ctx.planningDir, 'rtm.json');
  const rtm = readJson(rtmPath);
  if (!rtm?.requirements) return;

  const downstream = [
    'system-architecture.md',
    'architecture.md',
    'api-contracts.md',
    'ux-design-specification.md',
    'data-model-spec.md',
    'epics.md',
  ];
  const requirements = Object.values(rtm.requirements || {});
  const cited = new Set();
  for (const name of downstream) {
    const fp = path.join(ctx.planningDir, name);
    if (!fs.existsSync(fp)) continue;
    const text = readFile(fp) || '';
    for (const citedRequirementId of collectRequirementCitations(text, requirements)) cited.add(citedRequirementId);
  }

  const byType = {
    FR: { total: 0, cited: 0 },
    NFR: { total: 0, cited: 0 },
    TR: { total: 0, cited: 0 },
    IR: { total: 0, cited: 0 },
  };
  const advanced = new Set(['mapped', 'coded', 'tested', 'covered']);
  for (const req of requirements) {
    if (!advanced.has(req.status)) continue;
    const prefix = requirementTypeBucket(req);
    if (!byType[prefix]) continue;
    byType[prefix].total++;
    if (cited.has(req.id)) byType[prefix].cited++;
  }
  const pct = (t) => (t.total === 0 ? 100 : Math.round((t.cited / t.total) * 1000) / 10);
  const frPct = pct(byType.FR);
  const nfrPct = pct(byType.NFR);
  const trPct = pct(byType.TR);

  const offenders = [];
  // TR coverage must not trail FR by more than 25pp when TR.total > 0
  if (byType.TR.total > 0 && frPct - trPct > 25) {
    offenders.push(`TR ${trPct}% vs FR ${frPct}% (gap ${Math.round(frPct - trPct)}pp)`);
  }
  // NFR coverage must not trail FR by more than 20pp when NFR.total > 0
  if (byType.NFR.total > 0 && frPct - nfrPct > 20) {
    offenders.push(`NFR ${nfrPct}% vs FR ${frPct}% (gap ${Math.round(frPct - nfrPct)}pp)`);
  }
  if (offenders.length > 0) {
    emitFinding(
      findings,
      contract,
      'block',
      `coverage evenness violated: ${offenders.join('; ')}. Some requirement types are significantly under-cited in downstream artifacts.`,
    );
  }
}

function contractRtmMappedWithoutAc(ctx, findings) {
  const contract = ctx.contract('C19');
  const rtmPath = path.join(ctx.planningDir, 'rtm.json');
  const rtm = readJson(rtmPath);
  if (!rtm?.requirements) return;
  const advanced = new Set(['mapped', 'coded', 'tested', 'covered']);
  const offenders = Object.values(rtm.requirements)
    .filter((r) => advanced.has(r.status))
    .filter((r) => !Array.isArray(r.acceptance_criteria) || r.acceptance_criteria.length === 0)
    .map((r) => r.id);
  if (offenders.length > 0) {
    emitFinding(
      findings,
      contract,
      'block',
      `${offenders.length} advanced requirement(s) with empty acceptance_criteria: ${offenders.slice(0, 5).join(', ')}${offenders.length > 5 ? '...' : ''}`,
    );
  }
}

function contractStoryTrackerCensus(ctx, findings) {
  const contract = ctx.contract('C15');
  const st = readJson(path.join(ctx.planningDir, 'story-tracker.json'));
  const storiesDir = path.join(ctx.planningDir, 'stories');
  if (!st || !Array.isArray(st.stories)) return;
  const declaredIds = new Set(st.stories.map((s) => normalizeStoryId(s.id)).filter(Boolean));
  if (!fs.existsSync(storiesDir)) return;
  const onDisk = [];
  for (const entry of fs.readdirSync(storiesDir)) {
    const m = entry.match(/^(?:story-)?(E[A-Z0-9_]+-S\d+)(?:[-_].+)?\.md$/i);
    if (!m) continue;
    const id = normalizeStoryId(m[1]);
    if (id) onDisk.push(id);
  }
  const missing = onDisk.filter((id) => !declaredIds.has(id));
  if (missing.length > 0) {
    emitFinding(
      findings,
      contract,
      'block',
      `${missing.length} story file(s) on disk are missing from story-tracker (D-9 regex class): ${missing.slice(0, 5).join(', ')}`,
    );
  }
}

// ── utilities ──────────────────────────────────────────────────────────

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function findDiagramsRoot(ctx) {
  const candidates = [
    path.join(ctx.projectRoot, '_cobolt-output', 'latest', 'architecture-diagrams', 'target'),
    path.join(ctx.planningDir, '..', 'architecture-diagrams', 'target'),
    path.join(ctx.projectRoot, '_cobolt-output', 'latest', 'architecture-diagrams'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function findDiagramManifest(ctx) {
  const diagramsRoot = findDiagramsRoot(ctx);
  if (!diagramsRoot) return null;
  const candidates = [
    path.join(diagramsRoot, 'diagram-manifest.json'),
    path.join(diagramsRoot, '..', 'diagram-manifest.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// ── orchestration ──────────────────────────────────────────────────────

const CONTRACT_RUNNERS = {
  C1: contractStoryTrackerShape,
  C2: contractMilestoneStoryCount,
  C3: contractStoryTaskCount,
  C4: contractRtmStoryLinkage,
  C5: contractSpecCoverage,
  C6: contractDiagramStubs,
  C7: contractDiagramEdges,
  C8: contractDiagramDuplicates,
  C9: contractVersionSnapshots,
  C10: contractCapabilityGraphMerge,
  C11: contractEpicIdConsistency,
  C12: contractRlsPolicies,
  C13: contractJourneyFrLinkage,
  C14: contractReadinessAuditIngest,
  C15: contractStoryTrackerCensus,
  C16: contractCountsReconcile,
  C17: contractTraceTagCoverage,
  C18: contractFeatureRegistrySchema,
  C19: contractRtmMappedWithoutAc,
  C20: contractRtmAcExecutability,
  C21: contractUxSpecCompleteness,
  C22: contractSourceSemanticCoverage,
  C23: contractTrCoverageEvenness,
};

function runCheck(args = []) {
  const projectRoot = process.cwd();
  const planningDir = getPlanningDir(projectRoot, { create: false });
  if (!planningDir || !fs.existsSync(planningDir)) {
    console.error('[cobolt-planning-integrity] planning/ directory not found; nothing to verify');
    process.exit(3);
  }

  const skip = new Set((getFlag(args, '--skip', '') || '').split(',').filter(Boolean));
  const tierCap = Number(getFlag(args, '--tier', '1'));
  const specThreshold = Number(getFlag(args, '--spec-threshold', '1.0'));
  const ctx = {
    projectRoot,
    planningDir,
    options: { specThreshold },
    contract(id) {
      return CONTRACT_CATALOG.find((c) => c.id === id);
    },
  };

  const findings = [];
  const executed = [];
  for (const contract of CONTRACT_CATALOG) {
    if (skip.has(contract.group) || skip.has(contract.name) || skip.has(contract.id)) continue;
    try {
      CONTRACT_RUNNERS[contract.id](ctx, findings);
      executed.push(contract.id);
    } catch (err) {
      emitFinding(findings, contract, 'error', `runner threw: ${err.message}`);
    }
  }

  const blocking = findings.filter((f) => f.severity === 'block' && f.tier <= tierCap);
  const warnings = findings.filter((f) => f.severity === 'warn');
  const errors = findings.filter((f) => f.severity === 'error');

  const report = {
    timestamp: new Date().toISOString(),
    planningDir,
    tierCap,
    executed,
    skipped: CONTRACT_CATALOG.map((c) => c.id).filter((id) => !executed.includes(id)),
    counts: {
      total: findings.length,
      block: blocking.length,
      warn: warnings.length,
      error: errors.length,
    },
    findings,
  };

  if (hasFlag(args, '--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `[cobolt-planning-integrity] ${report.counts.block} block, ${report.counts.warn} warn, ${report.counts.error} error`,
    );
    for (const f of findings) {
      console.log(`  [${f.severity.toUpperCase()}] ${f.contractId} (${f.defect} ${f.name}): ${f.detail}`);
    }
  }

  // Persist audit trail
  try {
    const auditDir = path.join(projectRoot, '_cobolt-output', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.appendFileSync(path.join(auditDir, 'planning-integrity.jsonl'), `${JSON.stringify(report)}\n`, 'utf8');
  } catch {
    /* audit trail best-effort */
  }

  if (blocking.length > 0) {
    process.exit(4);
  }
  if (warnings.length > 0 && hasFlag(args, '--strict')) {
    process.exit(2);
  }
  process.exit(0);
}

// ── CLI ────────────────────────────────────────────────────────────────

function main(argv) {
  const [, , command, ...rest] = argv;
  if (command === '--help' || command === '-h') {
    console.log(
      'Usage: cobolt-planning-integrity.js check [--json] [--strict] [--tier <1|2|3>] [--skip group1,group2] [--spec-threshold 0.8]',
    );
    console.log('       cobolt-planning-integrity.js contracts');
    process.exit(0);
  }
  if (command === 'check' || command === undefined) {
    return runCheck(rest);
  }
  if (command === 'contracts') {
    console.log(JSON.stringify(CONTRACT_CATALOG, null, 2));
    process.exit(0);
  }
  console.error(
    'Usage: cobolt-planning-integrity.js check [--json] [--strict] [--tier <1|2|3>] [--skip group1,group2] [--spec-threshold 0.8]',
  );
  console.error('       cobolt-planning-integrity.js contracts');
  process.exit(1);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = {
  CONTRACT_CATALOG,
  runCheck,
  contractStoryTrackerShape,
  contractMilestoneStoryCount,
  contractStoryTaskCount,
  contractRtmStoryLinkage,
  contractSpecCoverage,
  contractDiagramStubs,
  contractDiagramEdges,
  contractDiagramDuplicates,
  contractVersionSnapshots,
  contractCapabilityGraphMerge,
  contractEpicIdConsistency,
  contractRlsPolicies,
  contractJourneyFrLinkage,
  contractReadinessAuditIngest,
  contractStoryTrackerCensus,
};
