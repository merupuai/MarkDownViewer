#!/usr/bin/env node

// CoBolt FR-Surface Census Tool — v0.39.0.
//
// Deterministic check: for every FR in prd.md that declares an HTTP endpoint
// (verb + path), verify the codebase contains a matching route registration
// in a supported router framework. Produces:
//
//   _cobolt-output/latest/planning/fr-surface-census.json
//   {
//     "capturedAt": "...",
//     "frTotal": N,
//     "frWithHttpSurface": N,
//     "frMatched": N,
//     "frUnmatched": [{"fr":"FR-001","declared":["POST /v1/chat/completions"],"missing":["POST /v1/chat/completions"]}, ...],
//     "routerFiles": ["apps/meru_runtime/lib/meru/router.ex", ...],
//     "verdict": "PASS" | "FAIL"
//   }
//
// Closes the Meru M1 HTTP-surface incident class: FR-001 declared five
// `/v1/...` endpoints but no code defined Phoenix routes for any of them.
// This tool would have flagged all five as unmatched and failed the gate
// before M1 closed.
//
// Usage:
//   node tools/cobolt-fr-surface-census.js check
//   node tools/cobolt-fr-surface-census.js check --json
//   node tools/cobolt-fr-surface-census.js check --milestone M1   # scope to one milestone's FRs
//
// Exit codes:
//   0  PASS (every declared FR endpoint has a matching route)
//   1  internal error
//   3  no PRD / no router parsers available (missing infra)
//   4  FAIL (one or more FR endpoints unmatched)

const fs = require('node:fs');
const path = require('node:path');

const FR_ID_RE = /\bFR-\d{2,4}\b/g;

// --- PRD endpoint extraction ---------------------------------------------

function trimPath(p) {
  // Strip trailing sentence punctuation (., ,, ;, :, !, ?, )) so /v1/models.
  // in "expose POST /v1/models." normalizes to /v1/models.
  return p.replace(/[.,;:!?)\]]+$/, '');
}

function extractDeclaredEndpoints(prdText) {
  const byFr = new Map(); // fr -> Set of "VERB /path"
  const frPositions = [];
  for (const m of prdText.matchAll(FR_ID_RE)) {
    frPositions.push({ fr: m[0], idx: m.index });
  }

  const windowSize = 1200;
  for (const { fr, idx } of frPositions) {
    const window = prdText.slice(Math.max(0, idx - 200), Math.min(prdText.length, idx + windowSize));
    const set = byFr.get(fr) || new Set();

    // "POST /v1/chat/completions" or "GET /foo/bar" or "`POST /v1/x`" or "POST `/v1/x`"
    const verbPathRe = /\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b[\s`]*([/][A-Za-z0-9_\-/:{}]+)/g;
    for (const m of window.matchAll(verbPathRe)) {
      set.add(`${m[1].toUpperCase()} ${trimPath(m[2])}`);
    }

    // Bare paths near the FR that look like canonical API paths (/v1/..., /api/...)
    const barePathRe = /(?:^|\s|[`"])(\/(?:v\d+|api|admin|auth|internal|public)\/[A-Za-z0-9_\-/:{}]+)/g;
    for (const m of window.matchAll(barePathRe)) {
      // Add as ANY verb marker — will match any verb that hits the path
      set.add(`* ${trimPath(m[1])}`);
    }

    if (set.size > 0) byFr.set(fr, set);
  }

  return byFr;
}

// --- Router scanning ------------------------------------------------------

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '_build',
  'deps',
  '.elixir_ls',
  'target',
  'dist',
  '.cobolt-backups',
  '_cobolt-output',
  '_cobolt-docker',
  '.cobolt',
  '.codex',
  '.claude',
  'coverage',
  'public',
  'priv',
]);

function walkSource(root, maxDepth = 8) {
  const files = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (SKIP_DIRS.has(ent.name)) continue;
      if (ent.name.startsWith('.') && depth === 0) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      if (/\.(ex|exs|rb|py|js|ts|mjs|cjs|go|rs|java|kt|php)$/i.test(ent.name)) {
        files.push(full);
      }
    }
  }
  walk(root, 0);
  return files;
}

