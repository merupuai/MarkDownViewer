#!/usr/bin/env node

// CoBolt MCP coverage audit
//
// For each agent in source/agents/*.md, computes:
//   - declared:  MCP tools enumerated in the agent's `tools:` frontmatter,
//                grouped by server (figma, github, context7, ...).
//   - inferred:  MCP servers the agent's role implies it should declare,
//                per lib/cobolt-mcp-roles.js role inference.
//   - gap:       inferred - declared (the agent should declare these but doesn't).
//   - extra:     declared - inferred (declared but role doesn't imply need).
//
// Project-MCP gaps (figma/stitch/context7/github) ship a remediation that says
// "add to tools: frontmatter; verify env key in .env.cobolt".
// Plugin-MCP gaps (chrome-devtools/playwright/microsoft-docs) ship a remediation
// that says "requires Claude Code plugin install via /plugin install <name>".
//
// Registration probe (server-side):
//   - .mcp.json (cwd) is the dogfood/self-development path; rarely present in
//     a user project.
//   - Runtime configs are the canonical user-facing path that bin/install.js
//     writes mcpServers into: <cwd>/.claude/settings.json (project),
//     ~/.claude/settings.json (global), ~/.claude.json (legacy global).
//   The serversManifest reports BOTH so users in a project that lacks .mcp.json
//   can still see whether a server is registered globally — closing the
//   "github MCP declared by 18 agents but tool unavailable at runtime" blind
//   spot surfaced 2026-04-27 (see plans/snuggly-pondering-fog.md).
//
// Output: _cobolt-output/audit/mcp-coverage-report.json (schema:
// source/schemas/mcp-coverage-report.schema.json).
//
// Exit codes (per tools/CLAUDE.md):
//   0 = audit ran to completion
//   1 = parse error / unhandled exception
//   2 = missing optional dep   (n/a here — pure Node)
//   3 = missing infrastructure (n/a here)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MCP_SERVER_MANIFEST,
  inferMcpServers,
  groupDeclaredByServer,
  remediationFor,
} = require('../lib/cobolt-mcp-roles.js');

const SCHEMA_VERSION = 1;

function defaultRuntimeConfigCandidates() {
  const home = os.homedir();
  return [
    path.join(process.cwd(), '.claude', 'settings.json'),
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.claude.json'),
  ];
}

// ── Help / argv ──────────────────────────────────────────────

const HELP = `cobolt-mcp-audit — declared-vs-inferred MCP tool coverage per agent

USAGE
  node tools/cobolt-mcp-audit.js [options]

OPTIONS
  --format=<json|text>      Output format (default: text)
  --mcp-config=<path>       .mcp.json path (default: <cwd>/.mcp.json)
                            Note: most user projects do NOT have a .mcp.json;
                            bin/install.js writes mcpServers to the runtime
                            config instead. See --runtime-config below.
  --runtime-config=<path>   Claude Code runtime config to probe for
                            mcpServers (repeatable). Default candidates:
                              <cwd>/.claude/settings.json
                              ~/.claude/settings.json
                              ~/.claude.json
  --agents-dir=<path>       Agents directory (default: <cwd>/source/agents)
  --ledger=<path>           mcp-call-ledger.jsonl path
                            (default: <cwd>/_cobolt-output/latest/mcp-call-ledger.jsonl)
  --output=<path>           Audit JSON output path
                            (default: <cwd>/_cobolt-output/audit/mcp-coverage-report.json)
  --write-cache             Write the JSON output even when --format=text
  --quiet                   Suppress text output (still writes the JSON)
  -h, --help                Show this help

EXIT CODES
  0  audit ran to completion
  1  parse error / unhandled exception
`;

