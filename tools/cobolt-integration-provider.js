#!/usr/bin/env node

// CoBolt Integration Provider Scanner (v0.13.2, Phase 3B)
//
// Third-party integration code gets mocked/stubbed under test pressure.
// A regex-only audit catches common patterns; agents invent novel ones.
// This scanner enforces two census properties against
// source/schemas/known-providers.json:
//
//   1) CODE CENSUS — every file that imports a known provider SDK must
//      either (a) import from src/integrations/<provider>.js (a local
//      copy of the blessed adapter at source/patterns/integrations/
//      <provider>.md), or (b) carry a reference comment citing that
//      adapter path explicitly. A file that imports the raw SDK without
//      adopting the blessed pattern is flagged as a 'rogue' integration.
//
//   2) REGISTER CENSUS — every provider declared in
//      _cobolt-output/latest/planning/dependency-register.md (by id
//      listed in known-providers.json) must satisfy four conditions on
//      disk: (i) wiring evidence, (ii) failure-mode contract evidence,
//      (iii) structured telemetry evidence, and (iv) contract or sandbox
//      test evidence. Missing any one is a census violation. Census, not
//      sampling.
//
// Usage:
//   node tools/cobolt-integration-provider.js scan [--json]
//   node tools/cobolt-integration-provider.js gate     # exit 1 on violations
//
// Writes  _cobolt-output/latest/integrations/report.json
// Appends _cobolt-output/audit/integration-provider-log.jsonl
//
// Falls back to an inline provider registry when known-providers.json is
// absent or unreadable, and reports registry-parity drift when the file
// exists but diverges from the inline fallback. Permissive when both
// dependency-register.md AND imports in src/ are absent (fresh repos).

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '_cobolt-output',
  'dist',
  'build',
  '.next',
  '.cache',
  'coverage',
  'source',
]);

const CODE_EXTS = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs']);
const INTEGRATION_EXTS = ['.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx'];

const INLINE_KNOWN_PROVIDERS = [
  {
    id: 'stripe',
    title: 'Stripe Payments',
    adapter: 'source/patterns/integrations/stripe.md',
    sdkModules: ['stripe'],
    sandboxEnvVar: 'STRIPE_SANDBOX_SECRET_KEY',
    requiredSecrets: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
    idempotencyStrategy: 'native-idempotency-key-header',
    webhookSigning: 'stripe-signature-hmac-sha256',
    category: 'payments',
  },
  {
    id: 'oauth-oidc',
    title: 'OAuth 2.0 / OIDC Identity Provider',
    adapter: 'source/patterns/integrations/oauth-oidc.md',
    sdkModules: ['openid-client', 'passport', 'next-auth', '@auth/core', 'jose'],
    sandboxEnvVar: 'OIDC_SANDBOX_ISSUER',
    requiredSecrets: ['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_ISSUER'],
    idempotencyStrategy: 'pkce-state-nonce',
    webhookSigning: 'not-applicable',
    category: 'auth',
  },
  {
    id: 'twilio',
    title: 'Twilio SMS / Voice',
    adapter: 'source/patterns/integrations/twilio.md',
    sdkModules: ['twilio'],
    sandboxEnvVar: 'TWILIO_TEST_ACCOUNT_SID',
    requiredSecrets: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_MESSAGING_SERVICE_SID'],
    idempotencyStrategy: 'client-dedup-key',
    webhookSigning: 'twilio-x-signature-hmac-sha1',
    category: 'sms',
  },
  {
    id: 'sendgrid',
    title: 'SendGrid Transactional Email',
    adapter: 'source/patterns/integrations/sendgrid.md',
    sdkModules: ['@sendgrid/mail', '@sendgrid/client'],
    sandboxEnvVar: 'SENDGRID_SANDBOX_MODE',
    requiredSecrets: ['SENDGRID_API_KEY'],
    idempotencyStrategy: 'custom-args-message-id',
    webhookSigning: 'sendgrid-ed25519',
    category: 'email',
  },
  {
    id: 'webhook-receiver',
    title: 'Generic Inbound Webhook Receiver',
    adapter: 'source/patterns/integrations/webhook-receiver.md',
    sdkModules: [],
    sandboxEnvVar: 'WEBHOOK_REPLAY_FIXTURE_DIR',
    requiredSecrets: ['WEBHOOK_SHARED_SECRET'],
    idempotencyStrategy: 'event-id-dedup-store',
    webhookSigning: 'hmac-sha256-timestamped',
    category: 'webhook',
  },
  {
    id: 's3-upload',
    title: 'S3-Compatible Blob Storage',
    adapter: 'source/patterns/integrations/s3-upload.md',
    sdkModules: ['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner', 'minio'],
    sandboxEnvVar: 'S3_ENDPOINT_URL',
    requiredSecrets: ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET'],
    idempotencyStrategy: 'content-addressed-key',
    webhookSigning: 's3-event-notification-optional',
    category: 'blob-storage',
  },
];

