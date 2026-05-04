#!/usr/bin/env node

// CoBolt API Contract Validator — Deterministic OpenAPI/Swagger spec vs code validator
//
// Parses OpenAPI/Swagger specs and validates API endpoints against actual code routes.
// Detects undocumented endpoints, spec drift, missing error responses, and schema gaps.
//
// No LLM inference. Pure file parsing. Runs in <10 seconds.
//
// Usage:
//   node tools/cobolt-api-contract-validator.js validate                   # Auto-detect spec + routes
//   node tools/cobolt-api-contract-validator.js validate --spec path       # Explicit spec path
//   node tools/cobolt-api-contract-validator.js validate --json            # Machine-readable output
//   node tools/cobolt-api-contract-validator.js validate --save            # Save report to _cobolt-output
//
// Exit codes:
//   0 = pass (score >= 90)
//   1 = contract violations found (score < 90) or error
//   2 = usage error

const fs = require('node:fs');
const path = require('node:path');

// ── Path Resolution ─────────────────────────────────────────

const { paths: _paths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();

function reviewDir(projectDir) {
  const p = typeof _paths === 'function' ? _paths(projectDir) : null;
  if (p) return p.review();
  return path.join(projectDir, '_cobolt-output/latest/review');
}

// ── Constants ───────────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '_build',
  'deps',
  'dist',
  'build',
  '.next',
  '_cobolt-output',
  '.claude',
  '.elixir_ls',
  '__pycache__',
  '.mypy_cache',
  'vendor',
  'coverage',
  '.nyc_output',
  'tmp',
  '.cache',
  'priv',
]);

const SPEC_FILENAMES = [
  'openapi.json',
  'openapi.yaml',
  'openapi.yml',
  'swagger.json',
  'swagger.yaml',
  'swagger.yml',
  'api-spec.json',
  'api-spec.yaml',
  'api-spec.yml',
];

const SPEC_SEARCH_DIRS = ['', 'docs', 'api', 'spec', 'config', 'src'];

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

const ROUTE_EXTENSIONS = [
  '.js',
  '.ts',
  '.mjs',
  '.cjs', // Node/Express/Fastify
  '.ex',
  '.exs', // Phoenix
  '.py', // FastAPI/Flask/Django
  '.go', // Go stdlib/Gin/Echo
];

// ── YAML Parser for OpenAPI ──────────────────────────────────
// Handles the subset needed for OpenAPI path/method extraction:
// - Nested objects with indentation
// - Keys containing slashes, braces, colons (e.g. /api/{id}, application/json:)
// - YAML sequences (- item)
// - Scalar values (strings, numbers, booleans)
// Falls back to JSON.parse for .json files.

function parseYamlLite(text) {
  const lines = text.split('\n');
  const root = {};
  const stack = [{ obj: root, indent: -1, isArray: false }];

  for (const raw of lines) {
    if (/^\s*#/.test(raw) || /^\s*$/.test(raw)) continue;
    const trimmed = raw.replace(/\s+$/, '');

    // Detect indent level
    const indentMatch = trimmed.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1].length : 0;
    const body = trimmed.slice(indent);

    // Pop stack to find parent at correct indent
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];

    // Sequence item: "- value" or "- key: value"
    if (body.startsWith('- ')) {
      const itemBody = body.slice(2).trim();
      if (Array.isArray(parent.obj)) {
        // Key-value inside sequence item
        const kvMatch = itemBody.match(/^(.+?):\s*(.*)$/);
        if (kvMatch) {
          const item = {};
          item[kvMatch[1].trim()] = parseYamlValue(kvMatch[2].trim());
          parent.obj.push(item);
          stack.push({ obj: item, indent: indent + 2, isArray: false });
        } else {
          parent.obj.push(parseYamlValue(itemBody));
        }
      }
      continue;
    }

    // Key-value pair: handle keys with slashes, braces, colons
    // Match everything up to the LAST ": " or ":" at end as the key-value separator
    const kvMatch = body.match(/^([^\s].*?):\s*(.*)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1].trim();
    const value = kvMatch[2].trim();

    if (value === '' || value === '|' || value === '>') {
      // Check if next non-empty line is a sequence
      const nextIdx = lines.indexOf(raw) + 1;
      let isSeq = false;
      for (let n = nextIdx; n < lines.length; n++) {
        const nextTrimmed = lines[n].trim();
        if (nextTrimmed === '' || nextTrimmed.startsWith('#')) continue;
        isSeq = nextTrimmed.startsWith('- ');
        break;
      }

      if (isSeq) {
        const arr = [];
        parent.obj[key] = arr;
        stack.push({ obj: arr, indent, isArray: true });
      } else {
        const child = {};
        parent.obj[key] = child;
        stack.push({ obj: child, indent, isArray: false });
      }
    } else {
      parent.obj[key] = parseYamlValue(value);
    }
  }
  return root;
}

