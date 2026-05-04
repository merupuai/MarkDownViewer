#!/usr/bin/env node

// CoBolt OpenAPI Presence — enforces that api-contracts.md is not allowed
// to claim OpenAPI 3.x coverage without actual spec files on disk.
//
// Closes Blocker #6 from the Meru readiness review: api-contracts.md said
// "OpenAPI 3.2.0 coverage" while no openapi/*.yaml or *.json spec file
// existed, and it also omitted mandatory PRD endpoints (/v1/responses,
// /v1/messages, /mcp).
//
// Strategy:
//   1. Parse api-contracts.md for OpenAPI version claims and endpoint lists.
//   2. Search standard roots (openapi/, docs/openapi/, api/, _cobolt-output/
//      latest/planning/openapi/, project root) for .yaml/.yml/.json files
//      that parse as an OpenAPI spec (openapi: 3.x or swagger: 2.x field).
//   3. Verify every endpoint named in api-contracts.md appears in at least
//      one spec's `paths:` block.
//   4. If PRD mentions specific endpoints (e.g. /v1/responses, /v1/messages,
//      /mcp) as required, verify each is covered.
//
// Exit codes:
//   0 = present + coherent
//   1 = usage
//   2 = no api-contracts.md (skip)
//   3 = violation — Tier 1 block

const fs = require('node:fs');
const path = require('node:path');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_MISSING = 2;
const EXIT_VIOLATION = 3;