function cloneInlineProviders() {
  return JSON.parse(JSON.stringify(INLINE_KNOWN_PROVIDERS));
}

function loadKnownProviders() {
  const candidates = [
    path.join(process.cwd(), 'source', 'schemas', 'known-providers.json'),
    path.join(__dirname, '..', 'source', 'schemas', 'known-providers.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        return parsed.providers || [];
      } catch {
        return cloneInlineProviders();
      }
    }
  }
  return cloneInlineProviders();
}

function providerComparable(p) {
  return {
    id: p.id,
    adapter: p.adapter,
    sdkModules: [...(p.sdkModules || [])].sort(),
    sandboxEnvVar: p.sandboxEnvVar || '',
    requiredSecrets: [...(p.requiredSecrets || [])].sort(),
    idempotencyStrategy: p.idempotencyStrategy || '',
    webhookSigning: p.webhookSigning || '',
    category: p.category || '',
  };
}

function registryParity(providers) {
  const actual = [...providers].map(providerComparable).sort((a, b) => a.id.localeCompare(b.id));
  const expected = [...INLINE_KNOWN_PROVIDERS].map(providerComparable).sort((a, b) => a.id.localeCompare(b.id));
  return {
    ok: JSON.stringify(actual) === JSON.stringify(expected),
    inlineCount: expected.length,
    artifactCount: actual.length,
  };
}

function walk(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (IGNORE_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, acc);
    } else if (e.isFile()) {
      acc.push(full);
    }
  }
  return acc;
}

function buildSdkIndex(providers) {
  const idx = new Map();
  for (const p of providers) {
    for (const mod of p.sdkModules || []) {
      idx.set(mod, p);
    }
  }
  return idx;
}

const IMPORT_RE = /(?:require\(\s*['"]([^'"]+)['"]\s*\))|(?:from\s+['"]([^'"]+)['"])|(?:import\s+['"]([^'"]+)['"])/g;

function extractImports(source) {
  const imports = [];
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(source)) !== null) {
    const spec = m[1] || m[2] || m[3];
    if (spec) imports.push(spec);
  }
  return imports;
}

function matchSdk(spec, sdkIndex) {
  if (sdkIndex.has(spec)) return sdkIndex.get(spec);
  for (const [mod, provider] of sdkIndex.entries()) {
    if (spec === mod) return provider;
    if (spec.startsWith(`${mod}/`)) return provider;
  }
  return null;
}

function referencesBlessedAdapter(source, provider) {
  if (source.includes(`source/patterns/integrations/${provider.id}.md`)) return true;
  if (source.includes(`patterns/integrations/${provider.id}.md`)) return true;
  return false;
}

function importsLocalAdapter(source, provider) {
  const re = new RegExp(
    `(?:require|from|import)\\s*\\(?\\s*['"][^'"]*integrations/${provider.id}(?:\\.js|\\.ts|\\.mjs|\\.cjs)?['"]`,
  );
  return re.test(source);
}