function parseYamlValue(str) {
  if (!str) return '';
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    return str.slice(1, -1);
  }
  if (str === 'true') return true;
  if (str === 'false') return false;
  if (str === 'null') return null;
  if (/^\d+$/.test(str)) return parseInt(str, 10);
  if (/^\d+\.\d+$/.test(str)) return parseFloat(str);
  return str;
}

// ── Spec Discovery & Parsing ────────────────────────────────

function findSpec(projectDir, explicitPath) {
  if (explicitPath) {
    const abs = path.isAbsolute(explicitPath) ? explicitPath : path.join(projectDir, explicitPath);
    if (fs.existsSync(abs)) return abs;
    return null;
  }

  for (const dir of SPEC_SEARCH_DIRS) {
    for (const name of SPEC_FILENAMES) {
      const candidate = path.join(projectDir, dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function parseSpec(specPath) {
  const content = fs.readFileSync(specPath, 'utf8');
  const ext = path.extname(specPath).toLowerCase();

  let doc;
  if (ext === '.json') {
    doc = JSON.parse(content);
  } else {
    // YAML — try JSON first (some .yaml files are actually JSON)
    try {
      doc = JSON.parse(content);
    } catch {
      doc = parseYamlLite(content);
    }
  }
  return doc;
}

function extractSpecEndpoints(doc) {
  const endpoints = [];
  const paths = doc.paths || {};

  for (const [route, methods] of Object.entries(paths)) {
    if (typeof methods !== 'object' || methods === null) continue;

    for (const method of HTTP_METHODS) {
      const op = methods[method];
      if (!op || typeof op !== 'object') continue;

      const responses = op.responses || {};
      const responseKeys = Object.keys(responses);
      const has2xx = responseKeys.some((k) => /^2\d{2}$/.test(k) || k === 'default');
      const has4xx = responseKeys.some((k) => /^4\d{2}$/.test(k));
      const has5xx = responseKeys.some((k) => /^5\d{2}$/.test(k));
      const hasDescription = !!(op.description || op.summary);
      const _hasRequestBody = !!op.requestBody;
      const needsRequestBody = ['post', 'put', 'patch'].includes(method);

      const hasResponseSchema = responseKeys.some((k) => {
        const resp = responses[k];
        if (!resp || typeof resp !== 'object') return false;
        if (resp.content) return true;
        if (resp.schema) return true;
        return false;
      });

      const hasRequestSchema = (() => {
        if (!op.requestBody) return false;
        const rb = op.requestBody;
        if (rb.content) return true;
        if (rb.schema) return true;
        return false;
      })();

      // OpenAPI 2.x: parameters with in=body
      const params = op.parameters || [];
      const hasBodyParam = params.some((p) => p && p.in === 'body' && p.schema);

      endpoints.push({
        route: normalizePath(route),
        method: method.toUpperCase(),
        hasDescription,
        has2xx,
        has4xx,
        has5xx,
        hasResponseSchema,
        hasRequestSchema: hasRequestSchema || hasBodyParam,
        needsRequestBody,
        operationId: op.operationId || null,
        responseKeys,
      });
    }
  }
  return endpoints;
}

function normalizePath(p) {
  // Normalize path params: /users/{id} and /users/:id -> /users/:param
  return (
    p
      .replace(/\{[^}]+\}/g, ':param')
      .replace(/:[a-zA-Z_]\w*/g, ':param')
      .replace(/\/+/g, '/')
      .replace(/\/$/, '') || '/'
  );
}

// ── Route Extraction from Code ──────────────────────────────

function walkFiles(dir, extensions) {
  const results = [];

  function walk(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        results.push(full);
      }
    }
  }

  walk(dir);
  return results;
}

// Route extraction patterns per framework
const ROUTE_PATTERNS = [
  // Express/Koa/Hono: app.get('/path', ...), router.get('/path', ...)
  {
    ext: ['.js', '.ts', '.mjs', '.cjs'],
    regex: /\b(?:app|router|server|api)\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
    extract: (m) => ({ method: m[1].toUpperCase(), route: m[2] }),
  },
  // Express: app.route('/path').get(...).post(...)
  {
    ext: ['.js', '.ts', '.mjs', '.cjs'],
    regex: /\.route\s*\(\s*['"`]([^'"`]+)['"`]\s*\)\s*\.(get|post|put|patch|delete)/gi,
    extract: (m) => ({ method: m[2].toUpperCase(), route: m[1] }),
  },
  // Fastify: fastify.get('/path', ...)
  {
    ext: ['.js', '.ts', '.mjs', '.cjs'],
    regex: /\b(?:fastify|instance)\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
    extract: (m) => ({ method: m[1].toUpperCase(), route: m[2] }),
  },
  // Next.js API routes: export async function GET/POST/PUT/DELETE
  {
    ext: ['.js', '.ts', '.mjs', '.cjs'],
    regex: /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g,
    extract: (m, file) => {
      const parts = file.replace(/\\/g, '/').match(/app\/api\/(.+?)\/route\.[jt]sx?$/);
      const route = parts ? `/api/${parts[1]}` : '/unknown';
      return { method: m[1].toUpperCase(), route };
    },
  },
  // Phoenix: get "/path", ..., post "/path", ...
  {
    ext: ['.ex', '.exs'],
    regex: /\b(get|post|put|patch|delete|head|options)\s+["']([^"']+)["']/gi,
    extract: (m) => ({ method: m[1].toUpperCase(), route: m[2] }),
  },
  // FastAPI: @app.get("/path"), @router.get("/path")
  {
    ext: ['.py'],
    regex: /@\s*(?:app|router)\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
    extract: (m) => ({ method: m[1].toUpperCase(), route: m[2] }),
  },
  // Flask: @app.route("/path", methods=["GET"])
  {
    ext: ['.py'],
    regex: /@\s*(?:app|bp|blueprint)\s*\.route\s*\(\s*['"`]([^'"`]+)['"`](?:\s*,\s*methods\s*=\s*\[([^\]]+)\])?/gi,
    extract: (m) => {
      const methods = m[2]
        ? m[2]
            .replace(/['"` ]/g, '')
            .split(',')
            .map((s) => s.trim().toUpperCase())
        : ['GET'];
      return methods.map((method) => ({ method, route: m[1] }));
    },
  },
  // Go: http.HandleFunc("/path", handler)
  {
    ext: ['.go'],
    regex: /\b(?:http|mux|router)\.HandleFunc\s*\(\s*["']([^"']+)["']/gi,
    extract: (m) => ({ method: 'GET', route: m[1] }),
  },
  // Go Gin/Echo: r.GET("/path", handler)
  {
    ext: ['.go'],
    regex: /\b\w+\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(\s*["']([^"']+)["']/g,
    extract: (m) => ({ method: m[1].toUpperCase(), route: m[2] }),
  },
];

function extractCodeRoutes(projectDir) {
  const files = walkFiles(projectDir, ROUTE_EXTENSIONS);
  const routes = [];
  const seen = new Set();

  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const relFile = path.relative(projectDir, file);

    for (const pattern of ROUTE_PATTERNS) {
      if (!pattern.ext.some((ext) => file.endsWith(ext))) continue;
      if (!pattern.extract) continue;

      let match;
      pattern.regex.lastIndex = 0;

      while ((match = pattern.regex.exec(content)) !== null) {
        const result = pattern.extract(match, file);
        const items = Array.isArray(result) ? result : [result];

        for (const item of items) {
          const normalized = normalizePath(item.route);
          const key = `${item.method}:${normalized}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const beforeMatch = content.substring(0, match.index);
          const line = (beforeMatch.match(/\n/g) || []).length + 1;

          routes.push({
            method: item.method,
            route: normalized,
            rawRoute: item.route,
            file: relFile,
            line,
          });
        }
      }
    }
  }

  return routes;
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function hasApplicationImplementation(projectDir) {
  const manifests = ['package.json', 'mix.exs', 'go.mod', 'pyproject.toml', 'Cargo.toml'];
  if (manifests.some((name) => fs.existsSync(path.join(projectDir, name)))) return true;

  const appRoots = ['src', 'app', 'lib', 'server', 'backend', 'web', 'apps'];
  for (const rootName of appRoots) {
    const root = path.join(projectDir, rootName);
    if (!fs.existsSync(root)) continue;
    const files = walkFiles(root, ROUTE_EXTENSIONS).filter((file) => {
      const rel = path.relative(projectDir, file).replace(/\\/g, '/');
      return !rel.startsWith('tools/') && !rel.startsWith('_cobolt-output/');
    });
    if (files.length > 0) return true;
  }

  return false;
}

function isPreImplementationProject(projectDir) {
  const state = readJsonIfExists(path.join(projectDir, 'cobolt-state.json'));
  const greenfieldPlanning =
    state &&
    String(state.projectType || '').toLowerCase() === 'greenfield' &&
    /^S0$/i.test(String(state.currentStage || ''));

  return !!greenfieldPlanning && !hasApplicationImplementation(projectDir);
}

// ── Validation Logic ────────────────────────────────────────

function validate(projectDir, options) {
  options = options || {};
  const specPath = findSpec(projectDir, options.spec);
  const findings = [];
  let specEndpoints = [];
  let codeRoutes = [];
  let specFile = null;

  if (!specPath) {
    findings.push({
      id: 'ACV-001',
      type: 'missing-spec',
      severity: 'high',
      file: '',
      line: 0,
      message: `No OpenAPI/Swagger spec found. Searched: ${SPEC_FILENAMES.join(', ')}`,
      suggestion: 'Create an openapi.json or openapi.yaml in the project root or docs/ directory.',
    });
  } else {
    specFile = path.relative(projectDir, specPath);
    try {
      const doc = parseSpec(specPath);
      specEndpoints = extractSpecEndpoints(doc);
    } catch (err) {
      findings.push({
        id: 'ACV-002',
        type: 'spec-parse-error',
        severity: 'high',
        file: specFile,
        line: 0,
        message: `Failed to parse spec: ${err.message}`,
        suggestion: 'Validate the spec with spectral or swagger-cli.',
      });
    }
  }

  codeRoutes = extractCodeRoutes(projectDir);
  const preImplementationMode =
    specEndpoints.length > 0 && codeRoutes.length === 0 && isPreImplementationProject(projectDir);

  // Build lookup maps
  const specMap = new Map();
  for (const ep of specEndpoints) {
    specMap.set(`${ep.method}:${ep.route}`, ep);
  }

  const codeMap = new Map();
  for (const cr of codeRoutes) {
    codeMap.set(`${cr.method}:${cr.route}`, cr);
  }

  // ── Check 1: Undocumented endpoints (in code but not in spec) ──
  let counter = 10;
  for (const cr of codeRoutes) {
    const key = `${cr.method}:${cr.route}`;
    if (!specMap.has(key)) {
      findings.push({
        id: `ACV-${String(counter++).padStart(3, '0')}`,
        type: 'undocumented-endpoint',
        severity: 'medium',
        file: cr.file,
        line: cr.line,
        message: `${cr.method} ${cr.rawRoute} exists in code but is not documented in the spec.`,
        suggestion: `Add ${cr.method} ${cr.rawRoute} to the OpenAPI spec paths.`,
      });
    }
  }

  // ── Check 2: Phantom endpoints (in spec but not in code) ──
  if (!preImplementationMode) {
    for (const ep of specEndpoints) {
      const key = `${ep.method}:${ep.route}`;
      if (!codeMap.has(key)) {
        findings.push({
          id: `ACV-${String(counter++).padStart(3, '0')}`,
          type: 'phantom-endpoint',
          severity: 'medium',
          file: specFile || '',
          line: 0,
          message: `${ep.method} ${ep.route} is in spec but has no matching code route.`,
          suggestion: 'Implement the endpoint or remove it from the spec to avoid drift.',
        });
      }
    }
  }

  // ── Check 3: Missing error responses ──
  for (const ep of specEndpoints) {
    if (!ep.has4xx) {
      findings.push({
        id: `ACV-${String(counter++).padStart(3, '0')}`,
        type: 'missing-error-response',
        severity: 'low',
        file: specFile || '',
        line: 0,
        message: `${ep.method} ${ep.route} has no 4xx error response documented.`,
        suggestion: 'Add at least 400/404/422 responses for client error behavior.',
      });
    }
    if (!ep.has5xx) {
      findings.push({
        id: `ACV-${String(counter++).padStart(3, '0')}`,
        type: 'missing-error-response',
        severity: 'low',
        file: specFile || '',
        line: 0,
        message: `${ep.method} ${ep.route} has no 5xx error response documented.`,
        suggestion: 'Add a 500 response for server error behavior.',
      });
    }
  }

  // ── Check 4: Missing descriptions ──
  for (const ep of specEndpoints) {
    if (!ep.hasDescription) {
      findings.push({
        id: `ACV-${String(counter++).padStart(3, '0')}`,
        type: 'missing-description',
        severity: 'low',
        file: specFile || '',
        line: 0,
        message: `${ep.method} ${ep.route} has no description or summary.`,
        suggestion: 'Add a description or summary to help API consumers.',
      });
    }
  }

  // ── Check 5: Schema completeness ──
  for (const ep of specEndpoints) {
    if (!ep.hasResponseSchema && ep.has2xx) {
      findings.push({
        id: `ACV-${String(counter++).padStart(3, '0')}`,
        type: 'missing-response-schema',
        severity: 'medium',
        file: specFile || '',
        line: 0,
        message: `${ep.method} ${ep.route} has no response schema defined.`,
        suggestion: 'Add a JSON schema for type-safe client generation.',
      });
    }
    if (ep.needsRequestBody && !ep.hasRequestSchema) {
      findings.push({
        id: `ACV-${String(counter++).padStart(3, '0')}`,
        type: 'missing-request-schema',
        severity: 'medium',
        file: specFile || '',
        line: 0,
        message: `${ep.method} ${ep.route} accepts a body but has no request schema.`,
        suggestion: 'Add a requestBody schema to document the expected payload.',
      });
    }
  }

  // ── Scoring ───────────────────────────────────────────────
  const penalties = { high: 18, medium: 8, low: 2 };
  const totalPenalty = findings.reduce((s, f) => s + (penalties[f.severity] || 0), 0);
  const score = Math.max(0, 100 - totalPenalty);

  const summary = {
    total: findings.length,
    high: findings.filter((f) => f.severity === 'high').length,
    medium: findings.filter((f) => f.severity === 'medium').length,
    low: findings.filter((f) => f.severity === 'low').length,
    specEndpoints: specEndpoints.length,
    codeRoutes: codeRoutes.length,
    undocumented: findings.filter((f) => f.type === 'undocumented-endpoint').length,
    phantom: findings.filter((f) => f.type === 'phantom-endpoint').length,
    missingErrorResponses: findings.filter((f) => f.type === 'missing-error-response').length,
    missingSchemas: findings.filter((f) => f.type === 'missing-response-schema' || f.type === 'missing-request-schema')
      .length,
    specFile: specFile || null,
    implementationState: preImplementationMode ? 'pre-implementation' : 'implementation-present',
    routeDriftEnforced: !preImplementationMode,
    routeDriftDeferred: preImplementationMode,
  };

  return {
    findings,
    summary,
    score,
    verdict: score >= 90 ? 'PASS' : score >= 75 ? 'WATCH' : 'FAIL',
    note: preImplementationMode
      ? 'Route drift check deferred because this greenfield project is still in S0 planning and no application route scaffold exists.'
      : null,
    timestamp: new Date().toISOString(),
  };
}

// ── Report Writing ──────────────────────────────────────────

function writeReport(projectDir, result) {
  const outDir = reviewDir(projectDir);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const dest = path.join(outDir, 'api-contract-report.json');
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, dest);
  return dest;
}

// ── Exports ─────────────────────────────────────────────────

module.exports = {
  validate,
  writeReport,
  extractCodeRoutes,
  extractSpecEndpoints,
  parseSpec,
  findSpec,
  normalizePath,
  isPreImplementationProject,
};

// ── CLI ─────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log('CoBolt API Contract Validator');
    console.log('');
    console.log('Usage:');
    console.log('  node tools/cobolt-api-contract-validator.js validate              # Auto-detect spec + routes');
    console.log('  node tools/cobolt-api-contract-validator.js validate --spec path   # Explicit spec path');
    console.log('  node tools/cobolt-api-contract-validator.js validate --json        # Machine-readable output');
    console.log('  node tools/cobolt-api-contract-validator.js validate --save        # Save report');
    console.log('');
    console.log('Exit codes: 0 = pass, 1 = violations, 2 = usage error');
    process.exit(2);
  }

  if (cmd === 'validate') {
    const options = {};
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--spec' && args[i + 1]) options.spec = args[++i];
      else if (args[i] === '--json') options.json = true;
      else if (args[i] === '--save') options.save = true;
    }

    const projectDir = process.cwd();
    const result = validate(projectDir, options);

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('');
      console.log('  CoBolt API Contract Validator');
      console.log('  ======================================================');
      console.log(`  Spec file:        ${result.summary.specFile || '(none found)'}`);
      console.log(`  Spec endpoints:   ${result.summary.specEndpoints}`);
      console.log(`  Code routes:      ${result.summary.codeRoutes}`);
      console.log('  ------------------------------------------------------');
      console.log(`  Undocumented:     ${result.summary.undocumented}`);
      console.log(`  Phantom:          ${result.summary.phantom}`);
      console.log(`  Missing errors:   ${result.summary.missingErrorResponses}`);
      console.log(`  Missing schemas:  ${result.summary.missingSchemas}`);
      console.log('  ------------------------------------------------------');
      console.log(`  Score: ${result.score}% -- ${result.verdict}`);
      console.log('  ======================================================');

      if (result.findings.length > 0) {
        console.log('');
        for (const f of result.findings.slice(0, 30)) {
          const icon = f.severity === 'high' ? 'X' : f.severity === 'medium' ? '!' : '-';
          const loc = f.file ? (f.line > 0 ? ` ${f.file}:${f.line}` : ` ${f.file}`) : '';
          console.log(`  [${icon}] [${f.severity.toUpperCase()}]${loc} -- ${f.message}`);
        }
        if (result.findings.length > 30) {
          console.log(`  ... and ${result.findings.length - 30} more`);
        }
      }
    }

    if (options.save) {
      const dest = writeReport(projectDir, result);
      if (!options.json) console.log(`\n  Report saved: ${dest}`);
    }

    process.exit(result.verdict === 'PASS' ? 0 : 1);
  } else {
    console.error(`Unknown command: ${cmd}. Use "validate" or "--help".`);
    process.exit(2);
  }
}
