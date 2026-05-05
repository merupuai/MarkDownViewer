#!/usr/bin/env node

// CoBolt Architecture Evidence Graph builder (v0.21.0).
//
// Builds the canonical intermediate graph consumed by the diagram generator,
// renderer, validator, and report tools. Output is schema-validated against
// source/schemas/architecture-graph.schema.json.
//
// Non-disruption contract:
//   - Reads only existing planning / brownfield artifacts.
//   - Writes only under _cobolt-output/latest/architecture-diagrams/graph/
//     (or _cobolt-output/latest/brownfield/architecture-diagrams/graph/).
//   - Never mutates PRD / TRD / architecture / data-model / api / security /
//     delivery artifacts.
//
// Usage:
//   node tools/cobolt-architecture-graph.js build --pipeline greenfield [--state target] [--dir <projectRoot>]
//   node tools/cobolt-architecture-graph.js build --pipeline brownfield --state current
//   node tools/cobolt-architecture-graph.js show   [--dir <projectRoot>] [--pipeline greenfield|brownfield]
//
// Exit codes:
//   0 — graph written
//   1 — required input artifact missing (non-fatal caller should handle)
//   2 — usage error
//   3 — graph failed schema validation

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CANONICAL_VERSION = '1.0.0';

// ── Path helpers ────────────────────────────────────────────────────────────

function outputRoot(projectRoot) {
  return path.join(path.resolve(projectRoot || process.cwd()), '_cobolt-output', 'latest');
}

function archRoot(projectRoot, pipeline) {
  const base = outputRoot(projectRoot);
  return pipeline === 'brownfield'
    ? path.join(base, 'brownfield', 'architecture-diagrams')
    : path.join(base, 'architecture-diagrams');
}

// Enforce that every write stays under the architecture-diagrams subtree.
// Defense-in-depth against --dir misuse or symlink tricks.
function assertUnderArchRoot(targetPath, projectRoot, pipeline) {
  const realRoot = path.resolve(archRoot(projectRoot, pipeline));
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(realRoot, resolvedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `[architecture-graph] refusing to write outside architecture-diagrams subtree: ${resolvedTarget} not under ${realRoot}`,
    );
  }
}

function graphPath(projectRoot, pipeline) {
  return path.join(archRoot(projectRoot, pipeline), 'graph', 'architecture-graph.json');
}

// ── IO helpers ──────────────────────────────────────────────────────────────

