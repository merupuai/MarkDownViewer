#!/usr/bin/env node
// S2 — Consumer-Driven Contract test generator. Records how the consumer milestone
// actually calls the provider's API (via static scan + optional runtime trace),
// then emits pact-shaped contract tests.
// Usage: node tools/cobolt-cdc-gen.js --consumer M4 --provider M3

const fs = require('node:fs');
const path = require('node:path');

const CWD = process.cwd();
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const consumer = arg('--consumer');
const provider = arg('--provider');
if (!consumer || !provider) {
  console.error('Usage: --consumer M<n+1> --provider M<n>');
  process.exit(1);
}

const contracts = (() => {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(CWD, '_cobolt-output', 'latest', 'planning', 'interface-contracts.json'), 'utf8'),
    );
  } catch {
    return { contracts: [] };
  }
})();

function contractProvider(c) {
  return c.provider || c.milestone || null;
}

function contractConsumers(c) {
  if (Array.isArray(c.consumers)) return c.consumers;
  if (Array.isArray(c.consumer)) return c.consumer;
  if (c.consumer) return [c.consumer];
  return [];
}

function contractEndpoint(c) {
  return c.endpoint || c.path || c.name || c.spec?.path || '';
}

function contractMethod(c) {
  return String(c.method || c.spec?.method || 'GET').toUpperCase();
}

function contractResponse(c) {
  if (c.response && typeof c.response === 'object') return c.response;
  if (c.expectedResponse && typeof c.expectedResponse === 'object') return c.expectedResponse;
  const examples = Array.isArray(c.examples) ? c.examples : [];
  const example = examples.find((e) => e.kind === 'happy') || examples[0];
  const then = example?.then;
  if (!then || typeof then !== 'object') return {};
  const out = {};
  if (then.status !== undefined) out.status = then.status;
  if (then.statusCode !== undefined) out.status = then.statusCode;
  const body = then.response ?? then.body ?? then.responseBody;
  if (body !== undefined) out.body = body;
  return out;
}

const providerContracts = (contracts.contracts || []).filter((c) => {
  const declaredProvider = contractProvider(c);
  const declaredConsumers = contractConsumers(c);
  return declaredProvider === provider && (!declaredConsumers.length || declaredConsumers.includes(consumer));
});
if (!providerContracts.length) console.warn(`warn: no contracts for provider ${provider}`);

// Static scan: find calls to provider API paths inside consumer story files / source.
const consumerRoot = path.join(CWD, 'src');
const pacts = [];

function walk(d, out = []) {
  try {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && !/node_modules|\.git|dist|build/.test(e.name)) walk(p, out);
      else if (e.isFile() && /\.(ts|tsx|js|jsx|py|ex|exs|rs|go|java|rb)$/.test(e.name)) out.push(p);
    }
  } catch {}
  return out;
}
const files = fs.existsSync(consumerRoot) ? walk(consumerRoot) : [];

// Dedupe by (endpoint, method, body-shape-hash)
const crypto = require('node:crypto');
const pactKey = (endpoint, method, body) => {
  const shape = shapeOf(body);
  const hash = crypto.createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 12);
  return `${(method || 'GET').toUpperCase()} ${endpoint} ${hash}`;
};
function shapeOf(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return [v.length ? shapeOf(v[0]) : null];
  if (typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = shapeOf(v[k]);
    return o;
  }
  return typeof v;
}
const seen = new Map();
const pushPact = (p) => {
  const k = `${p.contractId || ''} ${pactKey(p.endpoint, p.method, p.request?.body)}`;
  if (!seen.has(k)) {
    seen.set(k, p);
    pacts.push(p);
  }
};

providerContracts.forEach((c) => {
  const endpoint = contractEndpoint(c);
  if (!endpoint) return;
  const needle = endpoint.replace(/\{[^}]+\}/g, '[^\'"`]+');
  const re = new RegExp(`['"\`](${needle})['"\`]`);
  const hits = files.filter((f) => {
    try {
      return re.test(fs.readFileSync(f, 'utf8'));
    } catch {
      return false;
    }
  });
  if (hits.length) {
    pushPact({
      contractId: c.id,
      semanticVersion: c.semanticVersion,
      boundedContextProvider: c.boundedContextProvider,
      boundedContextConsumer: c.boundedContextConsumer,
      consumer,
      provider,
      endpoint,
      method: contractMethod(c),
      callers: hits.map((h) => path.relative(CWD, h)),
      request: c.request || {},
      response: contractResponse(c),
      source: 'static',
      verified: false,
    });
  }
});

