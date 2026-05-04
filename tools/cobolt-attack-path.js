#!/usr/bin/env node

// CoBolt Attack Path Graph Builder — deterministic (v0.19+)
//
// Consumes three brownfield artifacts and produces an attack-path graph
// combining entry points, auth boundaries, privilege tiers, and data-exit
// edges. Artifacts produced:
//   - 12j-attack-paths.json  (graph: nodes + edges + rank-ordered paths)
//   - 12j-attack-paths.md    (human-readable summary with worst paths)
//
// Inputs (best-effort — degrades gracefully when inputs missing):
//   - _cobolt-output/latest/brownfield/07-configuration-and-access-audit.md
//   - _cobolt-output/latest/brownfield/08-api-and-protocol-catalog.md  (optional)
//   - _cobolt-output/latest/brownfield/09-data-flows-and-sequences.md  (optional)
//   - _cobolt-output/latest/brownfield/09-supply-chain-and-vulnerability-review.md
//   - _cobolt-output/latest/brownfield/12-security-and-quality-assessment.md
//   - _cobolt-output/latest/brownfield/runtime-truth.json  (optional)
//
// No LLM. Builds the graph from patterns found in the source artifacts.
// When an input is missing, the relevant graph section is tagged with
// `incomplete: true` and the MD summary names the missing input.
//
// Usage:
//   node tools/cobolt-attack-path.js build [--dir <path>] [--json] [--save]

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
const EXIT_OK = 0;
const EXIT_USAGE = 1;

const BROWNFIELD_ARTIFACTS = {
  accessAudit: '07-configuration-and-access-audit.md',
  apiCatalog: '08-api-and-protocol-catalog.md',
  dataFlows: '09-data-flows-and-sequences.md',
  supplyChain: '09-supply-chain-and-vulnerability-review.md',
  securityAssessment: '12-security-and-quality-assessment.md',
  runtimeTruth: 'runtime-truth.json',
};

function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

// ── Extractors ─────────────────────────────────────────────

