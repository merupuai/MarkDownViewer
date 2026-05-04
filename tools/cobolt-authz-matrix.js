#!/usr/bin/env node

// CoBolt Authorization Matrix Producer
//
// Problem this closes:
//   Multiple gates (cobolt-authz-reviewer, security-authz-deep-reviewer,
//   authz-census hard gate) require `_cobolt-output/latest/planning/authz-matrix.json`.
//   No skill or tool currently produces it. Projects that declare multi-tenancy
//   or RBAC ship without the matrix and the gate falls back to a degraded path
//   that silently lets under-enforced endpoints through.
//
// What this tool does:
//   Derives authz-matrix.json deterministically from:
//     - prd.md                         (detect multi-tenancy + RBAC declarations)
//     - api-contracts.md               (enumerate endpoints)
//     - security-requirements.md       (extract role catalog + RBAC rules)
//     - feature-registry.json (opt.)   (map FEAT-NNN → endpoints)
//
//   The matrix is a contract — not an enforcement oracle. Agents enrich it
//   during build; this tool guarantees the baseline exists so gates can run.
//
// Usage:
//   node tools/cobolt-authz-matrix.js generate [--project <dir>] [--json] [--force]
//   node tools/cobolt-authz-matrix.js check    [--project <dir>] [--json]
//
// Exit codes:
//   0 = success (matrix exists and is valid, or was just generated)
//   1 = hard error
//   2 = missing required inputs (no api-contracts.md)
//   3 = project does not declare multi-tenancy/RBAC (tool is a no-op by design)

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ROLES = ['admin', 'operator', 'auditor', 'end-user'];

const MULTI_TENANCY_SIGNALS = [
  /\bmulti[-\s]?tenan(t|cy)\b/i,
  /\btenant\s*(isolation|scop(e|ed|ing)|lifecycle)\b/i,
  /\bper[-\s]tenant\b/i,
  /\bX-Meru-Tenant\b/i,
  /\btenant_id\b/i,
];

const RBAC_SIGNALS = [
  /\bRBAC\b/,
  /\brole[-\s]based access\b/i,
  /\brole\s+matrix\b/i,
  /\ba(uthorization|uthz)\s+matrix\b/i,
];

function parseArgs(argv) {
  const out = { command: 'generate', project: process.cwd(), json: false, force: false, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--json') out.json = true;
    else if (a === '--force') out.force = true;
    else if (a === '--project' || a === '--dir' || a === '--root') {
      out.project = argv[i + 1] || out.project;
      i += 1;
    } else if (a.startsWith('--project=')) out.project = a.slice('--project='.length);
    else if (a.startsWith('--')) out.unknown = a;
    else positional.push(a);
  }
  if (positional.length > 0) out.command = positional[0];
  return out;
}

function printUsage() {
  console.log('Usage: node tools/cobolt-authz-matrix.js [generate|check] [--project <dir>] [--json] [--force]');
  console.log();
  console.log('Deterministically produces _cobolt-output/latest/planning/authz-matrix.json from the');
  console.log('PRD + api-contracts + security-requirements when the project declares multi-tenancy or RBAC.');
}