function readText(p) {
  try {
    return fs
      .readFileSync(p, 'utf8')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
}

function readJson(p) {
  const txt = readText(p);
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function sha256(content) {
  return crypto
    .createHash('sha256')
    .update(content || '')
    .digest('hex');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeFile(p, content) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, content, { mode: 0o600 });
}

function _relPath(p, projectRoot) {
  return path.relative(path.resolve(projectRoot || process.cwd()), p).replace(/\\/g, '/');
}

function addSourceEvidence(sourceEvidence, projectRoot, rel, kind = 'markdown') {
  const p = path.join(path.resolve(projectRoot || process.cwd()), rel);
  const raw = readText(p);
  if (!raw) return false;
  sourceEvidence.push({ path: rel.replace(/\\/g, '/'), kind, bytes: raw.length, sha256: sha256(raw) });
  return true;
}

function artifactEvidence(artifacts, key, summary) {
  return {
    path: artifacts[key]?.evidencePath || `_cobolt-output/.../${key}`,
    summary: summary || '',
  };
}

// ── Markdown extractors ─────────────────────────────────────────────────────

function extractSection(md, pattern) {
  if (!md) return null;
  const lines = md.split('\n');
  const rx = new RegExp(`^#{1,6}\\s+.*(?:${pattern}).*$`, 'i');
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (rx.test(lines[i])) {
      start = i + 1;
      level = (lines[i].match(/^#+/) || [''])[0].length;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let j = start; j < lines.length; j += 1) {
    const m = lines[j].match(/^(#{1,6})\s+/);
    if (m && m[1].length <= level) {
      end = j;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

function extractBullets(section) {
  if (!section) return [];
  const out = [];
  for (const line of section.split('\n')) {
    const m = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+?)\s*$/);
    if (!m) continue;
    const item = cleanExtractedName(m[1]);
    if (isUsefulExtractedName(item)) out.push(item);
  }
  return out;
}

function extractTables(section) {
  if (!section) return [];
  const tables = [];
  const lines = section.split('\n');
  let i = 0;
  while (i < lines.length) {
    if (/^\s*\|.+\|\s*$/.test(lines[i]) && /^\s*\|[\s-:|]+\|\s*$/.test(lines[i + 1] || '')) {
      const header = lines[i]
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim().toLowerCase());
      const rows = [];
      let j = i + 2;
      while (j < lines.length && /^\s*\|.+\|\s*$/.test(lines[j])) {
        const cells = lines[j]
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim());
        const row = {};
        header.forEach((h, idx) => {
          if (h) row[h] = cells[idx] || '';
        });
        rows.push(row);
        j += 1;
      }
      tables.push({ header, rows });
      i = j;
    } else {
      i += 1;
    }
  }
  return tables;
}

function cleanExtractedName(raw) {
  return String(raw || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]+\]\([^)]*\)/g, (m) => m.replace(/^\[|\]\([^)]*\)$/g, ''))
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isUsefulExtractedName(name) {
  const s = String(name || '').trim();
  if (!s || s.length > 140) return false;
  if (/^[:;,.!?-]+$/.test(s)) return false;
  if (/^drawn verbatim\b/i.test(s)) return false;
  if (/^source documents?:/i.test(s)) return false;
  if (/^(component|description|owner|---)$/i.test(s)) return false;
  if (/[<>|]/.test(s)) return false;
  return true;
}

function extractSubheadings(section) {
  if (!section) return [];
  const out = [];
  for (const m of section.matchAll(/^#{3,6}\s+(.+?)\s*$/gm)) {
    const name = cleanExtractedName(m[1]);
    if (isUsefulExtractedName(name)) out.push(name);
  }
  return out;
}

function extractHeadings(section, minLevel = 2, maxLevel = 6) {
  if (!section) return [];
  const out = [];
  for (const m of section.matchAll(/^(#{1,6})\s+(.+?)\s*$/gm)) {
    const level = m[1].length;
    if (level < minLevel || level > maxLevel) continue;
    const name = cleanExtractedName(m[2]);
    if (isUsefulExtractedName(name)) out.push(name);
  }
  return out;
}

function sanitizeId(str, prefix) {
  const base = String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${prefix}-${base || 'x'}`;
}

function dedupeById(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

// ── Greenfield source loaders ───────────────────────────────────────────────

function loadGreenfieldArtifacts(projectRoot) {
  const planning = path.join(outputRoot(projectRoot), 'planning');
  const names = [
    'prd.md',
    'trd.md',
    'architecture.md',
    'system-architecture.md',
    'data-model-spec.md',
    'api-contracts.md',
    'security-requirements.md',
    'delivery-plan.md',
    'enriched-requirements.md',
    'feature-service-blueprints.md',
    'source-document-consolidation.md',
    'implicit-requirements.md',
  ];
  const artifacts = {};
  const sourceEvidence = [];
  for (const n of names) {
    const p = path.join(planning, n);
    const content = readText(p);
    if (content) {
      artifacts[n] = { path: p, content, evidencePath: `_cobolt-output/latest/planning/${n}` };
      sourceEvidence.push({
        path: `_cobolt-output/latest/planning/${n}`,
        kind: 'markdown',
        bytes: content.length,
        sha256: sha256(content),
      });
    }
  }
  const jsonNames = ['feature-registry.json', 'rtm.json', 'interface-contracts.json', 'bounded-contexts.json'];
  for (const n of jsonNames) {
    const p = path.join(planning, n);
    const data = readJson(p);
    if (data) {
      artifacts[n] = { path: p, data, evidencePath: `_cobolt-output/latest/planning/${n}` };
      const raw = readText(p) || '';
      sourceEvidence.push({
        path: `_cobolt-output/latest/planning/${n}`,
        kind: 'json',
        bytes: raw.length,
        sha256: sha256(raw),
      });
    }
  }
  const docsFallback = loadProjectDocsArtifacts(projectRoot);
  if (docsFallback.sourceEvidence.length) {
    for (const [key, artifact] of Object.entries(docsFallback.artifacts || {})) {
      const existing = artifacts[key];
      const existingIsConsolidationOnly =
        !existing || /source-document-consolidation\.md$/i.test(existing.evidencePath || '');
      if (existingIsConsolidationOnly) artifacts[key] = artifact;
    }
    const seenEvidence = new Set(sourceEvidence.map((entry) => entry.path));
    for (const entry of docsFallback.sourceEvidence) {
      if (seenEvidence.has(entry.path)) continue;
      sourceEvidence.push(entry);
      seenEvidence.add(entry.path);
    }
  }
  if (!sourceEvidence.length) {
    return loadRepositoryFallbackArtifacts(projectRoot);
  }
  return { artifacts, sourceEvidence };
}

const PROJECT_DOC_ARTIFACTS = {
  'prd.md': [
    'docs/01-product/01-product-overview.md',
    'docs/01-product/02-feature-catalog.md',
    'docs/01-product/03-feature-to-module-matrix.md',
  ],
  'architecture.md': [
    'docs/02-architecture/01-solution-architecture.md',
    'docs/03-build-specs/01-gateway-build-spec.md',
    'docs/03-build-specs/06-deployment-topologies.md',
  ],
  'data-model-spec.md': [
    'docs/02-architecture/02-domain-model.md',
    'docs/03-build-specs/04-state-config-and-event-spec.md',
  ],
  'api-contracts.md': [
    'docs/02-architecture/03-api-and-protocols.md',
    'docs/03-build-specs/02-runtime-api-contracts.md',
  ],
  'security-requirements.md': [
    'docs/04-security-and-operations/01-security-and-policy-pipeline.md',
    'docs/04-security-and-operations/05-identity-and-access-spec.md',
    'docs/04-security-and-operations/06-kill-switch-and-emergency-controls.md',
    'docs/04-security-and-operations/08-presidio-integration-spec.md',
    'docs/04-security-and-operations/09-enforcement-and-verification-model.md',
  ],
  'delivery-plan.md': [
    'docs/06-delivery/01-implementation-roadmap.md',
    'docs/06-delivery/02-testing-and-verification.md',
    'docs/06-delivery/04-sdks-and-developer-experience.md',
    'docs/03-build-specs/06-deployment-topologies.md',
  ],
  'trd.md': [
    'docs/04-security-and-operations/02-nfrs-and-operations.md',
    'docs/04-security-and-operations/03-slos-and-service-tiers.md',
    'docs/05-integrations/01-storage-and-rag.md',
    'docs/05-integrations/02-ops-and-security-tools.md',
    'docs/05-integrations/03-billing-and-metering.md',
    'docs/05-integrations/04-ai-agent-platforms-and-tools.md',
    'docs/05-integrations/05-agent-interoperability-and-a2a.md',
    'docs/05-integrations/06-catalogs-llmops-and-agent-observability.md',
    'docs/05-integrations/07-observability-export-and-datalake.md',
  ],
  'feature-service-blueprints.md': [
    'docs/03-build-specs/01-gateway-build-spec.md',
    'docs/03-build-specs/03-control-plane-resource-spec.md',
    'docs/03-build-specs/05-dashboard-and-command-center.md',
    'docs/03-build-specs/07-prompt-registry-spec.md',
    'docs/03-build-specs/08-prompt-and-context-caching.md',
    'docs/03-build-specs/09-model-intake-and-governance.md',
    'docs/03-build-specs/10-tenant-lifecycle-spec.md',
    'docs/03-build-specs/11-control-plane-authority-and-lifecycle.md',
  ],
};

function loadProjectDocsArtifacts(projectRoot) {
  const root = path.resolve(projectRoot || process.cwd());
  const artifacts = {};
  const sourceEvidence = [];
  for (const [key, rels] of Object.entries(PROJECT_DOC_ARTIFACTS)) {
    const parts = [];
    const existing = [];
    for (const rel of rels) {
      const p = path.join(root, rel);
      const content = readText(p);
      if (!content) continue;
      existing.push(rel);
      parts.push(`\n\n<!-- source: ${rel} -->\n\n${content}`);
      sourceEvidence.push({
        path: rel.replace(/\\/g, '/'),
        kind: 'markdown',
        bytes: content.length,
        sha256: sha256(content),
      });
    }
    if (parts.length) {
      const normalized = key === 'architecture.md' ? synthesizeArchitectureDocSections(parts.join('\n'), existing) : '';
      artifacts[key] = {
        path: path.join(root, existing[0]),
        evidencePath: existing[0].replace(/\\/g, '/'),
        content: `${normalized}${parts.join('\n')}`.trim(),
      };
    }
  }
  return { artifacts, sourceEvidence };
}

function synthesizeArchitectureDocSections(content, sourcePaths = []) {
  const components = [];
  const push = (name, description, owner) => {
    const clean = String(name || '')
      .replace(/[`*]/g, '')
      .trim();
    if (!clean || clean.length > 90) return;
    if (
      /^(infrastructure|grpc over https|rocksdb|postgresql|mnesia|amnesia\/mnesia|phoenix liveview|opentelemetry|victoriametrics|loki|tempo|opensearch|vault|kubernetes|helm|object storage)$/i.test(
        clean,
      )
    )
      return;
    if (components.some((c) => c.name.toLowerCase() === clean.toLowerCase())) return;
    components.push({
      name: clean,
      description: String(description || '').trim(),
      owner: owner || 'Architecture docs',
    });
  };
  for (const m of content.matchAll(/^\s*\d+\.\s+`([^`]+)`\s*-\s*([^\n]+)/gm)) {
    push(m[1], m[2], 'Build spec');
  }
  const baseline = extractSection(
    content,
    'architectural baseline|recommended build baseline|service responsibilities',
  );
  for (const b of extractBullets(baseline)) {
    const m = b.match(/^(Go edge agent|Elixir gateway server|MCP bridge)\b/i);
    if (m) push(m[1], b, 'Architecture baseline');
  }
  for (const h of content.matchAll(/^###\s+`?([a-z][\w/-]+)`?\s*$/gim)) {
    const name = h[1];
    if (
      /^(grpc|agents|ingest|rocksdb|amnesia|flush|reconciliation|resources|policies|identity|config|audit|analytics|storage|exports|fleet|feedback|experiments|integrations|backup|certs|nodes|cli_tools|mcp|web)$/i.test(
        name,
      )
    ) {
      push(`gateway-server/${name}`, 'Elixir gateway bounded context', 'Gateway server');
    }
  }
  if (!components.length) return '';
  return [
    '# Project Documentation Architecture Extract',
    '',
    `Source documents: ${sourcePaths.join(', ')}`,
    '',
    '## Components',
    '| Component | Description | Owner |',
    '| --- | --- | --- |',
    ...components.map((c) => `| ${c.name} | ${c.description.replace(/\|/g, '/')} | ${c.owner} |`),
    '',
  ].join('\n');
}

function listExistingComponents(projectRoot) {
  const candidates = [
    [
      'source',
      'source/ canonical content',
      'Agent, skill, hook, template, schema, plugin, and track authoring surface',
      'Platform authors',
    ],
    ['cli', 'cli/ cobolt-cli wrapper', 'Public Codex CLI command routing and workflow orchestration', 'CLI runtime'],
    [
      'tools',
      'tools/ deterministic tool engine',
      'Registered local tools for gates, scans, reports, evidence, and release checks',
      'Tooling runtime',
    ],
    [
      'lib',
      'lib/ shared runtime helpers',
      'Shared path, transform, registry, policy, and validation helpers',
      'Core libraries',
    ],
    ['bin', 'bin/ installer entrypoints', 'Install, approval, remodel, and reset entrypoints', 'Distribution runtime'],
    [
      'scripts',
      'scripts/ build and sync automation',
      'Hook builds, documentation sync, and repository maintenance automation',
      'Release automation',
    ],
    [
      'docs',
      'docs/ architecture and workflow docs',
      'Human-readable product, architecture, and operations references',
      'Documentation',
    ],
    [
      'tests',
      'tests/ Node verification suite',
      'Node test coverage for CLI, tools, transforms, hooks, and contracts',
      'Quality gates',
    ],
    [
      'source/hooks',
      'source/hooks/ runtime gates',
      'PreToolUse, PostToolUse, Stop, and lifecycle guards',
      'Runtime safety',
    ],
    [
      'source/schemas',
      'source/schemas/ artifact contracts',
      'JSON schemas for graph, manifests, reports, and pipeline artifacts',
      'Artifact contracts',
    ],
    [
      'app',
      'app/ standalone Phoenix product',
      'Phoenix application runtime for product-facing workflows',
      'Product app',
    ],
    [
      '_cobolt-output',
      '_cobolt-output/ artifact store',
      'Run-scoped artifacts, reports, evidence, audit ledgers, and memory',
      'Pipeline state',
    ],
  ];

  const out = candidates.filter(([rel]) => fs.existsSync(path.join(projectRoot, rel)));
  if (out.length) return out;

  try {
    return fs
      .readdirSync(projectRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .slice(0, 12)
      .map((d) => [d.name, `${d.name}/`, 'Repository top-level component', 'Repository']);
  } catch {
    return [];
  }
}

function extractCliCommandsFromSource(projectRoot) {
  const idx = readText(path.join(projectRoot, 'cli', 'index.js')) || '';
  const out = [];
  const commandBlock = idx.match(/const\s+COMMANDS\s*=\s*{([\s\S]*?)\n};/);
  if (commandBlock) {
    const rx = /^\s*([A-Za-z0-9_-]+):\s*{[\s\S]*?desc:\s*['"`]([^'"`\n]+)['"`]/gm;
    for (const m of commandBlock[1].matchAll(rx)) {
      out.push({ name: m[1], description: m[2].trim() });
    }
  }
  if (out.length) return out;

  const pkg = readJson(path.join(projectRoot, 'package.json'));
  return Object.entries(pkg?.bin || {}).map(([name, file]) => ({ name, description: `Executable mapped to ${file}` }));
}

function loadRepositoryFallbackArtifacts(projectRoot) {
  const root = path.resolve(projectRoot || process.cwd());
  const artifacts = {};
  const sourceEvidence = [];
  const pkg = readJson(path.join(root, 'package.json')) || {};
  const commands = extractCliCommandsFromSource(root);
  const components = listExistingComponents(root);

  addSourceEvidence(sourceEvidence, root, 'AGENTS.md');
  addSourceEvidence(sourceEvidence, root, 'docs/ARCHITECTURE.md');
  addSourceEvidence(sourceEvidence, root, 'docs/COBOLT-ARCHITECTURE-DIAGRAM.md');
  addSourceEvidence(sourceEvidence, root, 'docs/OUTPUTS-AND-ARTIFACTS.md');
  addSourceEvidence(sourceEvidence, root, 'package.json', 'json');
  addSourceEvidence(sourceEvidence, root, 'cli/index.js', 'source');
  addSourceEvidence(sourceEvidence, root, 'tools/index.js', 'source');
  addSourceEvidence(sourceEvidence, root, 'app/README.md');

  const projectName = pkg.name || path.basename(root);
  const commandCapabilities = commands.length
    ? commands.map((c) => `- ${c.name} workflow - ${c.description}`)
    : ['- Repository workflow - Derived from source tree inventory'];

  artifacts['prd.md'] = {
    path: path.join(root, 'AGENTS.md'),
    evidencePath: fs.existsSync(path.join(root, 'AGENTS.md')) ? 'AGENTS.md' : 'package.json',
    content: [
      `# ${projectName} Repository Fallback Requirements`,
      '',
      '## Personas',
      '- User / operator',
      '- CI / release automation',
      '- Runtime agent',
      '',
      '## Features',
      ...commandCapabilities,
      '- Source-backed runtime distribution - Canonical source content deploys into supported runtimes',
      '- Deterministic evidence and gate loop - Tools produce auditable output under the CoBolt artifact model',
    ].join('\n'),
  };

  artifacts['architecture.md'] = {
    path: path.join(root, 'docs', 'ARCHITECTURE.md'),
    evidencePath: fs.existsSync(path.join(root, 'docs', 'ARCHITECTURE.md')) ? 'docs/ARCHITECTURE.md' : 'package.json',
    content: [
      `# ${projectName} Repository Fallback Architecture`,
      '',
      '## Components',
      '| Component | Description | Owner |',
      '| --- | --- | --- |',
      ...components.map(([, name, description, owner]) => `| ${name} | ${description} | ${owner} |`),
    ].join('\n'),
  };

  artifacts['data-model-spec.md'] = {
    path: path.join(root, 'docs', 'OUTPUTS-AND-ARTIFACTS.md'),
    evidencePath: fs.existsSync(path.join(root, 'docs', 'OUTPUTS-AND-ARTIFACTS.md'))
      ? 'docs/OUTPUTS-AND-ARTIFACTS.md'
      : 'package.json',
    content: [
      `# ${projectName} Repository Fallback Data Model`,
      '',
      '## Entities',
      '- Source agent definitions',
      '- Source skill definitions',
      '- Source hook definitions',
      '- JSON schema contracts',
      '- Pipeline run artifacts',
      '- Latest run pointer',
      '- Milestone reports',
      '- Audit ledger entries',
      '- Context memory artifacts',
    ].join('\n'),
  };

  artifacts['api-contracts.md'] = {
    path: path.join(root, 'cli', 'index.js'),
    evidencePath: fs.existsSync(path.join(root, 'cli', 'index.js')) ? 'cli/index.js' : 'package.json',
    content: [
      `# ${projectName} Repository Fallback API Surface`,
      '',
      '## CLI Commands',
      ...(commands.length
        ? commands.map((c) => `- cobolt-cli ${c.name}: ${c.description}`)
        : ['- repository command surface: package bin entries']),
    ].join('\n'),
  };

  artifacts['security-requirements.md'] = {
    path: path.join(root, 'source', 'schemas', 'gate-tiers.json'),
    evidencePath: fs.existsSync(path.join(root, 'source', 'schemas', 'gate-tiers.json'))
      ? 'source/schemas/gate-tiers.json'
      : 'docs/ARCHITECTURE.md',
    content: [
      `# ${projectName} Repository Fallback Security Requirements`,
      '',
      '## Trust Boundaries',
      '- User workspace',
      '- Runtime deployment copies',
      '- External model and agent runtime',
      '- Network icon fetch boundary',
      '- Local artifact and audit store',
      '',
      '## Controls',
      '- PreToolUse gates',
      '- PostToolUse audit ledgers',
      '- JSON schema validation',
      '- Output path containment',
      '- Release readiness checks',
      '- Secret and dependency scanning',
    ].join('\n'),
  };

  artifacts['delivery-plan.md'] = {
    path: path.join(root, 'package.json'),
    evidencePath: 'package.json',
    content: [
      `# ${projectName} Repository Fallback Delivery Plan`,
      '',
      '## Runtime',
      '- Node.js CLI runtime',
      '- Local filesystem artifact store',
      '- Codex IDE runtime copy',
      '- Claude Code runtime copy',
      '- Phoenix application runtime',
      '- Browser and Playwright validation runtime',
    ].join('\n'),
  };

  artifacts['trd.md'] = {
    path: path.join(root, 'package.json'),
    evidencePath: 'package.json',
    content: [
      `# ${projectName} Repository Fallback Technical Requirements`,
      '',
      '## External Services',
      '- External Codex CLI',
      '- Claude Code runtime',
      '- Codex IDE runtime',
      '- GitHub repository',
      '- npm package registry',
      '',
      '## Observability',
      '- Audit JSONL ledgers',
      '- Pipeline progress log',
      '- Context state snapshots',
      '- Release readiness reports',
      '- Health check reports',
      '- Evaluation trace ledgers',
    ].join('\n'),
  };

  return { artifacts, sourceEvidence };
}

// ── Brownfield source loaders ───────────────────────────────────────────────
//
// Brownfield artifacts split into two cohorts:
//
//   AS-IS (current state)   — outputs of the discovery / inventory / scan
//                             agents. Every entry describes facts the agents
//                             observed in the actual source tree. Safe to
//                             treat as evidence for "what does this codebase
//                             look like today".
//
//   TO-BE (target state)    — modernization plan markdown. Hypothetical
//                             redesign generated by the brownfield planner.
//                             MUST NOT feed current-state diagrams; doing so
//                             produces fictional architectures (e.g., a
//                             desktop markdown viewer rendered as an
//                             enterprise AI gateway). Allowed only when the
//                             caller asks for state=target/composite.
//
// The buildGraphForState caller passes the state so we admit only the
// cohort relevant to the requested view. state === null|'current' returns
// AS-IS only; state === 'target' returns TO-BE only; state === 'composite'
// or 'both' or 'delta' returns both because the caller is computing a
// transition.

const BROWNFIELD_AS_IS_ARTIFACTS = [
  '00-source-file-manifest.json',
  '04-feature-and-module-inventory.md',
  '05-database-and-data-store-report.md',
  '06-integration-map.md',
  '12-security-and-quality-assessment.md',
  '16-issues-registry.json',
  '19-evidence-index.json',
  '23-master-assessment.md',
];

const BROWNFIELD_TO_BE_ARTIFACTS = [
  '27-modernization-system-architecture.md',
  '30-modernization-api-contracts.md',
  '39-modernization-delivery-plan.md',
];

function brownfieldArtifactNamesForState(state) {
  if (state === 'target') return BROWNFIELD_TO_BE_ARTIFACTS.slice();
  if (state === 'composite' || state === 'both' || state === 'delta') {
    return [...BROWNFIELD_AS_IS_ARTIFACTS, ...BROWNFIELD_TO_BE_ARTIFACTS];
  }
  // Default (state === null | undefined | 'current') — AS-IS only. This is
  // the precise leak fix: stops modernization-* artifacts from feeding
  // current-state diagrams.
  return BROWNFIELD_AS_IS_ARTIFACTS.slice();
}

function loadBrownfieldArtifacts(projectRoot, state = null) {
  const bf = path.join(outputRoot(projectRoot), 'brownfield');
  const names = brownfieldArtifactNamesForState(state);
  const artifacts = {};
  const sourceEvidence = [];
  for (const n of names) {
    const p = path.join(bf, n);
    const content = readText(p);
    if (content) {
      const isJson = n.endsWith('.json');
      const entry = { path: p, content, evidencePath: `_cobolt-output/latest/brownfield/${n}` };
      if (isJson) {
        try {
          entry.data = JSON.parse(content);
        } catch {
          entry.data = null;
        }
      }
      artifacts[n] = entry;
      sourceEvidence.push({
        path: `_cobolt-output/latest/brownfield/${n}`,
        kind: isJson ? 'json' : 'markdown',
        bytes: content.length,
        sha256: sha256(content),
      });
    }
  }
  return { artifacts, sourceEvidence };
}

// ── Entity extractors ───────────────────────────────────────────────────────

function _addEvidence(node, artifactKey, summary) {
  node.evidence = node.evidence || [];
  if (artifactKey) node.evidence.push({ path: `_cobolt-output/.../${artifactKey}`, summary: summary || '' });
  return node;
}

function leadingName(raw) {
  const clean = String(raw || '')
    .replace(/[`*]/g, '')
    .trim();
  const colon = clean.indexOf(':');
  if (colon > 0 && colon < 120) return clean.slice(0, colon).trim();
  return clean.split(/\s+(?:--|-|->|=>)\s+/)[0].trim();
}

function extractActors(artifacts, state) {
  const actors = [];
  const prd = artifacts['prd.md']?.content || '';
  const roleSection = extractSection(prd, 'personas|actors|users|user roles');
  const roleCandidates = [...extractSubheadings(roleSection), ...extractBullets(roleSection)];
  for (const b of roleCandidates) {
    const name = cleanExtractedName(b.split(/[—:-]/)[0]);
    if (!name || name.length > 80) continue;
    actors.push({
      id: sanitizeId(name, 'actor'),
      type: 'actor',
      name,
      state,
      confidence: 'confirmed',
      evidence: [artifactEvidence(artifacts, 'prd.md', 'Derived from PRD personas / user roles section')],
    });
  }
  return dedupeById(actors);
}

const CAPABILITY_DOMAIN_DEFINITIONS = [
  {
    id: 'access',
    name: 'User and Admin Experience',
    group: 'Experience',
    rx: /admin|dashboard|operator|developer|sdk|cli|user|persona|liveview|command|experience/i,
  },
  {
    id: 'orchestration',
    name: 'Agent Gateway and Orchestration',
    group: 'Core Platform',
    rx: /gateway|runtime|openai|chat|completion|embedding|route|workflow|agent|orchestrat|stream|request/i,
  },
  {
    id: 'integration',
    name: 'Provider and MCP Integration',
    group: 'Integration',
    rx: /provider|mcp|connector|integration|tool|llm|model catalog|model intake|storage|rag|webhook/i,
  },
  {
    id: 'security',
    name: 'Policy and Security Governance',
    group: 'Governance',
    rx: /policy|identity|rbac|redaction|scanner|guardrail|trust|lease|kill|security|compliance|approval|auth/i,
  },
  {
    id: 'data',
    name: 'State and Evidence Data',
    group: 'Data',
    rx: /data|state|postgres|rocksdb|mnesia|backup|restore|retention|audit event|evidence export|record|store/i,
  },
  {
    id: 'operations',
    name: 'Operations and Observability',
    group: 'Operations',
    rx: /observability|telemetry|metric|trace|log|cost|billing|incident|slo|sla|health|audit evidence|evidence bundle/i,
  },
  {
    id: 'delivery',
    name: 'Deployment and Release Management',
    group: 'Delivery',
    rx: /deploy|release|canary|rollback|environment|promotion|feature flag|tenant lifecycle|rollout|delivery/i,
  },
];

const CAPABILITY_CONTEXT_HINTS = {
  gateway: 'orchestration',
  'control-plane': 'access',
  control: 'access',
  identity: 'security',
  'policy-engine': 'security',
  policy: 'security',
  integrations: 'integration',
  integration: 'integration',
  audit: 'operations',
  observability: 'operations',
  billing: 'operations',
  data: 'data',
  delivery: 'delivery',
};

const CAPABILITY_DOMAIN_RELATIONSHIPS = [
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

function featureCapabilityId(feature) {
  return String(feature?.featureId || feature?.id || feature?.frId || '').trim();
}

function featureCapabilityName(feature) {
  return cleanExtractedName(feature?.title || feature?.name || feature?.summary || featureCapabilityId(feature));
}

function featureCapabilityText(feature) {
  return [
    featureCapabilityId(feature),
    featureCapabilityName(feature),
    feature?.description,
    feature?.boundedContext,
    feature?.scopeTier,
    feature?.priority,
    Array.isArray(feature?.prdFrs) ? feature.prdFrs.join(' ') : '',
    Array.isArray(feature?.sourceIds) ? feature.sourceIds.join(' ') : '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function classifyFeatureCapability(feature) {
  const text = featureCapabilityText(feature);
  const matches = CAPABILITY_DOMAIN_DEFINITIONS.filter((domain) => domain.rx.test(text)).map((domain) => domain.id);
  const context = String(feature?.boundedContext || '').toLowerCase();
  const contextHint = CAPABILITY_CONTEXT_HINTS[context];
  if (contextHint && !matches.includes(contextHint)) matches.push(contextHint);
  return matches.length ? matches : ['orchestration'];
}

function extractCapabilities(artifacts, state) {
  const features = artifacts['feature-registry.json']?.data;
  const out = [];
  if (features && Array.isArray(features.features)) {
    const buckets = new Map(CAPABILITY_DOMAIN_DEFINITIONS.map((domain) => [domain.id, { domain, features: [] }]));
    for (const f of features.features) {
      const featureId = featureCapabilityId(f);
      const featureName = featureCapabilityName(f);
      if (!featureId && !featureName) continue;
      for (const domainId of classifyFeatureCapability(f)) {
        const bucket = buckets.get(domainId);
        if (bucket) bucket.features.push({ id: featureId || featureName, name: featureName || featureId });
      }
    }
    for (const { domain, features: bucketFeatures } of buckets.values()) {
      if (!bucketFeatures.length) continue;
      const refs = bucketFeatures
        .map((f) => f.id)
        .filter(Boolean)
        .slice(0, 12);
      out.push({
        id: `capability-${domain.id}`,
        type: 'capability',
        name: domain.name,
        group: domain.group,
        description: `${bucketFeatures.length} source-backed feature${bucketFeatures.length === 1 ? '' : 's'} mapped to this capability domain.`,
        featureRefs: refs,
        state,
        confidence: 'confirmed',
        evidence: [
          artifactEvidence(
            artifacts,
            'feature-registry.json',
            `Feature registry capability domain (${bucketFeatures.length} source-backed features)`,
          ),
        ],
      });
    }
  }
  if (!out.length) {
    const prd = artifacts['prd.md']?.content || '';
    const featuresSection = extractSection(prd, 'features|capabilities|functional requirements');
    for (const row of extractTables(featuresSection).flatMap((t) => t.rows)) {
      const name = row.feature || row.capability || row.name || row.title || row.requirement || '';
      if (!name || name.length > 120) continue;
      out.push({
        id: sanitizeId(name, 'cap'),
        type: 'capability',
        name,
        state,
        confidence: 'inferred',
        inferredFrom: 'PRD table row — no feature-registry.json available',
        evidence: [artifactEvidence(artifacts, 'prd.md', 'Derived from PRD features table')],
      });
    }
    for (const b of extractBullets(featuresSection)) {
      const name = leadingName(b);
      if (!name || name.length > 120) continue;
      out.push({
        id: sanitizeId(name, 'cap'),
        type: 'capability',
        name,
        description: b,
        state,
        confidence: 'inferred',
        inferredFrom: 'PRD feature bullet with no feature-registry.json available',
        evidence: [artifactEvidence(artifacts, 'prd.md', 'Derived from PRD features bullet')],
      });
    }
  }
  return dedupeById(out);
}

function extractComponents(artifacts, state) {
  const out = [];
  const archKey = artifacts['architecture.md'] ? 'architecture.md' : 'system-architecture.md';
  const arch = artifacts['architecture.md']?.content || artifacts['system-architecture.md']?.content || '';
  const componentsSection = extractSection(arch, 'components|services|modules|subsystems');
  for (const t of extractTables(componentsSection)) {
    for (const row of t.rows) {
      const name = cleanExtractedName(row.component || row.service || row.module || row.name || row.subsystem || '');
      if (!isUsefulExtractedName(name) || name.length > 120) continue;
      out.push({
        id: sanitizeId(name, 'component'),
        type: 'component',
        name,
        description: row.description || row.purpose || '',
        owner: row.owner || row.team || '',
        state,
        confidence: 'confirmed',
        evidence: [artifactEvidence(artifacts, archKey, 'Architecture components table')],
      });
    }
  }
  for (const b of extractBullets(componentsSection)) {
    const name = b.split(/[—:-]/)[0].trim().replace(/[`*]/g, '');
    if (!name || name.length > 80) continue;
    out.push({
      id: sanitizeId(name, 'component'),
      type: 'component',
      name,
      state,
      confidence: 'confirmed',
      evidence: [artifactEvidence(artifacts, archKey, 'Architecture components section')],
    });
  }
  if (!out.length) {
    const bfInv = artifacts['04-feature-and-module-inventory.md']?.content || '';
    const mods = extractBullets(extractSection(bfInv, 'modules|components'));
    for (const b of mods) {
      const name = b.split(/[—:-]/)[0].trim();
      if (!name || name.length > 80) continue;
      out.push({
        id: sanitizeId(name, 'component'),
        type: 'component',
        name,
        state,
        confidence: 'inferred',
        inferredFrom: 'Brownfield module inventory',
        evidence: [artifactEvidence(artifacts, '04-feature-and-module-inventory.md', 'Module inventory entry')],
      });
    }
  }
  return dedupeById(out);
}

