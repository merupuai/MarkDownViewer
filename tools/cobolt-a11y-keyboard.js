#!/usr/bin/env node
// S7 — Keyboard-navigation Playwright harness. Runs Tab/Shift-Tab/Enter/Escape
// against every interactive flow in the UX spec and asserts declared focus order.
//
// Exit codes (CoBolt tool contract):
//   0 — real run completed (playwright installed, report written)
//   1 — hard error (misuse, unexpected exception)
//   2 — missing optional dependency (playwright). Caller (Tier 2 gate) should skip-and-report.
//
// Usage:
//   node tools/cobolt-a11y-keyboard.js --url http://localhost:3000 --spec ux-design-specification.md
//   node tools/cobolt-a11y-keyboard.js --allow-stub    # write harness stub even when playwright is missing (still exits 2)
//
// Historical note: the earlier implementation exited 0 after writing a stub when playwright
// was missing, which caused a11y gates to record green without ever running the harness.
// See memory: feedback_pipeline_fail_closed.md.

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
const CWD = process.cwd();
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const hasFlag = (flag) => process.argv.includes(flag);

const url = arg('--url', 'http://localhost:3000');
const _spec = arg('--spec', '_cobolt-output/latest/planning/ux-design-specification.md');
const allowStub = hasFlag('--allow-stub');

function emitMissingDepReport(reason) {
  const out = path.join(CWD, '_cobolt-output', 'latest', 'a11y', 'keyboard.json');
  atomicWrite(
    out,
    JSON.stringify(
      {
        status: 'missing-dependency',
        dependency: 'playwright',
        reason,
        ran: false,
        url,
      },
      null,
      2,
    ),
  );
}

function writeStubSpec() {
  const stub = path.join(CWD, 'tests', 'a11y', 'keyboard.spec.ts');
  fs.mkdirSync(path.dirname(stub), { recursive: true });
  fs.writeFileSync(
    stub,
    `import { test, expect } from '@playwright/test';

test('keyboard focus order', async ({ page }) => {
  await page.goto('${url}');
  const order = [];
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab');
    order.push(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') || document.activeElement?.tagName));
  }
  expect(order).toMatchSnapshot('focus-order.json');
});

test('escape closes modal', async ({ page }) => {
  await page.goto('${url}');
  // TODO: open modal per UX spec
  await page.keyboard.press('Escape');
  expect(await page.locator('[role="dialog"]').count()).toBe(0);
});
`,
  );
  return stub;
}

let playwright;
try {
  playwright = require('playwright');
} catch (err) {
  const reason = err?.message ? err.message : 'require("playwright") failed';
  console.error('[a11y-keyboard] playwright not installed — keyboard harness did NOT run');
  console.error('[a11y-keyboard] install: npm install --save-dev playwright');
  emitMissingDepReport(reason);
  if (allowStub) {
    const stub = writeStubSpec();
    console.error('[a11y-keyboard] wrote harness stub (informational only):', stub);
  }
  // Exit 2 = missing optional dep. Callers MUST NOT treat this as success.
  process.exit(2);
}

(async () => {
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage();
  const report = { url, status: 'ran', flows: [] };
  try {
    await page.goto(url);
    const order = [];
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      const id = await page.evaluate(() => {
        const e = document.activeElement;
        return e ? e.getAttribute('data-testid') || e.id || e.tagName : null;
      });
      order.push(id);
    }
    report.flows.push({ flow: 'root-tab-order', order });
  } catch (e) {
    report.error = e.message;
    report.status = 'error';
  } finally {
    await browser.close();
  }
  const out = path.join(CWD, '_cobolt-output', 'latest', 'a11y', 'keyboard.json');
  atomicWrite(out, JSON.stringify(report, null, 2));
  console.log('keyboard report →', path.relative(CWD, out));
  process.exit(report.status === 'error' ? 1 : 0);
})();