function parseArgs(argv) {
  const args = {
    format: 'text',
    mcpConfig: path.join(process.cwd(), '.mcp.json'),
    runtimeConfigs: null, // null = use defaults; explicit array overrides
    agentsDir: path.join(process.cwd(), 'source', 'agents'),
    ledger: path.join(process.cwd(), '_cobolt-output', 'latest', 'mcp-call-ledger.jsonl'),
    output: path.join(process.cwd(), '_cobolt-output', 'audit', 'mcp-coverage-report.json'),
    writeCache: false,
    quiet: false,
    help: false,
  };
  for (const raw of argv) {
    if (raw === '-h' || raw === '--help') {
      args.help = true;
    } else if (raw === '--write-cache') {
      args.writeCache = true;
    } else if (raw === '--quiet') {
      args.quiet = true;
    } else if (raw.startsWith('--format=')) {
      const v = raw.slice('--format='.length);
      if (v === 'json' || v === 'text') args.format = v;
    } else if (raw.startsWith('--mcp-config=')) {
      args.mcpConfig = path.resolve(raw.slice('--mcp-config='.length));
    } else if (raw.startsWith('--runtime-config=')) {
      if (!Array.isArray(args.runtimeConfigs)) args.runtimeConfigs = [];
      args.runtimeConfigs.push(path.resolve(raw.slice('--runtime-config='.length)));
    } else if (raw.startsWith('--agents-dir=')) {
      args.agentsDir = path.resolve(raw.slice('--agents-dir='.length));
    } else if (raw.startsWith('--ledger=')) {
      args.ledger = path.resolve(raw.slice('--ledger='.length));
    } else if (raw.startsWith('--output=')) {
      args.output = path.resolve(raw.slice('--output='.length));
    }
  }
  if (args.runtimeConfigs === null) {
    args.runtimeConfigs = defaultRuntimeConfigCandidates();
  }
  return args;
}

// ── Frontmatter parsing ──────────────────────────────────────

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return null;
  const raw = m[1];
  const fm = {};
  const lines = raw.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kv = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      let value = kv[2].trim();
      // Multi-line value support: subsequent indented lines extend the value
      // (description fields often wrap). Stop on next top-level key or end.
      let lookahead = i + 1;
      while (lookahead < lines.length) {
        const nxt = lines[lookahead];
        if (/^\S/.test(nxt) && /^[a-zA-Z_][\w-]*\s*:/.test(nxt)) break;
        if (nxt.trim().length === 0) {
          lookahead += 1;
          continue;
        }
        value = value ? `${value} ${nxt.trim()}` : nxt.trim();
        lookahead += 1;
      }
      fm[key] = value;
      i = lookahead;
      continue;
    }
    i += 1;
  }
  return fm;
}

function splitToolsCsv(toolsValue) {
  if (!toolsValue) return [];
  return String(toolsValue)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── .mcp.json parsing ────────────────────────────────────────

function readMcpConfig(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const json = JSON.parse(raw);
    const servers = json?.mcpServers ? Object.keys(json.mcpServers) : [];
    return { exists: true, servers };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false, servers: [] };
    throw new Error(`failed to parse ${filePath}: ${err.message}`);
  }
}

// ── Runtime config probe ─────────────────────────────────────
//
// bin/install.js writes mcpServers into the Claude Code runtime config
// (~/.claude/settings.json by default), NOT into <cwd>/.mcp.json. For a
// user-project audit, this is the canonical registration source.
//
// readRuntimeConfigs returns a Map<serverName, configPath> recording the
// FIRST runtime config that registers each server (in candidate order).

function readRuntimeConfigs(filePaths) {
  const serverToPath = new Map();
  const pathsRead = [];
  if (!Array.isArray(filePaths)) return { serverToPath, pathsRead };
  for (const filePath of filePaths) {
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      // Tolerant: a malformed runtime config should not abort the audit —
      // record the path and move on so the user still sees coverage data.
      pathsRead.push({ path: filePath, ok: false, error: err.message });
      continue;
    }
    let json;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      pathsRead.push({ path: filePath, ok: false, error: `parse: ${err.message}` });
      continue;
    }
    pathsRead.push({ path: filePath, ok: true });
    const servers = json?.mcpServers && typeof json.mcpServers === 'object' ? Object.keys(json.mcpServers) : [];
    for (const server of servers) {
      if (!serverToPath.has(server)) serverToPath.set(server, filePath);
    }
  }
  return { serverToPath, pathsRead };
}

// ── Ledger lookup ────────────────────────────────────────────

function readLedgerFamilies(filePath) {
  const families = new Set();
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (entry?.family) families.add(entry.family);
      } catch {
        // tolerant — ledger may have partial lines
      }
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }
  return families;
}

