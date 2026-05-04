#!/usr/bin/env node

// CoBolt Deploy Smoke Test - schema-aware HTTP smoke testing for deploy stage.
//
// Extends HTTP status code checks with response body schema validation so that
// an endpoint returning {"status":"error"} with HTTP 200 is correctly flagged.
//
// Usage:
//   node tools/cobolt-smoke-test.js run --target <url> [--config smoke-tests.json]

const fs = require('node:fs');
const path = require('node:path');

const { atomicWrite } = require('../lib/cobolt-atomic-write');

// -- Default smoke test suite -----------------------------------

const DEFAULT_SMOKE_TESTS = [
  {
    name: 'health-check',
    method: 'GET',
    path: '/api/health',
    expect: {
      status: 200,
      body: {
        type: 'object',
        required: ['status'],
        properties: { status: { enum: ['ok', 'healthy'] } },
      },
    },
  },
  {
    name: 'auth-unauthenticated',
    method: 'GET',
    path: '/api/me',
    expect: { status: 401 },
  },
  {
    name: 'root-page',
    method: 'GET',
    path: '/',
    expect: { status: 200, bodyContains: ['<!DOCTYPE html>'] },
  },
  {
    name: 'security-headers',
    method: 'GET',
    path: '/',
    expect: {
      status: 200,
      securityHeaders: {
        required: ['x-content-type-options', 'x-frame-options'],
        recommended: ['strict-transport-security', 'content-security-policy', 'x-xss-protection', 'referrer-policy'],
      },
    },
  },
  {
    name: 'response-time',
    method: 'GET',
    path: '/api/health',
    expect: {
      status: 200,
      performance: { maxResponseMs: 2000 },
    },
  },
];

// -- Auto-discovery of API endpoints from route files ----------

/**
 * Scan the project for API route definitions and generate smoke tests.
 * Covers Go (gorilla/mux, chi, gin, echo), Express, Fastify, Phoenix.
 * @param {string} projectDir
 * @returns {object[]} - array of discovered test descriptors
 */