function extractDataEntities(artifacts, state) {
  const out = [];
  const data = artifacts['data-model-spec.md']?.content || '';
  const entitiesSection = extractSection(data, 'entities|tables|data model|schema');
  for (const b of extractBullets(entitiesSection)) {
    const name = b.split(/[—:-]/)[0].trim().replace(/[`*]/g, '');
    if (!name || name.length > 80) continue;
    out.push({
      id: sanitizeId(name, 'entity'),
      type: 'dataEntity',
      name,
      state,
      confidence: 'confirmed',
      evidence: [artifactEvidence(artifacts, 'data-model-spec.md', 'Entity bullet')],
    });
  }
  for (const t of extractTables(entitiesSection || data)) {
    for (const row of t.rows) {
      const name = row.entity || row.table || row.name || '';
      if (!name || name.length > 80) continue;
      out.push({
        id: sanitizeId(name, 'entity'),
        type: 'dataEntity',
        name,
        description: row.description || '',
        state,
        confidence: 'confirmed',
        evidence: [artifactEvidence(artifacts, 'data-model-spec.md', 'Entity table row')],
      });
    }
  }
  if (!out.length) {
    const bfDb = artifacts['05-database-and-data-store-report.md']?.content || '';
    const bfEntities = extractBullets(extractSection(bfDb, 'tables|entities|collections'));
    for (const b of bfEntities) {
      const name = b.split(/[—:-]/)[0].trim();
      if (!name || name.length > 80) continue;
      out.push({
        id: sanitizeId(name, 'entity'),
        type: 'dataEntity',
        name,
        state,
        confidence: 'inferred',
        inferredFrom: 'Brownfield database report',
        evidence: [artifactEvidence(artifacts, '05-database-and-data-store-report.md', 'DB report entry')],
      });
    }
  }
  return dedupeById(out);
}

function extractApis(artifacts, state) {
  const out = [];
  const api = artifacts['api-contracts.md']?.content || artifacts['30-modernization-api-contracts.md']?.content || '';
  const endpoints = [...api.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+([/\w:{}-]+)/g)];
  for (const m of endpoints) {
    const method = m[1];
    const route = m[2];
    out.push({
      id: sanitizeId(`${method}-${route}`, 'api'),
      type: 'api',
      name: `${method} ${route}`,
      state,
      confidence: 'confirmed',
      evidence: [artifactEvidence(artifacts, 'api-contracts.md', 'Endpoint declaration')],
    });
  }
  const commandSection = extractSection(api, 'commands|cli|public workflows');
  for (const b of extractBullets(commandSection)) {
    const cleaned = String(b || '')
      .replace(/[`*]/g, '')
      .trim();
    const colon = cleaned.indexOf(':');
    const name = colon > 0 ? cleaned.slice(0, colon).trim() : leadingName(cleaned);
    if (!name || name.length > 120) continue;
    out.push({
      id: sanitizeId(name, 'api'),
      type: 'api',
      name,
      protocol: 'cli',
      description: cleaned,
      state,
      confidence: 'confirmed',
      evidence: [artifactEvidence(artifacts, 'api-contracts.md', 'CLI command declaration')],
    });
  }
  return dedupeById(out);
}

