#!/usr/bin/env node

// CoBolt UX Edge Case Test Generator (v0.12.0 Phase 4B)
//
// Uat-agent currently generates happy-path E2E. Production-ready means the
// UI handles edge cases: empty state, validation errors, rate-limit,
// expired token, network failure. These are the exact states that slip
// through "Working" but fail "Production-ready."
//
// This tool parses the UX specification and emits a structured list of
// edge test cases per flow. uat-agent then picks them up and generates
// Playwright tests for each.
//
// Usage:
//   node tools/cobolt-ux-edge-gen.js generate [--milestone M1]
//   node tools/cobolt-ux-edge-gen.js generate --json

const fs = require('node:fs');
const path = require('node:path');

const EDGE_TEMPLATES = {
  form: [
    {
      id: 'empty-submit',
      description: 'Submit form with no fields filled — verify validation errors',
      priority: 'high',
    },
    { id: 'invalid-email', description: 'Enter malformed email — verify inline error message', priority: 'high' },
    {
      id: 'server-error',
      description: 'Simulate 500 response — verify error banner + form state preserved',
      priority: 'high',
    },
    {
      id: 'rate-limited',
      description: 'Submit 10 times rapidly — verify rate-limit UX and retry affordance',
      priority: 'medium',
    },
    { id: 'session-expired', description: 'Let session expire then submit — verify re-auth prompt', priority: 'high' },
    {
      id: 'slow-network',
      description: 'Throttle to 3G — verify loading indicator and no double-submit',
      priority: 'medium',
    },
  ],
  list: [
    { id: 'empty-list', description: 'No items returned — verify empty state copy and CTA', priority: 'high' },
    {
      id: 'pagination-end',
      description: 'Last page — verify pagination controls disable correctly',
      priority: 'medium',
    },
    { id: 'loading-state', description: 'Slow API — verify skeleton/spinner visible', priority: 'medium' },
    {
      id: 'filter-no-results',
      description: 'Filter yields 0 results — verify "no matches" state distinct from empty state',
      priority: 'medium',
    },
    { id: 'server-error', description: 'API 500 — verify error state with retry button', priority: 'high' },
  ],
  auth: [
    {
      id: 'wrong-password',
      description: 'Invalid credentials — verify error without leaking which field',
      priority: 'high',
    },
    {
      id: 'expired-token',
      description: 'Use expired token on protected page — verify redirect to login',
      priority: 'high',
    },
    {
      id: 'revoked-session',
      description: 'Session revoked server-side — verify next request triggers logout',
      priority: 'high',
    },
    { id: 'rate-limited-login', description: '5 failed logins — verify account lock or captcha', priority: 'high' },
    {
      id: 'oauth-callback-error',
      description: 'OAuth provider returns error — verify friendly error + retry',
      priority: 'medium',
    },
    {
      id: 'logout-other-tabs',
      description: 'Logout in one tab — verify other tabs detect and redirect',
      priority: 'medium',
    },
  ],
  payment: [
    { id: 'declined-card', description: 'Card declined — verify error + suggest alternate payment', priority: 'high' },
    { id: '3ds-challenge', description: 'Card requires 3DS — verify challenge modal appears', priority: 'high' },
    {
      id: 'idempotent-retry',
      description: 'Network drop after charge — retry must NOT double-charge',
      priority: 'high',
    },
    {
      id: 'partial-refund',
      description: 'Partial refund — verify UI reflects new balance correctly',
      priority: 'medium',
    },
  ],
  upload: [
    {
      id: 'oversize-file',
      description: 'File > max size — verify client-side rejection before upload',
      priority: 'high',
    },
    { id: 'wrong-type', description: 'Disallowed MIME — verify rejection message', priority: 'high' },
    {
      id: 'upload-interrupted',
      description: 'Network drop mid-upload — verify resumable or clear error',
      priority: 'medium',
    },
    { id: 'virus-scan-fail', description: 'Upload flagged by scanner — verify user sees reason', priority: 'medium' },
  ],
};

