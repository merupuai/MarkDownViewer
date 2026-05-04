#!/usr/bin/env node

// CoBolt Contract Invention Scanner
//
// Gap: cobolt-contract-verify.js iterates *declared* contracts and checks code
// satisfies them — a drift check. It cannot detect INVENTION: code in M_n
// that references an API path / DB table / event which NO interface contract
// declares AND which no milestone actually provides.
//
// Example: M3 calls `GET /api/v1/accounts/:id/ledger`. If no IC-API declares
// that path AND no handler exists for it anywhere in the codebase, the drift
// check passes (nothing to check) but the code is broken — it assumes another
// milestone supplies an endpoint nobody built.
//
// This scanner inverts the check: collect cross-cutting references from code,
// then verify each is either (a) declared in interface-contracts.json or
// (b) locally satisfied by a handler/migration/publisher+subscriber pair in
// the current codebase.
//
// Usage:
//   node tools/cobolt-contract-invention.js scan [--milestone M3] [--json]
//   node tools/cobolt-contract-invention.js gate       # exit 1 on inventions
//
// Writes _cobolt-output/latest/contract-invention/report.json
// Appends _cobolt-output/audit/contract-inventions.jsonl
// Records contractInventions metric.
//
// Permissive when interface-contracts.json is absent (back-compat).

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const IGNORE = new Set([
  'node_modules',
  '.git',
  '_cobolt-output',
  'dist',
  'build',
  '.next',
  'coverage',
  '_build',
  'deps',
]);
const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|ex|exs|py|go|rs|java|kt|rb)$/i;
const TEST_EXT = /\.(spec|test)\.(js|mjs|cjs|ts|tsx|jsx|py|ex|exs|rb|go)$/i;