function extractIntegrations(artifacts, state) {
  const out = [];
  const imap = artifacts['06-integration-map.md']?.content || '';
  for (const b of extractBullets(extractSection(imap, 'integrations|external systems|third-party'))) {
    const name = b.split(/[—:-]/)[0].trim();
    if (!name || name.length > 80) continue;
    out.push({
      id: sanitizeId(name, 'integ'),
      type: 'integration',
      name,
      state,
      confidence: 'inferred',
      inferredFrom: 'Brownfield integration map',
      evidence: [artifactEvidence(artifacts, '06-integration-map.md', 'Integration entry')],
    });
  }
  const trd = artifacts['trd.md']?.content || '';
  for (const b of extractBullets(extractSection(trd, 'external services|third-party|integrations|dependencies'))) {
    const name = b.split(/[—:-]/)[0].trim();
    if (!name || name.length > 80) continue;
    out.push({
      id: sanitizeId(name, 'integ'),
      type: 'integration',
      name,
      state,
      confidence: 'confirmed',
      evidence: [artifactEvidence(artifacts, 'trd.md', 'External dependency entry')],
    });
  }
  return dedupeById(out);
}

function extractSecurityControls(artifacts, state) {
  const out = [];
  const sec = artifacts['security-requirements.md']?.content || '';
  const pushControl = (name, summary) => {
    if (!isUsefulExtractedName(name) || name.length > 120) return;
    out.push({
      id: sanitizeId(name, 'sec'),
      type: 'securityControl',
      name,
      state,
      confidence: 'confirmed',
      evidence: [artifactEvidence(artifacts, 'security-requirements.md', summary)],
    });
  };
  const controls = extractSection(sec, 'controls|authentication|authorization|encryption|audit');
  for (const b of extractBullets(controls)) {
    const name = cleanExtractedName(b.split(/[—:-]/)[0]);
    pushControl(name, 'Control bullet');
  }
  for (const b of extractBullets(sec)) {
    const name = cleanExtractedName(b.split(/[—:-]/)[0]);
    if (
      !/deny|allow|enforce|require|reject|block|scan|audit|policy|trust|egress|approval|lease|scanner|guardrail|degradation|kill|containment/i.test(
        name,
      )
    ) {
      continue;
    }
    pushControl(name, 'Security action bullet');
  }
  for (const heading of extractHeadings(sec, 2, 4)) {
    const name = cleanExtractedName(heading);
    if (
      !/security|policy|firewall|egress|trust|scanner|guardrail|degradation|audit|lease|verification|red.?team|kill|containment|identity|access|enforcement/i.test(
        name,
      )
    ) {
      continue;
    }
    pushControl(name, 'Security heading');
  }
  return dedupeById(out);
}

function extractTrustBoundaries(artifacts, state) {
  const out = [];
  const sec = artifacts['security-requirements.md']?.content || '';
  const boundaries = extractSection(sec, 'trust boundaries|network zones|trust zones');
  for (const b of extractBullets(boundaries)) {
    const name = b.split(/[—:-]/)[0].trim();
    if (!name || name.length > 80) continue;
    out.push({
      id: sanitizeId(name, 'tb'),
      type: 'trustBoundary',
      name,
      state,
      confidence: 'inferred',
      evidence: [artifactEvidence(artifacts, 'security-requirements.md', 'Trust boundary bullet')],
    });
  }
  if (!out.length) {
    // Fallback: synthesize two canonical boundaries so SEC-001 is never empty.
    // Each carries an explicit synthesized-evidence marker so the strict
    // evidence census recognizes the node as deliberate synthesis (not a
    // missing-citation bug). The marker is namespaced under "synthesized:"
    // to avoid collision with real source-tree paths.
    const synthesizedEvidence = [
      {
        path: 'synthesized:default-trust-boundary',
        summary: 'Synthesized fallback — no explicit trust-boundary section in artifacts',
      },
    ];
    out.push(
      {
        id: 'tb-external',
        type: 'trustBoundary',
        name: 'External / Internet',
        state,
        confidence: 'inferred',
        inferredFrom: 'Default boundary (no explicit trust-boundary section found)',
        evidence: synthesizedEvidence,
      },
      {
        id: 'tb-internal',
        type: 'trustBoundary',
        name: 'Internal / Application',
        state,
        confidence: 'inferred',
        inferredFrom: 'Default boundary (no explicit trust-boundary section found)',
        evidence: synthesizedEvidence,
      },
    );
  }
  return dedupeById(out);
}

function pushExtractedPlatformNode(out, artifacts, state, name, summary = 'Runtime target entry') {
  const clean = cleanExtractedName(name);
  if (!clean || clean.length > 90) return;
  if (out.some((node) => node.name.toLowerCase() === clean.toLowerCase())) return;
  out.push({
    id: sanitizeId(clean, 'plat'),
    type: 'platformNode',
    name: clean,
    state,
    confidence: 'confirmed',
    evidence: [artifactEvidence(artifacts, 'delivery-plan.md', summary)],
  });
}

function deploymentModeNamesFromText(text) {
  const source = String(text || '');
  const modes = [];
  const add = (rx, name) => {
    if (rx.test(source) && !modes.includes(name)) modes.push(name);
  };
  add(/single[-\s]?tenant\s+on[-\s]?prem/i, 'Single-Tenant On-Prem');
  add(/customer[-\s]?(?:managed\s+)?cloud/i, 'Customer-Managed Cloud');
  add(/\bhybrid\b/i, 'Hybrid Deployment');
  add(/\bsaas\b|managed\s+saas/i, 'SaaS Deployment');
  add(/\bkubernetes\b|\bhelm\b/i, 'Kubernetes / Helm Runtime');
  add(/docker\s+compose/i, 'Docker Compose Dev Runtime');
  add(/postgres\s+ha/i, 'Postgres HA Runtime');
  add(/identity provider|idp/i, 'Identity Provider Sandbox');
  add(/canary[-\s]?per[-\s]?region|weighted\s+ramp|per[-\s]?region/i, 'Regional Canary Runtime');
  return modes;
}

function extractPlatformNodes(artifacts, state) {
  const out = [];
  const delivery = artifacts['delivery-plan.md']?.content || '';
  for (const b of extractBullets(
    extractSection(
      delivery,
      'runtime|platform|environments?|environment promotion|deployment targets|release strategy',
    ),
  )) {
    const name = b.split(/[—:-]/)[0].trim();
    const cleanName = cleanExtractedName(name);
    if (!cleanName || cleanName.length > 80) continue;
    if (/^(dev|staging|preprod|production|prod)\b/i.test(cleanName)) continue;
    if (
      !/kubernetes|helm|docker|compose|postgres|identity provider|idp|on-prem|cloud|hybrid|saas|canary|region/i.test(
        cleanName,
      )
    )
      continue;
    out.push({
      id: sanitizeId(cleanName, 'plat'),
      type: 'platformNode',
      name: cleanName,
      state,
      confidence: 'confirmed',
      evidence: [artifactEvidence(artifacts, 'delivery-plan.md', 'Runtime target entry')],
    });
  }
  for (const name of deploymentModeNamesFromText(delivery)) {
    pushExtractedPlatformNode(out, artifacts, state, name, 'Deployment platform inferred from delivery plan');
  }
  return dedupeById(out);
}

