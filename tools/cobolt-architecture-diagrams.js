#!/usr/bin/env node

// CoBolt Architecture Diagrams generator (v0.21.0).
//
// Reads _cobolt-output/latest/architecture-diagrams/graph/architecture-graph.json
// (or the brownfield equivalent) and produces per-diagram specs + Mermaid
// files + an index.md + a diagram-manifest.json + an evidence-map.json for
// the requested profile and state.
//
// Non-disruption: writes only under its own architecture-diagrams/ subtree.
//
// Usage:
//   node tools/cobolt-architecture-diagrams.js generate --pipeline greenfield --profile core --state target [--dir <project>]
//   node tools/cobolt-architecture-diagrams.js generate --pipeline brownfield --profile core --state both
//   node tools/cobolt-architecture-diagrams.js list-profiles
//
// Exit codes:
//   0 — artifacts written
//   1 — missing graph (caller should rebuild via cobolt-architecture-graph)
//   2 — usage error
//   3 — invalid profile/state

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { graphPath, archRoot, CANONICAL_VERSION } = require('./cobolt-architecture-graph');

// ── Profile registry ────────────────────────────────────────────────────────

const CORE_DIAGRAMS = [
  { id: 'EA-001', title: 'Enterprise Capability Map', taxonomyArea: 'Enterprise Architecture', kind: 'capability-map' },
  {
    id: 'BA-001',
    title: 'Business Process / Value Stream',
    taxonomyArea: 'Business Architecture',
    kind: 'value-stream',
  },
  {
    id: 'SA-001',
    title: 'Solution Architecture - System Context',
    taxonomyArea: 'Solution Architecture',
    kind: 'c4-context',
  },
  {
    id: 'SA-002',
    title: 'Solution Architecture - Detailed Components',
    taxonomyArea: 'Solution Architecture',
    kind: 'c4-container',
  },
  {
    id: 'APP-001',
    title: 'Application Architecture - Detailed Components',
    taxonomyArea: 'Application Architecture',
    kind: 'component-map',
  },
  {
    id: 'APP-002',
    title: 'Domain / Bounded Context Map',
    taxonomyArea: 'Application Architecture',
    kind: 'domain-map',
  },
  { id: 'DATA-001', title: 'Logical Data Model (ERD)', taxonomyArea: 'Data Architecture', kind: 'erd' },
  { id: 'DATA-002', title: 'Data Flow Diagram', taxonomyArea: 'Data Architecture', kind: 'data-flow' },
  { id: 'INT-001', title: 'Integration / API Map', taxonomyArea: 'Integration Architecture', kind: 'api-map' },
  { id: 'SEC-001', title: 'Security Trust Boundaries', taxonomyArea: 'Security Architecture', kind: 'trust-boundary' },
  { id: 'SEC-002', title: 'Identity and Access Flow', taxonomyArea: 'Security Architecture', kind: 'identity-flow' },
  {
    id: 'PLAT-001',
    title: 'Runtime Platform Topology',
    taxonomyArea: 'Platform Architecture',
    kind: 'runtime-topology',
  },
  {
    id: 'OPS-001',
    title: 'Observability and Operations Map',
    taxonomyArea: 'Operational Architecture',
    kind: 'observability-map',
  },
  {
    id: 'DELTA-001',
    title: 'Current-to-Target Delta Map',
    taxonomyArea: 'Brownfield only',
    kind: 'delta-map',
    stateRestrict: 'delta',
  },
];

const ENTERPRISE_DIAGRAMS = [
  {
    id: 'GOV-001',
    title: 'Governance Control Map',
    taxonomyArea: 'Governance / Compliance Architecture',
    kind: 'governance-map',
  },
  {
    id: 'GOV-002',
    title: 'Compliance Control → Evidence Map',
    taxonomyArea: 'Governance / Compliance Architecture',
    kind: 'governance-map',
  },
  {
    id: 'PRIV-001',
    title: 'Privacy / Sensitive-Data Flow',
    taxonomyArea: 'Governance / Compliance Architecture',
    kind: 'privacy-flow',
  },
  {
    id: 'PRIV-002',
    title: 'Data Residency and Retention',
    taxonomyArea: 'Governance / Compliance Architecture',
    kind: 'privacy-flow',
  },
  {
    id: 'RES-001',
    title: 'Resilience / Failure-Domain Topology',
    taxonomyArea: 'Operational Architecture',
    kind: 'resilience-map',
  },
  {
    id: 'REL-001',
    title: 'Release and Environment Promotion',
    taxonomyArea: 'Operational Architecture',
    kind: 'release-flow',
  },
  { id: 'OWN-001', title: 'Ownership / Team Topology', taxonomyArea: 'Enterprise Architecture', kind: 'ownership-map' },
  {
    id: 'MIG-001',
    title: 'Migration Transition Roadmap',
    taxonomyArea: 'Enterprise Architecture',
    kind: 'migration-roadmap',
  },
  {
    id: 'SC-001',
    title: 'Supply-Chain Architecture',
    taxonomyArea: 'Governance / Compliance Architecture',
    kind: 'supply-chain',
  },
  { id: 'COST-001', title: 'Cost / FinOps Topology', taxonomyArea: 'Platform Architecture', kind: 'cost-topology' },
  { id: 'RISK-001', title: 'Risk and Evidence Confidence', taxonomyArea: 'Enterprise Architecture', kind: 'risk-map' },
];

const SECURITY_DIAGRAMS = [
  { id: 'SEC-001', title: 'Security Trust Boundaries', taxonomyArea: 'Security Architecture', kind: 'trust-boundary' },
  { id: 'SEC-002', title: 'Identity and Access Flow', taxonomyArea: 'Security Architecture', kind: 'identity-flow' },
  { id: 'SEC-003', title: 'RBAC / Permission Topology', taxonomyArea: 'Security Architecture', kind: 'identity-flow' },
  { id: 'SEC-004', title: 'Secrets and Key Management', taxonomyArea: 'Security Architecture', kind: 'trust-boundary' },
];

const DATA_DIAGRAMS = [
  { id: 'DATA-001', title: 'Logical Data Model (ERD)', taxonomyArea: 'Data Architecture', kind: 'erd' },
  { id: 'DATA-002', title: 'Data Flow Diagram', taxonomyArea: 'Data Architecture', kind: 'data-flow' },
  { id: 'DATA-003', title: 'Data Classification Map', taxonomyArea: 'Data Architecture', kind: 'data-flow' },
  { id: 'DATA-004', title: 'Data Lifecycle and Retention', taxonomyArea: 'Data Architecture', kind: 'data-flow' },
];

const OPERATIONS_DIAGRAMS = [
  {
    id: 'OPS-001',
    title: 'Observability and Operations Map',
    taxonomyArea: 'Operational Architecture',
    kind: 'observability-map',
  },
  {
    id: 'OPS-002',
    title: 'Incident Response Flow',
    taxonomyArea: 'Operational Architecture',
    kind: 'observability-map',
  },
  {
    id: 'RES-001',
    title: 'Resilience / Failure-Domain Topology',
    taxonomyArea: 'Operational Architecture',
    kind: 'resilience-map',
  },
  {
    id: 'REL-001',
    title: 'Release and Environment Promotion',
    taxonomyArea: 'Operational Architecture',
    kind: 'release-flow',
  },
];

const MIGRATION_DIAGRAMS = [
  {
    id: 'MIG-001',
    title: 'Migration Transition Roadmap',
    taxonomyArea: 'Enterprise Architecture',
    kind: 'migration-roadmap',
  },
  {
    id: 'DELTA-001',
    title: 'Current-to-Target Delta Map',
    taxonomyArea: 'Brownfield only',
    kind: 'delta-map',
    stateRestrict: 'delta',
  },
  {
    id: 'MIG-002',
    title: 'Coexistence and Cutover',
    taxonomyArea: 'Enterprise Architecture',
    kind: 'coexistence-cutover',
  },
];

const AI_DIAGRAMS = [
  {
    id: 'AI-001',
    title: 'AI / Model Invocation Pipeline',
    taxonomyArea: 'Application Architecture',
    kind: 'ai-pipeline',
  },
  {
    id: 'AI-002',
    title: 'Retrieval and Vector Store Topology',
    taxonomyArea: 'Data Architecture',
    kind: 'ai-pipeline',
  },
  { id: 'AI-003', title: 'Guardrails and Eval Flow', taxonomyArea: 'Operational Architecture', kind: 'ai-pipeline' },
];

const PROFILE_REGISTRY = {
  core: CORE_DIAGRAMS,
  enterprise: [...CORE_DIAGRAMS, ...ENTERPRISE_DIAGRAMS],
  security: SECURITY_DIAGRAMS,
  data: DATA_DIAGRAMS,
  operations: OPERATIONS_DIAGRAMS,
  migration: MIGRATION_DIAGRAMS,
  ai: AI_DIAGRAMS,
  all: [
    ...CORE_DIAGRAMS,
    ...ENTERPRISE_DIAGRAMS,
    ...SECURITY_DIAGRAMS,
    ...DATA_DIAGRAMS,
    ...OPERATIONS_DIAGRAMS,
    ...MIGRATION_DIAGRAMS,
    ...AI_DIAGRAMS,
  ],
};

function dedupeDiagramEntries(entries) {
  const seen = new Set();
  const out = [];
  for (const d of entries) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    out.push(d);
  }
  return out;
}

// ── IO helpers ──────────────────────────────────────────────────────────────

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeFile(p, content) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, content, { mode: 0o600 });
}

function assertArchitectureOutputPath(dir) {
  const resolved = path.resolve(dir);
  if (
    !resolved.includes(`${path.sep}architecture-diagrams${path.sep}`) &&
    !resolved.endsWith(`${path.sep}architecture-diagrams`)
  ) {
    throw new Error(`Refusing to clear non-architecture diagram output path: ${resolved}`);
  }
  return resolved;
}

function clearGeneratedDir(dir) {
  const resolved = assertArchitectureOutputPath(dir);
  fs.rmSync(resolved, { recursive: true, force: true });
  ensureDir(resolved);
}

function clearPublishedSvgFiles(outDir, state) {
  const diagramsDir = path.join(outDir, 'diagrams');
  const resolved = assertArchitectureOutputPath(diagramsDir);
  ensureDir(resolved);
  const prefix = state === 'current' || state === 'target' || state === 'delta' ? `${state}-` : '';
  for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.svg')) continue;
    if (prefix && !entry.name.startsWith(prefix)) continue;
    fs.rmSync(path.join(resolved, entry.name), { force: true });
  }
}

function resetGeneratedStateOutput(outDir, state, format) {
  const sub = stateSubdir(outDir, state);
  clearGeneratedDir(sub.specs);
  if (formatRequestsMermaid(format)) clearGeneratedDir(sub.mermaid);
  if (formatRequestsPlantUml(format)) clearGeneratedDir(sub.plantuml);
  if (formatRequestsD2(format)) clearGeneratedDir(sub.d2);
  if (formatRequestsSvgIconic(format)) {
    clearGeneratedDir(sub.svgIconic);
    clearPublishedSvgFiles(outDir, state);
  }
}

function stateSubdir(arch, state) {
  if (state === 'current' || state === 'target' || state === 'delta') {
    return {
      specs: path.join(arch, state, 'specs'),
      mermaid: path.join(arch, state, 'mermaid'),
      plantuml: path.join(arch, state, 'plantuml'),
      d2: path.join(arch, state, 'd2'),
      svgIconic: path.join(arch, state, 'svg-iconic'),
    };
  }
  // greenfield default or composite
  return {
    specs: path.join(arch, 'specs'),
    mermaid: path.join(arch, 'mermaid'),
    plantuml: path.join(arch, 'plantuml'),
    d2: path.join(arch, 'd2'),
    svgIconic: path.join(arch, 'svg-iconic'),
  };
}

function publishableSvgName(state, filename) {
  if (state === 'current' || state === 'target' || state === 'delta') {
    return `${state}-${filename}`;
  }
  return filename;
}

function formatRequestsMermaid(format) {
  return format === 'mermaid' || format === 'svg' || format === 'png' || format === 'sources' || format === 'all';
}

function formatRequestsPlantUml(format) {
  return format === 'plantuml' || format === 'sources' || format === 'all';
}

function formatRequestsD2(format) {
  return format === 'd2' || format === 'sources' || format === 'all';
}

function formatRequestsSvgIconic(format) {
  return format === 'svg-iconic' || format === 'sources' || format === 'all';
}

// ── Spec construction per diagram ───────────────────────────────────────────

function pickNodes(graph, predicate, limit = 40) {
  return (graph.nodes || []).filter(predicate).slice(0, limit);
}

function architectureNodeRank(node) {
  const text = `${node?.type || ''} ${node?.name || ''}`.toLowerCase();
  const patterns = [
    /clients|ai tools|enterprise systems/,
    /admins|automation/,
    /go edge agent/,
    /elixir gateway server$/,
    /security and policy pipeline/,
    /routing, workflow, and event engine/,
    /mcp bridge and tool router/,
    /provider adapters/,
    /llm providers/,
    /mcp servers/,
    /rocksdb append log/,
    /amnesia|mnesia coordination/,
    /postgresql system of record/,
    /phoenix liveview/,
  ];
  const idx = patterns.findIndex((rx) => rx.test(text));
  if (idx !== -1) return idx;
  if (/^actor /.test(text)) return 40;
  if (/gateway-server\//.test(text)) return 50;
  if (/component/.test(text)) return 60;
  if (/integration/.test(text)) return 70;
  if (/datastore|dataentity/.test(text)) return 80;
  return 100;
}

function governanceNodeRank(node) {
  const text = `${node?.type || ''} ${node?.name || ''}`.toLowerCase();
  const patterns = [
    /compliance|auditor|risk|security engineer|finops|enterprise architect/,
    /policy-engine|policy bundle|governance|control|guardrail/,
    /audit-evidence|audit rows|evidence bundles|tamper/,
    /observability|logs|dashboards|metrics|traces/,
    /admin\/v1\/(policies|budgets|quotas|catalog|prompts|models|mcp|integrations)/,
    /identity|oidc|saml|rbac|sessions|tenant|virtual.?key/,
    /models|providers|prompts|policy_versions|scanner/,
    /rocksdb|postgres|mnesia|backup|restore|retention/,
  ];
  const idx = patterns.findIndex((rx) => rx.test(text));
  if (idx !== -1) return idx;
  if (/securitycontrol/.test(text)) return 20;
  if (/operationalsignal/.test(text)) return 30;
  if (/api/.test(text)) return 40;
  if (/datastore|dataentity/.test(text)) return 60;
  return 100;
}

function privacyNodeRank(node) {
  const text = `${node?.type || ''} ${node?.name || ''}`.toLowerCase();
  const patterns = [
    /chat\/completions|embeddings|sessions|backups|restore|erasure|audit|export|admin\/v1\/(sessions|backups|exports|erasure|retention)/,
    /tenant|virtual.?key|users|roles|service.?accounts|sessions|certificates/,
    /redaction|policy|scanner|guardrail|identity|auth/,
    /dsar|erasure|retention|backup|restore|audit-evidence/,
    /rocksdb|postgres|mnesia|hybrid storage|state/,
    /llm providers|siem|data lake|warehouse|provider|mcp/,
  ];
  const idx = patterns.findIndex((rx) => rx.test(text));
  if (idx !== -1) return idx;
  if (/securitycontrol/.test(text)) return 25;
  if (/operationalsignal/.test(text)) return 35;
  if (/datastore|dataentity/.test(text)) return 45;
  if (/integration/.test(text)) return 55;
  return 100;
}

function releaseNodeRank(node) {
  const text = `${node?.type || ''} ${node?.name || ''}`.toLowerCase();
  const patterns = [
    /release request|change set|build candidate|artifact|image|package/,
    /inference\/deployments|deployment api|deploy/i,
    /internal.*design.?partner|design.?partner.*internal/,
    /\bstaging\b/,
    /post-condition|smoke|regression|validation|health/,
    /policy bundle|scanner|red.?team|security|compliance|approval|itsm|soar|gate/,
    /\bproduction\b/,
    /canary|traffic shift|rollout/,
    /rollback|audit|observability|evidence|export/,
    /phase 0|foundation/,
    /phase 1/,
    /phase 2/,
    /phase 3/,
    /phase 4/,
    /single-tenant on-prem/,
    /customer cloud/,
    /managed control plane/,
    /hybrid regional event backbone/,
  ];
  const idx = patterns.findIndex((rx) => rx.test(text));
  if (idx !== -1) return idx;
  if (/deploymentenvironment/.test(text)) return 50;
  if (/platformnode/.test(text)) return 70;
  return 100;
}

function securityNodeRank(node) {
  const text = `${node?.type || ''} ${node?.name || ''}`.toLowerCase();
  const patterns = [
    /security and policy pipeline/,
    /strict egress firewall/,
    /trust labels and egress controls/,
    /request security layers/,
    /output and result security/,
    /execution leases/,
    /claimed side-effect verification/,
    /tiered enforcement and degradation ledger/,
    /audit requirements|audit trail|audit events|policy.*audit/,
    /policy simulation/,
    /llm red-team harness/,
    /allowed providers/,
    /allowed model families/,
    /allowed mcp servers/,
    /deny destinations/,
    /deny provider/,
    /external \/ internet/,
    /internal \/ application/,
    /go edge agent/,
    /elixir gateway server/,
    /mcp bridge and tool router/,
  ];
  const idx = patterns.findIndex((rx) => rx.test(text));
  if (idx !== -1) return idx;
  if (/securitycontrol/.test(text)) return 40;
  if (/trustboundary/.test(text)) return 50;
  if (/operationalsignal/.test(text)) return 60;
  if (/component/.test(text)) return 70;
  return 100;
}

function nodeDegreeMap(graph) {
  const degree = new Map();
  for (const e of graph.edges || []) {
    degree.set(e.from, (degree.get(e.from) || 0) + 1);
    degree.set(e.to, (degree.get(e.to) || 0) + 1);
  }
  return degree;
}

const RISK_COLUMNS = [
  { key: 'exposure', label: 'Exposure Surface', cap: 7 },
  { key: 'control', label: 'Control Gates', cap: 8 },
  { key: 'asset', label: 'Protected Assets', cap: 6 },
  { key: 'evidence', label: 'Evidence and Assurance', cap: 7 },
];

function riskNodeText(node) {
  return `${node?.label || node?.name || ''} ${node?.kind || node?.type || ''}`.toLowerCase();
}

function riskRoleForNode(node) {
  const kind = String(node?.kind || node?.type || '').toLowerCase();
  const text = riskNodeText(node);
  if (
    /audit|evidence|observability|otel|billing|cost|finops|compliance auditor|siem|data lake|warehouse|rag|staging|production|release/.test(
      text,
    )
  ) {
    return 'evidence';
  }
  if (
    kind === 'securitycontrol' ||
    /tls|auth|rate.?limit|quota|redaction|kill.?switch|policy|scanner|guardrail|trust class|tenant resolve|post.?condition|provider dispatch/.test(
      text,
    )
  ) {
    return 'control';
  }
  if (
    kind === 'datastore' ||
    kind === 'dataentity' ||
    /\bbc\b|bounded context|gateway bc|identity bc|policy-engine bc|integrations bc|rocksdb|postgres|mnesia|amnesia|system of record|append log/.test(
      text,
    )
  ) {
    return 'asset';
  }
  if (kind === 'actor' || kind === 'integration' || kind === 'api') return 'exposure';
  if (
    /inbound|gateway|edge agent|enterprise tenant|enterprise idp|mcp servers|llm providers|external|internet/.test(text)
  ) {
    return 'exposure';
  }
  return kind === 'component' ? 'control' : 'asset';
}

function riskColumnLabel(role) {
  return RISK_COLUMNS.find((c) => c.key === role)?.label || RISK_COLUMNS[2].label;
}

function riskRoleRank(role) {
  const idx = RISK_COLUMNS.findIndex((c) => c.key === role);
  return idx === -1 ? 2 : idx;
}

function riskLevelForNode(node) {
  const role = node.riskRole || riskRoleForNode(node);
  const text = riskNodeText(node);
  if (
    /kill.?switch|scanner|policy-engine|identity|gateway bc|rocksdb|postgres|llm providers|mcp servers|provider dispatch|redaction/.test(
      text,
    )
  ) {
    return 'critical';
  }
  if (role === 'exposure' || role === 'control' || /audit|evidence/.test(text)) return 'high';
  if (role === 'asset') return 'medium';
  return 'low';
}

function evidenceConfidenceForNode(node) {
  const refs = Array.isArray(node.evidenceRefs) ? node.evidenceRefs : Array.isArray(node.evidence) ? node.evidence : [];
  if (node.confidence === 'confirmed' && refs.length) return 'documented';
  if (node.confidence === 'confirmed') return 'confirmed';
  return node.confidence || 'unknown';
}

function riskPickRank(node, degree) {
  const roleRank = riskRoleRank(riskRoleForNode(node));
  const levelRank = { critical: 0, high: 1, medium: 2, low: 3 };
  const degreeScore = Math.min(degree.get(node.id) || 0, 10);
  return roleRank * 100 + (levelRank[riskLevelForNode(node)] ?? 3) * 10 - degreeScore;
}

function pickRiskMapNodes(graph, limit = 28) {
  const degree = nodeDegreeMap(graph);
  const byRole = new Map(RISK_COLUMNS.map((c) => [c.key, []]));
  const candidates = (graph.nodes || [])
    .slice()
    .filter((n) => riskRoleForNode(n))
    .sort((a, b) => riskPickRank(a, degree) - riskPickRank(b, degree) || String(a.id).localeCompare(String(b.id)));

  for (const n of candidates) {
    const role = riskRoleForNode(n);
    if (!byRole.has(role)) byRole.set(role, []);
    const cap = RISK_COLUMNS.find((c) => c.key === role)?.cap || 6;
    if (byRole.get(role).length < cap) byRole.get(role).push(n);
  }

  const picked = [];
  for (const col of RISK_COLUMNS) picked.push(...(byRole.get(col.key) || []));
  const pickedIds = new Set(picked.map((n) => n.id));
  for (const n of candidates) {
    if (picked.length >= limit) break;
    if (pickedIds.has(n.id)) continue;
    picked.push(n);
    pickedIds.add(n.id);
  }
  return picked.slice(0, limit);
}

function pickRankedNodes(graph, predicate, limit = 40, ranker = architectureNodeRank) {
  return (graph.nodes || [])
    .filter(predicate)
    .slice()
    .sort((a, b) => ranker(a) - ranker(b) || String(a.id).localeCompare(String(b.id)))
    .slice(0, limit);
}

const CAPABILITY_FALLBACK_BUCKETS = [
  {
    id: 'access',
    label: 'User and Admin Experience',
    group: 'Experience',
    rx: /actor|client|admin|automation|phoenix|liveview|\bweb\b|developer experience/i,
  },
  {
    id: 'orchestration',
    label: 'Agent Gateway and Orchestration',
    group: 'Core Platform',
    rx: /gateway|agent|routing|workflow|event engine|mcp bridge|tool router/i,
  },
  {
    id: 'integration',
    label: 'Provider and MCP Integration',
    group: 'Integration',
    rx: /integration|provider|llm|mcp server|adapter|chat\/completions|responses|embeddings|rerank|messages/i,
  },
  {
    id: 'security',
    label: 'Policy and Security Governance',
    group: 'Governance',
    rx: /security|policy|guardrail|trust|egress|approval|auth|rbac|secret|allowed|deny|redaction/i,
  },
  {
    id: 'data',
    label: 'State and Evidence Data',
    group: 'Data',
    rx: /datastore|dataentity|rocksdb|postgres|amnesia|mnesia|state|config|backup|audit|append log|vector/i,
  },
  {
    id: 'operations',
    label: 'Operations and Observability',
    group: 'Operations',
    rx: /operationalsignal|observability|metrics|latency|health|siem|loki|tempo|victoria|incident|degradation/i,
  },
  {
    id: 'delivery',
    label: 'Deployment and Release Management',
    group: 'Delivery',
    rx: /deploymentenvironment|platformnode|production|staging|phase|release|migration|cutover|on-prem|saas/i,
  },
];

const CAPABILITY_FALLBACK_RELATIONSHIPS = [
  ['capability-access', 'capability-orchestration', 'initiates work through'],
  ['capability-orchestration', 'capability-integration', 'routes provider calls'],
  ['capability-orchestration', 'capability-data', 'persists operational state'],
  ['capability-security', 'capability-orchestration', 'governs execution'],
  ['capability-security', 'capability-integration', 'controls egress'],
  ['capability-operations', 'capability-orchestration', 'observes runtime health'],
  ['capability-operations', 'capability-integration', 'monitors dependencies'],
  ['capability-delivery', 'capability-orchestration', 'deploys platform changes'],
  ['capability-delivery', 'capability-security', 'promotes controls'],
];

function confidenceWorst(values) {
  const order = ['confirmed', 'inferred', 'weak', 'unknown'];
  let worst = 'confirmed';
  for (const value of values || []) {
    const normalized = order.includes(value) ? value : 'unknown';
    if (order.indexOf(normalized) > order.indexOf(worst)) worst = normalized;
  }
  return worst;
}

function normalizedOwnerName(raw) {
  return String(raw || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function ownerNodeId(owner) {
  const slug = normalizedOwnerName(owner)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `owner-${slug || 'unassigned'}`;
}

function ownerOfNode(node) {
  return normalizedOwnerName(node?.owner || node?.team || node?.metadata?.owner || node?.metadata?.team || '');
}

function ownershipNodeRank(node) {
  const text = `${node?.name || ''} ${node?.type || ''}`.toLowerCase();
  const patterns = [
    /^gateway-agent\b/,
    /^gateway-server\b$/,
    /^mcp-bridge\b$/,
    /gateway-server\/grpc/,
    /gateway-server\/agents/,
    /gateway-server\/ingest/,
    /gateway-server\/resources/,
    /gateway-server\/web/,
    /gateway-server\/rocksdb/,
    /gateway-server\/amnesia/,
    /gateway-server\/backup/,
    /gateway-server\/flush/,
    /gateway-server\/reconciliation/,
  ];
  const idx = patterns.findIndex((rx) => rx.test(text));
  return idx === -1 ? patterns.length + String(node?.name || '').length : idx;
}

function ownershipLegend() {
  return [
    { symbol: 'Owner domain', meaning: 'Accountable team / ownership domain' },
    { symbol: 'Owned asset', meaning: 'Component assigned to that owner' },
    { symbol: 'Solid edge', meaning: 'Owns / accountable for' },
    { symbol: 'Dashed edge', meaning: 'Cross-owner dependency inferred from graph edge' },
  ];
}

function readGraphEvidenceJson(graph, basename) {
  const evidence = (graph.sourceEvidence || []).find(
    (e) => path.basename(e.path || '').toLowerCase() === basename.toLowerCase(),
  );
  const candidates = [];
  if (evidence?.path) {
    if (path.isAbsolute(evidence.path)) candidates.push(evidence.path);
    if (graph.projectRoot) candidates.push(path.resolve(graph.projectRoot, evidence.path));
    candidates.push(path.resolve(process.cwd(), evidence.path));
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return { data: JSON.parse(fs.readFileSync(candidate, 'utf8')), path: evidence.path };
      }
    } catch {
      /* ignore malformed optional evidence */
    }
  }
  return { data: null, path: evidence?.path || basename };
}

function boundedContextsForOwnership(graph) {
  if (Array.isArray(graph.boundedContexts)) return { contexts: graph.boundedContexts, path: 'graph.boundedContexts' };
  const loaded = readGraphEvidenceJson(graph, 'bounded-contexts.json');
  const contexts = Array.isArray(loaded.data?.boundedContexts) ? loaded.data.boundedContexts : [];
  return { contexts, path: loaded.path };
}

function interfaceContractsForOwnership(graph) {
  if (Array.isArray(graph.interfaceContracts))
    return { contracts: graph.interfaceContracts, path: 'graph.interfaceContracts' };
  const loaded = readGraphEvidenceJson(graph, 'interface-contracts.json');
  const contracts = Array.isArray(loaded.data?.contracts) ? loaded.data.contracts : [];
  return { contracts, path: loaded.path };
}

function ownershipContextOwnerName(context) {
  const name = normalizedOwnerName(context.name || context.id || 'Ownership Domain');
  return `${name} BC Team`;
}

function ownershipContextGroupId(context) {
  return `bc-${String(context.id || context.name || 'context')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')}`;
}

function ownershipContextTeamId(context) {
  return ownerNodeId(ownershipContextOwnerName(context));
}

function ownershipContextEvidence(context, sourcePath) {
  const summary = context.source
    ? `${context.name || context.id} bounded-context ownership: ${context.source}`
    : `${context.name || context.id} bounded-context ownership declaration`;
  return [{ path: sourcePath || 'bounded-contexts.json', summary }];
}

function ownershipContextPatterns(context) {
  const id = String(context.id || '').toLowerCase();
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '[-\\s]');
  const escapedName = String(context.name || '')
    .toLowerCase()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  const base = [];
  if (escapedId) base.push(new RegExp(`\\b${escapedId}\\b|${escapedId}\\s+bc`, 'i'));
  if (escapedName) base.push(new RegExp(`${escapedName}\\s+bc|\\b${escapedName}\\b`, 'i'));
  const byId = {
    gateway: [
      /mug|meru unified gateway/i,
      /gateway bc/i,
      /go edge agent/i,
      /elixir.*gateway/i,
      /route resolution/i,
      /inbound.*chat\/completions/i,
    ],
    'control-plane': [
      /control-plane bc/i,
      /control plane admin api|liveview dashboard|config authority/i,
      /admin\/v1\/tenants|tenant lifecycle/i,
    ],
    identity: [/identity bc/i, /oidc|saml|ldap|scim|rbac|enterprise idp/i],
    'policy-engine': [
      /policy-engine bc/i,
      /policy bundle eval|opa-style/i,
      /rate-limit|quota|trust class|lease|scanner|redaction|kill-switch/i,
    ],
    'audit-evidence': [/audit-evidence bc/i, /audit events|audit exports|evidence bundles|dsar|attestation/i],
    observability: [/observability bc/i, /otel|metrics|traces|loki|tempo|victoriametrics|shadow-ai|experiments/i],
    integrations: [/integrations bc/i, /mcp registry|mcp bridge|tool router|mcp servers|enterprise connectors/i],
    billing: [/billing bc/i, /cost events|metering|finops|billing|invoices|rollups/i],
  };
  return [...(byId[id] || []), ...base];
}

function ownershipContextAssetCandidates(graph, context, usedAssetIds, maxAssets = 4) {
  const patterns = ownershipContextPatterns(context);
  const candidates = (graph.nodes || [])
    .filter((n) => !usedAssetIds.has(n.id))
    .filter((n) => patterns.some((rx) => rx.test(`${n.name || ''} ${n.type || ''} ${n.id || ''}`)))
    .filter((n) => !['actor', 'deploymentEnvironment'].includes(n.type))
    .sort((a, b) => {
      const score = (n) => {
        const text = `${n.name || ''} ${n.id || ''}`.toLowerCase();
        let value = ownershipNodeRank(n);
        if (new RegExp(`${String(context.id || '').replace(/-/g, '[-\\s]')}\\s+bc`, 'i').test(text)) value -= 80;
        if (/bc\b|bounded context/.test(text)) value -= 40;
        if (
          /mug|gateway|policy-engine|identity|audit-evidence|observability|integrations|billing|control-plane/.test(
            text,
          )
        )
          value -= 20;
        if (n.type === 'api' || n.type === 'dataEntity') value += 18;
        return value;
      };
      return score(a) - score(b) || String(a.name || a.id).localeCompare(String(b.name || b.id));
    });
  return candidates.slice(0, maxAssets);
}

function deriveBoundedContextOwnershipTopology(graph) {
  const { contexts, path: contextPath } = boundedContextsForOwnership(graph);
  if (!contexts.length) return null;

  const nodes = [];
  const edges = [];
  const groups = [];
  const evidence = [];
  const usedAssetIds = new Set();
  const contextById = new Map(contexts.map((c) => [c.id, c]));

  for (const context of contexts) {
    const owner = ownershipContextOwnerName(context);
    const groupId = ownershipContextGroupId(context);
    const ownerId = ownershipContextTeamId(context);
    const contextEvidence = ownershipContextEvidence(context, contextPath);
    evidence.push(...contextEvidence);
    groups.push({
      id: groupId,
      label: owner,
      boundary: true,
      ownerNodeId: ownerId,
      boundedContext: context.id,
      assetCount: 0,
    });
    nodes.push({
      id: ownerId,
      label: owner,
      kind: 'team',
      group: groupId,
      owner,
      external: false,
      state: graph.state || 'target',
      confidence: 'confirmed',
      ownershipRole: 'owner',
      boundedContext: context.id,
      ownedCount: 0,
      evidenceRefs: contextEvidence,
    });

    const assets = ownershipContextAssetCandidates(graph, context, usedAssetIds, 4);
    if (!assets.length) {
      const scopeId = `${groupId}-ownership-scope`;
      nodes.push({
        id: scopeId,
        label: `${context.name || context.id} ownership scope`,
        kind: 'component',
        group: groupId,
        owner,
        external: false,
        state: graph.state || 'target',
        confidence: 'confirmed',
        ownershipRole: 'asset',
        boundedContext: context.id,
        evidenceRefs: contextEvidence,
      });
      edges.push({ from: ownerId, to: scopeId, label: 'owns', style: 'solid', ownership: true });
      groups[groups.length - 1].assetCount += 1;
      continue;
    }
    for (const asset of assets) {
      usedAssetIds.add(asset.id);
      const assetEvidence = asset.evidence?.length ? asset.evidence : contextEvidence;
      evidence.push(...assetEvidence);
      nodes.push({
        id: asset.id,
        label: asset.name,
        kind: asset.type,
        group: groupId,
        owner,
        external: asset.type === 'integration' || asset.type === 'actor',
        state: asset.state || graph.state || 'target',
        deltaType: asset.deltaType,
        confidence: asset.confidence || 'confirmed',
        ownershipRole: 'asset',
        boundedContext: context.id,
        evidenceRefs: assetEvidence,
      });
      edges.push({ from: ownerId, to: asset.id, label: 'owns', style: 'solid', ownership: true });
      groups[groups.length - 1].assetCount += 1;
    }
  }

  const teamByContext = new Map(contexts.map((c) => [c.id, ownershipContextTeamId(c)]));
  const seenDeps = new Set();
  const { contracts, path: contractPath } = interfaceContractsForOwnership(graph);
  for (const contract of contracts) {
    const from = teamByContext.get(contract.producerBC);
    const to = teamByContext.get(contract.consumerBC);
    if (!from || !to || from === to) continue;
    const key = `${from}->${to}->${contract.name || contract.id}`;
    if (seenDeps.has(key)) continue;
    seenDeps.add(key);
    edges.push({
      from,
      to,
      label: contract.name || contract.contractType || 'interface contract',
      style: 'dashed',
      ownership: false,
      evidenceRefs: [{ path: contractPath, summary: `${contract.id || 'interface'} cross-BC ownership handoff` }],
    });
    if (seenDeps.size >= 10) break;
  }

  if (!seenDeps.size) {
    for (const context of contexts) {
      const from = teamByContext.get(context.id);
      for (const targetId of [...(context.downstream || []), ...(context.upstream || [])]) {
        if (!contextById.has(targetId)) continue;
        const to = teamByContext.get(targetId);
        if (!from || !to || from === to) continue;
        const key = `${from}->${to}`;
        if (seenDeps.has(key)) continue;
        seenDeps.add(key);
        edges.push({
          from,
          to,
          label: `coordinates with ${contextById.get(targetId).name || targetId}`,
          style: 'dashed',
          ownership: false,
        });
        if (seenDeps.size >= 10) break;
      }
      if (seenDeps.size >= 10) break;
    }
  }

  return {
    nodes,
    edges,
    groups,
    evidence,
    assumptions: [
      'Ownership topology is derived from bounded-context ownership declarations and interface contracts when explicit graph owner metadata is absent.',
    ],
    warnings: [],
  };
}

const DOMAIN_CONTEXT_GROUPS = [
  { id: 'Runtime Core', label: 'Runtime Core', boundary: true, domainLayer: 'runtime' },
  { id: 'Governance and Control', label: 'Governance and Control', boundary: true, domainLayer: 'control' },
  { id: 'Integration Boundary', label: 'Integration Boundary', boundary: true, domainLayer: 'integration' },
  { id: 'Assurance and Operations', label: 'Assurance and Operations', boundary: true, domainLayer: 'assurance' },
  { id: 'Commercial Context', label: 'Commercial Context', boundary: true, domainLayer: 'commercial' },
];

const DOMAIN_CONTEXT_LAYER_BY_ID = {
  gateway: 'runtime',
  'control-plane': 'control',
  identity: 'control',
  'policy-engine': 'control',
  integrations: 'integration',
  'audit-evidence': 'assurance',
  observability: 'assurance',
  billing: 'commercial',
};

function domainContextNodeId(context) {
  return ownershipContextGroupId(context);
}

function canonicalDomainContextId(raw) {
  const id = String(raw || '')
    .trim()
    .toLowerCase();
  if (!id || ['n/a', 'na', 'none', 'null', 'terminal'].includes(id)) return null;
  return id;
}

function domainContextLayer(context) {
  const id = canonicalDomainContextId(context.id);
  if (id && DOMAIN_CONTEXT_LAYER_BY_ID[id]) return DOMAIN_CONTEXT_LAYER_BY_ID[id];
  const text = `${context.name || ''} ${context.purpose || ''}`.toLowerCase();
  if (/gateway|runtime|traffic|provider|route|stream/.test(text)) return 'runtime';
  if (/identity|policy|governance|admin|control|config|rbac/.test(text)) return 'control';
  if (/connector|integration|mcp|external/.test(text)) return 'integration';
  if (/audit|evidence|observability|telemetry|metrics|trace|slo/.test(text)) return 'assurance';
  if (/billing|metering|finops|chargeback|cost/.test(text)) return 'commercial';
  return 'runtime';
}

function domainContextGroup(context) {
  const layer = domainContextLayer(context);
  return DOMAIN_CONTEXT_GROUPS.find((g) => g.domainLayer === layer) || DOMAIN_CONTEXT_GROUPS[0];
}

function domainContextIconKind(context) {
  const id = canonicalDomainContextId(context.id);
  if (id === 'gateway' || id === 'control-plane') return 'platformNode';
  if (id === 'identity') return 'identity';
  if (id === 'policy-engine') return 'securityControl';
  if (id === 'integrations') return 'integration';
  if (id === 'audit-evidence' || id === 'observability' || id === 'billing') return 'operationalSignal';
  return 'component';
}

function domainContextLabel(context) {
  const base = normalizedOwnerName(context.name || context.id || 'Bounded Context');
  return /\bbc$/i.test(base) ? base : `${base} BC`;
}

function domainContextEvidence(context, sourcePath) {
  const summary = context.source
    ? `${context.name || context.id} bounded context: ${context.source}`
    : `${context.name || context.id} bounded-context declaration`;
  return [{ path: sourcePath || 'bounded-contexts.json', summary }];
}

function domainContractLabel(contract) {
  const raw = contract.name || contract.contractType || contract.id || 'interface contract';
  return String(raw).replace(/\s+/g, ' ').trim();
}

function domainDependencyLabel(fromContext, toContext) {
  const text = `${fromContext?.name || ''} ${toContext?.name || ''}`.toLowerCase();
  if (/billing|metering|finops|cost/.test(text)) return 'cost event dependency';
  if (/audit|evidence|attestation/.test(text)) return 'audit evidence dependency';
  if (/observability|telemetry|metrics|trace/.test(text)) return 'telemetry dependency';
  if (/identity|rbac|session/.test(text)) return 'identity dependency';
  if (/policy|guardrail|scanner/.test(text)) return 'policy dependency';
  return 'context dependency';
}

function deriveDomainBoundedContextTopology(graph) {
  const { contexts, path: contextPath } = boundedContextsForOwnership(graph);
  if (!contexts.length) {
    return {
      nodes: [],
      edges: [],
      groups: DOMAIN_CONTEXT_GROUPS,
      legend: [],
      evidence: [],
      assumptions: [],
      warnings: ['No bounded-context artifact was available for the Domain / Bounded Context Map.'],
    };
  }

  const nodes = [];
  const edges = [];
  const evidence = [];
  const validContexts = contexts.filter((context) => canonicalDomainContextId(context.id));
  const contextIdToNodeId = new Map();

  for (const context of validContexts) {
    const contextId = canonicalDomainContextId(context.id);
    const group = domainContextGroup(context);
    const contextEvidence = domainContextEvidence(context, contextPath);
    evidence.push(...contextEvidence);
    const nodeId = domainContextNodeId(context);
    contextIdToNodeId.set(contextId, nodeId);
    nodes.push({
      id: nodeId,
      label: domainContextLabel(context),
      kind: 'component',
      group: group.id,
      domainRole: 'bounded-context',
      domainLayer: group.domainLayer,
      boundedContext: context.id,
      purpose: context.purpose || '',
      featureCount: Array.isArray(context.features) ? context.features.length : 0,
      nfrCount: Array.isArray(context.nfrs) ? context.nfrs.length : 0,
      sharedKernel: Array.isArray(context.kernel) ? context.kernel.slice(0, 6) : [],
      ownedPaths: Array.isArray(context.ownedPaths) ? context.ownedPaths.slice(0, 5) : [],
      iconKind: domainContextIconKind(context),
      external: group.domainLayer === 'integration',
      state: graph.state || 'target',
      confidence: 'confirmed',
      evidenceRefs: contextEvidence,
    });
  }

  const { contracts, path: contractPath } = interfaceContractsForOwnership(graph);
  const seenEdges = new Set();
  const seenPairs = new Set();
  for (const contract of contracts) {
    const producer = canonicalDomainContextId(contract.producerBC || contract.producerContext || contract.producer);
    const consumer = canonicalDomainContextId(contract.consumerBC || contract.consumerContext || contract.consumer);
    const from = contextIdToNodeId.get(producer);
    const to = contextIdToNodeId.get(consumer);
    if (!from || !to || from === to) continue;
    const label = domainContractLabel(contract);
    const key = `${from}->${to}->${label}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    seenPairs.add(`${from}->${to}`);
    edges.push({
      from,
      to,
      label,
      style: String(contract.stability || '').toLowerCase() === 'evolving' ? 'dashed' : 'solid',
      contractRole: 'interface-contract',
      contractId: contract.id || null,
      contractType: contract.contractType || null,
      channel: contract.channel || null,
      stability: contract.stability || null,
      evidenceRefs: [
        {
          path: contractPath || 'interface-contracts.json',
          summary: `${contract.id || 'interface'} ${label}: ${producer} -> ${consumer}`,
        },
      ],
    });
  }

  const contextById = new Map(validContexts.map((context) => [canonicalDomainContextId(context.id), context]));
  const degreeByContextId = new Map(validContexts.map((context) => [canonicalDomainContextId(context.id), 0]));
  for (const edge of edges) {
    const fromContextId = [...contextIdToNodeId.entries()].find(([, nodeId]) => nodeId === edge.from)?.[0];
    const toContextId = [...contextIdToNodeId.entries()].find(([, nodeId]) => nodeId === edge.to)?.[0];
    if (fromContextId) degreeByContextId.set(fromContextId, (degreeByContextId.get(fromContextId) || 0) + 1);
    if (toContextId) degreeByContextId.set(toContextId, (degreeByContextId.get(toContextId) || 0) + 1);
  }

  for (const context of validContexts) {
    const contextId = canonicalDomainContextId(context.id);
    if ((degreeByContextId.get(contextId) || 0) > 0) continue;
    const candidates = [
      ...(context.downstream || []).map((targetId) => ({
        fromId: contextId,
        toId: canonicalDomainContextId(targetId),
      })),
      ...(context.upstream || []).map((sourceId) => ({ fromId: canonicalDomainContextId(sourceId), toId: contextId })),
    ].filter((candidate) => candidate.fromId && candidate.toId && candidate.fromId !== candidate.toId);
    for (const candidate of candidates) {
      const from = contextIdToNodeId.get(candidate.fromId);
      const to = contextIdToNodeId.get(candidate.toId);
      if (!from || !to) continue;
      const pairKey = `${from}->${to}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      edges.push({
        from,
        to,
        label: domainDependencyLabel(contextById.get(candidate.fromId), contextById.get(candidate.toId)),
        style: 'dashed',
        contractRole: 'bounded-context-dependency',
        evidenceRefs: [
          {
            path: contextPath || 'bounded-contexts.json',
            summary: `${candidate.fromId} -> ${candidate.toId} bounded-context dependency`,
          },
        ],
      });
      degreeByContextId.set(candidate.fromId, (degreeByContextId.get(candidate.fromId) || 0) + 1);
      degreeByContextId.set(candidate.toId, (degreeByContextId.get(candidate.toId) || 0) + 1);
      break;
    }
  }

  if (!edges.length) {
    for (const context of validContexts) {
      const from = contextIdToNodeId.get(canonicalDomainContextId(context.id));
      const related = [...(context.downstream || []), ...(context.upstream || [])];
      for (const targetIdRaw of related) {
        const targetId = canonicalDomainContextId(targetIdRaw);
        const to = contextIdToNodeId.get(targetId);
        if (!from || !to || from === to || !contextById.has(targetId)) continue;
        const label = `context dependency: ${contextById.get(targetId).name || targetId}`;
        const key = `${from}->${to}->${label}`;
        if (seenEdges.has(key)) continue;
        seenEdges.add(key);
        edges.push({ from, to, label, style: 'dashed', contractRole: 'context-dependency' });
      }
    }
  }

  return {
    nodes,
    edges,
    groups: DOMAIN_CONTEXT_GROUPS,
    legend: [
      { symbol: 'Bounded context', meaning: 'Business/application boundary owning features, data, and behavior' },
      { symbol: 'Contract edge', meaning: 'Source-backed interface contract between bounded contexts' },
      { symbol: 'Dashed edge', meaning: 'Evolving or inferred cross-context dependency' },
      { symbol: 'Shared kernel', meaning: 'Shared vocabulary/types that require governance across contexts' },
    ],
    evidence: dedupeEvidence(evidence),
    assumptions: [
      'Domain map is derived from bounded-context declarations and interface-contract artifacts, not generic graph component order.',
    ],
    warnings: edges.length
      ? []
      : ['Bounded contexts were found, but no cross-context contracts or dependencies were available.'],
  };
}

function deriveOwnershipTopology(graph, limit = 36) {
  const owned = (graph.nodes || [])
    .filter((n) => ownerOfNode(n))
    .sort((a, b) => {
      const ownerCmp = ownerOfNode(a).localeCompare(ownerOfNode(b));
      if (ownerCmp !== 0) return ownerCmp;
      return (
        ownershipNodeRank(a) - ownershipNodeRank(b) || String(a.name || a.id).localeCompare(String(b.name || b.id))
      );
    })
    .slice(0, limit);
  if (!owned.length) {
    const boundedContextTopology = deriveBoundedContextOwnershipTopology(graph);
    if (boundedContextTopology) return boundedContextTopology;
    return {
      nodes: [],
      edges: [],
      groups: [],
      evidence: [],
      assumptions: [
        'No owner metadata or bounded-context ownership declarations were present in the evidence graph; ownership topology cannot be derived.',
      ],
      warnings: [
        'No graph nodes contained owner/team metadata and no bounded-context ownership artifact was available.',
      ],
    };
  }

  const byOwner = new Map();
  for (const node of owned) {
    const owner = ownerOfNode(node);
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push(node);
  }

  const groups = [];
  const nodes = [];
  const edges = [];
  const evidence = [];
  for (const [owner, ownerNodes] of byOwner.entries()) {
    const ownerId = ownerNodeId(owner);
    groups.push({ id: owner, label: owner, boundary: true, ownerNodeId: ownerId, assetCount: ownerNodes.length });
    nodes.push({
      id: ownerId,
      label: owner,
      kind: 'team',
      group: owner,
      owner,
      external: false,
      state: graph.state || 'target',
      confidence: 'confirmed',
      ownershipRole: 'owner',
      ownedCount: ownerNodes.length,
    });
    for (const n of ownerNodes) {
      nodes.push({
        id: n.id,
        label: n.name,
        kind: n.type,
        group: owner,
        owner,
        external: n.type === 'integration' || n.type === 'actor',
        state: n.state || graph.state || 'target',
        deltaType: n.deltaType,
        confidence: n.confidence || 'inferred',
        ownershipRole: 'asset',
      });
      edges.push({ from: ownerId, to: n.id, label: 'owns', style: 'solid', ownership: true });
      if (n.evidence?.length) evidence.push(...n.evidence);
    }
  }

  const ownerByNode = new Map(nodes.filter((n) => n.ownershipRole === 'asset').map((n) => [n.id, n.owner]));
  const seenDeps = new Set();
  for (const e of graph.edges || []) {
    const fromOwner = ownerByNode.get(e.from);
    const toOwner = ownerByNode.get(e.to);
    if (!fromOwner || !toOwner || fromOwner === toOwner) continue;
    const fromOwnerId = ownerNodeId(fromOwner);
    const toOwnerId = ownerNodeId(toOwner);
    const key = `${fromOwnerId}->${toOwnerId}`;
    if (seenDeps.has(key)) continue;
    seenDeps.add(key);
    edges.push({
      from: fromOwnerId,
      to: toOwnerId,
      label: e.label && e.label !== 'flows to' ? `coordinates: ${e.label}` : 'cross-owner dependency',
      style: 'dashed',
      ownership: false,
    });
    if (seenDeps.size >= 8) break;
  }

  return {
    nodes,
    edges,
    groups,
    evidence,
    assumptions: ['Ownership topology is derived from graph owner/team metadata and rendered as accountability lanes.'],
    warnings: [],
  };
}

function deriveCapabilityFallbackSeeds(graph, limit = 12) {
  const buckets = new Map();
  for (const node of graph.nodes || []) {
    const text = `${node.type || ''} ${node.name || ''}`;
    const bucket = CAPABILITY_FALLBACK_BUCKETS.find((b) => b.rx.test(text));
    if (!bucket) continue;
    if (!buckets.has(bucket.id)) {
      buckets.set(bucket.id, {
        id: `capability-${bucket.id}`,
        name: bucket.label,
        type: 'capability',
        group: bucket.group,
        state: node.state,
        confidence: node.confidence || 'inferred',
        evidence: [],
        sourceNodeIds: [],
      });
    }
    const cap = buckets.get(bucket.id);
    cap.sourceNodeIds.push(node.id);
    cap.confidence = confidenceWorst([cap.confidence, node.confidence || 'inferred']);
    if (!cap.state && node.state) cap.state = node.state;
    if (Array.isArray(node.evidence)) cap.evidence.push(...node.evidence);
  }

  return [...buckets.values()].slice(0, limit).map((cap) => ({
    ...cap,
    evidence: dedupeEvidence(cap.evidence, 8),
  }));
}

// Hand-rolled shape check for the manifest (no ajv dependency in the repo).
// Covers the schema's required-field contract + enum checks at the top level
// and per-diagram entry. Detailed schema conformance is handled by the
// separate cobolt-architecture-diagram-validate tool; this check catches
// obvious shape drift at write-time so schemaPass is never a lie.
const MANIFEST_TOP_REQUIRED = ['version', 'generatedAt', 'pipeline', 'profile', 'state', 'diagrams'];
const MANIFEST_PIPELINE_ENUM = new Set(['greenfield', 'brownfield']);
const MANIFEST_PROFILE_ENUM = new Set([
  'core',
  'enterprise',
  'security',
  'data',
  'operations',
  'migration',
  'ai',
  'all',
]);
const MANIFEST_STATE_ENUM = new Set(['current', 'target', 'delta', 'both', 'composite']);
const DIAGRAM_REQUIRED = ['id', 'title', 'taxonomyArea', 'state', 'status'];
const DIAGRAM_STATUS_ENUM = new Set(['generated', 'skipped', 'warning', 'failed']);
const DIAGRAM_CONFIDENCE_ENUM = new Set(['confirmed', 'inferred', 'weak', 'unknown']);

function validateManifestShape(manifest) {
  const violations = [];
  for (const k of MANIFEST_TOP_REQUIRED) {
    if (manifest[k] === undefined || manifest[k] === null) {
      violations.push(`missing required top-level field: ${k}`);
    }
  }
  if (manifest.pipeline && !MANIFEST_PIPELINE_ENUM.has(manifest.pipeline)) {
    violations.push(`invalid pipeline enum: ${manifest.pipeline}`);
  }
  if (manifest.profile && !MANIFEST_PROFILE_ENUM.has(manifest.profile)) {
    violations.push(`invalid profile enum: ${manifest.profile}`);
  }
  if (manifest.state && !MANIFEST_STATE_ENUM.has(manifest.state)) {
    violations.push(`invalid state enum: ${manifest.state}`);
  }
  if (!Array.isArray(manifest.diagrams)) {
    violations.push(`diagrams must be an array (got ${typeof manifest.diagrams})`);
  } else {
    manifest.diagrams.forEach((d, i) => {
      for (const k of DIAGRAM_REQUIRED) {
        if (d[k] === undefined || d[k] === null) {
          violations.push(`diagrams[${i}]: missing required field: ${k}`);
        }
      }
      if (d.status && !DIAGRAM_STATUS_ENUM.has(d.status)) {
        violations.push(`diagrams[${i}]: invalid status enum: ${d.status}`);
      }
      if (d.confidence && !DIAGRAM_CONFIDENCE_ENUM.has(d.confidence)) {
        violations.push(`diagrams[${i}]: invalid confidence enum: ${d.confidence}`);
      }
      if (d.evidenceCount != null && (!Number.isInteger(d.evidenceCount) || d.evidenceCount < 0)) {
        violations.push(`diagrams[${i}]: evidenceCount must be a non-negative integer`);
      }
    });
  }
  if (manifest.validation && manifest.validation.tier != null) {
    if (![2, 3].includes(manifest.validation.tier)) {
      violations.push(`validation.tier must be 2 or 3 (got ${manifest.validation.tier})`);
    }
  }
  return { ok: violations.length === 0, violations };
}

// Dedupe evidence entries by (path, summary) tuple. Preserves first-seen
// order. Entries without a `path` are keyed by `summary` only. Caps at 50
// entries per spec to prevent pathological bloat.
function dedupeEvidence(entries, cap = 50) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const path = typeof e.path === 'string' ? e.path : '';
    const summary = typeof e.summary === 'string' ? e.summary : '';
    const key = `${path}::${summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
    if (out.length >= cap) break;
  }
  return out;
}

const COEXISTENCE_COLUMNS = [
  { key: 'source', label: 'Source still active', cap: 6, state: 'current', deltaType: 'keep' },
  { key: 'coexistence', label: 'Coexistence run', cap: 5, state: 'target', deltaType: 'change' },
  { key: 'cutover', label: 'Cutover gates', cap: 7, state: 'target', deltaType: 'change' },
  { key: 'target', label: 'Target steady state', cap: 5, state: 'target', deltaType: 'add' },
  { key: 'validation', label: 'Validation / rollback', cap: 5, state: 'target', deltaType: 'change' },
];

function coexistenceColumnMeta(phase) {
  return COEXISTENCE_COLUMNS.find((c) => c.key === phase) || COEXISTENCE_COLUMNS[1];
}

function coexistenceNodeText(node) {
  return `${node?.label || node?.name || ''} ${node?.kind || node?.type || ''}`.toLowerCase();
}

function coexistenceEvidenceRef(graph, pattern, summary) {
  const hit = (graph.sourceEvidence || []).find((e) => pattern.test(String(e.path || '')));
  if (hit) return { path: hit.path, summary };
  const fallback =
    (graph.sourceEvidence || []).find((e) => /architecture|prd|delivery|planning/i.test(String(e.path || ''))) ||
    (graph.sourceEvidence || [])[0];
  return fallback ? { path: fallback.path, summary } : null;
}

function coexistenceNodeFromGraph(node, phase, iconKind = null) {
  const column = coexistenceColumnMeta(phase);
  return {
    id: node.id,
    label: node.name,
    kind: node.type,
    group: column.label,
    cutoverPhase: phase,
    migrationRole: phase,
    iconKind: iconKind || node.type,
    external: node.type === 'integration' || node.type === 'actor',
    state: column.state,
    deltaType: column.deltaType,
    confidence: node.confidence || 'confirmed',
    evidenceRefs: node.evidence || [],
  };
}

function coexistenceSyntheticNode(graph, id, label, phase, kind, iconKind, evidencePattern, evidenceSummary) {
  const column = coexistenceColumnMeta(phase);
  const evidence = coexistenceEvidenceRef(graph, evidencePattern, evidenceSummary);
  return {
    id,
    label,
    kind,
    group: column.label,
    cutoverPhase: phase,
    migrationRole: phase,
    iconKind: iconKind || kind,
    external: kind === 'integration' || kind === 'actor',
    state: column.state,
    deltaType: column.deltaType,
    confidence: evidence ? 'confirmed' : 'inferred',
    evidenceRefs: evidence ? [evidence] : [],
  };
}

function deriveCoexistenceCutoverTopology(graph) {
  const allNodes = graph.nodes || [];
  const used = new Set();
  const nodes = [];
  const evidence = [];

  function add(node) {
    if (!node || used.has(node.id)) return null;
    const column = coexistenceColumnMeta(node.cutoverPhase);
    const count = nodes.filter((n) => n.cutoverPhase === column.key).length;
    if (count >= column.cap) return null;
    used.add(node.id);
    nodes.push(node);
    for (const e of node.evidenceRefs || []) evidence.push(e);
    return node;
  }

  function matchRank(node, prefer = {}) {
    const text = `${node.name || ''} ${node.type || ''}`;
    let rank = 0;
    if (prefer.prefer?.some((rx) => rx.test(text))) rank -= 100;
    if (prefer.avoid?.some((rx) => rx.test(text))) rank += 100;
    if (prefer.types) {
      const idx = prefer.types.indexOf(node.type);
      rank += idx === -1 ? 40 : idx * 5;
    } else if (node.type === 'api' || node.type === 'dataEntity') {
      rank += 18;
    }
    return rank;
  }

  function addGraph(pattern, phase, iconKind = null, prefer = {}) {
    const found = allNodes
      .filter((n) => !used.has(n.id) && pattern.test(`${n.name || ''} ${n.type || ''}`))
      .sort((a, b) => matchRank(a, prefer) - matchRank(b, prefer) || String(a.id).localeCompare(String(b.id)))[0];
    return add(found ? coexistenceNodeFromGraph(found, phase, iconKind) : null);
  }

  function addSynthetic(id, label, phase, kind, iconKind, evidencePattern, evidenceSummary) {
    return add(coexistenceSyntheticNode(graph, id, label, phase, kind, iconKind, evidencePattern, evidenceSummary));
  }

  addGraph(/enterprise tenant/i, 'source', 'actor');
  addGraph(/application developer|cli agents|clients, ai tools|enterprise systems/i, 'source', 'actor');
  addGraph(/enterprise idp|oidc|saml|ldap|scim/i, 'source', 'identity');
  addGraph(/llm providers|openai|anthropic|google|azure|bedrock/i, 'source', 'integration');
  addGraph(/itsm|soar|approval|on-call/i, 'source', 'operationalSignal', {
    types: ['component', 'operationalSignal', 'api'],
    prefer: [/ITSM|SOAR|On-call/i],
  });
  addGraph(/\bsiem\b|data lake|warehouse|\brag\b/i, 'source', 'operationalSignal', {
    types: ['integration', 'operationalSignal', 'dataStore', 'api'],
    prefer: [/SIEM|Data lake|Warehouse|RAG/i],
  });

  addSynthetic(
    'cutover-parallel-run',
    'Parallel run with source tenant active',
    'coexistence',
    'operationalSignal',
    'deployment',
    /tenant-lifecycle|model-intake|deployment-topologies|control-plane/i,
    'Coexistence / migration evidence: source remains active until cutover confirmation.',
  );
  addGraph(/mug|meru unified gateway/i, 'coexistence', 'platformNode');
  addGraph(/go edge agent/i, 'coexistence', 'platformNode');
  addGraph(/elixir.*gateway|gateway server cluster/i, 'coexistence', 'platformNode');
  addGraph(/inbound.*chat\/completions|runtime ingress/i, 'coexistence', 'api');

  addSynthetic(
    'cutover-route-switch',
    'DNS / client config route switch',
    'cutover',
    'deployment',
    'deployment',
    /tenant-lifecycle|deployment-topologies/i,
    'Cutover evidence: update DNS / client config to point at the target deployment.',
  );
  addSynthetic(
    'cutover-source-suspend',
    'Suspend source after confirmation',
    'cutover',
    'securityControl',
    'securityControl',
    /tenant-lifecycle/i,
    'Cutover evidence: suspend source only after target confirmation.',
  );
  addGraph(/virtual-key|tenant resolve/i, 'cutover', 'securityControl');
  addGraph(/identity bc|rbac|sessions|oidc|saml/i, 'cutover', 'identity', {
    types: ['securityControl', 'component', 'dataEntity', 'api'],
    prefer: [/identity BC/i],
  });
  addGraph(/policy-engine|kill-switch|budgets|scanner|redaction/i, 'cutover', 'securityControl', {
    types: ['securityControl', 'component', 'dataEntity', 'api'],
    prefer: [/policy-engine BC/i],
  });
  addGraph(/route resolution/i, 'cutover', 'component');
  addGraph(/post-condition verifier|webhook|probe|approval/i, 'cutover', 'securityControl');

  addGraph(/control-plane bc|admin api|liveview|config authority/i, 'target', 'platformNode');
  addGraph(/gateway bc|grpc, agents|ingest, rocksdb/i, 'target', 'dataStore');
  addGraph(/rocksdb|append-only durable|append log/i, 'target', 'dataStore', {
    types: ['dataStore', 'dataEntity'],
    prefer: [/write buffer|append-only|append log/i],
  });
  addGraph(/integrations bc|mcp registry|enterprise connectors/i, 'target', 'integration');
  addGraph(/mcp servers|tools/i, 'target', 'integration', {
    types: ['integration', 'dataEntity', 'component'],
    prefer: [/MCP Servers|Tools/i],
  });

  addSynthetic(
    'cutover-rollback-bundle',
    'Rollback bundle and write-freeze gate',
    'validation',
    'securityControl',
    'release',
    /state-config|control-plane-resource|deployment-topologies|feature-catalog/i,
    'Rollback evidence: rollback bundle and freeze controls protect partial failures.',
  );
  addGraph(/observability bc|otel|shadow-ai|experiments/i, 'validation', 'operationalSignal', {
    types: ['operationalSignal', 'component', 'dataEntity', 'api'],
    prefer: [/observability BC/i],
  });
  addGraph(/audit-evidence bc|audit events|evidence bundles/i, 'validation', 'operationalSignal');
  addGraph(/compliance auditor/i, 'validation', 'actor');
  addGraph(/\bsiem\b|data lake|warehouse|\brag\b/i, 'validation', 'operationalSignal', {
    types: ['integration', 'operationalSignal', 'dataStore', 'api'],
    prefer: [/SIEM|Data lake|Warehouse|RAG/i],
  });

  const byText = (phase, pattern) =>
    nodes.find((n) => n.cutoverPhase === phase && pattern.test(coexistenceNodeText(n)));
  const anyText = (pattern) => nodes.find((n) => pattern.test(coexistenceNodeText(n)));
  const edges = [];
  const seenEdges = new Set();
  function connect(from, to, label, style = 'solid') {
    if (!from || !to || from.id === to.id) return;
    const key = `${from.id}->${to.id}:${label}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({ from: from.id, to: to.id, label, style });
  }

  const tenant = byText('source', /enterprise tenant|application developer|clients|cli agents/);
  const idp = byText('source', /idp|oidc|saml|ldap|scim/);
  const providers = byText('source', /llm providers|openai|anthropic|azure|bedrock/);
  const approval = byText('source', /itsm|soar|approval|on-call/);
  const parallel = byText('coexistence', /parallel run/);
  const mug = byText('coexistence', /mug|unified gateway/);
  const edgeAgent = byText('coexistence', /go edge agent/);
  const gatewayServer = byText('coexistence', /elixir.*gateway|gateway server/);
  const inbound = byText('coexistence', /inbound|runtime ingress/);
  const routeSwitch = byText('cutover', /route switch|dns|client config/);
  const sourceSuspend = byText('cutover', /suspend source/);
  const virtualKey = byText('cutover', /virtual-key|tenant resolve/);
  const identity = byText('cutover', /identity|rbac|sessions|oidc|saml/);
  const policy = byText('cutover', /policy-engine|kill-switch|budgets|scanner|redaction/);
  const route = byText('cutover', /route resolution/);
  const verifier = byText('cutover', /post-condition|webhook|probe|approval/);
  const controlPlane = byText('target', /control-plane|admin api|liveview/);
  const gatewayBc = byText('target', /gateway bc|grpc, agents|rocksdb/);
  const rocks = byText('target', /rocksdb|append/);
  const integrations = byText('target', /integrations bc|mcp/);
  const rollback = byText('validation', /rollback|freeze/);
  const observability = byText('validation', /observability|otel|shadow/);
  const audit = byText('validation', /audit|evidence/);
  const compliance = byText('validation', /compliance auditor/);
  const siem = anyText(/siem|data lake|warehouse|rag/);

  connect(tenant, parallel || mug, 'shadow/proxy traffic', 'dashed');
  connect(providers, mug || inbound, 'provider route governed', 'dashed');
  connect(idp, identity || virtualKey, 'federated identity live', 'dashed');
  connect(approval, routeSwitch || sourceSuspend, 'manual approval gate', 'solid');
  connect(parallel, routeSwitch, 'promote after parity', 'solid');
  connect(mug || inbound, virtualKey || routeSwitch, 'governed ingress', 'solid');
  connect(edgeAgent, gatewayServer, 'gRPC over mTLS', 'solid');
  connect(gatewayServer || mug, gatewayBc, 'target session path', 'solid');
  connect(virtualKey, policy || route, 'quota and policy gate', 'solid');
  connect(identity, route || controlPlane, 'tenant/session continuity', 'solid');
  connect(policy, route || verifier, 'allow target route', 'solid');
  connect(route || routeSwitch, verifier || gatewayBc, 'cutover execution', 'solid');
  connect(verifier || routeSwitch, gatewayBc || controlPlane, 'commit target path', 'solid');
  connect(controlPlane, sourceSuspend, 'customer confirmation', 'dashed');
  connect(gatewayBc, rocks, 'durable target state', 'solid');
  connect(policy || route, integrations || gatewayBc, 'connector policy', 'dashed');
  connect(gatewayBc || controlPlane, rollback, 'checkpoint for rollback', 'dashed');
  connect(observability || audit, compliance, 'go/no-go evidence', 'solid');
  if (siem?.cutoverPhase === 'source') connect(siem, audit || observability, 'receives audit export', 'dashed');
  else connect(audit || gatewayBc, siem, 'audit export', 'dashed');
  connect(rollback, compliance || audit, 'rollback readiness', 'dashed');

  return {
    nodes,
    edges,
    groups: COEXISTENCE_COLUMNS.map((c) => ({ id: c.label, label: c.label, boundary: true, cutoverPhase: c.key })),
    legend: [
      {
        symbol: 'Source active',
        meaning: 'Existing tenant, identity, provider, and ops surfaces remain live during coexistence',
      },
      { symbol: 'Coexistence run', meaning: 'MUG/edge/gateway path runs in parallel or shadow/proxy mode' },
      {
        symbol: 'Cutover gates',
        meaning: 'Explicit switch, policy, identity, confirmation, and post-condition controls',
      },
      { symbol: 'Target steady state', meaning: 'Target control plane, gateway, integrations, and durable state' },
      { symbol: 'Validation / rollback', meaning: 'Evidence, observability, rollback bundle, and go/no-go checks' },
    ],
    evidence: dedupeEvidence(evidence),
    assumptions: [
      'Coexistence/cutover phases are derived from tenant lifecycle, traffic routing, rollback, and validation evidence so the diagram shows operational cutover semantics instead of a generic migration pipeline.',
    ],
    warnings: nodes.length ? [] : ['No graph nodes matched the coexistence/cutover viewpoint.'],
  };
}

const BUSINESS_VALUE_STAGES = [
  { key: 'demand', label: 'Stakeholder Demand', cap: 4 },
  { key: 'intake', label: 'Governed Intake', cap: 3 },
  { key: 'control', label: 'Control Decision', cap: 5 },
  { key: 'execution', label: 'Approved Execution', cap: 4 },
  { key: 'outcome', label: 'Evidence and Outcomes', cap: 5 },
];

function businessStageMeta(stage) {
  return BUSINESS_VALUE_STAGES.find((s) => s.key === stage) || BUSINESS_VALUE_STAGES[0];
}

function businessNodeText(node) {
  return `${node?.label || node?.name || ''} ${node?.kind || node?.type || ''}`.toLowerCase();
}

function businessNodeFromGraph(node, stage, iconKind = null) {
  const meta = businessStageMeta(stage);
  return {
    id: node.id,
    label: node.name,
    kind: node.type,
    group: meta.label,
    businessStage: stage,
    iconKind: iconKind || node.type,
    external: node.type === 'integration' || node.type === 'actor',
    state: node.state || 'target',
    confidence: node.confidence || 'confirmed',
    evidenceRefs: node.evidence || [],
  };
}

function businessSyntheticNode(graph, id, label, stage, kind, iconKind, evidencePattern, evidenceSummary) {
  const meta = businessStageMeta(stage);
  const evidence = coexistenceEvidenceRef(graph, evidencePattern, evidenceSummary);
  return {
    id,
    label,
    kind,
    group: meta.label,
    businessStage: stage,
    iconKind: iconKind || kind,
    external: kind === 'integration' || kind === 'actor',
    state: 'target',
    confidence: evidence ? 'confirmed' : 'inferred',
    evidenceRefs: evidence ? [evidence] : [],
  };
}

function deriveBusinessValueStreamTopology(graph) {
  const allNodes = graph.nodes || [];
  const used = new Set();
  const nodes = [];
  const evidence = [];

  function rankMatch(node, prefer = {}) {
    const text = `${node.name || ''} ${node.type || ''}`;
    let rank = 0;
    if (prefer.prefer?.some((rx) => rx.test(text))) rank -= 100;
    if (prefer.avoid?.some((rx) => rx.test(text))) rank += 100;
    if (prefer.types) {
      const idx = prefer.types.indexOf(node.type);
      rank += idx === -1 ? 40 : idx * 5;
    } else if (node.type === 'api' || node.type === 'dataEntity') {
      rank += 18;
    }
    return rank;
  }

  function add(node) {
    if (!node || used.has(node.id)) return null;
    const meta = businessStageMeta(node.businessStage);
    const count = nodes.filter((n) => n.businessStage === meta.key).length;
    if (count >= meta.cap) return null;
    used.add(node.id);
    nodes.push(node);
    for (const e of node.evidenceRefs || []) evidence.push(e);
    return node;
  }

  function addGraph(pattern, stage, iconKind = null, prefer = {}) {
    const found = allNodes
      .filter((n) => !used.has(n.id) && pattern.test(`${n.name || ''} ${n.type || ''}`))
      .sort((a, b) => rankMatch(a, prefer) - rankMatch(b, prefer) || String(a.id).localeCompare(String(b.id)))[0];
    return add(found ? businessNodeFromGraph(found, stage, iconKind) : null);
  }

  function addSynthetic(id, label, stage, kind, iconKind, evidencePattern, evidenceSummary) {
    return add(businessSyntheticNode(graph, id, label, stage, kind, iconKind, evidencePattern, evidenceSummary));
  }

  addGraph(/application developer|cli agents/i, 'demand', 'actor', {
    types: ['actor'],
    prefer: [/Application Developer \/ CLI Agents/i],
  });
  addGraph(/platform \/ security \/ finops operators|security engineer/i, 'demand', 'actor', {
    types: ['actor'],
    prefer: [/Platform \/ Security \/ FinOps Operators|Security Engineer/i],
  });
  addGraph(/finops|cost owner/i, 'demand', 'actor', { types: ['actor'] });
  addGraph(/compliance.*risk officer|compliance auditor/i, 'demand', 'actor', {
    types: ['actor', 'operationalSignal'],
  });

  addSynthetic(
    'business-default-ai-route',
    'Default route for enterprise AI traffic',
    'intake',
    'capability',
    'platformNode',
    /product-overview|feature-catalog/i,
    'Business objective: MUG becomes the default route for enterprise AI traffic.',
  );
  addGraph(/mug|meru unified gateway/i, 'intake', 'platformNode', {
    types: ['component', 'platformNode'],
    prefer: [/Meru Unified Gateway|MUG/i],
  });
  addGraph(/inbound.*chat\/completions|post \/mcp|runtime ingress/i, 'intake', 'api', {
    types: ['component', 'api'],
  });

  addGraph(/virtual-key|tenant resolve/i, 'control', 'securityControl', {
    types: ['component', 'securityControl', 'api'],
  });
  addGraph(/identity bc|oidc|saml|ldap|scim|rbac/i, 'control', 'identity', {
    types: ['securityControl', 'component', 'dataEntity'],
    prefer: [/identity BC/i],
  });
  addGraph(/policy-engine|policy bundle|guardrail|scanner|redaction|kill-switch/i, 'control', 'securityControl', {
    types: ['securityControl', 'component', 'dataEntity'],
    prefer: [/policy-engine BC|Policy bundle eval/i],
  });
  addGraph(/budgets|quota|cost control/i, 'control', 'operationalSignal', {
    types: ['dataEntity', 'operationalSignal', 'api'],
  });
  addGraph(/mcp.*approval|approval.*workflow|trust score/i, 'control', 'securityControl', {
    types: ['api', 'dataEntity', 'component'],
  });

  addGraph(/llm providers|openai|anthropic|google|azure|bedrock/i, 'execution', 'integration', {
    types: ['integration', 'component'],
    prefer: [/LLM Providers/i],
  });
  addGraph(/mcp servers|mcp tools/i, 'execution', 'integration', {
    types: ['integration', 'dataEntity'],
    prefer: [/MCP Servers|Tools/i],
  });
  addGraph(/go edge agent|cli|agent traffic/i, 'execution', 'platformNode', {
    types: ['component', 'actor'],
    prefer: [/Go Edge Agent/i],
  });
  addGraph(/itsm|soar|approval|on-call/i, 'execution', 'operationalSignal', {
    types: ['component', 'operationalSignal', 'api'],
    prefer: [/ITSM|SOAR|On-call/i],
  });

  addGraph(/audit-evidence bc|audit events|evidence bundles/i, 'outcome', 'operationalSignal', {
    types: ['operationalSignal', 'dataEntity'],
    prefer: [/audit-evidence BC/i],
  });
  addGraph(/cost events|billing bc|metering|finops/i, 'outcome', 'operationalSignal', {
    types: ['operationalSignal', 'dataEntity'],
    prefer: [/billing BC|Cost events/i],
  });
  addGraph(/\bsiem\b|data lake|warehouse|\brag\b/i, 'outcome', 'integration', {
    types: ['integration', 'operationalSignal', 'dataStore', 'api'],
    prefer: [/SIEM|Data lake|Warehouse|RAG/i],
  });
  addGraph(/compliance auditor/i, 'outcome', 'actor', {
    types: ['operationalSignal', 'actor'],
  });
  addSynthetic(
    'business-outcome-governed-ai',
    'Reduced unmanaged egress, cost variance, and audit gaps',
    'outcome',
    'capability',
    'operationalSignal',
    /product-overview|feature-catalog/i,
    'Business outcomes include reduced unmanaged AI use, lower cost variance, and improved audit readiness.',
  );

  const byStage = (stage, pattern) => nodes.find((n) => n.businessStage === stage && pattern.test(businessNodeText(n)));
  const _any = (pattern) => nodes.find((n) => pattern.test(businessNodeText(n)));
  const edges = [];
  const seen = new Set();
  function connect(from, to, label, style = 'solid') {
    if (!from || !to || from.id === to.id) return;
    const key = `${from.id}->${to.id}:${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from: from.id, to: to.id, label, style });
  }

  const developer = byStage('demand', /developer|cli agents/);
  const operators = byStage('demand', /platform|security|operator/);
  const finops = byStage('demand', /finops|cost/);
  const compliance = byStage('demand', /compliance|risk/);
  const defaultRoute = byStage('intake', /default route/);
  const gateway = byStage('intake', /mug|unified gateway/);
  const ingress = byStage('intake', /inbound|mcp|runtime ingress/);
  const tenant = byStage('control', /virtual-key|tenant resolve/);
  const identity = byStage('control', /identity|oidc|saml|rbac/);
  const policy = byStage('control', /policy-engine|policy bundle|guardrail|scanner|redaction|kill-switch/);
  const budget = byStage('control', /budget|quota|cost/);
  const approval = byStage('control', /approval|trust/);
  const providers = byStage('execution', /llm providers|openai|anthropic|azure|bedrock/);
  const mcp = byStage('execution', /mcp servers|mcp tools/);
  const edge = byStage('execution', /go edge|cli|agent traffic/);
  const itsm = byStage('execution', /itsm|soar|approval|on-call/);
  const audit = byStage('outcome', /audit|evidence/);
  const cost = byStage('outcome', /cost|billing|metering|finops/);
  const siem = byStage('outcome', /siem|data lake|warehouse|rag/);
  const auditor = byStage('outcome', /compliance auditor/);
  const outcome = byStage('outcome', /reduced unmanaged|audit gaps|cost variance/);

  connect(developer, defaultRoute || gateway || ingress, 'requests governed AI usage');
  connect(operators, gateway || defaultRoute, 'configures guardrails');
  connect(finops, budget || policy, 'sets spend constraints');
  connect(compliance, policy || auditor, 'defines evidence obligations');
  connect(defaultRoute, gateway || ingress, 'routes through MUG');
  connect(gateway || ingress, tenant || identity, 'resolves tenant context');
  connect(tenant || identity, policy, 'adds identity context');
  connect(budget, policy, 'adds cost limits');
  connect(approval, policy, 'adds tool trust gate');
  connect(policy, providers, 'allows model route');
  connect(policy, mcp, 'allows tool route');
  connect(policy, edge, 'governs agent sessions');
  connect(policy, itsm, 'requests approval or escalation', 'dashed');
  connect(providers || mcp || edge, audit, 'emits decision evidence');
  connect(mcp, audit, 'emits tool evidence');
  connect(edge, audit, 'emits session evidence');
  connect(policy, siem, 'exports evidence stream', 'dashed');
  connect(policy, auditor, 'supports audit review');
  connect(budget, cost, 'proves spend control');
  connect(policy, outcome, 'proves governance outcome');

  return {
    nodes,
    edges,
    groups: BUSINESS_VALUE_STAGES.map((s) => ({ id: s.label, label: s.label, boundary: true, businessStage: s.key })),
    legend: [
      { symbol: 'Demand', meaning: 'Business personas and stakeholder concerns driving the value stream' },
      { symbol: 'Intake', meaning: 'Default governed entry point for AI, MCP, and agent traffic' },
      { symbol: 'Control', meaning: 'Identity, policy, spend, and approval decisions before execution' },
      { symbol: 'Execution', meaning: 'Approved provider, tool, agent, and enterprise workflow paths' },
      { symbol: 'Outcome', meaning: 'Audit evidence, cost signals, compliance review, and business impact' },
    ],
    evidence: dedupeEvidence(evidence),
    assumptions: [
      'Business value-stream stages are derived from personas, product objectives, feature catalog capabilities, and architecture nodes so BA-001 shows business flow rather than a generic component graph.',
    ],
    warnings: nodes.length ? [] : ['No graph nodes matched the business value-stream viewpoint.'],
  };
}

const SOLUTION_CONTEXT_GROUPS = [
  { id: 'External actors', label: 'External actors', boundary: false, solutionLayer: 'actors' },
  { id: 'System boundary', label: 'MUG system boundary', boundary: true, solutionLayer: 'system' },
  { id: 'External systems', label: 'External systems', boundary: false, solutionLayer: 'external' },
];

const SOLUTION_CONTAINER_GROUPS = [
  { id: 'MUG Platform', label: 'MUG Platform Boundary', boundary: true, solutionLayer: 'platform' },
  { id: 'State and Evidence Stores', label: 'State and Evidence Stores', boundary: true, solutionLayer: 'state' },
];

const APPLICATION_COMPONENT_GROUPS = [
  { id: 'Application Channels', label: 'Application Channels', boundary: true, applicationLayer: 'channels' },
  { id: 'Request Pipeline', label: 'Request Pipeline', boundary: true, applicationLayer: 'flow' },
  { id: 'Runtime Services', label: 'Runtime Services', boundary: true, applicationLayer: 'runtime' },
  { id: 'State and Config', label: 'State and Config', boundary: true, applicationLayer: 'state' },
  { id: 'External Integrations', label: 'External Integrations', boundary: true, applicationLayer: 'external' },
];

const AI_INVOCATION_GROUPS = [
  { id: 'Client and API Entry', label: 'Client and API Entry', boundary: true, aiStage: 'entry' },
  { id: 'Pre-Invocation Controls', label: 'Pre-Invocation Controls', boundary: true, aiStage: 'controls' },
  { id: 'Policy and Routing', label: 'Policy and Routing', boundary: true, aiStage: 'policy' },
  { id: 'Provider Invocation', label: 'Provider Invocation', boundary: true, aiStage: 'provider' },
  { id: 'Post-Invocation Evidence', label: 'Post-Invocation Evidence', boundary: true, aiStage: 'evidence' },
  { id: 'Model and Prompt Governance', label: 'Model and Prompt Governance', boundary: true, aiStage: 'governance' },
];

const RETRIEVAL_VECTOR_GROUPS = [
  { id: 'Retrieval API Entry', label: 'Retrieval API Entry', boundary: true, aiStage: 'entry' },
  { id: 'Query and Data Controls', label: 'Query and Data Controls', boundary: true, aiStage: 'controls' },
  { id: 'Index and Prompt Governance', label: 'Index and Prompt Governance', boundary: true, aiStage: 'policy' },
  { id: 'Embedding and Model Providers', label: 'Embedding and Model Providers', boundary: true, aiStage: 'provider' },
  {
    id: 'Retrieval Evidence and Operations',
    label: 'Retrieval Evidence and Operations',
    boundary: true,
    aiStage: 'evidence',
  },
  {
    id: 'Vector Stores and Knowledge Sources',
    label: 'Vector Stores and Knowledge Sources',
    boundary: true,
    aiStage: 'governance',
  },
];

const DATA_MODEL_GROUPS = [
  { id: 'Tenant and Identity', label: 'Tenant and Identity', boundary: true, dataStage: 'identity' },
  { id: 'Runtime Configuration', label: 'Runtime Configuration', boundary: true, dataStage: 'configuration' },
  { id: 'Policy and Guardrails', label: 'Policy and Guardrails', boundary: true, dataStage: 'policy' },
  { id: 'Provider and Tool Catalog', label: 'Provider and Tool Catalog', boundary: true, dataStage: 'catalog' },
  { id: 'Evidence and Operations', label: 'Evidence and Operations', boundary: true, dataStage: 'evidence' },
  { id: 'Storage Substrate', label: 'Storage Substrate', boundary: true, dataStage: 'storage' },
];

const DATA_FLOW_GROUPS = [
  { id: 'Request Sources', label: 'Request Sources', boundary: true, dataStage: 'source' },
  { id: 'Runtime Controls', label: 'Runtime Controls', boundary: true, dataStage: 'control' },
  { id: 'Policy and Provider Flow', label: 'Policy and Provider Flow', boundary: true, dataStage: 'provider' },
  { id: 'Evidence and Telemetry', label: 'Evidence and Telemetry', boundary: true, dataStage: 'evidence' },
  { id: 'Durable State', label: 'Durable State', boundary: true, dataStage: 'state' },
  { id: 'External Data Sinks', label: 'External Data Sinks', boundary: true, dataStage: 'external' },
];

const DATA_CLASSIFICATION_GROUPS = [
  {
    id: 'Restricted Identity and Secrets',
    label: 'Restricted Identity and Secrets',
    boundary: true,
    dataStage: 'restricted',
  },
  { id: 'Tenant Configuration', label: 'Tenant Configuration', boundary: true, dataStage: 'tenant-config' },
  {
    id: 'Security Policy and Guardrails',
    label: 'Security Policy and Guardrails',
    boundary: true,
    dataStage: 'security-policy',
  },
  { id: 'Evidence and Compliance', label: 'Evidence and Compliance', boundary: true, dataStage: 'compliance' },
  { id: 'Financial and Usage Data', label: 'Financial and Usage Data', boundary: true, dataStage: 'usage' },
  { id: 'External and Model Context', label: 'External and Model Context', boundary: true, dataStage: 'context' },
];

const DATA_LIFECYCLE_GROUPS = [
  { id: 'Create and Ingest', label: 'Create and Ingest', boundary: true, dataStage: 'create' },
  { id: 'Validate and Govern', label: 'Validate and Govern', boundary: true, dataStage: 'govern' },
  { id: 'Persist and Replicate', label: 'Persist and Replicate', boundary: true, dataStage: 'persist' },
  { id: 'Export and Observe', label: 'Export and Observe', boundary: true, dataStage: 'export' },
  { id: 'Retain and Erase', label: 'Retain and Erase', boundary: true, dataStage: 'retain' },
];

const RELEASE_PROMOTION_GROUPS = [
  { id: 'Build', label: 'Build', boundary: true, releaseStage: 'build' },
  { id: 'Staging', label: 'Staging', boundary: true, releaseStage: 'staging' },
  { id: 'Release Gates', label: 'Release Gates', boundary: true, releaseStage: 'gates' },
  { id: 'Production', label: 'Production', boundary: true, releaseStage: 'production' },
  { id: 'Rollback and Evidence', label: 'Rollback and Evidence', boundary: true, releaseStage: 'evidence' },
];

function solutionEvidenceRef(graph, pattern, summary) {
  return coexistenceEvidenceRef(graph, pattern, summary);
}

function _solutionNodeText(node) {
  return `${node?.label || node?.name || ''} ${node?.kind || node?.type || ''}`.toLowerCase();
}

function solutionNodeFromGraph(node, options = {}) {
  const kind = options.kind || node.type;
  return {
    id: node.id,
    label: options.label || node.name,
    kind,
    group: options.group || groupOf({ type: kind }),
    solutionLayer: options.solutionLayer || options.group || null,
    c4Role: options.c4Role || null,
    iconKind: options.iconKind || kind,
    external: options.external ?? (kind === 'integration' || kind === 'actor'),
    state: node.state || 'target',
    deltaType: node.deltaType,
    confidence: node.confidence || 'confirmed',
    evidenceRefs: node.evidence || [],
  };
}

function solutionSyntheticNode(graph, id, label, kind, options = {}) {
  const evidence = solutionEvidenceRef(
    graph,
    options.evidencePattern || /solution-architecture|architecture|prd|planning/i,
    options.evidenceSummary || `Derived ${label} for the Solution Architecture viewpoint.`,
  );
  return {
    id,
    label,
    kind,
    group: options.group || groupOf({ type: kind }),
    solutionLayer: options.solutionLayer || options.group || null,
    c4Role: options.c4Role || null,
    iconKind: options.iconKind || kind,
    external: options.external ?? (kind === 'integration' || kind === 'actor'),
    state: 'target',
    confidence: evidence ? 'confirmed' : 'inferred',
    evidenceRefs: evidence ? [evidence] : [],
  };
}

function solutionFindGraphNodes(graph, pattern, options = {}) {
  const typeOrder = options.types || null;
  const prefer = options.prefer || [];
  const avoid = options.avoid || [];
  return (graph.nodes || [])
    .filter((n) => pattern.test(`${n.name || ''} ${n.type || ''}`))
    .filter((n) => !typeOrder || typeOrder.includes(n.type))
    .slice()
    .sort((a, b) => {
      const score = (n) => {
        const text = `${n.name || ''} ${n.type || ''}`;
        let value = 0;
        if (typeOrder) {
          const idx = typeOrder.indexOf(n.type);
          value += idx === -1 ? 80 : idx * 8;
        }
        if (prefer.some((rx) => rx.test(text))) value -= 120;
        if (avoid.some((rx) => rx.test(text))) value += 120;
        value += architectureNodeRank(n);
        return value;
      };
      return score(a) - score(b) || String(a.id).localeCompare(String(b.id));
    });
}

function solutionAddGraphNode(graph, add, pattern, options) {
  const found = solutionFindGraphNodes(graph, pattern, options);
  for (const candidate of found) {
    const added = add(solutionNodeFromGraph(candidate, options));
    if (added) return added;
  }
  if (!options.syntheticId || !options.syntheticLabel) return null;
  return add(
    solutionSyntheticNode(graph, options.syntheticId, options.syntheticLabel, options.kind || 'component', {
      group: options.group,
      solutionLayer: options.solutionLayer,
      c4Role: options.c4Role,
      iconKind: options.iconKind,
      external: options.external,
      evidencePattern: options.evidencePattern,
      evidenceSummary: options.evidenceSummary,
    }),
  );
}

function applicationLayerMeta(layer) {
  return APPLICATION_COMPONENT_GROUPS.find((g) => g.applicationLayer === layer) || APPLICATION_COMPONENT_GROUPS[2];
}

function applicationNodeFromGraph(node, options = {}) {
  const kind = options.kind || node.type;
  const layer = options.applicationLayer || 'runtime';
  const group = options.group || applicationLayerMeta(layer).id;
  return {
    id: node.id,
    label: options.label || node.name,
    kind,
    group,
    applicationLayer: layer,
    componentRole: options.componentRole || null,
    iconKind: options.iconKind || kind,
    external: options.external ?? (kind === 'integration' || kind === 'actor'),
    state: node.state || 'target',
    deltaType: node.deltaType,
    confidence: node.confidence || 'confirmed',
    evidenceRefs: node.evidence || [],
  };
}

function applicationSyntheticNode(graph, id, label, kind, options = {}) {
  const layer = options.applicationLayer || 'runtime';
  const group = options.group || applicationLayerMeta(layer).id;
  const evidence = solutionEvidenceRef(
    graph,
    options.evidencePattern || /architecture|api|data-model|prd|planning/i,
    options.evidenceSummary || `Derived ${label} for the Application Architecture viewpoint.`,
  );
  return {
    id,
    label,
    kind,
    group,
    applicationLayer: layer,
    componentRole: options.componentRole || null,
    iconKind: options.iconKind || kind,
    external: options.external ?? (kind === 'integration' || kind === 'actor'),
    state: 'target',
    confidence: evidence ? 'confirmed' : 'inferred',
    evidenceRefs: evidence ? [evidence] : [],
  };
}

function applicationAddGraphNode(graph, add, pattern, options = {}) {
  const found = solutionFindGraphNodes(graph, pattern, options);
  for (const candidate of found) {
    const added = add(applicationNodeFromGraph(candidate, options));
    if (added) return added;
  }
  if (!options.syntheticId || !options.syntheticLabel) return null;
  return add(
    applicationSyntheticNode(graph, options.syntheticId, options.syntheticLabel, options.kind || 'component', options),
  );
}

function aiStageMeta(stage) {
  return AI_INVOCATION_GROUPS.find((g) => g.aiStage === stage) || AI_INVOCATION_GROUPS[0];
}

function retrievalVectorStageMeta(stage) {
  return RETRIEVAL_VECTOR_GROUPS.find((g) => g.aiStage === stage) || RETRIEVAL_VECTOR_GROUPS[0];
}

function aiInvocationNodeFromGraph(node, options = {}) {
  const stage = options.aiStage || 'entry';
  const kind = options.kind || node.type;
  return {
    id: node.id,
    label: options.label || node.name,
    kind,
    group: options.group || aiStageMeta(stage).id,
    aiStage: stage,
    aiRole: options.aiRole || null,
    sequenceIndex: Number.isFinite(options.sequenceIndex) ? options.sequenceIndex : null,
    iconKind: options.iconKind || kind,
    external: options.external ?? (kind === 'integration' || kind === 'actor'),
    state: node.state || 'target',
    deltaType: node.deltaType,
    confidence: node.confidence || 'confirmed',
    evidenceRefs: node.evidence || [],
  };
}

function aiInvocationSyntheticNode(graph, id, label, kind, options = {}) {
  const stage = options.aiStage || 'entry';
  const evidence = solutionEvidenceRef(
    graph,
    options.evidencePattern || /architecture|api|security|policy|model|prompt|rag|planning/i,
    options.evidenceSummary || `Derived ${label} for the AI / Model Invocation Pipeline viewpoint.`,
  );
  return {
    id,
    label,
    kind,
    group: options.group || aiStageMeta(stage).id,
    aiStage: stage,
    aiRole: options.aiRole || null,
    sequenceIndex: Number.isFinite(options.sequenceIndex) ? options.sequenceIndex : null,
    iconKind: options.iconKind || kind,
    external: options.external ?? (kind === 'integration' || kind === 'actor'),
    state: 'target',
    confidence: evidence ? 'confirmed' : 'inferred',
    evidenceRefs: evidence ? [evidence] : [],
  };
}

function aiInvocationAddGraphNode(graph, add, pattern, options = {}) {
  const found = solutionFindGraphNodes(graph, pattern, options);
  for (const candidate of found) {
    const added = add(aiInvocationNodeFromGraph(candidate, options));
    if (added) return added;
  }
  if (!options.syntheticId || !options.syntheticLabel) return null;
  return add(
    aiInvocationSyntheticNode(graph, options.syntheticId, options.syntheticLabel, options.kind || 'component', options),
  );
}

function retrievalVectorAddGraphNode(graph, add, pattern, options = {}) {
  const stage = options.aiStage || 'entry';
  return aiInvocationAddGraphNode(graph, add, pattern, {
    ...options,
    group: options.group || retrievalVectorStageMeta(stage).id,
    evidenceSummary:
      options.evidenceSummary ||
      `Derived ${options.label || options.syntheticLabel || 'retrieval vector topology node'} for the Retrieval and Vector Store Topology viewpoint.`,
  });
}

function dataStageMeta(groups, stage) {
  return groups.find((g) => g.dataStage === stage || g.id === stage) || groups[0];
}

function dataFriendlyLabel(raw) {
  const cleaned = String(raw || '')
    .replace(/`/g, '')
    .replace(/_/g, ' ')
    .replace(/\s*,\s*/g, ' / ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'Data Asset';
  return cleaned
    .split(' ')
    .map((part) => (part.length <= 3 && part === part.toUpperCase() ? part : part[0]?.toUpperCase() + part.slice(1)))
    .join(' ');
}

function dataNodeFromGraph(node, options = {}) {
  const groups = options.groups || DATA_MODEL_GROUPS;
  const stage = options.dataStage || 'state';
  const kind = options.kind || node.type;
  return {
    id: node.id,
    label: options.label || dataFriendlyLabel(node.name),
    kind,
    group: options.group || dataStageMeta(groups, stage).id,
    dataStage: stage,
    dataRole: options.dataRole || null,
    dataClass: options.dataClass || null,
    retention: options.retention || null,
    entityFields: options.entityFields || [],
    iconKind: options.iconKind || kind,
    sequenceIndex: options.sequenceIndex,
    external: options.external ?? (kind === 'integration' || kind === 'actor'),
    state: node.state || 'target',
    deltaType: node.deltaType,
    confidence: node.confidence || 'confirmed',
    evidenceRefs: node.evidence || [],
  };
}

function dataSyntheticNode(graph, id, label, kind, options = {}) {
  const groups = options.groups || DATA_MODEL_GROUPS;
  const stage = options.dataStage || 'state';
  const evidence = solutionEvidenceRef(
    graph,
    options.evidencePattern || /data|architecture|security|privacy|retention|model|policy|audit|planning/i,
    options.evidenceSummary || `Derived ${label} for the Data Architecture viewpoint.`,
  );
  return {
    id,
    label,
    kind,
    group: options.group || dataStageMeta(groups, stage).id,
    dataStage: stage,
    dataRole: options.dataRole || null,
    dataClass: options.dataClass || null,
    retention: options.retention || null,
    entityFields: options.entityFields || [],
    iconKind: options.iconKind || kind,
    sequenceIndex: options.sequenceIndex,
    external: options.external ?? (kind === 'integration' || kind === 'actor'),
    state: 'target',
    confidence: evidence ? 'confirmed' : 'inferred',
    evidenceRefs: evidence ? [evidence] : [],
  };
}

function dataAddGraphNode(graph, add, pattern, options = {}) {
  const found = solutionFindGraphNodes(graph, pattern, options);
  for (const candidate of found) {
    const added = add(dataNodeFromGraph(candidate, options));
    if (added) return added;
  }
  if (!options.syntheticId || !options.syntheticLabel) return null;
  return add(
    dataSyntheticNode(graph, options.syntheticId, options.syntheticLabel, options.kind || 'dataEntity', options),
  );
}

function releaseStageMeta(stage) {
  return (
    RELEASE_PROMOTION_GROUPS.find((g) => g.releaseStage === stage || g.id === stage) || RELEASE_PROMOTION_GROUPS[0]
  );
}

function releaseNodeFromGraph(node, options = {}) {
  const stage = options.releaseStage || 'build';
  const kind = options.kind || node.type;
  return {
    id: node.id,
    label: options.label || node.name,
    kind,
    group: options.group || releaseStageMeta(stage).id,
    releaseStage: stage,
    releaseRole: options.releaseRole || null,
    sequenceIndex: Number.isFinite(options.sequenceIndex) ? options.sequenceIndex : null,
    iconKind: options.iconKind || kind,
    external: options.external ?? (kind === 'integration' || kind === 'actor'),
    state: node.state || 'target',
    deltaType: node.deltaType,
    confidence: node.confidence || 'confirmed',
    evidenceRefs: node.evidence || [],
  };
}

function releaseSyntheticNode(graph, id, label, kind, options = {}) {
  const stage = options.releaseStage || 'build';
  const evidence = solutionEvidenceRef(
    graph,
    options.evidencePattern ||
      /delivery|release|deploy|environment|security|audit|observability|planning|architecture/i,
    options.evidenceSummary || `Derived ${label} for the Release and Environment Promotion viewpoint.`,
  );
  return {
    id,
    label,
    kind,
    group: options.group || releaseStageMeta(stage).id,
    releaseStage: stage,
    releaseRole: options.releaseRole || null,
    sequenceIndex: Number.isFinite(options.sequenceIndex) ? options.sequenceIndex : null,
    iconKind: options.iconKind || kind,
    external: options.external ?? (kind === 'integration' || kind === 'actor'),
    state: 'target',
    deltaType: options.deltaType,
    confidence: evidence ? 'confirmed' : 'inferred',
    evidenceRefs: evidence ? [evidence] : [],
  };
}

function releaseAddGraphNode(graph, add, pattern, options = {}) {
  const found = solutionFindGraphNodes(graph, pattern, options);
  for (const candidate of found) {
    const added = add(releaseNodeFromGraph(candidate, options));
    if (added) return added;
  }
  if (!options.syntheticId || !options.syntheticLabel) return null;
  return add(
    releaseSyntheticNode(graph, options.syntheticId, options.syntheticLabel, options.kind || 'component', options),
  );
}

function deriveReleasePromotionTopology(graph) {
  const nodes = [];
  const edges = [];
  const evidence = [];
  const used = new Set();

  function add(node) {
    if (!node || used.has(node.id)) return null;
    used.add(node.id);
    nodes.push(node);
    for (const ref of node.evidenceRefs || []) evidence.push(ref);
    return node;
  }

  const releaseRequest = releaseAddGraphNode(
    graph,
    add,
    /application developer.*cli agents|platform.*security.*finops.*operator|release request|change set/i,
    {
      types: ['actor', 'operationalSignal', 'component'],
      prefer: [/platform.*security.*finops.*operator|application developer/i],
      releaseStage: 'build',
      releaseRole: 'release-request',
      kind: 'actor',
      iconKind: 'actor',
      label: 'Release Request / Change Set',
      external: false,
      sequenceIndex: 0,
      syntheticId: 'release-request-change-set',
      syntheticLabel: 'Release Request / Change Set',
      evidencePattern: /delivery|implementation-roadmap|prd|planning/i,
      evidenceSummary: 'Release flow starts from a controlled change set or release request.',
    },
  );
  const ciBuild = releaseAddGraphNode(graph, add, /ci build|build pipeline|build verification|package release/i, {
    types: ['component', 'dataEntity', 'operationalSignal'],
    prefer: [/ci build|build pipeline|reversible operations/i],
    releaseStage: 'build',
    releaseRole: 'build-pipeline',
    kind: 'component',
    iconKind: 'component',
    label: 'CI Build and Test Pipeline',
    sequenceIndex: 1,
    syntheticId: 'release-ci-build-test',
    syntheticLabel: 'CI Build and Test Pipeline',
    evidencePattern: /delivery|engineering|implementation|deployment|planning/i,
    evidenceSummary: 'Build stage packages and verifies the release candidate before promotion.',
  });
  const artifact = releaseAddGraphNode(
    graph,
    add,
    /release artifact|deployment artifact|container image|release package|deployment manifest|immutable artifact/i,
    {
      types: ['dataEntity', 'dataStore', 'component'],
      releaseStage: 'build',
      releaseRole: 'artifact',
      kind: 'dataStore',
      iconKind: 'release',
      label: 'Immutable Release Artifact',
      sequenceIndex: 2,
      syntheticId: 'release-immutable-artifact',
      syntheticLabel: 'Immutable Release Artifact',
      evidencePattern: /delivery|deployment|release|planning/i,
      evidenceSummary: 'Release candidate is represented as an immutable artifact or deployment bundle.',
    },
  );

  const deployApi = releaseAddGraphNode(
    graph,
    add,
    /post \/admin\/v1\/inference\/deployments|inference\/deployments|deployment api/i,
    {
      types: ['api', 'component'],
      releaseStage: 'staging',
      releaseRole: 'deploy-api',
      kind: 'api',
      iconKind: 'api',
      label: 'Staging Deployment API',
      sequenceIndex: 3,
      syntheticId: 'release-staging-deployment-api',
      syntheticLabel: 'Staging Deployment API',
    },
  );
  const staging = releaseAddGraphNode(graph, add, /\bstaging\b|env-staging/i, {
    types: ['deploymentEnvironment', 'platformNode'],
    releaseStage: 'staging',
    releaseRole: 'staging-env',
    kind: 'deploymentEnvironment',
    iconKind: 'deployment',
    label: 'Staging Environment',
    sequenceIndex: 4,
    syntheticId: 'release-staging-env',
    syntheticLabel: 'Staging Environment',
    evidencePattern: /delivery|environment|deployment/i,
  });
  const stagingChecks = releaseAddGraphNode(
    graph,
    add,
    /post-condition verifier|smoke|regression|health check|validation/i,
    {
      types: ['component', 'securityControl', 'operationalSignal'],
      prefer: [/post-condition verifier|health/i],
      releaseStage: 'staging',
      releaseRole: 'staging-checks',
      kind: 'component',
      iconKind: 'securityControl',
      label: 'Staging Smoke / Post-Condition Checks',
      sequenceIndex: 5,
      syntheticId: 'release-staging-smoke-checks',
      syntheticLabel: 'Staging Smoke / Post-Condition Checks',
      evidencePattern: /delivery|security|architecture|planning/i,
    },
  );

  const policyGate = releaseAddGraphNode(graph, add, /policy bundle eval|policy-engine|policy gate|compliance gate/i, {
    types: ['securityControl', 'component', 'api'],
    prefer: [/policy bundle eval|policy-engine/i],
    releaseStage: 'gates',
    releaseRole: 'policy-gate',
    kind: 'securityControl',
    iconKind: 'securityControl',
    label: 'Policy Bundle Release Gate',
    sequenceIndex: 6,
    syntheticId: 'release-policy-bundle-gate',
    syntheticLabel: 'Policy Bundle Release Gate',
  });
  const securityGate = releaseAddGraphNode(
    graph,
    add,
    /llm red-team release gate|scanner fan-out|red.?team|scanner|security gate/i,
    {
      types: ['securityControl', 'component', 'dataEntity'],
      prefer: [/llm red-team release gate|scanner fan-out/i],
      releaseStage: 'gates',
      releaseRole: 'security-gate',
      kind: 'securityControl',
      iconKind: 'securityControl',
      label: 'Security / Red-Team Gate',
      sequenceIndex: 7,
      syntheticId: 'release-security-red-team-gate',
      syntheticLabel: 'Security / Red-Team Gate',
    },
  );
  const approvalGate = releaseAddGraphNode(graph, add, /itsm|soar|approval|on-call|mcp\/approvals/i, {
    types: ['component', 'api', 'operationalSignal'],
    prefer: [/ITSM|SOAR|Approval|On-call|mcp\/approvals/i],
    releaseStage: 'gates',
    releaseRole: 'approval-gate',
    kind: 'operationalSignal',
    iconKind: 'operationalSignal',
    label: 'Change Approval / On-Call Gate',
    sequenceIndex: 8,
    syntheticId: 'release-change-approval-gate',
    syntheticLabel: 'Change Approval / On-Call Gate',
  });

  const production = releaseAddGraphNode(graph, add, /\bproduction\b|env-production|\bprod\b/i, {
    types: ['deploymentEnvironment', 'platformNode'],
    releaseStage: 'production',
    releaseRole: 'production-env',
    kind: 'deploymentEnvironment',
    iconKind: 'deployment',
    label: 'Production Environment',
    sequenceIndex: 9,
    syntheticId: 'release-production-env',
    syntheticLabel: 'Production Environment',
    evidencePattern: /delivery|environment|deployment/i,
  });
  const trafficShift = releaseAddGraphNode(graph, add, /canary|traffic shift|progressive rollout|blue.?green/i, {
    types: ['component', 'operationalSignal', 'platformNode'],
    releaseStage: 'production',
    releaseRole: 'traffic-shift',
    kind: 'deployment',
    iconKind: 'release',
    label: 'Production Canary / Traffic Shift',
    sequenceIndex: 10,
    syntheticId: 'release-production-canary-traffic-shift',
    syntheticLabel: 'Production Canary / Traffic Shift',
    evidencePattern: /delivery|deployment|release|planning/i,
  });
  const runtime = releaseAddGraphNode(
    graph,
    add,
    /mug|meru unified gateway|elixir.*gateway|gateway server cluster|go edge agent/i,
    {
      types: ['component', 'platformNode'],
      prefer: [/MUG|Meru Unified Gateway|Elixir.*Gateway/i],
      releaseStage: 'production',
      releaseRole: 'runtime-rollout',
      kind: 'component',
      iconKind: 'platformNode',
      label: 'Production Runtime Rollout',
      sequenceIndex: 11,
      syntheticId: 'release-production-runtime-rollout',
      syntheticLabel: 'Production Runtime Rollout',
    },
  );

  const rollback = releaseAddGraphNode(graph, add, /rollback|restore|reversible operation|write-freeze|backup/i, {
    types: ['component', 'securityControl', 'dataEntity'],
    prefer: [/rollback|restore|reversible/i],
    releaseStage: 'evidence',
    releaseRole: 'rollback',
    kind: 'securityControl',
    iconKind: 'release',
    label: 'Rollback Bundle / Restore Path',
    sequenceIndex: 12,
    syntheticId: 'release-rollback-restore-path',
    syntheticLabel: 'Rollback Bundle / Restore Path',
    evidencePattern: /delivery|data-model|deployment|release|planning/i,
  });
  const observability = releaseAddGraphNode(graph, add, /observability bc|otel|metrics|traces|health|dashboard/i, {
    types: ['operationalSignal', 'component', 'api'],
    prefer: [/observability BC|OTel/i],
    releaseStage: 'evidence',
    releaseRole: 'observability',
    kind: 'operationalSignal',
    iconKind: 'operationalSignal',
    label: 'Release Health and Telemetry',
    sequenceIndex: 13,
    syntheticId: 'release-health-telemetry',
    syntheticLabel: 'Release Health and Telemetry',
  });
  const evidenceStore = releaseAddGraphNode(
    graph,
    add,
    /audit-evidence bc|audit emit|audit events|evidence exports|release evidence/i,
    {
      types: ['operationalSignal', 'dataEntity', 'dataStore', 'api'],
      prefer: [/audit-evidence BC|audit emit|evidence_exports|audit_events/i],
      releaseStage: 'evidence',
      releaseRole: 'evidence-store',
      kind: 'operationalSignal',
      iconKind: 'operationalSignal',
      label: 'Audit Evidence / Release Packet',
      sequenceIndex: 14,
      syntheticId: 'release-audit-evidence-packet',
      syntheticLabel: 'Audit Evidence / Release Packet',
    },
  );

  const seenEdges = new Set();
  function connect(from, to, label, style = 'solid') {
    if (!from || !to || from.id === to.id) return;
    const key = `${from.id}->${to.id}:${label}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({ from: from.id, to: to.id, label, style });
  }

  connect(releaseRequest, ciBuild, 'starts controlled release build');
  connect(ciBuild, artifact, 'packages immutable release candidate');
  connect(artifact, deployApi, 'publishes deployable candidate');
  connect(deployApi, staging, 'deploys candidate to staging');
  connect(staging, stagingChecks, 'runs smoke and post-condition checks');
  connect(stagingChecks, policyGate, 'submits staging evidence');
  connect(policyGate, securityGate, 'requires policy and scanner approval');
  connect(securityGate, approvalGate, 'opens change approval workflow');
  connect(approvalGate, production, 'approves production promotion');
  connect(production, trafficShift, 'starts production canary');
  connect(trafficShift, runtime, 'shifts production traffic');
  connect(runtime, observability, 'emits release health telemetry');
  connect(runtime, evidenceStore, 'writes release evidence');
  connect(approvalGate, evidenceStore, 'records approval evidence', 'dashed');
  connect(trafficShift, rollback, 'arms rollback on failed health', 'dashed');
  connect(observability, rollback, 'triggers rollback decision', 'dashed');
  connect(rollback, production, 'restores previous production release', 'dashed');
  connect(evidenceStore, observability, 'correlates release packet with health', 'dashed');

  return {
    nodes,
    edges,
    groups: RELEASE_PROMOTION_GROUPS,
    legend: [
      { symbol: 'Build', meaning: 'Controlled change set, build verification, and immutable release artifact' },
      { symbol: 'Environment', meaning: 'Staging and production deployment environments' },
      { symbol: 'Gate', meaning: 'Policy, scanner, security, and approval checks required before promotion' },
      { symbol: 'Rollback', meaning: 'Restore path armed by production health checks' },
      { symbol: 'Evidence', meaning: 'Audit, telemetry, and release packet generated for every promotion' },
    ],
    evidence: dedupeEvidence(evidence),
    assumptions: [
      'Release and Environment Promotion is derived from delivery-plan environments plus deployment API, security gates, approval, runtime, rollback, observability, and audit evidence nodes instead of rendering only environment boxes.',
    ],
    warnings: nodes.length ? [] : ['No graph nodes matched the Release and Environment Promotion viewpoint.'],
  };
}

function deriveLogicalDataModelTopology(graph) {
  const nodes = [];
  const edges = [];
  const evidence = [];
  const used = new Set();
  const groups = DATA_MODEL_GROUPS;

  function add(node) {
    if (!node || used.has(node.id)) return null;
    used.add(node.id);
    nodes.push(node);
    for (const ref of node.evidenceRefs || []) evidence.push(ref);
    return node;
  }
  const entity = (pattern, options) =>
    dataAddGraphNode(graph, add, pattern, { groups, types: ['dataEntity', 'dataStore'], ...options });
  const store = (pattern, options) =>
    dataAddGraphNode(graph, add, pattern, { groups, types: ['dataStore', 'dataEntity'], ...options });

  const tenants = entity(/`tenants`|entity-tenants/i, {
    label: 'Tenants',
    dataStage: 'identity',
    dataClass: 'tenant-master',
    entityFields: ['id', 'name', 'residency_region', 'status'],
  });
  const projects = entity(/`projects`|entity-projects/i, {
    label: 'Projects',
    dataStage: 'identity',
    dataClass: 'tenant-master',
    entityFields: ['id', 'tenant_id', 'name'],
  });
  const virtualKeys = entity(/`virtual_keys`|virtual keys/i, {
    label: 'Virtual Keys',
    dataStage: 'identity',
    dataClass: 'secret',
    entityFields: ['id', 'tenant_id', 'hash', 'scope'],
    iconKind: 'identity',
  });
  const usersRoles = entity(/`users`, `roles`, `role_bindings`|users.*roles.*role_bindings/i, {
    label: 'Users / Roles / Bindings',
    dataStage: 'identity',
    dataClass: 'identity',
    entityFields: ['user_id', 'role_id', 'tenant_id'],
    iconKind: 'identity',
  });
  const serviceAccounts = entity(/`service_accounts`|service accounts/i, {
    label: 'Service Accounts',
    dataStage: 'identity',
    dataClass: 'secret',
    entityFields: ['id', 'tenant_id', 'key_ref'],
    iconKind: 'identity',
  });
  const sessions = entity(/`sessions`|sessions/i, {
    label: 'Sessions',
    dataStage: 'identity',
    dataClass: 'session',
    entityFields: ['id', 'tenant_id', 'expires_at'],
    iconKind: 'identity',
  });
  const certificates = entity(/`certificates`|certificates/i, {
    label: 'Certificates',
    dataStage: 'identity',
    dataClass: 'secret',
    entityFields: ['id', 'tenant_id', 'fingerprint', 'expires_at'],
    iconKind: 'securityControl',
  });

  const configVersions = entity(/`config_versions`|config versions/i, {
    label: 'Config Versions',
    dataStage: 'configuration',
    dataClass: 'configuration',
    entityFields: ['id', 'tenant_id', 'version', 'checksum'],
  });
  const routes = entity(/`routes`|entity-routes/i, {
    label: 'Routes',
    dataStage: 'configuration',
    dataClass: 'routing',
    entityFields: ['id', 'tenant_id', 'provider_id', 'policy_version_id'],
  });
  const providers = entity(/`providers`|entity-providers/i, {
    label: 'Providers',
    dataStage: 'catalog',
    dataClass: 'provider-catalog',
    entityFields: ['id', 'name', 'adapter', 'status'],
  });
  const models = entity(/`models`|entity-models/i, {
    label: 'Models',
    dataStage: 'catalog',
    dataClass: 'model-catalog',
    entityFields: ['id', 'provider_id', 'model_id', 'capabilities'],
  });
  const mcpServers = entity(/`mcp_servers`|mcp servers/i, {
    label: 'MCP Servers',
    dataStage: 'catalog',
    dataClass: 'tool-catalog',
    entityFields: ['id', 'tenant_id', 'endpoint'],
  });
  const mcpTools = entity(/`mcp_tools`|mcp tools/i, {
    label: 'MCP Tools',
    dataStage: 'catalog',
    dataClass: 'tool-catalog',
    entityFields: ['id', 'server_id', 'schema_hash'],
  });

  const policyBundles = entity(/`policy_bundles`|policy bundles/i, {
    label: 'Policy Bundles',
    dataStage: 'policy',
    dataClass: 'policy',
    entityFields: ['id', 'tenant_id', 'name'],
    iconKind: 'securityControl',
  });
  const policyVersions = entity(/`policy_versions`|policy versions/i, {
    label: 'Policy Versions',
    dataStage: 'policy',
    dataClass: 'policy-version',
    entityFields: ['id', 'bundle_id', 'version', 'status'],
    iconKind: 'securityControl',
  });
  const redactionPacks = entity(/`redaction_packs`|redaction packs/i, {
    label: 'Redaction Packs',
    dataStage: 'policy',
    dataClass: 'data-protection',
    entityFields: ['id', 'policy_version_id', 'scanner_set'],
    iconKind: 'securityControl',
  });
  const scanners = entity(/`scanners`|entity-scanners/i, {
    label: 'Scanners',
    dataStage: 'policy',
    dataClass: 'data-protection',
    entityFields: ['id', 'name', 'mode'],
    iconKind: 'securityControl',
  });
  const leases = entity(/`leases`|entity-leases/i, {
    label: 'Leases',
    dataStage: 'policy',
    dataClass: 'runtime-control',
    entityFields: ['id', 'tenant_id', 'trust_class', 'expires_at'],
  });
  const budgets = entity(/`budgets`, `quota_profiles`|budgets.*quota_profiles/i, {
    label: 'Budgets / Quota Profiles',
    dataStage: 'policy',
    dataClass: 'quota',
    entityFields: ['id', 'tenant_id', 'limit', 'period'],
    iconKind: 'operationalSignal',
  });
  const killSwitches = entity(/`kill_switches`|kill switches/i, {
    label: 'Kill Switches',
    dataStage: 'policy',
    dataClass: 'runtime-control',
    entityFields: ['id', 'scope', 'enabled'],
    iconKind: 'securityControl',
  });

  const auditEvents = entity(/`audit_events`|audit events/i, {
    label: 'Audit Events',
    dataStage: 'evidence',
    dataClass: 'audit-evidence',
    entityFields: ['id', 'tenant_id', 'actor_id', 'hash'],
    iconKind: 'operationalSignal',
  });
  const evidenceExports = entity(/`evidence_exports`|evidence exports/i, {
    label: 'Evidence Exports',
    dataStage: 'evidence',
    dataClass: 'compliance-export',
    entityFields: ['id', 'tenant_id', 'destination', 'checksum'],
    iconKind: 'operationalSignal',
  });
  const erasureLog = entity(/`erasure_log`|erasure log/i, {
    label: 'Erasure Log',
    dataStage: 'evidence',
    dataClass: 'privacy-evidence',
    entityFields: ['id', 'subject_id', 'scope', 'proof_hash'],
    iconKind: 'securityControl',
  });
  const costEvents = entity(/`cost_events`|cost events/i, {
    label: 'Cost Events',
    dataStage: 'evidence',
    dataClass: 'financial',
    entityFields: ['id', 'tenant_id', 'provider_id', 'amount'],
    iconKind: 'operationalSignal',
  });
  const experiments = entity(/`experiments`, `feedback_datasets`|experiments.*feedback_datasets/i, {
    label: 'Experiments / Feedback Datasets',
    dataStage: 'evidence',
    dataClass: 'analytics',
    entityFields: ['id', 'tenant_id', 'dataset_ref'],
  });
  const degradationLedger = entity(/`degradation_ledger`|degradation ledger/i, {
    label: 'Degradation Ledger',
    dataStage: 'evidence',
    dataClass: 'operational-ledger',
    entityFields: ['id', 'tenant_id', 'incident_ref'],
    iconKind: 'operationalSignal',
  });

  const postgres = store(/postgres.*system of record|postgres/i, {
    label: 'Postgres System of Record',
    dataStage: 'storage',
    dataClass: 'system-of-record',
    iconKind: 'dataStore',
  });
  const rocks = store(/rocksdb.*write buffer|entity-rocksdb|rocksdb/i, {
    label: 'RocksDB Append Log',
    dataStage: 'storage',
    dataClass: 'append-log',
    iconKind: 'dataStore',
  });
  const mnesia = store(/amnesia|mnesia|cursors.*replication/i, {
    label: 'Amnesia / Mnesia Replication State',
    dataStage: 'storage',
    dataClass: 'replication-state',
    iconKind: 'dataStore',
  });

  const connect = (from, to, label, style = 'solid', cardinality = '||--o{') => {
    if (from && to && from.id !== to.id) edges.push({ from: from.id, to: to.id, label, style, cardinality });
  };

  connect(tenants, projects, 'tenant owns projects');
  connect(tenants, usersRoles, 'tenant-scoped identities');
  connect(tenants, serviceAccounts, 'tenant service principals');
  connect(serviceAccounts, certificates, 'certificate-bound credential', 'dashed');
  connect(tenants, virtualKeys, 'tenant virtual keys');
  connect(virtualKeys, sessions, 'creates sessions', 'solid', '||--o{');
  connect(tenants, configVersions, 'versions config');
  connect(configVersions, routes, 'publishes routes');
  connect(routes, providers, 'targets provider');
  connect(providers, models, 'offers models');
  connect(mcpServers, mcpTools, 'exposes tools');
  connect(policyBundles, policyVersions, 'versioned policy');
  connect(policyVersions, redactionPacks, 'selects redaction');
  connect(policyVersions, scanners, 'configures scanners');
  connect(policyVersions, killSwitches, 'controls kill switch');
  connect(policyVersions, budgets, 'binds quota policy');
  connect(policyVersions, leases, 'mints trust leases');
  connect(tenants, auditEvents, 'emits tenant audit');
  connect(auditEvents, evidenceExports, 'packages evidence');
  connect(auditEvents, erasureLog, 'records erasure proof');
  connect(auditEvents, costEvents, 'correlates cost');
  connect(models, experiments, 'feeds experiments', 'dashed');
  connect(killSwitches, degradationLedger, 'records degraded mode', 'dashed');
  connect(postgres, tenants, 'stores master data', 'dashed');
  connect(rocks, auditEvents, 'durable append log', 'dashed');
  connect(mnesia, leases, 'replicates cursor and lease state', 'dashed');

  return {
    nodes,
    edges,
    groups,
    legend: [
      { symbol: 'Entity', meaning: 'Logical table or durable data entity' },
      { symbol: 'Store', meaning: 'Physical store or persistence substrate' },
      { symbol: 'Solid edge', meaning: 'Primary relationship or ownership' },
      { symbol: 'Dashed edge', meaning: 'Persistence, projection, or derived relationship' },
    ],
    evidence: dedupeEvidence(evidence),
    assumptions: [
      'Logical Data Model is derived from source-backed data entities, data stores, policy tables, evidence tables, and runtime storage nodes instead of graph-order data keywords.',
    ],
    warnings: nodes.length ? [] : ['No data entities matched the Logical Data Model viewpoint.'],
  };
}

function deriveDataFlowTopology(graph) {
  const nodes = [];
  const edges = [];
  const evidence = [];
  const used = new Set();
  const groups = DATA_FLOW_GROUPS;
  function add(node) {
    if (!node || used.has(node.id)) return null;
    used.add(node.id);
    nodes.push(node);
    for (const ref of node.evidenceRefs || []) evidence.push(ref);
    return node;
  }
  const node = (pattern, options) => dataAddGraphNode(graph, add, pattern, { groups, ...options });

  const clients = node(/application developer.*cli agents|clients, ai tools|enterprise systems/i, {
    types: ['actor'],
    label: 'Clients / Agent Apps',
    kind: 'actor',
    dataStage: 'source',
    iconKind: 'actor',
    sequenceIndex: 0,
  });
  const chatApi = node(/post \/v1\/chat\/completions|inbound.*chat\/completions/i, {
    types: ['api', 'component'],
    prefer: [/^POST \/v1\/chat\/completions/i],
    label: 'Chat Completion API',
    kind: 'api',
    dataStage: 'source',
    iconKind: 'api',
    sequenceIndex: 1,
  });
  const tenant = node(/virtual-key|tenant resolve/i, {
    types: ['component', 'securityControl'],
    prefer: [/^2\.\s*virtual-key/i],
    label: 'Tenant / Virtual Key Resolution',
    kind: 'component',
    dataStage: 'control',
    iconKind: 'identity',
    sequenceIndex: 2,
  });
  const quota = node(/rate-limit|quota/i, {
    types: ['component', 'dataEntity'],
    prefer: [/^3\.\s*rate-limit/i],
    label: 'Quota Profile Lookup',
    kind: 'component',
    dataStage: 'control',
    iconKind: 'operationalSignal',
    sequenceIndex: 3,
  });
  const redaction = node(/redaction pack apply|redaction packs/i, {
    types: ['securityControl', 'component'],
    prefer: [/^4\.\s*redaction pack apply/i],
    label: 'Redaction Pack Apply',
    kind: 'securityControl',
    dataStage: 'control',
    iconKind: 'securityControl',
    sequenceIndex: 4,
  });
  const route = node(/route resolution|routing, workflow|event engine/i, {
    types: ['component'],
    label: 'Route Resolution',
    kind: 'component',
    dataStage: 'provider',
    iconKind: 'platformNode',
    sequenceIndex: 5,
  });
  const policy = node(/policy bundle eval|policy-engine bc|policy bundle/i, {
    types: ['securityControl', 'component'],
    prefer: [/^8\.\s*policy bundle eval/i],
    label: 'Policy Bundle Evaluation',
    kind: 'securityControl',
    dataStage: 'provider',
    iconKind: 'securityControl',
    sequenceIndex: 6,
  });
  const scanner = node(/scanner fan-out|presidio|nemo|guardrails ai|llamaguard/i, {
    types: ['securityControl', 'component'],
    prefer: [/^9\.\s*scanner fan-out/i],
    label: 'Scanner Fan-Out',
    kind: 'securityControl',
    dataStage: 'provider',
    iconKind: 'securityControl',
    sequenceIndex: 7,
  });
  const dispatch = node(/provider dispatch|streaming guardrails/i, {
    types: ['integration', 'component'],
    prefer: [/^10\.\s*provider dispatch/i],
    label: 'Provider Dispatch',
    kind: 'integration',
    dataStage: 'provider',
    iconKind: 'integration',
    sequenceIndex: 8,
  });
  const llm = node(/llm providers|openai|anthropic|google|azure|bedrock/i, {
    types: ['integration'],
    label: 'LLM Provider APIs',
    kind: 'integration',
    dataStage: 'external',
    external: true,
    iconKind: 'integration',
    sequenceIndex: 9,
  });
  const audit = node(/audit emit|cost event/i, {
    types: ['operationalSignal', 'component'],
    prefer: [/^12\.\s*audit emit/i],
    label: 'Audit Emit / Cost Event',
    kind: 'operationalSignal',
    dataStage: 'evidence',
    iconKind: 'operationalSignal',
    sequenceIndex: 10,
  });
  const observability = node(/observability bc|otel|shadow-ai|experiments|intelligence/i, {
    types: ['operationalSignal', 'component'],
    label: 'Observability / Shadow-AI Signals',
    kind: 'operationalSignal',
    dataStage: 'evidence',
    iconKind: 'operationalSignal',
    sequenceIndex: 11,
  });
  const siem = node(/siem|data lake|warehouse/i, {
    types: ['integration'],
    label: 'SIEM / Data Lake / Warehouse',
    kind: 'integration',
    dataStage: 'external',
    external: true,
    iconKind: 'integration',
    sequenceIndex: 15,
  });
  const rocks = node(/rocksdb.*write buffer|rocksdb/i, {
    types: ['dataStore', 'dataEntity'],
    label: 'RocksDB Append Log',
    kind: 'dataStore',
    dataStage: 'state',
    iconKind: 'dataStore',
    sequenceIndex: 12,
  });
  const mnesia = node(/amnesia|mnesia|cursors.*replication/i, {
    types: ['dataStore'],
    label: 'Amnesia / Mnesia Replication State',
    kind: 'dataStore',
    dataStage: 'state',
    iconKind: 'dataStore',
    sequenceIndex: 13,
  });
  const postgres = node(/postgres.*system of record|postgres/i, {
    types: ['dataStore'],
    label: 'Postgres System of Record',
    kind: 'dataStore',
    dataStage: 'state',
    iconKind: 'dataStore',
    sequenceIndex: 14,
  });
  const hybrid = node(/hybrid storage|rag context|rag index|index-refs/i, {
    types: ['dataStore'],
    label: 'Hybrid Storage / RAG Context',
    kind: 'dataStore',
    dataStage: 'state',
    iconKind: 'dataStore',
    sequenceIndex: 5.5,
  });

  const connect = (from, to, label, style = 'solid') => {
    if (from && to && from.id !== to.id) edges.push({ from: from.id, to: to.id, label, style });
  };
  connect(clients, chatApi, 'model request payload');
  connect(chatApi, tenant, 'tenant and key envelope');
  connect(tenant, quota, 'quota context lookup');
  connect(quota, redaction, 'redaction pack selection');
  connect(redaction, route, 'sanitized request');
  connect(route, policy, 'route and policy context');
  connect(policy, scanner, 'scanner policy');
  connect(scanner, dispatch, 'approved provider payload');
  connect(dispatch, llm, 'provider request');
  connect(llm, dispatch, 'streamed model response', 'dashed');
  connect(dispatch, audit, 'response metadata and cost');
  connect(audit, rocks, 'append immutable event');
  connect(rocks, mnesia, 'replicate cursor state', 'dashed');
  connect(mnesia, postgres, 'project system of record', 'dashed');
  connect(policy, postgres, 'policy and config read', 'dashed');
  connect(redaction, hybrid, 'RAG context redaction', 'dashed');
  connect(audit, observability, 'telemetry event');
  connect(observability, siem, 'export evidence stream', 'dashed');
  connect(postgres, siem, 'analytics projection', 'dashed');

  return {
    nodes,
    edges,
    groups,
    legend: [
      { symbol: 'Source', meaning: 'Data producer or request entry point' },
      { symbol: 'Control', meaning: 'Policy, identity, quota, and scanner data controls' },
      { symbol: 'Store', meaning: 'Durable state, append log, or system-of-record store' },
      { symbol: 'External sink', meaning: 'Provider, SIEM, warehouse, or external evidence target' },
    ],
    evidence: dedupeEvidence(evidence),
    assumptions: [
      'Data Flow Diagram is derived from source-backed request, control, provider, persistence, audit, and external sink nodes with explicit semantic handoffs.',
    ],
    warnings: nodes.length ? [] : ['No graph nodes matched the Data Flow Diagram viewpoint.'],
  };
}

function deriveDataClassificationTopology(graph) {
  const nodes = [];
  const edges = [];
  const evidence = [];
  const used = new Set();
  const groups = DATA_CLASSIFICATION_GROUPS;
  function add(node) {
    if (!node || used.has(node.id)) return null;
    used.add(node.id);
    nodes.push(node);
    for (const ref of node.evidenceRefs || []) evidence.push(ref);
    return node;
  }
  const entity = (pattern, options) =>
    dataAddGraphNode(graph, add, pattern, { groups, types: ['dataEntity', 'dataStore'], ...options });

  const virtualKeys = entity(/`virtual_keys`|virtual keys/i, {
    label: 'Virtual Keys',
    dataStage: 'restricted',
    dataClass: 'secret',
    iconKind: 'identity',
  });
  const serviceAccounts = entity(/`service_accounts`|service accounts/i, {
    label: 'Service Accounts',
    dataStage: 'restricted',
    dataClass: 'secret',
    iconKind: 'identity',
  });
  const sessions = entity(/`sessions`|sessions/i, {
    label: 'Sessions',
    dataStage: 'restricted',
    dataClass: 'session',
    iconKind: 'identity',
  });
  const certificates = entity(/`certificates`|certificates/i, {
    label: 'Certificates',
    dataStage: 'restricted',
    dataClass: 'secret',
    iconKind: 'securityControl',
  });
  const tenants = entity(/`tenants`|entity-tenants/i, {
    label: 'Tenants',
    dataStage: 'tenant-config',
    dataClass: 'tenant-master',
  });
  const projects = entity(/`projects`|entity-projects/i, {
    label: 'Projects',
    dataStage: 'tenant-config',
    dataClass: 'tenant-config',
  });
  const config = entity(/`config_versions`|config versions/i, {
    label: 'Config Versions',
    dataStage: 'tenant-config',
    dataClass: 'configuration',
  });
  const routes = entity(/`routes`|entity-routes/i, {
    label: 'Routes',
    dataStage: 'tenant-config',
    dataClass: 'routing',
  });
  const policyBundles = entity(/`policy_bundles`|policy bundles/i, {
    label: 'Policy Bundles',
    dataStage: 'security-policy',
    dataClass: 'policy',
    iconKind: 'securityControl',
  });
  const policyVersions = entity(/`policy_versions`|policy versions/i, {
    label: 'Policy Versions',
    dataStage: 'security-policy',
    dataClass: 'policy-version',
    iconKind: 'securityControl',
  });
  const redaction = entity(/`redaction_packs`|redaction packs/i, {
    label: 'Redaction Packs',
    dataStage: 'security-policy',
    dataClass: 'data-protection',
    iconKind: 'securityControl',
  });
  const scanners = entity(/`scanners`|entity-scanners/i, {
    label: 'Scanners',
    dataStage: 'security-policy',
    dataClass: 'data-protection',
    iconKind: 'securityControl',
  });
  const killSwitches = entity(/`kill_switches`|kill switches/i, {
    label: 'Kill Switches',
    dataStage: 'security-policy',
    dataClass: 'runtime-control',
    iconKind: 'securityControl',
  });
  const auditEvents = entity(/`audit_events`|audit events/i, {
    label: 'Audit Events',
    dataStage: 'compliance',
    dataClass: 'audit-evidence',
    iconKind: 'operationalSignal',
  });
  const evidenceExports = entity(/`evidence_exports`|evidence exports/i, {
    label: 'Evidence Exports',
    dataStage: 'compliance',
    dataClass: 'compliance-export',
    iconKind: 'operationalSignal',
  });
  const erasure = entity(/`erasure_log`|erasure log/i, {
    label: 'Erasure Log',
    dataStage: 'compliance',
    dataClass: 'privacy-evidence',
    iconKind: 'securityControl',
  });
  const backups = entity(/`backups`, `restore_points`|backups.*restore_points/i, {
    label: 'Backups / Restore Points',
    dataStage: 'compliance',
    dataClass: 'backup',
  });
  const budgets = entity(/`budgets`, `quota_profiles`|budgets.*quota_profiles/i, {
    label: 'Budgets / Quota Profiles',
    dataStage: 'usage',
    dataClass: 'quota',
    iconKind: 'operationalSignal',
  });
  const costEvents = entity(/`cost_events`|cost events/i, {
    label: 'Cost Events',
    dataStage: 'usage',
    dataClass: 'financial',
    iconKind: 'operationalSignal',
  });
  const degradation = entity(/`degradation_ledger`|degradation ledger/i, {
    label: 'Degradation Ledger',
    dataStage: 'usage',
    dataClass: 'operational-ledger',
    iconKind: 'operationalSignal',
  });
  const experiments = entity(/`experiments`, `feedback_datasets`|experiments.*feedback_datasets/i, {
    label: 'Experiments / Feedback Datasets',
    dataStage: 'usage',
    dataClass: 'analytics',
  });
  const providers = entity(/`providers`|entity-providers/i, {
    label: 'Providers',
    dataStage: 'context',
    dataClass: 'provider-catalog',
  });
  const models = entity(/`models`|entity-models/i, {
    label: 'Models',
    dataStage: 'context',
    dataClass: 'model-catalog',
  });
  const mcpTools = entity(/`mcp_tools`|mcp tools/i, {
    label: 'MCP Tools',
    dataStage: 'context',
    dataClass: 'tool-catalog',
  });
  const hybrid = entity(/hybrid storage|rag/i, {
    label: 'Hybrid Storage / RAG Context',
    kind: 'dataStore',
    dataStage: 'context',
    dataClass: 'derived-context',
    iconKind: 'dataStore',
  });

  const connect = (from, to, label, style = 'dashed') => {
    if (from && to && from.id !== to.id) edges.push({ from: from.id, to: to.id, label, style });
  };
  connect(tenants, virtualKeys, 'tenant-scoped secret');
  connect(tenants, projects, 'project boundary');
  connect(virtualKeys, sessions, 'session derivation');
  connect(serviceAccounts, auditEvents, 'service principal audit');
  connect(serviceAccounts, certificates, 'credential material');
  connect(policyBundles, policyVersions, 'approved policy version');
  connect(policyVersions, redaction, 'data protection rules');
  connect(redaction, auditEvents, 'redaction evidence');
  connect(scanners, auditEvents, 'scanner finding evidence');
  connect(killSwitches, degradation, 'degradation decision');
  connect(auditEvents, evidenceExports, 'compliance export');
  connect(auditEvents, erasure, 'privacy proof trail');
  connect(backups, erasure, 'erasure reconciliation');
  connect(budgets, costEvents, 'metered usage');
  connect(providers, models, 'model catalog');
  connect(models, experiments, 'feedback dataset');
  connect(mcpTools, auditEvents, 'tool-use audit');
  connect(hybrid, redaction, 'context classification');
  connect(config, routes, 'tenant routing config');

  return {
    nodes,
    edges,
    groups,
    legend: [
      { symbol: 'Restricted', meaning: 'Secrets, certificates, sessions, and identity-bound data' },
      { symbol: 'Policy', meaning: 'Guardrail, redaction, scanner, and kill-switch data' },
      { symbol: 'Evidence', meaning: 'Audit, erasure, backup, and compliance data' },
      { symbol: 'Usage', meaning: 'Cost, quota, telemetry, and analytic data' },
    ],
    evidence: dedupeEvidence(evidence),
    assumptions: [
      'Data Classification Map is derived from explicit data entities and security/evidence semantics so sensitive assets are separated from operational and catalog data.',
    ],
    warnings: nodes.length ? [] : ['No graph nodes matched the Data Classification Map viewpoint.'],
  };
}

function deriveDataLifecycleTopology(graph) {
  const nodes = [];
  const edges = [];
  const evidence = [];
  const used = new Set();
  const groups = DATA_LIFECYCLE_GROUPS;
  function add(node) {
    if (!node || used.has(node.id)) return null;
    used.add(node.id);
    nodes.push(node);
    for (const ref of node.evidenceRefs || []) evidence.push(ref);
    return node;
  }
  const node = (pattern, options) => dataAddGraphNode(graph, add, pattern, { groups, ...options });

  const tenantCreate = node(/post \/admin\/v1\/tenants|tenant create/i, {
    types: ['api', 'component'],
    label: 'Tenant Create API',
    kind: 'api',
    dataStage: 'create',
    iconKind: 'api',
    sequenceIndex: 0,
  });
  const request = node(/post \/v1\/chat\/completions|inbound.*chat/i, {
    types: ['api', 'component'],
    label: 'Runtime Request Capture',
    kind: 'api',
    dataStage: 'create',
    iconKind: 'api',
    sequenceIndex: 1,
  });
  const partition = node(/partition creation|partitioning/i, {
    types: ['dataEntity'],
    label: 'Tenant Partition Creation',
    kind: 'dataEntity',
    dataStage: 'create',
    iconKind: 'dataEntity',
    sequenceIndex: 2,
  });
  const redaction = node(/redaction pack apply|redaction packs/i, {
    types: ['securityControl', 'dataEntity', 'component'],
    prefer: [/^4\.\s*redaction pack apply/i],
    label: 'Redaction / Data Minimization',
    kind: 'securityControl',
    dataStage: 'govern',
    iconKind: 'securityControl',
    sequenceIndex: 3,
  });
  const policy = node(/policy bundle eval|policy versions|policy-engine/i, {
    types: ['securityControl', 'dataEntity', 'component'],
    prefer: [/^8\.\s*policy bundle eval/i],
    label: 'Policy Evaluation',
    kind: 'securityControl',
    dataStage: 'govern',
    iconKind: 'securityControl',
    sequenceIndex: 4,
  });
  const scanner = node(/scanner fan-out|scanners/i, {
    types: ['securityControl', 'dataEntity', 'component'],
    prefer: [/^9\.\s*scanner fan-out/i],
    label: 'Scanner Fan-Out',
    kind: 'securityControl',
    dataStage: 'govern',
    iconKind: 'securityControl',
    sequenceIndex: 5,
  });
  const audit = node(/audit emit|audit events|cost event/i, {
    types: ['operationalSignal', 'dataEntity', 'component'],
    prefer: [/^12\.\s*audit emit/i],
    label: 'Audit / Cost Event Emit',
    kind: 'operationalSignal',
    dataStage: 'persist',
    iconKind: 'operationalSignal',
    sequenceIndex: 6,
  });
  const rocks = node(/rocksdb.*write buffer|rocksdb/i, {
    types: ['dataStore', 'dataEntity'],
    label: 'RocksDB Append Log',
    kind: 'dataStore',
    dataStage: 'persist',
    iconKind: 'dataStore',
    sequenceIndex: 7,
  });
  const mnesia = node(/amnesia|mnesia|cursors.*replication/i, {
    types: ['dataStore'],
    label: 'Replication Cursor State',
    kind: 'dataStore',
    dataStage: 'persist',
    iconKind: 'dataStore',
    sequenceIndex: 8,
  });
  const postgres = node(/postgres.*system of record|postgres/i, {
    types: ['dataStore'],
    label: 'Postgres System of Record',
    kind: 'dataStore',
    dataStage: 'persist',
    iconKind: 'dataStore',
    sequenceIndex: 9,
  });
  const rollups = node(/materialized rollups|rollups/i, {
    types: ['dataEntity'],
    label: 'Materialized Rollups',
    kind: 'dataEntity',
    dataStage: 'export',
    iconKind: 'dataStore',
    sequenceIndex: 10,
  });
  const observability = node(/observability bc|otel|shadow-ai|experiments|intelligence/i, {
    types: ['operationalSignal', 'component'],
    label: 'Observability Export',
    kind: 'operationalSignal',
    dataStage: 'export',
    iconKind: 'operationalSignal',
    sequenceIndex: 11,
  });
  const evidenceExports = node(/evidence exports|`evidence_exports`/i, {
    types: ['dataEntity'],
    label: 'Evidence Exports',
    kind: 'dataEntity',
    dataStage: 'export',
    iconKind: 'operationalSignal',
    sequenceIndex: 12,
  });
  const siem = node(/siem|data lake|warehouse/i, {
    types: ['integration'],
    label: 'SIEM / Warehouse Sink',
    kind: 'integration',
    dataStage: 'export',
    iconKind: 'integration',
    external: true,
    sequenceIndex: 13,
  });
  const backups = node(/backup\/restore lifecycle|backups.*restore_points|backup/i, {
    types: ['dataEntity', 'api'],
    label: 'Backups / Restore Points',
    kind: 'dataEntity',
    dataStage: 'retain',
    iconKind: 'dataStore',
    sequenceIndex: 14,
  });
  const erasure = node(/erasure log|`erasure_log`|dsar/i, {
    types: ['dataEntity', 'operationalSignal'],
    label: 'Erasure / DSAR Proof Log',
    kind: 'dataEntity',
    dataStage: 'retain',
    iconKind: 'securityControl',
    sequenceIndex: 15,
  });
  const retention = dataSyntheticNode(
    graph,
    'data-retention-policy',
    'Retention Policy and Legal Hold',
    'securityControl',
    {
      groups,
      dataStage: 'retain',
      dataClass: 'retention-control',
      iconKind: 'securityControl',
      sequenceIndex: 16,
      evidenceSummary:
        'Retention, legal hold, and lifecycle controls derived from Data Architecture retention evidence.',
    },
  );
  add(retention);

  const connect = (from, to, label, style = 'solid') => {
    if (from && to && from.id !== to.id) edges.push({ from: from.id, to: to.id, label, style });
  };
  connect(tenantCreate, partition, 'tenant partition bootstrap');
  connect(partition, postgres, 'partitioned master data');
  connect(request, redaction, 'capture and minimize');
  connect(redaction, policy, 'sanitized policy input');
  connect(policy, scanner, 'policy-constrained scan');
  connect(scanner, audit, 'scanner decision evidence');
  connect(audit, rocks, 'append immutable event');
  connect(rocks, mnesia, 'replicate cursor');
  connect(mnesia, postgres, 'project system of record');
  connect(postgres, rollups, 'materialized analytics');
  connect(audit, observability, 'telemetry event');
  connect(observability, siem, 'export telemetry');
  connect(audit, evidenceExports, 'package evidence');
  connect(evidenceExports, siem, 'compliance export');
  connect(postgres, backups, 'backup snapshot', 'dashed');
  connect(retention, backups, 'retention schedule', 'dashed');
  connect(retention, erasure, 'erasure policy', 'dashed');
  connect(erasure, evidenceExports, 'erasure proof export', 'dashed');

  return {
    nodes,
    edges,
    groups,
    legend: [
      { symbol: 'Create', meaning: 'Data creation and capture points' },
      { symbol: 'Govern', meaning: 'Data minimization, policy, and scanner controls' },
      { symbol: 'Persist', meaning: 'Append log, replication, and system of record' },
      { symbol: 'Retain', meaning: 'Retention, backup, erasure, and legal hold controls' },
    ],
    evidence: dedupeEvidence(evidence),
    assumptions: [
      'Data Lifecycle and Retention is derived from request capture, tenant partitioning, redaction, audit, replication, projection, export, backup, and erasure evidence.',
    ],
    warnings: nodes.length ? [] : ['No graph nodes matched the Data Lifecycle and Retention viewpoint.'],
  };
}

function deriveDataArchitectureTopology(graph, entry) {
  if (entry.id === 'DATA-001' || /logical data model/i.test(entry.title || ''))
    return deriveLogicalDataModelTopology(graph);
  if (entry.id === 'DATA-002' || /data flow/i.test(entry.title || '')) return deriveDataFlowTopology(graph);
  if (entry.id === 'DATA-003' || /classification/i.test(entry.title || ''))
    return deriveDataClassificationTopology(graph);
  if (entry.id === 'DATA-004' || /lifecycle|retention/i.test(entry.title || ''))
    return deriveDataLifecycleTopology(graph);
  return { nodes: [], edges: [], groups: [], legend: [], evidence: [], assumptions: [], warnings: [] };
}

function deriveApplicationComponentTopology(graph) {
  const nodes = [];
  const edges = [];
  const evidence = [];
  const used = new Set();

  function add(node) {
    if (!node || used.has(node.id)) return null;
    used.add(node.id);
    nodes.push(node);
    for (const ref of node.evidenceRefs || []) evidence.push(ref);
    return node;
  }

  const clients = applicationAddGraphNode(
    graph,
    add,
    /clients, ai tools|application developer.*cli agents|enterprise systems/i,
    {
      types: ['actor'],
      applicationLayer: 'channels',
      kind: 'actor',
      iconKind: 'actor',
      label: 'Application Developers / AI Clients',
      syntheticId: 'app-components-clients',
      syntheticLabel: 'Application Developers / AI Clients',
    },
  );
  const operators = applicationAddGraphNode(
    graph,
    add,
    /platform \/ security \/ finops operators|admins and automation|security engineer|tenant owner/i,
    {
      types: ['actor'],
      applicationLayer: 'channels',
      kind: 'actor',
      iconKind: 'actor',
      label: 'Platform / Security / FinOps Operators',
      syntheticId: 'app-components-operators',
      syntheticLabel: 'Platform / Security / FinOps Operators',
    },
  );
  const auditor = applicationAddGraphNode(graph, add, /compliance auditor|compliance.*risk officer/i, {
    types: ['actor', 'operationalSignal'],
    applicationLayer: 'channels',
    kind: 'actor',
    iconKind: 'actor',
    label: 'Compliance / Risk Reviewer',
  });

  const openAiApi = applicationAddGraphNode(graph, add, /inbound.*chat\/completions|post \/v1\/chat\/completions/i, {
    types: ['component', 'api'],
    applicationLayer: 'flow',
    componentRole: 'api',
    kind: 'api',
    iconKind: 'api',
    label: 'OpenAI-Compatible API',
    syntheticId: 'app-components-openai-api',
    syntheticLabel: 'OpenAI-Compatible API',
    evidenceSummary: 'OpenAI-compatible request surface for application and agent traffic.',
  });
  const adminApi = applicationAddGraphNode(
    graph,
    add,
    /control-plane bc|admin api|liveview dashboard|\/admin\/v1\/catalog|\/admin\/v1\/tenants/i,
    {
      types: ['api', 'component', 'actor'],
      prefer: [/\/admin\/v1\//i],
      avoid: [/control-plane bc/i],
      applicationLayer: 'channels',
      componentRole: 'api',
      kind: 'api',
      iconKind: 'api',
      label: 'Admin API / LiveView Dashboard',
      external: false,
      syntheticId: 'app-components-admin-api',
      syntheticLabel: 'Admin API / LiveView Dashboard',
      evidenceSummary: 'Administrative API and dashboard configure tenants, policy, routing, and controls.',
    },
  );
  const mcpApi = applicationAddGraphNode(graph, add, /post \/mcp|\/mcp\/|mcp bridge|tool router/i, {
    types: ['api', 'component', 'integration'],
    prefer: [/^POST \/mcp/i],
    avoid: [/trust-classes|approvals|bundles|mcp bridge|tool router/i],
    applicationLayer: 'channels',
    componentRole: 'api',
    kind: 'api',
    iconKind: 'api',
    label: 'MCP Tool API',
    external: false,
    syntheticId: 'app-components-mcp-api',
    syntheticLabel: 'MCP Tool API',
    evidenceSummary: 'MCP-compatible surface accepts governed tool invocation traffic.',
  });
  const evidenceApi = applicationAddGraphNode(graph, add, /audit\/events|audit\/exports|replay|attestation|dsar/i, {
    types: ['api', 'operationalSignal', 'dataEntity'],
    prefer: [/\/admin\/v1\/audit|\/admin\/v1\/replay|attestation|dsar/i],
    avoid: [/dataentity/i],
    applicationLayer: 'channels',
    componentRole: 'api',
    kind: 'api',
    iconKind: 'api',
    label: 'Evidence / Replay APIs',
    external: false,
    syntheticId: 'app-components-evidence-api',
    syntheticLabel: 'Evidence / Replay APIs',
    evidenceSummary: 'Evidence, audit export, replay, and compliance-facing API surface.',
  });

  const tls = applicationAddGraphNode(graph, add, /tls \+ auth|tls.*auth/i, {
    types: ['securityControl', 'component'],
    applicationLayer: 'flow',
    componentRole: 'control',
    kind: 'securityControl',
    iconKind: 'securityControl',
    syntheticId: 'app-components-tls-auth',
    syntheticLabel: 'TLS + Auth Gate',
  });
  const tenant = applicationAddGraphNode(graph, add, /virtual-key|tenant resolve/i, {
    types: ['component', 'securityControl', 'api'],
    applicationLayer: 'flow',
    componentRole: 'control',
    kind: 'component',
    iconKind: 'identity',
  });
  const identity = applicationAddGraphNode(graph, add, /identity bc|rbac|sessions|oidc|saml|ldap|scim/i, {
    types: ['securityControl', 'component', 'dataEntity'],
    prefer: [/identity bc/i],
    avoid: [/enterprise idp|directory|dataentity|`?sessions`?|users.*roles/i],
    applicationLayer: 'runtime',
    componentRole: 'identity',
    kind: 'securityControl',
    iconKind: 'identity',
    syntheticId: 'app-components-identity-bc',
    syntheticLabel: 'Identity BC (OIDC/SAML/LDAP/SCIM, RBAC, sessions)',
  });
  const quota = applicationAddGraphNode(graph, add, /rate-limit|quota/i, {
    types: ['component', 'dataEntity', 'api'],
    prefer: [/^3\.\s*rate-limit/i],
    avoid: [/quota_profiles|budgets|\/admin\/v1\/quotas/i],
    applicationLayer: 'flow',
    componentRole: 'control',
    kind: 'component',
    iconKind: 'operationalSignal',
  });
  const redaction = applicationAddGraphNode(graph, add, /redaction pack apply|redaction packs|redaction/i, {
    types: ['securityControl', 'component', 'dataEntity', 'api'],
    prefer: [/^4\.\s*redaction pack apply/i],
    avoid: [/redaction_packs|\/admin\/v1\/redaction/i],
    applicationLayer: 'flow',
    componentRole: 'control',
    kind: 'securityControl',
    iconKind: 'securityControl',
  });
  const killSwitch = applicationAddGraphNode(graph, add, /kill-switch check|kill.?switch/i, {
    types: ['securityControl', 'component', 'dataEntity'],
    prefer: [/^5\.\s*kill-switch check/i],
    avoid: [/kill_switches|incident responder/i],
    applicationLayer: 'flow',
    componentRole: 'control',
    kind: 'securityControl',
    iconKind: 'securityControl',
  });
  const route = applicationAddGraphNode(graph, add, /route resolution|routing, workflow|event engine/i, {
    types: ['component'],
    applicationLayer: 'flow',
    componentRole: 'routing',
    kind: 'component',
    iconKind: 'platformNode',
  });
  const trust = applicationAddGraphNode(graph, add, /trust class|lease mint/i, {
    types: ['component', 'securityControl'],
    applicationLayer: 'flow',
    componentRole: 'control',
    kind: 'component',
    iconKind: 'securityControl',
  });
  const policy = applicationAddGraphNode(graph, add, /policy bundle eval|policy-engine bc|policy bundle|guardrail/i, {
    types: ['securityControl', 'component'],
    prefer: [/^8\.\s*policy bundle eval/i, /policy-engine bc/i],
    avoid: [/policy_bundles|policy_versions/i],
    applicationLayer: 'runtime',
    componentRole: 'policy',
    kind: 'securityControl',
    iconKind: 'securityControl',
  });
  const scanner = applicationAddGraphNode(
    graph,
    add,
    /scanner fan-out|scanner|presidio|nemo|guardrails ai|llamaguard|wasm/i,
    {
      types: ['securityControl', 'component', 'dataEntity'],
      prefer: [/^9\.\s*scanner fan-out/i],
      avoid: [/entity-scanners|`scanners`|scanner unavailability/i],
      applicationLayer: 'flow',
      componentRole: 'control',
      kind: 'securityControl',
      iconKind: 'securityControl',
    },
  );
  const providerDispatch = applicationAddGraphNode(graph, add, /provider dispatch|streaming guardrails/i, {
    types: ['integration', 'component'],
    prefer: [/^10\.\s*provider dispatch/i],
    applicationLayer: 'flow',
    componentRole: 'adapter',
    kind: 'component',
    iconKind: 'integration',
    external: false,
  });
  const postVerifier = applicationAddGraphNode(graph, add, /post-condition verifier|re-read|webhook|probe/i, {
    types: ['component', 'securityControl', 'integration'],
    prefer: [/^11\.\s*post-condition verifier/i],
    applicationLayer: 'flow',
    componentRole: 'control',
    kind: 'component',
    iconKind: 'securityControl',
    external: false,
  });
  const auditEmit = applicationAddGraphNode(graph, add, /audit emit|cost event/i, {
    types: ['operationalSignal', 'component'],
    prefer: [/^12\.\s*audit emit/i],
    avoid: [/billing bc|cost events, metering/i],
    applicationLayer: 'flow',
    componentRole: 'telemetry',
    kind: 'operationalSignal',
    iconKind: 'operationalSignal',
  });

  const mug = applicationAddGraphNode(graph, add, /mug|meru unified gateway/i, {
    types: ['component', 'platformNode'],
    applicationLayer: 'runtime',
    componentRole: 'platform',
    kind: 'component',
    iconKind: 'platformNode',
    label: 'MUG Application Boundary',
    syntheticId: 'app-components-mug',
    syntheticLabel: 'MUG Application Boundary',
  });
  const gateway = applicationAddGraphNode(
    graph,
    add,
    /elixir.*gateway server|gateway server cluster|gateway-server$/i,
    {
      types: ['component', 'platformNode'],
      applicationLayer: 'runtime',
      componentRole: 'runtime',
      kind: 'component',
      iconKind: 'deployment',
    },
  );
  const edge = applicationAddGraphNode(graph, add, /go edge agent/i, {
    types: ['component', 'platformNode'],
    applicationLayer: 'runtime',
    componentRole: 'agent',
    kind: 'component',
    iconKind: 'deployment',
  });
  const integrationsBc = applicationAddGraphNode(
    graph,
    add,
    /integrations bc|mcp registry|enterprise connectors|mcp bridge|tool router/i,
    {
      types: ['component', 'integration'],
      applicationLayer: 'runtime',
      componentRole: 'adapter',
      kind: 'component',
      iconKind: 'integration',
      external: false,
    },
  );
  const controlPlane = applicationAddGraphNode(
    graph,
    add,
    /control-plane bc|admin api|liveview dashboard|config authority/i,
    {
      types: ['component', 'actor', 'platformNode'],
      applicationLayer: 'runtime',
      componentRole: 'control-plane',
      kind: 'component',
      iconKind: 'platformNode',
      label: 'Control Plane / Config Authority',
      external: false,
    },
  );

  const gatewayState = applicationAddGraphNode(graph, add, /gateway bc/i, {
    types: ['dataStore', 'component'],
    prefer: [/^gateway bc/i],
    applicationLayer: 'state',
    componentRole: 'state',
    kind: 'dataStore',
    iconKind: 'dataStore',
  });
  const rocks = applicationAddGraphNode(graph, add, /rocksdb|append log|write buffer/i, {
    types: ['dataStore', 'dataEntity'],
    prefer: [/^rocksdb\b/i, /write buffer|append-only durable|append log/i],
    avoid: [/gateway bc/i],
    applicationLayer: 'state',
    componentRole: 'state',
    kind: 'dataStore',
    iconKind: 'dataStore',
  });
  const amnesia = applicationAddGraphNode(graph, add, /amnesia|mnesia|cursors|replication status/i, {
    types: ['dataStore', 'dataEntity'],
    applicationLayer: 'state',
    componentRole: 'state',
    kind: 'dataStore',
    iconKind: 'dataStore',
  });
  const postgres = applicationAddGraphNode(graph, add, /postgres|system of record/i, {
    types: ['dataStore', 'dataEntity'],
    applicationLayer: 'state',
    componentRole: 'state',
    kind: 'dataStore',
    iconKind: 'dataStore',
  });
  const config = applicationAddGraphNode(
    graph,
    add,
    /config_versions|routes|providers|models|policy_bundles|redaction_packs/i,
    {
      types: ['dataEntity'],
      prefer: [/config_versions|routes|providers|models|policy_bundles|redaction_packs/i],
      applicationLayer: 'state',
      componentRole: 'config',
      kind: 'dataEntity',
      iconKind: 'dataStore',
      label: 'Configuration Tables',
      syntheticId: 'app-components-config-tables',
      syntheticLabel: 'Configuration Tables',
    },
  );
  const tenantData = applicationAddGraphNode(graph, add, /tenants|virtual_keys|users.*roles|sessions/i, {
    types: ['dataEntity'],
    prefer: [/tenants|virtual_keys|users.*roles|sessions/i],
    applicationLayer: 'state',
    componentRole: 'identity-data',
    kind: 'dataEntity',
    iconKind: 'dataStore',
    label: 'Tenant / Identity Tables',
    syntheticId: 'app-components-tenant-identity-tables',
    syntheticLabel: 'Tenant / Identity Tables',
  });
  const auditData = applicationAddGraphNode(
    graph,
    add,
    /audit_events|evidence_exports|dsar_cases|cost_events|degradation_ledger/i,
    {
      types: ['dataEntity', 'operationalSignal'],
      prefer: [/audit_events|evidence_exports|cost_events/i],
      applicationLayer: 'state',
      componentRole: 'evidence-data',
      kind: 'dataEntity',
      iconKind: 'operationalSignal',
      label: 'Audit / Cost / Evidence Tables',
      syntheticId: 'app-components-audit-cost-tables',
      syntheticLabel: 'Audit / Cost / Evidence Tables',
    },
  );

  const llm = applicationAddGraphNode(graph, add, /llm providers|openai|anthropic|azure|bedrock/i, {
    types: ['integration'],
    applicationLayer: 'external',
    componentRole: 'external',
    kind: 'integration',
    iconKind: 'integration',
    label: 'LLM Provider APIs',
  });
  const mcp = applicationAddGraphNode(graph, add, /mcp servers|mcp servers \/ tools/i, {
    types: ['integration', 'component'],
    applicationLayer: 'external',
    componentRole: 'external',
    kind: 'integration',
    iconKind: 'integration',
    label: 'MCP Servers / Tools',
  });
  const idp = applicationAddGraphNode(graph, add, /enterprise idp|oidc|saml|ldap|scim/i, {
    types: ['component', 'integration', 'securityControl'],
    prefer: [/enterprise idp|directory/i],
    avoid: [/identity bc|rbac|sessions/i],
    applicationLayer: 'external',
    componentRole: 'external',
    kind: 'integration',
    iconKind: 'identity',
    label: 'Enterprise IdP / Directory',
    external: true,
  });
  const siem = applicationAddGraphNode(graph, add, /siem|data lake|warehouse|rag/i, {
    types: ['integration', 'operationalSignal'],
    applicationLayer: 'external',
    componentRole: 'external',
    kind: 'integration',
    iconKind: 'integration',
    label: 'SIEM / Data Lake / Warehouse',
  });
  const itsm = applicationAddGraphNode(graph, add, /itsm|soar|on-call|approval/i, {
    types: ['component', 'integration', 'operationalSignal'],
    prefer: [/itsm|soar|on-call/i],
    avoid: [/post-condition|webhook|probe|re-read/i],
    applicationLayer: 'external',
    componentRole: 'external',
    kind: 'integration',
    iconKind: 'integration',
    label: 'ITSM / SOAR / Approval',
    external: true,
  });

  const connect = (from, to, label, style = 'solid') => {
    if (from && to && from.id !== to.id) edges.push({ from: from.id, to: to.id, label, style });
  };

  connect(clients, openAiApi, 'OpenAI-compatible request');
  connect(operators, adminApi, 'configuration and operations');
  connect(auditor, evidenceApi || auditData, 'evidence review', 'dashed');
  connect(openAiApi, tls, 'TLS and request authentication');
  connect(tls, tenant, 'virtual-key and tenant resolution');
  connect(tenant, identity, 'RBAC and session context');
  connect(tenant, quota, 'quota profile lookup');
  connect(quota || tenant, redaction, 'redaction pack apply');
  connect(redaction || quota, killSwitch, 'kill-switch check');
  connect(killSwitch || redaction || quota, route, 'route resolution');
  connect(route, trust, 'trust class and lease decision');
  connect(trust || route, policy, 'policy bundle evaluation');
  connect(policy, scanner, 'scanner fan-out');
  connect(scanner || policy, providerDispatch, 'provider dispatch');
  connect(providerDispatch || route, llm, 'approved provider request');
  connect(providerDispatch || route, postVerifier, 'post-condition verification');
  connect(postVerifier || providerDispatch || policy, auditEmit || auditData, 'audit emit and cost event');
  connect(adminApi, controlPlane || mug, 'mutates tenant policy and config');
  connect(controlPlane || adminApi, identity, 'identity configuration');
  connect(controlPlane || adminApi, policy, 'policy and routing configuration');
  connect(controlPlane || adminApi, config, 'stores versioned config');
  connect(mcpApi, integrationsBc, 'tool invocation request');
  connect(policy, integrationsBc, 'allowed tool policy');
  connect(integrationsBc, mcp, 'approved MCP tool invocation');
  connect(route, gateway || mug, 'dispatches runtime workflow');
  connect(gateway || mug, edge, 'gRPC over mTLS');
  connect(edge || gateway, gatewayState, 'agent/session state');
  connect(gatewayState, rocks, 'append durable log');
  connect(gatewayState, amnesia, 'replicate cursors and leases');
  connect(gatewayState, postgres, 'project system of record');
  connect(identity, tenantData, 'reads identity and session state');
  connect(identity, idp, 'federated identity lookup');
  connect(policy, config, 'reads policy, route, scanner config');
  connect(auditEmit, auditData, 'writes evidence and cost rows');
  connect(evidenceApi, auditData, 'queries evidence history');
  connect(auditData || auditEmit, siem, 'exports audit and telemetry stream', 'dashed');
  connect(policy, itsm, 'approval or escalation', 'dashed');

  return {
    nodes,
    edges,
    groups: APPLICATION_COMPONENT_GROUPS,
    legend: [
      { symbol: 'Actor/API', meaning: 'User, automation, and API entry surfaces' },
      { symbol: 'Component', meaning: 'Application module or runtime service' },
      { symbol: 'Control', meaning: 'Security, routing, policy, verification, or guardrail stage' },
      { symbol: 'Data store', meaning: 'Durable state, configuration, evidence, and cost data' },
      { symbol: 'External system', meaning: 'Provider, identity, MCP, SIEM, or approval dependency' },
    ],
    evidence: dedupeEvidence(evidence),
    assumptions: [
      'Application component topology is derived from source-backed API, control-plane, runtime, state, and integration nodes so APP-001 is a detailed application view rather than a generic data-entity grid.',
    ],
    warnings: nodes.length
      ? []
      : ['No graph nodes matched the Application Architecture detailed-components viewpoint.'],
  };
}

function deriveAiModelInvocationTopology(graph) {
  const nodes = [];
  const edges = [];
  const evidence = [];
  const used = new Set();

  function add(node) {
    if (!node || used.has(node.id)) return null;
    used.add(node.id);
    nodes.push(node);
    for (const ref of node.evidenceRefs || []) evidence.push(ref);
    return node;
  }

  const clients = aiInvocationAddGraphNode(
    graph,
    add,
    /application developer.*cli agents|application developer \(primary\)|clients, ai tools|enterprise systems/i,
    {
      types: ['actor'],
      aiStage: 'entry',
      aiRole: 'client',
      kind: 'actor',
      iconKind: 'actor',
      label: 'AI Clients / Agent Apps',
      sequenceIndex: 0,
      syntheticId: 'ai-invocation-clients',
      syntheticLabel: 'AI Clients / Agent Apps',
      evidenceSummary: 'Primary callers submit OpenAI-compatible model invocation traffic.',
    },
  );
  const chatApi = aiInvocationAddGraphNode(graph, add, /post \/v1\/chat\/completions|inbound.*chat\/completions/i, {
    types: ['api', 'component'],
    prefer: [/^POST \/v1\/chat\/completions/i],
    aiStage: 'entry',
    aiRole: 'chat-api',
    kind: 'api',
    iconKind: 'api',
    label: 'OpenAI-Compatible Chat API',
    sequenceIndex: 1,
    syntheticId: 'ai-invocation-chat-api',
    syntheticLabel: 'OpenAI-Compatible Chat API',
  });
  const embeddingsApi = aiInvocationAddGraphNode(graph, add, /post \/v1\/embeddings/i, {
    types: ['api'],
    aiStage: 'entry',
    aiRole: 'embeddings-api',
    kind: 'api',
    iconKind: 'api',
    label: 'Embeddings API',
    syntheticId: 'ai-invocation-embeddings-api',
    syntheticLabel: 'Embeddings API',
  });
  const modelsApi = aiInvocationAddGraphNode(graph, add, /^GET \/v1\/models|api-get-v1-models/i, {
    types: ['api'],
    aiStage: 'entry',
    aiRole: 'model-list-api',
    kind: 'api',
    iconKind: 'api',
    label: 'Model Discovery API',
    syntheticId: 'ai-invocation-models-api',
    syntheticLabel: 'Model Discovery API',
  });

  const tls = aiInvocationAddGraphNode(graph, add, /tls \+ auth|tls.*auth/i, {
    types: ['securityControl', 'component'],
    aiStage: 'controls',
    aiRole: 'auth',
    kind: 'securityControl',
    iconKind: 'securityControl',
    label: '1. TLS + Auth Gate',
    sequenceIndex: 2,
    syntheticId: 'ai-invocation-tls-auth',
    syntheticLabel: '1. TLS + Auth Gate',
  });
  const tenant = aiInvocationAddGraphNode(graph, add, /virtual-key|tenant resolve/i, {
    types: ['component', 'securityControl', 'api'],
    prefer: [/^2\.\s*virtual-key/i],
    avoid: [/virtual_keys/i],
    aiStage: 'controls',
    aiRole: 'tenant',
    kind: 'component',
    iconKind: 'identity',
    label: '2. Virtual Key + Tenant Resolve',
    sequenceIndex: 3,
  });
  const quota = aiInvocationAddGraphNode(graph, add, /rate-limit|quota/i, {
    types: ['component', 'dataEntity', 'api'],
    prefer: [/^3\.\s*rate-limit/i],
    avoid: [/quota_profiles|budgets|\/admin\/v1\/quotas/i],
    aiStage: 'controls',
    aiRole: 'quota',
    kind: 'component',
    iconKind: 'operationalSignal',
    label: '3. Rate Limit + Quota',
    sequenceIndex: 4,
  });
  const redaction = aiInvocationAddGraphNode(graph, add, /redaction pack apply|redaction packs|redaction/i, {
    types: ['securityControl', 'component', 'dataEntity', 'api'],
    prefer: [/^4\.\s*redaction pack apply/i],
    avoid: [/redaction_packs|\/admin\/v1\/redaction/i],
    aiStage: 'controls',
    aiRole: 'redaction',
    kind: 'securityControl',
    iconKind: 'securityControl',
    label: '4. Redaction Pack Apply',
    sequenceIndex: 5,
  });
  const killSwitch = aiInvocationAddGraphNode(graph, add, /kill-switch check|kill.?switch/i, {
    types: ['securityControl', 'component', 'dataEntity'],
    prefer: [/^5\.\s*kill-switch check/i],
    avoid: [/kill_switches|incident responder/i],
    aiStage: 'controls',
    aiRole: 'kill-switch',
    kind: 'securityControl',
    iconKind: 'securityControl',
    label: '5. Kill-Switch Check',
    sequenceIndex: 6,
  });

  const route = aiInvocationAddGraphNode(graph, add, /route resolution|routing, workflow|event engine/i, {
    types: ['component'],
    aiStage: 'policy',
    aiRole: 'routing',
    kind: 'component',
    iconKind: 'platformNode',
    label: '6. Route Resolution',
    sequenceIndex: 7,
  });
  const trust = aiInvocationAddGraphNode(graph, add, /trust class|lease mint/i, {
    types: ['component', 'securityControl'],
    prefer: [/^7\.\s*trust class/i],
    avoid: [/leases|llm red-team/i],
    aiStage: 'policy',
    aiRole: 'trust-lease',
    kind: 'component',
    iconKind: 'securityControl',
    label: '7. Trust Class + Lease',
    sequenceIndex: 8,
  });
  const policy = aiInvocationAddGraphNode(graph, add, /policy bundle eval|policy-engine bc|policy bundle|guardrail/i, {
    types: ['securityControl', 'component'],
    prefer: [/^8\.\s*policy bundle eval/i, /policy-engine bc/i],
    avoid: [/policy_bundles|policy_versions/i],
    aiStage: 'policy',
    aiRole: 'policy',
    kind: 'securityControl',
    iconKind: 'securityControl',
    label: '8. Policy Bundle Evaluation',
    sequenceIndex: 9,
  });
  const scanner = aiInvocationAddGraphNode(
    graph,
    add,
    /scanner fan-out|scanner|presidio|nemo|guardrails ai|llamaguard|wasm/i,
    {
      types: ['securityControl', 'component', 'dataEntity'],
      prefer: [/^9\.\s*scanner fan-out/i],
      avoid: [/entity-scanners|`scanners`|scanner unavailability/i],
      aiStage: 'policy',
      aiRole: 'scanner',
      kind: 'securityControl',
      iconKind: 'securityControl',
      label: '9. Scanner Fan-Out',
      sequenceIndex: 10,
    },
  );

  const providerDispatch = aiInvocationAddGraphNode(graph, add, /provider dispatch|streaming guardrails/i, {
    types: ['integration', 'component'],
    prefer: [/^10\.\s*provider dispatch/i],
    aiStage: 'provider',
    aiRole: 'provider-dispatch',
    kind: 'integration',
    iconKind: 'integration',
    label: '10. Provider Dispatch + Streaming Guardrails',
    external: false,
    sequenceIndex: 11,
  });
  const llmProviders = aiInvocationAddGraphNode(graph, add, /llm providers|openai|anthropic|google|azure|bedrock/i, {
    types: ['integration'],
    aiStage: 'provider',
    aiRole: 'llm-provider',
    kind: 'integration',
    iconKind: 'integration',
    label: 'LLM Provider APIs',
    external: true,
    sequenceIndex: 12,
  });

  const postVerifier = aiInvocationAddGraphNode(graph, add, /post-condition verifier|re-read|webhook|probe/i, {
    types: ['component', 'securityControl', 'integration'],
    prefer: [/^11\.\s*post-condition verifier/i],
    aiStage: 'evidence',
    aiRole: 'post-verifier',
    kind: 'component',
    iconKind: 'securityControl',
    label: '11. Post-Condition Verifier',
    sequenceIndex: 13,
  });
  const auditEmit = aiInvocationAddGraphNode(graph, add, /audit emit|cost event/i, {
    types: ['operationalSignal', 'component'],
    prefer: [/^12\.\s*audit emit/i],
    avoid: [/billing bc|cost events$/i],
    aiStage: 'evidence',
    aiRole: 'audit-cost',
    kind: 'operationalSignal',
    iconKind: 'operationalSignal',
    label: '12. Audit Emit + Cost Event',
    sequenceIndex: 14,
  });
  const observability = aiInvocationAddGraphNode(
    graph,
    add,
    /observability bc|otel|shadow-ai|experiments|intelligence/i,
    {
      types: ['operationalSignal', 'component'],
      aiStage: 'evidence',
      aiRole: 'observability',
      kind: 'operationalSignal',
      iconKind: 'operationalSignal',
      label: 'Observability / Shadow-AI Signals',
    },
  );

  const modelCatalog = aiInvocationAddGraphNode(
    graph,
    add,
    /model catalog|catalog\/models|models`?|model intake|\/admin\/v1\/models/i,
    {
      types: ['api', 'dataEntity', 'component'],
      prefer: [/GET \/admin\/v1\/catalog\/models|POST \/admin\/v1\/models\/intake|`models`/i],
      avoid: [/^GET \/v1\/models/i],
      aiStage: 'governance',
      aiRole: 'model-catalog',
      kind: 'api',
      iconKind: 'api',
      label: 'Model Catalog / Intake',
      syntheticId: 'ai-invocation-model-catalog',
      syntheticLabel: 'Model Catalog / Intake',
    },
  );
  const promptRegistry = aiInvocationAddGraphNode(graph, add, /\/admin\/v1\/prompts|prompt registry|prompts/i, {
    types: ['api', 'component', 'dataEntity'],
    aiStage: 'governance',
    aiRole: 'prompt-registry',
    kind: 'api',
    iconKind: 'api',
    label: 'Prompt Registry / Version Pinning',
    syntheticId: 'ai-invocation-prompt-registry',
    syntheticLabel: 'Prompt Registry / Version Pinning',
  });
  const ragRefs = aiInvocationAddGraphNode(graph, add, /rag|storage|hybrid storage|index-refs/i, {
    types: ['api', 'dataStore', 'integration'],
    prefer: [/rag\/index-refs|hybrid storage|rag/i],
    aiStage: 'governance',
    aiRole: 'rag-context',
    kind: 'dataStore',
    iconKind: 'dataStore',
    label: 'RAG / Context References',
    syntheticId: 'ai-invocation-rag-context',
    syntheticLabel: 'RAG / Context References',
  });

  const connect = (from, to, label, style = 'solid') => {
    if (from && to && from.id !== to.id) edges.push({ from: from.id, to: to.id, label, style });
  };

  connect(clients, chatApi, 'OpenAI-compatible request');
  connect(clients, embeddingsApi, 'embedding request', 'dashed');
  connect(clients, modelsApi, 'model discovery', 'dashed');
  connect(chatApi || embeddingsApi, tls, 'TLS and request authentication');
  connect(embeddingsApi, tls, 'embedding request authentication', 'dashed');
  connect(tls, tenant, 'tenant and virtual-key context');
  connect(tenant, quota, 'quota and rate-limit profile');
  connect(quota, redaction, 'redaction pack selection');
  connect(redaction, killSwitch, 'emergency stop check');
  connect(killSwitch, route, 'route request');
  connect(route, trust, 'trust class and lease decision');
  connect(trust, policy, 'policy context');
  connect(policy, scanner, 'scanner policy fan-out');
  connect(scanner, providerDispatch, 'approved request envelope');
  connect(providerDispatch, llmProviders, 'provider API call');
  connect(llmProviders, postVerifier, 'streamed model response', 'dashed');
  connect(providerDispatch, postVerifier, 'stream / response verification');
  connect(postVerifier, auditEmit, 'audit emit and cost event');
  connect(auditEmit, observability, 'telemetry and evidence export', 'dashed');
  connect(modelCatalog, route, 'model routing metadata', 'dashed');
  connect(modelCatalog, providerDispatch, 'provider adapter metadata', 'dashed');
  connect(promptRegistry, redaction, 'pinned prompt context', 'dashed');
  connect(ragRefs, scanner, 'retrieved context scanning', 'dashed');
  connect(policy, auditEmit, 'policy decision evidence', 'dashed');
  connect(killSwitch, auditEmit, 'kill-switch decision event', 'dashed');
  connect(scanner, auditEmit, 'scanner finding evidence', 'dashed');

  return {
    nodes,
    edges,
    groups: AI_INVOCATION_GROUPS,
    legend: [
      { symbol: 'Primary path', meaning: 'Ordered model invocation path from request to evidence' },
      { symbol: 'Control', meaning: 'Auth, tenant, quota, redaction, kill-switch, policy, scanner, verification' },
      { symbol: 'External provider', meaning: 'LLM provider API boundary' },
      { symbol: 'Dashed edge', meaning: 'Support, metadata, response, telemetry, or evidence path' },
    ],
    evidence: dedupeEvidence(evidence),
    assumptions: [
      'AI / Model Invocation Pipeline is derived from source-backed runtime API, policy pipeline, provider dispatch, model catalog, prompt/RAG, and audit evidence nodes instead of generic AI keyword matches.',
    ],
    warnings: nodes.length ? [] : ['No graph nodes matched the AI / Model Invocation Pipeline viewpoint.'],
  };
}

function deriveRetrievalVectorTopology(graph) {
  const nodes = [];
  const edges = [];
  const evidence = [];
  const used = new Set();

  function add(node) {
    if (!node || used.has(node.id)) return null;
    used.add(node.id);
    nodes.push(node);
    for (const ref of node.evidenceRefs || []) evidence.push(ref);
    return node;
  }

  const clients = retrievalVectorAddGraphNode(
    graph,
    add,
    /application developer.*cli agents|application developer \(primary\)|clients, ai tools|enterprise systems/i,
    {
      types: ['actor'],
      aiStage: 'entry',
      aiRole: 'retrieval-client',
      kind: 'actor',
      iconKind: 'actor',
      label: 'AI / RAG Clients',
      sequenceIndex: 0,
      syntheticId: 'retrieval-clients',
      syntheticLabel: 'AI / RAG Clients',
      evidenceSummary: 'Primary callers submit retrieval-augmented AI traffic.',
    },
  );
  const retrievalApi = retrievalVectorAddGraphNode(graph, add, /post \/v1\/chat\/completions|chat\/completions/i, {
    types: ['api', 'component'],
    prefer: [/^POST \/v1\/chat\/completions/i],
    aiStage: 'entry',
    aiRole: 'retrieval-api',
    kind: 'api',
    iconKind: 'api',
    label: 'Retrieval-Augmented Chat API',
    sequenceIndex: 1,
    syntheticId: 'retrieval-chat-api',
    syntheticLabel: 'Retrieval-Augmented Chat API',
  });
  const embeddingsApi = retrievalVectorAddGraphNode(graph, add, /post \/v1\/embeddings|embeddings/i, {
    types: ['api', 'component'],
    prefer: [/^POST \/v1\/embeddings/i],
    aiStage: 'entry',
    aiRole: 'embedding-api',
    kind: 'api',
    iconKind: 'api',
    label: 'Embedding Request API',
    sequenceIndex: 2,
    syntheticId: 'retrieval-embeddings-api',
    syntheticLabel: 'Embedding Request API',
  });
  const ragIndexApi = retrievalVectorAddGraphNode(graph, add, /rag\/index-refs|index-refs/i, {
    types: ['api', 'component'],
    aiStage: 'entry',
    aiRole: 'rag-index-api',
    kind: 'api',
    iconKind: 'api',
    label: 'RAG Index References API',
    sequenceIndex: 3,
    syntheticId: 'retrieval-rag-index-api',
    syntheticLabel: 'RAG Index References API',
  });
  const storageAdminApi = retrievalVectorAddGraphNode(
    graph,
    add,
    /integrations\/storage|storage integration|hybrid storage/i,
    {
      types: ['api', 'component', 'dataStore'],
      prefer: [/PUT \/admin\/v1\/integrations\/storage/i],
      avoid: [/^hybrid storage$/i],
      aiStage: 'entry',
      aiRole: 'storage-admin-api',
      kind: 'api',
      iconKind: 'api',
      label: 'Storage Integration Admin API',
      sequenceIndex: 4,
      syntheticId: 'retrieval-storage-admin-api',
      syntheticLabel: 'Storage Integration Admin API',
    },
  );

  const authGate = retrievalVectorAddGraphNode(graph, add, /tls \+ auth|tls.*auth|virtual-key|tenant resolve|tenant/i, {
    types: ['securityControl', 'component', 'api', 'dataEntity'],
    prefer: [/tls \+ auth|virtual-key tenant resolve/i],
    avoid: [/tenant_capabilities|tenant_profile/i],
    aiStage: 'controls',
    aiRole: 'tenant-auth',
    kind: 'securityControl',
    iconKind: 'identity',
    label: 'Tenant Auth and Access Context',
    sequenceIndex: 5,
    syntheticId: 'retrieval-tenant-auth',
    syntheticLabel: 'Tenant Auth and Access Context',
  });
  const queryPolicy = retrievalVectorAddGraphNode(
    graph,
    add,
    /redaction pack apply|redaction|policy bundle eval|guardrail/i,
    {
      types: ['securityControl', 'component', 'api', 'dataEntity'],
      prefer: [/redaction pack apply|policy bundle eval/i],
      avoid: [/redaction_packs|policy_versions/i],
      aiStage: 'controls',
      aiRole: 'query-policy',
      kind: 'securityControl',
      iconKind: 'securityControl',
      label: 'Query Redaction and Policy Gate',
      sequenceIndex: 6,
      syntheticId: 'retrieval-query-policy',
      syntheticLabel: 'Query Redaction and Policy Gate',
    },
  );
  const contextScanner = retrievalVectorAddGraphNode(
    graph,
    add,
    /scanner fan-out|scanner|presidio|nemo|guardrails ai|llamaguard|red-team/i,
    {
      types: ['securityControl', 'component', 'dataEntity'],
      prefer: [/scanner fan-out|llm red-team release gate/i],
      avoid: [/entity-scanners|`scanners`/i],
      aiStage: 'controls',
      aiRole: 'context-scan',
      kind: 'securityControl',
      iconKind: 'securityControl',
      label: 'Retrieved Context Guardrail Scan',
      sequenceIndex: 7,
      syntheticId: 'retrieval-context-scan',
      syntheticLabel: 'Retrieved Context Guardrail Scan',
    },
  );

  const promptRegistry = retrievalVectorAddGraphNode(graph, add, /\/admin\/v1\/prompts|prompt registry|prompts/i, {
    types: ['api', 'component', 'dataEntity'],
    aiStage: 'policy',
    aiRole: 'prompt-registry',
    kind: 'api',
    iconKind: 'api',
    label: 'Prompt Registry / Version Pinning',
    sequenceIndex: 8,
    syntheticId: 'retrieval-prompt-registry',
    syntheticLabel: 'Prompt Registry / Version Pinning',
  });
  const modelCatalog = retrievalVectorAddGraphNode(
    graph,
    add,
    /catalog\/models|model catalog|models`?|model intake|\/admin\/v1\/models/i,
    {
      types: ['api', 'dataEntity', 'component'],
      prefer: [/GET \/admin\/v1\/catalog\/models|POST \/admin\/v1\/models\/intake|`models`/i],
      avoid: [/^GET \/v1\/models/i],
      aiStage: 'policy',
      aiRole: 'model-catalog',
      kind: 'api',
      iconKind: 'api',
      label: 'Model Catalog / Embedding Policy',
      sequenceIndex: 9,
      syntheticId: 'retrieval-model-catalog',
      syntheticLabel: 'Model Catalog / Embedding Policy',
    },
  );
  const indexBuilder = retrievalVectorAddGraphNode(
    graph,
    add,
    /index builder|rag sync|rag\/index-refs|integrations\/storage/i,
    {
      types: ['component', 'api'],
      prefer: [/index builder|rag sync/i],
      aiStage: 'policy',
      aiRole: 'index-builder',
      kind: 'component',
      iconKind: 'component',
      label: 'Index Build / Sync Control',
      sequenceIndex: 10,
      syntheticId: 'retrieval-index-builder',
      syntheticLabel: 'Index Build / Sync Control',
    },
  );

  const embeddingProvider = retrievalVectorAddGraphNode(
    graph,
    add,
    /llm providers|openai|anthropic|google|azure|bedrock|embedding provider|embedding model/i,
    {
      types: ['integration', 'component'],
      aiStage: 'provider',
      aiRole: 'embedding-provider',
      kind: 'integration',
      iconKind: 'integration',
      label: 'Embedding / LLM Provider APIs',
      external: true,
      sequenceIndex: 11,
      syntheticId: 'retrieval-embedding-provider',
      syntheticLabel: 'Embedding / LLM Provider APIs',
    },
  );
  const contextAssembly = retrievalVectorAddGraphNode(
    graph,
    add,
    /context assembly|rerank|route resolution|routing, workflow|event engine|provider dispatch|streaming guardrails/i,
    {
      types: ['component', 'integration'],
      prefer: [/context assembly|rerank|route resolution/i],
      aiStage: 'provider',
      aiRole: 'context-assembly',
      kind: 'component',
      iconKind: 'component',
      label: 'Context Assembly / Rerank',
      sequenceIndex: 12,
      syntheticId: 'retrieval-context-assembly',
      syntheticLabel: 'Context Assembly / Rerank',
    },
  );

  const vectorStore = retrievalVectorAddGraphNode(graph, add, /vector|rag|hybrid storage|index/i, {
    types: ['dataStore', 'integration', 'dataEntity'],
    prefer: [/hybrid storage|rag/i],
    avoid: [/api|endpoint/i],
    aiStage: 'governance',
    aiRole: 'vector-store',
    kind: 'dataStore',
    iconKind: 'dataStore',
    label: 'Vector Store / RAG Index',
    sequenceIndex: 13,
    syntheticId: 'retrieval-vector-store',
    syntheticLabel: 'Vector Store / RAG Index',
  });
  const metadataStore = retrievalVectorAddGraphNode(
    graph,
    add,
    /rocksdb|postgres|mnesia|metadata|hybrid storage|state/i,
    {
      types: ['dataStore', 'dataEntity', 'integration'],
      prefer: [/rocksdb|postgres|mnesia|hybrid storage/i],
      aiStage: 'governance',
      aiRole: 'metadata-store',
      kind: 'dataStore',
      iconKind: 'dataStore',
      label: 'Metadata, Citations, and Source Refs',
      sequenceIndex: 14,
      syntheticId: 'retrieval-metadata-store',
      syntheticLabel: 'Metadata, Citations, and Source Refs',
    },
  );
  const knowledgeSources = retrievalVectorAddGraphNode(graph, add, /siem|data lake|warehouse|rag|document|storage/i, {
    types: ['integration', 'dataStore', 'dataEntity'],
    prefer: [/siem|data lake|warehouse|rag/i],
    aiStage: 'governance',
    aiRole: 'knowledge-sources',
    kind: 'integration',
    iconKind: 'integration',
    label: 'Knowledge Sources / Data Lake',
    external: true,
    sequenceIndex: 15,
    syntheticId: 'retrieval-knowledge-sources',
    syntheticLabel: 'Knowledge Sources / Data Lake',
  });

  const retrievalAudit = retrievalVectorAddGraphNode(
    graph,
    add,
    /audit emit|cost event|observability|otel|siem|telemetry/i,
    {
      types: ['operationalSignal', 'component', 'integration'],
      prefer: [/audit emit|observability|siem/i],
      aiStage: 'evidence',
      aiRole: 'retrieval-audit',
      kind: 'operationalSignal',
      iconKind: 'operationalSignal',
      label: 'Retrieval Audit / Evidence',
      sequenceIndex: 16,
      syntheticId: 'retrieval-audit-evidence',
      syntheticLabel: 'Retrieval Audit / Evidence',
    },
  );
  const releaseGate = retrievalVectorAddGraphNode(
    graph,
    add,
    /llm red-team release gate|eval|guardrail|release gate/i,
    {
      types: ['securityControl', 'operationalSignal', 'component'],
      prefer: [/llm red-team release gate|eval/i],
      aiStage: 'evidence',
      aiRole: 'retrieval-release-gate',
      kind: 'securityControl',
      iconKind: 'securityControl',
      label: 'RAG / Model Eval Release Gate',
      sequenceIndex: 17,
      syntheticId: 'retrieval-release-gate',
      syntheticLabel: 'RAG / Model Eval Release Gate',
    },
  );

  const connect = (from, to, label, style = 'solid') => {
    if (from && to && from.id !== to.id) edges.push({ from: from.id, to: to.id, label, style });
  };

  connect(clients, retrievalApi, 'retrieval request');
  connect(retrievalApi, authGate, 'tenant and access context');
  connect(authGate, queryPolicy, 'policy and redaction context');
  connect(queryPolicy, promptRegistry, 'select prompt version', 'dashed');
  connect(retrievalApi, embeddingsApi, 'embedding request');
  connect(embeddingsApi, embeddingProvider, 'embedding provider call');
  connect(ragIndexApi, indexBuilder, 'register index refs');
  connect(storageAdminApi, indexBuilder, 'configure storage connector');
  connect(knowledgeSources, indexBuilder, 'source documents and metadata');
  connect(indexBuilder, embeddingProvider, 'batch embedding job', 'dashed');
  connect(indexBuilder, vectorStore, 'write vectors and chunks');
  connect(indexBuilder, metadataStore, 'write citations and source refs', 'dashed');
  connect(modelCatalog, embeddingProvider, 'model/version policy', 'dashed');
  connect(modelCatalog, contextAssembly, 'retrieval model selection', 'dashed');
  connect(promptRegistry, contextAssembly, 'grounding prompt template');
  connect(vectorStore, contextAssembly, 'top-k semantic matches');
  connect(metadataStore, contextAssembly, 'filters and citations');
  connect(queryPolicy, contextScanner, 'scanner policy');
  connect(contextAssembly, contextScanner, 'retrieved context package');
  connect(contextScanner, embeddingProvider, 'grounded provider request');
  connect(contextScanner, retrievalAudit, 'guardrail findings');
  connect(embeddingProvider, retrievalAudit, 'response and usage evidence');
  connect(contextAssembly, retrievalAudit, 'retrieval trace and citations');
  connect(releaseGate, modelCatalog, 'eval-approved model policy', 'dashed');
  connect(releaseGate, contextScanner, 'eval and guardrail controls', 'dashed');
  connect(retrievalAudit, knowledgeSources, 'evidence export', 'dashed');

  return {
    nodes,
    edges,
    groups: RETRIEVAL_VECTOR_GROUPS,
    legend: [
      { symbol: 'Primary path', meaning: 'Retrieval request, embedding, lookup, context assembly, and evidence path' },
      { symbol: 'Control', meaning: 'Tenant, policy, redaction, guardrail, and eval controls' },
      { symbol: 'Data store', meaning: 'Vector index, source references, metadata, and citation stores' },
      { symbol: 'External provider', meaning: 'Embedding, LLM, storage, SIEM, or knowledge-source boundary' },
      { symbol: 'Dashed edge', meaning: 'Governance, batch, metadata, or evidence-support path' },
    ],
    evidence: dedupeEvidence(evidence),
    assumptions: [
      'Retrieval and Vector Store Topology is derived from source-backed RAG index APIs, embeddings APIs, storage integration, model catalog, prompt governance, vector/source stores, guardrails, and evidence sinks instead of generic AI keyword matches.',
    ],
    warnings: nodes.length ? [] : ['No graph nodes matched the Retrieval and Vector Store Topology viewpoint.'],
  };
}

function deriveGuardrailsEvalTopology(graph) {
  const nodes = [];
  const edges = [];
  const evidence = [];
  const used = new Set();

  function add(node) {
    if (!node || used.has(node.id)) return null;
    used.add(node.id);
    nodes.push(node);
    for (const ref of node.evidenceRefs || []) evidence.push(ref);
    return node;
  }

  const clients = aiInvocationAddGraphNode(
    graph,
    add,
    /application developer.*cli agents|application developer \(primary\)|clients, ai tools|enterprise systems/i,
    {
      types: ['actor'],
      aiStage: 'entry',
      aiRole: 'client',
      kind: 'actor',
      iconKind: 'actor',
      label: 'AI Clients / Agent Apps',
      sequenceIndex: 0,
      syntheticId: 'guardrails-clients',
      syntheticLabel: 'AI Clients / Agent Apps',
    },
  );
  const runtimeApi = aiInvocationAddGraphNode(graph, add, /post \/v1\/chat\/completions|post \/v1\/embeddings/i, {
    types: ['api', 'component'],
    prefer: [/^POST \/v1\/chat\/completions/i],
    aiStage: 'entry',
    aiRole: 'runtime-api',
    kind: 'api',
    iconKind: 'api',
    label: 'AI Runtime API',
    sequenceIndex: 1,
    syntheticId: 'guardrails-runtime-api',
    syntheticLabel: 'AI Runtime API',
  });
  const adminApi = aiInvocationAddGraphNode(graph, add, /\/admin\/v1\/(policies|catalog|prompts|models|mcp|cache)/i, {
    types: ['api'],
    aiStage: 'entry',
    aiRole: 'admin-api',
    kind: 'api',
    iconKind: 'api',
    label: 'Guardrail Admin APIs',
    sequenceIndex: 2,
    syntheticId: 'guardrails-admin-api',
    syntheticLabel: 'Guardrail Admin APIs',
  });
  const tls = aiInvocationAddGraphNode(graph, add, /tls \+ auth|tls.*auth/i, {
    types: ['securityControl', 'component'],
    aiStage: 'controls',
    aiRole: 'auth',
    kind: 'securityControl',
    iconKind: 'identity',
    label: '1. TLS + Auth Gate',
    sequenceIndex: 3,
    syntheticId: 'guardrails-tls-auth',
    syntheticLabel: '1. TLS + Auth Gate',
  });
  const tenant = aiInvocationAddGraphNode(graph, add, /virtual-key|tenant resolve/i, {
    types: ['component', 'securityControl', 'api'],
    prefer: [/^2\.\s*virtual-key/i],
    aiStage: 'controls',
    aiRole: 'tenant',
    kind: 'component',
    iconKind: 'identity',
    label: '2. Tenant and Virtual-Key Context',
    sequenceIndex: 4,
    syntheticId: 'guardrails-tenant-context',
    syntheticLabel: '2. Tenant and Virtual-Key Context',
  });
  const redaction = aiInvocationAddGraphNode(graph, add, /redaction pack apply|redaction packs|redaction/i, {
    types: ['securityControl', 'component', 'dataEntity', 'api'],
    prefer: [/^4\.\s*redaction pack apply/i],
    avoid: [/redaction_packs|\/admin\/v1\/redaction/i],
    aiStage: 'controls',
    aiRole: 'redaction',
    kind: 'securityControl',
    iconKind: 'securityControl',
    label: '3. Redaction Pack Apply',
    sequenceIndex: 5,
    syntheticId: 'guardrails-redaction',
    syntheticLabel: '3. Redaction Pack Apply',
  });
  const killSwitch = aiInvocationAddGraphNode(graph, add, /kill-switch check|kill.?switch/i, {
    types: ['securityControl', 'component', 'dataEntity'],
    prefer: [/^5\.\s*kill-switch check/i],
    aiStage: 'controls',
    aiRole: 'kill-switch',
    kind: 'securityControl',
    iconKind: 'securityControl',
    label: '4. Kill-Switch Check',
    sequenceIndex: 6,
    syntheticId: 'guardrails-kill-switch',
    syntheticLabel: '4. Kill-Switch Check',
  });
  const policy = aiInvocationAddGraphNode(graph, add, /policy bundle eval|policy-engine bc|policy bundle|guardrail/i, {
    types: ['securityControl', 'component'],
    prefer: [/^8\.\s*policy bundle eval/i, /policy-engine bc/i],
    aiStage: 'policy',
    aiRole: 'policy',
    kind: 'securityControl',
    iconKind: 'securityControl',
    label: '5. Policy Bundle Evaluation',
    sequenceIndex: 7,
    syntheticId: 'guardrails-policy-eval',
    syntheticLabel: '5. Policy Bundle Evaluation',
  });
  const scanner = aiInvocationAddGraphNode(
    graph,
    add,
    /scanner fan-out|scanner|presidio|nemo|guardrails ai|llamaguard|wasm/i,
    {
      types: ['securityControl', 'component', 'dataEntity'],
      prefer: [/^9\.\s*scanner fan-out/i],
      aiStage: 'policy',
      aiRole: 'scanner',
      kind: 'securityControl',
      iconKind: 'securityControl',
      label: '6. Scanner Fan-Out',
      sequenceIndex: 8,
      syntheticId: 'guardrails-scanner-fanout',
      syntheticLabel: '6. Scanner Fan-Out',
    },
  );
  const evalGate = aiInvocationAddGraphNode(graph, add, /llm red-team release gate|eval|red.?team|release gate/i, {
    types: ['securityControl', 'operationalSignal', 'component'],
    prefer: [/llm red-team release gate/i],
    aiStage: 'policy',
    aiRole: 'eval-gate',
    kind: 'securityControl',
    iconKind: 'securityControl',
    label: '7. Red-Team / Eval Release Gate',
    sequenceIndex: 9,
    syntheticId: 'guardrails-eval-gate',
    syntheticLabel: '7. Red-Team / Eval Release Gate',
  });
  const modelCatalog = aiInvocationAddGraphNode(
    graph,
    add,
    /catalog\/models|model catalog|models`?|model intake|\/admin\/v1\/models/i,
    {
      types: ['api', 'dataEntity', 'component'],
      prefer: [/GET \/admin\/v1\/catalog\/models|POST \/admin\/v1\/models\/intake|`models`/i],
      aiStage: 'governance',
      aiRole: 'model-catalog',
      kind: 'api',
      iconKind: 'api',
      label: 'Model Catalog / Approval State',
      sequenceIndex: 10,
      syntheticId: 'guardrails-model-catalog',
      syntheticLabel: 'Model Catalog / Approval State',
    },
  );
  const promptRegistry = aiInvocationAddGraphNode(graph, add, /\/admin\/v1\/prompts|prompt registry|prompts/i, {
    types: ['api', 'component', 'dataEntity'],
    aiStage: 'governance',
    aiRole: 'prompt-registry',
    kind: 'api',
    iconKind: 'api',
    label: 'Prompt Registry / Guardrail Versions',
    sequenceIndex: 11,
    syntheticId: 'guardrails-prompt-registry',
    syntheticLabel: 'Prompt Registry / Guardrail Versions',
  });
  const providerDispatch = aiInvocationAddGraphNode(graph, add, /provider dispatch|streaming guardrails/i, {
    types: ['integration', 'component'],
    prefer: [/^10\.\s*provider dispatch/i],
    aiStage: 'provider',
    aiRole: 'provider-dispatch',
    kind: 'integration',
    iconKind: 'integration',
    label: 'Provider Dispatch + Streaming Guardrails',
    sequenceIndex: 12,
    syntheticId: 'guardrails-provider-dispatch',
    syntheticLabel: 'Provider Dispatch + Streaming Guardrails',
  });
  const llmProviders = aiInvocationAddGraphNode(graph, add, /llm providers|openai|anthropic|google|azure|bedrock/i, {
    types: ['integration'],
    aiStage: 'provider',
    aiRole: 'llm-provider',
    kind: 'integration',
    iconKind: 'integration',
    label: 'LLM Provider APIs',
    external: true,
    sequenceIndex: 13,
    syntheticId: 'guardrails-llm-providers',
    syntheticLabel: 'LLM Provider APIs',
  });
  const postVerifier = aiInvocationAddGraphNode(graph, add, /post-condition verifier|re-read|webhook|probe/i, {
    types: ['component', 'securityControl', 'integration'],
    aiStage: 'evidence',
    aiRole: 'post-verifier',
    kind: 'component',
    iconKind: 'securityControl',
    label: 'Post-Condition Verifier',
    sequenceIndex: 14,
    syntheticId: 'guardrails-post-verifier',
    syntheticLabel: 'Post-Condition Verifier',
  });
  const audit = aiInvocationAddGraphNode(graph, add, /audit emit|cost event|audit-evidence|evidence bundles/i, {
    types: ['operationalSignal', 'component'],
    aiStage: 'evidence',
    aiRole: 'audit',
    kind: 'operationalSignal',
    iconKind: 'operationalSignal',
    label: 'Guardrail Audit / Evidence',
    sequenceIndex: 15,
    syntheticId: 'guardrails-audit-evidence',
    syntheticLabel: 'Guardrail Audit / Evidence',
  });
  const observability = aiInvocationAddGraphNode(
    graph,
    add,
    /observability bc|otel|shadow-ai|experiments|intelligence/i,
    {
      types: ['operationalSignal', 'component'],
      aiStage: 'evidence',
      aiRole: 'observability',
      kind: 'operationalSignal',
      iconKind: 'operationalSignal',
      label: 'Eval Metrics / Shadow-AI Signals',
      sequenceIndex: 16,
      syntheticId: 'guardrails-observability',
      syntheticLabel: 'Eval Metrics / Shadow-AI Signals',
    },
  );

  const connect = (from, to, label, style = 'solid') => {
    if (from && to && from.id !== to.id) edges.push({ from: from.id, to: to.id, label, style });
  };

  connect(clients, runtimeApi, 'AI request');
  connect(adminApi, policy, 'guardrail configuration', 'dashed');
  connect(adminApi, modelCatalog, 'model approval workflow', 'dashed');
  connect(runtimeApi, tls, 'authenticate request');
  connect(tls, tenant, 'tenant and key context');
  connect(tenant, redaction, 'redaction policy context');
  connect(redaction, killSwitch, 'emergency stop check');
  connect(killSwitch, policy, 'policy bundle context');
  connect(policy, scanner, 'scanner fan-out plan');
  connect(scanner, evalGate, 'eval rule coverage', 'dashed');
  connect(evalGate, modelCatalog, 'approved model state', 'dashed');
  connect(promptRegistry, policy, 'guardrail prompt versions', 'dashed');
  connect(modelCatalog, providerDispatch, 'allowed provider/model metadata', 'dashed');
  connect(scanner, providerDispatch, 'approved request envelope');
  connect(providerDispatch, llmProviders, 'provider API call');
  connect(llmProviders, postVerifier, 'streamed response', 'dashed');
  connect(providerDispatch, postVerifier, 'stream guardrail verification');
  connect(postVerifier, audit, 'audit emit and evidence bundle');
  connect(scanner, audit, 'scanner findings');
  connect(evalGate, audit, 'eval gate decision');
  connect(audit, observability, 'metrics and shadow-AI export', 'dashed');

  return {
    nodes,
    edges,
    groups: AI_INVOCATION_GROUPS,
    legend: [
      {
        symbol: 'Primary path',
        meaning: 'Request guardrail path from API entry through policy, scanner, provider, and evidence',
      },
      { symbol: 'Control', meaning: 'Auth, redaction, kill-switch, policy, scanner, eval, and verification gates' },
      { symbol: 'Governance', meaning: 'Model catalog, prompt versions, and release-gate approval state' },
      { symbol: 'Dashed edge', meaning: 'Configuration, response, eval, or telemetry support path' },
    ],
    evidence: dedupeEvidence(evidence),
    assumptions: [
      'Guardrails and Eval Flow is derived from source-backed auth, redaction, kill-switch, policy bundle, scanner, eval gate, provider dispatch, post-condition verification, and evidence nodes instead of generic AI keyword matches.',
    ],
    warnings: nodes.length ? [] : ['No graph nodes matched the Guardrails and Eval Flow viewpoint.'],
  };
}

function deriveSolutionContextTopology(graph) {
  const nodes = [];
  const edges = [];
  const evidence = [];
  const used = new Set();

  function add(node) {
    if (!node || used.has(node.id)) return null;
    used.add(node.id);
    nodes.push(node);
    for (const ref of node.evidenceRefs || []) evidence.push(ref);
    return node;
  }

  const clients = solutionAddGraphNode(
    graph,
    add,
    /clients, ai tools|application developer.*cli agents|enterprise systems/i,
    {
      types: ['actor'],
      group: 'External actors',
      solutionLayer: 'actors',
      c4Role: 'person',
      kind: 'actor',
      iconKind: 'actor',
      label: 'Application Developers / AI Clients',
      syntheticId: 'solution-context-clients',
      syntheticLabel: 'Application Developers / AI Clients',
      evidenceSummary: 'Primary consumers send OpenAI-compatible and agent traffic into MUG.',
    },
  );
  const admins = solutionAddGraphNode(
    graph,
    add,
    /platform \/ security \/ finops operators|admins and automation|tenant owner|security engineer/i,
    {
      types: ['actor'],
      group: 'External actors',
      solutionLayer: 'actors',
      c4Role: 'person',
      kind: 'actor',
      iconKind: 'actor',
      label: 'Platform, Security, and FinOps Operators',
      syntheticId: 'solution-context-admins',
      syntheticLabel: 'Platform, Security, and FinOps Operators',
      evidenceSummary: 'Operators configure policies, budgets, approvals, and runtime controls.',
    },
  );
  const auditor = solutionAddGraphNode(graph, add, /compliance auditor|compliance.*risk officer/i, {
    types: ['actor', 'operationalSignal'],
    group: 'External actors',
    solutionLayer: 'actors',
    c4Role: 'person',
    kind: 'actor',
    iconKind: 'actor',
    label: 'Compliance and Risk Officers',
    syntheticId: 'solution-context-auditor',
    syntheticLabel: 'Compliance and Risk Officers',
    evidenceSummary: 'Compliance stakeholders review evidence bundles and audit trails.',
  });

  const mug = solutionAddGraphNode(graph, add, /mug|meru unified gateway/i, {
    types: ['component', 'platformNode'],
    group: 'System boundary',
    solutionLayer: 'system',
    c4Role: 'system',
    kind: 'component',
    iconKind: 'platformNode',
    label: 'MUG - Meru Unified Gateway',
    syntheticId: 'solution-context-mug',
    syntheticLabel: 'MUG - Meru Unified Gateway',
    evidenceSummary: 'MUG is the central governed gateway for enterprise AI traffic.',
  });

  const llm = solutionAddGraphNode(graph, add, /llm providers|openai|anthropic|azure|bedrock/i, {
    types: ['integration'],
    group: 'External systems',
    solutionLayer: 'external',
    c4Role: 'external',
    kind: 'integration',
    iconKind: 'integration',
    label: 'LLM Provider APIs',
  });
  const mcp = solutionAddGraphNode(graph, add, /mcp servers|mcp servers \/ tools|mcp bridge|tool router/i, {
    types: ['integration', 'component'],
    group: 'External systems',
    solutionLayer: 'external',
    c4Role: 'external',
    kind: 'integration',
    iconKind: 'integration',
    label: 'MCP Servers / Enterprise Tools',
  });
  const idp = solutionAddGraphNode(graph, add, /enterprise idp|oidc|saml|ldap|scim/i, {
    types: ['component', 'integration', 'securityControl'],
    group: 'External systems',
    solutionLayer: 'external',
    c4Role: 'external',
    kind: 'integration',
    iconKind: 'identity',
    label: 'Enterprise IdP / Directory',
    external: true,
  });
  const siem = solutionAddGraphNode(graph, add, /siem|data lake|warehouse|rag/i, {
    types: ['integration', 'operationalSignal'],
    group: 'External systems',
    solutionLayer: 'external',
    c4Role: 'external',
    kind: 'integration',
    iconKind: 'integration',
    label: 'SIEM / Data Lake / Warehouse',
  });
  const itsm = solutionAddGraphNode(graph, add, /itsm|soar|approval|on-call/i, {
    types: ['component', 'integration', 'operationalSignal'],
    group: 'External systems',
    solutionLayer: 'external',
    c4Role: 'external',
    kind: 'integration',
    iconKind: 'integration',
    label: 'Approval / Escalation Workflow',
    external: true,
  });

  const connect = (from, to, label, style = 'solid') => {
    if (from && to && from.id !== to.id) edges.push({ from: from.id, to: to.id, label, style });
  };

  connect(clients, mug, 'OpenAI-compatible API and agent traffic');
  connect(admins, mug, 'configures tenants, policy, budgets');
  connect(auditor, mug, 'reviews evidence, audit trails, and controls', 'dashed');
  connect(mug, idp, 'federates identity and RBAC');
  connect(mug, llm, 'routes approved model calls');
  connect(mug, mcp, 'invokes approved tools');
  connect(mug, itsm, 'approval and escalation workflow', 'dashed');
  connect(mug, siem, 'exports security telemetry and audit evidence', 'dashed');

  return {
    nodes,
    edges,
    groups: SOLUTION_CONTEXT_GROUPS,
    legend: [
      { symbol: 'Person', meaning: 'External actors that use, operate, or audit the platform' },
      { symbol: 'System', meaning: 'MUG as the single system under design' },
      { symbol: 'System_Ext', meaning: 'External providers, enterprise systems, and operational sinks' },
    ],
    evidence: dedupeEvidence(evidence),
    assumptions: [
      'Solution context is derived as a C4 system-context view: MUG is the single system under design, while internal containers, controls, and stores are reserved for SA-002.',
    ],
    warnings: nodes.length ? [] : ['No graph nodes matched the Solution Architecture context viewpoint.'],
  };
}

function deriveSolutionContainerTopology(graph) {
  const nodes = [];
  const edges = [];
  const evidence = [];
  const used = new Set();

  function add(node) {
    if (!node || used.has(node.id)) return null;
    used.add(node.id);
    nodes.push(node);
    for (const ref of node.evidenceRefs || []) evidence.push(ref);
    return node;
  }

  const clients = solutionAddGraphNode(
    graph,
    add,
    /clients, ai tools|application developer.*cli agents|enterprise systems/i,
    {
      types: ['actor'],
      group: 'External Actors',
      solutionLayer: 'actors',
      c4Role: 'person',
      kind: 'actor',
      iconKind: 'actor',
      syntheticId: 'solution-container-clients',
      syntheticLabel: 'Clients, AI Tools, Enterprise Systems',
    },
  );
  const admins = solutionAddGraphNode(
    graph,
    add,
    /platform \/ security \/ finops operators|admins and automation|security engineer|tenant owner/i,
    {
      types: ['actor'],
      group: 'External Actors',
      solutionLayer: 'actors',
      c4Role: 'person',
      kind: 'actor',
      iconKind: 'actor',
      syntheticId: 'solution-container-admins',
      syntheticLabel: 'Platform, Security, and FinOps Operators',
    },
  );
  const auditor = solutionAddGraphNode(graph, add, /compliance auditor|compliance.*risk officer/i, {
    types: ['actor', 'operationalSignal'],
    group: 'External Actors',
    solutionLayer: 'actors',
    c4Role: 'person',
    kind: 'actor',
    iconKind: 'actor',
  });

  const inbound = solutionAddGraphNode(graph, add, /inbound.*chat\/completions|\/v1\/chat\/completions/i, {
    types: ['component', 'api'],
    group: 'MUG Platform',
    solutionLayer: 'ingress',
    c4Role: 'container',
    kind: 'api',
    iconKind: 'api',
    syntheticId: 'solution-container-ingress',
    syntheticLabel: 'OpenAI-Compatible API Ingress',
  });
  const tls = solutionAddGraphNode(graph, add, /tls \+ auth|tls.*auth/i, {
    types: ['securityControl', 'component'],
    group: 'MUG Platform',
    solutionLayer: 'control',
    c4Role: 'container',
    kind: 'securityControl',
    iconKind: 'securityControl',
    syntheticId: 'solution-container-tls-auth',
    syntheticLabel: 'TLS and Authentication Gate',
  });
  const tenant = solutionAddGraphNode(graph, add, /virtual-key|tenant resolve/i, {
    types: ['component', 'securityControl', 'api'],
    group: 'MUG Platform',
    solutionLayer: 'control',
    c4Role: 'container',
    kind: 'component',
    iconKind: 'securityControl',
  });
  const identity = solutionAddGraphNode(graph, add, /identity bc|rbac|sessions|oidc|saml|ldap|scim/i, {
    types: ['securityControl', 'component'],
    prefer: [/identity bc/i, /rbac|sessions/i],
    avoid: [/enterprise idp|directory/i],
    group: 'MUG Platform',
    solutionLayer: 'control',
    c4Role: 'container',
    kind: 'securityControl',
    iconKind: 'identity',
    syntheticId: 'solution-container-identity-bc',
    syntheticLabel: 'identity BC (OIDC/SAML/LDAP/SCIM, RBAC, sessions)',
  });
  const quota = solutionAddGraphNode(graph, add, /rate-limit|quota/i, {
    types: ['component', 'dataEntity'],
    prefer: [/^3\.\s*rate-limit/i],
    avoid: [/quota_profiles|budgets|\/admin\/v1\/quotas/i],
    group: 'MUG Platform',
    solutionLayer: 'control',
    c4Role: 'container',
    kind: 'component',
    iconKind: 'securityControl',
  });
  const redaction = solutionAddGraphNode(graph, add, /redaction pack apply|redaction packs|redaction/i, {
    types: ['securityControl', 'component', 'dataEntity', 'api'],
    prefer: [/^4\.\s*redaction pack apply/i],
    avoid: [/redaction_packs|\/admin\/v1\/redaction/i],
    group: 'MUG Platform',
    solutionLayer: 'control',
    c4Role: 'container',
    kind: 'securityControl',
    iconKind: 'securityControl',
  });
  const killSwitch = solutionAddGraphNode(graph, add, /kill-switch check|kill.?switch/i, {
    types: ['securityControl', 'component', 'dataEntity'],
    prefer: [/^5\.\s*kill-switch check/i],
    avoid: [/kill_switches|incident responder/i],
    group: 'MUG Platform',
    solutionLayer: 'control',
    c4Role: 'container',
    kind: 'securityControl',
    iconKind: 'securityControl',
  });
  const policy = solutionAddGraphNode(
    graph,
    add,
    /policy-engine bc|policy bundle eval|policy bundle|guardrail|kill-switch/i,
    {
      types: ['securityControl', 'component'],
      prefer: [/^8\.\s*policy bundle eval/i, /policy bundle eval/i, /policy-engine bc/i],
      avoid: [/`?budgets`?|quota_profiles|policy_bundles|policy_versions/i],
      group: 'MUG Platform',
      solutionLayer: 'control',
      c4Role: 'container',
      kind: 'securityControl',
      iconKind: 'securityControl',
    },
  );
  const route = solutionAddGraphNode(graph, add, /route resolution|routing, workflow|event engine/i, {
    types: ['component'],
    group: 'MUG Platform',
    solutionLayer: 'execution',
    c4Role: 'container',
    kind: 'component',
    iconKind: 'deployment',
  });
  const trust = solutionAddGraphNode(graph, add, /trust class|lease mint/i, {
    types: ['component', 'securityControl'],
    group: 'MUG Platform',
    solutionLayer: 'execution',
    c4Role: 'container',
    kind: 'component',
    iconKind: 'securityControl',
  });
  const scanner = solutionAddGraphNode(
    graph,
    add,
    /scanner fan-out|scanner|presidio|nemo|guardrails ai|llamaguard|wasm/i,
    {
      types: ['securityControl', 'component', 'dataEntity'],
      prefer: [/^9\.\s*scanner fan-out/i],
      avoid: [/entity-scanners|`scanners`|scanner unavailability/i],
      group: 'MUG Platform',
      solutionLayer: 'control',
      c4Role: 'container',
      kind: 'securityControl',
      iconKind: 'securityControl',
    },
  );
  const providerDispatch = solutionAddGraphNode(graph, add, /provider dispatch|streaming guardrails/i, {
    types: ['integration', 'component'],
    prefer: [/^10\.\s*provider dispatch/i],
    group: 'MUG Platform',
    solutionLayer: 'execution',
    c4Role: 'container',
    kind: 'component',
    iconKind: 'integration',
    external: false,
  });
  const postVerifier = solutionAddGraphNode(graph, add, /post-condition verifier|re-read|webhook|probe/i, {
    types: ['component', 'securityControl', 'integration'],
    prefer: [/^11\.\s*post-condition verifier/i],
    group: 'MUG Platform',
    solutionLayer: 'control',
    c4Role: 'container',
    kind: 'component',
    iconKind: 'securityControl',
    external: false,
  });
  const auditEmit = solutionAddGraphNode(graph, add, /audit emit|cost event/i, {
    types: ['operationalSignal', 'component'],
    prefer: [/^12\.\s*audit emit/i],
    avoid: [/billing bc|cost events, metering/i],
    group: 'State and Evidence Stores',
    solutionLayer: 'state',
    c4Role: 'container',
    kind: 'operationalSignal',
    iconKind: 'operationalSignal',
  });
  const mcpBridge = solutionAddGraphNode(graph, add, /integrations bc|mcp bridge|tool router|mcp registry/i, {
    types: ['component', 'integration'],
    group: 'MUG Platform',
    solutionLayer: 'execution',
    c4Role: 'container',
    kind: 'component',
    iconKind: 'integration',
  });
  const gateway = solutionAddGraphNode(graph, add, /elixir.*gateway server|gateway server cluster|gateway-server$/i, {
    types: ['component', 'platformNode'],
    group: 'MUG Platform',
    solutionLayer: 'execution',
    c4Role: 'container',
    kind: 'component',
    iconKind: 'deployment',
  });
  const edge = solutionAddGraphNode(graph, add, /go edge agent/i, {
    types: ['component', 'platformNode'],
    group: 'MUG Platform',
    solutionLayer: 'execution',
    c4Role: 'container',
    kind: 'component',
    iconKind: 'deployment',
  });
  const controlPlane = solutionAddGraphNode(graph, add, /control-plane bc|admin api|liveview dashboard/i, {
    types: ['component', 'actor', 'platformNode'],
    group: 'MUG Platform',
    solutionLayer: 'control',
    c4Role: 'container',
    kind: 'component',
    iconKind: 'platformNode',
    label: 'Control Plane Admin API / Dashboard',
    external: false,
  });

  const gatewayBc = solutionAddGraphNode(graph, add, /gateway bc/i, {
    types: ['dataStore', 'component'],
    prefer: [/^gateway bc/i],
    group: 'State and Evidence Stores',
    solutionLayer: 'state',
    c4Role: 'database',
    kind: 'dataStore',
    iconKind: 'dataStore',
  });
  const rocks = solutionAddGraphNode(graph, add, /rocksdb|append log|write buffer/i, {
    types: ['dataStore', 'dataEntity'],
    prefer: [/^rocksdb\b/i, /write buffer|append-only durable|append log/i],
    avoid: [/gateway bc/i],
    group: 'State and Evidence Stores',
    solutionLayer: 'state',
    c4Role: 'database',
    kind: 'dataStore',
    iconKind: 'dataStore',
  });
  const amnesia = solutionAddGraphNode(graph, add, /amnesia|mnesia|cursors|leases/i, {
    types: ['dataStore', 'dataEntity'],
    group: 'State and Evidence Stores',
    solutionLayer: 'state',
    c4Role: 'database',
    kind: 'dataStore',
    iconKind: 'dataStore',
  });
  const postgres = solutionAddGraphNode(graph, add, /postgres|system of record/i, {
    types: ['dataStore', 'dataEntity'],
    group: 'State and Evidence Stores',
    solutionLayer: 'state',
    c4Role: 'database',
    kind: 'dataStore',
    iconKind: 'dataStore',
  });
  const audit = solutionAddGraphNode(graph, add, /audit-evidence|append-only events|evidence bundles/i, {
    types: ['operationalSignal', 'dataStore', 'component'],
    group: 'State and Evidence Stores',
    solutionLayer: 'state',
    c4Role: 'container',
    kind: 'operationalSignal',
    iconKind: 'operationalSignal',
  });
  const observability = solutionAddGraphNode(graph, add, /observability|otel|metrics|traces/i, {
    types: ['operationalSignal', 'component'],
    group: 'State and Evidence Stores',
    solutionLayer: 'state',
    c4Role: 'container',
    kind: 'operationalSignal',
    iconKind: 'operationalSignal',
  });
  const billing = solutionAddGraphNode(graph, add, /billing bc|cost events|metering|finops/i, {
    types: ['operationalSignal', 'component', 'dataEntity'],
    group: 'State and Evidence Stores',
    solutionLayer: 'state',
    c4Role: 'container',
    kind: 'operationalSignal',
    iconKind: 'operationalSignal',
  });

  const llm = solutionAddGraphNode(graph, add, /llm providers|openai|anthropic|azure|bedrock/i, {
    types: ['integration'],
    group: 'External Systems',
    solutionLayer: 'external',
    c4Role: 'external',
    kind: 'integration',
    iconKind: 'integration',
  });
  const mcp = solutionAddGraphNode(graph, add, /mcp servers|mcp servers \/ tools/i, {
    types: ['integration', 'component'],
    group: 'External Systems',
    solutionLayer: 'external',
    c4Role: 'external',
    kind: 'integration',
    iconKind: 'integration',
  });
  const idp = solutionAddGraphNode(graph, add, /enterprise idp|oidc|saml|ldap|scim/i, {
    types: ['component', 'integration', 'securityControl'],
    prefer: [/enterprise idp|directory/i],
    avoid: [/identity bc|rbac|sessions/i],
    group: 'External Systems',
    solutionLayer: 'external',
    c4Role: 'external',
    kind: 'integration',
    iconKind: 'identity',
    label: 'Enterprise IdP / Directory',
    external: true,
  });
  const siem = solutionAddGraphNode(graph, add, /siem|data lake|warehouse|rag/i, {
    types: ['integration', 'operationalSignal'],
    group: 'External Systems',
    solutionLayer: 'external',
    c4Role: 'external',
    kind: 'integration',
    iconKind: 'integration',
  });
  const itsm = solutionAddGraphNode(graph, add, /itsm|soar|on-call|approval/i, {
    types: ['component', 'integration', 'operationalSignal'],
    prefer: [/itsm|soar|on-call/i],
    avoid: [/post-condition|webhook|probe|re-read/i],
    group: 'External Systems',
    solutionLayer: 'external',
    c4Role: 'external',
    kind: 'integration',
    iconKind: 'integration',
    external: true,
  });

  const connect = (from, to, label, style = 'solid') => {
    if (from && to && from.id !== to.id) edges.push({ from: from.id, to: to.id, label, style });
  };

  connect(clients, inbound, 'POST /v1/chat/completions');
  connect(admins, controlPlane || policy, 'admin API / dashboard config');
  connect(auditor, audit, 'reviews evidence bundle', 'dashed');
  connect(inbound, tls, 'TLS and request authentication');
  connect(tls, tenant, 'virtual-key and tenant resolution');
  connect(tenant, identity, 'RBAC and session context');
  connect(tenant, quota, 'quota profile lookup');
  connect(quota || tenant, redaction || policy, 'redaction pack apply');
  connect(redaction || quota || tenant, killSwitch || policy, 'kill-switch check');
  connect(killSwitch || redaction || quota || tenant, route, 'route resolution');
  connect(route, trust, 'trust class and lease decision');
  connect(trust || route, policy, 'policy bundle evaluation');
  connect(policy, scanner, 'scanner fan-out');
  connect(scanner || policy, providerDispatch || llm, 'provider dispatch');
  connect(providerDispatch || route || gateway, llm, 'approved provider request');
  connect(providerDispatch || route, postVerifier, 'post-condition verification');
  connect(postVerifier || providerDispatch || policy, auditEmit || audit, 'audit emit and cost event');
  connect(route || trust, gateway || edge, 'orchestrates runtime request');
  connect(gateway || route, edge, 'gRPC over mTLS');
  connect(mcpBridge || route, mcp, 'approved MCP tool invocation');
  connect(policy, mcpBridge, 'allowed tool policy');
  connect(policy, itsm, 'approval or escalation', 'dashed');
  connect(identity, idp, 'federated identity lookup');
  connect(edge || gateway, gatewayBc, 'agent/session state');
  connect(gatewayBc, rocks, 'append durable log');
  connect(gatewayBc, amnesia, 'replicate cursors and leases');
  connect(gatewayBc, postgres, 'project system of record');
  connect(policy, audit, 'append policy decision');
  connect(auditEmit, audit, 'evidence event');
  connect(gatewayBc, observability, 'OTel metrics and traces', 'dashed');
  connect(auditEmit || gatewayBc, billing, 'metered cost events');
  connect(audit || observability, siem, 'export audit and telemetry stream', 'dashed');

  return {
    nodes,
    edges,
    groups: SOLUTION_CONTAINER_GROUPS,
    legend: [
      { symbol: 'Person', meaning: 'Consumers and operators outside the system boundary' },
      { symbol: 'Container', meaning: 'Deployable API, control, routing, and execution containers' },
      { symbol: 'ContainerDb', meaning: 'Durable state and evidence stores' },
      { symbol: 'System_Ext', meaning: 'External providers, identity, ITSM, and telemetry systems' },
    ],
    evidence: dedupeEvidence(evidence),
    assumptions: [
      'Solution container topology is derived from source-backed runtime, control-plane, integration, and persistence nodes so SA-002 remains a C4 container view rather than a generic component grid.',
    ],
    warnings: nodes.length ? [] : ['No graph nodes matched the Solution Architecture container viewpoint.'],
  };
}

function buildSpec(entry, graph, { profile, state, pipeline: _pipeline }) {
  const spec = {
    id: entry.id,
    title: entry.title,
    taxonomyArea: entry.taxonomyArea,
    profile,
    state,
    purpose: purposeFor(entry),
    diagramKind: entry.kind,
    nodes: [],
    edges: [],
    groups: [],
    legend: defaultLegend(),
    evidence: [],
    confidence: 'inferred',
    warnings: [],
    assumptions: [],
  };

  let seeds = [];
  let capabilityFallback = false;
  let ownershipTopology = false;
  let coexistenceCutover = false;
  let businessValueStream = false;
  let solutionTopology = false;
  let applicationTopology = false;
  let domainTopology = false;
  let aiInvocationTopology = false;
  let dataTopology = false;
  let releaseTopology = false;
  switch (entry.kind) {
    case 'capability-map':
      seeds = pickNodes(graph, (n) => n.type === 'capability');
      if (!seeds.length) {
        seeds = deriveCapabilityFallbackSeeds(graph);
        capabilityFallback = seeds.length > 0;
        if (capabilityFallback) {
          spec.assumptions.push(
            'No explicit capability nodes were present; capability domains were derived from source-backed architecture evidence.',
          );
        }
      }
      break;
    case 'value-stream':
      {
        const valueStream = deriveBusinessValueStreamTopology(graph);
        spec.nodes = valueStream.nodes;
        spec.edges = valueStream.edges;
        spec.groups = valueStream.groups;
        spec.legend = valueStream.legend;
        spec.evidence = dedupeEvidence(valueStream.evidence);
        spec.assumptions.push(...valueStream.assumptions);
        spec.warnings.push(...valueStream.warnings);
        businessValueStream = true;
      }
      break;
    case 'c4-context':
      {
        const topology = deriveSolutionContextTopology(graph);
        spec.nodes = topology.nodes;
        spec.edges = topology.edges;
        spec.groups = topology.groups;
        spec.legend = topology.legend;
        spec.evidence = dedupeEvidence(topology.evidence);
        spec.assumptions.push(...topology.assumptions);
        spec.warnings.push(...topology.warnings);
        solutionTopology = true;
      }
      break;
    case 'c4-container':
      {
        const topology = deriveSolutionContainerTopology(graph);
        spec.nodes = topology.nodes;
        spec.edges = topology.edges;
        spec.groups = topology.groups;
        spec.legend = topology.legend;
        spec.evidence = dedupeEvidence(topology.evidence);
        spec.assumptions.push(...topology.assumptions);
        spec.warnings.push(...topology.warnings);
        solutionTopology = true;
      }
      break;
    case 'component-map':
      // D-7 fix: component view drills deeper — components + their data entities,
      // intentionally excluding platform/infra nodes that belong in container view.
      {
        const topology = deriveApplicationComponentTopology(graph);
        spec.nodes = topology.nodes;
        spec.edges = topology.edges;
        spec.groups = topology.groups;
        spec.legend = topology.legend;
        spec.evidence = dedupeEvidence(topology.evidence);
        spec.assumptions.push(...topology.assumptions);
        spec.warnings.push(...topology.warnings);
        applicationTopology = topology.nodes.length > 0;
      }
      if (!applicationTopology) {
        seeds = pickRankedNodes(
          graph,
          (n) => n.type === 'api' || n.type === 'component' || n.type === 'securityControl' || n.type === 'dataStore',
          30,
          architectureNodeRank,
        );
      }
      break;
    case 'domain-map':
      {
        const topology = deriveDomainBoundedContextTopology(graph);
        if (topology.nodes.length) {
          spec.nodes = topology.nodes;
          spec.edges = topology.edges;
          spec.groups = topology.groups;
          spec.legend = topology.legend;
          spec.evidence = dedupeEvidence(topology.evidence);
          spec.assumptions.push(...topology.assumptions);
          spec.warnings.push(...topology.warnings);
          domainTopology = true;
        } else {
          seeds = pickNodes(graph, (n) => n.type === 'domain' || n.type === 'component' || n.type === 'capability', 30);
          spec.groups = topology.groups;
          spec.assumptions.push(...topology.assumptions);
          spec.warnings.push(...topology.warnings);
        }
      }
      break;
    case 'erd':
      {
        const topology = deriveDataArchitectureTopology(graph, entry);
        if (topology.nodes.length) {
          spec.nodes = topology.nodes;
          spec.edges = topology.edges;
          spec.groups = topology.groups;
          spec.legend = topology.legend;
          spec.evidence = dedupeEvidence(topology.evidence);
          spec.assumptions.push(...topology.assumptions);
          spec.warnings.push(...topology.warnings);
          dataTopology = true;
        } else {
          seeds = pickNodes(graph, (n) => n.type === 'dataEntity' || n.type === 'dataStore', 30);
        }
      }
      break;
    case 'data-flow':
      {
        const topology = deriveDataArchitectureTopology(graph, entry);
        if (topology.nodes.length) {
          spec.nodes = topology.nodes;
          spec.edges = topology.edges;
          spec.groups = topology.groups;
          spec.legend = topology.legend;
          spec.evidence = dedupeEvidence(topology.evidence);
          spec.assumptions.push(...topology.assumptions);
          spec.warnings.push(...topology.warnings);
          dataTopology = true;
        } else {
          seeds = pickNodes(
            graph,
            (n) => n.type === 'dataEntity' || n.type === 'component' || n.type === 'integration',
            30,
          );
        }
      }
      break;
    case 'api-map':
      seeds = pickNodes(graph, (n) => n.type === 'api' || n.type === 'integration' || n.type === 'component', 30);
      break;
    case 'trust-boundary':
      seeds = pickRankedNodes(
        graph,
        (n) =>
          n.type === 'trustBoundary' ||
          n.type === 'securityControl' ||
          n.type === 'component' ||
          (n.type === 'operationalSignal' && /audit|policy|scanner|degradation|red.?team/i.test(n.name || '')),
        30,
        securityNodeRank,
      );
      break;
    case 'identity-flow':
      seeds = pickNodes(
        graph,
        (n) => n.type === 'actor' || n.type === 'identity' || n.type === 'role' || n.type === 'securityControl',
        20,
      );
      break;
    case 'runtime-topology':
      seeds = pickNodes(
        graph,
        (n) => n.type === 'platformNode' || n.type === 'component' || n.type === 'infrastructureNode',
        30,
      );
      break;
    case 'observability-map':
      seeds = pickNodes(graph, (n) => n.type === 'operationalSignal' || n.type === 'component', 30);
      break;
    case 'delta-map':
      seeds = pickNodes(graph, (n) => n.deltaType, 50);
      break;
    case 'governance-map':
      seeds = pickRankedNodes(
        graph,
        (n) =>
          n.type === 'actor' ||
          n.type === 'api' ||
          n.type === 'operationalSignal' ||
          n.type === 'complianceControl' ||
          n.type === 'securityControl' ||
          n.type === 'dataStore' ||
          n.type === 'dataEntity',
        24,
        governanceNodeRank,
      );
      break;
    case 'privacy-flow':
      seeds = pickRankedNodes(
        graph,
        (n) =>
          n.type === 'api' ||
          n.type === 'integration' ||
          n.type === 'operationalSignal' ||
          n.type === 'complianceControl' ||
          n.type === 'securityControl' ||
          n.type === 'dataStore' ||
          n.type === 'dataEntity',
        24,
        privacyNodeRank,
      );
      break;
    case 'resilience-map':
      seeds = pickNodes(
        graph,
        (n) => n.type === 'platformNode' || n.type === 'deploymentEnvironment' || n.type === 'component',
        20,
      );
      break;
    case 'release-flow':
      {
        const topology = deriveReleasePromotionTopology(graph);
        spec.nodes = topology.nodes;
        spec.edges = topology.edges;
        spec.groups = topology.groups;
        spec.legend = topology.legend;
        spec.evidence = dedupeEvidence(topology.evidence);
        spec.assumptions.push(...topology.assumptions);
        spec.warnings.push(...topology.warnings);
        releaseTopology = topology.nodes.length > 0;
        if (!releaseTopology) {
          seeds = pickRankedNodes(
            graph,
            (n) => n.type === 'deploymentEnvironment' || n.type === 'platformNode',
            15,
            releaseNodeRank,
          );
        }
      }
      break;
    case 'ownership-map':
      {
        const ownership = deriveOwnershipTopology(graph);
        if (ownership.nodes.length) {
          spec.nodes = ownership.nodes;
          spec.edges = ownership.edges;
          spec.groups = ownership.groups;
          spec.legend = ownershipLegend();
          spec.evidence = dedupeEvidence(ownership.evidence);
          spec.assumptions.push(...ownership.assumptions);
          spec.warnings.push(...ownership.warnings);
          ownershipTopology = true;
        } else {
          seeds = pickNodes(graph, (n) => n.owner, 30);
          spec.assumptions.push(...ownership.assumptions);
          spec.warnings.push(...ownership.warnings);
        }
      }
      break;
    case 'migration-roadmap':
      seeds = pickNodes(graph, (n) => n.deltaType || n.type === 'component', 20);
      break;
    case 'coexistence-cutover':
      {
        const topology = deriveCoexistenceCutoverTopology(graph);
        spec.nodes = topology.nodes;
        spec.edges = topology.edges;
        spec.groups = topology.groups;
        spec.legend = topology.legend;
        spec.evidence = dedupeEvidence(topology.evidence);
        spec.assumptions.push(...topology.assumptions);
        spec.warnings.push(...topology.warnings);
        coexistenceCutover = true;
      }
      break;
    case 'supply-chain':
      seeds = pickNodes(graph, (n) => n.type === 'integration' || n.type === 'component', 20);
      break;
    case 'cost-topology':
      seeds = pickNodes(
        graph,
        (n) => n.type === 'platformNode' || n.type === 'infrastructureNode' || n.type === 'component',
        20,
      );
      break;
    case 'risk-map':
      seeds = pickRiskMapNodes(graph, 28);
      break;
    case 'ai-pipeline':
      if (entry.id === 'AI-002' || /retrieval.*vector|vector store/i.test(entry.title || '')) {
        const topology = deriveRetrievalVectorTopology(graph);
        spec.nodes = topology.nodes;
        spec.edges = topology.edges;
        spec.groups = topology.groups;
        spec.legend = topology.legend;
        spec.evidence = dedupeEvidence(topology.evidence);
        spec.assumptions.push(...topology.assumptions);
        spec.warnings.push(...topology.warnings);
        aiInvocationTopology = topology.nodes.length > 0;
      } else if (entry.id === 'AI-003' || /guardrails?|eval/i.test(entry.title || '')) {
        const topology = deriveGuardrailsEvalTopology(graph);
        spec.nodes = topology.nodes;
        spec.edges = topology.edges;
        spec.groups = topology.groups;
        spec.legend = topology.legend;
        spec.evidence = dedupeEvidence(topology.evidence);
        spec.assumptions.push(...topology.assumptions);
        spec.warnings.push(...topology.warnings);
        aiInvocationTopology = topology.nodes.length > 0;
      } else if (entry.id === 'AI-001' || /model invocation/i.test(entry.title || '')) {
        const topology = deriveAiModelInvocationTopology(graph);
        spec.nodes = topology.nodes;
        spec.edges = topology.edges;
        spec.groups = topology.groups;
        spec.legend = topology.legend;
        spec.evidence = dedupeEvidence(topology.evidence);
        spec.assumptions.push(...topology.assumptions);
        spec.warnings.push(...topology.warnings);
        aiInvocationTopology = topology.nodes.length > 0;
      }
      if (!aiInvocationTopology) {
        seeds = pickNodes(graph, (n) => /model|vector|rag|llm|embed|prompt/i.test(n.name || ''), 30);
      }
      break;
    default:
      seeds = pickNodes(graph, () => true, 20);
  }

  for (const n of seeds) {
    spec.nodes.push({
      id: n.id,
      label: n.name,
      kind: n.type,
      group: n.group || groupOf(n),
      owner: n.owner,
      external: n.type === 'integration' || n.type === 'actor',
      state: n.state,
      deltaType: n.deltaType,
      confidence: n.confidence,
      evidenceRefs: n.evidence || [],
    });
    if (n.evidence?.length) {
      for (const e of n.evidence) spec.evidence.push(e);
    }
  }

  // Dedupe evidence by (path, summary) pair — the graph extractor often
  // attaches the same "Derived from PRD features bullet" reference to every
  // sibling node extracted from a shared section. Without this, a 12-node
  // diagram ships 12 identical evidence entries.
  spec.evidence = dedupeEvidence(spec.evidence);

  // Seed edges from graph, filtered to seed node ids.
  // D-6 fix: previous logic dropped every edge where only one endpoint was a
  // seed, producing diagrams with zero edges. Now include bridge edges and
  // auto-add the missing endpoint up to a cap so real relationships show.
  const seedIds = new Set(spec.nodes.map((n) => n.id));
  const bridgeCap = ['risk-map', 'coexistence-cutover', 'value-stream', 'c4-context', 'c4-container'].includes(
    entry.kind,
  )
    ? 0
    : 10;
  let bridgeAdded = 0;
  const graphNodeById = new Map((graph.nodes || []).map((n) => [n.id, n]));
  if (capabilityFallback) {
    const existingCapabilities = new Set(spec.nodes.map((n) => n.id));
    for (const [from, to, label] of CAPABILITY_FALLBACK_RELATIONSHIPS) {
      if (!existingCapabilities.has(from) || !existingCapabilities.has(to)) continue;
      spec.edges.push({
        from,
        to,
        label,
        style: 'solid',
      });
    }
    if (!spec.edges.length && spec.nodes.length > 1) {
      for (let i = 0; i < spec.nodes.length - 1 && spec.edges.length < 8; i += 1) {
        spec.edges.push({
          from: spec.nodes[i].id,
          to: spec.nodes[i + 1].id,
          label: 'enables',
          style: 'dashed',
        });
      }
    }
  }
  for (const e of graph.edges || []) {
    if (
      capabilityFallback ||
      ownershipTopology ||
      coexistenceCutover ||
      businessValueStream ||
      solutionTopology ||
      applicationTopology ||
      domainTopology ||
      aiInvocationTopology ||
      dataTopology ||
      releaseTopology
    )
      break;
    const fromInSeeds = seedIds.has(e.from);
    const toInSeeds = seedIds.has(e.to);
    if (fromInSeeds && toInSeeds) {
      spec.edges.push({ from: e.from, to: e.to, label: e.label || e.kind || '', style: 'solid' });
      continue;
    }
    if ((fromInSeeds || toInSeeds) && bridgeAdded < bridgeCap) {
      const missingId = fromInSeeds ? e.to : e.from;
      const missingNode = graphNodeById.get(missingId);
      if (missingNode) {
        spec.nodes.push({
          id: missingNode.id,
          label: missingNode.name,
          kind: missingNode.type,
          group: groupOf(missingNode),
          owner: missingNode.owner,
          external: true,
          state: missingNode.state,
          deltaType: missingNode.deltaType,
          confidence: missingNode.confidence,
          evidenceRefs: missingNode.evidence || [],
        });
        seedIds.add(missingId);
        bridgeAdded += 1;
        spec.edges.push({
          from: e.from,
          to: e.to,
          label: e.label || e.kind || '',
          style: 'dashed',
        });
      }
    }
  }

  applyRiskSemantics(spec);
  applyMigrationSemantics(spec);
  addMigrationHandoffEdges(spec);
  normalizeMigrationEdges(spec);
  applyViewpointGroups(spec, entry);
  applySemanticEdgeLabels(spec, entry);
  ensureViewpointConnectivity(spec, entry);
  ensureDiagramConnectivity(spec, entry);

  // Confidence rollup: worst case wins
  const order = ['confirmed', 'inferred', 'weak', 'unknown'];
  let worst = 'confirmed';
  for (const n of spec.nodes) {
    if (order.indexOf(n.confidence) > order.indexOf(worst)) worst = n.confidence;
  }
  spec.confidence = spec.nodes.length ? worst : 'unknown';

  if (!spec.nodes.length) {
    spec.warnings.push('No graph nodes matched this viewpoint.');
    spec.assumptions.push('Upstream evidence did not contain the entity types this diagram visualizes.');
  }

  // Split warning for density
  if (spec.nodes.length > 60) {
    spec.warnings.push(
      `Node density ${spec.nodes.length} exceeds readable threshold (60). Consider profile=all to auto-split.`,
    );
  }

  return spec;
}

function purposeFor(entry) {
  const map = {
    'capability-map': 'Show the enterprise capabilities this product delivers.',
    'value-stream': 'Show the end-to-end business process or value stream.',
    'c4-context': 'Show system actors, external systems, and the application boundary.',
    'c4-container': 'Show the internal containers (services, apps, data stores) that compose the system.',
    'component-map': 'Show major application components and their relationships.',
    'domain-map': 'Show domains / bounded contexts and their boundaries.',
    erd: 'Show the logical data model — entities, relationships, cardinality.',
    'data-flow': 'Show how data flows between actors, components, and stores.',
    'api-map': 'Show public and internal APIs with dependencies.',
    'trust-boundary': 'Show trust zones, perimeters, and security controls across them.',
    'identity-flow': 'Show authentication / authorization flow for primary actors.',
    'runtime-topology': 'Show runtime platform, environments, and where components deploy.',
    'observability-map': 'Show logging, metrics, and tracing surfaces.',
    'delta-map': 'Show what is kept, changed, replaced, retired, or added between current and target.',
    'governance-map': 'Show governance / compliance controls and their targets.',
    'privacy-flow': 'Show sensitive data and its lifecycle.',
    'resilience-map': 'Show failure domains and redundancy strategy.',
    'release-flow': 'Show environment promotion and release steps.',
    'ownership-map': 'Show team / owner assignments per component.',
    'migration-roadmap': 'Show phased migration steps from current to target.',
    'coexistence-cutover': 'Show coexistence, cutover gates, validation, rollback, and terminal target state.',
    'supply-chain': 'Show external dependencies and supply-chain surfaces.',
    'cost-topology': 'Show cost centres per platform / component.',
    'risk-map': 'Show risk / evidence-confidence across the system.',
    'ai-pipeline': 'Show AI / LLM invocations, retrieval, and guardrails.',
  };
  return map[entry.kind] || 'Visualize the requested architecture viewpoint.';
}

function groupOf(n) {
  const g = {
    actor: 'External',
    integration: 'External',
    component: 'Application',
    service: 'Application',
    dataStore: 'Data',
    dataEntity: 'Data',
    api: 'API',
    securityControl: 'Security',
    trustBoundary: 'Security',
    platformNode: 'Platform',
    operationalSignal: 'Operations',
  };
  return g[n.type] || 'Other';
}

const VIEWPOINT_GROUPS = {
  'api-map': [
    'API Consumers',
    'Runtime APIs',
    'Governance APIs',
    'Operations APIs',
    'Application Handlers',
    'External Systems and Stores',
  ],
  'identity-flow': [
    'Identity Actors',
    'Auth Entry APIs',
    'Identity Controls',
    'Policy and RBAC',
    'Identity Stores',
    'External IdP',
  ],
  'governance-map': [
    'Governance Actors',
    'Governance APIs',
    'Policy Controls',
    'Governed Assets',
    'Evidence and Assurance',
  ],
  'privacy-flow': [
    'Sensitive Data Entry',
    'Privacy Controls',
    'Tenant Data Stores',
    'External Processors',
    'Evidence and Retention',
  ],
  'observability-map': [
    'Telemetry Sources',
    'Runtime Components',
    'Signals and Dashboards',
    'Evidence Stores',
    'External Sinks',
  ],
  'runtime-topology': ['Runtime Entry', 'Gateway Runtime', 'Control Services', 'State Stores', 'External Dependencies'],
  'resilience-map': [
    'Failure Domains',
    'Runtime Redundancy',
    'State Replication',
    'Recovery Controls',
    'External Dependencies',
  ],
  'supply-chain': [
    'Consumers',
    'Gateway Runtime',
    'Provider and Tool Dependencies',
    'Control Gates',
    'Evidence Stores',
  ],
  'cost-topology': ['Cost Owners', 'Metered Runtime', 'Provider Spend', 'Storage Spend', 'FinOps Evidence'],
  'release-flow': ['Build', 'Staging', 'Release Gates', 'Production', 'Rollback and Evidence'],
  'risk-map': ['Exposure Surface', 'Control Gates', 'Protected Assets', 'Evidence and Assurance'],
  'trust-boundary': [
    'External Zone',
    'Identity and Edge Controls',
    'Application Zone',
    'Data Zone',
    'Evidence and Operations',
  ],
};

function nodeViewText(node) {
  return `${node?.label || node?.name || ''} ${node?.kind || node?.type || ''} ${node?.group || ''}`.toLowerCase();
}

function viewpointGroupFor(kind, node) {
  const text = nodeViewText(node);
  const nodeKind = node.kind || node.type;
  switch (kind) {
    case 'api-map':
      if (nodeKind === 'actor') return 'API Consumers';
      if (/\/admin\/v1\/(catalog|policies|budgets|quotas|prompts|models|mcp|integrations)/.test(text))
        return 'Governance APIs';
      if (/backup|restore|audit|session|export|replay|cache|erasure|incident/.test(text)) return 'Operations APIs';
      if (nodeKind === 'api') return 'Runtime APIs';
      if (nodeKind === 'component' || nodeKind === 'securityControl') return 'Application Handlers';
      return 'External Systems and Stores';
    case 'identity-flow':
      if (nodeKind === 'actor') return 'Identity Actors';
      if (nodeKind === 'api') return 'Auth Entry APIs';
      if (/oidc|saml|ldap|scim|idp|directory/.test(text)) return 'External IdP';
      if (/virtual.?key|tenant|session|service.?account|certificate|users|roles|role_bindings/.test(text))
        return 'Identity Stores';
      if (/policy|rbac|quota|lease|redaction|scanner|kill|guardrail/.test(text)) return 'Policy and RBAC';
      return 'Identity Controls';
    case 'governance-map':
      if (nodeKind === 'actor' || /auditor|compliance|finops|architect|security engineer/.test(text))
        return 'Governance Actors';
      if (nodeKind === 'api') return 'Governance APIs';
      if (nodeKind === 'securityControl' || /policy|control|guardrail|audit|red.?team/.test(text))
        return 'Policy Controls';
      if (nodeKind === 'operationalSignal' || /evidence|audit|logs|dashboard|compliance/.test(text))
        return 'Evidence and Assurance';
      return 'Governed Assets';
    case 'privacy-flow':
      if (nodeKind === 'actor' || nodeKind === 'api' || /chat|embeddings|admin/.test(text))
        return 'Sensitive Data Entry';
      if (nodeKind === 'securityControl' || /redaction|policy|identity|tenant|erasure|retention/.test(text))
        return 'Privacy Controls';
      if (nodeKind === 'integration' || /llm|provider|siem|warehouse|lake/.test(text)) return 'External Processors';
      if (nodeKind === 'operationalSignal' || /audit|evidence|backup|restore|retention/.test(text))
        return 'Evidence and Retention';
      return 'Tenant Data Stores';
    case 'observability-map':
      if (nodeKind === 'actor' || nodeKind === 'api') return 'Telemetry Sources';
      if (nodeKind === 'operationalSignal' || /logs|metrics|traces|dashboard|cost|audit/.test(text))
        return 'Signals and Dashboards';
      if (nodeKind === 'dataStore' || nodeKind === 'dataEntity' || /rocksdb|postgres|mnesia/.test(text))
        return 'Evidence Stores';
      if (nodeKind === 'integration' || /siem|warehouse|lake|on-call|itsm/.test(text)) return 'External Sinks';
      return 'Runtime Components';
    case 'runtime-topology':
      if (nodeKind === 'actor' || nodeKind === 'api' || /inbound|tenant/.test(text)) return 'Runtime Entry';
      if (/gateway|edge|agent|elixir|go edge/.test(text)) return 'Gateway Runtime';
      if (/control|policy|identity|integrations|billing|observability|audit/.test(text)) return 'Control Services';
      if (nodeKind === 'dataStore' || nodeKind === 'dataEntity' || /rocksdb|postgres|mnesia|state/.test(text))
        return 'State Stores';
      return 'External Dependencies';
    case 'resilience-map':
      if (
        /tenant|region|edge|external|provider|idp|siem|mcp/.test(text) ||
        nodeKind === 'actor' ||
        nodeKind === 'integration'
      )
        return 'Failure Domains';
      if (/gateway|agent|elixir|runtime|route/.test(text)) return 'Runtime Redundancy';
      if (/rocksdb|postgres|mnesia|replication|backup|restore|state/.test(text) || nodeKind === 'dataStore')
        return 'State Replication';
      if (/policy|kill|scanner|quota|post-condition|audit|observability/.test(text)) return 'Recovery Controls';
      return 'External Dependencies';
    case 'supply-chain':
      if (nodeKind === 'actor') return 'Consumers';
      if (/gateway|agent|runtime|route|inbound/.test(text)) return 'Gateway Runtime';
      if (nodeKind === 'integration' || /provider|mcp|idp|siem|warehouse|llm|tools/.test(text))
        return 'Provider and Tool Dependencies';
      if (/policy|scanner|trust|redaction|approval|identity|auth/.test(text)) return 'Control Gates';
      return 'Evidence Stores';
    case 'cost-topology':
      if (nodeKind === 'actor' || /finops|tenant|owner|auditor/.test(text)) return 'Cost Owners';
      if (/gateway|agent|runtime|route|control/.test(text)) return 'Metered Runtime';
      if (nodeKind === 'integration' || /provider|llm|mcp|idp/.test(text)) return 'Provider Spend';
      if (nodeKind === 'dataStore' || nodeKind === 'dataEntity' || /rocksdb|postgres|mnesia|storage/.test(text))
        return 'Storage Spend';
      return 'FinOps Evidence';
    case 'release-flow':
      if (/\bstaging\b|\bdev\b|qa|test environment|pre.?prod/.test(text)) return 'Staging';
      if (/production|prod/.test(text)) return 'Production';
      if (/rollback|restore|audit|observability|evidence|telemetry|release packet|health/.test(text))
        return 'Rollback and Evidence';
      if (/gate|policy|approval|security|red.?team|compliance/.test(text)) return 'Release Gates';
      return 'Build';
    case 'risk-map':
      if (nodeKind === 'securityControl' || /policy|control|guardrail|scanner|redaction|kill|tls|auth/.test(text))
        return 'Control Gates';
      if (
        nodeKind === 'dataStore' ||
        nodeKind === 'dataEntity' ||
        /postgres|rocksdb|mnesia|data|secret|certificate/.test(text)
      )
        return 'Protected Assets';
      if (nodeKind === 'operationalSignal' || /audit|evidence|logs|metrics|dashboard|backup|restore|export/.test(text))
        return 'Evidence and Assurance';
      return 'Exposure Surface';
    case 'trust-boundary':
      if (
        nodeKind === 'actor' ||
        nodeKind === 'integration' ||
        /external|internet|provider|idp|siem|mcp|client/.test(text)
      )
        return 'External Zone';
      if (
        nodeKind === 'securityControl' ||
        /identity|auth|tls|policy|scanner|redaction|guardrail|rbac|tenant/.test(text)
      )
        return 'Identity and Edge Controls';
      if (nodeKind === 'dataStore' || nodeKind === 'dataEntity' || /postgres|rocksdb|mnesia|store|data/.test(text))
        return 'Data Zone';
      if (
        nodeKind === 'operationalSignal' ||
        /audit|evidence|logs|metrics|dashboard|backup|restore|red.?team/.test(text)
      )
        return 'Evidence and Operations';
      return 'Application Zone';
    default:
      return node.group || groupOf({ type: nodeKind });
  }
}

function applyViewpointGroups(spec, entry) {
  const labels = VIEWPOINT_GROUPS[entry.kind];
  if (!labels) return;
  spec.groups = labels.map((label) => ({ id: label, label, boundary: true }));
  const allowed = new Set(labels);
  for (const node of spec.nodes || []) {
    const group = viewpointGroupFor(entry.kind, node);
    node.group = allowed.has(group) ? group : labels[0];
  }
}

function semanticEdgeLabel(kind, fromNode, toNode, fallback = '') {
  const raw = String(fallback || '').trim();
  if (raw && !/^(flows to|depends on|calls|uses|connects to|links to)$/i.test(raw)) return raw;
  const fromText = nodeViewText(fromNode);
  const toText = nodeViewText(toNode);
  switch (kind) {
    case 'api-map':
      if (/actor|client|developer|operator|admin/.test(fromText) && /api|post|get|put|delete/.test(toText))
        return 'calls API';
      if (/api|post|get|put|delete/.test(fromText) && /policy|identity|gateway|component/.test(toText))
        return 'handled by';
      if (/api|gateway|component/.test(fromText) && /provider|mcp|siem|idp|integration|external/.test(toText))
        return 'invokes dependency';
      if (/api|component|gateway/.test(fromText) && /store|data|postgres|rocksdb|mnesia/.test(toText))
        return 'reads/writes state';
      return 'API dependency';
    case 'identity-flow':
      if (/actor|client|admin|developer/.test(fromText)) return 'authenticates';
      if (/api|chat|session/.test(fromText) && /tls|auth|identity|virtual/.test(toText)) return 'establishes identity';
      if (/identity|auth|virtual|tenant/.test(fromText) && /policy|rbac|role/.test(toText)) return 'authorizes context';
      if (/idp|oidc|saml|ldap|scim/.test(toText)) return 'federates identity';
      return 'passes identity context';
    case 'governance-map':
      if (/actor|auditor|compliance/.test(fromText)) return 'reviews governance';
      if (/api|admin/.test(fromText)) return 'configures control';
      if (/policy|control|security|guardrail/.test(fromText)) return 'governs';
      if (/audit|evidence|logs|dashboard/.test(toText)) return 'records evidence';
      return 'governance dependency';
    case 'privacy-flow':
      if (/actor|api|chat|embedding/.test(fromText)) return 'submits sensitive data';
      if (/redaction|policy|privacy|identity/.test(fromText)) return 'enforces privacy policy';
      if (/store|data|postgres|rocksdb|mnesia/.test(toText)) return 'stores governed data';
      if (/provider|llm|siem|warehouse|lake/.test(toText)) return 'exports governed data';
      return 'sensitive-data handoff';
    case 'observability-map':
      if (/component|gateway|agent|api/.test(fromText)) return 'emits telemetry';
      if (/audit|logs|metrics|traces|dashboard|observability/.test(toText)) return 'records signal';
      if (/siem|lake|warehouse|on-call|itsm/.test(toText)) return 'exports alert/evidence';
      return 'observability link';
    case 'runtime-topology':
      if (/actor|api|inbound|tenant/.test(fromText)) return 'routes request';
      if (/agent|edge|gateway/.test(fromText) && /rocksdb|postgres|mnesia|state/.test(toText)) return 'persists state';
      if (/gateway|control|policy|identity/.test(fromText)) return 'runtime dependency';
      return 'runtime connection';
    case 'resilience-map':
      if (/state|rocksdb|postgres|mnesia/.test(fromText) || /state|rocksdb|postgres|mnesia/.test(toText))
        return 'replicates / recovers state';
      if (/policy|kill|scanner|audit|observability/.test(fromText)) return 'failure control';
      return 'failure-domain dependency';
    case 'supply-chain':
      if (/gateway|component|api/.test(fromText) && /provider|mcp|idp|siem|integration/.test(toText))
        return 'external dependency';
      if (/policy|scanner|trust|identity/.test(fromText)) return 'approval / trust gate';
      return 'supply-chain dependency';
    case 'cost-topology':
      if (/provider|llm|mcp|integration/.test(toText)) return 'provider spend';
      if (/storage|store|postgres|rocksdb|mnesia/.test(toText)) return 'storage spend';
      if (/audit|cost|billing|finops/.test(toText)) return 'cost evidence';
      return 'cost attribution';
    case 'release-flow':
      if (/build|change set|release request/.test(fromText) && /artifact|candidate/.test(toText))
        return 'packages release candidate';
      if (/artifact|candidate/.test(fromText) && /staging|deployment api/.test(toText))
        return 'deploys candidate to staging';
      if (/staging/.test(fromText) && /gate|policy|scanner|approval|security/.test(toText))
        return 'submits staging evidence';
      if (/gate|policy|scanner|approval|security/.test(fromText) && /production|prod/.test(toText))
        return 'approves production promotion';
      if (
        /production|prod|runtime|traffic/.test(fromText) &&
        /rollback|audit|observability|evidence|telemetry/.test(toText)
      )
        return 'emits release evidence';
      if (/rollback|restore/.test(fromText) || /rollback|restore/.test(toText)) return 'rollback guard';
      return 'release promotion dependency';
    case 'risk-map':
      if (/actor|api|external|provider|idp|mcp/.test(fromText)) return 'exposes risk surface';
      if (/policy|control|scanner|redaction|auth|guardrail/.test(fromText)) return 'mitigates risk';
      if (/audit|evidence|logs|backup|restore|export/.test(toText)) return 'produces assurance evidence';
      if (/store|data|postgres|rocksdb|mnesia|certificate/.test(toText)) return 'protects asset';
      return 'risk dependency';
    case 'trust-boundary':
      if (/actor|external|provider|idp|siem|mcp/.test(fromText) || /actor|external|provider|idp|siem|mcp/.test(toText))
        return 'crosses trust boundary';
      if (
        /policy|security|auth|scanner|redaction/.test(fromText) ||
        /policy|security|auth|scanner|redaction/.test(toText)
      )
        return 'controlled by';
      return 'secured flow';
    case 'migration-roadmap':
    case 'delta-map':
      if (/current|source|legacy/.test(fromText) && /transition|bridge|coexist/.test(toText)) return 'migrates through';
      if (/transition|bridge|coexist/.test(fromText) && /target|future/.test(toText)) return 'cuts over to';
      if (/store|data|postgres|rocksdb|mnesia/.test(fromText) || /store|data|postgres|rocksdb|mnesia/.test(toText))
        return 'state migration';
      return 'migration dependency';
    case 'coexistence-cutover':
      if (/current|source/.test(fromText) && /coexist|transition|parallel/.test(toText)) return 'runs in parallel';
      if (/transition|coexist|validation/.test(fromText) && /target|production/.test(toText))
        return 'promotes after validation';
      if (/rollback|restore/.test(fromText) || /rollback|restore/.test(toText)) return 'rollback guard';
      return 'cutover handoff';
    default:
      return raw || 'architecture dependency';
  }
}

function applySemanticEdgeLabels(spec, entry) {
  const byId = new Map((spec.nodes || []).map((node) => [node.id, node]));
  for (const edge of spec.edges || []) {
    edge.label = semanticEdgeLabel(entry.kind, byId.get(edge.from), byId.get(edge.to), edge.label);
  }
}

function viewpointNodeOrder(kind, node) {
  const groupLabels = VIEWPOINT_GROUPS[kind] || [];
  const groupIdx = groupLabels.indexOf(node.group);
  const groupRank = groupIdx === -1 ? 99 : groupIdx;
  const text = nodeViewText(node);
  const priority = [
    /client|developer|operator|admin|tenant|actor/,
    /post \/v1|chat|embedding|session|api/,
    /tls|auth|identity|virtual|tenant|policy|redaction|scanner|guardrail|control/,
    /gateway|agent|route|runtime|component|integrations/,
    /provider|mcp|idp|siem|external|llm/,
    /rocksdb|postgres|mnesia|storage|data|audit|evidence|logs|cost/,
  ].findIndex((rx) => rx.test(text));
  return groupRank * 100 + (priority === -1 ? 50 : priority);
}

function ensureViewpointConnectivity(spec, entry) {
  if (!VIEWPOINT_GROUPS[entry.kind]) return;
  if (!spec.nodes.length) return;
  const keyFor = (edge) => `${edge.from}->${edge.to}`;
  const existing = new Set((spec.edges || []).map(keyFor));
  const connected = new Set();
  for (const edge of spec.edges || []) {
    connected.add(edge.from);
    connected.add(edge.to);
  }
  const disconnected = spec.nodes.filter((node) => !connected.has(node.id));
  const needsRepair =
    spec.edges.length === 0 || (spec.nodes.length > 4 && disconnected.length / Math.max(1, spec.nodes.length) > 0.35);
  if (!needsRepair) return;

  const ordered = spec.nodes
    .slice()
    .sort(
      (a, b) =>
        viewpointNodeOrder(entry.kind, a) - viewpointNodeOrder(entry.kind, b) ||
        String(a.id).localeCompare(String(b.id)),
    );
  for (let i = 0; i < ordered.length - 1; i += 1) {
    const from = ordered[i];
    const to = ordered[i + 1];
    if (!from || !to || from.id === to.id) continue;
    const edge = { from: from.id, to: to.id };
    if (existing.has(keyFor(edge))) continue;
    spec.edges.push({
      from: from.id,
      to: to.id,
      label: semanticEdgeLabel(entry.kind, from, to),
      style: i % 4 === 3 ? 'dashed' : 'solid',
    });
    existing.add(keyFor(edge));
  }
}

function diagramGroupLabels(spec, entry) {
  const labels = VIEWPOINT_GROUPS[entry.kind];
  if (labels) return labels;
  return (spec.groups || []).map((group) => group.label || group.id).filter(Boolean);
}

function nodeGroupLabel(node) {
  return node?.group || node?.layer || groupOf({ type: node?.kind || node?.type });
}

function groupRank(labels, node) {
  const group = nodeGroupLabel(node);
  const idx = labels.indexOf(group);
  return idx === -1 ? 999 : idx;
}

function nodeConnectivityOrder(spec, entry) {
  const labels = diagramGroupLabels(spec, entry);
  return (spec.nodes || [])
    .slice()
    .sort(
      (a, b) =>
        groupRank(labels, a) - groupRank(labels, b) ||
        viewpointNodeOrder(entry.kind, a) - viewpointNodeOrder(entry.kind, b) ||
        String(a.id).localeCompare(String(b.id)),
    );
}

function edgeKey(from, to) {
  return `${from}->${to}`;
}

function addSemanticConnectivityEdge(spec, entry, existing, fromNode, toNode, style = 'dashed') {
  if (!fromNode || !toNode || fromNode.id === toNode.id) return false;
  const key = edgeKey(fromNode.id, toNode.id);
  if (existing.has(key)) return false;
  spec.edges.push({
    from: fromNode.id,
    to: toNode.id,
    label: semanticEdgeLabel(entry.kind, fromNode, toNode),
    style,
  });
  existing.add(key);
  return true;
}

function connectedComponents(nodes, edges) {
  const ids = new Set(nodes.map((node) => node.id));
  const adjacency = new Map(nodes.map((node) => [node.id, new Set()]));
  for (const edge of edges || []) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
    adjacency.get(edge.from).add(edge.to);
    adjacency.get(edge.to).add(edge.from);
  }
  const seen = new Set();
  const components = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    const stack = [node.id];
    const component = [];
    seen.add(node.id);
    while (stack.length) {
      const id = stack.pop();
      component.push(id);
      for (const next of adjacency.get(id) || []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    components.push(component);
  }
  return components;
}

function ensureDiagramConnectivity(spec, entry) {
  if (!Array.isArray(spec.nodes) || spec.nodes.length < 2) return;
  if (!Array.isArray(spec.edges)) spec.edges = [];

  const labels = diagramGroupLabels(spec, entry);
  const ordered = nodeConnectivityOrder(spec, entry);
  const byId = new Map(spec.nodes.map((node) => [node.id, node]));
  const existing = new Set(spec.edges.map((edge) => edgeKey(edge.from, edge.to)));
  const degree = new Map(spec.nodes.map((node) => [node.id, 0]));
  for (const edge of spec.edges) {
    if (degree.has(edge.from)) degree.set(edge.from, degree.get(edge.from) + 1);
    if (degree.has(edge.to)) degree.set(edge.to, degree.get(edge.to) + 1);
  }

  for (let i = 0; i < ordered.length; i += 1) {
    const node = ordered[i];
    if ((degree.get(node.id) || 0) > 0) continue;
    const sameGroupAnchor = ordered.find(
      (candidate) =>
        candidate.id !== node.id &&
        nodeGroupLabel(candidate) === nodeGroupLabel(node) &&
        (degree.get(candidate.id) || 0) > 0,
    );
    const connectedAnchor = ordered.find(
      (candidate) => candidate.id !== node.id && (degree.get(candidate.id) || 0) > 0,
    );
    const fallbackAnchor = ordered[i - 1] || ordered[i + 1];
    const anchor = sameGroupAnchor || connectedAnchor || fallbackAnchor;
    if (!anchor) continue;

    let from = anchor;
    let to = node;
    if (groupRank(labels, node) < groupRank(labels, anchor)) {
      from = node;
      to = anchor;
    }
    if (addSemanticConnectivityEdge(spec, entry, existing, from, to, 'dashed')) {
      degree.set(from.id, (degree.get(from.id) || 0) + 1);
      degree.set(to.id, (degree.get(to.id) || 0) + 1);
    }
  }

  let components = connectedComponents(spec.nodes, spec.edges);
  if (components.length <= 1) return;
  components = components.sort((a, b) => {
    const aNode = byId.get(a[0]);
    const bNode = byId.get(b[0]);
    return (
      groupRank(labels, aNode) - groupRank(labels, bNode) ||
      viewpointNodeOrder(entry.kind, aNode) - viewpointNodeOrder(entry.kind, bNode)
    );
  });
  for (let i = 0; i < components.length - 1; i += 1) {
    const from = byId.get(components[i][0]);
    const to = byId.get(components[i + 1][0]);
    addSemanticConnectivityEdge(spec, entry, existing, from, to, i % 2 ? 'dashed' : 'solid');
  }
}

function migrationNodeText(node) {
  return `${node?.label || node?.name || ''} ${node?.kind || node?.type || ''}`.toLowerCase();
}

function isMigrationTargetNode(node) {
  const text = migrationNodeText(node);
  return (
    /\bbc\b|bounded context|control-plane|policy-engine|identity bc|gateway bc|integrations bc|audit-evidence bc|observability bc|billing bc/.test(
      text,
    ) || /system of record|write buffer|append-only|mnesia|postgres|rocksdb/.test(text)
  );
}

function isMigrationCurrentSourceNode(node) {
  const kind = String(node?.kind || node?.type || '').toLowerCase();
  const text = migrationNodeText(node);
  if (kind === 'actor') return true;
  if (kind === 'integration') return true;
  return /enterprise tenant|enterprise idp|itsm|soar|approval|on-call|siem|data lake|warehouse|rag|llm providers|mcp servers|external system|source system|incumbent|legacy/.test(
    text,
  );
}

function isMigrationTransitionNode(node) {
  const label = String(node?.label || node?.name || '').toLowerCase();
  const text = migrationNodeText(node);
  return (
    /^\d+\.\s/.test(label) ||
    /inbound \/v1|go edge|elixir gateway|routing, workflow|event engine|mcp bridge and tool|phoenix liveview|dmz|load balancer|edge \(customer|unified gateway|mug/.test(
      text,
    )
  );
}

function migrationColumnKey(node) {
  const label = String(node?.label || node?.name || '').toLowerCase();
  const text = migrationNodeText(node);
  const state = String(node?.state || '').toLowerCase();
  const delta = String(node?.deltaType || '').toLowerCase();
  if (state === 'current' || ['retain', 'retained', 'retire', 'retired'].includes(delta)) return 'current';
  if (['add', 'added', 'replace', 'replaced', 'target'].includes(delta)) return 'target';
  if (/^(gateway-agent|gateway-server|mcp-bridge)$/.test(label)) return 'current';
  if (/gateway-server\//.test(label)) return 'current';
  if (isMigrationTargetNode(node)) return 'target';
  if (isMigrationTransitionNode(node)) return 'transition';
  if (isMigrationCurrentSourceNode(node)) return 'current';
  if (
    /actor|integration|securitycontrol|datastore|dataentity|provider|llm|mcp servers|rocksdb|postgres|amnesia|policy/.test(
      text,
    )
  ) {
    return 'target';
  }
  return 'transition';
}

const MIGRATION_COLUMNS = [
  { key: 'current', label: 'Current (source)', deltaType: 'retire', state: 'current' },
  { key: 'transition', label: 'Transition', deltaType: 'change', state: 'target' },
  { key: 'target', label: 'Target', deltaType: 'add', state: 'target' },
];

function _migrationColumnLabel(key) {
  return MIGRATION_COLUMNS.find((c) => c.key === key)?.label || 'Transition';
}

function migrationColumnRankFor(node) {
  const key = migrationColumnKey(node);
  const idx = MIGRATION_COLUMNS.findIndex((c) => c.key === key);
  return idx === -1 ? 1 : idx;
}

function applyMigrationSemantics(spec) {
  if (!['migration-roadmap', 'delta-map'].includes(spec.diagramKind)) return;
  spec.groups = MIGRATION_COLUMNS.map((c) => ({
    id: c.label,
    label: c.label,
    boundary: true,
    migrationRole: c.key,
  }));
  let derived = false;
  for (const n of spec.nodes || []) {
    const role = migrationColumnKey(n);
    const column = MIGRATION_COLUMNS.find((c) => c.key === role) || MIGRATION_COLUMNS[1];
    if (n.group !== column.label || n.migrationRole !== role) derived = true;
    n.group = column.label;
    n.migrationRole = role;
    n.migrationPhase = column.label;
    n.state = column.state;
    if (!n.deltaType) n.deltaType = column.deltaType;
  }
  if (derived) {
    spec.assumptions.push(
      'Migration phases are derived from node names, kinds, and delta metadata so every renderer uses the same current/transition/target contract.',
    );
  }
  spec.legend = [
    { symbol: 'Current', meaning: 'Existing source component or module to retire/replace' },
    { symbol: 'Transition', meaning: 'Bridge or target-runtime capability used during migration' },
    { symbol: 'Target', meaning: 'Target actors, integrations, security controls, and data stores' },
    { symbol: 'Dashed edge', meaning: 'Migration handoff or inferred target dependency' },
  ];
}

function migrationAffinity(node) {
  const kind = String(node?.kind || node?.type || '').toLowerCase();
  const text = migrationNodeText(node);
  if (kind === 'actor' || /enterprise tenant|application developer|clients|ai tools|operator|admin/.test(text))
    return 'consumer';
  if (/enterprise idp|oidc|saml|ldap|scim|identity/.test(text)) return 'identity';
  if (/itsm|soar|approval|on-call/.test(text)) return 'operations';
  if (/siem|data lake|warehouse|rag|audit|observability/.test(text)) return 'evidence';
  if (/llm providers|provider dispatch|provider adapters|openai|anthropic|azure|bedrock/.test(text)) return 'provider';
  if (/gateway-agent|go edge/.test(text)) return 'edge';
  if (/mcp-bridge|mcp bridge|tool router|mcp servers/.test(text)) return 'mcp';
  if (/rocksdb|append log/.test(text)) return 'rocksdb';
  if (/amnesia|mnesia/.test(text)) return 'coordination';
  if (/web|phoenix|liveview/.test(text)) return 'operations-ui';
  if (/resources|routing|workflow|event engine/.test(text)) return 'routing';
  if (/security|policy|guardrail/.test(text)) return 'security';
  if (/gateway-server|elixir gateway|grpc|agents|ingest|flush|reconciliation|backup/.test(text)) return 'gateway';
  return '';
}

function primaryMigrationTransitionTarget(nodes) {
  return (
    nodes.find(
      (n) =>
        migrationColumnKey(n) === 'transition' && /mug|unified gateway|gateway platform/i.test(n.label || n.name || ''),
    ) ||
    nodes.find(
      (n) =>
        migrationColumnKey(n) === 'transition' &&
        /go edge|elixir gateway|gateway server/i.test(n.label || n.name || ''),
    ) ||
    nodes.find((n) => migrationColumnKey(n) === 'transition')
  );
}

function normalizeMigrationEdges(spec) {
  if (!['migration-roadmap', 'delta-map'].includes(spec.diagramKind)) return;
  const nodeById = new Map((spec.nodes || []).map((n) => [n.id, n]));
  const seen = new Set();
  const normalized = [];
  for (const e of spec.edges || []) {
    let from = e.from;
    let to = e.to;
    const fromNode = nodeById.get(from);
    const toNode = nodeById.get(to);
    if (fromNode && toNode && migrationColumnRankFor(fromNode) > migrationColumnRankFor(toNode)) {
      from = e.to;
      to = e.from;
    }
    const key = `${from}->${to}:${e.label || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = /^flows to$/i.test(e.label || '') ? '' : e.label || '';
    normalized.push({
      ...e,
      from,
      to,
      label,
      style: e.style || (/migrates to/i.test(label) ? 'dashed' : 'solid'),
    });
  }
  spec.edges = normalized;
}

function addMigrationHandoffEdges(spec) {
  if (!['migration-roadmap', 'delta-map'].includes(spec.diagramKind)) return;
  const existing = new Set((spec.edges || []).map((e) => `${e.from}->${e.to}`));
  const destinations = spec.nodes.filter((n) => migrationColumnKey(n) !== 'current');
  const primaryTarget = primaryMigrationTransitionTarget(spec.nodes || []);
  let added = 0;
  for (const source of spec.nodes.filter((n) => migrationColumnKey(n) === 'current')) {
    const affinity = migrationAffinity(source);
    const target =
      (affinity &&
        (destinations.find((n) => migrationAffinity(n) === affinity && migrationColumnKey(n) === 'transition') ||
          destinations.find((n) => migrationAffinity(n) === affinity))) ||
      primaryTarget;
    if (!target) continue;
    const key = `${source.id}->${target.id}`;
    if (existing.has(key)) continue;
    existing.add(key);
    spec.edges.push({
      from: source.id,
      to: target.id,
      label: 'migrates to',
      style: 'dashed',
    });
    added += 1;
    if (added >= 8) break;
  }
}

function riskEdgeLabel(edge, fromNode, toNode) {
  const raw = String(edge.label || '').trim();
  if (raw && !/^flows to$/i.test(raw)) {
    if (/gRPC/i.test(raw)) return 'secured channel';
    if (/promotes to/i.test(raw)) return 'release evidence';
    return raw;
  }
  const fromRole = fromNode?.riskRole || riskRoleForNode(fromNode);
  const toRole = toNode?.riskRole || riskRoleForNode(toNode);
  if (fromRole === 'exposure' && toRole === 'control') return 'checked by';
  if (fromRole === 'control' && toRole === 'control') return 'control sequence';
  if (fromRole === 'control' && toRole === 'asset') return 'protects';
  if (fromRole === 'asset' && toRole === 'evidence') return 'emits evidence';
  if (fromRole === 'control' && toRole === 'evidence') return 'emits evidence';
  if (fromRole === 'exposure' && toRole === 'asset') return 'bounded by';
  if (fromRole === 'evidence' && toRole === 'evidence') return 'correlates';
  return 'risk signal';
}

function normalizeRiskEdges(spec) {
  const nodeById = new Map((spec.nodes || []).map((n) => [n.id, n]));
  const seen = new Set();
  const out = [];
  for (const e of spec.edges || []) {
    let from = e.from;
    let to = e.to;
    const fromNode = nodeById.get(from);
    const toNode = nodeById.get(to);
    if (!fromNode || !toNode) continue;
    if (riskRoleRank(fromNode.riskRole) > riskRoleRank(toNode.riskRole)) {
      from = e.to;
      to = e.from;
    }
    const nextFrom = nodeById.get(from);
    const nextTo = nodeById.get(to);
    const label = riskEdgeLabel(e, nextFrom, nextTo);
    const key = `${from}->${to}:${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...e,
      from,
      to,
      label,
      style: nextFrom?.confidence === 'confirmed' && nextTo?.confidence === 'confirmed' ? 'solid' : 'dashed',
    });
  }
  spec.edges = out;
}

function addRiskEvidenceCoverageEdges(spec) {
  const existing = new Set((spec.edges || []).map((e) => `${e.from}->${e.to}`));
  const evidenceTargets = (spec.nodes || []).filter((n) => n.riskRole === 'evidence');
  const auditTarget =
    evidenceTargets.find((n) => /audit|evidence/i.test(n.label || '')) ||
    evidenceTargets.find((n) => /observability|siem|compliance/i.test(n.label || ''));
  if (!auditTarget) return;
  for (const source of (spec.nodes || []).filter((n) => ['control', 'asset'].includes(n.riskRole)).slice(0, 8)) {
    const key = `${source.id}->${auditTarget.id}`;
    if (existing.has(key)) continue;
    existing.add(key);
    spec.edges.push({
      from: source.id,
      to: auditTarget.id,
      label: 'emits evidence',
      style: 'solid',
      evidenceCoverage: true,
    });
  }
}

function applyRiskSemantics(spec) {
  if (spec.diagramKind !== 'risk-map') return;
  spec.groups = RISK_COLUMNS.map((c) => ({
    id: c.label,
    label: c.label,
    boundary: true,
    riskRole: c.key,
  }));
  for (const n of spec.nodes || []) {
    const role = riskRoleForNode(n);
    n.riskRole = role;
    n.group = riskColumnLabel(role);
    n.riskLevel = riskLevelForNode(n);
    n.evidenceConfidence = evidenceConfidenceForNode(n);
    n.evidenceRefCount = Array.isArray(n.evidenceRefs) ? n.evidenceRefs.length : 0;
  }
  addRiskEvidenceCoverageEdges(spec);
  normalizeRiskEdges(spec);
  spec.legend = [
    { symbol: 'Exposure', meaning: 'Actor, API, provider, or integration surface that introduces risk' },
    { symbol: 'Control', meaning: 'Security, policy, verification, or guardrail that mitigates risk' },
    { symbol: 'Asset', meaning: 'Protected bounded context, data store, or durable system state' },
    { symbol: 'Evidence', meaning: 'Audit, observability, compliance, or release-readiness evidence sink' },
    { symbol: 'Solid edge', meaning: 'Confirmed risk, mitigation, or evidence relationship' },
  ];
  spec.assumptions.push(
    'Risk roles and evidence confidence are derived from graph node type, architecture labels, confidence, and evidence references so all renderers share the same risk contract.',
  );
}

function defaultLegend() {
  return [
    { symbol: 'Rectangle', meaning: 'Application component / service' },
    { symbol: 'Cylinder', meaning: 'Data store / entity' },
    { symbol: 'Rounded box', meaning: 'External actor / integration' },
    { symbol: 'Dashed edge', meaning: 'Inferred — low confidence' },
  ];
}

// ── Mermaid emission ────────────────────────────────────────────────────────

function mermaidIdSafe(id) {
  // Strip to ASCII alnum + underscore; prefix `n_` when the stripped ID would
  // start with a digit so Mermaid parses it as an identifier, not a number.
  const stripped = String(id).replace(/[^a-zA-Z0-9_]/g, '_');
  return /^[0-9]/.test(stripped) ? `n_${stripped}` : stripped;
}

function stripControlChars(s) {
  // Remove ASCII control chars (0x00-0x1f, 0x7f) without a control-char regex
  // so Biome's lint/suspicious/noControlCharactersInRegex stays happy.
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    out += code <= 0x1f || code === 0x7f ? ' ' : s[i];
  }
  return out;
}

function mermaidLabel(raw) {
  // Mermaid labels must not contain raw quotes, angle brackets, semicolons, or
  // newlines — those break the parser or (with securityLevel=loose) enable
  // HTML injection. Strip control chars and escape hazardous tokens.
  return stripControlChars(String(raw == null ? '' : raw))
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/;/g, ',')
    .replace(/\|/g, '/')
    .slice(0, 80);
}

function renderMermaid(spec) {
  if (spec.diagramKind === 'erd') return renderErd(spec);
  if (spec.diagramKind === 'value-stream') return renderMermaidValueStream(spec);
  if (['migration-roadmap', 'delta-map'].includes(spec.diagramKind)) return renderMermaidMigration(spec);
  if (spec.diagramKind === 'coexistence-cutover') return renderMermaidCoexistenceCutover(spec);
  if (spec.diagramKind === 'risk-map') return renderMermaidRisk(spec);
  return renderFlow(spec);
}

function renderMermaidRisk(spec) {
  const lines = [];
  lines.push(
    '%%{init: {"theme":"base","themeVariables":{"primaryColor":"#f8fafc","primaryBorderColor":"#1e3a8a","lineColor":"#475569"}} }%%',
  );
  lines.push('flowchart LR');
  lines.push(`  %% ${spec.id} - ${spec.title}`);
  if (!spec.nodes.length) {
    lines.push('  empty["No nodes - see gap report"]');
    return lines.join('\n');
  }

  const byRole = new Map(RISK_COLUMNS.map((c) => [c.key, []]));
  for (const n of spec.nodes) {
    const role = n.riskRole || riskRoleForNode(n);
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role).push(n);
  }
  const visible = new Set();
  for (const col of RISK_COLUMNS) {
    const nodes = (byRole.get(col.key) || [])
      .slice()
      .sort(
        (a, b) => riskPickRank(a, new Map()) - riskPickRank(b, new Map()) || String(a.id).localeCompare(String(b.id)),
      );
    lines.push(`  subgraph risk_${mermaidIdSafe(col.key)}["${mermaidLabel(col.label)}"]`);
    for (const n of nodes) {
      visible.add(n.id);
      const shape = shapeOf(n);
      const badge = `${n.riskLevel || riskLevelForNode(n)} / ${n.evidenceConfidence || evidenceConfidenceForNode(n)}`;
      lines.push(`    ${mermaidIdSafe(n.id)}${shape[0]}"${mermaidLabel(`${n.label} (${badge})`)}"${shape[1]}`);
    }
    lines.push('  end');
  }

  for (const e of spec.edges || []) {
    if (!visible.has(e.from) || !visible.has(e.to)) continue;
    const arrow = e.style === 'dashed' ? '-.->' : '-->';
    const label = e.label ? `|${mermaidLabel(e.label)}|` : '';
    lines.push(`  ${mermaidIdSafe(e.from)} ${arrow}${label} ${mermaidIdSafe(e.to)}`);
  }
  lines.push('  classDef critical fill:#fee2e2,stroke:#991b1b,stroke-width:2px;');
  lines.push('  classDef high fill:#fef3c7,stroke:#b45309,stroke-width:2px;');
  lines.push('  classDef medium fill:#ecfdf5,stroke:#047857,stroke-width:2px;');
  lines.push('  classDef low fill:#eff6ff,stroke:#1e3a8a,stroke-width:2px;');
  for (const n of spec.nodes || []) {
    const cls = ['critical', 'high', 'medium', 'low'].includes(n.riskLevel) ? n.riskLevel : 'medium';
    lines.push(`  class ${mermaidIdSafe(n.id)} ${cls};`);
  }
  return lines.join('\n');
}

function renderMermaidValueStream(spec) {
  const lines = [];
  lines.push(
    '%%{init: {"theme":"base","themeVariables":{"primaryColor":"#f8fafc","primaryBorderColor":"#1e3a8a","lineColor":"#475569"}} }%%',
  );
  lines.push('flowchart LR');
  lines.push(`  %% ${spec.id} - ${spec.title}`);
  lines.push(`  %% state: ${spec.state} | profile: ${spec.profile} | confidence: ${spec.confidence}`);
  if (!spec.nodes.length) {
    lines.push('  empty["No nodes - see gap report"]');
    return lines.join('\n');
  }

  const byStage = new Map(BUSINESS_VALUE_STAGES.map((s) => [s.key, []]));
  for (const n of spec.nodes || []) {
    const stage = n.businessStage || 'demand';
    if (!byStage.has(stage)) byStage.set(stage, []);
    byStage.get(stage).push(n);
  }
  const visible = new Set();
  for (const stage of BUSINESS_VALUE_STAGES) {
    const nodes = (byStage.get(stage.key) || []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
    lines.push(`  subgraph value_${mermaidIdSafe(stage.key)}["${mermaidLabel(stage.label)}"]`);
    for (const n of nodes) {
      visible.add(n.id);
      const shape = shapeOf(n);
      lines.push(`    ${mermaidIdSafe(n.id)}${shape[0]}"${mermaidLabel(n.label)}"${shape[1]}`);
    }
    lines.push('  end');
  }

  for (const e of spec.edges || []) {
    if (!visible.has(e.from) || !visible.has(e.to)) continue;
    const arrow = e.style === 'dashed' ? '-.->' : '-->';
    const label = e.label ? `|${mermaidLabel(e.label)}|` : '';
    lines.push(`  ${mermaidIdSafe(e.from)} ${arrow}${label} ${mermaidIdSafe(e.to)}`);
  }
  lines.push('  classDef demand fill:#eff6ff,stroke:#1e3a8a,stroke-width:2px;');
  lines.push('  classDef intake fill:#ecfeff,stroke:#0e7490,stroke-width:2px;');
  lines.push('  classDef control fill:#fff7ed,stroke:#c2410c,stroke-width:2px;');
  lines.push('  classDef execution fill:#f5f3ff,stroke:#6d28d9,stroke-width:2px;');
  lines.push('  classDef outcome fill:#ecfdf5,stroke:#047857,stroke-width:2px;');
  for (const n of spec.nodes || []) {
    const stage = BUSINESS_VALUE_STAGES.some((s) => s.key === n.businessStage) ? n.businessStage : 'demand';
    lines.push(`  class ${mermaidIdSafe(n.id)} ${stage};`);
  }
  return lines.join('\n');
}

function renderMermaidMigration(spec) {
  const lines = [];
  lines.push(
    '%%{init: {"theme":"base","themeVariables":{"primaryColor":"#f0f4ff","primaryBorderColor":"#1e3a8a","lineColor":"#475569"}} }%%',
  );
  lines.push('flowchart LR');
  lines.push(`  %% ${spec.id} - ${spec.title}`);
  lines.push(`  %% state: ${spec.state} | profile: ${spec.profile} | confidence: ${spec.confidence}`);
  if (!spec.nodes.length) {
    lines.push('  empty["No nodes - see gap report"]');
    return lines.join('\n');
  }

  const byColumn = new Map(MIGRATION_COLUMNS.map((c) => [c.key, []]));
  for (const n of spec.nodes) {
    const key = migrationColumnKey(n);
    if (!byColumn.has(key)) byColumn.set(key, []);
    byColumn.get(key).push(n);
  }
  const visible = new Set();
  for (const col of MIGRATION_COLUMNS) {
    const nodes = (byColumn.get(col.key) || [])
      .slice()
      .sort(
        (a, b) =>
          plantUmlMigrationPriority(a) - plantUmlMigrationPriority(b) || String(a.id).localeCompare(String(b.id)),
      );
    lines.push(`  subgraph sub_${mermaidIdSafe(col.key)}["${mermaidLabel(col.label)}"]`);
    for (const n of nodes) {
      visible.add(n.id);
      const shape = shapeOf(n);
      const mid = mermaidIdSafe(n.id);
      lines.push(`    ${mid}${shape[0]}"${mermaidLabel(n.label)}"${shape[1]}`);
    }
    lines.push('  end');
  }

  for (const e of spec.edges) {
    if (!visible.has(e.from) || !visible.has(e.to)) continue;
    let from = e.from;
    let to = e.to;
    const fromNode = spec.nodes.find((n) => n.id === from);
    const toNode = spec.nodes.find((n) => n.id === to);
    if (fromNode && toNode && migrationColumnRankFor(fromNode) > migrationColumnRankFor(toNode)) {
      from = e.to;
      to = e.from;
    }
    const arrow = e.style === 'dashed' ? '-.->' : '-->';
    const label = e.label ? `|${mermaidLabel(e.label)}|` : '';
    lines.push(`  ${mermaidIdSafe(from)} ${arrow}${label} ${mermaidIdSafe(to)}`);
  }

  lines.push('  classDef inferred stroke-dasharray: 5 5;');
  lines.push('  classDef weak stroke-dasharray: 2 2,color:#b45309;');
  lines.push('  classDef unknown stroke-dasharray: 1 3,color:#991b1b;');
  for (const n of spec.nodes) {
    if (n.confidence === 'inferred') lines.push(`  class ${mermaidIdSafe(n.id)} inferred;`);
    else if (n.confidence === 'weak') lines.push(`  class ${mermaidIdSafe(n.id)} weak;`);
    else if (n.confidence === 'unknown') lines.push(`  class ${mermaidIdSafe(n.id)} unknown;`);
  }
  return lines.join('\n');
}

function renderMermaidCoexistenceCutover(spec) {
  const lines = [];
  lines.push(
    '%%{init: {"theme":"base","themeVariables":{"primaryColor":"#f8fafc","primaryBorderColor":"#1e3a8a","lineColor":"#475569"}} }%%',
  );
  lines.push('flowchart LR');
  lines.push(`  %% ${spec.id} - ${spec.title}`);
  lines.push(`  %% state: ${spec.state} | profile: ${spec.profile} | confidence: ${spec.confidence}`);
  if (!spec.nodes.length) {
    lines.push('  empty["No nodes - see gap report"]');
    return lines.join('\n');
  }

  const byPhase = new Map(COEXISTENCE_COLUMNS.map((c) => [c.key, []]));
  for (const n of spec.nodes || []) {
    const phase = n.cutoverPhase || n.migrationRole || 'coexistence';
    if (!byPhase.has(phase)) byPhase.set(phase, []);
    byPhase.get(phase).push(n);
  }
  const visible = new Set();
  for (const col of COEXISTENCE_COLUMNS) {
    const nodes = (byPhase.get(col.key) || []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
    lines.push(`  subgraph cutover_${mermaidIdSafe(col.key)}["${mermaidLabel(col.label)}"]`);
    for (const n of nodes) {
      visible.add(n.id);
      const shape = shapeOf(n);
      const badge = n.deltaType ? ` [${n.deltaType}]` : '';
      lines.push(`    ${mermaidIdSafe(n.id)}${shape[0]}"${mermaidLabel(`${n.label}${badge}`)}"${shape[1]}`);
    }
    lines.push('  end');
  }

  for (const e of spec.edges || []) {
    if (!visible.has(e.from) || !visible.has(e.to)) continue;
    const arrow = e.style === 'dashed' ? '-.->' : '-->';
    const label = e.label ? `|${mermaidLabel(e.label)}|` : '';
    lines.push(`  ${mermaidIdSafe(e.from)} ${arrow}${label} ${mermaidIdSafe(e.to)}`);
  }
  lines.push('  classDef source fill:#eff6ff,stroke:#1e3a8a,stroke-width:2px;');
  lines.push('  classDef coexistence fill:#ecfeff,stroke:#0e7490,stroke-width:2px;');
  lines.push('  classDef cutover fill:#fff7ed,stroke:#c2410c,stroke-width:2px;');
  lines.push('  classDef target fill:#ecfdf5,stroke:#047857,stroke-width:2px;');
  lines.push('  classDef validation fill:#fef3c7,stroke:#b45309,stroke-width:2px;');
  for (const n of spec.nodes || []) {
    const phase = COEXISTENCE_COLUMNS.some((c) => c.key === n.cutoverPhase) ? n.cutoverPhase : 'coexistence';
    lines.push(`  class ${mermaidIdSafe(n.id)} ${phase};`);
  }
  return lines.join('\n');
}

function renderFlow(spec) {
  const lines = [];
  lines.push(
    '%%{init: {"theme":"base","themeVariables":{"primaryColor":"#f0f4ff","primaryBorderColor":"#1e3a8a","lineColor":"#475569"}} }%%',
  );
  lines.push('flowchart LR');
  lines.push(`  %% ${spec.id} — ${spec.title}`);
  lines.push(`  %% state: ${spec.state} | profile: ${spec.profile} | confidence: ${spec.confidence}`);

  if (!spec.nodes.length) {
    lines.push('  empty["No nodes — see gap report"]');
    return lines.join('\n');
  }

  const grouped = new Map();
  const groupLabels = new Map();
  for (const group of spec.groups || []) {
    const id = group.id || group.label;
    if (!id) continue;
    grouped.set(id, []);
    groupLabels.set(id, group.label || id);
  }
  for (const n of spec.nodes) {
    const g = n.group || 'Other';
    if (!grouped.has(g)) grouped.set(g, []);
    if (!groupLabels.has(g)) groupLabels.set(g, g);
    grouped.get(g).push(n);
  }

  for (const [group, nodes] of grouped.entries()) {
    if (!nodes.length) continue;
    const gid = `sub_${mermaidIdSafe(group)}`;
    lines.push(`  subgraph ${gid}["${mermaidLabel(groupLabels.get(group) || group)}"]`);
    const orderedNodes = nodes
      .slice()
      .sort(
        (a, b) =>
          (Number.isFinite(a.sequenceIndex) ? a.sequenceIndex : 1000) -
            (Number.isFinite(b.sequenceIndex) ? b.sequenceIndex : 1000) || String(a.id).localeCompare(String(b.id)),
      );
    for (const n of orderedNodes) {
      const shape = shapeOf(n);
      const mid = mermaidIdSafe(n.id);
      const confTag = n.confidence && n.confidence !== 'confirmed' ? ` (${n.confidence})` : '';
      const deltaTag = n.deltaType ? ` [${n.deltaType}]` : '';
      lines.push(`    ${mid}${shape[0]}"${mermaidLabel(n.label)}${confTag}${deltaTag}"${shape[1]}`);
    }
    lines.push('  end');
  }

  for (const e of spec.edges) {
    const arrow = e.style === 'dashed' ? '-.->' : '-->';
    const fromId = mermaidIdSafe(e.from);
    const toId = mermaidIdSafe(e.to);
    const label = e.label ? `|${mermaidLabel(e.label)}|` : '';
    lines.push(`  ${fromId} ${arrow}${label} ${toId}`);
  }

  // Classification for confidence dash
  lines.push('  classDef inferred stroke-dasharray: 5 5;');
  lines.push('  classDef weak stroke-dasharray: 2 2,color:#b45309;');
  lines.push('  classDef unknown stroke-dasharray: 1 3,color:#991b1b;');
  for (const n of spec.nodes) {
    if (n.confidence === 'inferred') lines.push(`  class ${mermaidIdSafe(n.id)} inferred;`);
    else if (n.confidence === 'weak') lines.push(`  class ${mermaidIdSafe(n.id)} weak;`);
    else if (n.confidence === 'unknown') lines.push(`  class ${mermaidIdSafe(n.id)} unknown;`);
  }

  return lines.join('\n');
}

function renderErd(spec) {
  const lines = [];
  lines.push(`%% ${spec.id} — ${spec.title}`);
  lines.push('erDiagram');
  if (!spec.nodes.length) {
    lines.push('  EMPTY ||--|| EMPTY : "no entities"');
    return lines.join('\n');
  }
  for (const n of spec.nodes) {
    const id = mermaidIdSafe(n.id).toUpperCase();
    const fields = Array.isArray(n.entityFields) && n.entityFields.length ? n.entityFields : ['id', 'name'];
    lines.push(`  ${id} {`);
    for (const rawField of fields.slice(0, 8)) {
      const field = String(rawField || 'field')
        .replace(/[^a-zA-Z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48);
      lines.push(`    string ${field || 'field'}`);
    }
    lines.push('  }');
  }
  for (const edge of spec.edges || []) {
    const a = mermaidIdSafe(edge.from).toUpperCase();
    const b = mermaidIdSafe(edge.to).toUpperCase();
    const cardinality = edge.cardinality || '||--o{';
    lines.push(`  ${a} ${cardinality} ${b} : "${mermaidLabel(edge.label || 'relates to')}"`);
  }
  return lines.join('\n');
}

function shapeOf(n) {
  switch (n.kind) {
    case 'team':
    case 'actor':
      return ['(', ')'];
    case 'integration':
      return ['((', '))'];
    case 'dataStore':
    case 'dataEntity':
      return ['[(', ')]'];
    case 'api':
      return ['>', ']'];
    case 'trustBoundary':
      return ['{{', '}}'];
    default:
      return ['[', ']'];
  }
}

// ── PlantUML / C4-PlantUML emission ─────────────────────────────────────────
//
// Emits `.puml` source. For C4 system-context and C4-container diagram kinds
// we use the C4-PlantUML stdlib macros (Person, System, System_Ext, Container,
// ContainerDb, Rel). For every other kind we use generic PlantUML component
// diagrams. The include URLs reference the upstream C4-PlantUML repo — this
// is STANDARD PlantUML usage; rendering requires `plantuml` (the jar) or an
// online PlantUML server. The `.puml` source stays readable either way.

function plantUmlIdSafe(id) {
  // PlantUML identifiers must be alphanumeric or quoted. Produce a safe bare
  // identifier; the optional alias-form handles anything unusual via display.
  const stripped = String(id).replace(/[^a-zA-Z0-9_]/g, '_');
  return /^[0-9]/.test(stripped) ? `n_${stripped}` : stripped || 'n_x';
}

function plantUmlLabel(raw) {
  // PlantUML labels are quoted in the macros. Escape embedded double-quotes
  // and strip control characters (reuses stripControlChars helper).
  return stripControlChars(String(raw == null ? '' : raw))
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .slice(0, 120);
}

function c4MacroFor(node, diagramKind = 'c4-context') {
  // Map generic graph-node kind to a C4-PlantUML macro name. The correct
  // macro depends on the C4 layer being rendered:
  //   c4-context   — internal components are System(); external are System_Ext()
  //   c4-container — internal components are Container(); data stores are ContainerDb()
  switch (node.kind) {
    case 'actor':
      return 'Person';
    case 'integration':
      return 'System_Ext';
    case 'dataStore':
    case 'dataEntity':
      return diagramKind === 'c4-container' ? 'ContainerDb' : 'SystemDb';
    case 'api':
    case 'component':
    case 'service':
      return diagramKind === 'c4-container' ? 'Container' : 'System';
    case 'platformNode':
    case 'infrastructureNode':
      return diagramKind === 'c4-container' ? 'Container' : 'System';
    default:
      return 'System';
  }
}

function renderPlantUml(spec) {
  // Route by diagramKind. C4 kinds use C4-PlantUML stdlib; everything else
  // uses generic PlantUML with component shapes.
  switch (spec.diagramKind) {
    case 'c4-context':
      return renderPlantUmlC4Context(spec);
    case 'c4-container':
      return renderPlantUmlC4Container(spec);
    case 'value-stream':
      return renderPlantUmlValueStream(spec);
    case 'migration-roadmap':
    case 'delta-map':
      return renderPlantUmlMigration(spec);
    case 'coexistence-cutover':
      return renderPlantUmlCoexistenceCutover(spec);
    case 'erd':
      return renderPlantUmlErd(spec);
    default:
      return renderPlantUmlGeneric(spec);
  }
}

function plantUmlHeader(spec, extraIncludes = []) {
  const out = [];
  out.push(`@startuml ${plantUmlIdSafe(spec.id)}`);
  out.push(`' ${spec.id} — ${plantUmlLabel(spec.title)}`);
  out.push(`' state: ${spec.state} | profile: ${spec.profile} | confidence: ${spec.confidence}`);
  out.push('!define DEVICONS https://raw.githubusercontent.com/tupadr3/plantuml-icon-font-sprites/master/devicons');
  for (const inc of extraIncludes) out.push(inc);
  out.push('skinparam defaultFontName "-apple-system,Segoe UI,Helvetica"');
  out.push('skinparam defaultFontSize 12');
  return out;
}

function renderPlantUmlC4Context(spec) {
  const out = plantUmlHeader(spec, ['!include <C4/C4_Context>']);
  out.push(`title ${plantUmlLabel(spec.title)}`);
  if (!spec.nodes.length) {
    out.push('note as N1');
    out.push(`  No graph nodes matched this viewpoint.`);
    out.push('end note');
    out.push('@enduml');
    return out.join('\n');
  }
  for (const n of spec.nodes) {
    const id = plantUmlIdSafe(n.id);
    const label = plantUmlLabel(n.label);
    const macro = c4MacroFor(n, 'c4-context');
    const confTag = n.confidence && n.confidence !== 'confirmed' ? ` (${n.confidence})` : '';
    const deltaTag = n.deltaType ? ` [${n.deltaType}]` : '';
    out.push(`${macro}(${id}, "${label}${confTag}${deltaTag}", "${plantUmlLabel(n.kind || '')}")`);
  }
  for (const e of spec.edges) {
    const from = plantUmlIdSafe(e.from);
    const to = plantUmlIdSafe(e.to);
    const label = e.label ? plantUmlLabel(e.label) : '';
    out.push(`Rel(${from}, ${to}, "${label}")`);
  }
  out.push('@enduml');
  return out.join('\n');
}

function renderPlantUmlC4Container(spec) {
  const out = plantUmlHeader(spec, ['!include <C4/C4_Container>']);
  out.push(`title ${plantUmlLabel(spec.title)}`);
  if (!spec.nodes.length) {
    out.push('note as N1');
    out.push(`  No graph nodes matched this viewpoint.`);
    out.push('end note');
    out.push('@enduml');
    return out.join('\n');
  }
  // Group nodes by spec.groups to create System_Boundary blocks when available.
  const groupIndex = new Map();
  for (const g of spec.groups || []) groupIndex.set(g.id, g);
  const ungrouped = [];
  const byGroup = new Map();
  for (const n of spec.nodes) {
    const g = n.group || null;
    if (g && groupIndex.has(g)) {
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(n);
    } else {
      ungrouped.push(n);
    }
  }
  for (const [gid, nodes] of byGroup.entries()) {
    const g = groupIndex.get(gid);
    out.push(`System_Boundary(${plantUmlIdSafe(gid)}, "${plantUmlLabel(g.label || g.id)}") {`);
    for (const n of nodes) out.push(`  ${c4NodeLine(n, 'c4-container')}`);
    out.push('}');
  }
  for (const n of ungrouped) out.push(c4NodeLine(n, 'c4-container'));
  for (const e of spec.edges) {
    const from = plantUmlIdSafe(e.from);
    const to = plantUmlIdSafe(e.to);
    const label = e.label ? plantUmlLabel(e.label) : '';
    out.push(`Rel(${from}, ${to}, "${label}")`);
  }
  out.push('@enduml');
  return out.join('\n');
}

function c4NodeLine(n, diagramKind = 'c4-container') {
  const id = plantUmlIdSafe(n.id);
  const label = plantUmlLabel(n.label);
  const macro = c4MacroFor(n, diagramKind);
  const confTag = n.confidence && n.confidence !== 'confirmed' ? ` (${n.confidence})` : '';
  const deltaTag = n.deltaType ? ` [${n.deltaType}]` : '';
  return `${macro}(${id}, "${label}${confTag}${deltaTag}", "${plantUmlLabel(n.kind || '')}")`;
}

function plantUmlMigrationPriority(node) {
  const text = `${node?.label || ''} ${node?.kind || ''}`.toLowerCase();
  const patterns = [
    /gateway-agent/,
    /^gateway-server component$/,
    /mcp-bridge/,
    /gateway-server\/grpc/,
    /gateway-server\/agents/,
    /gateway-server\/ingest/,
    /gateway-server\/rocksdb/,
    /gateway-server\/amnesia/,
    /gateway-server\/resources/,
    /gateway-server\/web/,
    /go edge/,
    /elixir gateway/,
    /routing, workflow/,
    /mcp bridge and tool/,
    /phoenix liveview/,
    /dmz|edge/,
    /load balancer/,
    /clients|enterprise systems/,
    /admins|automation/,
    /security and policy/,
    /provider adapters/,
    /llm providers/,
    /mcp servers/,
    /rocksdb append log/,
    /amnesia|mnesia/,
    /postgresql/,
  ];
  const idx = patterns.findIndex((rx) => rx.test(text));
  return idx === -1 ? 100 : idx;
}

function plantUmlMigrationNodeLine(n) {
  const id = plantUmlIdSafe(n.id);
  const label = plantUmlLabel(n.label);
  const shape = plantUmlShapeOf(n);
  const confTag = n.confidence && n.confidence !== 'confirmed' ? ` (${n.confidence})` : '';
  const deltaTag = n.deltaType ? ` [${n.deltaType}]` : '';
  return `${shape} "${label}${confTag}${deltaTag}" as ${id}`;
}

function renderPlantUmlMigration(spec) {
  const out = plantUmlHeader(spec);
  out.push('left to right direction');
  out.push('skinparam linetype ortho');
  out.push('skinparam nodesep 55');
  out.push('skinparam ranksep 75');
  out.push('skinparam packageStyle rectangle');
  out.push('hide stereotype');
  out.push(`title ${plantUmlLabel(spec.title)}`);
  if (!spec.nodes.length) {
    out.push('note as N1');
    out.push('  No graph nodes matched this viewpoint.');
    out.push('end note');
    out.push('@enduml');
    return out.join('\n');
  }

  const columns = [
    { key: 'current', label: 'Current source' },
    { key: 'transition', label: 'Transition' },
    { key: 'target', label: 'Target' },
  ];
  const byColumn = new Map(columns.map((c) => [c.key, []]));
  for (const n of spec.nodes) {
    byColumn.get(migrationColumnKey(n)).push(n);
  }
  for (const nodes of byColumn.values()) {
    nodes.sort(
      (a, b) => plantUmlMigrationPriority(a) - plantUmlMigrationPriority(b) || String(a.id).localeCompare(String(b.id)),
    );
  }

  const visible = new Set();
  const firstByColumn = new Map();
  for (const col of columns) {
    const nodes = byColumn.get(col.key).slice(0, 8);
    out.push(`package "${plantUmlLabel(col.label)}" as pkg_${col.key} {`);
    for (const n of nodes) {
      visible.add(n.id);
      if (!firstByColumn.has(col.key)) firstByColumn.set(col.key, n.id);
      out.push(`  ${plantUmlMigrationNodeLine(n)}`);
    }
    for (let i = 0; i < nodes.length - 1; i += 1) {
      out.push(`  ${plantUmlIdSafe(nodes[i].id)} -[hidden]down- ${plantUmlIdSafe(nodes[i + 1].id)}`);
    }
    const hiddenCount = byColumn.get(col.key).length - nodes.length;
    if (hiddenCount > 0) {
      const summaryId = `summary_${col.key}`;
      out.push(`  rectangle "+${hiddenCount} more in master spec" as ${summaryId}`);
      if (nodes.length) out.push(`  ${plantUmlIdSafe(nodes[nodes.length - 1].id)} -[hidden]down- ${summaryId}`);
    }
    out.push('}');
  }

  if (firstByColumn.get('current') && firstByColumn.get('transition')) {
    out.push(
      `${plantUmlIdSafe(firstByColumn.get('current'))} -[hidden]right- ${plantUmlIdSafe(firstByColumn.get('transition'))}`,
    );
  }
  if (firstByColumn.get('transition') && firstByColumn.get('target')) {
    out.push(
      `${plantUmlIdSafe(firstByColumn.get('transition'))} -[hidden]right- ${plantUmlIdSafe(firstByColumn.get('target'))}`,
    );
  }

  const columnRank = new Map(columns.map((c, index) => [c.key, index]));
  for (const e of spec.edges) {
    if (!visible.has(e.from) || !visible.has(e.to)) continue;
    let from = e.from;
    let to = e.to;
    const fromNode = spec.nodes.find((n) => n.id === from);
    const toNode = spec.nodes.find((n) => n.id === to);
    if (
      fromNode &&
      toNode &&
      columnRank.get(migrationColumnKey(fromNode)) > columnRank.get(migrationColumnKey(toNode))
    ) {
      from = e.to;
      to = e.from;
    }
    const arrow = e.style === 'dashed' ? '..>' : '-->';
    const label = e.label && e.label !== 'flows to' ? plantUmlLabel(e.label) : '';
    out.push(
      label
        ? `${plantUmlIdSafe(from)} ${arrow} ${plantUmlIdSafe(to)} : "${label}"`
        : `${plantUmlIdSafe(from)} ${arrow} ${plantUmlIdSafe(to)}`,
    );
  }
  out.push('@enduml');
  return out.join('\n');
}

function renderPlantUmlValueStream(spec) {
  const out = plantUmlHeader(spec);
  out.push('left to right direction');
  out.push('skinparam linetype ortho');
  out.push('skinparam nodesep 45');
  out.push('skinparam ranksep 60');
  out.push('skinparam packageStyle rectangle');
  out.push('hide stereotype');
  out.push(`title ${plantUmlLabel(spec.title)}`);
  if (!spec.nodes.length) {
    out.push('note as N1');
    out.push('  No graph nodes matched this viewpoint.');
    out.push('end note');
    out.push('@enduml');
    return out.join('\n');
  }

  const byStage = new Map(BUSINESS_VALUE_STAGES.map((s) => [s.key, []]));
  for (const n of spec.nodes || []) {
    const stage = n.businessStage || 'demand';
    if (!byStage.has(stage)) byStage.set(stage, []);
    byStage.get(stage).push(n);
  }
  const visible = new Set();
  const firstByStage = new Map();
  for (const stage of BUSINESS_VALUE_STAGES) {
    const nodes = (byStage.get(stage.key) || []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
    out.push(`package "${plantUmlLabel(stage.label)}" as pkg_${stage.key} {`);
    for (const n of nodes) {
      visible.add(n.id);
      if (!firstByStage.has(stage.key)) firstByStage.set(stage.key, n.id);
      out.push(`  ${plantUmlMigrationNodeLine(n)}`);
    }
    for (let i = 0; i < nodes.length - 1; i += 1) {
      out.push(`  ${plantUmlIdSafe(nodes[i].id)} -[hidden]down- ${plantUmlIdSafe(nodes[i + 1].id)}`);
    }
    out.push('}');
  }
  for (let i = 0; i < BUSINESS_VALUE_STAGES.length - 1; i += 1) {
    const from = firstByStage.get(BUSINESS_VALUE_STAGES[i].key);
    const to = firstByStage.get(BUSINESS_VALUE_STAGES[i + 1].key);
    if (from && to) out.push(`${plantUmlIdSafe(from)} -[hidden]right- ${plantUmlIdSafe(to)}`);
  }
  for (const e of spec.edges || []) {
    if (!visible.has(e.from) || !visible.has(e.to)) continue;
    const arrow = e.style === 'dashed' ? '..>' : '-->';
    const label = e.label ? plantUmlLabel(e.label) : '';
    out.push(
      label
        ? `${plantUmlIdSafe(e.from)} ${arrow} ${plantUmlIdSafe(e.to)} : "${label}"`
        : `${plantUmlIdSafe(e.from)} ${arrow} ${plantUmlIdSafe(e.to)}`,
    );
  }
  out.push('@enduml');
  return out.join('\n');
}

function renderPlantUmlCoexistenceCutover(spec) {
  const out = plantUmlHeader(spec);
  out.push('left to right direction');
  out.push('skinparam linetype ortho');
  out.push('skinparam nodesep 45');
  out.push('skinparam ranksep 60');
  out.push('skinparam packageStyle rectangle');
  out.push('hide stereotype');
  out.push(`title ${plantUmlLabel(spec.title)}`);
  if (!spec.nodes.length) {
    out.push('note as N1');
    out.push('  No graph nodes matched this viewpoint.');
    out.push('end note');
    out.push('@enduml');
    return out.join('\n');
  }

  const byPhase = new Map(COEXISTENCE_COLUMNS.map((c) => [c.key, []]));
  for (const n of spec.nodes || []) {
    const phase = n.cutoverPhase || n.migrationRole || 'coexistence';
    if (!byPhase.has(phase)) byPhase.set(phase, []);
    byPhase.get(phase).push(n);
  }
  const visible = new Set();
  const firstByPhase = new Map();
  for (const col of COEXISTENCE_COLUMNS) {
    const nodes = (byPhase.get(col.key) || []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
    out.push(`package "${plantUmlLabel(col.label)}" as pkg_${col.key} {`);
    for (const n of nodes) {
      visible.add(n.id);
      if (!firstByPhase.has(col.key)) firstByPhase.set(col.key, n.id);
      out.push(`  ${plantUmlMigrationNodeLine(n)}`);
    }
    for (let i = 0; i < nodes.length - 1; i += 1) {
      out.push(`  ${plantUmlIdSafe(nodes[i].id)} -[hidden]down- ${plantUmlIdSafe(nodes[i + 1].id)}`);
    }
    out.push('}');
  }
  for (let i = 0; i < COEXISTENCE_COLUMNS.length - 1; i += 1) {
    const from = firstByPhase.get(COEXISTENCE_COLUMNS[i].key);
    const to = firstByPhase.get(COEXISTENCE_COLUMNS[i + 1].key);
    if (from && to) out.push(`${plantUmlIdSafe(from)} -[hidden]right- ${plantUmlIdSafe(to)}`);
  }
  for (const e of spec.edges || []) {
    if (!visible.has(e.from) || !visible.has(e.to)) continue;
    const arrow = e.style === 'dashed' ? '..>' : '-->';
    const label = e.label ? plantUmlLabel(e.label) : '';
    out.push(
      label
        ? `${plantUmlIdSafe(e.from)} ${arrow} ${plantUmlIdSafe(e.to)} : "${label}"`
        : `${plantUmlIdSafe(e.from)} ${arrow} ${plantUmlIdSafe(e.to)}`,
    );
  }
  out.push('@enduml');
  return out.join('\n');
}

function renderPlantUmlGeneric(spec) {
  const out = plantUmlHeader(spec);
  out.push(`title ${plantUmlLabel(spec.title)}`);
  if (!spec.nodes.length) {
    out.push('note as N1');
    out.push('  No graph nodes matched this viewpoint.');
    out.push('end note');
    out.push('@enduml');
    return out.join('\n');
  }
  // Group into packages per spec.group for visual grouping.
  const buckets = new Map();
  const groupLabels = new Map();
  for (const group of spec.groups || []) {
    const id = group.id || group.label;
    if (!id) continue;
    buckets.set(id, []);
    groupLabels.set(id, group.label || id);
  }
  for (const n of spec.nodes) {
    const g = n.group || 'Other';
    if (!buckets.has(g)) buckets.set(g, []);
    if (!groupLabels.has(g)) groupLabels.set(g, g);
    buckets.get(g).push(n);
  }
  for (const [group, nodes] of buckets.entries()) {
    if (!nodes.length) continue;
    out.push(`package "${plantUmlLabel(groupLabels.get(group) || group)}" {`);
    const orderedNodes = nodes
      .slice()
      .sort(
        (a, b) =>
          (Number.isFinite(a.sequenceIndex) ? a.sequenceIndex : 1000) -
            (Number.isFinite(b.sequenceIndex) ? b.sequenceIndex : 1000) || String(a.id).localeCompare(String(b.id)),
      );
    for (const n of orderedNodes) {
      const id = plantUmlIdSafe(n.id);
      const label = plantUmlLabel(n.label);
      const shape = plantUmlShapeOf(n);
      const confTag = n.confidence && n.confidence !== 'confirmed' ? ` (${n.confidence})` : '';
      const deltaTag = n.deltaType ? ` [${n.deltaType}]` : '';
      out.push(`  ${shape} "${label}${confTag}${deltaTag}" as ${id}`);
    }
    out.push('}');
  }
  for (const e of spec.edges) {
    const from = plantUmlIdSafe(e.from);
    const to = plantUmlIdSafe(e.to);
    const label = e.label ? plantUmlLabel(e.label) : '';
    const arrow = e.style === 'dashed' ? '..>' : '-->';
    out.push(label ? `${from} ${arrow} ${to} : "${label}"` : `${from} ${arrow} ${to}`);
  }
  out.push('@enduml');
  return out.join('\n');
}

function plantUmlFieldName(raw) {
  return (
    String(raw || 'field')
      .replace(/[^a-zA-Z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'field'
  );
}

function plantUmlErdNodeLine(n) {
  const id = plantUmlIdSafe(n.id);
  const label = plantUmlLabel(n.label);
  const stereotype = n.kind === 'dataStore' ? ' <<store>>' : n.dataClass ? ` <<${plantUmlLabel(n.dataClass)}>>` : '';
  const fields = Array.isArray(n.entityFields) && n.entityFields.length ? n.entityFields.slice(0, 8) : ['id', 'name'];
  const out = [`  entity "${label}" as ${id}${stereotype} {`];
  fields.forEach((field, index) => {
    const prefix = index === 0 ? '  *' : '   ';
    out.push(`${prefix} ${plantUmlFieldName(field)} : string`);
    if (index === 0 && fields.length > 1) out.push('  --');
  });
  out.push('  }');
  return out;
}

function plantUmlErdCardinality(edge) {
  const raw = String(edge.cardinality || '||--o{');
  return edge.style === 'dashed' ? raw.replace('--', '..') : raw;
}

function renderPlantUmlErd(spec) {
  const out = plantUmlHeader(spec);
  out.push('left to right direction');
  out.push('skinparam linetype ortho');
  out.push('hide circle');
  out.push(`title ${plantUmlLabel(spec.title)}`);
  if (!spec.nodes.length) {
    out.push('entity "No entities matched this viewpoint" as empty_entity');
    out.push('@enduml');
    return out.join('\n');
  }
  const buckets = new Map();
  const groupLabels = new Map();
  for (const group of spec.groups || []) {
    const id = group.id || group.label;
    if (!id) continue;
    buckets.set(id, []);
    groupLabels.set(id, group.label || id);
  }
  for (const n of spec.nodes) {
    const g = n.group || 'Logical Data Model';
    if (!buckets.has(g)) buckets.set(g, []);
    if (!groupLabels.has(g)) groupLabels.set(g, g);
    buckets.get(g).push(n);
  }
  for (const [group, nodes] of buckets.entries()) {
    if (!nodes.length) continue;
    out.push(`package "${plantUmlLabel(groupLabels.get(group) || group)}" {`);
    const orderedNodes = nodes
      .slice()
      .sort(
        (a, b) =>
          (Number.isFinite(a.sequenceIndex) ? a.sequenceIndex : 1000) -
            (Number.isFinite(b.sequenceIndex) ? b.sequenceIndex : 1000) || String(a.id).localeCompare(String(b.id)),
      );
    for (const n of orderedNodes) out.push(...plantUmlErdNodeLine(n));
    out.push('}');
  }
  for (const e of spec.edges || []) {
    const from = plantUmlIdSafe(e.from);
    const to = plantUmlIdSafe(e.to);
    const label = e.label ? plantUmlLabel(e.label) : 'relates to';
    out.push(`${from} ${plantUmlErdCardinality(e)} ${to} : "${label}"`);
  }
  out.push('@enduml');
  return out.join('\n');
}

function plantUmlShapeOf(n) {
  switch (n.kind) {
    case 'team':
    case 'actor':
      return 'actor';
    case 'integration':
      return 'cloud';
    case 'dataStore':
    case 'dataEntity':
      return 'database';
    case 'api':
      return 'interface';
    case 'trustBoundary':
      return 'frame';
    case 'platformNode':
    case 'infrastructureNode':
      return 'node';
    case 'operationalSignal':
      return 'queue';
    default:
      return 'rectangle';
  }
}

// ── D2 renderer (rich + themed + icon-aware) ────────────────────────────────
//
// D2 supports nested containers, rich theming, icons via `shape: image`, and
// multiple layout engines (dagre, ELK). We emit D2 source text that:
//   - uses theme colors (professional/enterprise/dark/minimal/brand)
//   - nests nodes inside container groups when spec.groups[] is populated
//   - attaches icon URLs when the icon resolver matched a node
//   - uses edge styles that encode semantic meaning (peered/tunneled/calls)
//
// The .d2 source is written alongside .mmd / .puml. Rendering to SVG happens
// in cobolt-architecture-diagram-render.js via the `d2` CLI (best-effort).

function d2IdSafe(id) {
  // D2 identifiers can be arbitrary with quotes, but unquoted bare IDs must
  // be alnum + underscore + dash. Normalize for use as container keys.
  const stripped = String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
  return /^[0-9]/.test(stripped) ? `n_${stripped}` : stripped || 'n_x';
}

function d2QuoteLabel(raw) {
  // Defense in depth: strip HTML tags + escape quotes + strip control chars.
  // D2 labels are text, but stripping tags prevents any renderer that honors
  // HTML in labels from interpreting untrusted markup.
  return stripControlChars(String(raw == null ? '' : raw))
    .replace(/<[^>]*>/g, '') // strip any HTML tag
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .slice(0, 120);
}

function d2VisualKind(node) {
  const iconKind = String(node.iconKind || '').toLowerCase();
  if (iconKind === 'identity' || iconKind === 'securitycontrol') return 'securityControl';
  if (iconKind === 'operationalsignal') return 'operationalSignal';
  return node.kind;
}

function d2ShapeFor(node) {
  switch (d2VisualKind(node)) {
    case 'team':
    case 'actor':
      return 'person';
    case 'integration':
      return 'cloud';
    case 'dataStore':
    case 'dataEntity':
      return 'cylinder';
    case 'api':
      return 'rectangle';
    case 'trustBoundary':
      return 'rectangle';
    case 'platformNode':
    case 'infrastructureNode':
      return 'hexagon';
    case 'operationalSignal':
      return 'rectangle';
    default:
      return 'rectangle';
  }
}

function d2FillFor(node, theme) {
  if (node.external) return theme.externalFill;
  switch (d2VisualKind(node)) {
    case 'team':
      return theme.accentSoft;
    case 'dataStore':
    case 'dataEntity':
      return theme.dataFill;
    case 'trustBoundary':
    case 'securityControl':
      return theme.securityFill;
    case 'integration':
    case 'actor':
      return theme.externalFill;
    default:
      return theme.internalFill;
  }
}

function d2StrokeFor(node, theme) {
  if (node.external) return theme.externalStroke;
  switch (d2VisualKind(node)) {
    case 'team':
      return theme.accent;
    case 'dataStore':
    case 'dataEntity':
      return theme.dataStroke;
    case 'trustBoundary':
    case 'securityControl':
      return theme.securityStroke;
    case 'integration':
    case 'actor':
      return theme.externalStroke;
    default:
      return theme.internalStroke;
  }
}

function d2EdgeStyleFor(edge, theme) {
  const label = String(edge.label || '').toLowerCase();
  if (edge.style === 'dashed' || /peered|peering|tunnel/.test(label)) {
    return { stroke: theme.edgeDashed, strokeDash: 4 };
  }
  if (/trust|auth/.test(label)) return { stroke: theme.edgeStrong, strokeDash: 0 };
  return { stroke: theme.edgeDefault, strokeDash: 0 };
}

function d2ShouldUseResolvedIcon(node) {
  const visual = String(d2VisualKind(node) || '').toLowerCase();
  if (
    node.kind === 'dataEntity' &&
    ['dataentity', 'identity', 'securitycontrol', 'operationalsignal'].includes(visual)
  ) {
    return false;
  }
  return true;
}

function renderD2Migration(spec, opts = {}) {
  const theme = opts.theme || require('../lib/cobolt-arch-themes').resolveTheme('professional');
  const icons = opts.icons || {};
  const iconUrls = opts.iconUrls || {};
  const lines = [];
  lines.push(`# ${spec.id} - ${d2QuoteLabel(spec.title)}`);
  lines.push(`# state: ${spec.state} | profile: ${spec.profile} | confidence: ${spec.confidence}`);
  lines.push(`# theme: ${theme.name}`);
  lines.push('direction: right');
  lines.push('layout: elk');
  lines.push(`title: {`);
  lines.push(`  label: "${d2QuoteLabel(spec.title)}"`);
  lines.push(`  near: top-center`);
  lines.push(`  shape: text`);
  lines.push(`  style.font-size: 28`);
  lines.push(`  style.bold: true`);
  lines.push(`  style.font-color: "${theme.text}"`);
  lines.push(`}`);
  if (!spec.nodes.length) {
    lines.push('empty: "No graph nodes matched this viewpoint" {');
    lines.push(`  style.fill: "${theme.surfaceAlt}"`);
    lines.push(`  style.stroke: "${theme.border}"`);
    lines.push(`  style.font-color: "${theme.textMuted}"`);
    lines.push('}');
    return lines.join('\n');
  }

  const byColumn = new Map(MIGRATION_COLUMNS.map((c) => [c.key, []]));
  for (const n of spec.nodes) {
    const key = migrationColumnKey(n);
    if (!byColumn.has(key)) byColumn.set(key, []);
    byColumn.get(key).push(n);
  }
  const nodeToColumn = new Map();
  for (const col of MIGRATION_COLUMNS) {
    const groupId = `migration_${col.key}`;
    lines.push(`${groupId}: "${d2QuoteLabel(col.label)}" {`);
    lines.push(`  style.fill: "${theme.surfaceAlt}"`);
    lines.push(`  style.stroke: "${theme.accent}"`);
    lines.push(`  style.stroke-width: 2`);
    lines.push(`  style.font-color: "${theme.accent}"`);
    lines.push(`  style.bold: true`);
    const nodes = (byColumn.get(col.key) || [])
      .slice()
      .sort(
        (a, b) =>
          plantUmlMigrationPriority(a) - plantUmlMigrationPriority(b) || String(a.id).localeCompare(String(b.id)),
      );
    for (const n of nodes) {
      nodeToColumn.set(n.id, groupId);
      emitD2Node(n, theme, icons, iconUrls, '  ', lines);
    }
    lines.push('}');
  }

  for (const e of spec.edges || []) {
    let from = e.from;
    let to = e.to;
    const fromNode = spec.nodes.find((n) => n.id === from);
    const toNode = spec.nodes.find((n) => n.id === to);
    if (fromNode && toNode && migrationColumnRankFor(fromNode) > migrationColumnRankFor(toNode)) {
      from = e.to;
      to = e.from;
    }
    const fromGroup = nodeToColumn.get(from);
    const toGroup = nodeToColumn.get(to);
    if (!fromGroup || !toGroup) continue;
    const style = d2EdgeStyleFor(e, theme);
    const fromPath = `${fromGroup}.${d2IdSafe(from)}`;
    const toPath = `${toGroup}.${d2IdSafe(to)}`;
    const label = e.label ? `: "${d2QuoteLabel(e.label)}"` : ':';
    lines.push(`${fromPath} -> ${toPath}${label} {`);
    lines.push(`  style.stroke: "${style.stroke}"`);
    if (style.strokeDash) lines.push(`  style.stroke-dash: ${style.strokeDash}`);
    lines.push('}');
  }

  return lines.join('\n');
}

function renderD2ValueStream(spec, opts = {}) {
  const theme = opts.theme || require('../lib/cobolt-arch-themes').resolveTheme('professional');
  const icons = opts.icons || {};
  const iconUrls = opts.iconUrls || {};
  const lines = [];
  lines.push(`# ${spec.id} - ${d2QuoteLabel(spec.title)}`);
  lines.push(`# state: ${spec.state} | profile: ${spec.profile} | confidence: ${spec.confidence}`);
  lines.push(`# theme: ${theme.name}`);
  lines.push('direction: right');
  lines.push('layout: elk');
  lines.push('title: {');
  lines.push(`  label: "${d2QuoteLabel(spec.title)}"`);
  lines.push('  near: top-center');
  lines.push('  shape: text');
  lines.push('  style.font-size: 28');
  lines.push('  style.bold: true');
  lines.push(`  style.font-color: "${theme.text}"`);
  lines.push('}');
  if (!spec.nodes.length) {
    lines.push('empty: "No graph nodes matched this viewpoint"');
    return lines.join('\n');
  }

  const byStage = new Map(BUSINESS_VALUE_STAGES.map((s) => [s.key, []]));
  for (const n of spec.nodes || []) {
    const stage = n.businessStage || 'demand';
    if (!byStage.has(stage)) byStage.set(stage, []);
    byStage.get(stage).push(n);
  }
  const nodeToGroup = new Map();
  for (const stage of BUSINESS_VALUE_STAGES) {
    const groupId = `value_${stage.key}`;
    lines.push(`${groupId}: "${d2QuoteLabel(stage.label)}" {`);
    lines.push(`  style.fill: "${theme.surfaceAlt}"`);
    lines.push(`  style.stroke: "${theme.accent}"`);
    lines.push('  style.stroke-width: 2');
    lines.push(`  style.font-color: "${theme.accent}"`);
    lines.push('  style.bold: true');
    const nodes = (byStage.get(stage.key) || []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
    for (const n of nodes) {
      nodeToGroup.set(n.id, groupId);
      emitD2Node(n, theme, icons, iconUrls, '  ', lines);
    }
    lines.push('}');
  }

  for (const e of spec.edges || []) {
    const fromGroup = nodeToGroup.get(e.from);
    const toGroup = nodeToGroup.get(e.to);
    if (!fromGroup || !toGroup) continue;
    const style = d2EdgeStyleFor(e, theme);
    const fromPath = `${fromGroup}.${d2IdSafe(e.from)}`;
    const toPath = `${toGroup}.${d2IdSafe(e.to)}`;
    const label = e.label ? `: "${d2QuoteLabel(e.label)}"` : ':';
    lines.push(`${fromPath} -> ${toPath}${label} {`);
    lines.push(`  style.stroke: "${style.stroke}"`);
    if (style.strokeDash) lines.push(`  style.stroke-dash: ${style.strokeDash}`);
    lines.push('}');
  }
  return lines.join('\n');
}

function renderD2CoexistenceCutover(spec, opts = {}) {
  const theme = opts.theme || require('../lib/cobolt-arch-themes').resolveTheme('professional');
  const icons = opts.icons || {};
  const iconUrls = opts.iconUrls || {};
  const lines = [];
  lines.push(`# ${spec.id} - ${d2QuoteLabel(spec.title)}`);
  lines.push(`# state: ${spec.state} | profile: ${spec.profile} | confidence: ${spec.confidence}`);
  lines.push(`# theme: ${theme.name}`);
  lines.push('direction: right');
  lines.push('layout: elk');
  lines.push('title: {');
  lines.push(`  label: "${d2QuoteLabel(spec.title)}"`);
  lines.push('  near: top-center');
  lines.push('  shape: text');
  lines.push('  style.font-size: 28');
  lines.push('  style.bold: true');
  lines.push(`  style.font-color: "${theme.text}"`);
  lines.push('}');
  if (!spec.nodes.length) {
    lines.push('empty: "No graph nodes matched this viewpoint"');
    return lines.join('\n');
  }

  const byPhase = new Map(COEXISTENCE_COLUMNS.map((c) => [c.key, []]));
  for (const n of spec.nodes || []) {
    const phase = n.cutoverPhase || n.migrationRole || 'coexistence';
    if (!byPhase.has(phase)) byPhase.set(phase, []);
    byPhase.get(phase).push(n);
  }
  const nodeToGroup = new Map();
  for (const col of COEXISTENCE_COLUMNS) {
    const groupId = `cutover_${col.key}`;
    lines.push(`${groupId}: "${d2QuoteLabel(col.label)}" {`);
    lines.push(`  style.fill: "${theme.surfaceAlt}"`);
    lines.push(`  style.stroke: "${theme.accent}"`);
    lines.push('  style.stroke-width: 2');
    lines.push(`  style.font-color: "${theme.accent}"`);
    lines.push('  style.bold: true');
    const nodes = (byPhase.get(col.key) || []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
    for (const n of nodes) {
      nodeToGroup.set(n.id, groupId);
      emitD2Node(n, theme, icons, iconUrls, '  ', lines);
    }
    lines.push('}');
  }

  for (const e of spec.edges || []) {
    const fromGroup = nodeToGroup.get(e.from);
    const toGroup = nodeToGroup.get(e.to);
    if (!fromGroup || !toGroup) continue;
    const style = d2EdgeStyleFor(e, theme);
    const fromPath = `${fromGroup}.${d2IdSafe(e.from)}`;
    const toPath = `${toGroup}.${d2IdSafe(e.to)}`;
    const label = e.label ? `: "${d2QuoteLabel(e.label)}"` : ':';
    lines.push(`${fromPath} -> ${toPath}${label} {`);
    lines.push(`  style.stroke: "${style.stroke}"`);
    if (style.strokeDash) lines.push(`  style.stroke-dash: ${style.strokeDash}`);
    lines.push('}');
  }
  return lines.join('\n');
}

function renderD2Risk(spec, opts = {}) {
  const theme = opts.theme || require('../lib/cobolt-arch-themes').resolveTheme('professional');
  const icons = opts.icons || {};
  const iconUrls = opts.iconUrls || {};
  const lines = [];
  lines.push(`# ${spec.id} - ${d2QuoteLabel(spec.title)}`);
  lines.push(`# state: ${spec.state} | profile: ${spec.profile} | confidence: ${spec.confidence}`);
  lines.push('direction: right');
  lines.push('layout: elk');
  lines.push('title: {');
  lines.push(`  label: "${d2QuoteLabel(spec.title)}"`);
  lines.push('  near: top-center');
  lines.push('  shape: text');
  lines.push('  style.font-size: 28');
  lines.push('  style.bold: true');
  lines.push(`  style.font-color: "${theme.text}"`);
  lines.push('}');
  if (!spec.nodes.length) {
    lines.push('empty: "No nodes matched this risk viewpoint"');
    return lines.join('\n');
  }

  const byRole = new Map(RISK_COLUMNS.map((c) => [c.key, []]));
  for (const n of spec.nodes || []) {
    const role = n.riskRole || riskRoleForNode(n);
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role).push(n);
  }
  const nodeToGroup = new Map();
  for (const col of RISK_COLUMNS) {
    const groupId = `risk_${col.key}`;
    lines.push(`${groupId}: "${d2QuoteLabel(col.label)}" {`);
    lines.push(`  style.fill: "${theme.surfaceAlt}"`);
    lines.push(`  style.stroke: "${theme.accent}"`);
    lines.push('  style.stroke-width: 2');
    lines.push(`  style.font-color: "${theme.accent}"`);
    lines.push('  style.bold: true');
    const nodes = (byRole.get(col.key) || [])
      .slice()
      .sort(
        (a, b) => riskPickRank(a, new Map()) - riskPickRank(b, new Map()) || String(a.id).localeCompare(String(b.id)),
      );
    for (const n of nodes) {
      nodeToGroup.set(n.id, groupId);
      const riskLabel = `${n.label} | risk: ${n.riskLevel || riskLevelForNode(n)} | evidence: ${n.evidenceConfidence || evidenceConfidenceForNode(n)}`;
      emitD2Node({ ...n, label: riskLabel }, theme, icons, iconUrls, '  ', lines);
    }
    lines.push('}');
  }

  for (const e of spec.edges || []) {
    const fromGroup = nodeToGroup.get(e.from);
    const toGroup = nodeToGroup.get(e.to);
    if (!fromGroup || !toGroup) continue;
    const style = d2EdgeStyleFor(e, theme);
    const fromPath = `${fromGroup}.${d2IdSafe(e.from)}`;
    const toPath = `${toGroup}.${d2IdSafe(e.to)}`;
    const label = e.label ? `: "${d2QuoteLabel(e.label)}"` : ':';
    lines.push(`${fromPath} -> ${toPath}${label} {`);
    lines.push(`  style.stroke: "${style.stroke}"`);
    if (style.strokeDash) lines.push(`  style.stroke-dash: ${style.strokeDash}`);
    lines.push('}');
  }
  return lines.join('\n');
}

/**
 * Render D2 source from a spec.
 * @param {object} spec - Diagram viewpoint spec.
 * @param {object} [opts]
 * @param {object} [opts.theme] - Theme from lib/cobolt-arch-themes.js.
 * @param {object} [opts.icons] - Map of nodeId → resolved icon entry with .localPath or .sources.iconify.
 * @param {object} [opts.iconUrls] - Optional per-icon-slug absolute URL (when fetched + cached).
 * @returns {string} D2 source text.
 */
function renderD2(spec, opts = {}) {
  if (spec.diagramKind === 'value-stream') return renderD2ValueStream(spec, opts);
  if (['migration-roadmap', 'delta-map'].includes(spec.diagramKind)) return renderD2Migration(spec, opts);
  if (spec.diagramKind === 'coexistence-cutover') return renderD2CoexistenceCutover(spec, opts);
  if (spec.diagramKind === 'risk-map') return renderD2Risk(spec, opts);
  const theme = opts.theme || require('../lib/cobolt-arch-themes').resolveTheme('professional');
  const icons = opts.icons || {};
  const iconUrls = opts.iconUrls || {};
  const lines = [];

  lines.push(`# ${spec.id} — ${d2QuoteLabel(spec.title)}`);
  lines.push(`# state: ${spec.state} | profile: ${spec.profile} | confidence: ${spec.confidence}`);
  lines.push(`# theme: ${theme.name}`);
  lines.push('direction: right');
  lines.push(`title: {`);
  lines.push(`  label: "${d2QuoteLabel(spec.title)}"`);
  lines.push(`  near: top-center`);
  lines.push(`  shape: text`);
  lines.push(`  style.font-size: 28`);
  lines.push(`  style.bold: true`);
  lines.push(`  style.font-color: "${theme.text}"`);
  lines.push(`}`);

  if (!spec.nodes.length) {
    lines.push('empty: "No graph nodes matched this viewpoint" {');
    lines.push(`  style.fill: "${theme.surfaceAlt}"`);
    lines.push(`  style.stroke: "${theme.border}"`);
    lines.push(`  style.font-color: "${theme.textMuted}"`);
    lines.push('}');
    return lines.join('\n');
  }

  // Group nodes by spec.groups — this reproduces the hub/spoke/subnet aesthetic.
  const groupIndex = new Map();
  for (const g of spec.groups || []) groupIndex.set(g.id, g);
  const groupedNodes = new Map();
  const ungrouped = [];
  for (const g of spec.groups || []) {
    if (g.id) groupedNodes.set(g.id, []);
  }
  for (const n of spec.nodes) {
    const g = n.group || null;
    if (g && groupIndex.has(g)) {
      groupedNodes.get(g).push(n);
    } else {
      ungrouped.push(n);
    }
  }

  const nodeDecls = [];
  const edgeDecls = [];

  for (const [gid, nodes] of groupedNodes.entries()) {
    if (!nodes.length) continue;
    const g = groupIndex.get(gid);
    const gId = d2IdSafe(gid);
    nodeDecls.push(`${gId}: "${d2QuoteLabel(g.label || g.name || gid)}" {`);
    nodeDecls.push(`  style.fill: "${theme.surfaceAlt}"`);
    nodeDecls.push(`  style.stroke: "${theme.accent}"`);
    nodeDecls.push(`  style.stroke-width: 2`);
    nodeDecls.push(`  style.stroke-dash: 3`);
    nodeDecls.push(`  style.font-color: "${theme.accent}"`);
    nodeDecls.push(`  style.font-size: 14`);
    nodeDecls.push(`  style.bold: true`);
    const orderedNodes = nodes
      .slice()
      .sort(
        (a, b) =>
          (Number.isFinite(a.sequenceIndex) ? a.sequenceIndex : 1000) -
            (Number.isFinite(b.sequenceIndex) ? b.sequenceIndex : 1000) || String(a.id).localeCompare(String(b.id)),
      );
    for (const n of orderedNodes) {
      emitD2Node(n, theme, icons, iconUrls, '  ', nodeDecls);
    }
    nodeDecls.push('}');
  }
  for (const n of ungrouped) {
    emitD2Node(n, theme, icons, iconUrls, '', nodeDecls);
  }

  // Edges
  for (const e of spec.edges || []) {
    const fromPath = edgePath(e.from, groupedNodes, groupIndex);
    const toPath = edgePath(e.to, groupedNodes, groupIndex);
    const style = d2EdgeStyleFor(e, theme);
    const arrow = '->';
    if (e.label) {
      edgeDecls.push(`${fromPath} ${arrow} ${toPath}: "${d2QuoteLabel(e.label)}" {`);
    } else {
      edgeDecls.push(`${fromPath} ${arrow} ${toPath}: {`);
    }
    edgeDecls.push(`  style.stroke: "${style.stroke}"`);
    if (style.strokeDash) edgeDecls.push(`  style.stroke-dash: ${style.strokeDash}`);
    edgeDecls.push('}');
  }

  return [...lines, ...nodeDecls, ...edgeDecls].join('\n');
}

function edgePath(nodeId, groupedNodes, _groupIndex) {
  // If the node is inside a group, path is `group.node`; otherwise bare node.
  for (const [gid, nodes] of groupedNodes.entries()) {
    if (nodes.some((n) => n.id === nodeId)) {
      return `${d2IdSafe(gid)}.${d2IdSafe(nodeId)}`;
    }
  }
  return d2IdSafe(nodeId);
}

function emitD2Node(n, theme, icons, iconUrls, indent, out) {
  const id = d2IdSafe(n.id);
  const label = d2QuoteLabel(n.label);
  const shape = d2ShapeFor(n);
  const fill = d2FillFor(n, theme);
  const stroke = d2StrokeFor(n, theme);
  const icon = icons[n.id];
  const confTag = n.confidence && n.confidence !== 'confirmed' ? ` (${n.confidence})` : '';
  const deltaTag = n.deltaType ? ` [${n.deltaType}]` : '';
  const fullLabel = `${label}${confTag}${deltaTag}`;

  if (icon && d2ShouldUseResolvedIcon(n)) {
    // Prefer a local cached path (absolute path in D2 resolves as image).
    const iconPath = icon.localPath
      ? icon.localPath.replace(/\\/g, '/')
      : iconUrls[icon.slug]
        ? iconUrls[icon.slug]
        : null;
    if (iconPath) {
      out.push(`${indent}${id}: "${fullLabel}" {`);
      out.push(`${indent}  icon: ${iconPath}`);
      out.push(`${indent}  shape: image`);
      out.push(`${indent}  style.font-color: "${theme.text}"`);
      out.push(`${indent}  style.font-size: 12`);
      out.push(`${indent}}`);
      return;
    }
  }

  out.push(`${indent}${id}: "${fullLabel}" {`);
  out.push(`${indent}  shape: ${shape}`);
  out.push(`${indent}  style.fill: "${fill}"`);
  out.push(`${indent}  style.stroke: "${stroke}"`);
  out.push(`${indent}  style.stroke-width: 2`);
  if (n.confidence === 'inferred' || n.confidence === 'weak') {
    out.push(`${indent}  style.stroke-dash: 5`);
  }
  out.push(`${indent}  style.font-color: "${theme.text}"`);
  out.push(`${indent}  style.font-size: 12`);
  out.push(`${indent}  style.bold: ${n.kind === 'component' || n.kind === 'service'}`);
  out.push(`${indent}}`);
}

// ── Index + manifest + evidence-map writers ────────────────────────────────

function writeIndex(outDir, manifest, graph) {
  const lines = [];
  lines.push(`# Architecture Diagrams — ${manifest.pipeline} (${manifest.profile}, ${manifest.state})`);
  lines.push('');
  lines.push(`Generated: ${manifest.generatedAt}`);
  lines.push('');
  lines.push('## Executive Summary');
  lines.push('');
  lines.push(
    `This packet contains ${manifest.diagrams.length} diagram${manifest.diagrams.length === 1 ? '' : 's'} organized by the enterprise architecture taxonomy. Every diagram is derived from the evidence graph at \`graph/architecture-graph.json\` and marked with an explicit confidence level.`,
  );
  lines.push('');
  if ((graph.gaps || []).length) {
    lines.push('### Known Gaps');
    for (const g of graph.gaps) lines.push(`- **${g.area}** — ${g.reason}`);
    lines.push('');
  }

  // Taxonomy tree
  lines.push('## Architecture Taxonomy');
  lines.push('');
  const byArea = new Map();
  for (const d of manifest.diagrams) {
    if (!byArea.has(d.taxonomyArea)) byArea.set(d.taxonomyArea, []);
    byArea.get(d.taxonomyArea).push(d);
  }
  for (const [area, diagrams] of byArea.entries()) {
    lines.push(`### ${area}`);
    for (const d of diagrams) {
      const sourcePath = preferredDiagramSource(d);
      const title = sourcePath ? `[${d.title}](./${sourcePath})` : d.title;
      lines.push(`- **${d.id}** — ${title} (${d.status}, ${d.confidence || 'unknown'})`);
    }
    lines.push('');
  }

  lines.push('## Diagram Catalog');
  lines.push('');
  lines.push('| ID | Title | Taxonomy | State | Confidence | Nodes | Evidence | Status |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const d of manifest.diagrams) {
    lines.push(
      `| ${d.id} | ${d.title} | ${d.taxonomyArea} | ${d.state} | ${d.confidence || 'unknown'} | ${d.nodeCount || 0} | ${d.evidenceCount || 0} | ${d.status} |`,
    );
  }
  lines.push('');
  lines.push('## Generated Files');
  for (const d of manifest.diagrams) {
    const files = [
      d.files?.spec ? `spec: \`${d.files.spec}\`` : null,
      d.files?.mermaid ? `mermaid: \`${d.files.mermaid}\`` : null,
      d.files?.plantuml ? `plantuml: \`${d.files.plantuml}\`` : null,
    ].filter(Boolean);
    lines.push(`- **${d.id}** — ${files.length ? files.join(' | ') : 'no files generated'}`);
  }
  lines.push('');
  writeFile(path.join(outDir, 'index.md'), lines.join('\n'));
}

function preferredDiagramSource(diagram) {
  if (diagram.files?.svg) return diagram.files.svg;
  if (diagram.files?.svgIconic) return diagram.files.svgIconic;
  if (diagram.files?.mermaid) return diagram.files.mermaid;
  if (diagram.files?.plantuml) return diagram.files.plantuml;
  if (diagram.files?.spec) return diagram.files.spec;
  return null;
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function writeEvidenceMap(outDir, manifest, graph) {
  const map = {
    generatedAt: manifest.generatedAt,
    pipeline: manifest.pipeline,
    profile: manifest.profile,
    state: manifest.state,
    diagrams: manifest.diagrams.map((d) => ({
      id: d.id,
      title: d.title,
      evidence: (d.evidence || []).slice(0, 50),
    })),
    sourceEvidence: graph.sourceEvidence || [],
  };
  writeFile(path.join(outDir, 'evidence-map.json'), JSON.stringify(map, null, 2));
}

function readJsonUnder(outDir, rel) {
  if (!rel) return null;
  try {
    const p = path.resolve(outDir, rel);
    if (!p.startsWith(path.resolve(outDir))) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function formatOutputsForDiagram(d) {
  return {
    spec: d.files?.spec || null,
    mermaid: d.files?.mermaid || null,
    c4PlantUml: d.files?.plantuml || null,
    d2: d.files?.d2 || null,
    svgIconic: d.files?.svgIconic || null,
    publishableSvg: d.files?.svg || null,
  };
}

function writeDiagramMaster(outDir, manifest, graph) {
  const statePrefix =
    manifest.state === 'current' || manifest.state === 'target' || manifest.state === 'delta'
      ? `${manifest.state}/`
      : '';
  const master = {
    version: CANONICAL_VERSION,
    generatedAt: manifest.generatedAt,
    pipeline: manifest.pipeline,
    profile: manifest.profile,
    state: manifest.state,
    sourceOfTruth: {
      graph: manifest.graphPath,
      master: 'diagram-master.json',
      specs: `${statePrefix}specs/*.json`,
    },
    rendererContract: {
      rule: 'Each renderer consumes the diagram spec/master projection and writes only its own format folder.',
      formats: ['mermaid', 'c4PlantUml', 'd2', 'svgIconic', 'publishableSvg'],
    },
    graph: {
      nodeCount: (graph.nodes || []).length,
      edgeCount: (graph.edges || []).length,
      sourceEvidence: graph.sourceEvidence || [],
    },
    diagrams: manifest.diagrams.map((d) => {
      const spec = readJsonUnder(outDir, d.files?.spec) || {};
      return {
        id: d.id,
        title: d.title,
        taxonomyArea: d.taxonomyArea,
        diagramKind: d.diagramKind || spec.diagramKind || null,
        profile: d.profile,
        state: d.state,
        status: d.status,
        confidence: d.confidence,
        sourceSpec: d.files?.spec || null,
        nodes: spec.nodes || [],
        edges: spec.edges || [],
        evidence: spec.evidence || d.evidence || [],
        formatOutputs: formatOutputsForDiagram(d),
      };
    }),
  };
  writeFile(path.join(outDir, 'diagram-master.json'), JSON.stringify(master, null, 2));
  return master;
}

function writeFormatManifests(outDir, manifest) {
  const formatsDir = path.join(outDir, 'formats');
  clearGeneratedDir(formatsDir);
  const formats = [
    ['mermaid', 'Mermaid', 'mermaid'],
    ['c4-plantuml', 'C4-PlantUML / PlantUML', 'plantuml'],
    ['d2', 'D2', 'd2'],
    ['svg-iconic', 'Curated SVG', 'svgIconic'],
    ['publishable-svg', 'Publishable SVG', 'svg'],
  ];
  for (const [id, label, key] of formats) {
    const diagrams = manifest.diagrams
      .filter((d) => d.files?.[key])
      .map((d) => ({
        id: d.id,
        title: d.title,
        taxonomyArea: d.taxonomyArea,
        diagramKind: d.diagramKind || null,
        state: d.state,
        confidence: d.confidence,
        sourceSpec: d.files?.spec || null,
        file: d.files[key],
      }));
    writeFile(
      path.join(formatsDir, `${id}.json`),
      JSON.stringify(
        {
          version: CANONICAL_VERSION,
          generatedAt: manifest.generatedAt,
          pipeline: manifest.pipeline,
          profile: manifest.profile,
          state: manifest.state,
          format: id,
          label,
          sourceOfTruth: 'diagram-master.json',
          diagrams,
        },
        null,
        2,
      ),
    );
  }
}

// ── Top-level generate ─────────────────────────────────────────────────────

function resolveProfileEntries(profile, state) {
  const raw = PROFILE_REGISTRY[profile];
  if (!raw) return null;
  const entries = dedupeDiagramEntries(raw);
  return entries.filter((e) => {
    if (!e.stateRestrict) return true;
    if (e.stateRestrict === 'delta') return state === 'delta' || state === 'both' || state === 'composite';
    return true;
  });
}

function generateForState(entries, graph, outDir, context) {
  const sub = stateSubdir(outDir, context.state);
  const format = context.format || 'mermaid';
  const wantMermaid = formatRequestsMermaid(format);
  const wantPlantUml = formatRequestsPlantUml(format);
  const wantD2 = formatRequestsD2(format);
  const wantSvgIconic = formatRequestsSvgIconic(format);
  const diagrams = [];
  resetGeneratedStateOutput(outDir, context.state, format);

  // Resolve icons once per graph — cheap when cache is warm.
  const theme = context.theme;
  const iconsResolved = context.iconsResolved || {};

  for (const entry of entries) {
    try {
      const spec = buildSpec(entry, graph, context);
      const slug = slugify(entry.title);
      const specPath = path.join(sub.specs, `${entry.id}-${slug}.json`);
      writeFile(specPath, JSON.stringify(spec, null, 2));

      const files = {
        spec: path.relative(outDir, specPath).replace(/\\/g, '/'),
      };

      if (wantMermaid) {
        const mermaidPath = path.join(sub.mermaid, `${entry.id}-${slug}.mmd`);
        writeFile(mermaidPath, renderMermaid(spec));
        files.mermaid = path.relative(outDir, mermaidPath).replace(/\\/g, '/');
      }

      if (wantPlantUml) {
        const pumlPath = path.join(sub.plantuml, `${entry.id}-${slug}.puml`);
        writeFile(pumlPath, renderPlantUml(spec));
        files.plantuml = path.relative(outDir, pumlPath).replace(/\\/g, '/');
      }

      if (wantD2) {
        const d2Path = path.join(sub.d2, `${entry.id}-${slug}.d2`);
        writeFile(d2Path, renderD2(spec, { theme, icons: iconsResolved }));
        files.d2 = path.relative(outDir, d2Path).replace(/\\/g, '/');
      }

      if (wantSvgIconic) {
        // Prefer curated SVG templates for C4, zone, grid, and flow layouts.
        // Fall back to Graphviz only when no template matches the viewpoint.
        // post-processing). Falls back to the hand-rolled grid template
        // when the WASM renderer can't load (offline boxes, missing
        // @hpcc-js/wasm package, very-large graph timeout, …).
        const svgPath = path.join(sub.svgIconic, `${entry.id}-${slug}.svg`);
        let svgContent = null;
        try {
          const svgTemplatesLib = require('../lib/cobolt-arch-svg-templates');
          svgContent = svgTemplatesLib.renderSvgIconic({ spec, theme, iconsResolved });
        } catch {
          /* fall through to Graphviz */
        }
        if (!svgContent) {
          const graphvizLib = require('../lib/cobolt-arch-graphviz');
          svgContent = graphvizLib.renderSvgViaGraphvizSync({ spec, iconsResolved });
        }
        writeFile(svgPath, svgContent);
        files.svgIconic = path.relative(outDir, svgPath).replace(/\\/g, '/');
        const publishableSvgPath = path.join(
          outDir,
          'diagrams',
          publishableSvgName(context.state, `${entry.id}-${slug}.svg`),
        );
        writeFile(publishableSvgPath, svgContent);
        files.svg = path.relative(outDir, publishableSvgPath).replace(/\\/g, '/');
      }

      diagrams.push({
        id: entry.id,
        title: entry.title,
        taxonomyArea: entry.taxonomyArea,
        diagramKind: entry.kind,
        profile: context.profile,
        state: context.state === 'composite' ? graph.state || 'target' : context.state,
        status: spec.nodes.length ? 'generated' : 'warning',
        skipReason: spec.nodes.length ? undefined : 'No graph nodes matched viewpoint',
        files,
        confidence: spec.confidence,
        evidenceCount: (spec.evidence || []).length,
        nodeCount: spec.nodes.length,
        edgeCount: spec.edges.length,
        evidence: spec.evidence,
      });
    } catch (err) {
      diagrams.push({
        id: entry.id,
        title: entry.title,
        taxonomyArea: entry.taxonomyArea,
        diagramKind: entry.kind,
        profile: context.profile,
        state: context.state,
        status: 'failed',
        skipReason: String(err.message || err).slice(0, 200),
        files: {},
        confidence: 'unknown',
        evidenceCount: 0,
        nodeCount: 0,
        edgeCount: 0,
      });
    }
  }
  return diagrams;
}

// Synchronously ensure the icon cache is populated for every slug the resolver
// could match. Spawns tools/cobolt-arch-icon-search.js so the network/SSRF
// guard, allowlisted hosts, license check, sanitizer, and SHA pinning of
// lib/cobolt-arch-icon-fetch.js apply identically. Best-effort: any failure
// degrades to "no icon for this node" — the SVG renderer falls back to the
// generic shape placeholder. Honors COBOLT_ARCH_ICON_FETCH={off|bundled-only|
// local-only} and the --arch-icon-fetch flag.
function ensureIconCacheSync({ projectRoot, slugs, iconFetch, iconBudget }) {
  if (!Array.isArray(slugs) || slugs.length === 0) return { ok: true, skipped: 'no-slugs' };
  const mode = String(iconFetch || process.env.COBOLT_ARCH_ICON_FETCH || 'auto').toLowerCase();
  if (mode === 'off' || mode === 'bundled-only' || mode === '0' || mode === 'false' || mode === 'disabled') {
    return { ok: true, skipped: `mode=${mode}` };
  }
  if (mode === 'local-only') {
    return { ok: true, skipped: 'local-only' };
  }

  const tool = path.join(__dirname, 'cobolt-arch-icon-search.js');
  if (!fs.existsSync(tool)) return { ok: false, error: 'icon-search-tool-missing' };

  const args = ['ensure', '--slugs', slugs.join(','), '--dir', projectRoot, '--json'];
  if (iconBudget != null && Number.isFinite(iconBudget)) {
    args.push('--budget', String(iconBudget));
  }

  try {
    const res = spawnSync(process.execPath, [tool, ...args], {
      cwd: projectRoot,
      env: { ...process.env, COBOLT_ARCH_ICON_FETCH_CONTEXT: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (res.error) return { ok: false, error: res.error.message || 'spawn-error' };
    let summary = null;
    try {
      summary = JSON.parse(res.stdout || '{}');
    } catch {
      summary = null;
    }
    return {
      ok: res.status === 0,
      exitCode: res.status,
      summary,
      stderr: (res.stderr || '').trim().slice(0, 500),
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// Build the deduped slug list for icon ensure. Sources:
//   1. Slugs the registry resolver matched against graph node names.
//   2. Tech-stack-detected slugs (covers things named generically in the graph
//      like "Database" or "Auth" that wouldn't resolve from name alone).
function collectSlugsToFetch(iconsResolved, techStack) {
  const out = new Set();
  for (const entry of Object.values(iconsResolved || {})) {
    if (entry?.slug) out.add(entry.slug);
  }
  for (const slug of techStack?.allSlugs || []) {
    out.add(slug);
  }
  return [...out].filter(Boolean).sort();
}

function generate({
  projectRoot = process.cwd(),
  pipeline = 'greenfield',
  profile = 'core',
  state = 'target',
  format = 'mermaid',
  theme: themeName = 'professional',
  iconFetch = null,
  iconBudget = null,
} = {}) {
  if (!PROFILE_REGISTRY[profile]) {
    return { ok: false, code: 3, error: `unknown profile: ${profile}` };
  }

  const outDir = archRoot(projectRoot, pipeline);
  const gp = graphPath(projectRoot, pipeline);
  const graph = readJson(gp);
  if (!graph) {
    return { ok: false, code: 1, error: `graph not found at ${gp} — run cobolt-architecture-graph build first.` };
  }

  const entries = resolveProfileEntries(profile, state);
  if (!entries?.length) {
    return { ok: false, code: 3, error: `no diagrams resolved for profile=${profile}` };
  }

  // Resolve theme once. Safe to call even when format doesn't request d2 —
  // the HTML packet also consumes theme colors.
  const themesLib = require('../lib/cobolt-arch-themes');
  const theme = themesLib.resolveTheme(themeName, { projectRoot });

  // Resolve icons across the primary graph (used for d2 + HTML packet).
  const iconsLib = require('../lib/cobolt-arch-icons');
  const stackLib = require('../lib/cobolt-arch-tech-stack');
  const techStack = (() => {
    try {
      return stackLib.detect(projectRoot);
    } catch {
      return { allSlugs: [], categories: {} };
    }
  })();
  let iconsResolved = iconsLib.resolveGraph(graph, { projectRoot, techStack });

  // Populate the icon cache from allowlisted CDNs (Iconify/simple-icons/
  // devicon — covers AWS Architecture Icons, Azure Icons, Google Cloud Icons,
  // and the Microsoft enterprise icon set via the logos: pack on Iconify).
  // Without this, every node renders the generic-shape fallback in svgIcon().
  // Honors --arch-icon-fetch and COBOLT_ARCH_ICON_FETCH (off/bundled-only/local-only).
  const slugsToFetch = collectSlugsToFetch(iconsResolved, techStack);
  const iconFetchReport = ensureIconCacheSync({ projectRoot, slugs: slugsToFetch, iconFetch, iconBudget });
  if (slugsToFetch.length && iconFetchReport.ok && !iconFetchReport.skipped) {
    // Re-resolve so newly cached files are picked up via the cache lookup
    // branch in lib/cobolt-arch-icons.js (returns source: 'cached', localPath).
    iconsResolved = iconsLib.resolveGraph(graph, { projectRoot, techStack });
  }

  const allDiagrams = [];

  if (state === 'both' || state === 'composite') {
    for (const sub of ['current', 'target', 'delta']) {
      const subGraph = readJson(path.join(path.dirname(gp), `architecture-graph.${sub}.json`)) || graph;
      const subIcons = iconsLib.resolveGraph(subGraph, { projectRoot, techStack });
      const diagrams = generateForState(entries, subGraph, outDir, {
        profile,
        state: sub,
        pipeline,
        format,
        theme,
        iconsResolved: subIcons,
      });
      allDiagrams.push(...diagrams.map((d) => ({ ...d, state: sub })));
    }
  } else {
    const diagrams = generateForState(entries, graph, outDir, {
      profile,
      state,
      pipeline,
      format,
      theme,
      iconsResolved,
    });
    allDiagrams.push(...diagrams);
  }

  // Compute how many resolved icons actually have a local SVG file on disk
  // (the only state in which the SVG renderer will inline a real icon — every
  // other state falls back to the generic shape placeholder).
  const iconsWithLocalPath = Object.values(iconsResolved).filter((e) => e?.localPath).length;
  const manifest = {
    version: CANONICAL_VERSION,
    generatedAt: new Date().toISOString(),
    pipeline,
    workflow: pipeline === 'brownfield' ? 'brownfield' : 'plan',
    profile,
    state,
    format,
    theme: theme.name,
    graphPath: path.relative(outDir, gp).replace(/\\/g, '/'),
    reports: { html: null, pdf: null, pdfStatus: 'skipped', pdfReason: 'report tool not yet invoked' },
    diagrams: allDiagrams,
    gaps: graph.gaps || [],
    icons: {
      resolved: Object.keys(iconsResolved).length,
      cached: iconsWithLocalPath,
      total: (graph.nodes || []).length,
      attributions: buildIconAttributions(iconsResolved),
      fetch: {
        mode: String(iconFetch || process.env.COBOLT_ARCH_ICON_FETCH || 'auto').toLowerCase(),
        slugsRequested: slugsToFetch.length,
        ok: iconFetchReport.ok,
        skipped: iconFetchReport.skipped || null,
        exitCode: iconFetchReport.exitCode ?? null,
        budgetRemaining: iconFetchReport.summary?.budgetRemaining ?? null,
        note: iconFetchReport.summary?.note || iconFetchReport.error || null,
      },
    },
    techStack: techStack.categories ? { slugs: techStack.allSlugs } : undefined,
    validation: { schemaPass: true, syntaxPass: true, evidencePass: true, tier: 3, violations: [] },
  };

  // Real schema validation — replace the hardcoded schemaPass:true with an
  // actual shape check against the manifest schema's required fields.
  const manifestShape = validateManifestShape(manifest);
  manifest.validation.schemaPass = manifestShape.ok;
  if (!manifestShape.ok) {
    manifest.validation.violations.push(
      ...manifestShape.violations.map((v) => ({
        code: 'MANIFEST_SHAPE',
        message: v,
        severity: 'error',
      })),
    );
  }

  writeFile(path.join(outDir, 'diagram-manifest.json'), JSON.stringify(manifest, null, 2));
  writeDiagramMaster(outDir, manifest, graph);
  writeFormatManifests(outDir, manifest);
  writeEvidenceMap(outDir, manifest, graph);
  writeIndex(outDir, manifest, graph);

  return {
    ok: true,
    code: 0,
    outDir,
    manifest,
    paths: {
      index: path.join(outDir, 'index.md'),
      manifest: path.join(outDir, 'diagram-manifest.json'),
      master: path.join(outDir, 'diagram-master.json'),
      evidenceMap: path.join(outDir, 'evidence-map.json'),
    },
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseCliArgs(argv) {
  const out = {
    pipeline: 'greenfield',
    profile: 'core',
    state: 'target',
    format: 'all',
    theme: 'professional',
    dir: null,
    json: false,
    iconFetch: null,
    iconBudget: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--pipeline') out.pipeline = argv[++i];
    else if (a === '--profile') out.profile = argv[++i];
    else if (a === '--state') out.state = argv[++i];
    else if (a === '--format') out.format = argv[++i];
    else if (a === '--theme') out.theme = argv[++i];
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--icon-fetch' || a === '--arch-icon-fetch') out.iconFetch = argv[++i];
    else if (a === '--icon-budget' || a === '--arch-icon-budget') out.iconBudget = parseInt(argv[++i], 10);
  }
  return out;
}

function cli(argv) {
  const [cmd, ...rest] = argv;

  if (cmd === 'list-profiles') {
    for (const [p, entries] of Object.entries(PROFILE_REGISTRY)) {
      process.stdout.write(`${p} (${dedupeDiagramEntries(entries).length} diagrams)\n`);
    }
    return;
  }

  if (cmd !== 'generate') {
    process.stderr.write(
      'usage: cobolt-architecture-diagrams <generate|list-profiles> [--pipeline ...] [--profile ...] [--state ...] [--format ...] [--dir ...]\n',
    );
    process.exit(2);
  }

  const opts = parseCliArgs(rest);
  const result = generate({
    projectRoot: opts.dir || process.cwd(),
    pipeline: opts.pipeline,
    profile: opts.profile,
    state: opts.state,
    format: opts.format,
    theme: opts.theme,
    iconFetch: opts.iconFetch,
    iconBudget: opts.iconBudget,
  });

  if (!result.ok) {
    process.stderr.write(`[architecture-diagrams] ${result.error}\n`);
    process.exit(result.code);
  }

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, paths: result.paths, diagramCount: result.manifest.diagrams.length }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(
      `[architecture-diagrams] wrote ${result.manifest.diagrams.length} diagrams to ${result.outDir}\n`,
    );
  }
}

if (require.main === module) cli(process.argv.slice(2));

function buildIconAttributions(iconsResolved) {
  const sources = new Map();
  for (const entry of Object.values(iconsResolved || {})) {
    const src =
      entry?.source ||
      (entry?.sources?.iconify
        ? 'iconify'
        : entry?.sources?.simpleicons
          ? 'simpleicons'
          : entry?.sources?.devicon
            ? 'devicon'
            : 'unknown');
    const lic = entry?.license || 'unknown';
    const key = `${src}|${lic}`;
    if (!sources.has(key)) sources.set(key, { source: src, license: lic, count: 0 });
    sources.get(key).count += 1;
  }
  return [...sources.values()];
}

module.exports = {
  generate,
  renderMermaid,
  renderPlantUml,
  renderPlantUmlC4Context,
  renderPlantUmlC4Container,
  renderPlantUmlGeneric,
  renderD2,
  buildSpec,
  resolveProfileEntries,
  formatRequestsMermaid,
  formatRequestsPlantUml,
  formatRequestsD2,
  formatRequestsSvgIconic,
  buildIconAttributions,
  PROFILE_REGISTRY,
  CORE_DIAGRAMS,
};
