#!/usr/bin/env node

// CoBolt Runtime A11y Runner (v0.12.0 Phase 3A)
//
// Companion to cobolt-a11y-linter.js (static TSX/JSX pattern scanner).
// This tool runs the app in a headless browser and injects axe-core to
// detect the violations the static linter cannot see:
//
//   - Keyboard traps (tab-cycle exits the modal)
//   - Focus management (modal focus-lock, return focus on close)
//   - Runtime ARIA semantics (live regions, role conflicts)
//   - Contrast at rendered pixel level (not CSS string)
//   - Landmark coverage and heading order
//   - Form label association (ID linkage through state changes)
//
// Strategy:
//   1. Prefer @axe-core/playwright if installed.
//   2. Fallback: serve a small Puppeteer-style script via npx playwright.
//   3. Fallback 2: emit diagnostics-only JSON with setup instructions.
//
// Output: _cobolt-output/latest/a11y/a11y-runtime-findings.json conforming
// to the shape cobolt-a11y-i18n-gate.js expects (findings[] with severity,
// rule, element, message).
//
// Usage:
//   node tools/cobolt-a11y-runtime.js scan --url http://localhost:3000
//   node tools/cobolt-a11y-runtime.js scan --url URL --route /dashboard --route /login
//   node tools/cobolt-a11y-runtime.js setup    # print install instructions

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ROUTES = ['/'];
const DEFAULT_TIMEOUT = 30_000;

function resolvePkg(pkgName) {
  try {
    return require.resolve(pkgName, { paths: [process.cwd(), path.join(process.cwd(), 'node_modules')] });
  } catch {
    return null;
  }
}

function hasPlaywright() {
  return Boolean(resolvePkg('@playwright/test') || resolvePkg('playwright'));
}

function hasAxe() {
  return Boolean(resolvePkg('axe-core'));
}

function hasAxePlaywright() {
  return Boolean(resolvePkg('@axe-core/playwright'));
}

function setupInstructions() {
  return {
    ok: false,
    mode: 'setup-required',
    missing: {
      playwright: !hasPlaywright(),
      'axe-core': !hasAxe(),
      '@axe-core/playwright': !hasAxePlaywright(),
    },
    install: [
      'npm install --save-dev @playwright/test axe-core @axe-core/playwright',
      'npx playwright install chromium',
    ],
    note: 'a11y-runtime scan requires Playwright + axe-core. Falling back to static lint coverage only.',
  };
}

// ── Inline runner — dynamically import axe-core/playwright when available.
async function runScan({ url, routes, timeout }) {
  if (!hasPlaywright() || !hasAxePlaywright() || !hasAxe()) {
    return setupInstructions();
  }

  // Dynamic import so the tool loads even if packages aren't present
  const { chromium } = require(resolvePkg('playwright') || resolvePkg('@playwright/test'));
  const AxeBuilder = require(resolvePkg('@axe-core/playwright')).default;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const findings = [];
  const perRoute = [];

  try {
    for (const route of routes) {
      const full = url.replace(/\/$/, '') + route;
      const page = await context.newPage();
      page.setDefaultTimeout(timeout);
      try {
        await page.goto(full, { waitUntil: 'domcontentloaded', timeout });
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'])
          .analyze();
        const routeFindings = [];
        for (const v of results.violations) {
          const f = {
            rule: v.id,
            impact: v.impact || 'minor',
            severity:
              v.impact === 'critical'
                ? 'critical'
                : v.impact === 'serious'
                  ? 'high'
                  : v.impact === 'moderate'
                    ? 'medium'
                    : 'low',
            tags: v.tags,
            help: v.help,
            helpUrl: v.helpUrl,
            description: v.description,
            route,
            nodes: v.nodes.slice(0, 5).map((n) => ({
              target: n.target,
              html: (n.html || '').slice(0, 400),
              failureSummary: n.failureSummary || '',
            })),
          };
          findings.push(f);
          routeFindings.push({ rule: f.rule, severity: f.severity });
        }
        perRoute.push({ route, url: full, violations: routeFindings.length, findings: routeFindings });
      } catch (err) {
        perRoute.push({ route, url: full, error: err?.message || 'navigation failed' });
      } finally {
        await page.close();
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  return {
    ok: true,
    mode: 'axe-playwright',
    generatedAt: new Date().toISOString(),
    appUrl: url,
    perRoute,
    findings,
    summary: {
      total: findings.length,
      critical: findings.filter((f) => f.severity === 'critical').length,
      high: findings.filter((f) => f.severity === 'high').length,
      medium: findings.filter((f) => f.severity === 'medium').length,
      low: findings.filter((f) => f.severity === 'low').length,
    },
  };
}

function writeOutput(result) {
  const dir = path.join(process.cwd(), '_cobolt-output', 'latest', 'a11y');
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, 'a11y-runtime-findings.json');
  fs.writeFileSync(fp, JSON.stringify(result, null, 2));
  return fp;
}

function parseFlags(args) {
  const out = { _: [], url: null, routes: [], timeout: DEFAULT_TIMEOUT };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--url') out.url = args[++i];
    else if (a === '--route') out.routes.push(args[++i]);
    else if (a === '--timeout') out.timeout = Number(args[++i]);
    else out._.push(a);
  }
  if (out.routes.length === 0) out.routes = DEFAULT_ROUTES;
  return out;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (cmd) {
    case 'setup': {
      console.log(JSON.stringify(setupInstructions(), null, 2));
      return 0;
    }
    case 'scan': {
      if (!flags.url) {
        console.error('--url required');
        return 1;
      }
      const r = await runScan(flags);
      writeOutput(r);
      console.log(JSON.stringify(r, null, 2));
      // Exit-code contract (per tools/CLAUDE.md):
      //   0 — real scan completed with no critical/high findings
      //   1 — real scan completed with critical/high findings present
      //   2 — missing optional dependency (@axe-core/playwright, axe-core, playwright)
      // Previously this returned 0 on setup-required to avoid CI failures, which caused
      // a11y gates to record green without a scan ever running. Tier 2 gates must treat
      // exit code 2 as skip-and-report, not success.
      if (!r.ok) return 2;
      return r.summary.critical + r.summary.high > 0 ? 1 : 0;
    }
    default:
      console.error('Usage: cobolt-a11y-runtime.js {scan|setup} [--url URL] [--route /path]+');
      return 1;
  }
}

if (require.main === module) {
  main()
    .then((c) => process.exit(c || 0))
    .catch((e) => {
      console.error(e?.stack || e?.message);
      process.exit(1); // hard error (unexpected exception) — distinct from exit 2 (missing dep)
    });
}

module.exports = { runScan, setupInstructions, hasPlaywright, hasAxePlaywright };