function extractDeliveryFlow(artifacts, state) {
  const delivery = artifacts['delivery-plan.md']?.content || '';
  const nodes = [];
  const edges = [];
  const seen = new Set();
  const pushNode = (name, type, summary, tags = []) => {
    const clean = String(name || '')
      .replace(/[`*]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean || clean.length > 120) return null;
    const id = sanitizeId(clean, type === 'platformNode' ? 'plat' : 'env');
    if (!seen.has(id)) {
      nodes.push({
        id,
        type,
        name: clean,
        state,
        confidence: 'confirmed',
        tags,
        evidence: [artifactEvidence(artifacts, 'delivery-plan.md', summary)],
      });
      seen.add(id);
    }
    return id;
  };
  const pushEdge = (from, to, label, summary) => {
    if (!from || !to || from === to) return;
    edges.push({
      from,
      to,
      kind: 'deploys-to',
      confidence: 'confirmed',
      label,
      evidence: [artifactEvidence(artifacts, 'delivery-plan.md', summary)],
    });
  };

  const releaseSignals =
    /release|rollout|promotion|environment|deployment|staging|prod|production|design-partner/i.test(delivery);
  const releaseSequence = [];
  if (/internal|design-partner/i.test(delivery))
    releaseSequence.push(
      pushNode('Internal / Design Partner', 'deploymentEnvironment', 'Release environment', ['release-env']),
    );
  if (/\bstaging\b/i.test(delivery))
    releaseSequence.push(pushNode('Staging', 'deploymentEnvironment', 'Release environment', ['release-env']));
  if (/\bprod\b|\bproduction\b/i.test(delivery))
    releaseSequence.push(pushNode('Production', 'deploymentEnvironment', 'Release environment', ['release-env']));
  if (releaseSignals && releaseSequence.length < 2) {
    releaseSequence.push(
      pushNode('Release Candidate', 'deploymentEnvironment', 'Release environment', ['release-env']),
    );
    releaseSequence.push(pushNode('Production', 'deploymentEnvironment', 'Release environment', ['release-env']));
  }
  for (let i = 0; i < releaseSequence.length - 1; i += 1) {
    pushEdge(releaseSequence[i], releaseSequence[i + 1], 'promotes to', 'Release promotion sequence');
  }

  const phases = [];
  for (const m of delivery.matchAll(/^##\s+(Phase\s+\d+\s*[:-]\s*[^\n]+)$/gim)) {
    phases.push(pushNode(m[1], 'deploymentEnvironment', 'Implementation roadmap phase', ['release-phase']));
  }
  for (let i = 0; i < phases.length - 1; i += 1)
    pushEdge(phases[i], phases[i + 1], 'next phase', 'Roadmap phase sequence');

  const modes = [];
  for (const m of delivery.matchAll(/^##\s+(?:Mode\s+\d+\s*[-–]\s*)?([^\n]+)$/gim)) {
    const name = m[1].trim();
    if (!/on-prem|customer cloud|hybrid|managed saas|single-tenant|multi-tenant/i.test(name)) continue;
    modes.push(pushNode(name, 'platformNode', 'Deployment mode', ['deployment-mode']));
  }
  for (const name of deploymentModeNamesFromText(delivery)) {
    modes.push(pushNode(name, 'platformNode', 'Deployment mode', ['deployment-mode']));
  }
  for (const mode of modes) {
    const target = releaseSequence[releaseSequence.length - 1] || phases[phases.length - 1];
    pushEdge(target, mode, 'deploys as', 'Deployment topology target');
  }
  return { nodes: dedupeById(nodes), edges: mergeEdges(edges) };
}

function extractOpsSignals(artifacts, state) {
  const out = [];
  const trd = artifacts['trd.md']?.content || '';
  for (const b of extractBullets(extractSection(trd, 'observability|monitoring|alerts|metrics|logging'))) {
    const name = b.split(/[—:-]/)[0].trim();
    if (!name || name.length > 80) continue;
    out.push({
      id: sanitizeId(name, 'ops'),
      type: 'operationalSignal',
      name,
      state,
      confidence: 'confirmed',
      evidence: [artifactEvidence(artifacts, 'trd.md', 'Operational signal entry')],
    });
  }
  return dedupeById(out);
}

function classifyMermaidNode(label) {
  const s = String(label || '').toLowerCase();
  if (/client|admin|operator|user|automation|application developer|platform engineer|security engineer/.test(s))
    return 'actor';
  if (
    /llm provider|provider|mcp server|tool server|external|agent runtime|third-party|siem|warehouse|data lake/.test(s)
  )
    return 'integration';
  if (
    /postgres|rocksdb|mnesia|amnesia|opensearch|vector|rag|object storage|lakehouse|parquet|database|indexes|rollups/.test(
      s,
    )
  )
    return 'dataStore';
  if (/metrics|traces|audit|telemetry|cost event|observability|logs|loki|tempo|victoria/.test(s))
    return 'operationalSignal';
  if (/policy|security|firewall|redaction|guardrail|presidio|identity|access|auth|kill-switch/.test(s))
    return 'securityControl';
  return 'component';
}

function graphNodeFromMermaid(alias, label, artifacts, key, state) {
  const type = classifyMermaidNode(label);
  const prefix =
    {
      actor: 'actor',
      integration: 'integ',
      dataStore: 'store',
      operationalSignal: 'ops',
      securityControl: 'sec',
      component: 'component',
    }[type] || 'component';
  return {
    id: sanitizeId(label || alias, prefix),
    type,
    name: label || alias,
    state,
    confidence: 'confirmed',
    evidence: [artifactEvidence(artifacts, key, 'Mermaid architecture diagram node')],
  };
}

function parseMermaidLabel(raw) {
  let text = String(raw || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (let i = 0; i < 4; i += 1) {
    const next = text
      .replace(/^\[\s*([\s\S]*?)\s*\]$/, '$1')
      .replace(/^\(\s*([\s\S]*?)\s*\)$/, '$1')
      .replace(/^\{\{\s*([\s\S]*?)\s*\}\}$/, '$1')
      .replace(/^["'`]\s*([\s\S]*?)\s*["'`]$/, '$1')
      .trim();
    if (next === text) break;
    text = next;
  }
  return text;
}

function parseMermaidEdges(src) {
  const edges = [];
  const nodeDefInlineRx = /\b([A-Za-z][\w-]*)\s*(?:\[[^\]]+\]|\([^)]+\)|\{\{[^}]+\}\})/g;
  for (const rawLine of String(src || '').split(/\r?\n/)) {
    const line = rawLine.replace(/%%.*$/, '').trim();
    if (!line || /^(flowchart|graph|subgraph|end\b|classDef|class\s+)/i.test(line)) continue;
    const compact = line.replace(nodeDefInlineRx, '$1');
    let m =
      compact.match(/^\s*([A-Za-z][\w-]*)\s*-->\|([^|]+)\|\s*([A-Za-z][\w-]*)/) ||
      compact.match(/^\s*([A-Za-z][\w-]*)\s*--\|([^|]+)\|\s*([A-Za-z][\w-]*)/) ||
      compact.match(/^\s*([A-Za-z][\w-]*)\s*-\.\s*"([^"]+)"\s*\.->\s*([A-Za-z][\w-]*)/) ||
      compact.match(/^\s*([A-Za-z][\w-]*)\s*--\s*([^->]+?)\s*-->\s*([A-Za-z][\w-]*)/);
    if (m) {
      edges.push({ from: m[1], to: m[3], label: parseMermaidLabel(m[2]) || 'flows to' });
      continue;
    }
    m = compact.match(/^\s*([A-Za-z][\w-]*)\s*(?:-->|-\.[^>]*->|==>|--[^>]*>)\s*([A-Za-z][\w-]*)/);
    if (m) edges.push({ from: m[1], to: m[2], label: 'flows to' });
  }
  return edges;
}

function extractMermaidFlowchartGraph(artifacts, state) {
  const nodesByAlias = new Map();
  const nodesById = new Map();
  const edges = [];
  const seenEdges = new Set();
  const keys = ['architecture.md', 'system-architecture.md', 'api-contracts.md', 'trd.md'];
  const nodeDefRx =
    /\b([A-Za-z][\w-]*)\s*(?:\[\s*"([^"]+)"\s*\]|\[\s*([^\]]+?)\s*\]|\(\s*"([^"]+)"\s*\)|\(\s*([^)]+?)\s*\)|\{\{\s*"([^"]+)"\s*\}\}|\{\{\s*([^}]+?)\s*\}\})/g;
  for (const key of keys) {
    const content = artifacts[key]?.content || '';
    for (const block of content.matchAll(/```mermaid\s+([\s\S]*?)```/gi)) {
      const src = block[1] || '';
      if (!/^\s*(flowchart|graph)\s+/i.test(src)) continue;
      let m;
      nodeDefRx.lastIndex = 0;
      while ((m = nodeDefRx.exec(src)) !== null) {
        const alias = m[1];
        const label = parseMermaidLabel(m[2] || m[3] || m[4] || m[5] || m[6] || m[7] || alias);
        const node = graphNodeFromMermaid(alias, label, artifacts, key, state);
        nodesByAlias.set(alias, node);
        if (!nodesById.has(node.id)) nodesById.set(node.id, node);
      }
      for (const parsedEdge of parseMermaidEdges(src)) {
        const fromAlias = parsedEdge.from;
        const toAlias = parsedEdge.to;
        const from = nodesByAlias.get(fromAlias) || graphNodeFromMermaid(fromAlias, fromAlias, artifacts, key, state);
        const to = nodesByAlias.get(toAlias) || graphNodeFromMermaid(toAlias, toAlias, artifacts, key, state);
        nodesByAlias.set(fromAlias, from);
        nodesByAlias.set(toAlias, to);
        if (!nodesById.has(from.id)) nodesById.set(from.id, from);
        if (!nodesById.has(to.id)) nodesById.set(to.id, to);
        const edgeKey = `${from.id}::${to.id}::calls`;
        if (seenEdges.has(edgeKey)) continue;
        seenEdges.add(edgeKey);
        edges.push({
          from: from.id,
          to: to.id,
          kind: classifyMermaidNode(to.name) === 'dataStore' ? 'writes' : 'calls',
          confidence: 'confirmed',
          label: parsedEdge.label || 'flows to',
          evidence: [artifactEvidence(artifacts, key, 'Mermaid architecture diagram edge')],
        });
      }
    }
  }
  return { nodes: [...nodesById.values()], edges };
}

// ── Tech-stack fallback (fires when planning artifacts are absent) ─────────
//
// When `_cobolt-output/latest/planning/` is empty (common when a user runs
// `arch` from their project root without having run `cobolt-plan` first),
// the planning-side extractors produce essentially 0 nodes. Instead of
// emitting empty diagrams, we synthesize nodes from the already-built
// tech-stack detector (lib/cobolt-arch-tech-stack.js) which reads package.json,
// docker-compose, infra-manifest, language manifests, etc. Every fallback
// node carries `confidence: 'inferred'` + `inferredFrom: 'tech-stack:<source>'`
// so provenance stays transparent.

const TECH_STACK_TYPE_MAP = {
  languages: 'component',
  frameworks: 'component',
  databases: 'dataStore',
  queues: 'integration',
  clouds: 'platformNode',
  cdns: 'platformNode',
  auth: 'securityControl',
  payments: 'integration',
  comms: 'integration',
  observability: 'operationalSignal',
  ai: 'integration',
  search: 'dataStore',
  containers: 'platformNode',
  cicd: 'platformNode',
  testing: 'operationalSignal',
  integrations: 'integration',
};

const ID_PREFIX_FOR_TYPE = {
  component: 'component',
  dataStore: 'entity',
  integration: 'integ',
  platformNode: 'plat',
  securityControl: 'sec',
  operationalSignal: 'ops',
};

const SERVICE_LABEL_OVERRIDES = {
  aws: 'AWS',
  gcp: 'Google Cloud',
  azure: 'Azure',
  'aws-rds': 'AWS RDS',
  'aws-s3': 'AWS S3',
  'aws-lambda': 'AWS Lambda',
  'aws-dynamodb': 'AWS DynamoDB',
  'aws-sqs': 'AWS SQS',
  'aws-sns': 'AWS SNS',
  'aws-eks': 'AWS EKS',
  'aws-ecs': 'AWS ECS',
  'aws-cloudfront': 'AWS CloudFront',
  'aws-cognito': 'AWS Cognito',
  'aws-cloudwatch': 'AWS CloudWatch',
  'azure-cosmosdb': 'Azure Cosmos DB',
  'azure-storage': 'Azure Storage',
  'azure-functions': 'Azure Functions',
  'azure-aks': 'Azure AKS',
  'azure-keyvault': 'Azure Key Vault',
  'azure-entra': 'Azure Entra ID',
  'gcp-bigquery': 'Google BigQuery',
  'gcp-gcs': 'Google Cloud Storage',
  'gcp-cloud-run': 'Cloud Run',
  'gcp-gke': 'GKE',
  'gcp-pubsub': 'Pub/Sub',
  nextjs: 'Next.js',
  node: 'Node.js',
  nodejs: 'Node.js',
  'next-auth': 'NextAuth.js',
  langchain: 'LangChain',
  llamaindex: 'LlamaIndex',
  huggingface: 'Hugging Face',
  mongodb: 'MongoDB',
  postgres: 'PostgreSQL',
  clickhouse: 'ClickHouse',
  cockroachdb: 'CockroachDB',
  opentelemetry: 'OpenTelemetry',
  newrelic: 'New Relic',
  pagerduty: 'PagerDuty',
  'github-actions': 'GitHub Actions',
  'gitlab-ci': 'GitLab CI',
  circleci: 'CircleCI',
  argocd: 'Argo CD',
  dotnet: '.NET',
  solidjs: 'SolidJS',
  sveltekit: 'SvelteKit',
  typescript: 'TypeScript',
  redis: 'Redis',
  kafka: 'Apache Kafka',
  rabbitmq: 'RabbitMQ',
  auth0: 'Auth0',
  okta: 'Okta',
  workos: 'WorkOS',
};