function discoverEndpoints(projectDir) {
  const discovered = [];
  const seen = new Set();

  const ROUTE_PATTERNS = [
    /\.(?:HandleFunc|Handle|Get|Post|Put|Delete|Patch)\s*\(\s*["'`](\/api[^"'`]+)["'`]/g,
    /\.(?:GET|POST|PUT|DELETE|PATCH)\s*\(\s*["'`](\/api[^"'`]+)["'`]/g,
    /(?:app|router|server)\.(?:get|post|put|delete|patch)\s*\(\s*['"`](\/api[^'"`]+)['"`]/gi,
    /(?:get|post|put|delete|patch)\s+["'](\/api[^"']+)["']/g,
  ];

  const METHOD_MAP = {
    HandleFunc: 'GET',
    Handle: 'GET',
    Get: 'GET',
    GET: 'GET',
    get: 'GET',
    Post: 'POST',
    POST: 'POST',
    post: 'POST',
    Put: 'PUT',
    PUT: 'PUT',
    put: 'PUT',
    Delete: 'DELETE',
    DELETE: 'DELETE',
    delete: 'DELETE',
    Patch: 'PATCH',
    PATCH: 'PATCH',
    patch: 'PATCH',
  };

  const SOURCE_EXTS = new Set(['.go', '.js', '.ts', '.ex', '.exs', '.py']);
  const SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    '_cobolt-output',
    'dist',
    'build',
    'vendor',
    'deps',
    'test',
    'tests',
    'spec',
    'specs',
    '__tests__',
    '__mocks__',
    'fixtures',
    'mocks',
    'e2e',
  ]);
  const TEST_FILE_PATTERN = /(?:\.(?:test|spec)\.|_test\.go|_test\.exs?$|\.stories\.)/;

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (SOURCE_EXTS.has(path.extname(entry.name))) {
        if (TEST_FILE_PATTERN.test(entry.name)) continue;
        let content;
        try {
          content = fs.readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        for (const pattern of ROUTE_PATTERNS) {
          pattern.lastIndex = 0;
          let match;
          while ((match = pattern.exec(content)) !== null) {
            const routePath = match[1];
            if (/:|\{|\[/.test(routePath)) continue;
            if (seen.has(routePath)) continue;
            seen.add(routePath);

            const funcMatch = match[0].match(/\.(\w+)\s*\(/);
            const method = funcMatch ? METHOD_MAP[funcMatch[1]] || 'GET' : 'GET';

            discovered.push({
              name: `auto:${method}:${routePath}`,
              method,
              path: routePath,
              expect: {
                status: method === 'GET' ? 200 : undefined,
                body: { type: 'object', _notStub: true },
              },
              _source: path.relative(projectDir, full),
              _auto: true,
            });
          }
        }
      }
    }
  }

  walk(projectDir);
  return discovered;
}

/**
 * Generate infrastructure service health check tests from infra-manifest.
 * @param {string} projectDir
 * @returns {object[]} - array of infra health test descriptors
 */
function discoverInfraHealthTests(projectDir) {
  const tests = [];
  const manifestPath = path.join(projectDir, '_cobolt-output', 'latest', 'infra', 'infra-manifest.json');
  if (!fs.existsSync(manifestPath)) return tests;

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const services = manifest.services || manifest.infrastructure?.services || {};

    for (const [name, svc] of Object.entries(services)) {
      const healthEndpoint = svc.healthEndpoint || svc.health_endpoint;
      if (healthEndpoint) {
        tests.push({
          name: `infra:${name}:health`,
          method: 'GET',
          path: healthEndpoint,
          expect: { status: 200 },
          _source: 'infra-manifest',
          _auto: true,
        });
      }
    }
  } catch {
    /* parse error */
  }

  return tests;
}

// -- Simple schema validator ------------------------------------

/**
 * Validates body against a minimal JSON Schema subset.
 * Supports: type:'object', required:[], properties:{ field:{ enum:[] } }
 *
 * @param {unknown} body   - parsed JSON body (or null for non-JSON)
 * @param {object}  schema - JSON Schema (subset)
 * @returns {string[]}     - array of failure messages (empty = valid)
 */
function validateSchema(body, schema) {
  const failures = [];

  if (schema.type === 'object') {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      failures.push(`body type expected object, got ${body === null ? 'null' : typeof body}`);
      return failures; // can't continue structural checks
    }
  }

  // required fields
  if (Array.isArray(schema.required)) {
    for (const field of schema.required) {
      if (!(field in body)) {
        failures.push(`body missing required field "${field}"`);
      }
    }
  }

  // property constraints
  if (schema.properties && typeof body === 'object' && body !== null) {
    for (const [field, fieldSchema] of Object.entries(schema.properties)) {
      if (!(field in body)) continue; // already covered by required check

      if (Array.isArray(fieldSchema.enum)) {
        if (!fieldSchema.enum.includes(body[field])) {
          failures.push(
            `body.${field} value ${JSON.stringify(body[field])} not in enum [${fieldSchema.enum.map((v) => JSON.stringify(v)).join(', ')}]`,
          );
        }
      }
    }
  }

  return failures;
}

// -- Response validator -----------------------------------------

/**
 * Validates a response object against an expectation descriptor.
 *
 * @param {{ status: number, body: unknown, bodyText: string, headers: object, durationMs: number }} response
 * @param {{ status?: number, body?: object, bodyContains?: string[], securityHeaders?: object, performance?: object }} expect
 * @returns {{ passed: boolean, reason: string }}
 */
function validateResponse(response, expect) {
  const failures = [];

  // Status check
  if (expect.status !== undefined && response.status !== expect.status) {
    failures.push(`status expected ${expect.status}, got ${response.status}`);
  }

  // Body schema check (JSON Schema subset)
  if (expect.body) {
    const schemaFailures = validateSchema(response.body, expect.body);
    failures.push(...schemaFailures);
  }

  // bodyContains check (plain text substring matching)
  if (Array.isArray(expect.bodyContains)) {
    const text = typeof response.bodyText === 'string' ? response.bodyText : '';
    for (const substring of expect.bodyContains) {
      if (!text.includes(substring)) {
        failures.push(`body does not contain "${substring}"`);
      }
    }
  }

  // Security headers check
  if (expect.securityHeaders && response.headers) {
    const hdrs = response.headers;
    if (Array.isArray(expect.securityHeaders.required)) {
      for (const header of expect.securityHeaders.required) {
        if (!hdrs[header.toLowerCase()]) {
          failures.push(`missing required security header: ${header}`);
        }
      }
    }
    // Recommended security headers are enforced by default; set recommendedMode: "advisory" only for explicit non-production probes.
    const advisoryRecommended = expect.securityHeaders.recommendedMode === 'advisory';
    if (Array.isArray(expect.securityHeaders.recommended)) {
      for (const header of expect.securityHeaders.recommended) {
        if (!hdrs[header.toLowerCase()]) {
          if (advisoryRecommended) {
            if (!response._warnings) response._warnings = [];
            response._warnings.push(`missing recommended security header: ${header}`);
          } else {
            failures.push(`missing recommended security header: ${header}`);
          }
        }
      }
    }
    // Cookie security check
    const setCookie = hdrs['set-cookie'];
    if (setCookie) {
      const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie;
      if (!cookieStr.toLowerCase().includes('httponly')) {
        failures.push('cookie missing HttpOnly flag');
      }
      if (!cookieStr.toLowerCase().includes('secure')) {
        failures.push('cookie missing Secure flag');
      }
      if (!cookieStr.toLowerCase().includes('samesite')) {
        failures.push('cookie missing SameSite attribute');
      }
    }
  }

  // Performance assertion
  if (expect.performance && typeof response.durationMs === 'number') {
    if (expect.performance.maxResponseMs && response.durationMs > expect.performance.maxResponseMs) {
      failures.push(`response time ${response.durationMs}ms exceeds budget ${expect.performance.maxResponseMs}ms`);
    }
  }

  return {
    passed: failures.length === 0,
    reason: failures.join('; '),
  };
}

// -- HTTP runner ------------------------------------------------

/**
 * Runs all smoke tests against a target base URL.
 *
 * @param {string}   target  - base URL (e.g. 'http://localhost:4000')
 * @param {object[]} tests   - array of test descriptors
 * @param {object}   [opts]  - options (reserved for future use)
 * @returns {Promise<object[]>} - array of test result objects
 */
async function runSmokeTests(target, tests, _opts = {}) {
  const results = [];

  for (const test of tests) {
    const url = target.replace(/\/$/, '') + test.path;
    const startMs = Date.now();
    let status = null;
    let body = null;
    let bodyText = '';
    let fetchError = null;

    let responseHeaders = {};
    try {
      const res = await fetch(url, {
        method: test.method || 'GET',
        signal: AbortSignal.timeout(10_000),
      });

      status = res.status;
      bodyText = await res.text();

      // Capture response headers for security header validation
      responseHeaders = {};
      res.headers.forEach((value, key) => {
        responseHeaders[key.toLowerCase()] = value;
      });

      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('json')) {
        try {
          body = JSON.parse(bodyText);
        } catch {
          body = null;
        }
      }
    } catch (err) {
      fetchError = err.message || String(err);
    }

    const duration = Date.now() - startMs;

    let passed = false;
    let reason = '';

    if (fetchError) {
      reason = `fetch error: ${fetchError}`;
    } else {
      const validation = validateResponse(
        { status, body, bodyText, headers: responseHeaders, durationMs: duration },
        test.expect || {},
      );
      passed = validation.passed;
      reason = validation.reason;
    }

    results.push({
      name: test.name,
      url,
      method: test.method || 'GET',
      status,
      duration,
      passed,
      reason,
    });
  }

  return results;
}

// -- Result writer ----------------------------------------------

/**
 * Atomically writes smoke test results to the canonical output path.
 *
 * @param {object[]} results
 * @param {string}   [outputPath]  - override default path (for testing)
 */
function writeResults(results, outputPath) {
  const dest = outputPath || path.join(process.cwd(), '_cobolt-output', 'latest', 'deploy', 'smoke-results.json');
  const content = JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2);
  atomicWrite(dest, content, { encoding: 'utf8', mode: 0o600 });
  return dest;
}

// -- CLI entry point --------------------------------------------

async function main(argv) {
  let [cmd, ...rest] = argv;

  if (cmd !== 'run' && argv.includes('--config')) {
    cmd = 'run';
    rest = argv;
  }

  if (cmd === 'run') {
    let target = null;
    let configPath = null;
    let discover = false;
    let jsonOutput = false;

    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--target' && rest[i + 1]) target = rest[++i];
      if (rest[i] === '--config' && rest[i + 1]) configPath = rest[++i];
      if (rest[i] === '--discover') discover = true;
      if (rest[i] === '--json') jsonOutput = true;
    }

    let tests = DEFAULT_SMOKE_TESTS;
    if (configPath) {
      try {
        const raw = fs.readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          tests = parsed;
        } else {
          target ||= parsed.target || parsed.baseUrl || parsed.url || null;
          tests = parsed.tests || parsed.smokeTests || DEFAULT_SMOKE_TESTS;
        }
      } catch (err) {
        process.stderr.write(`Error reading config: ${err.message}\n`);
        process.exit(3);
      }
    }

    if (!target) {
      process.stderr.write('Error: --target <url> is required\n');
      process.exit(3);
    }

    // Auto-discover API endpoints and infra health checks
    if (discover) {
      const projectDir = process.cwd();
      const apiEndpoints = discoverEndpoints(projectDir);
      const infraHealth = discoverInfraHealthTests(projectDir);

      if (apiEndpoints.length > 0) {
        if (!jsonOutput) console.log(`Discovered ${apiEndpoints.length} API endpoint(s) from route files`);
        // Only add GET endpoints for auto-discovery (POST/PUT/DELETE need valid payloads)
        const safeEndpoints = apiEndpoints.filter((t) => t.method === 'GET');
        tests = [...tests, ...safeEndpoints];
      }

      if (infraHealth.length > 0) {
        if (!jsonOutput) console.log(`Discovered ${infraHealth.length} infrastructure health endpoint(s)`);
        tests = [...tests, ...infraHealth];
      }
    }

    const results = await runSmokeTests(target, tests);
    const failed = results.filter((r) => !r.passed);
    const dest = writeResults(results);

    if (jsonOutput) {
      console.log(
        JSON.stringify(
          {
            passed: failed.length === 0,
            total: results.length,
            failed: failed.length,
            resultsPath: dest,
            results,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(`Running ${tests.length} smoke test(s) against ${target} ...`);
      for (const r of results) {
        const icon = r.passed ? '-' : '-';
        const detail = r.reason ? `  - ${r.reason}` : '';
        console.log(`  ${icon} [${r.method} ${r.url}] HTTP ${r.status ?? 'ERR'} (${r.duration}ms) ${r.name}${detail}`);
      }
      console.log(`\nResults written to ${dest}`);
      console.log(`\n${results.length - failed.length}/${results.length} tests passed.`);
    }

    if (failed.length > 0) {
      process.exitCode = 1;
    }
    return;
  }

  // Unknown command
  process.stderr.write(
    [
      'CoBolt Smoke Test',
      '',
      'Usage:',
      '  node tools/cobolt-smoke-test.js run --target <url> [--config smoke-tests.json] [--discover]',
      '',
      'Options:',
      '  --target <url>     Base URL to test against (required)',
      '  --config <path>    JSON file with custom test definitions',
      '  --discover         Auto-discover API endpoints from route files + infra health checks',
      '',
    ].join('\n'),
  );
  process.exit(3);
}

// -- Exports ----------------------------------------------------

module.exports = {
  runSmokeTests,
  validateResponse,
  writeResults,
  discoverEndpoints,
  discoverInfraHealthTests,
  _testOnly: {
    DEFAULT_SMOKE_TESTS,
    validateResponse,
  },
};

// Run CLI only when invoked directly
if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`Fatal: ${err.message}\n`);
    process.exit(1);
  });
}
