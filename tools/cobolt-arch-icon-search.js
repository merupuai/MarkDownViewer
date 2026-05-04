#!/usr/bin/env node

// CoBolt Architecture Icon Search Tool (v0.22.0).
//
// Deterministic first-pass icon search. Given a service name or a list of
// slugs, resolves each against the bundled registry, the per-project cache,
// and (when network is enabled) the allowlisted icon sources via
// lib/cobolt-arch-icon-fetch.js. Returns a structured report and, in
// --ensure mode, populates the local cache.
//
// Usage:
//   node tools/cobolt-arch-icon-search.js resolve --name "Postgres" [--dir <project>]
//   node tools/cobolt-arch-icon-search.js ensure  --slugs postgres,redis,stripe [--budget 20] [--dir <project>]
//   node tools/cobolt-arch-icon-search.js list-registry
//   node tools/cobolt-arch-icon-search.js manifest [--dir <project>]
//
// Exit codes:
//   0 — resolved or report emitted
//   1 — all lookups failed
//   2 — usage error

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
const icons = require('../lib/cobolt-arch-icons');
const fetcher = require('../lib/cobolt-arch-icon-fetch');
const stack = require('../lib/cobolt-arch-tech-stack');
const { graphPath } = require('./cobolt-architecture-graph');

function parseArgs(argv) {
  const out = { dir: null, name: null, slugs: [], budget: null, json: false, pipeline: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dir') out.dir = argv[++i];
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--slugs')
      out.slugs = String(argv[++i] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a === '--budget') out.budget = parseInt(argv[++i], 10);
    else if (a === '--json') out.json = true;
    else if (a === '--pipeline') out.pipeline = argv[++i];
  }
  return out;
}

async function cmdResolve(opts) {
  const projectRoot = opts.dir ? path.resolve(opts.dir) : process.cwd();
  const techStack = stack.detect(projectRoot);
  const resolved = icons.resolve({
    nodeName: opts.name,
    techStack,
    projectRoot,
  });
  if (!resolved) {
    const report = {
      ok: false,
      name: opts.name,
      reason: 'not-in-registry',
      suggestion:
        'Add the service to source/icons/registry.json or place a custom SVG at docs/diagrams/icons/<slug>.svg',
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, ...resolved }, null, 2)}\n`);
  process.exit(0);
}

async function cmdEnsure(opts) {
  const projectRoot = opts.dir ? path.resolve(opts.dir) : process.cwd();
  const slugs = opts.slugs.length ? opts.slugs : suggestSlugsFromStack(projectRoot);
  if (!slugs.length) {
    process.stdout.write(`${JSON.stringify({ ok: true, slugs: [], note: 'no slugs to resolve' }, null, 2)}\n`);
    process.exit(0);
  }
  // Set context marker so the PreToolUse gate enforces allowlist on any
  // WebFetch emitted by this process tree (defense in depth; the fetcher does
  // this validation internally too).
  const markerDir = path.join(projectRoot, '_cobolt-output');
  try {
    atomicWrite(
      path.join(markerDir, '.arch-icon-fetch-active'),
      JSON.stringify({ created: Date.now(), ttl: 120_000, pid: process.pid }),
      { mode: 0o600 },
    );
  } catch {
    /* best-effort */
  }

  const budget = typeof opts.budget === 'number' && Number.isFinite(opts.budget) ? opts.budget : fetcher.DEFAULT_BUDGET;
  const { results, budgetRemaining } = await fetcher.ensureIconsForSlugs(projectRoot, slugs, { budget });
  const resolvedCount = Object.values(results).filter((r) => r.ok).length;
  const summary = {
    ok: resolvedCount > 0 || slugs.length === 0,
    total: slugs.length,
    resolved: resolvedCount,
    budgetRemaining,
    results,
    note: fetcher.isOffline()
      ? 'offline mode: no network fetches attempted'
      : `fetched ${resolvedCount}/${slugs.length} icons (${budget - budgetRemaining} new downloads)`,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  // Clean marker
  try {
    fs.unlinkSync(path.join(markerDir, '.arch-icon-fetch-active'));
  } catch {
    /* best-effort */
  }
  process.exit(summary.ok ? 0 : 1);
}

function suggestSlugsFromStack(projectRoot) {
  const detected = stack.detect(projectRoot);
  return detected.allSlugs || [];
}

function cmdListRegistry() {
  const reg = icons.loadRegistry();
  const out = {
    version: reg.version,
    totalIcons: Object.keys(reg.icons || {}).length,
    sources: Object.keys(reg.sources || {}),
    slugs: Object.keys(reg.icons || {}).sort(),
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(0);
}

function cmdManifest(opts) {
  const projectRoot = opts.dir ? path.resolve(opts.dir) : process.cwd();
  const manifest = fetcher.loadManifest(projectRoot);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  process.exit(0);
}

// Returns the list of slugs the architecture-graph references that are NOT
// in the icon cache yet — the dispatcher can use this to decide which slugs
// to escalate to the arch-icon-resolver agent.
function detectArchitecturePipeline(projectRoot) {
  const bf = path.join(projectRoot, '_cobolt-output', 'latest', 'brownfield');
  const sentinels = ['00-source-file-manifest.json', '04-feature-and-module-inventory.md', '23-master-assessment.md'];
  return sentinels.some((name) => fs.existsSync(path.join(bf, name))) ? 'brownfield' : 'greenfield';
}

function cmdUnresolved(opts) {
  const projectRoot = opts.dir ? path.resolve(opts.dir) : process.cwd();
  const preferred = opts.pipeline || detectArchitecturePipeline(projectRoot);
  const pipelines = [preferred, preferred === 'brownfield' ? 'greenfield' : 'brownfield'];
  const candidatePaths = pipelines.map((pipeline) => graphPath(projectRoot, pipeline));
  let graph = null;
  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        graph = JSON.parse(fs.readFileSync(p, 'utf8'));
        break;
      }
    } catch {
      /* try next */
    }
  }
  if (!graph) {
    process.stdout.write(`${JSON.stringify({ ok: true, unresolved: [], note: 'no graph found' }, null, 2)}\n`);
    process.exit(0);
  }
  const manifest = fetcher.loadManifest(projectRoot);
  const cachedSlugs = new Set(Object.keys(manifest.icons || {}));
  const unresolved = [];
  const seen = new Set();
  for (const node of graph.nodes || []) {
    if (!node?.name) continue;
    // Only escalate when the node represents a service worth iconifying:
    // integrations, dataStores, platformNodes, securityControls. Skip actors,
    // capabilities, dataEntities, components — those don't get vendor icons.
    const iconable = ['integration', 'dataStore', 'platformNode', 'securityControl'].includes(node.type);
    if (!iconable) continue;
    const slug = String(node.name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    if (cachedSlugs.has(slug)) continue;
    // Also skip if the registry has it (would be picked up by ensure())
    const registryHit = require('../lib/cobolt-arch-icons').iconForSlug(slug);
    if (registryHit) continue;
    unresolved.push({ slug, name: node.name, type: node.type, nodeId: node.id });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, count: unresolved.length, unresolved }, null, 2)}\n`);
  process.exit(0);
}