// Parsers — return array of {verb, path, framework, file, line}.
// A verb of '*' means "any".
const ROUTER_PARSERS = [
  // Phoenix / Plug Router: `get "/foo", Controller, :action` or `post "/v1/x", ...`
  {
    name: 'phoenix-plug',
    fileTest: (fp) => /\.ex$/i.test(fp),
    parse: (content, file) => {
      const routes = [];
      const re = /\b(get|post|put|delete|patch|head|options|match)\s+"((?:\/[^"\n]*))"/g;
      for (const m of content.matchAll(re)) {
        const verb = m[1].toLowerCase() === 'match' ? '*' : m[1].toUpperCase();
        routes.push({ verb, path: m[2], framework: 'phoenix/plug', file });
      }
      // forward/scope — forward "/api", ApiRouter maps all methods into a prefix.
      const fwd = /\bforward\s+"((?:\/[^"\n]*))",\s*([A-Z][\w.]*)/g;
      for (const m of content.matchAll(fwd)) {
        routes.push({ verb: '*', path: `${m[1]}/*`, framework: 'phoenix/plug', file });
      }
      return routes;
    },
  },
  // Express / Node: app.get('/foo', ...) | router.post("/v1/x", ...)
  {
    name: 'express',
    fileTest: (fp) => /\.(js|ts|mjs|cjs)$/i.test(fp),
    parse: (content, file) => {
      const routes = [];
      const re =
        /\b(?:app|router)\s*\.\s*(get|post|put|delete|patch|head|options|all|use)\s*\(\s*['"`]((?:\/[^'"`]*))['"`]/g;
      for (const m of content.matchAll(re)) {
        const verb = m[1].toLowerCase() === 'all' || m[1].toLowerCase() === 'use' ? '*' : m[1].toUpperCase();
        routes.push({ verb, path: m[2], framework: 'express', file });
      }
      return routes;
    },
  },
  // Rails: get '/foo', to: 'controller#action'  |  resources :foo
  {
    name: 'rails',
    fileTest: (fp) => /routes\.rb$/i.test(fp),
    parse: (content, file) => {
      const routes = [];
      const re = /\b(get|post|put|delete|patch|match)\s+['"]((?:\/[^'"]*))['"]/g;
      for (const m of content.matchAll(re)) {
        routes.push({
          verb: m[1].toLowerCase() === 'match' ? '*' : m[1].toUpperCase(),
          path: m[2],
          framework: 'rails',
          file,
        });
      }
      return routes;
    },
  },
  // FastAPI / Flask: @app.get('/foo')  |  @router.post("/v1/x")
  {
    name: 'fastapi-flask',
    fileTest: (fp) => /\.py$/i.test(fp),
    parse: (content, file) => {
      const routes = [];
      const re = /@\s*\w+\s*\.\s*(get|post|put|delete|patch|head|options|route)\s*\(\s*['"]((?:\/[^'"]*))['"]/g;
      for (const m of content.matchAll(re)) {
        const verb = m[1].toLowerCase() === 'route' ? '*' : m[1].toUpperCase();
        routes.push({ verb, path: m[2], framework: 'fastapi/flask', file });
      }
      return routes;
    },
  },
  // Go chi / gin / net/http: r.Get("/foo", ...)  |  r.HandleFunc("/foo", ...)
  {
    name: 'go-router',
    fileTest: (fp) => /\.go$/i.test(fp),
    parse: (content, file) => {
      const routes = [];
      const re = /\.\s*(Get|Post|Put|Delete|Patch|Head|Options|Handle|HandleFunc)\s*\(\s*"((?:\/[^"\n]*))"/g;
      for (const m of content.matchAll(re)) {
        const verb = /^(Handle|HandleFunc)$/.test(m[1]) ? '*' : m[1].toUpperCase();
        routes.push({ verb, path: m[2], framework: 'go', file });
      }
      return routes;
    },
  },
  // Axum / actix / rocket (Rust): .route("/foo", get(handler))  |  #[get("/foo")]
  {
    name: 'rust-router',
    fileTest: (fp) => /\.rs$/i.test(fp),
    parse: (content, file) => {
      const routes = [];
      const reRoute = /\.route\s*\(\s*"((?:\/[^"\n]*))"\s*,\s*(get|post|put|delete|patch)\s*\(/gi;
      for (const m of content.matchAll(reRoute)) {
        routes.push({ verb: m[2].toUpperCase(), path: m[1], framework: 'rust/axum', file });
      }
      const reMacro = /#\[\s*(get|post|put|delete|patch)\s*\(\s*"((?:\/[^"\n]*))"/gi;
      for (const m of content.matchAll(reMacro)) {
        routes.push({ verb: m[1].toUpperCase(), path: m[2], framework: 'rust/rocket', file });
      }
      return routes;
    },
  },
  // Java Spring: @RequestMapping("/foo")  |  @GetMapping("/foo")
  {
    name: 'spring',
    fileTest: (fp) => /\.(java|kt)$/i.test(fp),
    parse: (content, file) => {
      const routes = [];
      const re =
        /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\s*\(\s*(?:value\s*=\s*)?"((?:\/[^"\n]*))"/g;
      for (const m of content.matchAll(re)) {
        const verb = m[1] === 'RequestMapping' ? '*' : m[1].replace('Mapping', '').toUpperCase();
        routes.push({ verb, path: m[2], framework: 'spring', file });
      }
      return routes;
    },
  },
];

function scanRouters(root) {
  const files = walkSource(root);
  const allRoutes = [];
  const routerFiles = new Set();
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (content.length > 500_000) continue; // skip generated / bundled
    for (const parser of ROUTER_PARSERS) {
      if (!parser.fileTest(file)) continue;
      const routes = parser.parse(content, file);
      if (routes.length > 0) {
        allRoutes.push(...routes);
        routerFiles.add(file);
      }
    }
  }
  return { allRoutes, routerFiles: [...routerFiles] };
}

// --- Match declared against implemented ----------------------------------

function normalizePath(p) {
  return p
    .replace(/:\w+/g, '{}') // Rails/Express :id     → {}
    .replace(/\{[^}]*\}/g, '{}') // templated {id}        → {}
    .replace(/\*+/g, '*')
    .replace(/\/$/, '')
    .toLowerCase();
}

function pathMatches(declared, implemented) {
  const a = normalizePath(declared);
  const b = normalizePath(implemented);
  if (a === b) return true;
  // wildcard mount (e.g., forward "/api" + actual routes under it)
  if (b.endsWith('/*')) {
    const prefix = b.slice(0, -2);
    return a.startsWith(prefix);
  }
  return false;
}

function matchDeclaredToImplemented(declaredMap, implementedRoutes) {
  // declaredMap: Map<fr, Set<"VERB /path" | "* /path">>
  // implementedRoutes: [{verb, path, framework, file}]
  const result = {
    frTotal: declaredMap.size,
    frWithHttpSurface: 0,
    frMatched: 0,
    frUnmatched: [],
  };
  for (const [fr, declaredSet] of declaredMap.entries()) {
    if (declaredSet.size === 0) continue;
    result.frWithHttpSurface += 1;
    const declared = [...declaredSet];
    const missing = [];
    for (const d of declared) {
      const [verb, dPath] = d.split(' ');
      const matched = implementedRoutes.some((r) => {
        const verbOk = verb === '*' || r.verb === '*' || r.verb === verb;
        return verbOk && pathMatches(dPath, r.path);
      });
      if (!matched) missing.push(d);
    }
    if (missing.length === 0) {
      result.frMatched += 1;
    } else {
      result.frUnmatched.push({ fr, declared, missing });
    }
  }
  return result;
}

// --- CLI ------------------------------------------------------------------

function check(opts = {}) {
  const root = process.cwd();
  const prdPath = path.join(root, '_cobolt-output', 'latest', 'planning', 'prd.md');
  if (!fs.existsSync(prdPath)) {
    return { verdict: 'SKIP', reason: 'prd.md not present', prdPath };
  }
  const prd = fs.readFileSync(prdPath, 'utf8');
  let declaredMap = extractDeclaredEndpoints(prd);

  // Optional milestone scoping — restrict to FRs in milestone-tracker
  if (opts.milestone) {
    const mtPath = path.join(root, '_cobolt-output', 'latest', 'planning', 'milestone-tracker.json');
    if (fs.existsSync(mtPath)) {
      try {
        const mt = JSON.parse(fs.readFileSync(mtPath, 'utf8'));
        const milestones = Array.isArray(mt) ? mt : mt.milestones || [];
        const me = milestones.find((m) => m?.id === opts.milestone);
        const frIds = me?.frIds || me?.requirementIds?.filter((r) => /^FR-/.test(r)) || [];
        const scoped = new Map();
        for (const fr of frIds) {
          if (declaredMap.has(fr)) scoped.set(fr, declaredMap.get(fr));
        }
        declaredMap = scoped;
      } catch {
        /* fall through with full set */
      }
    }
  }

  const { allRoutes, routerFiles } = scanRouters(root);
  const match = matchDeclaredToImplemented(declaredMap, allRoutes);

  const report = {
    capturedAt: new Date().toISOString(),
    version: '0.39.0',
    tool: 'cobolt-fr-surface-census',
    scopedMilestone: opts.milestone || null,
    frTotal: match.frTotal,
    frWithHttpSurface: match.frWithHttpSurface,
    frMatched: match.frMatched,
    frUnmatched: match.frUnmatched,
    routerFiles,
    implementedRouteCount: allRoutes.length,
    verdict: match.frUnmatched.length === 0 ? 'PASS' : 'FAIL',
  };

  const outPath = path.join(root, '_cobolt-output', 'latest', 'planning', 'fr-surface-census.json');
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    report._writtenTo = outPath;
  } catch {
    /* output is still returned */
  }

  return report;
}

function printHuman(report) {
  const v = report.verdict;
  console.log(`FR-Surface Census — ${v}`);
  console.log(`  FRs with HTTP surface: ${report.frWithHttpSurface} / ${report.frTotal}`);
  console.log(`  Matched:               ${report.frMatched}`);
  console.log(`  Unmatched:             ${report.frUnmatched.length}`);
  console.log(`  Router files:          ${report.routerFiles.length}`);
  console.log(`  Implemented routes:    ${report.implementedRouteCount}`);
  if (report.frUnmatched.length > 0) {
    console.log('\nUnmatched FR endpoints:');
    for (const u of report.frUnmatched.slice(0, 20)) {
      console.log(`  - ${u.fr}: missing ${u.missing.join(', ')}`);
    }
    if (report.frUnmatched.length > 20) {
      console.log(`  ... (${report.frUnmatched.length - 20} more)`);
    }
  }
  if (report._writtenTo) console.log(`\nReport: ${report._writtenTo}`);
}

function main(argv) {
  const cmd = argv[2] || 'check';
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log('usage: cobolt-fr-surface-census check [--json] [--milestone M{n}]');
    return 0;
  }
  if (cmd !== 'check') {
    console.error(`unknown command: ${cmd}`);
    return 1;
  }
  const opts = {};
  let json = false;
  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === '--json') json = true;
    else if (argv[i] === '--milestone') {
      opts.milestone = argv[++i];
    }
  }

  let report;
  try {
    report = check(opts);
  } catch (e) {
    console.error(`cobolt-fr-surface-census: ${e.message}`);
    return 1;
  }

  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printHuman(report);

  if (report.verdict === 'SKIP') return 3;
  if (report.verdict === 'FAIL') return 4;
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = {
  check,
  extractDeclaredEndpoints,
  scanRouters,
  matchDeclaredToImplemented,
  pathMatches,
  normalizePath,
  ROUTER_PARSERS,
};