function scanCodeCensus(providers) {
  const sdkIndex = buildSdkIndex(providers);
  const violations = [];
  const cwd = process.cwd();
  const files = walk(cwd, []);
  for (const file of files) {
    if (!CODE_EXTS.has(path.extname(file))) continue;
    if (file.includes(`${path.sep}tests${path.sep}`) || file.includes(`${path.sep}test${path.sep}`)) continue;
    if (file.includes(`${path.sep}src${path.sep}integrations${path.sep}`)) continue;
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const imports = extractImports(source);
    for (const spec of imports) {
      const provider = matchSdk(spec, sdkIndex);
      if (!provider) continue;
      const hasLocalAdapter = importsLocalAdapter(source, provider);
      const hasAdapterComment = referencesBlessedAdapter(source, provider);
      if (!hasLocalAdapter && !hasAdapterComment) {
        violations.push({
          kind: 'rogue-import',
          provider: provider.id,
          file: path.relative(cwd, file),
          import: spec,
          remediation: `Import from src/integrations/${provider.id}.js (copy of ${provider.adapter}) OR add a comment referencing ${provider.adapter}.`,
        });
      }
    }
  }
  return violations;
}

function findTests(provider, suffix) {
  const cwd = process.cwd();
  const roots = ['tests', 'test', '__tests__'];
  const suffixes = [`${suffix}.test.js`, `${suffix}.test.ts`, `${suffix}.test.mjs`, `${suffix}.test.cjs`];
  for (const root of roots) {
    const dir = path.join(cwd, root);
    if (!fs.existsSync(dir)) continue;
    const files = walk(dir, []);
    for (const f of files) {
      const base = path.basename(f);
      for (const s of suffixes) {
        if (base === `${provider.id}.${s}` || base.endsWith(`-${provider.id}.${s}`) || base === `${provider.id}.${s}`) {
          return path.relative(cwd, f);
        }
      }
      if (base.includes(provider.id) && base.includes(suffix) && /\.test\.(js|ts|mjs|cjs)$/.test(base)) {
        return path.relative(cwd, f);
      }
    }
  }
  return null;
}

function adapterExists(provider) {
  const p = path.join(process.cwd(), provider.adapter);
  if (fs.existsSync(p)) return provider.adapter;
  const fallback = path.join(__dirname, '..', provider.adapter);
  if (fs.existsSync(fallback)) return provider.adapter;
  return null;
}

function localAdapterExists(provider) {
  const candidates = [];
  for (const ext of INTEGRATION_EXTS) {
    candidates.push(path.join(process.cwd(), 'src', 'integrations', `${provider.id}${ext}`));
    candidates.push(path.join(process.cwd(), 'src', 'integrations', provider.id, `index${ext}`));
  }
  const found = candidates.find((p) => fs.existsSync(p));
  return found ? path.relative(process.cwd(), found) : null;
}

function fileExistsAny(candidates) {
  const found = candidates.find((p) => fs.existsSync(path.join(process.cwd(), p)));
  return found || null;
}

function failureModeContractExists(provider) {
  const declared = fileExistsAny([
    `contracts/integrations/${provider.id}.failure-contract.json`,
    `contracts/integrations/${provider.id}.failure-contract.yaml`,
    `contracts/integrations/${provider.id}.failure-contract.yml`,
    `contracts/integrations/${provider.id}.failure-contract.md`,
    `_cobolt-output/latest/integrations/${provider.id}.failure-contract.json`,
  ]);
  return declared || adapterExists(provider);
}