// ── HTTP client call patterns ──────────────────────────────────────
// Captures method + path. Path must start with `/` to avoid matching URLs/args.
const HTTP_PATTERNS = [
  // fetch('/path', {method: 'POST'})  -> default GET if no method
  { re: /fetch\s*\(\s*['"`](\/[^'"`?\s]{1,200})['"`]\s*(?:,\s*\{([^}]{0,200})\})?/g, kind: 'fetch' },
  // axios.get('/path'), axios.post('/path')
  { re: /axios\s*\.\s*(get|post|put|patch|delete|head)\s*\(\s*['"`](\/[^'"`?\s]{1,200})['"`]/gi, kind: 'axios' },
  // httpClient.request({ method: 'GET', url: '/path' }) — approximate
  {
    re: /\b(?:request|http|client)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`](\/[^'"`?\s]{1,200})['"`]/gi,
    kind: 'generic',
  },
  // Python requests
  { re: /requests\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`?\s]{1,200})['"`]/gi, kind: 'requests' },
];

// ── SQL / ORM table references ─────────────────────────────────────
const SQL_PATTERNS = [
  /\bFROM\s+["`']?(\w{3,60})["`']?\b/gi,
  /\bINSERT\s+INTO\s+["`']?(\w{3,60})["`']?\b/gi,
  /\bUPDATE\s+["`']?(\w{3,60})["`']?\s+SET\b/gi,
  /\bDELETE\s+FROM\s+["`']?(\w{3,60})["`']?\b/gi,
  /\b(?:\.from|\.table)\(\s*['"`](\w{3,60})['"`]/gi, // Knex/Supabase .from('table')
];

// ── Event pub/sub ──────────────────────────────────────────────────
const EVENT_PUBLISH = [
  /\b(?:emit|publish|dispatch|broadcast)\s*\(\s*['"`]([a-z][a-z0-9._-]{2,60})['"`]/gi,
  /PubSub\.broadcast\s*\(\s*\w+\s*,\s*['"`]([a-z][a-z0-9._-]{2,60})['"`]/gi,
];
const EVENT_SUBSCRIBE = [/\b(?:on|subscribe|addListener|handleIn)\s*\(\s*['"`]([a-z][a-z0-9._-]{2,60})['"`]/gi];

// SQL noise — SQL keywords, common non-table identifiers picked up by greedy FROM/UPDATE matching.
const SQL_NOISE = new Set([
  'select',
  'where',
  'values',
  'set',
  'null',
  'true',
  'false',
  'dual',
  'table',
  'schema',
  'row',
  'rows',
  'count',
  'sum',
  'now',
  'distinct',
  'unique',
  'index',
  'json',
  'jsonb',
  'varchar',
  'text',
  'integer',
  'boolean',
  'timestamp',
  'uuid',
  'default',
  'primary',
  'foreign',
  'cascade',
  'restrict',
  'string',
  'number',
]);

function walk(dir, out = [], depth = 0) {
  if (depth > 12) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (IGNORE.has(e.name) || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out, depth + 1);
    else if (e.isFile() && CODE_EXT.test(e.name)) out.push(full);
  }
  return out;
}

function findMigrationFiles() {
  const results = [];
  for (const p of ['migrations', 'priv/repo/migrations', 'db/migrate', 'migrate']) {
    const dir = path.join(process.cwd(), p);
    if (!fs.existsSync(dir)) continue;
    (function rec(d) {
      let entries;
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) rec(full);
        else if (/\.(sql|exs|ex|rb|py|ts|js)$/i.test(e.name)) results.push(full);
      }
    })(dir);
  }
  return results;
}

function loadContracts() {
  for (const p of [
    path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'interface-contracts.json'),
    path.join(process.cwd(), '_cobolt-output', 'planning', 'interface-contracts.json'),
  ]) {
    if (fs.existsSync(p)) {
      try {
        return { data: JSON.parse(fs.readFileSync(p, 'utf8')), source: p };
      } catch {
        return { data: null, source: p };
      }
    }
  }
  return { data: null, source: null };
}

// Normalize an API path for comparison: lowercase, strip trailing slash, collapse :param / {param} → :p
function normalizePath(p) {
  return p
    .toLowerCase()
    .replace(/\/+$/, '')
    .replace(/:\w+/g, ':p')
    .replace(/\{[^}]+\}/g, ':p');
}

// Build a declared-resource index from the loaded contracts.
function buildDeclaredIndex(contracts) {
  const api = new Map(); // "METHOD normalizedPath" → contractId
  const data = new Map(); // lowercaseEntity → contractId
  const events = new Map(); // eventName → contractId
  for (const c of contracts || []) {
    const spec = c.spec || {};
    if (spec.kind === 'api' && spec.method && spec.path) {
      api.set(`${spec.method.toUpperCase()} ${normalizePath(spec.path)}`, c.id);
    } else if (spec.kind === 'data' && spec.entity) {
      data.set(spec.entity.toLowerCase(), c.id);
    } else if (spec.kind === 'event' && spec.eventName) {
      events.set(spec.eventName, c.id);
    }
  }
  return { api, data, events };
}

// Build a local-resource index — resources the codebase actually provides.
// Handlers: files that register routes. Tables: migrations that CREATE TABLE.
// Event producers/consumers: files that publish or subscribe the event.
function buildLocalIndex(codeFiles, migrationFiles) {
  const handlers = new Set(); // "METHOD normalizedPath"
  const tables = new Set(); // lowercase entity
  const published = new Set();
  const subscribed = new Set();

  // Handler patterns — route registrations, not client calls.
  const handlerPatterns = [
    // Express / Fastify / Koa style: app.get('/path', handler)
    /\b(?:app|router|server|api)\s*\.\s*(get|post|put|patch|delete|all|use)\s*\(\s*['"`](\/[^'"`?\s]+)['"`]/gi,
    // Generic .route('/path', ...).method(...) is skipped — too ambiguous.
    // Phoenix: get "/path", Controller, :action
    /\b(get|post|put|patch|delete)\s+["'](\/[^"']+)["']\s*,\s*\w+Controller/gi,
    // FastAPI: @app.get("/path")
    /@\w+\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`](\/[^'"`?\s]+)['"`]/gi,
    // Go net/http: http.HandleFunc("/path", ...)
    /HandleFunc\s*\(\s*['"`](\/[^'"`?\s]+)['"`]/gi,
  ];

  for (const f of codeFiles) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }

    for (const re of handlerPatterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        // HandleFunc has path in group 1; others have method in 1 and path in 2.
        if (m.length === 2) handlers.add(`ANY ${normalizePath(m[1])}`);
        else handlers.add(`${m[1].toUpperCase()} ${normalizePath(m[2])}`);
      }
    }

    for (const re of EVENT_PUBLISH) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) published.add(m[1]);
    }
    for (const re of EVENT_SUBSCRIBE) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) subscribed.add(m[1]);
    }
  }

  // CREATE TABLE scan over migrations.
  const createRe = /create\s+table(?:\s+if\s+not\s+exists)?\s+["`']?(\w{3,60})["`']?/gi;
  const phoenixCreateRe = /create\s+table\s*\(\s*:(\w{3,60})/gi;
  for (const f of migrationFiles) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8').toLowerCase();
    } catch {
      continue;
    }
    for (const re of [createRe, phoenixCreateRe]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) tables.add(m[1]);
    }
  }

  return { handlers, tables, published, subscribed };
}

// Collect cross-cutting references from code — things that might be invented.
function collectReferences(codeFiles) {
  const refs = []; // {kind, key, method?, name?, file, line}

  function lineOf(text, idx) {
    return text.slice(0, idx).split('\n').length;
  }

  for (const f of codeFiles) {
    // Skip test files — they call real code anyway; inventions must manifest in app code.
    if (TEST_EXT.test(f)) continue;
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }

    // HTTP references.
    for (const { re, kind } of HTTP_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        let method = 'GET';
        let p;
        if (kind === 'fetch') {
          p = m[1];
          const opts = m[2] || '';
          const mm = /method\s*:\s*['"`](\w+)['"`]/i.exec(opts);
          if (mm) method = mm[1].toUpperCase();
        } else {
          method = (m[1] || 'GET').toUpperCase();
          p = m[2];
        }
        if (!p?.startsWith('/')) continue;
        refs.push({
          kind: 'api',
          key: `${method} ${normalizePath(p)}`,
          method,
          path: p,
          file: f,
          line: lineOf(text, m.index),
        });
      }
    }

    // SQL references.
    for (const re of SQL_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const t = (m[1] || '').toLowerCase();
        if (!t || SQL_NOISE.has(t)) continue;
        refs.push({ kind: 'data', key: t, entity: t, file: f, line: lineOf(text, m.index) });
      }
    }

    // Event publishes — subscribers alone without publishers are ALSO suspicious,
    // but for this check we treat publish as the invention signal (code assumes
    // somebody will consume it; if contract + subscriber both missing → invention).
    for (const re of EVENT_PUBLISH) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        refs.push({ kind: 'event', key: m[1], name: m[1], role: 'publish', file: f, line: lineOf(text, m.index) });
      }
    }
    for (const re of EVENT_SUBSCRIBE) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        refs.push({ kind: 'event', key: m[1], name: m[1], role: 'subscribe', file: f, line: lineOf(text, m.index) });
      }
    }
  }
  return refs;
}

function scan() {
  const { data, source } = loadContracts();
  if (!data) return { ok: true, skipped: true, reason: 'no interface-contracts.json', source };

  const declared = buildDeclaredIndex(data.contracts || []);
  const codeFiles = walk(process.cwd());
  const migrationFiles = findMigrationFiles();
  const local = buildLocalIndex(codeFiles, migrationFiles);
  const refs = collectReferences(codeFiles);

  const inventions = [];
  // Dedupe by kind+key+file so one file referencing the same endpoint 50x reports once.
  const seen = new Set();

  for (const r of refs) {
    const dedupeKey = `${r.kind}|${r.key}|${r.file}`;
    if (seen.has(dedupeKey)) continue;

    let isDeclared = false;
    let isLocal = false;

    if (r.kind === 'api') {
      isDeclared = declared.api.has(r.key) || declared.api.has(`ANY ${r.key.split(' ').slice(1).join(' ')}`);
      // Any handler registered for that path (any method) is enough to prove locality.
      const np = r.key.split(' ').slice(1).join(' ');
      isLocal = local.handlers.has(r.key) || local.handlers.has(`ANY ${np}`);
      // Also accept exact path with any declared method.
      if (!isLocal) {
        for (const h of local.handlers) {
          if (h.endsWith(` ${np}`)) {
            isLocal = true;
            break;
          }
        }
      }
    } else if (r.kind === 'data') {
      isDeclared = declared.data.has(r.key);
      isLocal = local.tables.has(r.key);
    } else if (r.kind === 'event') {
      isDeclared = declared.events.has(r.key);
      // Event is "local" only if BOTH published and subscribed in the same codebase.
      isLocal = local.published.has(r.key) && local.subscribed.has(r.key);
    }

    if (!isDeclared && !isLocal) {
      inventions.push({
        kind: r.kind,
        reference: r.kind === 'api' ? `${r.method} ${r.path}` : r.kind === 'data' ? r.entity : r.name,
        role: r.role || null,
        file: path.relative(process.cwd(), r.file),
        line: r.line,
        reason:
          r.kind === 'api'
            ? `HTTP call to ${r.method} ${r.path} — no interface-contract declares it and no handler registered in this codebase`
            : r.kind === 'data'
              ? `Query against table "${r.entity}" — no interface-contract declares it and no migration creates it`
              : `Event "${r.name}" ${r.role}d but no contract declares it and no matching ${r.role === 'publish' ? 'subscriber' : 'publisher'} exists`,
      });
      seen.add(dedupeKey);
    }
  }

  return {
    ok: inventions.length === 0,
    totalRefs: refs.length,
    totalContracts: (data.contracts || []).length,
    inventions,
    source,
    generatedAt: new Date().toISOString(),
  };
}

function writeReport(result) {
  const dir = path.join(process.cwd(), '_cobolt-output', 'latest', 'contract-invention');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fp = path.join(dir, 'report.json');
  fs.writeFileSync(fp, JSON.stringify(result, null, 2));

  // Audit log
  if (result.inventions && result.inventions.length > 0) {
    const auditDir = path.join(process.cwd(), '_cobolt-output', 'audit');
    if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
    const logFile = path.join(auditDir, 'contract-inventions.jsonl');
    const ts = new Date().toISOString();
    for (const inv of result.inventions) {
      fs.appendFileSync(logFile, `${JSON.stringify({ ts, ...inv })}\n`, { mode: 0o600 });
    }
  }
  return fp;
}

function bumpMetric(count) {
  if (count <= 0) return;
  try {
    const tool = path.join(__dirname, 'cobolt-production-readiness.js');
    if (fs.existsSync(tool)) {
      execFileSync('node', [tool, 'record', 'contractInventions', String(count)], { stdio: 'ignore' });
    }
  } catch {
    /* non-fatal */
  }
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const json = rest.includes('--json');
  switch (cmd) {
    case 'scan':
    case 'gate': {
      const r = scan();
      if (r.skipped) {
        if (cmd === 'gate') console.log(JSON.stringify(r, null, 2));
        return 0;
      }
      const fp = writeReport(r);
      if (!r.ok) bumpMetric(r.inventions.length);
      if (json || cmd === 'gate') console.log(JSON.stringify(r, null, 2));
      else {
        console.log(
          `Contract invention — ${r.ok ? 'PASS' : 'FAIL'} (${r.totalRefs} refs scanned, ${r.totalContracts} contracts declared)`,
        );
        if (!r.ok) {
          console.log(`\n${r.inventions.length} invention(s):`);
          for (const inv of r.inventions.slice(0, 10)) {
            console.log(`  [${inv.kind}] ${inv.reference}`);
            console.log(`    ${inv.file}:${inv.line}`);
            console.log(`    ${inv.reason}`);
          }
          if (r.inventions.length > 10) console.log(`  …and ${r.inventions.length - 10} more`);
        }
        console.log(`\nReport: ${fp}`);
      }
      return r.ok ? 0 : 1;
    }
    default:
      console.error('Usage: cobolt-contract-invention.js {scan|gate} [--json]');
      return 1;
  }
}

if (require.main === module) process.exit(main());

module.exports = { scan, buildDeclaredIndex, buildLocalIndex, collectReferences, normalizePath };