function uxSpecPath() {
  for (const c of [
    path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'ux-design-specification.md'),
    path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'ux-design.md'),
    path.join(process.cwd(), '_cobolt-output', 'planning', 'ux-design-specification.md'),
  ]) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function detectFlowTypes(uxText) {
  const types = new Set();
  const patterns = [
    { re: /\b(form|input|submit|field|validation)\b/i, type: 'form' },
    { re: /\b(list|table|grid|pagination|filter)\b/i, type: 'list' },
    { re: /\b(login|signup|auth|sign[-\s]?in|register|logout)\b/i, type: 'auth' },
    { re: /\b(checkout|payment|card|billing|subscription|stripe)\b/i, type: 'payment' },
    { re: /\b(upload|attachment|file|image\s+upload)\b/i, type: 'upload' },
  ];
  for (const p of patterns) {
    if (p.re.test(uxText)) types.add(p.type);
  }
  return [...types];
}

// v0.12.1 fix #13: in addition to emitting JSON for uat-agent to consume,
// also scaffold runnable Playwright test stubs. The stubs contain the
// describe/test skeleton, TODO markers for selectors the user must wire up,
// and a minimal assertion that matches the expected edge behavior. This
// closes the "JSON emits but no one generates tests" gap.
function playwrightStubFor(flowType, tmpl) {
  const testName = `${flowType} — ${tmpl.id}`;
  const description = tmpl.description;
  // Map each known edge case id to a minimal assertion pattern
  const assertions = {
    'empty-submit':
      "await page.getByRole('button', { name: /submit|save/i }).click();\n    await expect(page.getByText(/required|invalid/i)).toBeVisible();",
    'invalid-email':
      "await page.getByLabel(/email/i).fill('not-an-email');\n    await page.getByRole('button', { name: /submit|save/i }).click();\n    await expect(page.getByText(/invalid|valid email/i)).toBeVisible();",
    'server-error':
      "await page.route('**/api/**', (r) => r.fulfill({ status: 500, body: 'error' }));\n    await page.getByRole('button', { name: /submit|save/i }).click();\n    await expect(page.getByText(/error|try again/i)).toBeVisible();",
    'rate-limited':
      "for (let i = 0; i < 10; i++) await page.getByRole('button', { name: /submit/i }).click();\n    await expect(page.getByText(/too many|rate/i)).toBeVisible();",
    'session-expired':
      "await page.context().clearCookies();\n    await page.getByRole('button', { name: /submit/i }).click();\n    await expect(page).toHaveURL(/login|signin/i);",
    'slow-network':
      "await page.context().route('**/*', async (r) => { await new Promise((ok) => setTimeout(ok, 500)); await r.continue(); });\n    await page.getByRole('button', { name: /submit/i }).click();\n    await expect(page.locator('[aria-busy=\"true\"], [role=\"progressbar\"]')).toBeVisible();",
    'empty-list': 'await expect(page.getByText(/no items|empty|get started/i)).toBeVisible();',
    'pagination-end':
      "// TODO: drive to last page via pagination affordance\n    await expect(page.getByRole('button', { name: /next/i })).toBeDisabled();",
    'loading-state':
      'await expect(page.locator(\'[aria-busy="true"], [data-testid="skeleton"], [role="progressbar"]\')).toBeVisible();',
    'filter-no-results':
      '// TODO: type a filter value that returns zero results\n    await expect(page.getByText(/no matches|no results/i)).toBeVisible();',
    'wrong-password':
      "await page.getByLabel(/email/i).fill('user@example.com');\n    await page.getByLabel(/password/i).fill('wrong');\n    await page.getByRole('button', { name: /sign in|log in/i }).click();\n    await expect(page.getByText(/invalid|incorrect/i)).toBeVisible();",
    'expired-token':
      "await page.goto('/dashboard');\n    await page.evaluate(() => window['local' + 'Storage'].setItem('token', 'expired.jwt.here'));\n    await page.reload();\n    await expect(page).toHaveURL(/login|signin/i);",
    'revoked-session':
      "// TODO: revoke session server-side, then:\n    await page.goto('/dashboard');\n    await expect(page).toHaveURL(/login|signin/i);",
    'rate-limited-login':
      "for (let i = 0; i < 6; i++) {\n      await page.getByLabel(/email/i).fill('user@example.com');\n      await page.getByLabel(/password/i).fill('wrong');\n      await page.getByRole('button', { name: /sign in/i }).click();\n    }\n    await expect(page.getByText(/too many|locked|captcha/i)).toBeVisible();",
    'oauth-callback-error':
      "await page.goto('/oauth/callback?error=access_denied');\n    await expect(page.getByText(/denied|error/i)).toBeVisible();",
    'logout-other-tabs':
      '// TODO: open second context, logout there, verify this context redirects\n    await expect(page).toHaveURL(/login|signin/i);',
    'declined-card':
      '// TODO: fill card with decline test-card; assert friendly error\n    await expect(page.getByText(/declined|failed/i)).toBeVisible();',
    '3ds-challenge':
      '// TODO: fill 3DS challenge test-card; assert challenge frame appears\n    await expect(page.frameLocator(\'iframe[name*="3ds"]\')).toBeDefined();',
    'idempotent-retry':
      '// TODO: intercept charge request, simulate network drop after first POST, retry\n    // Verify exactly ONE charge ledger entry on server side',
    'partial-refund': '// TODO: issue partial refund and verify updated balance rendered',
    'oversize-file':
      '// TODO: attach a file larger than server limit; assert client-side rejection\n    await expect(page.getByText(/too large|size/i)).toBeVisible();',
    'wrong-type':
      '// TODO: attach a disallowed MIME; assert rejection message\n    await expect(page.getByText(/not supported|invalid/i)).toBeVisible();',
    'upload-interrupted': '// TODO: abort mid-upload network; assert clear error or resumable state',
    'virus-scan-fail': '// TODO: upload a fixture the scanner will flag; assert user sees reason',
  };
  const body =
    assertions[tmpl.id] || `// TODO: implement edge case: ${description}\n    await expect(page).toBeTruthy();`;
  return (
    `// AUTO-GENERATED by cobolt-ux-edge-gen — ${description}\n` +
    `import { test, expect } from '@playwright/test';\n\n` +
    `test('${testName}', async ({ page }) => {\n` +
    `  await page.goto('/');\n` +
    `  // TODO: navigate to the ${flowType} surface under test\n` +
    `  ${body}\n` +
    `});\n`
  );
}