function extractEntryPoints(apiText, securityText) {
  const nodes = [];
  const seen = new Set();
  const pattern = /\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\/[^\s`'")\]]{1,120})/g;
  for (const src of [apiText || '', securityText || '']) {
    for (const m of src.matchAll(pattern)) {
      const key = `${m[1]} ${m[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const isPublic = /\/(public|webhook|auth|login|signup|register|health|metrics)/i.test(m[2]);
      const isAuth = /\/(auth|login|signup|register|oauth|token|session)/i.test(m[2]);
      nodes.push({
        id: `entry:${key}`,
        kind: 'entry-point',
        method: m[1],
        path: m[2],
        exposure: isPublic ? 'public' : 'unknown',
        authGate: isAuth ? 'self' : 'unknown',
      });
    }
  }
  return nodes;
}

function extractAuthBoundaries(accessText) {
  const boundaries = [];
  if (!accessText) return boundaries;
  const roleMatches = [
    ...accessText.matchAll(/\b(?:role|roles?|permission[s]?|scope[s]?)\s*[:=]\s*['"]?([A-Z_][A-Z0-9_-]{2,40})['"]?/gi),
  ];
  const seen = new Set();
  for (const m of roleMatches) {
    const role = m[1].toUpperCase();
    if (seen.has(role)) continue;
    seen.add(role);
    boundaries.push({ id: `role:${role}`, kind: 'auth-boundary', role });
  }
  // Middleware / guard detection
  const middlewareMatches = [
    ...accessText.matchAll(
      /\b(?:requireAuth|requireRole|authenticated|authorize|guard|middleware|protect)\b[^\n]{0,160}/gi,
    ),
  ];
  for (const m of middlewareMatches.slice(0, 30)) {
    boundaries.push({
      id: `middleware:${boundaries.length}`,
      kind: 'auth-boundary',
      pattern: m[0].slice(0, 160),
    });
  }
  return boundaries;
}

function extractDataExits(dataFlowsText, securityText) {
  const exits = [];
  if (!dataFlowsText && !securityText) return exits;
  const combined = `${dataFlowsText || ''}\n${securityText || ''}`;
  // External host calls
  const hostMatches = [...combined.matchAll(/https?:\/\/([a-zA-Z0-9.-]+\.[a-zA-Z]{2,24})/g)];
  const seenHost = new Set();
  for (const m of hostMatches) {
    const host = m[1].toLowerCase();
    if (seenHost.has(host) || host === 'example.com' || host === 'localhost') continue;
    if (host.endsWith('.github.com') || host.endsWith('.github.io')) continue;
    seenHost.add(host);
    exits.push({ id: `exit:http:${host}`, kind: 'data-exit', transport: 'https', host });
  }
  // DB queries to external systems
  if (/\b(?:mongodb|redis|kafka|rabbitmq|s3|gcs|azure-storage)\b/i.test(combined)) {
    for (const m of combined.matchAll(/\b(mongodb|redis|kafka|rabbitmq|s3|gcs|azure-storage)\b/gi)) {
      const kind = m[1].toLowerCase();
      const id = `exit:${kind}`;
      if (!exits.find((e) => e.id === id)) exits.push({ id, kind: 'data-exit', transport: kind });
    }
  }
  return exits;
}

function extractVulnerabilities(supplyChainText, securityText) {
  const vulns = [];
  const combined = `${supplyChainText || ''}\n${securityText || ''}`;
  const cveMatches = [...combined.matchAll(/\bCVE-\d{4}-\d{4,8}\b/g)];
  const seen = new Set();
  for (const m of cveMatches) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    vulns.push({ id: `vuln:${m[0]}`, kind: 'vulnerability', cve: m[0] });
  }
  return vulns;
}

function buildPaths(nodes) {
  // Heuristic path construction: entry-point → (auth-boundary?) → vuln/exit
  const paths = [];
  const entries = nodes.filter((n) => n.kind === 'entry-point');
  const boundaries = nodes.filter((n) => n.kind === 'auth-boundary');
  const exits = nodes.filter((n) => n.kind === 'data-exit');
  const vulns = nodes.filter((n) => n.kind === 'vulnerability');

  for (const entry of entries.slice(0, 40)) {
    const entryRisk = entry.exposure === 'public' ? 2 : 1;
    const chosenBoundary = boundaries.find((b) => b.role && /ADMIN|ROOT|SUPER/i.test(b.role)) || boundaries[0];
    const hops = [entry];
    let risk = entryRisk;
    if (chosenBoundary) {
      hops.push(chosenBoundary);
    } else {
      risk += 2; // no auth boundary detected for this entry — elevated risk
    }
    if (vulns.length > 0) {
      hops.push(vulns[0]);
      risk += 3;
    }
    if (exits.length > 0) {
      hops.push(exits[0]);
      risk += 2;
    }
    paths.push({
      id: `path:${entry.id}`,
      risk,
      hops: hops.map((h) => h.id),
      narrative: `${entry.method} ${entry.path} → ${chosenBoundary ? chosenBoundary.id : 'NO-AUTH-BOUNDARY'} → ${vulns[0] ? vulns[0].cve : 'no-known-vuln'} → ${exits[0] ? exits[0].transport : 'no-known-exfil'}`,
    });
  }
  return paths.sort((a, b) => b.risk - a.risk);
}

function buildGraph(dir) {
  const bfDir = path.join(dir, '_cobolt-output', 'latest', 'brownfield');
  const read = (key) => readIfExists(path.join(bfDir, BROWNFIELD_ARTIFACTS[key]));
  const accessText = read('accessAudit');
  const apiText = read('apiCatalog');
  const dataText = read('dataFlows');
  const supplyChainText = read('supplyChain');
  const securityText = read('securityAssessment');
  const runtimeText = read('runtimeTruth');

  const missing = [];
  if (!accessText) missing.push(BROWNFIELD_ARTIFACTS.accessAudit);
  if (!apiText) missing.push(BROWNFIELD_ARTIFACTS.apiCatalog);
  if (!dataText) missing.push(BROWNFIELD_ARTIFACTS.dataFlows);
  if (!supplyChainText) missing.push(BROWNFIELD_ARTIFACTS.supplyChain);
  if (!securityText) missing.push(BROWNFIELD_ARTIFACTS.securityAssessment);

  const entries = extractEntryPoints(apiText, securityText);
  const boundaries = extractAuthBoundaries(accessText);
  const exits = extractDataExits(dataText, securityText);
  const vulns = extractVulnerabilities(supplyChainText, securityText);
  const nodes = [...entries, ...boundaries, ...exits, ...vulns];

  const edges = [];
  for (const e of entries) {
    if (boundaries.length > 0) {
      edges.push({ from: e.id, to: boundaries[0].id, kind: 'traverses' });
    }
    for (const vuln of vulns.slice(0, 2)) edges.push({ from: e.id, to: vuln.id, kind: 'may-exploit' });
    for (const exit of exits.slice(0, 2)) edges.push({ from: e.id, to: exit.id, kind: 'may-exfiltrate' });
  }

  const paths = buildPaths(nodes);

  return {
    tool: 'cobolt-attack-path',
    version: '1.0.0',
    target: dir,
    timestamp: new Date().toISOString(),
    inputs: {
      accessAudit: accessText != null,
      apiCatalog: apiText != null,
      dataFlows: dataText != null,
      supplyChain: supplyChainText != null,
      securityAssessment: securityText != null,
      runtimeTruth: runtimeText != null,
    },
    missingInputs: missing,
    incomplete: missing.length > 0,
    summary: {
      entryPoints: entries.length,
      authBoundaries: boundaries.length,
      dataExits: exits.length,
      knownVulnerabilities: vulns.length,
      totalNodes: nodes.length,
      totalEdges: edges.length,
      totalPaths: paths.length,
      topRiskPath: paths[0] || null,
    },
    nodes,
    edges,
    paths,
  };
}

function emitMarkdown(result) {
  const { target, timestamp, summary, missingInputs, paths, incomplete } = result;
  const lines = [];
  lines.push('# Attack Path Graph');
  lines.push('');
  lines.push(`- **Generated:** ${timestamp}`);
  lines.push(`- **Target:** ${target}`);
  lines.push(`- **Entry points:** ${summary.entryPoints}`);
  lines.push(`- **Auth boundaries:** ${summary.authBoundaries}`);
  lines.push(`- **Data exits:** ${summary.dataExits}`);
  lines.push(`- **Known vulnerabilities:** ${summary.knownVulnerabilities}`);
  lines.push(`- **Paths constructed:** ${summary.totalPaths}`);
  lines.push('');
  if (incomplete) {
    lines.push(
      '> ⚠️ **Incomplete graph** — the following input artifacts are missing. The graph was built from the artifacts that were present; the missing inputs would add additional nodes and edges. Re-run after those inputs are produced:',
    );
    lines.push('');
    for (const m of missingInputs) lines.push(`  - \`${m}\``);
    lines.push('');
  }
  lines.push('## How this graph is built');
  lines.push('');
  lines.push(
    'This tool consumes the Phase 1 discovery artifacts and Phase 2 security assessment outputs to build an attack-path graph. It extracts:',
  );
  lines.push('');
  lines.push('- **Entry points** from the API catalog (HTTP verb + route pairs) and security assessment');
  lines.push('- **Auth boundaries** from the access audit (roles, permissions, middleware patterns)');
  lines.push('- **Data exits** from data-flow descriptions (external hosts, queues, object stores)');
  lines.push('- **Known vulnerabilities** from the supply-chain and security assessments (CVE identifiers)');
  lines.push('');
  lines.push(
    'Paths are ranked by a coarse risk score that increments for public exposure, missing auth boundary between entry and action, presence of any CVE in the path, and presence of a data exit. This is a **deterministic heuristic** — it is not a replacement for manual threat modeling or an exploit PoC.',
  );
  lines.push('');
  lines.push('## Top Paths (by risk score)');
  lines.push('');
  if (paths.length === 0) {
    lines.push(
      'No entry-point → action paths could be reconstructed. Most likely cause: Phase 1 did not produce an API catalog or an access audit. Re-run `/cobolt-brownfield --scan deep` to generate the missing artifacts, then re-run this tool.',
    );
  } else {
    for (const p of paths.slice(0, 20)) {
      lines.push(`### Risk ${p.risk} — \`${p.id}\``);
      lines.push('');
      lines.push(`\`${p.narrative}\``);
      lines.push('');
      lines.push('Hop chain:');
      for (const hop of p.hops) lines.push(`  - ${hop}`);
      lines.push('');
    }
    if (paths.length > 20) {
      lines.push(`… ${paths.length - 20} more paths in the JSON artifact.`);
      lines.push('');
    }
  }
  lines.push('## Limits');
  lines.push('');
  lines.push(
    'This tool is intentionally heuristic. It **does not**: (a) build a full exploit chain, (b) verify that a known CVE is actually reachable through the listed entry points, (c) attempt to probe any running service, (d) model session lifecycle or token scope properly. Use it as a triage lens, not as proof. For exploit-reachable paths, pair with `cobolt-pentest` (Phase 2.5 optional).',
  );
  lines.push('');
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || command === '-h' || command === '--help') {
    process.stderr.write('Usage: cobolt-attack-path build [--dir <path>] [--json] [--save] [--output <path>]\n');
    process.exit(EXIT_USAGE);
  }
  if (command !== 'build') {
    process.stderr.write(`Unknown command: ${command}\n`);
    process.exit(EXIT_USAGE);
  }
  const dirIdx = args.indexOf('--dir');
  const dir = dirIdx !== -1 && args[dirIdx + 1] ? path.resolve(args[dirIdx + 1]) : process.cwd();
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx !== -1 && args[outputIdx + 1] ? args[outputIdx + 1] : null;
  const save = args.includes('--save');

  const result = buildGraph(dir);
  const md = emitMarkdown(result);

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `[cobolt-attack-path] built graph — ${result.summary.totalNodes} nodes, ${result.summary.totalEdges} edges, ${result.summary.totalPaths} paths${result.incomplete ? ` (incomplete: ${result.missingInputs.length} missing)` : ''}\n`,
    );
  }

  if (save || outputPath) {
    const jsonPath = outputPath || path.join(dir, '_cobolt-output', 'latest', 'brownfield', '12j-attack-paths.json');
    const mdPath = jsonPath.replace(/\.json$/, '.md');
    atomicWrite(jsonPath, JSON.stringify(result, null, 2), 'utf8');
    atomicWrite(mdPath, md, 'utf8');
    process.stderr.write(`[cobolt-attack-path] wrote ${jsonPath}\n`);
    process.stderr.write(`[cobolt-attack-path] wrote ${mdPath}\n`);
  }

  process.exit(EXIT_OK);
}

if (require.main === module) main();

module.exports = { buildGraph, emitMarkdown };