// Accepts a resolver-supplied candidate JSON on stdin and validates+fetches+caches it.
// Input format (stdin, JSON): { slug, candidate: { url, source, iconId?, license?, confidence? } }
async function cmdAcceptResolver(opts) {
  const projectRoot = opts.dir ? path.resolve(opts.dir) : process.cwd();
  let stdinRaw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) stdinRaw += chunk;
  let payload;
  try {
    payload = JSON.parse(stdinRaw || '{}');
  } catch (err) {
    process.stderr.write(`[icon-search:accept-resolver] invalid JSON on stdin: ${err.message}\n`);
    process.exit(2);
  }
  const { slug, candidate } = payload;
  if (!slug || !candidate?.url) {
    process.stderr.write(`[icon-search:accept-resolver] payload requires {slug, candidate:{url}}\n`);
    process.exit(2);
  }
  // Set marker so the icon-fetch-gate hook enforces allowlist on any WebFetch
  // emitted in this process tree.
  const markerDir = path.join(projectRoot, '_cobolt-output');
  try {
    atomicWrite(
      path.join(markerDir, '.arch-icon-fetch-active'),
      JSON.stringify({ created: Date.now(), ttl: 120_000, pid: process.pid }),
      { mode: 0o600 },
    );
  } catch {
    /* best-effort */
  }
  const result = await fetcher.fetchAndCacheFromCandidate(projectRoot, slug, candidate);
  try {
    fs.unlinkSync(path.join(markerDir, '.arch-icon-fetch-active'));
  } catch {
    /* best-effort */
  }
  // Audit log every resolver acceptance
  try {
    const auditDir = path.join(projectRoot, '_cobolt-output', 'audit');
    fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      path.join(auditDir, 'arch-icon-resolver.jsonl'),
      `${JSON.stringify({
        ts: new Date().toISOString(),
        slug,
        url: candidate.url,
        source: candidate.source || 'resolver',
        result: result.ok ? 'ok' : 'fail',
        reason: result.reason || null,
      })}\n`,
      { mode: 0o600 },
    );
  } catch {
    /* best-effort */
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const opts = parseArgs(rest);
  switch (cmd) {
    case 'resolve':
      return cmdResolve(opts);
    case 'ensure':
      return cmdEnsure(opts);
    case 'list-registry':
      return cmdListRegistry();
    case 'manifest':
      return cmdManifest(opts);
    case 'unresolved':
      return cmdUnresolved(opts);
    case 'accept-resolver':
      return cmdAcceptResolver(opts);
    default:
      process.stderr.write(
        'usage: cobolt-arch-icon-search <resolve|ensure|list-registry|manifest|unresolved|accept-resolver> [options]\n' +
          '  resolve         --name "<service>" [--dir <path>]\n' +
          '  ensure          --slugs a,b,c [--budget 20] [--dir <path>]\n' +
          '  list-registry\n' +
          '  manifest        [--dir <path>]\n' +
          '  unresolved      [--dir <path>] [--pipeline greenfield|brownfield]\n' +
          '  accept-resolver [--dir <path>]   # reads {slug, candidate:{url,...}} JSON on stdin\n',
      );
      process.exit(2);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`[icon-search] error: ${err.message || err}\n`);
    process.exit(1);
  });
}

module.exports = { suggestSlugsFromStack };