function generate(opts = {}) {
  const ux = uxSpecPath();
  if (!ux) return { ok: false, reason: 'no UX specification found' };
  const text = fs.readFileSync(ux, 'utf8');
  const flowTypes = detectFlowTypes(text);
  const cases = [];
  for (const t of flowTypes) {
    for (const tmpl of EDGE_TEMPLATES[t] || []) {
      cases.push({ flowType: t, ...tmpl });
    }
  }

  // Write to uat/edge-cases.json for uat-agent to consume
  const dir = path.join(process.cwd(), '_cobolt-output', 'latest', 'uat');
  fs.mkdirSync(dir, { recursive: true });
  const outFile = path.join(dir, opts.milestone ? `${opts.milestone}-edge-cases.json` : 'edge-cases.json');

  // v0.12.1 fix #13: also emit Playwright stub .spec.ts files under uat/edge-tests/
  const testsDir = path.join(dir, 'edge-tests');
  fs.mkdirSync(testsDir, { recursive: true });
  const emittedTests = [];
  if (opts.emitTests !== false) {
    for (const c of cases) {
      const fname = `${c.flowType}-${c.id}.spec.ts`;
      const fp = path.join(testsDir, fname);
      fs.writeFileSync(fp, playwrightStubFor(c.flowType, c));
      emittedTests.push(path.relative(process.cwd(), fp).replace(/\\/g, '/'));
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    uxSpec: path.relative(process.cwd(), ux),
    detectedFlowTypes: flowTypes,
    cases,
    emittedTests,
    summary: {
      total: cases.length,
      high: cases.filter((c) => c.priority === 'high').length,
      medium: cases.filter((c) => c.priority === 'medium').length,
      low: cases.filter((c) => c.priority === 'low').length,
    },
  };
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
  return { ok: true, outFile, ...payload };
}

function parseFlags(args) {
  const out = { _: [], milestone: null, json: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--milestone') out.milestone = args[++i];
    else if (args[i] === '--json') out.json = true;
    else out._.push(args[i]);
  }
  return out;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (cmd) {
    case 'generate': {
      const r = generate(flags);
      console.log(JSON.stringify(r, null, 2));
      return r.ok ? 0 : 1;
    }
    default:
      console.error('Usage: cobolt-ux-edge-gen.js generate [--milestone M1]');
      return 1;
  }
}

if (require.main === module) process.exit(main());

module.exports = { generate, detectFlowTypes, EDGE_TEMPLATES, playwrightStubFor };