function readOrNull(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function readJsonOrNull(p) {
  const text = readOrNull(p);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function resolvePlanningDir(projectRoot) {
  const candidates = [
    path.join(projectRoot, '_cobolt-output', 'latest', 'planning'),
    path.join(projectRoot, '_cobolt-output', 'planning'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function detectMultiTenancy(prdText) {
  return MULTI_TENANCY_SIGNALS.some((re) => re.test(prdText));
}

function detectRbac(prdText, secReqText) {
  const combined = `${prdText || ''}\n${secReqText || ''}`;
  return RBAC_SIGNALS.some((re) => re.test(combined));
}

function extractRoles(secReqText) {
  if (!secReqText) return [...DEFAULT_ROLES];
  const set = new Set();
  // Match role names inside RBAC tables (| admin |  | auditor |) or bullets (- admin:).
  const lines = secReqText.split(/\r?\n/);
  for (const line of lines) {
    const cleaned = line.trim();
    if (!cleaned) continue;
    // Markdown table row or bulleted role line.
    const bullet = cleaned.match(/^[-*]\s+\*?\*?([A-Za-z][A-Za-z0-9 _-]{2,40})\*?\*?\s*[:(]/);
    if (bullet) {
      const name = bullet[1].trim().toLowerCase().replace(/\s+/g, '-');
      if (name.length <= 40) set.add(name);
      continue;
    }
    const tableRow = cleaned.match(/^\|\s*([a-z][a-z0-9_-]{2,40})\s*\|/i);
    if (tableRow) {
      set.add(tableRow[1].toLowerCase());
    }
  }
  // Keep only plausible role tokens.
  const tokens = [...set].filter((r) => /^[a-z][a-z0-9_-]{2,40}$/i.test(r));
  // Always include defaults so gates never see an empty role list.
  for (const d of DEFAULT_ROLES) tokens.push(d);
  // Deduplicate preserving first-seen order.
  const ordered = [];
  const seen = new Set();
  for (const t of tokens) {
    if (!seen.has(t)) {
      seen.add(t);
      ordered.push(t);
    }
  }
  return ordered;
}

function extractEndpoints(apiContractsText) {
  // Parses rows like `| POST | /v1/chat/completions | …` — the same table
  // convention emitted by cobolt-create-api-contracts.
  const endpoints = [];
  if (!apiContractsText) return endpoints;
  const seen = new Set();
  const rowRegex = /^\|\s*(GET|POST|PUT|PATCH|DELETE|WS|WEBSOCKET)\s*\|\s*`?([^|`]+?)`?\s*\|\s*([^|]+?)\s*\|/gim;
  for (const m of apiContractsText.matchAll(rowRegex)) {
    const method = m[1].toUpperCase();
    const route = m[2].trim();
    const purpose = m[3].trim();
    const key = `${method} ${route}`;
    if (seen.has(key)) continue;
    seen.add(key);
    endpoints.push({ method, path: route, purpose });
  }
  return endpoints;
}

// Fallback: some producers emit admin endpoints as a "Resource family | Path prefix | FEAT" table
// rather than the runtime method+path table. Test3 shipped this pattern. When the primary
// extractor yields 0 admin endpoints but admin routes are clearly declared in prose, this fallback
// parser synthesizes endpoints so the downstream authz-reviewer / authz-gate see a non-empty
// admin surface. Synthesized endpoints are tagged `inferredFromPrefixFamily: true` so consumers
// can distinguish them from agent-authored rows.
function extractPrefixFamilyAdminEndpoints(apiContractsText) {
  const endpoints = [];
  if (!apiContractsText) return endpoints;

  // Walk line-by-line looking for rows whose middle cell contains at least one /admin/*
  // path reference. This matches the Test3 3-column table without locking in on exact headers
  // (producers may name columns "Resource", "Path prefix", "FEAT", etc.).
  const lines = apiContractsText.split(/\r?\n/);
  const seenPaths = new Set();

  for (const rawLine of lines) {
    if (!rawLine.includes('|') || !rawLine.includes('/admin/')) continue;
    const cells = rawLine.split('|').map((c) => c.trim());
    // Skip markdown header-separator rows (all dashes).
    if (cells.every((c) => /^-+$/.test(c) || c === '')) continue;
    if (cells.length < 3) continue;

    // Strip parenthetical notes like "(POST requires MFA ...)" from the path cell.
    const pathCell = cells
      .slice(1, -1)
      .join(' ')
      .replace(/\([^)]*\)/g, ' ');
    const family = cells[1] || '';
    const featCell = cells[cells.length - 1] || '';
    const feats = [...featCell.matchAll(/\bFEAT-\d{3}\b/g)].map((m) => m[0]);

    // Extract every /admin/... token from the path cell. Commas inside brace groups
    // (e.g. /admin/v1/{users,roles,service-accounts}) must not split the token; only
    // commas OUTSIDE braces separate paths.
    const rawPaths = [];
    const stripped = pathCell.replace(/`/g, ' ');
    // Match /admin/... greedily, tolerating braces; terminate at whitespace, backtick,
    // top-level comma (comma not inside braces), or end of string.
    let pos = 0;
    while (pos < stripped.length) {
      const slashIdx = stripped.indexOf('/admin/', pos);
      if (slashIdx === -1) break;
      let end = slashIdx;
      let depth = 0;
      while (end < stripped.length) {
        const ch = stripped[end];
        if (ch === '{') depth += 1;
        else if (ch === '}') depth = Math.max(0, depth - 1);
        else if (depth === 0 && /[\s`,;]/.test(ch)) break;
        end += 1;
      }
      const token = stripped.slice(slashIdx, end).trim();
      if (token) rawPaths.push(token);
      pos = end + 1;
    }

    const expanded = [];
    for (const raw of rawPaths) {
      // Brace expansion: /admin/v1/{a,b,c} → 3 paths.
      const braceMatch = raw.match(/^(.*?)\{([^}]+)\}(.*)$/);
      if (braceMatch) {
        for (const piece of braceMatch[2].split(',')) {
          expanded.push(`${braceMatch[1]}${piece.trim()}${braceMatch[3]}`);
        }
      } else {
        expanded.push(raw);
      }
    }

    for (const route of expanded) {
      if (!/^\/admin\//i.test(route)) continue;
      // Drop trailing commas / whitespace / stray punctuation.
      const cleanRoute = route.replace(/[,;)]+$/g, '').trim();
      if (!cleanRoute || seenPaths.has(cleanRoute)) continue;
      seenPaths.add(cleanRoute);
      endpoints.push({
        method: 'ANY',
        path: cleanRoute,
        purpose: family,
        features: feats,
        inferredFromPrefixFamily: true,
      });
    }
  }

  return endpoints;
}

function classifyEndpointScope(route) {
  const lower = route.toLowerCase();
  if (lower.startsWith('/admin/')) return 'admin';
  if (lower.startsWith('/internal/')) return 'internal';
  if (lower.includes('kill-switch') || lower.includes('dsar')) return 'sensitive';
  if (lower.startsWith('/mcp/')) return 'mcp-proxy';
  if (lower.startsWith('/v1/') || lower.startsWith('/api/')) return 'runtime';
  return 'public';
}

function defaultRolesForScope(scope, roles) {
  switch (scope) {
    case 'admin':
      return roles.filter((r) => r === 'admin' || r === 'operator');
    case 'internal':
      return ['admin'];
    case 'sensitive':
      return ['admin'];
    case 'mcp-proxy':
      return roles.filter((r) => r === 'end-user' || r === 'admin' || r === 'operator');
    case 'runtime':
      return roles.filter((r) => r !== 'auditor');
    default:
      return roles;
  }
}

function buildMatrix(projectRoot) {
  const planningDir = resolvePlanningDir(projectRoot);
  if (!planningDir) {
    return { ok: false, code: 2, error: 'No planning dir under _cobolt-output/' };
  }
  const prdText = readOrNull(path.join(planningDir, 'prd.md')) || '';
  const apiContractsText = readOrNull(path.join(planningDir, 'api-contracts.md'));
  const secReqText = readOrNull(path.join(planningDir, 'security-requirements.md'));
  const featureRegistry = readJsonOrNull(path.join(planningDir, 'feature-registry.json'));

  const multiTenant = detectMultiTenancy(prdText);
  const rbac = detectRbac(prdText, secReqText);
  if (!multiTenant && !rbac) {
    return {
      ok: false,
      code: 3,
      error: 'Project does not declare multi-tenancy or RBAC — authz-matrix is not required',
      planningDir,
    };
  }

  if (!apiContractsText) {
    return {
      ok: false,
      code: 2,
      error: 'api-contracts.md missing — cannot derive endpoint authorization matrix',
      planningDir,
    };
  }

  const roles = extractRoles(secReqText);
  const primaryEndpoints = extractEndpoints(apiContractsText);
  const primaryHasAdmin = primaryEndpoints.some((ep) => classifyEndpointScope(ep.path) === 'admin');
  const endpoints = [...primaryEndpoints];

  // v0.40.9 Fix B1: when the primary extractor finds zero admin rows but the
  // source text clearly declares /admin/* paths, fall back to the prefix-family
  // parser so admin endpoints are not silently missing from the matrix.
  let adminCoverageStatus = 'full';
  let inferredAdmin = [];
  const apiTextLower = apiContractsText.toLowerCase();
  const adminMentionedInText = /\s\/admin\//.test(` ${apiTextLower} `) || apiTextLower.includes('/admin/');

  if (!primaryHasAdmin && adminMentionedInText) {
    inferredAdmin = extractPrefixFamilyAdminEndpoints(apiContractsText);
    if (inferredAdmin.length > 0) {
      adminCoverageStatus = 'inferred';
      for (const ep of inferredAdmin) endpoints.push(ep);
    } else {
      adminCoverageStatus = 'unparseable';
    }
  } else if (!adminMentionedInText) {
    adminCoverageStatus = 'n/a';
  }

  if (endpoints.length === 0) {
    return {
      ok: false,
      code: 2,
      error: 'No endpoints parsed from api-contracts.md — verify endpoint table formatting',
      planningDir,
    };
  }

  const featIndexByPath = new Map();
  if (Array.isArray(featureRegistry?.features)) {
    for (const feat of featureRegistry.features) {
      const featId = feat.id || feat.featureId;
      for (const api of feat.apis || feat.endpoints || []) {
        const route = typeof api === 'string' ? api : api.path;
        if (!route) continue;
        const key = route.toLowerCase();
        if (!featIndexByPath.has(key)) featIndexByPath.set(key, []);
        featIndexByPath.get(key).push(featId);
      }
    }
  }

  const entries = endpoints.map((ep) => {
    const scope = classifyEndpointScope(ep.path);
    const requiredRoles = defaultRolesForScope(scope, roles);
    const featMatches = featIndexByPath.get(ep.path.toLowerCase()) || [];
    const features = ep.features && ep.features.length > 0 ? ep.features : featMatches;
    const entry = {
      method: ep.method,
      path: ep.path,
      scope,
      purpose: ep.purpose || null,
      requiredRoles,
      authenticated: scope !== 'public',
      tenantScoped: multiTenant,
      features,
      enforcementStatus: 'declared',
      notes: scope === 'sensitive' ? 'MFA step-up required — verify in build' : null,
    };
    if (ep.inferredFromPrefixFamily) entry.inferredFromPrefixFamily = true;
    return entry;
  });

  const matrix = {
    $schema: 'https://github.com/merupuai/cobolt/schemas/authz-matrix.json',
    version: 1,
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-authz-matrix',
    multiTenant,
    rbac,
    roles,
    defaultDenyPosture: true,
    endpoints: entries,
    coverage: {
      totalEndpoints: entries.length,
      authenticatedEndpoints: entries.filter((e) => e.authenticated).length,
      adminScopedEndpoints: entries.filter((e) => e.scope === 'admin').length,
      sensitiveEndpoints: entries.filter((e) => e.scope === 'sensitive').length,
      adminCoverageStatus,
      inferredAdminEndpoints: entries.filter((e) => e.inferredFromPrefixFamily === true).length,
    },
  };

  return { ok: true, planningDir, matrix };
}

function writeMatrix(planningDir, matrix) {
  const outPath = path.join(planningDir, 'authz-matrix.json');
  fs.writeFileSync(outPath, `${JSON.stringify(matrix, null, 2)}\n`, 'utf8');
  return outPath;
}

function generate(projectRoot, { force = false } = {}) {
  const outPath = path.join(resolvePlanningDir(projectRoot) || '', 'authz-matrix.json');
  if (!force && outPath && fs.existsSync(outPath) && fs.statSync(outPath).size > 200) {
    const existing = readJsonOrNull(outPath);
    if (existing && Array.isArray(existing.endpoints) && existing.endpoints.length > 0) {
      return {
        ok: true,
        skipped: true,
        reason: 'authz-matrix.json already present with endpoints — pass --force to regenerate',
        outPath,
      };
    }
  }
  const built = buildMatrix(projectRoot);
  if (!built.ok) return built;
  const written = writeMatrix(built.planningDir, built.matrix);
  return { ok: true, outPath: written, coverage: built.matrix.coverage };
}

function check(projectRoot) {
  const planningDir = resolvePlanningDir(projectRoot);
  const report = { ok: false, planningDir };
  if (!planningDir) {
    report.error = 'No planning dir under _cobolt-output/';
    return report;
  }
  const matrix = readJsonOrNull(path.join(planningDir, 'authz-matrix.json'));
  if (!matrix) {
    report.error = 'authz-matrix.json missing';
    return report;
  }
  report.ok = Array.isArray(matrix.endpoints) && matrix.endpoints.length > 0;
  report.endpoints = matrix.endpoints?.length || 0;
  report.multiTenant = matrix.multiTenant === true;
  report.rbac = matrix.rbac === true;
  report.roles = Array.isArray(matrix.roles) ? matrix.roles.length : 0;
  return report;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printUsage();
    return 0;
  }
  if (args.unknown) {
    console.error(`Unknown option: ${args.unknown}`);
    printUsage();
    return 1;
  }
  if (!['generate', 'check'].includes(args.command)) {
    console.error(`Unknown command: ${args.command}`);
    printUsage();
    return 1;
  }

  const report = args.command === 'generate' ? generate(args.project, { force: args.force }) : check(args.project);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.ok) {
    if (report.skipped) {
      console.log(`authz-matrix.json already present: ${report.outPath}`);
    } else if (args.command === 'generate') {
      console.log(
        `authz-matrix.json written: ${report.outPath} (endpoints=${report.coverage.totalEndpoints}, admin=${report.coverage.adminScopedEndpoints}, sensitive=${report.coverage.sensitiveEndpoints})`,
      );
    } else {
      console.log(
        `authz-matrix.json is valid — endpoints=${report.endpoints}, multiTenant=${report.multiTenant}, roles=${report.roles}`,
      );
    }
  } else {
    console.error(`authz-matrix.js ${args.command} failed: ${report.error}`);
  }

  if (!report.ok) {
    if (report.code === 3) return 3;
    if (report.code === 2) return 2;
    return 1;
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  DEFAULT_ROLES,
  buildMatrix,
  generate,
  check,
  extractEndpoints,
  extractPrefixFamilyAdminEndpoints,
  extractRoles,
  classifyEndpointScope,
  defaultRolesForScope,
  detectMultiTenancy,
  detectRbac,
  resolvePlanningDir,
  main,
};