// Map ledger 'family' (lowercase, e.g. 'github', 'figma', 'stitch')
// to manifest 'server' (e.g. 'github', 'Figma', 'StitchMCP').
function familyToServer(family) {
  const f = String(family || '').toLowerCase();
  if (f === 'figma') return 'Figma';
  if (f === 'stitch') return 'StitchMCP';
  if (f === 'github') return 'github';
  if (f === 'context7') return 'context7';
  if (f === 'chrome-devtools') return 'chrome-devtools';
  if (f === 'playwright') return 'playwright';
  if (f === 'microsoft-docs') return 'microsoft-docs';
  return null;
}

// ── Per-agent analysis ───────────────────────────────────────

function analyseAgent(filePath, ledgerServers) {
  const content = fs.readFileSync(filePath, 'utf8');
  const fm = parseFrontmatter(content);
  if (!fm) return null;
  const name = (fm.name || path.basename(filePath, '.md')).trim();
  const description = fm.description || '';
  const tools = splitToolsCsv(fm.tools);

  const declaredGrouped = groupDeclaredByServer(tools).map((g) => ({
    server: g.server,
    kind: g.kind,
    tools: g.tools,
    actuallyCalled: ledgerServers.has(g.server),
  }));

  const inferred = inferMcpServers({ name, description });

  const declaredSet = new Set(declaredGrouped.map((g) => g.server));
  const inferredSet = new Set(inferred.map((i) => i.server));

  const gap = inferred
    .filter((i) => !declaredSet.has(i.server))
    .map((i) => ({
      server: i.server,
      kind: i.kind,
      matchedKeywords: i.matchedKeywords,
      remediation: remediationFor(i.server),
    }));

  const extra = declaredGrouped
    .filter((d) => !inferredSet.has(d.server))
    .map((d) => ({
      server: d.server,
      kind: d.kind,
      note: d.actuallyCalled
        ? 'declared without role-inference match — but actually invoked per ledger; keep'
        : 'declared without role-inference match and never invoked per ledger',
    }));

  return {
    name,
    filePath: path.relative(process.cwd(), filePath).replace(/\\/g, '/'),
    declared: declaredGrouped,
    inferred,
    gap,
    extra,
  };
}

// ── Main ────────────────────────────────────────────────────

function listAgentFiles(agentsDir) {
  const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;
    if (entry.name.toUpperCase() === 'CLAUDE.MD') continue;
    out.push(path.join(agentsDir, entry.name));
  }
  return out;
}

function buildServersManifest(mcpConfig, runtimeRegistration) {
  const declaredInMcpJson = new Set(mcpConfig?.servers || []);
  const runtimeMap = runtimeRegistration?.serverToPath instanceof Map ? runtimeRegistration.serverToPath : new Map();
  return MCP_SERVER_MANIFEST.map((m) => {
    const isProject = m.kind === 'project';
    const inMcpJson = isProject && declaredInMcpJson.has(m.server);
    const runtimePath = isProject ? runtimeMap.get(m.server) || null : null;
    return {
      server: m.server,
      kind: m.kind,
      envKeys: m.envKeys,
      representativeTools: m.representativeTools,
      registeredInMcpJson: inMcpJson,
      registeredInRuntimeConfig: isProject ? Boolean(runtimePath) : false,
      runtimeConfigPath: runtimePath,
    };
  });
}

function summarise(agentReports) {
  let projectMcpGapCount = 0;
  let pluginMcpGapCount = 0;
  let extraDeclarationCount = 0;
  let agentsWithGap = 0;
  let agentsWithoutAnyMcp = 0;
  for (const a of agentReports) {
    if (a.gap.length > 0) agentsWithGap += 1;
    if (a.declared.length === 0) agentsWithoutAnyMcp += 1;
    extraDeclarationCount += a.extra.length;
    for (const g of a.gap) {
      if (g.kind === 'project') projectMcpGapCount += 1;
      else pluginMcpGapCount += 1;
    }
  }
  return {
    projectMcpGapCount,
    pluginMcpGapCount,
    extraDeclarationCount,
    agentsWithGap,
    agentsWithoutAnyMcp,
  };
}