function prettyServiceName(slug) {
  if (SERVICE_LABEL_OVERRIDES[slug]) return SERVICE_LABEL_OVERRIDES[slug];
  return String(slug || '')
    .split('-')
    .filter(Boolean)
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

function evidenceForTechSource(source, slug) {
  if (source === 'package.json') {
    return { path: 'package.json', summary: `Dependency declared as "${slug}"` };
  }
  if (source.startsWith('docker-compose')) {
    return { path: 'docker-compose.yml', summary: `Service image matched "${slug}"` };
  }
  if (source === 'infra-manifest') {
    return { path: '_cobolt-output/latest/infra/infra-manifest.json', summary: `Platform target "${slug}"` };
  }
  if (source === 'trd.md') {
    return { path: '_cobolt-output/latest/planning/trd.md', summary: `External service "${slug}"` };
  }
  if (source === 'prd.md') {
    return { path: '_cobolt-output/latest/planning/prd.md', summary: `Mentioned "${slug}"` };
  }
  if (source.includes('brownfield')) {
    return { path: source, summary: `Brownfield integration "${slug}"` };
  }
  return { path: source, summary: `Detected "${slug}" via ${source}` };
}

function extractFromTechStack(projectRoot, state, sourceEvidence) {
  let stackLib;
  try {
    stackLib = require('../lib/cobolt-arch-tech-stack');
  } catch {
    return [];
  }
  let detected;
  try {
    detected = stackLib.detect(projectRoot);
  } catch {
    return [];
  }
  // Slugs that are too generic to materialize as a standalone node when they
  // map to an off-purpose category (e.g., libraries that imply Python presence
  // but are not first-class architectural concerns themselves — bcrypt, passlib,
  // pydantic). The language slug is already emitted under `languages`; we don't
  // want duplicate "Python" nodes appearing as integration / securityControl /
  // operationalSignal.
  const NON_FIRST_CLASS_SLUGS = new Set(['python', 'node', 'go', 'java', 'ruby', 'php', 'dotnet', 'kotlin', 'rust']);

  const nodes = [];
  const seenSlugs = new Set();
  // Process language category first so a generic-language slug is allowed there
  // and suppressed everywhere else.
  const orderedCategories = ['languages', ...Object.keys(detected.categories || {}).filter((c) => c !== 'languages')];
  for (const category of orderedCategories) {
    const entries = detected.categories?.[category];
    if (!Array.isArray(entries)) continue;
    const nodeType = TECH_STACK_TYPE_MAP[category] || 'component';
    const prefix = ID_PREFIX_FOR_TYPE[nodeType] || 'component';
    for (const entry of entries) {
      // Suppress duplicate emission of generic-language slugs across categories.
      if (NON_FIRST_CLASS_SLUGS.has(entry.slug) && seenSlugs.has(entry.slug)) continue;
      seenSlugs.add(entry.slug);
      const evidence = (entry.sources || []).slice(0, 4).map((s) => evidenceForTechSource(s, entry.slug));
      const sources = (entry.sources || []).join(', ');
      nodes.push({
        id: sanitizeId(entry.slug, prefix),
        type: nodeType,
        name: prettyServiceName(entry.slug),
        state,
        confidence: 'inferred',
        inferredFrom: `tech-stack:${sources}`,
        evidence,
      });
    }
  }
  // If we had no sourceEvidence yet but tech-stack produced nodes, record the
  // source files that drove detection so downstream reports aren't "no evidence".
  if (nodes.length > 0 && sourceEvidence.length === 0) {
    const absRoot = path.resolve(projectRoot || process.cwd());
    for (const rel of [
      'package.json',
      'docker-compose.yml',
      'docker-compose.yaml',
      '_cobolt-output/latest/infra/infra-manifest.json',
    ]) {
      const raw = readText(path.join(absRoot, rel));
      if (raw) {
        sourceEvidence.push({
          path: rel,
          kind: rel.endsWith('.json') ? 'json' : rel.match(/\.ya?ml$/) ? 'yaml' : 'markdown',
          bytes: raw.length,
          sha256: sha256(raw),
        });
      }
    }
  }
  return nodes;
}

// Source-manifest fallback: synthesize components/APIs/data-entities from
// the project's actual file layout when planning/brownfield documentation is
// absent. Reads `00-source-file-manifest.json` if present (brownfield builds
// it deterministically) and otherwise falls back to a shallow scan of the
// project root. This is the difference between a 4-node graph and a graph
// that reflects what the codebase actually contains.
//
// Heuristics target the common layouts we see in production audits:
//   - api/v1/endpoints/<group>/<endpoint>.py    → APIs grouped by <group>
//   - app/api/<group>/<endpoint>.py             → APIs grouped by <group>
//   - controllers/, routes/, handlers/          → APIs
//   - services/<name>.py                        → components
//   - workers/, jobs/, tasks/                   → components
//   - schemas/, db/models/, models/             → dataEntity per file
//   - lib/, internal/                           → components
function extractFromSourceManifest(projectRoot, state, sourceEvidence, brownfieldArtifacts) {
  const files = collectProjectFiles(projectRoot, brownfieldArtifacts);
  if (!files || files.length === 0) return [];

  const manifestPath = brownfieldArtifacts?.['00-source-file-manifest.json']?.evidencePath || 'project source tree';

  const out = [];
  const apiGroups = new Map();
  const components = new Map();
  const entities = new Map();

  // Patterns for each layer.
  const API_RX =
    /(?:^|\/)(?:api(?:\/v\d+)?\/(?:endpoints\/)?|app\/api\/|controllers?\/|routes?\/|handlers?\/|web\/handlers\/|interfaces?\/http\/)([^/]+?)(?:\/[^/]+)?\.(?:py|js|ts|go|rb|ex|exs|kt|java|cs|php)$/i;
  const SERVICE_RX =
    /(?:^|\/)(?:services?|use[_-]?cases?|usecases|application\/services)\/([^/]+?)\.(?:py|js|ts|go|rb|ex|exs)$/i;
  const WORKER_RX = /(?:^|\/)(?:workers?|jobs?|tasks?|consumers?|background)\/([^/]+?)\.(?:py|js|ts|go|rb|ex|exs)$/i;
  const ENTITY_RX =
    /(?:^|\/)(?:db\/models|models|schemas|domain\/entities|entities)\/([^/]+?)\.(?:py|js|ts|go|rb|ex|exs)$/i;
  const LIB_RX = /(?:^|\/)(?:lib|internal|pkg|core)\/([^/]+?)\.(?:py|js|ts|go|rb|ex|exs)$/i;

  for (const rel of files) {
    if (!rel || rel.includes('__pycache__') || rel.includes('node_modules')) continue;
    if (rel.includes('/tests/') || rel.includes('/test/') || /[_/.-](test|spec)\.(?:py|js|ts|go|rb|ex)$/i.test(rel)) {
      continue;
    }

    const apiMatch = rel.match(API_RX);
    if (apiMatch) {
      const group = apiMatch[1].toLowerCase();
      if (!apiGroups.has(group)) apiGroups.set(group, 0);
      apiGroups.set(group, apiGroups.get(group) + 1);
      continue;
    }

    const serviceMatch = rel.match(SERVICE_RX);
    if (serviceMatch) {
      const name = humanizeFileBase(serviceMatch[1]);
      if (name) components.set(name, rel);
      continue;
    }

    const workerMatch = rel.match(WORKER_RX);
    if (workerMatch) {
      const name = `${humanizeFileBase(workerMatch[1])} Worker`;
      if (workerMatch[1]) components.set(name, rel);
      continue;
    }

    const entityMatch = rel.match(ENTITY_RX);
    if (entityMatch) {
      const name = humanizeFileBase(entityMatch[1]);
      if (name && !/^(__init__|index|base|common|helpers?)$/i.test(entityMatch[1])) {
        entities.set(name, rel);
      }
      continue;
    }

    const libMatch = rel.match(LIB_RX);
    if (libMatch && !/^(__init__|index|utils?|helpers?|common)$/i.test(libMatch[1])) {
      const name = `${humanizeFileBase(libMatch[1])} (lib)`;
      if (!components.has(name)) components.set(name, rel);
    }
  }

  // APIs: one node per group (e.g., "Admin API", "Orders API"). Only emit if
  // the group has at least 1 file (which is implied by the entry's existence).
  for (const [group, count] of apiGroups) {
    const name = `${humanizeFileBase(group)} API`;
    out.push({
      id: sanitizeId(name, 'api'),
      type: 'api',
      name,
      description: `${count} endpoint file(s) under ${group}/`,
      state,
      confidence: 'inferred',
      inferredFrom: 'source-manifest:routes',
      evidence: [{ path: manifestPath, summary: `${count} endpoint file(s) under ${group}/` }],
    });
  }

  // Components: cap at 24 to keep diagrams readable; the rest become a single
  // "Other services" rollup so the count is preserved without flooding views.
  const compEntries = [...components.entries()].slice(0, 24);
  for (const [name, rel] of compEntries) {
    out.push({
      id: sanitizeId(name, 'component'),
      type: 'component',
      name,
      state,
      confidence: 'inferred',
      inferredFrom: 'source-manifest:services',
      evidence: [{ path: rel, summary: 'Service file detected' }],
    });
  }
  if (components.size > compEntries.length) {
    const rolled = components.size - compEntries.length;
    out.push({
      id: 'component-other-services',
      type: 'component',
      name: `+${rolled} more services`,
      state,
      confidence: 'inferred',
      inferredFrom: 'source-manifest:services-rollup',
      evidence: [{ path: manifestPath, summary: `${rolled} additional service files not shown individually` }],
    });
  }

  // Data entities: cap at 30 with rollup.
  const entityEntries = [...entities.entries()].slice(0, 30);
  for (const [name, rel] of entityEntries) {
    out.push({
      id: sanitizeId(name, 'entity'),
      type: 'dataEntity',
      name,
      state,
      confidence: 'inferred',
      inferredFrom: 'source-manifest:models',
      evidence: [{ path: rel, summary: 'Model / schema file detected' }],
    });
  }
  if (entities.size > entityEntries.length) {
    const rolled = entities.size - entityEntries.length;
    out.push({
      id: 'entity-other',
      type: 'dataEntity',
      name: `+${rolled} more entities`,
      state,
      confidence: 'inferred',
      inferredFrom: 'source-manifest:entities-rollup',
      evidence: [{ path: manifestPath, summary: `${rolled} additional model files not shown individually` }],
    });
  }

  // If we synthesized anything, record the source-file manifest as evidence.
  if (out.length && brownfieldArtifacts?.['00-source-file-manifest.json']) {
    const exists = sourceEvidence.some((s) => s.path?.endsWith('00-source-file-manifest.json'));
    if (!exists) {
      const entry = brownfieldArtifacts['00-source-file-manifest.json'];
      sourceEvidence.push({
        path: entry.evidencePath,
        kind: 'json',
        bytes: entry.content.length,
        sha256: sha256(entry.content),
      });
    }
  }

  return out;
}

function humanizeFileBase(raw) {
  const base = String(raw || '')
    .replace(/\.(py|js|ts|go|rb|ex|exs|kt|java|cs|php)$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!base) return '';
  return base
    .split(/\s+/)
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

function collectProjectFiles(projectRoot, brownfieldArtifacts) {
  // Prefer the deterministic brownfield manifest when present.
  const manifest = brownfieldArtifacts?.['00-source-file-manifest.json']?.data;
  if (manifest && Array.isArray(manifest.files)) {
    return manifest.files.map((f) => String(f).replace(/\\/g, '/'));
  }
  // Greenfield / no-manifest fallback: shallow recursive scan capped at 5000
  // entries. We only need directory shape, not contents.
  const root = path.resolve(projectRoot || process.cwd());
  const out = [];
  const skip = new Set([
    'node_modules',
    '.git',
    '__pycache__',
    'venv',
    '.venv',
    'env',
    'dist',
    'build',
    'target',
    'coverage',
    '_cobolt-output',
    '_cobolt-docker',
    '.next',
    '.nuxt',
    '.cache',
  ]);
  const walk = (dir, depth) => {
    if (out.length >= 5000 || depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (skip.has(ent.name) || ent.name.startsWith('.')) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(abs, depth + 1);
      } else if (ent.isFile()) {
        out.push(path.relative(root, abs).replace(/\\/g, '/'));
        if (out.length >= 5000) return;
      }
    }
  };
  try {
    walk(root, 0);
  } catch {
    /* ignore */
  }
  return out;
}

// ── Graph assembly ──────────────────────────────────────────────────────────

function mergeEdges(...edgeLists) {
  const out = [];
  const seen = new Set();
  for (const list of edgeLists) {
    for (const e of list || []) {
      if (!e?.from || !e?.to) continue;
      const key = `${e.from}::${e.to}::${e.kind || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

function deriveCapabilityDomainEdges(nodes) {
  const byId = new Map((nodes || []).map((node) => [node.id, node]));
  const edges = [];
  for (const [from, to, label] of CAPABILITY_DOMAIN_RELATIONSHIPS) {
    if (!byId.has(from) || !byId.has(to)) continue;
    edges.push({
      from,
      to,
      kind: 'capability-flow',
      confidence: 'confirmed',
      label,
      evidence: [{ summary: 'Feature-registry capability-domain relationship' }],
    });
  }
  return edges;
}

// Pipeline + state → evidence-mode label. Recorded on the graph so the
// validator and HTML packet can audit which cohort was admitted.
//
//   greenfield, * → planning-artifacts (validated planning docs)
//   brownfield, current → code-scan (discovery / inventory / scan outputs)
//   brownfield, target  → planning-artifacts (modernization plan = to-be spec)
//   brownfield, composite|both|delta → composite (both cohorts admitted)
function _modeForBuild(pipeline, state) {
  if (pipeline === 'brownfield') {
    if (state === 'current' || !state) return 'code-scan';
    if (state === 'target') return 'planning-artifacts';
    return 'composite';
  }
  return 'planning-artifacts';
}

function buildGraphForState(projectRoot, pipeline, state) {
  const { artifacts, sourceEvidence } =
    pipeline === 'brownfield' ? loadBrownfieldArtifacts(projectRoot, state) : loadGreenfieldArtifacts(projectRoot);

  const nodes = [];
  nodes.push(...extractActors(artifacts, state));
  nodes.push(...extractCapabilities(artifacts, state));
  nodes.push(...extractComponents(artifacts, state));
  nodes.push(...extractDataEntities(artifacts, state));
  nodes.push(...extractApis(artifacts, state));
  nodes.push(...extractIntegrations(artifacts, state));
  nodes.push(...extractSecurityControls(artifacts, state));
  nodes.push(...extractTrustBoundaries(artifacts, state));
  nodes.push(...extractPlatformNodes(artifacts, state));
  nodes.push(...extractOpsSignals(artifacts, state));
  const deliveryFlow = extractDeliveryFlow(artifacts, state);
  nodes.push(...deliveryFlow.nodes.filter((n) => !nodes.some((m) => m.id === n.id)));
  const mermaidGraph = extractMermaidFlowchartGraph(artifacts, state);
  nodes.push(...mermaidGraph.nodes.filter((n) => !nodes.some((m) => m.id === n.id)));

  // Tech-stack fallback: when planning-side extractors yielded essentially
  // nothing (<= 3 real nodes, excluding the synthesized default trust
  // boundaries), synthesize nodes from the actual project signals.
  const realNodeCount = nodes.filter(
    (n) => !(n.type === 'trustBoundary' && /Default boundary/.test(n.inferredFrom || '')),
  ).length;
  const techStackUsed = realNodeCount <= 3;
  if (techStackUsed) {
    const techStackNodes = extractFromTechStack(projectRoot, state, sourceEvidence);
    const fresh = dedupeById(techStackNodes).filter((n) => !nodes.some((m) => m.id === n.id));
    nodes.push(...fresh);
  }

  // Source-manifest fallback: when documentation extractors yielded NO APIs,
  // NO components, and NO data entities — regardless of how many platform/
  // tech-stack nodes were synthesized — derive them from the project file
  // layout. Tech-stack on its own gives only platforms ("Docker", "AWS") and
  // languages; without this extractor, every brownfield project with thin
  // documentation gets diagrams that show no application surface at all.
  const hasDocApis = nodes.some((n) => n.type === 'api');
  const hasDocComponents = nodes.some((n) => n.type === 'component' && !/^tech-stack:/.test(n.inferredFrom || ''));
  const hasDocEntities = nodes.some((n) => n.type === 'dataEntity' && !/^tech-stack:/.test(n.inferredFrom || ''));
  const sourceManifestUsed = !hasDocApis && !hasDocComponents && !hasDocEntities;
  if (sourceManifestUsed) {
    const manifestNodes = extractFromSourceManifest(projectRoot, state, sourceEvidence, artifacts);
    const fresh = dedupeById(manifestNodes).filter((n) => !nodes.some((m) => m.id === n.id));
    nodes.push(...fresh);
  }

  // ── Real semantic edge inference ────────────────────────────────────────
  // The legacy synthesizeEdges() pairs components with entities by array
  // index, producing edges that have zero semantic meaning. Replace it with
  // real code analysis: parse Python imports + FastAPI routes + ORM queries
  // + SDK client init + HTTP calls (mirror for JS/TS) to derive edges that
  // reflect actual call/data relationships in the codebase.
  let edges = mergeEdges(deliveryFlow.edges, mermaidGraph.edges);
  let edgeInferenceMeta = null;
  try {
    const inferenceLib = require('../lib/cobolt-arch-edge-inference');
    const manifestFiles = artifacts?.['00-source-file-manifest.json']?.data?.files || null;
    const result = inferenceLib.inferEdges({
      projectRoot,
      nodes,
      state,
      manifestFiles,
    });
    edges = mergeEdges(edges, result.edges);
    edgeInferenceMeta = {
      scanned: result.scanned,
      durationMs: result.durationMs,
      addedNodeCount: result.addedNodes.length,
    };
    // Merge any newly synthesized integration / datastore nodes (e.g., a
    // boto3 call that minted a new "AWS S3" node).
    if (result.addedNodes.length) {
      const existingIds = new Set(nodes.map((n) => n.id));
      for (const added of result.addedNodes) {
        if (!existingIds.has(added.id)) nodes.push(added);
      }
    }
  } catch (err) {
    // Graceful degradation — if inference throws (e.g., AST lib failure or
    // unreadable file), fall back to the actor-only synthesis so the graph
    // ships with at least one semantically meaningful edge per actor. Audit
    // log the failure so silent regressions are visible (see audit/arch-edge-inference.jsonl).
    edges = edges.length ? edges : synthesizeFallbackArchitectureEdges(nodes);
    edgeInferenceMeta = { error: String(err.message || err).slice(0, 200), fallback: 'architectureLayer' };
    appendEdgeInferenceFailure({
      reason: 'inference-threw',
      error: String(err.message || err).slice(0, 500),
      stack: err?.stack ? String(err.stack).slice(0, 800) : null,
      projectRoot,
      pipeline,
      state,
      fallbackEdgeCount: edges.length,
    });
  }
  // If real inference produced nothing (likely for codebases the inference
  // patterns don't cover — e.g., Rust, Java, C#, or pure Markdown
  // orchestration), fall back to actor-only synthesis. The previous index-
  // based component→entity pairing was removed because it produced
  // semantically-meaningless edges (component[i] → entity[i] regardless of
  // any real relationship). The actor-only fallback always preserves user→
  // entry-point edges which are universally valid; everything else stays
  // empty and the `degraded` flag below signals downstream tools to surface
  // the gap honestly.
  if (edges.length === 0) {
    edges = synthesizeFallbackArchitectureEdges(nodes);
    edgeInferenceMeta = { ...edgeInferenceMeta, fallback: 'architectureLayer', emptyInference: true };
    appendEdgeInferenceFailure({
      reason: 'inference-empty',
      projectRoot,
      pipeline,
      state,
      nodeCount: nodes.length,
      fallbackEdgeCount: edges.length,
    });
  }
  edges = mergeEdges(edges, deriveCapabilityDomainEdges(nodes));

  const gaps = computeGaps(nodes, sourceEvidence);
  const assumptions = buildAssumptions(nodes, sourceEvidence);
  if (techStackUsed) {
    assumptions.unshift(
      'Planning artifacts were absent; nodes were synthesized from the project tech stack (package.json / docker-compose / infra-manifest / language manifests). Run `cobolt plan project .` for evidence-backed diagrams.',
    );
  }
  if (sourceManifestUsed) {
    assumptions.unshift(
      'Documentation artifacts were thin; APIs / services / entities were synthesized from the project source tree (api/, services/, schemas/, models/). Run the full brownfield pipeline for confirmed nodes.',
    );
  }
  if (edgeInferenceMeta?.fallback === 'architectureLayer') {
    assumptions.unshift(
      'No source-level call/data edges were detected; relationship edges were synthesized from durable architecture layers and marked inferred. Add planning artifacts or source-level dependency evidence for confirmed edges.',
    );
  }

  // Final degraded-graph signal so downstream tools can surface this clearly
  // instead of silently shipping an empty packet.
  const finalRealNodes = nodes.filter(
    (n) => !(n.type === 'trustBoundary' && /Default boundary/.test(n.inferredFrom || '')),
  ).length;
  const degraded = finalRealNodes < 5;

  return {
    version: CANONICAL_VERSION,
    generatedAt: new Date().toISOString(),
    pipeline,
    state,
    mode: _modeForBuild(pipeline, state),
    projectRoot: path.resolve(projectRoot || process.cwd()),
    sourceEvidence,
    nodes,
    edges,
    groups: buildGroups(nodes),
    risks: [],
    assumptions,
    gaps,
    degraded,
    degradedReason: degraded
      ? `Only ${finalRealNodes} non-default nodes were extracted across all fallbacks. Diagrams will be near-empty.`
      : null,
    edgeInference: edgeInferenceMeta,
  };
}

// Fallback edge synthesizer — only used when real semantic inference fails
// or returns empty. Preserves ONLY actor → entry-point edges, which are
// universally meaningful (an actor that exists must enter the system
// somewhere). The previous `synthesizeEdges()` function paired components
// with entities by array index, producing semantically-meaningless edges
// like "component A reads entity X" purely because both happened to be
// index 0 — that index pairing has been removed because it created false
// architecture claims that no architect would recognize.
//
// Every edge here carries an explicit `evidence: []` field with a fallback
// reason so downstream validators / curators can identify synthesized vs
// real edges. The degraded flag on the graph is the authoritative signal.
function synthesizeFallbackArchitectureEdges(nodes) {
  const edges = [];
  const seen = new Set();
  const components = nodes.filter((n) => n.type === 'component');
  const apis = nodes.filter((n) => n.type === 'api');
  const actors = nodes.filter((n) => n.type === 'actor');
  const capabilities = nodes.filter((n) => n.type === 'capability');
  const entities = nodes.filter((n) => n.type === 'dataEntity' || n.type === 'dataStore');
  const integrations = nodes.filter((n) => n.type === 'integration');
  const platforms = nodes.filter((n) => n.type === 'platformNode' || n.type === 'infrastructureNode');
  const controls = nodes.filter((n) => n.type === 'securityControl' || n.type === 'trustBoundary');
  const opsSignals = nodes.filter((n) => n.type === 'operationalSignal');
  const text = (n) => `${n?.id || ''} ${n?.name || ''}`.toLowerCase();
  const has = (n, rx) => rx.test(text(n));
  const push = (from, to, kind, label, summary) => {
    if (!from?.id || !to?.id || from.id === to.id) return;
    const key = `${from.id}::${to.id}::${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({
      from: from.id,
      to: to.id,
      kind,
      confidence: 'inferred',
      label,
      evidence: [{ summary: `fallback architecture-layer synthesis: ${summary}` }],
    });
  };
  const ranked = (items, patterns, limit = 1) =>
    items
      .map((item) => {
        const hay = text(item);
        const rank = patterns.findIndex((rx) => rx.test(hay));
        return { item, rank: rank === -1 ? patterns.length : rank };
      })
      .sort((a, b) => a.rank - b.rank || String(a.item.id).localeCompare(String(b.item.id)))
      .slice(0, limit)
      .map((x) => x.item);

  const entrypoints = apis.length
    ? ranked(apis, [/cli|command|route|api|workflow|endpoint/, /public|external/], 3)
    : [];
  const primaryComponents = ranked(
    components,
    [/cli|command|controller|router|gateway|api/, /tool|engine|service|runtime|app|application/, /source|core|lib/],
    Math.min(4, Math.max(1, components.length)),
  );

  for (const actor of actors) {
    if (entrypoints.length) {
      for (const api of entrypoints)
        push(actor, api, 'calls', 'uses', 'actor enters through documented API/command surface');
    } else {
      for (const component of primaryComponents.slice(0, 1)) {
        push(actor, component, 'calls', 'uses', 'actor enters through primary application component');
      }
    }
  }

  for (const api of entrypoints) {
    for (const component of primaryComponents) {
      push(api, component, 'invokes', 'dispatches', 'API/command surface dispatches into application components');
    }
  }

  for (const capability of capabilities.slice(0, 8)) {
    const words = text(capability)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 5);
    const matched =
      components.find((component) => words.some((w) => text(component).includes(w))) ||
      primaryComponents[0] ||
      components[0];
    if (matched) push(capability, matched, 'realizes', 'realized by', 'capability is realized by application surface');
  }

  const componentTargets = primaryComponents.length ? primaryComponents : components.slice(0, 3);
  for (const component of componentTargets) {
    const localMatches = entities.filter((entity) => {
      const c = text(component);
      const e = text(entity);
      if (/artifact|output|state|report|audit|memory|schema|contract|definition|model|data/.test(e)) return true;
      return c.split(/[^a-z0-9]+/).some((w) => w.length >= 5 && e.includes(w));
    });
    for (const entity of localMatches.slice(0, 8)) {
      push(component, entity, 'reads-writes', 'manages', 'application component manages documented data artifacts');
    }
  }

  const schemaEntities = entities.filter((n) => has(n, /schema|contract/));
  const sourceEntities = entities.filter((n) => has(n, /source|definition|model/));
  const artifactEntities = entities.filter((n) => has(n, /artifact|run|report|audit|memory|pointer|state|output/));
  for (const schema of schemaEntities.slice(0, 2)) {
    for (const entity of sourceEntities.slice(0, 6)) {
      push(schema, entity, 'validates', 'validates', 'schema/contract validates source-backed artifacts');
    }
  }
  const artifactHub = artifactEntities.find((n) => has(n, /pipeline|run|artifact|output/)) || artifactEntities[0];
  if (artifactHub) {
    for (const entity of artifactEntities.filter((n) => n.id !== artifactHub.id).slice(0, 6)) {
      push(
        artifactHub,
        entity,
        'contains',
        'contains',
        'run artifact hub contains derived report/audit/memory artifacts',
      );
    }
  }

  for (const component of componentTargets) {
    const platformMatches = platforms.filter((platform) => {
      const c = text(component);
      const p = text(platform);
      if (/test|quality/.test(c)) return /browser|playwright|test/.test(p);
      if (/artifact|output|state/.test(c)) return /file|storage|artifact|filesystem/.test(p);
      if (/cli|tool|engine|service|runtime|app/.test(c)) return /node|runtime|cloud|container|platform|phoenix/.test(p);
      return /runtime|platform|filesystem/.test(p);
    });
    for (const platform of platformMatches.slice(0, 4)) {
      push(component, platform, 'runs-on', 'runs on', 'application component runs on inferred platform/runtime');
    }
  }

  for (const component of componentTargets) {
    const integrationMatches = integrations.filter((integration) => {
      const c = text(component);
      const i = text(integration);
      if (/doc|artifact|output/.test(c)) return /github|npm|registry|runtime|codex|claude/.test(i);
      if (/cli|tool|engine|service|runtime|app/.test(c)) return true;
      return /runtime|repository|registry|external/.test(i);
    });
    for (const integration of integrationMatches.slice(0, 5)) {
      push(
        component,
        integration,
        'depends-on',
        'integrates with',
        'application component integrates with external/runtime system',
      );
    }
  }

  const protectedTargets = [...entrypoints, ...componentTargets, ...entities.slice(0, 5), ...platforms.slice(0, 3)];
  for (const control of controls.slice(0, 10)) {
    const preferred = protectedTargets.find((target) => {
      const c = text(control);
      const t = text(target);
      if (/model|agent runtime|network/.test(c)) return /runtime|codex|claude|tool|api|command/.test(t);
      if (/schema|validation/.test(c)) return /schema|contract|data|artifact|source/.test(t);
      if (/path|contain|boundary|workspace/.test(c)) return /artifact|filesystem|output|workspace|platform/.test(t);
      if (/secret|dependency|release|readiness/.test(c))
        return /runtime|registry|repository|platform|component/.test(t);
      if (/pretool|posttool|gate|audit/.test(c)) return /api|command|tool|artifact|audit/.test(t);
      return false;
    });
    if (preferred)
      push(control, preferred, 'guards', 'guards', 'security control guards matching architecture surface');
  }

  const opsTargets = [
    ...componentTargets,
    ...(artifactHub ? artifactEntities.slice(0, 4) : []),
    ...platforms.slice(0, 2),
  ];
  for (const signal of opsSignals.slice(0, 8)) {
    const preferred =
      opsTargets.find((target) => {
        const o = text(signal);
        const t = text(target);
        if (/audit|ledger/.test(o)) return /audit|artifact|output|tool/.test(t);
        if (/health|readiness|release/.test(o)) return /runtime|platform|tool|report/.test(t);
        if (/trace|metric|log|progress/.test(o)) return /component|tool|run|artifact|platform/.test(t);
        return false;
      }) || opsTargets[0];
    if (preferred)
      push(signal, preferred, 'observes', 'observes', 'operational signal observes matching runtime/artifact surface');
  }

  if (!edges.length && actors.length && components.length) {
    for (const actor of actors)
      push(actor, components[0], 'calls', 'uses', 'last-resort actor to primary component edge');
  }
  return edges;
}

// Audit log for edge-inference failures. Appends to
// _cobolt-output/audit/arch-edge-inference.jsonl. Best-effort — never throws.
function appendEdgeInferenceFailure(record) {
  try {
    const auditDir = path.join(process.cwd(), '_cobolt-output', 'audit');
    fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`;
    fs.appendFileSync(path.join(auditDir, 'arch-edge-inference.jsonl'), line, { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}

function buildGroups(nodes) {
  const groups = [];
  const byType = {
    actor: 'Actors',
    capability: 'Capabilities',
    component: 'Application',
    dataEntity: 'Data',
    dataStore: 'Data',
    api: 'API',
    integration: 'External',
    securityControl: 'Security',
    trustBoundary: 'Security',
    platformNode: 'Platform',
    operationalSignal: 'Operations',
  };
  const bucket = new Map();
  for (const n of nodes) {
    const g = byType[n.type];
    if (!g) continue;
    if (!bucket.has(g)) bucket.set(g, []);
    bucket.get(g).push(n.id);
  }
  for (const [name, ids] of bucket.entries()) {
    groups.push({
      id: sanitizeId(name, 'grp'),
      name,
      kind: name === 'Security' ? 'boundary' : name === 'Platform' ? 'platform' : 'layer',
      nodes: ids,
    });
  }
  return groups;
}

function buildAssumptions(nodes, sourceEvidence) {
  const out = [];
  if (!sourceEvidence.length) {
    out.push('No planning or brownfield artifacts were available — graph is a minimal stub.');
  }
  if (!nodes.some((n) => n.type === 'api')) {
    out.push('No explicit API endpoints found; API map will show placeholder or skip.');
  }
  if (!nodes.some((n) => n.type === 'dataEntity')) {
    out.push('No data entities extracted; ERD / data-flow diagrams will show placeholder or skip.');
  }
  return out;
}

function computeGaps(nodes, sourceEvidence) {
  const gaps = [];
  if (!sourceEvidence.length) {
    gaps.push({ area: 'evidence', reason: 'No upstream artifacts available.' });
  }
  const expected = [
    'actor',
    'capability',
    'component',
    'dataEntity',
    'api',
    'integration',
    'securityControl',
    'trustBoundary',
    'platformNode',
    'operationalSignal',
  ];
  for (const t of expected) {
    if (!nodes.some((n) => n.type === t)) {
      gaps.push({ area: t, reason: `No ${t} nodes extracted from available evidence.` });
    }
  }
  return gaps;
}

// ── Schema validation (minimal, dependency-free) ───────────────────────────

function validateGraphShape(graph) {
  const errors = [];
  if (!graph || typeof graph !== 'object') return ['graph is not an object'];
  for (const req of ['version', 'generatedAt', 'pipeline', 'state', 'nodes', 'edges']) {
    if (!(req in graph)) errors.push(`missing required field: ${req}`);
  }
  if (graph.pipeline && !['greenfield', 'brownfield'].includes(graph.pipeline))
    errors.push(`invalid pipeline: ${graph.pipeline}`);
  if (graph.state && !['current', 'target', 'delta', 'composite'].includes(graph.state))
    errors.push(`invalid state: ${graph.state}`);
  if (graph.nodes && !Array.isArray(graph.nodes)) errors.push('nodes is not an array');
  if (graph.edges && !Array.isArray(graph.edges)) errors.push('edges is not an array');
  if (Array.isArray(graph.nodes)) {
    for (const n of graph.nodes) {
      if (!n.id || !n.type || !n.name || !n.confidence) {
        errors.push(`node missing required fields: ${JSON.stringify(n).slice(0, 120)}`);
      }
    }
  }
  return errors;
}

// ── Delta builder (current → target) ────────────────────────────────────────

function buildDeltaGraph(currentGraph, targetGraph) {
  const currentById = new Map((currentGraph?.nodes || []).map((n) => [n.id, n]));
  const targetById = new Map((targetGraph?.nodes || []).map((n) => [n.id, n]));
  const deltaNodes = [];
  for (const [id, tn] of targetById.entries()) {
    if (currentById.has(id)) {
      deltaNodes.push({ ...tn, state: 'delta', deltaType: 'keep' });
    } else {
      deltaNodes.push({ ...tn, state: 'delta', deltaType: 'add' });
    }
  }
  for (const [id, cn] of currentById.entries()) {
    if (!targetById.has(id)) {
      deltaNodes.push({ ...cn, state: 'delta', deltaType: 'retire' });
    }
  }
  return {
    version: CANONICAL_VERSION,
    generatedAt: new Date().toISOString(),
    pipeline: targetGraph?.pipeline || 'brownfield',
    state: 'delta',
    projectRoot: targetGraph?.projectRoot || currentGraph?.projectRoot,
    sourceEvidence: [...(currentGraph?.sourceEvidence || []), ...(targetGraph?.sourceEvidence || [])],
    nodes: deltaNodes,
    edges: [],
    groups: [],
    gaps: [],
  };
}

// ── Build command ───────────────────────────────────────────────────────────

function buildGraph({ projectRoot = process.cwd(), pipeline = 'greenfield', state = null } = {}) {
  const effectiveState = state || (pipeline === 'brownfield' ? 'current' : 'target');

  if (effectiveState === 'both') {
    const current = buildGraphForState(projectRoot, pipeline, 'current');
    const target = buildGraphForState(projectRoot, pipeline, 'target');
    const delta = buildDeltaGraph(current, target);
    return {
      graph: { ...current, state: 'composite', mode: 'composite' },
      subgraphs: { current, target, delta },
    };
  }

  if (effectiveState === 'delta') {
    const current = buildGraphForState(projectRoot, pipeline, 'current');
    const target = buildGraphForState(projectRoot, pipeline, 'target');
    const delta = buildDeltaGraph(current, target);
    return { graph: delta, subgraphs: { current, target, delta } };
  }

  return { graph: buildGraphForState(projectRoot, pipeline, effectiveState), subgraphs: null };
}

function persistGraph(result, { projectRoot, pipeline }) {
  const gp = graphPath(projectRoot, pipeline);
  assertUnderArchRoot(gp, projectRoot, pipeline);
  writeFile(gp, JSON.stringify(result.graph, null, 2));
  if (result.subgraphs) {
    const dir = path.dirname(gp);
    for (const [key, g] of Object.entries(result.subgraphs)) {
      const subPath = path.join(dir, `architecture-graph.${key}.json`);
      assertUnderArchRoot(subPath, projectRoot, pipeline);
      writeFile(subPath, JSON.stringify(g, null, 2));
    }
  }
  return gp;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseCliArgs(argv) {
  const out = { pipeline: 'greenfield', state: null, dir: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--pipeline') out.pipeline = argv[++i];
    else if (a === '--state') out.state = argv[++i];
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--json') out.json = true;
  }
  return out;
}

function cli(argv) {
  const [cmd, ...rest] = argv;
  const opts = parseCliArgs(rest);
  const projectRoot = opts.dir || process.cwd();

  if (cmd === 'build') {
    const result = buildGraph({ projectRoot, pipeline: opts.pipeline, state: opts.state });
    const errs = validateGraphShape(result.graph);
    if (errs.length) {
      process.stderr.write(`[architecture-graph] schema errors:\n  - ${errs.join('\n  - ')}\n`);
      process.exit(3);
    }
    const gp = persistGraph(result, { projectRoot, pipeline: opts.pipeline });
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, graphPath: gp, nodeCount: result.graph.nodes.length, edgeCount: result.graph.edges.length }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(
        `[architecture-graph] wrote ${gp} (${result.graph.nodes.length} nodes, ${result.graph.edges.length} edges)\n`,
      );
    }
    return;
  }

  if (cmd === 'show') {
    const gp = graphPath(projectRoot, opts.pipeline);
    const data = readJson(gp);
    if (!data) {
      process.stderr.write(`[architecture-graph] no graph at ${gp}\n`);
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }

  process.stderr.write(
    'usage: cobolt-architecture-graph <build|show> [--pipeline greenfield|brownfield] [--state current|target|both|delta] [--dir <path>]\n',
  );
  process.exit(2);
}

if (require.main === module) cli(process.argv.slice(2));

module.exports = {
  buildGraph,
  buildGraphForState,
  buildDeltaGraph,
  validateGraphShape,
  graphPath,
  archRoot,
  CANONICAL_VERSION,
};
