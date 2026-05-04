#!/usr/bin/env node

// CoBolt API-Contracts Slicer — endpoint-scoped API contract extract.
//
// Problem
//   _cobolt-output/latest/planning/api-contracts.md contains the whole
//   REST surface (routes, schemas, auth, rate-limits, pagination...)
//   for every resource group. Builders in a specific API round typically
//   own 2–4 endpoints, not the entire surface. Full injection costs
//   2–5K tokens per builder per API round.
//
// Solution
//   Produce an endpoint-scoped slice containing:
//     - Always-kept global sections (Overview, Auth, Resources schema,
//       Error Taxonomy, Rate Limiting, Pagination, Versioning, CORS,
//       Conventions)
//     - ## 4. Endpoints filtered to resource groups (### 4.N) and
//       endpoints (#### METHOD /path) matching the builder's file
//       ownership (by resource name derived from filename, or by route
//       path substring match).
//
// Fail-safe
//   If api-contracts.md is missing OR filtering matches zero endpoints,
//   the slicer COPIES the full contract file. Never produces an empty
//   or stub slice — that would silently starve API builders.
//
// Output
//   _cobolt-output/latest/build/{M}/api-contracts-slice-{hash}.md
//   _cobolt-output/latest/build/{M}/api-contracts-slice-{hash}.trace.json
//
// CLI
//   node tools/cobolt-api-contracts-slice.js slice \
//       --milestone M1 \
//       --files src/api/users.js,src/api/orders.js \
//       [--routes "/users,/orders/:id"] \
//       [--contracts <override path>] \
//       [--out <override path>]
//
// Exit codes (tools/CLAUDE.md contract):
//   0 = success (slice OR fallback)
//   1 = hard error (missing args, cannot read contracts, write failure)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWrite, atomicWriteJSON } = require('../lib/cobolt-atomic-write');
const { isSameOrDescendantPath } = require('../lib/cobolt-paths');

// Common English words that appear as filename segments. Matching these as
// bare substrings against arbitrary H3/H4 headings produces false positives
// (e.g. "orderHistory" → "history" matches "4.3 History & Audit Logs"
// unintentionally). For these tokens we require a word-boundary match.
const COMMON_NOUNS = new Set([
  'admin',
  'api',
  'app',
  'auth',
  'base',
  'code',
  'data',
  'date',
  'edit',
  'file',
  'form',
  'help',
  'home',
  'info',
  'item',
  'list',
  'log',
  'logs',
  'main',
  'menu',
  'meta',
  'name',
  'new',
  'page',
  'post',
  'role',
  'root',
  'site',
  'step',
  'sub',
  'tab',
  'tag',
  'text',
  'time',
  'type',
  'user',
  'view',
  'work',
  'history',
  'order',
  'orders',
  'product',
  'products',
  'setting',
  'settings',
]);

function assertPathWithinProject(p, label) {
  const cwd = process.cwd();
  const resolved = path.resolve(p);
  if (!isSameOrDescendantPath(resolved, cwd)) {
    console.error(`[api-contracts-slice] ${label || 'path'} "${p}" resolves outside project root (${cwd}); refusing.`);
    process.exit(1);
  }
  return resolved;
}

// Heading regexes
const H2 = /^##\s+(.+?)\s*$/;
const H3 = /^###\s+(.+?)\s*$/;
const H4 = /^####\s+(.+?)\s*$/;

// H2 sections to KEEP unconditionally (contain policies shared across every endpoint)
const GLOBAL_H2 = new Set([
  '1. API Overview',
  '2. Authentication & Authorization',
  '3. Resources',
  '5. Error Taxonomy',
  '6. Rate Limiting',
  '7. Pagination & Filtering',
  '8. Webhooks',
  '9. Versioning',
  '10. CORS',
  '11. Conventions',
]);

// The endpoints section — its H3 / H4 children are what we filter.
const ENDPOINTS_H2_PREFIX = '4. Endpoints';