function renderText(report, args) {
  if (args.quiet) return '';
  const lines = [];
  lines.push('CoBolt MCP coverage audit');
  lines.push(`generated: ${report.generatedAt}`);
  lines.push(`agents scanned: ${report.agentsScanned}`);
  lines.push(`project-MCP gaps:  ${report.summary.projectMcpGapCount} (across ${report.summary.agentsWithGap} agents)`);
  lines.push(`plugin-MCP gaps:   ${report.summary.pluginMcpGapCount}`);
  lines.push(`extra declarations: ${report.summary.extraDeclarationCount}`);
  lines.push(`agents with zero MCP tools declared: ${report.summary.agentsWithoutAnyMcp}`);
  lines.push('');
  lines.push('top gaps by server:');
  const counts = new Map();
  for (const a of report.agents) {
    for (const g of a.gap) {
      counts.set(g.server, (counts.get(g.server) || 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [server, count] of sorted) {
    const m = MCP_SERVER_MANIFEST.find((x) => x.server === server);
    lines.push(`  ${String(count).padStart(4)}  ${server.padEnd(18)} (${m ? m.kind : '?'})`);
  }

  // Project-MCP runtime registration — surfaces the "github MCP declared by N
  // agents but not loaded at runtime" class of failures that <cwd>/.mcp.json
  // alone cannot detect. In user projects (.mcp.json absent), the runtime
  // config is the canonical signal; show it first and omit the .mcp.json
  // column when no project server is recorded as registered there.
  const projectServers = (report.serversManifest || []).filter((s) => s.kind === 'project');
  if (projectServers.length > 0) {
    const anyMcpJson = projectServers.some((s) => s.registeredInMcpJson === true);
    lines.push('');
    lines.push('project-MCP server registration:');
    for (const s of projectServers) {
      const runtimeCol = s.registeredInRuntimeConfig ? `yes (${s.runtimeConfigPath})` : 'no';
      const baseLine = `  ${s.server.padEnd(18)}  runtime=${runtimeCol}`;
      const mcpJsonCol = anyMcpJson ? `  .mcp.json=${s.registeredInMcpJson ? 'yes' : 'no'}` : '';
      lines.push(`${baseLine}${mcpJsonCol}`);
      if (!s.registeredInMcpJson && !s.registeredInRuntimeConfig) {
        lines.push(
          `      remediation: not registered anywhere — re-run \`node bin/install.js --sync --yes\` and verify ${(s.envKeys || []).join(' + ') || '(no env keys)'} in .env.cobolt`,
        );
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

function writeJson(outputPath, report) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

function run(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  let agentFiles;
  try {
    agentFiles = listAgentFiles(args.agentsDir);
  } catch (err) {
    process.stderr.write(`error: agents dir unreadable: ${args.agentsDir}: ${err.message}\n`);
    return 1;
  }

  let mcpConfig;
  try {
    mcpConfig = readMcpConfig(args.mcpConfig);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    return 1;
  }

  const runtimeRegistration = readRuntimeConfigs(args.runtimeConfigs);

  const ledgerFamilies = readLedgerFamilies(args.ledger);
  const ledgerServers = new Set();
  for (const f of ledgerFamilies) {
    const s = familyToServer(f);
    if (s) ledgerServers.add(s);
  }

  const agents = [];
  for (const file of agentFiles) {
    try {
      const a = analyseAgent(file, ledgerServers);
      if (a) agents.push(a);
    } catch (err) {
      process.stderr.write(`warn: skipping ${file}: ${err.message}\n`);
    }
  }

  const report = {
    version: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    target: path.relative(process.cwd(), args.agentsDir).replace(/\\/g, '/') || args.agentsDir,
    agentsScanned: agents.length,
    summary: summarise(agents),
    serversManifest: buildServersManifest(mcpConfig, runtimeRegistration),
    agents,
  };

  if (!args.quiet) {
    if (args.format === 'json') {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(renderText(report, args));
    }
  }

  if (args.format === 'json' || args.writeCache) {
    try {
      writeJson(args.output, report);
    } catch (err) {
      process.stderr.write(`error: failed to write ${args.output}: ${err.message}\n`);
      return 1;
    }
  }

  return 0;
}

if (require.main === module) {
  try {
    process.exit(run(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`fatal: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  run,
  parseFrontmatter,
  splitToolsCsv,
  analyseAgent,
  summarise,
  buildServersManifest,
  familyToServer,
  readRuntimeConfigs,
  defaultRuntimeConfigCandidates,
  renderText,
};