// Runtime trace ingestion (OpenTelemetry JSONL). Supplements static scan
// with observed client spans targeting provider endpoints.
const tracePath = path.join(CWD, '_cobolt-output', 'latest', 'traces', 'otel.jsonl');
if (fs.existsSync(tracePath)) {
  const endpoints = providerContracts
    .map((c) => ({ raw: contractEndpoint(c), method: contractMethod(c), c }))
    .filter((x) => x.raw);
  const matchers = endpoints.map((e) => ({
    ...e,
    re: new RegExp(
      e.raw.replace(/\{[^}]+\}/g, '[^/?#]+').replace(/[.+^$()|[\]\\]/g, (m) => (m === '/' ? m : `\\${m}`)),
    ),
  }));
  const lines = fs.readFileSync(tracePath, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    let span;
    try {
      span = JSON.parse(line);
    } catch {
      continue;
    }
    // Tolerate flat or nested span shape
    const kind = span.kind || span['span.kind'] || span.attributes?.['span.kind'];
    if (kind !== 'client') continue;
    const url = span['http.url'] || span.http?.url || span.attributes?.['http.url'] || '';
    const method = span['http.method'] || span.http?.method || span.attributes?.['http.method'] || 'GET';
    const body = span['http.request.body'] ?? span.http?.request?.body ?? span.attributes?.['http.request.body'];
    if (!url) continue;
    for (const m of matchers) {
      if (m.re.test(url)) {
        pushPact({
          contractId: m.c.id,
          semanticVersion: m.c.semanticVersion,
          boundedContextProvider: m.c.boundedContextProvider,
          boundedContextConsumer: m.c.boundedContextConsumer,
          consumer,
          provider,
          endpoint: m.raw,
          method,
          callers: [],
          request: { body: body ?? null },
          response: contractResponse(m.c),
          source: 'trace',
          observedUrl: url,
          verified: false,
        });
      }
    }
  }
}

function expectedResponse(response) {
  if (!response || typeof response !== 'object') return {};
  const out = {};
  if (response.status !== undefined) out.status = response.status;
  if (response.statusCode !== undefined) out.status = response.statusCode;
  if (response.body !== undefined) out.body = response.body;
  else if (response.response !== undefined) out.body = response.response;
  else if (response.schema !== undefined) out.schema = response.schema;
  else if (Object.keys(response).length) out.body = response;
  if (response.matchingRules !== undefined) out.matchingRules = response.matchingRules;
  return out;
}

function requestFor(p) {
  const request = {
    kind: 'http',
    method: String(p.method || 'GET').toUpperCase(),
    path: p.endpoint,
  };
  if (p.request?.headers !== undefined) request.headers = p.request.headers;
  if (p.request?.query !== undefined) request.query = p.request.query;
  if (p.request?.body !== undefined) request.body = p.request.body;
  return request;
}

function writeStep06bPacts() {
  const groups = new Map();
  for (const p of pacts) {
    if (!/^IC-(API|DATA|EVT|INFRA|TYPE)-\d{3,}$/.test(String(p.contractId || ''))) continue;
    const key = `${p.contractId}::${p.consumer}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  if (!groups.size) return [];

  const outDir = path.join(CWD, '_cobolt-output', 'latest', 'planning', 'contracts');
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const [key, interactions] of groups) {
    const first = interactions[0];
    const [contractId] = key.split('::');
    const doc = {
      pactVersion: first.semanticVersion || '1.0.0',
      contractId,
      provider: {
        milestone: first.provider,
        ...(first.boundedContextProvider ? { boundedContext: first.boundedContextProvider } : {}),
        ...(first.semanticVersion ? { semanticVersion: first.semanticVersion } : {}),
      },
      consumer: {
        milestone: first.consumer,
        ...(first.boundedContextConsumer ? { boundedContext: first.boundedContextConsumer } : {}),
      },
      generatedAt: new Date().toISOString(),
      interactions: interactions.map((p, idx) => ({
        id: `INT-${String(idx + 1).padStart(3, '0')}`,
        description: `${String(p.method || 'GET').toUpperCase()} ${p.endpoint} observed by ${p.source}`,
        request: requestFor(p),
        expectedResponse: expectedResponse(p.response),
      })),
    };
    const outFile = path.join(outDir, `${contractId}.${first.consumer}.pact.json`);
    fs.writeFileSync(outFile, JSON.stringify(doc, null, 2));
    written.push(outFile);
  }
  return written;
}

const outDir = path.join(CWD, 'contracts', 'consumer');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${consumer}-consumes-${provider}.pact.json`);
fs.writeFileSync(
  outFile,
  JSON.stringify(
    {
      consumer,
      provider,
      generated: new Date().toISOString(),
      interactions: pacts,
    },
    null,
    2,
  ),
);

console.log(`wrote ${pacts.length} interaction pacts → ${path.relative(CWD, outFile)}`);
const replayPacts = writeStep06bPacts();
if (replayPacts.length) {
  const replayDir = path.dirname(replayPacts[0]);
  console.log(
    `wrote ${replayPacts.length} Step 06B replay pact${replayPacts.length === 1 ? '' : 's'} -> ${path.relative(
      CWD,
      replayDir,
    )}`,
  );
}
if (!pacts.length) process.exit(0);