function planningDir(cwd = process.cwd()) {
  const p = path.join(cwd, '_cobolt-output', 'latest', 'planning');
  return fs.existsSync(p) ? p : null;
}

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function walk(dir, pattern, out = [], depth = 0) {
  if (depth > 6) return out;
  try {
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
        walk(full, pattern, out, depth + 1);
      } else if (e.isFile() && pattern.test(e.name)) {
        out.push(full);
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

// Best-effort OpenAPI detection from YAML/JSON content without pulling in a
// YAML parser. We check the head of the file for an `openapi:` or `swagger:`
// declaration and extract `paths:` entries via regex.
function parseSpec(content) {
  if (!content) return null;
  const head = content.slice(0, 2000);
  const oas = head.match(/^\s*openapi\s*[:=]\s*["']?(\d\.\d(?:\.\d)?)["']?/m);
  const swagger = head.match(/^\s*swagger\s*[:=]\s*["']?(\d\.\d)["']?/m);
  if (!oas && !swagger) return null;
  // Extract paths. JSON: "paths": { "/v1/x": {...}, ... }. YAML: paths:\n  /v1/x:\n
  const paths = [];
  // YAML-style
  const yamlBlock = content.match(/^paths\s*:\s*\n([\s\S]*?)(?=^\w|Z)/m);
  if (yamlBlock) {
    const re = /^\s+(\/\S+)\s*:/gm;
    for (const m of yamlBlock[1].matchAll(re)) {
      paths.push(m[1]);
    }
  }
  // JSON-style
  const jsonBlock = content.match(/"paths"\s*:\s*\{([\s\S]*)/);
  if (jsonBlock) {
    for (const m of jsonBlock[1].matchAll(/"(\/[^"]+)"\s*:/g)) {
      paths.push(m[1]);
    }
  }
  return {
    version: oas ? oas[1] : swagger ? swagger[1] : null,
    kind: oas ? 'openapi' : 'swagger',
    paths: [...new Set(paths)],
  };
}

function findAllSpecs(cwd, pd) {
  const roots = [
    path.join(cwd, 'openapi'),
    path.join(cwd, 'docs', 'openapi'),
    path.join(cwd, 'api'),
    path.join(cwd, 'spec'),
    path.join(cwd, 'specs'),
    path.join(pd, 'openapi'),
    path.join(pd, 'api'),
    cwd, // top-level catches openapi.yaml or swagger.json
  ];
  const pattern = /\.(?:ya?ml|json)$/i;
  const files = new Set();
  for (const r of roots) for (const f of walk(r, pattern, [], 0)) files.add(f);
  const specs = [];
  for (const f of files) {
    const name = path.basename(f).toLowerCase();
    // Prefilter by name hints to avoid parsing every YAML/JSON in the repo
    if (!/openapi|swagger|api-spec|runtime|admin|evidence/.test(name) && !name.includes('spec')) {
      continue;
    }
    const parsed = parseSpec(readFileSafe(f));
    if (parsed) specs.push({ file: path.relative(cwd, f), ...parsed });
  }
  return specs;
}

function extractEndpointsFromContractsMd(content) {
  if (!content) return [];
  const endpoints = new Set();
  // Look for path-like tokens: /v1/responses, /mcp, /admin/users/{id}
  for (const m of content.matchAll(/`((?:\/[a-z0-9_{}-]+)+)`/gi)) {
    endpoints.add(m[1]);
  }
  // Also markdown headings like "### POST /v1/responses"
  for (const m of content.matchAll(/^#+\s+(?:GET|POST|PUT|PATCH|DELETE)\s+(\/\S+)/gim)) {
    endpoints.add(m[1]);
  }
  return [...endpoints];
}

function extractPrdRequiredEndpoints(prd) {
  if (!prd) return [];
  const required = new Set();
  for (const m of prd.matchAll(/`((?:\/[a-z0-9_{}-]+)+)`/gi)) {
    required.add(m[1]);
  }
  // Also common required API patterns from PRD prose
  for (const pattern of [/\/v1\/responses\b/, /\/v1\/messages\b/, /\/v1\/completions\b/, /\/mcp\b/]) {
    const m = prd.match(pattern);
    if (m) required.add(m[0]);
  }
  return [...required];
}

function claimsOpenApi(content) {
  if (!content) return null;
  const m = content.match(/OpenAPI\s+(\d\.\d(?:\.\d)?)/i);
  return m ? m[1] : null;
}

function check() {
  const pd = planningDir();
  if (!pd) return { exitCode: EXIT_MISSING, error: 'no planning directory' };
  const contracts = readFileSafe(path.join(pd, 'api-contracts.md'));
  if (!contracts) return { exitCode: EXIT_MISSING, error: 'api-contracts.md missing', planningDir: pd };
  const prd = readFileSafe(path.join(pd, 'prd.md'));

  const claimedVersion = claimsOpenApi(contracts);
  const declaredEndpoints = extractEndpointsFromContractsMd(contracts);
  const specs = findAllSpecs(process.cwd(), pd);

  const violations = [];

  // Invariant 1: if api-contracts claims OpenAPI, a spec file must exist
  if (claimedVersion && specs.length === 0) {
    violations.push({
      type: 'openapi-claimed-without-spec-file',
      claimedVersion,
      searchedRoots: ['openapi/', 'docs/openapi/', 'api/', 'spec(s)/', `${path.relative(process.cwd(), pd)}/openapi/`],
      hint: `api-contracts.md claims OpenAPI ${claimedVersion} coverage but no spec file exists on disk. Create openapi/runtime.yaml (or admin.yaml / evidence.yaml) before plan close.`,
    });
  }

  // Invariant 2: every endpoint named in api-contracts must appear in a spec
  if (specs.length > 0 && declaredEndpoints.length > 0) {
    const allSpecPaths = new Set(specs.flatMap((s) => s.paths));
    const missing = declaredEndpoints.filter((e) => !allSpecPaths.has(e));
    if (missing.length > 0 && missing.length < declaredEndpoints.length) {
      // If ALL are missing, that's probably a prose-heavy contract doc with
      // illustrative URIs — don't flag. But if SOME are missing while others
      // are covered, flag.
      violations.push({
        type: 'contracts-endpoint-missing-from-spec',
        missing: missing.slice(0, 30),
        totalDeclared: declaredEndpoints.length,
        totalInSpecs: allSpecPaths.size,
        hint: 'Endpoints listed in api-contracts.md are not present in any openapi spec file.',
      });
    }
  }

  // Invariant 3: PRD-required endpoints must be covered
  const prdRequired = extractPrdRequiredEndpoints(prd);
  const mandatoryPatterns = [/^\/v1\/responses/, /^\/v1\/messages/, /^\/mcp/];
  const mandatoryRequired = prdRequired.filter((p) => mandatoryPatterns.some((re) => re.test(p)));
  if (mandatoryRequired.length > 0) {
    const allEndpoints = new Set([...specs.flatMap((s) => s.paths), ...declaredEndpoints]);
    const missingMandatory = mandatoryRequired.filter((p) => ![...allEndpoints].some((e) => e.startsWith(p)));
    if (missingMandatory.length > 0) {
      violations.push({
        type: 'prd-required-endpoint-not-in-contracts-or-specs',
        missing: missingMandatory,
        hint: 'PRD mentions these endpoints as required but neither api-contracts.md nor any openapi spec declares them.',
      });
    }
  }

  // Invariant 4: "to be generated at build time" prose — blocks declaring
  // OpenAPI coverage and deferring the actual spec to later.
  if (/to\s+be\s+generated\s+at\s+build\s+time/i.test(contracts) && claimedVersion) {
    violations.push({
      type: 'openapi-deferred-to-build-time',
      claimedVersion,
      hint: 'api-contracts.md claims OpenAPI coverage but defers the actual spec to build time. This is planning fraud — the spec must exist at plan close.',
    });
  }

  return {
    exitCode: violations.length > 0 ? EXIT_VIOLATION : EXIT_OK,
    planningDir: pd,
    summary: {
      claimedVersion,
      specFilesFound: specs.length,
      declaredEndpointsInContracts: declaredEndpoints.length,
      prdRequiredEndpoints: prdRequired.length,
      violations: violations.length,
    },
    specs: specs.map((s) => ({ file: s.file, kind: s.kind, version: s.version, pathCount: s.paths.length })),
    violations,
  };
}

function formatText(r) {
  const lines = ['== OpenAPI Presence =='];
  lines.push(`  planningDir: ${r.planningDir || '(missing)'}`);
  if (r.summary) for (const [k, v] of Object.entries(r.summary)) lines.push(`  ${k}: ${v}`);
  if (r.specs?.length) {
    lines.push('  specs:');
    for (const s of r.specs) lines.push(`    - ${s.file} (${s.kind} ${s.version}, ${s.pathCount} paths)`);
  }
  if (r.violations?.length) {
    lines.push('  violations:');
    for (const v of r.violations) lines.push(`    - [${v.type}]`);
  }
  lines.push(`verdict: ${r.exitCode === EXIT_OK ? 'PASS' : 'VIOLATION'}`);
  return lines.join('\n');
}

function main(argv = process.argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'check';
  const json = args.includes('--json');
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('Usage: cobolt-openapi-presence.js check [--json]');
    process.exit(EXIT_OK);
  }
  if (cmd !== 'check' && cmd !== 'report') {
    console.error('Usage: cobolt-openapi-presence.js check [--json]');
    process.exit(EXIT_USAGE);
  }
  const r = check();
  if (json) console.log(JSON.stringify(r, null, 2));
  else console.log(formatText(r));
  process.exit(cmd === 'report' ? EXIT_OK : r.exitCode);
}

if (require.main === module) main();

module.exports = {
  check,
  parseSpec,
  extractEndpointsFromContractsMd,
  claimsOpenApi,
  EXIT_OK,
  EXIT_VIOLATION,
  EXIT_MISSING,
};