// HTTP methods recognized in endpoint headings like "#### GET /users"
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const METHOD_PATH_RE = new RegExp(`^(${HTTP_METHODS.join('|')})\\s+(\\S+)`, 'i');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function splitList(raw) {
  if (!raw || raw === true) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Derive candidate resource tokens from a source file path. Applies the same
// "drop common-noun singletons when a compound exists" rule used by the
// design-cache slicer — a file like `orderHistory.js` should match an
// `Order History` resource but NOT an unrelated `History & Audit` resource.
function candidateResourceTokens(filePath) {
  const base = path.basename(String(filePath), path.extname(String(filePath)));
  const tokens = new Set();
  const lower = base.toLowerCase();
  tokens.add(lower);
  if (lower.endsWith('s') && lower.length > 2) tokens.add(lower.slice(0, -1));

  const pascalSegs = base
    .split(/(?=[A-Z])/)
    .map((s) => s.toLowerCase().trim())
    .filter(Boolean);
  const kebabSegs = base
    .split(/[-_]/)
    .map((s) => s.toLowerCase().trim())
    .filter(Boolean);
  const allSegs = Array.from(new Set([...pascalSegs, ...kebabSegs]));
  const hasCompound = allSegs.length > 1;

  if (hasCompound) tokens.add(pascalSegs.join(' '));

  for (const s of allSegs) {
    if (hasCompound && COMMON_NOUNS.has(s)) continue;
    tokens.add(s);
    if (s.endsWith('s') && s.length > 2 && !(hasCompound && COMMON_NOUNS.has(s.slice(0, -1)))) {
      tokens.add(s.slice(0, -1));
    }
  }
  return tokens;
}

// Derive tokens from an explicit route like "/users/:id" → ['users', 'user']
function routeTokens(route) {
  const parts = String(route)
    .split(/[/:]/)
    .map((s) => s.toLowerCase().trim())
    .filter((s) => s && !/^\{.*\}$/.test(s));
  const tokens = new Set();
  for (const p of parts) {
    tokens.add(p);
    if (p.endsWith('s') && p.length > 2) tokens.add(p.slice(0, -1));
  }
  return tokens;
}

function wordBoundaryMatch(haystack, token) {
  const re = new RegExp(`\\b${token.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
  return re.test(haystack);
}

function tokenMatches(haystack, token) {
  if (token.length < 2) return false;
  // Common nouns require word-boundary match to avoid false positives.
  if (COMMON_NOUNS.has(token)) {
    return wordBoundaryMatch(haystack, token);
  }
  return haystack.includes(token);
}

function resourceMatches(h3Heading, tokenSets) {
  const lower = String(h3Heading).toLowerCase();
  for (const tokens of tokenSets) {
    for (const t of tokens) {
      if (tokenMatches(lower, t)) return true;
    }
  }
  return false;
}

function endpointMatches(h4Heading, tokenSets) {
  const lower = String(h4Heading).toLowerCase();
  const m = String(h4Heading).match(METHOD_PATH_RE);
  const route = m ? m[2].toLowerCase() : '';
  for (const tokens of tokenSets) {
    for (const t of tokens) {
      if (tokenMatches(lower, t)) return true;
      if (route && tokenMatches(route, t)) return true;
    }
  }
  return false;
}

function parseBlocks(content) {
  const lines = content.split(/\r?\n/);
  const blocks = [];
  let current = { level: 0, heading: null, lines: [] };
  for (const line of lines) {
    const h2 = line.match(H2);
    const h3 = line.match(H3);
    const h4 = line.match(H4);
    if (h2) {
      if (current.lines.length || current.heading !== null) blocks.push(current);
      current = { level: 2, heading: h2[1], lines: [line] };
    } else if (h3) {
      if (current.lines.length || current.heading !== null) blocks.push(current);
      current = { level: 3, heading: h3[1], lines: [line] };
    } else if (h4) {
      if (current.lines.length || current.heading !== null) blocks.push(current);
      current = { level: 4, heading: h4[1], lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length || current.heading !== null) blocks.push(current);
  return blocks;
}

function filterBlocks(blocks, tokenSets) {
  const out = [];
  let currentH2 = null;
  let insideEndpointsH2 = false;
  let currentH3Matches = true; // default keep until we're inside Endpoints and know per-H3
  for (const b of blocks) {
    if (b.level === 2) {
      currentH2 = b.heading;
      insideEndpointsH2 = /^4\.\s*Endpoints/i.test(String(currentH2)) || String(currentH2) === ENDPOINTS_H2_PREFIX;
      if (GLOBAL_H2.has(currentH2) || (/^[0-9]+\./.test(String(currentH2)) && !insideEndpointsH2)) {
        out.push(b);
        currentH3Matches = true;
      } else if (insideEndpointsH2) {
        out.push(b);
        currentH3Matches = false; // children filter per-H3
      } else {
        // Unknown H2 — conservative keep.
        out.push(b);
        currentH3Matches = true;
      }
    } else if (b.level === 3) {
      if (!insideEndpointsH2) {
        out.push(b);
      } else {
        currentH3Matches = resourceMatches(b.heading, tokenSets);
        if (currentH3Matches) out.push(b);
      }
    } else if (b.level === 4) {
      if (!insideEndpointsH2) {
        out.push(b);
      } else if (currentH3Matches) {
        // Resource group already matched — keep all its endpoints.
        out.push(b);
      } else {
        // Resource not matched — keep endpoint only if its own heading matches.
        if (endpointMatches(b.heading, tokenSets)) out.push(b);
      }
    } else {
      out.push(b);
    }
  }
  return out;
}

function renderBlocks(blocks) {
  return blocks.map((b) => b.lines.join('\n')).join('\n');
}

// Count only the H3 resource groups and H4 endpoint headings INSIDE
// ## 4. Endpoints. Counting every H3/H4 in the whole file would include
// the global "## 3. Resources" section, which is always kept — that would
// make the fallback-no-matches branch unreachable.
function countMatches(blocks) {
  let resources = 0;
  let endpoints = 0;
  let insideEndpoints = false;
  for (const b of blocks) {
    if (b.level === 2) {
      insideEndpoints = /^4\.\s*Endpoints/i.test(String(b.heading)) || b.heading === ENDPOINTS_H2_PREFIX;
      continue;
    }
    if (!insideEndpoints) continue;
    if (b.level === 3) resources++;
    else if (b.level === 4) endpoints++;
  }
  return { resources, endpoints };
}

function computeHash(blocks) {
  const txt = blocks
    .filter((b) => b.level === 3 || b.level === 4)
    .map((b) => `${b.level}:${b.heading}`)
    .join('|');
  return crypto.createHash('sha256').update(txt).digest('hex').slice(0, 10);
}

function defaultContractsPath() {
  return path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'api-contracts.md');
}

function cmdSlice(args) {
  const milestone = args.milestone;
  if (!milestone) {
    console.error('slice requires --milestone M{n}');
    process.exit(1);
  }

  const files = splitList(args.files);
  const routes = splitList(args.routes);
  if (files.length === 0 && routes.length === 0) {
    console.error('slice requires --files <list> OR --routes <list> (or both)');
    process.exit(1);
  }

  const cwd = process.cwd();
  const contractsPath = args.contracts
    ? assertPathWithinProject(args.contracts, '--contracts')
    : defaultContractsPath();

  const outDir = path.join(cwd, '_cobolt-output', 'latest', 'build', milestone);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  if (args.out) assertPathWithinProject(args.out, '--out');

  if (!fs.existsSync(contractsPath)) {
    const stubPath = args.out ? path.resolve(args.out) : path.join(outDir, 'api-contracts-slice-missing.md');
    const stub =
      `# API Contracts Slice — ${milestone}\n\n` +
      `## Slice Status\n\n` +
      `- **Source:** ${contractsPath}\n` +
      `- **Status:** FALLBACK — source contracts not found\n` +
      `- **Reason:** Orchestrator should either regenerate planning artifact or inject the PRD FR sections instead.\n`;
    atomicWrite(stubPath, stub, { mode: 0o600 });
    const trace = {
      tool: 'cobolt-api-contracts-slice',
      milestone,
      status: 'fallback-missing-contracts',
      contractsPath,
      outPath: stubPath,
      requestedFiles: files,
      requestedRoutes: routes,
      emittedAt: new Date().toISOString(),
    };
    atomicWriteJSON(`${stubPath}.trace.json`, trace, { mode: 0o600 });
    console.log(stubPath);
    return;
  }

  const content = fs.readFileSync(contractsPath, 'utf8');
  const allBlocks = parseBlocks(content);
  const allCounts = countMatches(allBlocks);

  const tokenSets = [];
  for (const f of files) tokenSets.push(candidateResourceTokens(f));
  for (const r of routes) tokenSets.push(routeTokens(r));

  const filtered = filterBlocks(allBlocks, tokenSets);
  const filteredCounts = countMatches(filtered);

  let finalBlocks = filtered;
  let status = 'sliced';
  if (filteredCounts.endpoints === 0 && filteredCounts.resources === 0) {
    finalBlocks = allBlocks;
    status = 'fallback-no-matches';
  }

  const rendered = renderBlocks(finalBlocks);
  const hash = computeHash(finalBlocks);
  const outPath = args.out ? path.resolve(args.out) : path.join(outDir, `api-contracts-slice-${hash}.md`);

  atomicWrite(outPath, rendered, { mode: 0o600 });

  const trace = {
    tool: 'cobolt-api-contracts-slice',
    milestone,
    status,
    contractsPath,
    outPath,
    requestedFiles: files,
    requestedRoutes: routes,
    resourcesTotal: allCounts.resources,
    endpointsTotal: allCounts.endpoints,
    resourcesMatched: filteredCounts.resources,
    endpointsMatched: filteredCounts.endpoints,
    sliceBytes: Buffer.byteLength(rendered, 'utf8'),
    sourceBytes: Buffer.byteLength(content, 'utf8'),
    reductionPercent: content.length > 0 ? Math.round((1 - rendered.length / content.length) * 100) : 0,
    hash,
    emittedAt: new Date().toISOString(),
  };
  atomicWriteJSON(`${outPath}.trace.json`, trace, { mode: 0o600 });

  console.log(outPath);
  if (process.env.COBOLT_API_CONTRACTS_VERBOSE === '1') {
    console.error(
      `[api-contracts-slice] ${status} — ${filteredCounts.endpoints}/${allCounts.endpoints} endpoints, ${trace.reductionPercent}% reduction`,
    );
  }
}

function main() {
  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);
  switch (command) {
    case 'slice':
      return cmdSlice(args);
    default:
      console.error(
        'Usage: cobolt-api-contracts-slice.js slice --milestone M{n} --files <paths> [--routes <paths>] [--contracts <path>] [--out <path>]\n' +
          '  Produces an endpoint-scoped api-contracts slice. Falls back to full contracts on zero matches. Fallback-missing-contracts stub when source is absent.',
      );
      process.exit(1);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`[api-contracts-slice] ERROR: ${e.message}`);
    process.exit(1);
  }
}

module.exports = {
  parseBlocks,
  filterBlocks,
  candidateResourceTokens,
  routeTokens,
  resourceMatches,
  endpointMatches,
  renderBlocks,
  GLOBAL_H2,
};
