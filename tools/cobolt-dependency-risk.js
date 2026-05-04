#!/usr/bin/env node

// CoBolt dependency-risk analyzer (Ship 4, v0.54+).
//
// Tier 3 advisory analyzer over the existing cobolt-architecture-graph.js
// manifest. Computes per-node fan-in / fan-out / simple centrality, detects
// circular dependencies, missing cross-milestone interface contracts, and
// single-point-of-failure nodes. Per-milestone roll-up via
// milestone-surface-map.json (when available).
//
// Operates entirely over JSON. NO graph database. NO LLM. Deterministic.
//
// CLI:
//   node tools/cobolt-dependency-risk.js analyze [--json] [--target <root>]
//   node tools/cobolt-dependency-risk.js summary
//   node tools/cobolt-dependency-risk.js --help
//
// Exit codes (per tools/CLAUDE.md contract):
//   0 = success (analysis ran, output emitted)
//   1 = misuse / hard error
//   3 = missing infrastructure (architecture-graph.json absent — Phase 3
//       hasn't run yet, or arch was disabled)
//
// Bypass: COBOLT_PHASE_3_5=off (Tier 3 advisory; bypass logged to
// gate-skip-log.jsonl by the SKILL.md step). Bypassing only suppresses the
// step from running; the analyzer itself never blocks anything.

const fs = require('node:fs');
const path = require('node:path');

const { getPlanningDir } = require('../lib/cobolt-planning-artifacts');

const DEPENDENCY_EDGE_KINDS = new Set(['depends-on', 'flows-to', 'api-call', 'data-flow']);
const HIGH_FAN_IN_THRESHOLD = 5;
const HIGH_FAN_OUT_THRESHOLD = 5;
const HIGH_RISK_SCORE = 70;

