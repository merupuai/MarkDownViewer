#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(ROOT, 'source', 'agents');
const DEFAULT_OUT = path.join(ROOT, '_cobolt-output', 'audit', 'agent-dedup-proposal.json');
const PACKAGE_JSON = path.join(ROOT, 'package.json');
const DEFAULT_BASELINE = 0;

function loadBaseline() {
  // AD-04 Phase 1: --check is a regression detector, not an absolute gate.
  // Mirrors the cobolt.agentCeiling pattern in tools/cobolt-agent-ceiling.js —
  // package.json declares the accepted dedup-candidate-cluster baseline; the
  // tool fails only when the live count exceeds it. Lowering the baseline is
  // how Phase 2 dedup work is forced incrementally.
  try {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
    const v = pkg?.cobolt?.agentDedupBaseline;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  } catch {
    /* fall through */
  }
  return DEFAULT_BASELINE;
}

function stripQuotes(value) {
  return String(value || '')
    .replace(/^['"]/, '')
    .replace(/['"]$/, '');
}

function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return { fm: {}, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return { fm: {}, body: raw };
  const block = raw.slice(4, end);
  const body = raw.slice(end + 4).replace(/^\r?\n/, '');
  const fm = {};
  let pending = null;
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const listMatch = line.match(/^\s+-\s+(.*)$/);
    if (listMatch && pending) {
      if (!Array.isArray(fm[pending])) fm[pending] = [];
      fm[pending].push(stripQuotes(listMatch[1].trim()));
      continue;
    }
    const nestedMatch = line.match(/^\s+([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (nestedMatch && pending) {
      if (!fm[pending] || Array.isArray(fm[pending])) fm[pending] = {};
      fm[pending][nestedMatch[1]] = stripQuotes(nestedMatch[2].trim());
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.trim();
    pending = value ? null : key;
    fm[key] = value ? stripQuotes(value) : [];
  }
  return { fm, body };
}

const CAPABILITY_HINTS = [
  [/-reviewer$/, 'review'],
  [/-fix(?:-agent)?$/, 'fix'],
  [/-builder$/, 'build'],
  [/-architect$/, 'plan'],
  [/-analyst$/, 'plan'],
  [/-auditor$/, 'audit'],
  [/-validator$/, 'validate'],
  [/security/, 'security'],
  [/compliance/, 'compliance'],
  [/deploy/, 'deploy'],
  [/brownfield|legacy|reverse/, 'brownfield'],
  [/-lead$|-orchestrator$/, 'orchestration'],
];

function inferCapability(name, fm, body = '') {
  if (typeof fm.capability === 'string' && fm.capability) return fm.capability;
  for (const [re, capability] of CAPABILITY_HINTS) {
    if (re.test(name)) return capability;
  }
  const lower = body.toLowerCase();
  if (lower.includes('frontend') || lower.includes('component')) return 'frontend';
  if (lower.includes('backend') || lower.includes('api')) return 'backend';
  if (lower.includes('research') || lower.includes('investigate')) return 'research';
  return 'other';
}

function inferGrounding(fm) {
  if (typeof fm.grounding === 'string' && fm.grounding) return fm.grounding;
  const tools = Array.isArray(fm.tools) ? fm.tools.join(',') : String(fm.tools || '');
  if (/context7/i.test(tools)) return 'context7';
  if (/playwright/i.test(tools)) return 'playwright-mcp';
  if (/chrome-devtools/i.test(tools)) return 'chrome-devtools-mcp';
  if (/mcp__github/i.test(tools)) return 'github-mcp';
  if (/(^|,\s*)(Bash|Glob|Grep|Read|Write|Edit)/.test(tools) && !/mcp__/i.test(tools)) return 'deterministic';
  return 'none';
}

function inferEscalationTarget(fm, body = '') {
  if (typeof fm.escalationTarget === 'string' && fm.escalationTarget) return fm.escalationTarget;
  const match =
    body.match(/dispatched\s+by\s+([\w-]+)/i) ||
    body.match(/escalat(?:es?|ed?|ion)\s+to\s+([\w-]+)/i) ||
    body.match(/^owner:\s*([\w-]+)/im);
  return match ? match[1].toLowerCase() : '<unset>';
}

function clusterId(capability, grounding, escalationTarget) {
  return crypto.createHash('sha1').update(`${capability}:${grounding}:${escalationTarget}`).digest('hex').slice(0, 12);
}

function classifyAll(options = {}) {
  const rootDir = options.rootDir || AGENTS_DIR;
  if (!fs.existsSync(rootDir)) throw new Error(`agents dir not found: ${rootDir}`);
  const agents = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'CLAUDE.md') continue;
    const full = path.join(rootDir, entry.name);
    const { fm, body } = parseFrontmatter(fs.readFileSync(full, 'utf8'));
    const name = entry.name.replace(/\.md$/, '');
    const capability = inferCapability(name, fm, body);
    const grounding = inferGrounding(fm);
    const escalationTarget = inferEscalationTarget(fm, body);
    const isAlias = Boolean(fm.alias && typeof fm.alias === 'object' && fm.alias.of);
    agents.push({
      name,
      file: path.relative(ROOT, full).replace(/\\/g, '/'),
      capability,
      grounding,
      escalationTarget,
      clusterId: clusterId(capability, grounding, escalationTarget),
      isAlias,
      aliasOf: isAlias ? fm.alias.of : null,
      bodyLen: body.length,
    });
  }
  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

function buildClusters(agents) {
  const map = new Map();
  for (const agent of agents) {
    if (agent.isAlias) continue;
    if (!map.has(agent.clusterId)) {
      map.set(agent.clusterId, {
        clusterId: agent.clusterId,
        capability: agent.capability,
        grounding: agent.grounding,
        escalationTarget: agent.escalationTarget,
        members: [],
      });
    }
    map.get(agent.clusterId).members.push(agent);
  }
  return [...map.values()].sort((a, b) => b.members.length - a.members.length);
}

function recommendCanonical(cluster) {
  return [...cluster.members].sort((a, b) => b.bodyLen - a.bodyLen)[0]?.name || null;
}

function buildProposal(agents, clusters) {
  const duplicateClusters = clusters.filter((cluster) => cluster.members.length > 1);
  return {
    schema: 'cobolt-agent-dedup-proposal@1',
    generatedAt: new Date().toISOString(),
    totalAgents: agents.length,
    activeAgents: agents.filter((agent) => !agent.isAlias).length,
    aliasCount: agents.filter((agent) => agent.isAlias).length,
    clusterCount: clusters.length,
    dedupCandidateClusters: duplicateClusters.length,
    estimatedAliasOpportunities: duplicateClusters.reduce((sum, cluster) => sum + cluster.members.length - 1, 0),
    clusters: duplicateClusters.map((cluster) => ({
      ...cluster,
      recommendCanonical: recommendCanonical(cluster),
      members: cluster.members.map((agent) => agent.name),
    })),
  };
}

function writeProposal(proposal, outPath = DEFAULT_OUT) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(outPath, `${JSON.stringify(proposal, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return outPath;
}

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { json: false, print: false, check: false, out: DEFAULT_OUT, baseline: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--print') opts.print = true;
    else if (arg === '--check') opts.check = true;
    else if (arg === '--out') opts.out = path.resolve(argv[++i] || opts.out);
    else if (arg === '--baseline') {
      const raw = argv[++i];
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`--baseline expects a non-negative integer, got: ${raw}`);
      }
      opts.baseline = parsed;
    } else if (arg.startsWith('--baseline=')) {
      const parsed = Number.parseInt(arg.slice('--baseline='.length), 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`--baseline expects a non-negative integer, got: ${arg}`);
      }
      opts.baseline = parsed;
    } else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(`Usage: node tools/cobolt-agent-dedup.js [--json|--print|--check] [--baseline N] [--out file]

Modes:
  (default)     Write the dedup proposal packet to --out and exit 0.
  --print       Print candidate clusters to stdout and exit 0.
  --json        Emit the proposal as JSON on stdout and exit 0.
  --check       Compare candidate-cluster count against the baseline; exit 1
                only when the live count exceeds it.

Baseline:
  --baseline N  Override the package.json cobolt.agentDedupBaseline value.
                The baseline is the number of candidate clusters currently
                accepted (AD-04 Phase 1). --check exits 0 when
                dedupCandidateClusters <= baseline; lower the baseline as
                Phase 2 alias work demotes redundant agents.`);
    return 0;
  }
  const agents = classifyAll();
  const clusters = buildClusters(agents);
  const proposal = buildProposal(agents, clusters);
  const baseline = typeof opts.baseline === 'number' ? opts.baseline : loadBaseline();
  proposal.baseline = baseline;
  proposal.exceedsBaseline = proposal.dedupCandidateClusters > baseline;
  if (opts.json) console.log(JSON.stringify(proposal, null, 2));
  else if (opts.print) {
    console.log(
      `Agents: ${proposal.totalAgents}; candidate clusters: ${proposal.dedupCandidateClusters} (baseline ${baseline})`,
    );
    for (const cluster of proposal.clusters) {
      console.log(
        `${cluster.clusterId} ${cluster.capability}/${cluster.grounding}/${cluster.escalationTarget}: ${cluster.members.join(', ')}`,
      );
    }
  } else if (opts.check) {
    if (proposal.exceedsBaseline) {
      console.error(
        `[cobolt-agent-dedup] FAIL — ${proposal.dedupCandidateClusters} candidate clusters exceed baseline ${baseline}. ` +
          `Either alias new redundant agents or raise package.json cobolt.agentDedupBaseline.`,
      );
    } else {
      console.log(
        `[cobolt-agent-dedup] OK — ${proposal.dedupCandidateClusters} candidate clusters (baseline ${baseline}, ` +
          `headroom ${baseline - proposal.dedupCandidateClusters}).`,
      );
    }
  } else {
    const out = writeProposal(proposal, opts.out);
    console.log(`[cobolt-agent-dedup] wrote ${path.relative(ROOT, out).replace(/\\/g, '/')}`);
  }
  return opts.check && proposal.exceedsBaseline ? 1 : 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`[cobolt-agent-dedup] ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  buildClusters,
  buildProposal,
  classifyAll,
  clusterId,
  DEFAULT_BASELINE,
  inferCapability,
  inferEscalationTarget,
  inferGrounding,
  loadBaseline,
  main,
  parseArgs,
  parseFrontmatter,
  recommendCanonical,
  writeProposal,
};