function telemetryEvidenceExists(provider) {
  const declared = fileExistsAny([
    `src/integrations/${provider.id}.telemetry.json`,
    `src/integrations/${provider.id}/telemetry.json`,
    `observability/integrations/${provider.id}.telemetry.json`,
    `contracts/integrations/${provider.id}.telemetry.json`,
    `_cobolt-output/latest/integrations/${provider.id}.telemetry.json`,
  ]);
  if (declared) return declared;
  const adapter = localAdapterExists(provider);
  if (!adapter) return null;
  try {
    const source = fs.readFileSync(path.join(process.cwd(), adapter), 'utf8');
    if (
      /\b(emitIntegrationTelemetry|recordIntegrationMetric|integrationTelemetry|trace\.|span\.|metrics\.|logger\.)\b/.test(
        source,
      )
    ) {
      return adapter;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function parseRegisterDeclaredProviders(providers) {
  const registerPath = path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'dependency-register.md');
  if (!fs.existsSync(registerPath)) return { present: false, declared: [] };
  let contents;
  try {
    contents = fs.readFileSync(registerPath, 'utf8').toLowerCase();
  } catch {
    return { present: true, declared: [] };
  }
  const declared = [];
  for (const p of providers) {
    const needles = [p.id, ...(p.sdkModules || []).map((m) => m.toLowerCase())];
    if (needles.some((n) => contents.includes(n))) {
      declared.push(p);
    }
  }
  return { present: true, declared };
}

function scanRegisterCensus(providers) {
  const { present, declared } = parseRegisterDeclaredProviders(providers);
  if (!present) return { registerPresent: false, violations: [] };
  const violations = [];
  for (const provider of declared) {
    const wiring = localAdapterExists(provider);
    const failureContract = failureModeContractExists(provider);
    const telemetry = telemetryEvidenceExists(provider);
    const sandbox = findTests(provider, 'sandbox');
    const failure = findTests(provider, 'failure');
    const contract = findTests(provider, 'contract') || findTests(provider, 'pact') || sandbox;
    const missing = [];
    if (!wiring) missing.push('wiring-evidence');
    if (!failureContract || !failure) missing.push('failure-mode-contract');
    if (!telemetry) missing.push('structured-telemetry');
    if (!contract) missing.push('contract-test');
    if (missing.length > 0) {
      violations.push({
        kind: 'register-census',
        provider: provider.id,
        missing,
        evidence: { wiring, failureContract, telemetry, sandbox, failure, contract },
        remediation:
          `Declared in dependency-register.md but missing: ${missing.join(', ')}. ` +
          `Expected wiring: src/integrations/${provider.id}.*; failure-mode contract: ${provider.adapter} ` +
          `plus tests/**/${provider.id}.failure.test.*; telemetry: src|observability|contracts integration telemetry artifact; ` +
          `contract test: tests/**/${provider.id}.contract.test.* or sandbox equivalent.`,
      });
    }
  }
  return { registerPresent: true, violations };
}

function appendAudit(entry) {
  try {
    const dir = path.join(process.cwd(), '_cobolt-output', 'audit');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'integration-provider-log.jsonl'),
      `${JSON.stringify({ ...entry, ts: new Date().toISOString() })}\n`,
    );
  } catch {
    /* best-effort */
  }
}

function writeReport(report) {
  try {
    const dir = path.join(process.cwd(), '_cobolt-output', 'latest', 'integrations');
    atomicWrite(path.join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  } catch {
    /* best-effort */
  }
}

function run() {
  const providers = loadKnownProviders();
  if (providers.length === 0) {
    return { ok: true, skipped: 'known-providers.json absent', violations: [] };
  }
  const parity = registryParity(providers);
  const codeViolations = scanCodeCensus(providers);
  const { registerPresent, violations: registerViolations } = scanRegisterCensus(providers);
  const parityViolations = parity.ok
    ? []
    : [
        {
          kind: 'registry-parity',
          provider: 'known-providers',
          missing: ['inline-registry-parity'],
          remediation:
            'Update INLINE_KNOWN_PROVIDERS in tools/cobolt-integration-provider.js to match source/schemas/known-providers.json, or vice versa.',
        },
      ];
  const violations = [...parityViolations, ...codeViolations, ...registerViolations];
  const report = {
    generatedAt: new Date().toISOString(),
    providersCount: providers.length,
    registryParity: parity,
    registerPresent,
    violations,
    ok: violations.length === 0,
  };
  writeReport(report);
  if (violations.length > 0) {
    for (const v of violations) appendAudit(v);
  }
  return report;
}

function main() {
  const cmd = process.argv[2] || 'scan';
  const report = run();
  if (cmd === 'gate') {
    if (report.violations && report.violations.length > 0) {
      process.stdout.write(JSON.stringify(report));
      process.exit(1);
    }
    process.exit(0);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
  main();
}

module.exports = {
  run,
  scanCodeCensus,
  scanRegisterCensus,
  loadKnownProviders,
  registryParity,
  INLINE_KNOWN_PROVIDERS,
};