function parseArgs(argv) {
  const out = { command: null, json: false, target: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === 'analyze' || arg === 'summary') {
      out.command = arg;
    } else if (arg === '--json') {
      out.json = true;
    } else if (arg === '--target') {
      out.target = argv[++i] || null;
    } else if (arg === '--help' || arg === '-h') {
      out.command = 'help';
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(
    [
      'cobolt-dependency-risk — analyze inter-milestone risk over the existing arch-graph',
      '',
      'Usage:',
      '  node tools/cobolt-dependency-risk.js analyze [--json] [--target <root>]',
      '  node tools/cobolt-dependency-risk.js summary',
      '',
      'Inputs (all optional — analyzer skips gracefully when absent):',
      '  _cobolt-output/latest/architecture-diagrams/graph/architecture-graph.json',
      '  _cobolt-output/latest/planning/milestone-surface-map.json',
      '  _cobolt-output/latest/planning/interface-contracts.json',
      '',
      'Output:',
      '  _cobolt-output/latest/planning/dependency-risk.json',
      '',
      'Detects:',
      '  - High fan-in / high fan-out nodes (blast radius)',
      '  - Circular dependencies',
      '  - Cross-milestone edges without interface contracts',
      '  - Per-milestone aggregated risk score',
      '',
      'Exit codes:',
      '  0  analysis ran and output emitted',
      '  1  misuse / hard error',
      '  3  no architecture-graph.json found (Phase 3 must run first)',
      '',
      'Bypass: COBOLT_PHASE_3_5=off (logged).',
      '',
    ].join('\n'),
  );
}

function readJsonMaybe(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function locateGraphManifest(projectRoot) {
  const candidates = [
    path.join(projectRoot, '_cobolt-output', 'latest', 'architecture-diagrams', 'graph', 'architecture-graph.json'),
    path.join(projectRoot, '_cobolt-output', 'latest', 'architecture-diagrams', 'architecture-graph.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// Returns { nodes: Map<id, node>, edges: Edge[], depEdges: Edge[] }.
function indexGraph(graph) {
  const nodes = new Map();
  for (const n of graph.nodes || []) {
    if (n?.id) nodes.set(n.id, n);
  }
  const edges = (graph.edges || []).filter((e) => e?.from && e.to);
  const depEdges = edges.filter((e) => DEPENDENCY_EDGE_KINDS.has(String(e.kind || '').toLowerCase()));
  return { nodes, edges, depEdges };
}

function fanCounts(depEdges) {
  const fanIn = new Map();
  const fanOut = new Map();
  for (const e of depEdges) {
    fanIn.set(e.to, (fanIn.get(e.to) || 0) + 1);
    fanOut.set(e.from, (fanOut.get(e.from) || 0) + 1);
  }
  return { fanIn, fanOut };
}

// Detect cycles via DFS with three-color marking.
function detectCircularDeps(depEdges, nodes) {
  const adj = new Map();
  for (const e of depEdges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.to);
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  for (const id of nodes.keys()) color.set(id, WHITE);

  const cycles = [];
  const stack = [];

  function visit(u) {
    color.set(u, GRAY);
    stack.push(u);
    const next = adj.get(u) || [];
    for (const v of next) {
      if (color.get(v) === GRAY) {
        // Cycle found — slice from first occurrence of v in stack.
        const idx = stack.indexOf(v);
        if (idx >= 0) {
          cycles.push([...stack.slice(idx), v]);
        }
      } else if (color.get(v) === WHITE) {
        visit(v);
      }
    }
    color.set(u, BLACK);
    stack.pop();
  }

  for (const id of nodes.keys()) {
    if (color.get(id) === WHITE) visit(id);
  }
  return cycles;
}

// Build a per-milestone roll-up from milestone-surface-map.json (when
// available). Falls back to flat (no per-milestone roll-up) when the map is
// missing.
function buildMilestoneAssignment(planningDir) {
  const map = planningDir ? readJsonMaybe(path.join(planningDir, 'milestone-surface-map.json')) : null;
  if (!map || !Array.isArray(map.milestones)) return null;
  const nodeToMilestone = new Map();
  for (const ms of map.milestones) {
    const id = ms?.id || ms?.milestoneId;
    if (!id) continue;
    const surfaces = ms?.surfaces || ms?.frBindings || {};
    // surfaces can be { screens: [...], apis: [...], workers: [...] } etc.
    if (Array.isArray(surfaces)) {
      for (const s of surfaces) if (typeof s === 'string') nodeToMilestone.set(s, id);
    } else if (typeof surfaces === 'object') {
      for (const key of Object.keys(surfaces)) {
        const arr = Array.isArray(surfaces[key]) ? surfaces[key] : [];
        for (const s of arr) {
          if (typeof s === 'string') nodeToMilestone.set(s, id);
          else if (s?.id) nodeToMilestone.set(s.id, id);
          else if (s?.surfaceId) nodeToMilestone.set(s.surfaceId, id);
        }
      }
    }
  }
  return nodeToMilestone;
}

function findCrossMilestoneEdgesWithoutContract(depEdges, nodeToMilestone, contracts) {
  if (!nodeToMilestone) return [];
  const declaredContracts = new Set();
  if (contracts) {
    const list = contracts.contracts || contracts.entries || (Array.isArray(contracts) ? contracts : []);
    for (const c of list) {
      const key = `${c?.from || c?.producer || ''}::${c?.to || c?.consumer || ''}`;
      if (key !== '::') declaredContracts.add(key);
    }
  }
  const out = [];
  for (const e of depEdges) {
    const fromMs = nodeToMilestone.get(e.from);
    const toMs = nodeToMilestone.get(e.to);
    if (fromMs && toMs && fromMs !== toMs) {
      const key = `${fromMs}::${toMs}`;
      if (!declaredContracts.has(key)) {
        out.push({ from: e.from, to: e.to, fromMilestone: fromMs, toMilestone: toMs, kind: e.kind });
      }
    }
  }
  return out;
}

function nodeRiskScore(node, fanIn, fanOut, isInCycle, isCrossMilestone) {
  // Simple bounded score 0-100 by stacking signals.
  let score = 0;
  if (fanIn >= HIGH_FAN_IN_THRESHOLD) score += 25;
  if (fanIn >= HIGH_FAN_IN_THRESHOLD * 2) score += 15;
  if (fanOut >= HIGH_FAN_OUT_THRESHOLD) score += 15;
  if (isInCycle) score += 25;
  if (isCrossMilestone) score += 10;
  if (node?.confidence === 'inferred' || node?.confidence === 'hypothetical') score += 10;
  return Math.min(100, score);
}

function analyze(options = {}) {
  const projectRoot = options.target || process.cwd();
  const graphPath = locateGraphManifest(projectRoot);
  if (!graphPath) {
    return {
      ok: false,
      skipped: true,
      reason: 'architecture-graph.json not found (Phase 3 has not produced one yet)',
    };
  }
  const graph = readJsonMaybe(graphPath);
  if (!graph) {
    return { ok: false, skipped: true, reason: 'architecture-graph.json is malformed or unreadable' };
  }

  const planningDir = getPlanningDir(projectRoot, { create: false, strict: false, fallbackToLatest: true });
  const interfaceContracts = planningDir ? readJsonMaybe(path.join(planningDir, 'interface-contracts.json')) : null;
  const nodeToMilestone = buildMilestoneAssignment(planningDir);

  const { nodes, edges, depEdges } = indexGraph(graph);
  const { fanIn, fanOut } = fanCounts(depEdges);
  const cycles = detectCircularDeps(depEdges, nodes);
  const cycleNodeSet = new Set();
  for (const cycle of cycles) for (const id of cycle) cycleNodeSet.add(id);
  const crossMilestoneOrphans = findCrossMilestoneEdgesWithoutContract(depEdges, nodeToMilestone, interfaceContracts);
  const crossNodeSet = new Set();
  for (const e of crossMilestoneOrphans) {
    crossNodeSet.add(e.from);
    crossNodeSet.add(e.to);
  }

  // Per-node risk
  const nodeRisks = [];
  for (const [id, node] of nodes.entries()) {
    const fi = fanIn.get(id) || 0;
    const fo = fanOut.get(id) || 0;
    const inCycle = cycleNodeSet.has(id);
    const isCross = crossNodeSet.has(id);
    const score = nodeRiskScore(node, fi, fo, inCycle, isCross);
    if (score > 0) {
      nodeRisks.push({
        id,
        type: node?.type || 'unknown',
        fanIn: fi,
        fanOut: fo,
        inCycle,
        crossMilestone: isCross,
        confidence: node?.confidence || null,
        riskScore: score,
        milestone: nodeToMilestone ? nodeToMilestone.get(id) || null : null,
      });
    }
  }
  nodeRisks.sort((a, b) => b.riskScore - a.riskScore);

  // Per-milestone roll-up
  const milestones = [];
  if (nodeToMilestone) {
    const byMs = new Map();
    for (const r of nodeRisks) {
      if (!r.milestone) continue;
      if (!byMs.has(r.milestone)) byMs.set(r.milestone, { id: r.milestone, nodes: [], maxScore: 0, totalScore: 0 });
      const bucket = byMs.get(r.milestone);
      bucket.nodes.push({ id: r.id, riskScore: r.riskScore });
      bucket.maxScore = Math.max(bucket.maxScore, r.riskScore);
      bucket.totalScore += r.riskScore;
    }
    for (const [, bucket] of byMs.entries()) {
      milestones.push({
        id: bucket.id,
        nodeCount: bucket.nodes.length,
        maxNodeRisk: bucket.maxScore,
        avgNodeRisk: Math.round(bucket.totalScore / bucket.nodes.length) || 0,
        topNodes: bucket.nodes.sort((a, b) => b.riskScore - a.riskScore).slice(0, 5),
      });
    }
  }

  // Findings
  const findings = [];
  for (const cycle of cycles) {
    findings.push({
      type: 'circular-dependency',
      severity: 'critical',
      evidence: { cycle },
      remediationHint: `Break the cycle ${cycle.join(' -> ')} by introducing an interface or extracting a shared dependency.`,
    });
  }
  for (const o of crossMilestoneOrphans) {
    findings.push({
      type: 'cross-milestone-edge-without-contract',
      severity: 'advisory',
      evidence: o,
      remediationHint: `Edge ${o.from} (M:${o.fromMilestone}) -> ${o.to} (M:${o.toMilestone}) crosses a milestone boundary without an interface-contracts.json entry. Add a contract entry for the producer/consumer pair.`,
    });
  }
  for (const n of nodeRisks.filter((r) => r.riskScore >= HIGH_RISK_SCORE)) {
    findings.push({
      type: 'high-blast-radius-node',
      severity: 'advisory',
      evidence: n,
      remediationHint: `Node ${n.id} has risk score ${n.riskScore}/100 (fanIn=${n.fanIn}, fanOut=${n.fanOut}). Consider splitting responsibility or stabilizing its public surface before downstream milestones depend further.`,
    });
  }

  return {
    ok: true,
    skipped: false,
    generatedAt: new Date().toISOString(),
    graphPath,
    nodeCount: nodes.size,
    edgeCount: edges.length,
    dependencyEdgeCount: depEdges.length,
    cycles,
    crossMilestoneOrphans,
    nodeRisks,
    milestones,
    findings,
    summary: {
      circularDepCount: cycles.length,
      crossMilestoneOrphanCount: crossMilestoneOrphans.length,
      highRiskNodeCount: nodeRisks.filter((n) => n.riskScore >= HIGH_RISK_SCORE).length,
      maxNodeRisk: nodeRisks.length > 0 ? nodeRisks[0].riskScore : 0,
    },
  };
}

function writeArtifact(result, planningDir) {
  if (!planningDir) return null;
  const outPath = path.join(planningDir, 'dependency-risk.json');
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
    return outPath;
  } catch {
    return null;
  }
}

function renderSummary(r) {
  if (!r.ok) return `dependency-risk: ${r.reason}\n`;
  return [
    `dependency-risk: ${r.nodeCount} nodes, ${r.dependencyEdgeCount} dep edges`,
    `  circular deps: ${r.summary.circularDepCount}`,
    `  cross-milestone orphans: ${r.summary.crossMilestoneOrphanCount}`,
    `  high-risk nodes: ${r.summary.highRiskNodeCount} (max score ${r.summary.maxNodeRisk}/100)`,
    `  milestones rolled up: ${r.milestones.length}`,
    '',
  ].join('\n');
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.command === 'help' || !args.command) {
    printHelp();
    process.exit(args.command === 'help' ? 0 : 1);
  }
  const result = analyze({ target: args.target });
  const projectRoot = args.target || process.cwd();
  const planningDir = getPlanningDir(projectRoot, { create: false, strict: false, fallbackToLatest: true });
  if (result.ok) writeArtifact(result, planningDir);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (args.command === 'summary') {
    process.stdout.write(renderSummary(result));
  } else {
    process.stdout.write(renderSummary(result));
  }

  if (!result.ok) process.exit(3);
  process.exit(0);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  analyze,
  parseArgs,
  detectCircularDeps,
  fanCounts,
  buildMilestoneAssignment,
  findCrossMilestoneEdgesWithoutContract,
  nodeRiskScore,
  HIGH_FAN_IN_THRESHOLD,
  HIGH_RISK_SCORE,
};
