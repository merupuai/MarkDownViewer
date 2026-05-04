#!/usr/bin/env node

// CoBolt Playwright - Browser testing, route crawling, screenshots, and visual regression

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { paths: _paths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();
const flakeHunter = (() => {
  try {
    return require('../lib/cobolt-flake-hunter');
  } catch {
    return null;
  }
})();

const KNOWN_ROUTES = {
  public: [
    { path: '/', name: 'Landing', auth: false },
    { path: '/login', name: 'Login', auth: false },
  ],
  protected: [
    { path: '/dashboard', name: 'Project Dashboard', auth: true },
    { path: '/settings/api-keys', name: 'API Keys', auth: true },
    { path: '/dashboard/telemetry', name: 'Telemetry', auth: true },
    { path: '/onboarding', name: 'Onboarding', auth: true },
    { path: '/portfolio', name: 'Portfolio', auth: true },
    { path: '/search', name: 'Search', auth: true },
    { path: '/agents', name: 'Agent Catalog', auth: true },
    { path: '/compliance', name: 'Compliance', auth: true },
    { path: '/marketplace', name: 'Marketplace', auth: true },
    { path: '/webhooks', name: 'Webhooks', auth: true },
  ],
  api: [
    { path: '/api/v1/auth/me', name: 'Auth Me', method: 'GET' },
    { path: '/.well-known/agent.json', name: 'A2A Agent Card', method: 'GET' },
    { path: '/api/openapi.json', name: 'OpenAPI Spec', method: 'GET' },
    { path: '/api/graphql', name: 'GraphQL', method: 'POST' },
  ],
};

class PlaywrightTool {
  constructor(projectDir) {
    this.projectDir = projectDir || process.cwd();
    this._p = typeof _paths === 'function' ? _paths(this.projectDir) : null;
    this.e2eDir = path.join(this.projectDir, 'e2e');
    this.baseUrl = process.env.BASE_URL || 'http://localhost:4000';
  }

  _runRoot() {
    return this._p ? this._p.currentRun() : path.join(this.projectDir, '_cobolt-output', 'latest');
  }

  _outputDir() {
    return path.join(this._runRoot(), 'test-suite');
  }

  _legacyOutputDir() {
    return path.join(this._runRoot(), 'build');
  }

  _ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  _writeJson(filePath, data) {
    this._ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return filePath;
  }

  _playwrightConfigCandidates() {
    return [
      path.join(this.projectDir, 'e2e', 'playwright.config.js'),
      path.join(this.projectDir, 'e2e', 'playwright.config.ts'),
      path.join(this.projectDir, 'playwright.config.js'),
      path.join(this.projectDir, 'playwright.config.ts'),
    ];
  }

  _resolveConfigPath() {
    return this._playwrightConfigCandidates().find((candidate) => fs.existsSync(candidate)) || null;
  }

  _createFallbackConfig(testTarget) {
    const configPath = path.join(this.projectDir, '.cobolt-playwright.config.cjs');
    const resolvedTarget =
      testTarget && fs.existsSync(testTarget) ? testTarget : path.join(this.projectDir, 'e2e', 'tests');
    const testDir = fs.existsSync(resolvedTarget) ? resolvedTarget : path.join(this.projectDir, 'e2e', 'tests');
    const buildDir = this._legacyOutputDir();
    this._ensureDir(buildDir);

    const contents = [
      "const path = require('node:path');",
      '',
      'module.exports = {',
      `  testDir: ${JSON.stringify(testDir)},`,
      '  use: {',
      "    baseURL: process.env.BASE_URL || 'http://localhost:4000',",
      "    trace: 'retain-on-failure',",
      "    screenshot: 'only-on-failure',",
      '  },',
      '  reporter: [',
      `    ['json', { outputFile: ${JSON.stringify(path.join(buildDir, 'playwright-results.json'))} }],`,
      `    ['html', { outputFolder: ${JSON.stringify(path.join(buildDir, 'playwright-report'))}, open: 'never' }],`,
      '  ],',
      '};',
      '',
    ].join('\n');

    fs.writeFileSync(configPath, contents, 'utf8');
    return configPath;
  }

  _findResultsFile() {
    const candidates = [
      path.join(this._outputDir(), 'playwright-results.json'),
      path.join(this._legacyOutputDir(), 'playwright-results.json'),
    ];

    return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
  }

  _resolveTestTarget(candidate) {
    if (!candidate) return null;

    const resolved = path.isAbsolute(candidate) ? candidate : path.join(this.projectDir, candidate);
    if (fs.existsSync(resolved)) return resolved;

    const defaultTests = path.join(this.projectDir, 'e2e', 'tests');
    if (fs.existsSync(defaultTests)) return defaultTests;

    return null;
  }

  _copyRunArtifacts(targetDir) {
    if (!targetDir) return;

    const resolvedTarget = path.isAbsolute(targetDir) ? targetDir : path.join(this.projectDir, targetDir);
    this._ensureDir(resolvedTarget);

    const candidates = [
      this._findResultsFile(),
      path.join(this._outputDir(), 'playwright-report'),
      path.join(this._legacyOutputDir(), 'playwright-report'),
    ];

    for (const source of candidates) {
      if (!fs.existsSync(source)) continue;

      const destination = path.join(resolvedTarget, path.basename(source));
      try {
        if (fs.statSync(source).isDirectory()) {
          fs.cpSync(source, destination, { recursive: true, force: true });
        } else {
          fs.copyFileSync(source, destination);
        }
      } catch {
        /* best-effort */
      }
    }
  }

  _writeFlakeHunterArtifact() {
    if (!flakeHunter?.analyzeFlakes || !flakeHunter?.writeFlakeHunterReport) return null;

    try {
      const report = flakeHunter.analyzeFlakes(this.projectDir);
      return flakeHunter.writeFlakeHunterReport(this.projectDir, report);
    } catch {
      return null;
    }
  }

  _countTestsInSuites(suites = []) {
    let total = 0;

    for (const suite of suites || []) {
      for (const spec of suite.specs || []) {
        total += (spec.tests || []).length;
      }
      if (Array.isArray(suite.suites) && suite.suites.length > 0) {
        total += this._countTestsInSuites(suite.suites);
      }
    }

    return total;
  }

  _summarizeRunResults() {
    const resultsPath = this._findResultsFile();
    if (!resultsPath || !fs.existsSync(resultsPath)) {
      return { totalTests: 0, passed: 0, failed: 0, skipped: 0 };
    }

    try {
      const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
      const suites = results.suites || [];
      let passed = 0;
      let failed = 0;
      let skipped = 0;

      const visitSuites = (items) => {
        for (const suite of items || []) {
          for (const spec of suite.specs || []) {
            for (const test of spec.tests || []) {
              const lastResult = Array.isArray(test.results) && test.results.length > 0 ? test.results.at(-1) : null;
              const status = lastResult?.status || 'unknown';
              if (status === 'passed') passed++;
              else if (status === 'skipped') skipped++;
              else failed++;
            }
          }
          if (Array.isArray(suite.suites) && suite.suites.length > 0) {
            visitSuites(suite.suites);
          }
        }
      };

      visitSuites(suites);

      return {
        totalTests: this._countTestsInSuites(suites),
        passed,
        failed,
        skipped,
      };
    } catch {
      return { totalTests: 0, passed: 0, failed: 0, skipped: 0 };
    }
  }

  _loadPlaywright() {
    try {
      return require('playwright');
    } catch {
      return null;
    }
  }

  checkInstallation() {
    const status = { playwright: false, browsers: false, mcp: false, config: false };

    try {
      require.resolve('playwright');
      status.playwright = true;
    } catch {
      /* not installed */
    }

    try {
      require.resolve('@playwright/mcp');
      status.mcp = true;
    } catch {
      /* not installed */
    }

    status.config = !!this._resolveConfigPath();

    try {
      execFileSync('npx', ['playwright', 'install', '--dry-run'], {
        cwd: this.projectDir,
        encoding: 'utf8',
        timeout: 15000,
        stdio: 'pipe',
      });
      status.browsers = true;
    } catch {
      status.browsers = false;
    }

    return status;
  }

  installBrowsers() {
    console.log('  Installing Playwright browsers...');
    try {
      execFileSync('npx', ['playwright', 'install', 'chromium'], {
        cwd: this.projectDir,
        encoding: 'utf8',
        timeout: 300000,
        stdio: 'inherit',
      });
      console.log('  Chromium installed successfully.');
      return true;
    } catch (err) {
      console.error(`  Failed to install browsers: ${err.message}`);
      return false;
    }
  }

  runTests(options = {}) {
    const testTarget = this._resolveTestTarget(options.testPath);
    const configPath = options.configPath || this._resolveConfigPath() || this._createFallbackConfig(testTarget);
    if (!configPath) {
      console.error('  No Playwright config found in e2e/ or project root.');
      return { success: false, error: 'No config' };
    }

    const args = ['playwright', 'test', '--config', configPath];
    if (testTarget) args.push(testTarget);
    if (options.headed) args.push('--headed');
    if (options.project) args.push('--project', options.project);
    if (options.grep) args.push('--grep', options.grep);
    if (options.updateSnapshots) args.push('--update-snapshots');
    if (options.reporter) args.push('--reporter', options.reporter);

    const env = {
      ...process.env,
      BASE_URL: options.baseUrl || this.baseUrl,
      SKIP_SERVER: options.skipServer ? '1' : '',
    };

    console.log(`  Running: npx ${args.join(' ')}`);
    const startedAt = Date.now();

    try {
      execFileSync('npx', args, {
        cwd: this.projectDir,
        encoding: 'utf8',
        timeout: 600000,
        env,
        stdio: 'inherit',
      });

      const summary = this._summarizeRunResults();
      const result = {
        success: summary.totalTests > 0,
        durationMs: Date.now() - startedAt,
        executedTests: summary.totalTests,
        passed: summary.passed,
        failed: summary.failed,
        skipped: summary.skipped,
      };
      if (summary.totalTests === 0) {
        result.error = 'No Playwright tests executed';
      }
      this._copyRunArtifacts(options.outputDir);
      if (options.outputDir) this._writeJson(path.join(options.outputDir, 'run-summary.json'), result);
      this._writeFlakeHunterArtifact();
      return result;
    } catch (err) {
      const summary = this._summarizeRunResults();
      const result = {
        success: false,
        durationMs: Date.now() - startedAt,
        exitCode: err.status,
        output: (err.stdout || '') + (err.stderr || ''),
        executedTests: summary.totalTests,
        passed: summary.passed,
        failed: summary.failed,
        skipped: summary.skipped,
      };
      this._copyRunArtifacts(options.outputDir);
      if (options.outputDir) this._writeJson(path.join(options.outputDir, 'run-summary.json'), result);
      this._writeFlakeHunterArtifact();
      return result;
    }
  }

  async _runAccessibilityAudit(page) {
    try {
      const AxeBuilder = require('@axe-core/playwright').default;
      const axe = await new AxeBuilder({ page }).analyze();
      const violations = axe.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact || 'unknown',
        description: violation.description || violation.help || violation.id,
        nodes: violation.nodes?.length || 0,
      }));

      return {
        engine: 'axe-core',
        score: Math.max(0, 100 - violations.length * 10),
        passes: axe.passes.length,
        violations,
      };
    } catch {
      const summary = await page.evaluate(() => {
        const issues = [];
        const passes = [];

        const addIssue = (id, impact, description, count = 1) => {
          issues.push({ id, impact, description, count });
        };

        const title = document.title.trim();
        if (title) passes.push('title');
        else addIssue('missing-title', 'serious', 'Document title is missing');

        const main = document.querySelector('main, [role="main"]');
        if (main) passes.push('main-landmark');
        else addIssue('missing-main', 'moderate', 'Main landmark is missing');

        const h1s = Array.from(document.querySelectorAll('h1'));
        if (h1s.length === 1) passes.push('single-h1');
        else
          addIssue(
            'heading-structure',
            h1s.length === 0 ? 'serious' : 'moderate',
            `Expected exactly one h1, found ${h1s.length}`,
          );

        const imagesMissingAlt = Array.from(document.querySelectorAll('img')).filter((img) => !img.getAttribute('alt'));
        if (imagesMissingAlt.length === 0) passes.push('image-alt');
        else
          addIssue(
            'image-alt',
            'moderate',
            `${imagesMissingAlt.length} image(s) missing alt text`,
            imagesMissingAlt.length,
          );

        const unlabeledControls = Array.from(document.querySelectorAll('input, select, textarea')).filter((el) => {
          if (el.getAttribute('type') === 'hidden' || el.disabled) return false;
          const hasLabel = el.labels && el.labels.length > 0;
          const aria = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
          return !hasLabel && !aria;
        });
        if (unlabeledControls.length === 0) passes.push('form-labels');
        else
          addIssue(
            'form-labels',
            'serious',
            `${unlabeledControls.length} form control(s) missing accessible labels`,
            unlabeledControls.length,
          );

        const namelessButtons = Array.from(document.querySelectorAll('button')).filter((el) => {
          const text = (el.innerText || '').trim();
          const aria = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
          return !text && !aria;
        });
        if (namelessButtons.length === 0) passes.push('button-names');
        else
          addIssue(
            'button-names',
            'serious',
            `${namelessButtons.length} button(s) missing accessible names`,
            namelessButtons.length,
          );

        const namelessLinks = Array.from(document.querySelectorAll('a[href]')).filter((el) => {
          const text = (el.innerText || '').trim();
          const aria = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
          return !text && !aria;
        });
        if (namelessLinks.length === 0) passes.push('link-names');
        else
          addIssue(
            'link-names',
            'moderate',
            `${namelessLinks.length} link(s) missing accessible names`,
            namelessLinks.length,
          );

        return { issues, passes: passes.length };
      });

      return {
        engine: 'basic',
        score: Math.max(0, 100 - summary.issues.length * 10),
        passes: summary.passes,
        violations: summary.issues,
      };
    }
  }

  async _probePage(baseUrl, options = {}) {
    const playwright = this._loadPlaywright();
    if (!playwright) {
      throw new Error('playwright package is not installed');
    }

    const browser = await playwright.chromium.launch({ headless: options.headed !== true });
    const page = await browser.newPage({
      viewport: options.viewport || { width: 1440, height: 900 },
    });

    const consoleErrors = [];
    const consoleWarnings = [];
    const requestFailures = [];
    const failedResponses = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
      if (msg.type() === 'warning') consoleWarnings.push(msg.text());
    });

    page.on('requestfailed', (request) => {
      requestFailures.push({
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        error: request.failure()?.errorText || 'request failed',
      });
    });

    page.on('response', (response) => {
      const resourceType = response.request().resourceType();
      if ((resourceType === 'xhr' || resourceType === 'fetch') && response.status() >= 400) {
        failedResponses.push({
          url: response.url(),
          method: response.request().method(),
          status: response.status(),
        });
      }
    });

    const startedAt = Date.now();
    let response = null;

    try {
      response = await page.goto(baseUrl, {
        waitUntil: options.waitUntil || 'networkidle',
        timeout: options.timeout || 30000,
      });
      await page.waitForTimeout(500);

      const screenshots = {};
      if (options.captureScreenshots) {
        const screenshotsDir = this._ensureDir(
          options.screenshotsDir || path.join(this._legacyOutputDir(), 'screenshots'),
        );
        const viewports = options.viewports || [
          { name: 'desktop', width: 1440, height: 900 },
          { name: 'tablet', width: 768, height: 1024 },
          { name: 'mobile', width: 375, height: 812 },
        ];

        for (const viewport of viewports) {
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          await page.waitForTimeout(250);
          const screenshotPath = path.join(screenshotsDir, `smoke-${viewport.name}.png`);
          await page.screenshot({ path: screenshotPath, fullPage: true });
          screenshots[viewport.name] = path.relative(this.projectDir, screenshotPath);
        }
      }

      const accessibility = options.includeAccessibility ? await this._runAccessibilityAudit(page) : null;

      return {
        timestamp: new Date().toISOString(),
        url: page.url(),
        httpStatus: response?.status() || 0,
        loadTimeMs: Date.now() - startedAt,
        consoleErrors,
        consoleWarnings,
        requestFailures,
        failedResponses,
        screenshots,
        accessibility,
      };
    } finally {
      await browser.close();
    }
  }

  async crawl(options = {}) {
    const outDir = this._ensureDir(
      options.outDir
        ? path.isAbsolute(options.outDir)
          ? options.outDir
          : path.join(this.projectDir, options.outDir)
        : path.join(this._outputDir(), 'post-deploy-screenshots'),
    );
    const baseUrl = options.baseUrl || this.baseUrl;

    console.log(`  Crawling ${baseUrl}...`);
    console.log(`  Screenshots: ${outDir}`);

    const crawlScript = this._generateCrawlScript(baseUrl, outDir, options);
    const scriptPath = path.join(outDir, '_crawl-script.js');
    fs.writeFileSync(scriptPath, crawlScript, 'utf8');

    try {
      execFileSync('node', [scriptPath], {
        cwd: this.projectDir,
        encoding: 'utf8',
        timeout: 300000,
        stdio: 'inherit',
      });

      const resultsPath = path.join(outDir, 'crawl-results.json');
      if (fs.existsSync(resultsPath)) {
        return JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
      }
      return { success: true };
    } catch (err) {
      console.error(`  Crawl failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  buildVisualInventory(options = {}) {
    const stableTestSuiteDir = path.join(this.projectDir, '_cobolt-output', 'latest', 'test-suite');
    let outDir = options.outDir || path.join(stableTestSuiteDir, 'post-deploy-screenshots');
    let screenshotsDir = options.screenshotsDir || path.join(stableTestSuiteDir, 'screenshots');
    let crawlResultsPath = path.join(outDir, 'crawl-results.json');

    if (!fs.existsSync(crawlResultsPath)) {
      const runOutDir = path.join(this._outputDir(), 'post-deploy-screenshots');
      const runCrawlResultsPath = path.join(runOutDir, 'crawl-results.json');
      if (fs.existsSync(runCrawlResultsPath)) {
        outDir = runOutDir;
        crawlResultsPath = runCrawlResultsPath;
        screenshotsDir = path.join(this._outputDir(), 'screenshots');
      }
    }
    const summary = {
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      generatedBy: 'cobolt-playwright',
      sourceRoot: this.projectDir,
      baseUrl: options.baseUrl || this.baseUrl,
      crawlCaptured: false,
      routeCount: 0,
      screenshotCount: 0,
      domSnapshotCount: 0,
      screenshotsDir: fs.existsSync(screenshotsDir) ? path.relative(this.projectDir, screenshotsDir) : null,
      crawlArtifactsDir: fs.existsSync(outDir) ? path.relative(this.projectDir, outDir) : null,
      routes: [],
    };

    if (fs.existsSync(crawlResultsPath)) {
      try {
        const crawlResults = JSON.parse(fs.readFileSync(crawlResultsPath, 'utf8'));
        summary.crawlCaptured = true;
        summary.baseUrl = crawlResults.baseUrl || summary.baseUrl;
        summary.routes = (crawlResults.routes || []).map((route) => ({
          route: route.route,
          name: route.name,
          status: route.status,
          title: route.title || null,
          h1: route.h1 || null,
          redirectedTo: route.redirectedTo || null,
          durationMs: route.durationMs || null,
          screenshot: route.screenshot || null,
          domSnapshot: route.domSnapshot || null,
          passed: route.passed !== false,
        }));
        summary.routeCount = summary.routes.length;
        summary.screenshotCount = summary.routes.filter((route) => route.screenshot).length;
        summary.domSnapshotCount = summary.routes.filter((route) => route.domSnapshot).length;
      } catch {
        /* ignore malformed crawl output */
      }
    }

    if (summary.routeCount === 0) {
      const fallbackRoutes = [...KNOWN_ROUTES.public, ...KNOWN_ROUTES.protected];
      summary.routes = fallbackRoutes.map((route) => ({
        route: route.path,
        name: route.name,
        status: null,
        title: null,
        h1: null,
        redirectedTo: null,
        durationMs: null,
        screenshot: null,
        domSnapshot: null,
        passed: null,
        source: 'static-known-route-catalog',
      }));
      summary.routeCount = summary.routes.length;
    }

    const outputFile = options.outputFile || path.join(outDir, 'visual-route-inventory.json');
    this._writeJson(outputFile, summary);
    return { ...summary, outputFile };
  }

  _generateCrawlScript(baseUrl, outDir, options) {
    const routes = options.includeProtected ? [...KNOWN_ROUTES.public, ...KNOWN_ROUTES.protected] : KNOWN_ROUTES.public;

    return `
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: ${options.headed ? 'false' : 'true'} });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });

  const results = [];
  const routes = ${JSON.stringify(routes)};

  for (const route of routes) {
    const page = await context.newPage();
    const startTime = Date.now();

    try {
      const response = await page.goto('${baseUrl}' + route.path, {
        waitUntil: 'networkidle',
        timeout: 30000,
      });

      const status = response ? response.status() : 0;
      const url = page.url();

      try {
        await page.waitForSelector('[data-phx-main]', { timeout: 10000 });
      } catch { /* not a LiveView page or slow mount */ }

      const screenshotName = route.name.toLowerCase().replace(/[^a-z0-9]/g, '-') + '.png';
      const screenshotPath = path.join('${outDir.replace(/\\/g, '\\\\')}', screenshotName);
      await page.screenshot({ path: screenshotPath, fullPage: true });

      const consoleErrors = [];
      page.on('console', msg => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });

      const title = await page.title();
      const h1 = await page.locator('h1').first().textContent().catch(() => '');
      const domName = route.name.toLowerCase().replace(/[^a-z0-9]/g, '-') + '.html';
      const domSnapshotPath = path.join('${outDir.replace(/\\/g, '\\\\')}', domName);
      fs.writeFileSync(domSnapshotPath, await page.content(), 'utf8');

      results.push({
        route: route.path,
        name: route.name,
        status,
        redirectedTo: url !== '${baseUrl}' + route.path ? url : null,
        title,
        h1: h1 || null,
        screenshot: screenshotName,
        domSnapshot: domName,
        durationMs: Date.now() - startTime,
        errors: consoleErrors,
        passed: status < 500,
      });

      console.log('  ' + (status < 500 ? 'OK' : 'FAIL') + ' [' + status + '] ' + route.path + ' (' + (Date.now() - startTime) + 'ms)');
    } catch (err) {
      results.push({
        route: route.path,
        name: route.name,
        status: 0,
        error: err.message,
        durationMs: Date.now() - startTime,
        passed: false,
      });
      console.log('  FAIL [ERR] ' + route.path + ': ' + err.message);
    }

    await page.close();
  }

  await browser.close();

  const summary = {
    timestamp: new Date().toISOString(),
    baseUrl: '${baseUrl}',
    total: results.length,
    passed: results.filter(r => r.passed).length,
    failed: results.filter(r => !r.passed).length,
    routes: results,
  };

  fs.writeFileSync(
    path.join('${outDir.replace(/\\/g, '\\\\')}', 'crawl-results.json'),
    JSON.stringify(summary, null, 2),
    'utf8'
  );

  console.log();
    console.log('  Summary: ' + summary.passed + '/' + summary.total + ' routes OK');
  process.exit(summary.failed > 0 ? 1 : 0);
})();
`;
  }

  async healthCheck(options = {}) {
    const baseUrl = options.baseUrl || this.baseUrl;
    const allRoutes = [...KNOWN_ROUTES.public, ...KNOWN_ROUTES.api];

    console.log(`  Health checking ${baseUrl}...`);
    const results = [];

    for (const route of allRoutes) {
      try {
        const method = route.method || 'GET';
        const url = `${baseUrl}${route.path}`;
        const startedAt = Date.now();

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        const fetchOptions = {
          method,
          signal: controller.signal,
          headers: { Accept: 'application/json, text/html' },
        };

        if (method === 'POST') {
          fetchOptions.headers['Content-Type'] = 'application/json';
          fetchOptions.body = '{}';
        }

        const response = await fetch(url, fetchOptions);
        clearTimeout(timeout);

        const durationMs = Date.now() - startedAt;
        const passed = response.status < 500;

        results.push({
          route: route.path,
          name: route.name,
          method,
          status: response.status,
          durationMs,
          passed,
        });

        console.log(`  ${passed ? 'OK' : 'FAIL'} [${response.status}] ${method} ${route.path} (${durationMs}ms)`);
      } catch (err) {
        results.push({
          route: route.path,
          name: route.name,
          method: route.method || 'GET',
          status: 0,
          error: err.message,
          passed: false,
        });
        console.log(`  FAIL [ERR] ${route.path}: ${err.message}`);
      }
    }

    const summary = {
      timestamp: new Date().toISOString(),
      baseUrl,
      total: results.length,
      passed: results.filter((result) => result.passed).length,
      failed: results.filter((result) => !result.passed).length,
      routes: results,
    };

    this._writeJson(path.join(this._outputDir(), 'health-check.json'), summary);

    console.log();
    console.log(`  Summary: ${summary.passed}/${summary.total} routes healthy`);
    return summary;
  }

  async screenshot(url, options = {}) {
    const outDir = this._ensureDir(path.join(this._outputDir(), 'screenshots'));
    const name = options.name || url.replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-');

    const script = `
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: ${options.width || 1280}, height: ${options.height || 720} },
  });
  await page.goto('${url}', { waitUntil: 'networkidle', timeout: 30000 });
  try { await page.waitForSelector('[data-phx-main]', { timeout: 10000 }); } catch (_e) { /* not a LiveView page */ }
  await page.screenshot({ path: '${path.join(outDir, `${name}.png`).replace(/\\/g, '\\\\')}', fullPage: true });
  console.log('  Screenshot saved: ${name}.png');
  await browser.close();
})();
`;
    const scriptPath = path.join(outDir, '_screenshot-script.js');
    fs.writeFileSync(scriptPath, script, 'utf8');

    try {
      execFileSync('node', [scriptPath], {
        cwd: this.projectDir,
        encoding: 'utf8',
        timeout: 60000,
        stdio: 'inherit',
      });
      return { success: true, path: path.join(outDir, `${name}.png`) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  mcpStatus() {
    const status = this.checkInstallation();
    console.log('  Playwright MCP Status:');
    console.log(`    playwright package: ${status.playwright ? 'installed' : 'MISSING'}`);
    console.log(`    @playwright/mcp:   ${status.mcp ? 'installed' : 'MISSING'}`);
    console.log(`    browsers:          ${status.browsers ? 'installed' : 'needs install'}`);
    console.log(`    e2e config:        ${status.config ? 'found' : 'MISSING'}`);

    const mcpConfigured = this._isMcpConfigured(['playwright']);

    console.log(`    MCP server config: ${mcpConfigured ? 'configured' : 'NOT configured'}`);

    // Check Chrome DevTools MCP availability
    const chromeDevtools = this._checkChromeDevToolsMcp();
    console.log();
    console.log('  Chrome DevTools MCP Status:');
    console.log(`    plugin installed:  ${chromeDevtools.pluginInstalled ? 'yes' : 'NOT found'}`);
    console.log(`    MCP configured:   ${chromeDevtools.mcpConfigured ? 'yes' : 'NOT configured'}`);

    console.log();
    console.log('  Dual-Engine Summary:');
    console.log(
      `    Playwright:        ${mcpConfigured && status.playwright ? 'READY' : 'NOT READY'} (interaction engine)`,
    );
    console.log(`    Chrome DevTools:   ${chromeDevtools.available ? 'READY' : 'NOT READY'} (inspection engine)`);

    return { ...status, mcpConfigured, chromeDevtools };
  }

  _checkChromeDevToolsMcp() {
    // Check for Chrome DevTools MCP plugin in common locations
    const pluginPaths = [
      path.join(this.projectDir, '.claude-plugin', 'settings.json'),
      path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'plugins', 'chrome-devtools-mcp'),
    ];

    let pluginInstalled = false;
    let mcpConfigured = false;

    // Check plugin directory existence
    for (const pluginPath of pluginPaths) {
      if (fs.existsSync(pluginPath)) {
        pluginInstalled = true;
        break;
      }
    }

    // Check settings for chrome-devtools MCP server
    const codexHome = process.env.CODEX_HOME;
    const settingsLocations = [
      path.join(this.projectDir, '.claude', 'settings.json'),
      path.join(this.projectDir, '.claude-plugin', 'settings.json'),
      path.join(this.projectDir, '.codex', 'config.toml'),
      path.join(this.projectDir, '.codex', 'mcp.json'),
      path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'settings.json'),
      ...(codexHome ? [path.join(codexHome, 'config.toml')] : []),
      path.join(process.env.HOME || process.env.USERPROFILE || '', '.codex', 'config.toml'),
      path.join(process.env.HOME || process.env.USERPROFILE || '', '.codex', 'mcp.json'),
    ];

    for (const settingsPath of settingsLocations) {
      if (!fs.existsSync(settingsPath)) continue;
      try {
        const raw = fs.readFileSync(settingsPath, 'utf8');
        const settings = settingsPath.endsWith('.json') ? JSON.parse(raw) : null;
        const servers = settings?.mcpServers || {};
        const jsonConfigured = Object.keys(servers).some(
          (key) => key.includes('chrome-devtools') || key.includes('devtools'),
        );
        const rawConfigured = /chrome-devtools|devtools/i.test(raw);
        if (jsonConfigured || rawConfigured) {
          mcpConfigured = true;
          break;
        }
      } catch {
        /* invalid JSON */
      }
    }

    // Also check if the plugin is loaded via Claude Code plugin system
    const pluginDir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'plugins');
    if (fs.existsSync(pluginDir)) {
      try {
        const entries = fs.readdirSync(pluginDir);
        if (entries.some((entry) => entry.includes('chrome-devtools'))) {
          pluginInstalled = true;
          mcpConfigured = true;
        }
      } catch {
        /* permission or read error */
      }
    }

    return {
      pluginInstalled,
      mcpConfigured,
      available: pluginInstalled || mcpConfigured,
    };
  }

  _isMcpConfigured(names = []) {
    const lowerNames = names.map((name) => String(name).toLowerCase());
    const codexHome = process.env.CODEX_HOME;
    const settingsLocations = [
      path.join(this.projectDir, '.claude', 'settings.json'),
      path.join(this.projectDir, '.claude-plugin', 'settings.json'),
      path.join(this.projectDir, '.codex', 'config.toml'),
      path.join(this.projectDir, '.codex', 'mcp.json'),
      path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'settings.json'),
      ...(codexHome ? [path.join(codexHome, 'config.toml')] : []),
      path.join(process.env.HOME || process.env.USERPROFILE || '', '.codex', 'config.toml'),
      path.join(process.env.HOME || process.env.USERPROFILE || '', '.codex', 'mcp.json'),
    ];

    for (const settingsPath of settingsLocations) {
      if (!settingsPath || !fs.existsSync(settingsPath)) continue;
      try {
        const raw = fs.readFileSync(settingsPath, 'utf8');
        if (settingsPath.endsWith('.json')) {
          const settings = JSON.parse(raw);
          const servers = settings.mcpServers || {};
          if (Object.keys(servers).some((key) => lowerNames.some((name) => key.toLowerCase().includes(name)))) {
            return true;
          }
        }
        const lowerRaw = raw.toLowerCase();
        if (lowerNames.some((name) => lowerRaw.includes(name))) return true;
      } catch {
        /* invalid config */
      }
    }

    return false;
  }

  showReport() {
    const resultsPath = this._findResultsFile();
    if (!fs.existsSync(resultsPath)) {
      console.log('  No Playwright test results found.');
      console.log('  Run: node tools/cobolt-playwright.js test');
      return null;
    }

    const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
    const suites = results.suites || [];

    console.log('  Playwright E2E Test Results');
    console.log('  ================================================================');
    console.log();

    let totalTests = 0;
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    for (const suite of suites) {
      console.log(`  Suite: ${suite.title}`);
      for (const spec of suite.specs || []) {
        for (const test of spec.tests || []) {
          totalTests++;
          const result = test.results?.[0];
          const status = result?.status || 'unknown';
          if (status === 'passed') {
            passed++;
            console.log(`    PASS ${spec.title}`);
          } else if (status === 'skipped') {
            skipped++;
            console.log(`    SKIP ${spec.title}`);
          } else {
            failed++;
            console.log(`    FAIL ${spec.title}: ${result?.error?.message || 'unknown error'}`);
          }
        }
      }
      console.log();
    }

    console.log(`  Total: ${totalTests} | Passed: ${passed} | Failed: ${failed} | Skipped: ${skipped}`);
    return { totalTests, passed, failed, skipped };
  }

  async smoke(options = {}) {
    const baseUrl = options.baseUrl || this.baseUrl;
    const buildDir = this._legacyOutputDir();
    const smokeResultPath = path.join(buildDir, 'browser-smoke.json');

    console.log('  CoBolt Browser Smoke Test');
    console.log('  =========================');
    console.log();
    console.log(`  Base URL: ${baseUrl}`);

    try {
      const details = await this._probePage(baseUrl, {
        captureScreenshots: true,
        includeAccessibility: true,
        screenshotsDir: path.join(buildDir, 'screenshots'),
      });

      const passed =
        details.httpStatus > 0 &&
        details.httpStatus < 500 &&
        details.consoleErrors.length === 0 &&
        details.requestFailures.length === 0;

      const result = this._writeSmokeResult(smokeResultPath, passed, details);
      console.log(`  Result: ${result.passed ? 'PASSED' : 'FAILED'}`);
      console.log(`  HTTP:   ${result.httpStatus}`);
      console.log(`  Load:   ${result.loadTimeMs}ms`);
      if (result.consoleErrors.length > 0) {
        console.log(`  Errors: ${result.consoleErrors.length} console error(s)`);
      }
      return result;
    } catch (err) {
      console.error(`  Smoke test failed: ${err.message}`);
      return this._writeSmokeResult(smokeResultPath, false, {
        url: baseUrl,
        error: err.message,
        consoleErrors: [err.message],
      });
    }
  }

  async audit(options = {}) {
    const baseUrl = options.baseUrl || options.url || this.baseUrl;
    const outputPath = options.output || path.join(this._legacyOutputDir(), 'playwright-a11y-audit.json');

    try {
      const details = await this._probePage(baseUrl, { includeAccessibility: true });
      const result = {
        timestamp: new Date().toISOString(),
        url: details.url,
        standard: options.standard || 'WCAG2AA',
        score: details.accessibility?.score || 0,
        engine: details.accessibility?.engine || 'none',
        passes: details.accessibility?.passes || 0,
        violations: details.accessibility?.violations || [],
      };
      this._writeJson(outputPath, result);
      console.log(`  Wrote: ${path.relative(this.projectDir, outputPath)}`);
      return result;
    } catch (err) {
      const result = {
        timestamp: new Date().toISOString(),
        url: baseUrl,
        standard: options.standard || 'WCAG2AA',
        score: 0,
        engine: 'none',
        passes: 0,
        violations: [],
        error: err.message,
      };
      this._writeJson(outputPath, result);
      console.error(`  Accessibility audit failed: ${err.message}`);
      return result;
    }
  }

  async checkSync(options = {}) {
    const baseUrl = options.baseUrl || options.url || this.baseUrl;
    const outputPath = options.output || path.join(this._legacyOutputDir(), 'playwright-sync-check.json');

    try {
      const details = await this._probePage(baseUrl, { includeAccessibility: false });
      const failedRequests = [...details.requestFailures, ...details.failedResponses];
      const result = {
        timestamp: new Date().toISOString(),
        url: details.url,
        passed: failedRequests.length === 0 && details.consoleErrors.length === 0,
        failedRequests,
        consoleErrors: details.consoleErrors,
        consoleWarnings: details.consoleWarnings,
      };
      this._writeJson(outputPath, result);
      console.log(`  Wrote: ${path.relative(this.projectDir, outputPath)}`);
      return result;
    } catch (err) {
      const result = {
        timestamp: new Date().toISOString(),
        url: baseUrl,
        passed: false,
        failedRequests: [],
        consoleErrors: [err.message],
        error: err.message,
      };
      this._writeJson(outputPath, result);
      console.error(`  Frontend/backend sync check failed: ${err.message}`);
      return result;
    }
  }

  _screenshotArtifactsFromMap(screenshots = {}) {
    return Object.entries(screenshots || {})
      .filter(([, filePath]) => !!filePath)
      .map(([name, filePath]) => ({ name, path: filePath }));
  }

  chromeDevtoolsEvidence(options = {}) {
    const baseUrl = options.baseUrl || options.url || this.baseUrl;
    const uatDir = this._ensureDir(path.join(this.projectDir, '_cobolt-output', 'latest', 'uat'));
    const outputFile = options.output
      ? path.isAbsolute(options.output)
        ? options.output
        : path.join(this.projectDir, options.output)
      : path.join(uatDir, 'chrome-devtools-evidence.json');
    const chromeDevtools = this._checkChromeDevToolsMcp();
    const status = options.status || (chromeDevtools.available ? 'available-pending-mcp-evidence' : 'not-available');
    const consoleErrors = Number(options.consoleErrors || 0);
    const failedRequests = Number(options.failedRequests || 0);
    const minLighthouseScore = Number(options.minLighthouseScore || 80);
    const lighthouseScores = options.lighthouseScores || null;
    const artifacts = options.artifacts || {
      lighthouseReport: options.lighthouseReport || null,
      consoleLog: options.consoleLog || null,
      networkLog: options.networkLog || null,
      performanceTrace: options.performanceTrace || null,
      memorySnapshot: options.memorySnapshot || null,
      screenshots: options.screenshotArtifact ? [options.screenshotArtifact] : options.screenshotArtifacts || [],
    };
    const screenshotArtifacts = Array.isArray(artifacts.screenshots)
      ? artifacts.screenshots
      : artifacts.screenshots
        ? [artifacts.screenshots]
        : [];
    const requiredArtifactKeys = ['lighthouseReport', 'consoleLog', 'networkLog', 'performanceTrace'];
    const missingArtifactKeys =
      status === 'verified' || status === 'passed' ? requiredArtifactKeys.filter((key) => !artifacts[key]) : [];
    const artifactRefs = [
      artifacts.lighthouseReport,
      artifacts.consoleLog,
      artifacts.networkLog,
      artifacts.performanceTrace,
      artifacts.memorySnapshot,
      ...screenshotArtifacts,
    ].filter(Boolean);
    const missingArtifactFiles = artifactRefs.filter((ref) => {
      const filePath = path.isAbsolute(ref) ? ref : path.join(this.projectDir, ref);
      return !fs.existsSync(filePath);
    });
    const scoresPass =
      !lighthouseScores ||
      Object.values(lighthouseScores)
        .filter((value) => typeof value === 'number')
        .every((value) => value >= minLighthouseScore);
    const rawArtifactsPass = missingArtifactKeys.length === 0 && missingArtifactFiles.length === 0;
    const passed =
      status === 'not-available' ||
      ((status === 'verified' || status === 'passed') &&
        consoleErrors === 0 &&
        failedRequests === 0 &&
        scoresPass &&
        rawArtifactsPass);

    const evidence = {
      timestamp: new Date().toISOString(),
      engine: 'chrome-devtools-mcp',
      baseUrl,
      available: chromeDevtools.available,
      required: chromeDevtools.available,
      status,
      passed,
      chromeDevtools,
      attempts: options.attempts || [
        {
          tool: 'chrome-devtools-mcp',
          outcome: chromeDevtools.available ? 'available' : 'not-available',
          reason: chromeDevtools.available
            ? 'Chrome DevTools MCP is configured; UAT agent must replace this with verified MCP measurements.'
            : 'Chrome DevTools MCP was not configured in local settings.',
        },
      ],
      lighthouseScores,
      thresholds: { minLighthouseScore },
      console: { errors: consoleErrors },
      network: { failedRequests },
      performance: { traces: Number(options.performanceTraces || 0) },
      memory: { snapshots: Number(options.memorySnapshots || 0) },
      screenshots: Number(options.screenshots || 0),
      artifacts,
      artifactStatus: {
        required: status === 'verified' || status === 'passed',
        missingKeys: missingArtifactKeys,
        missingFiles: missingArtifactFiles,
      },
    };

    this._writeJson(outputFile, evidence);
    console.log(`  Chrome DevTools evidence: ${status}`);
    console.log(`  Wrote: ${path.relative(this.projectDir, outputFile)}`);
    return evidence;
  }

  async headlessUx(options = {}) {
    const baseUrl = options.baseUrl || options.url || this.baseUrl;
    const minA11yScore = Number(options.minA11yScore || 80);
    const uatDir = this._ensureDir(path.join(this.projectDir, '_cobolt-output', 'latest', 'uat'));
    const outDir = this._ensureDir(
      options.outputDir
        ? path.isAbsolute(options.outputDir)
          ? options.outputDir
          : path.join(this.projectDir, options.outputDir)
        : path.join(uatDir, 'headless-ux'),
    );
    const screenshotsDir = this._ensureDir(path.join(outDir, 'screenshots'));
    const crawlDir = this._ensureDir(path.join(outDir, 'crawl'));
    const outputFile = options.output
      ? path.isAbsolute(options.output)
        ? options.output
        : path.join(this.projectDir, options.output)
      : path.join(uatDir, 'ui-visual-evidence.json');
    const chromeDevtoolsEvidencePath = path.join(uatDir, 'chrome-devtools-evidence.json');
    const chromeDevtools = this.chromeDevtoolsEvidence({
      baseUrl,
      output: chromeDevtoolsEvidencePath,
    });

    console.log('  CoBolt Headless UX Evidence');
    console.log('  ============================');
    console.log();
    console.log(`  Base URL: ${baseUrl}`);
    console.log(`  Output:   ${path.relative(this.projectDir, outputFile)}`);

    let smokeDetails;
    try {
      smokeDetails = await this._probePage(baseUrl, {
        captureScreenshots: true,
        includeAccessibility: true,
        screenshotsDir,
        headed: options.headed === true,
      });
    } catch (err) {
      smokeDetails = {
        timestamp: new Date().toISOString(),
        url: baseUrl,
        httpStatus: 0,
        loadTimeMs: 0,
        consoleErrors: [err.message],
        consoleWarnings: [],
        requestFailures: [],
        failedResponses: [],
        screenshots: {},
        accessibility: { score: 0, violations: [], passes: 0, engine: 'none' },
        error: err.message,
      };
    }

    const smokePassed =
      smokeDetails.httpStatus > 0 &&
      smokeDetails.httpStatus < 500 &&
      (smokeDetails.consoleErrors || []).length === 0 &&
      (smokeDetails.requestFailures || []).length === 0;
    const smokePath = path.join(outDir, 'headless-browser-smoke.json');
    this._writeSmokeResult(smokePath, smokePassed, smokeDetails);

    const syncPath = path.join(outDir, 'headless-sync-check.json');
    const sync = await this.checkSync({ baseUrl, output: syncPath });

    const crawl = await this.crawl({
      baseUrl,
      includeProtected: options.includeProtected === true,
      headed: options.headed === true,
      outDir: crawlDir,
    });
    const visualInventoryPath = path.join(outDir, 'visual-route-inventory.json');
    const visualInventory = this.buildVisualInventory({
      outDir: crawlDir,
      screenshotsDir: crawlDir,
      outputFile: visualInventoryPath,
    });

    const screenshots = this._screenshotArtifactsFromMap(smokeDetails.screenshots);
    for (const route of crawl?.routes || []) {
      if (route.screenshot)
        screenshots.push({
          name: `route:${route.route || route.name}`,
          path: path.join(path.relative(this.projectDir, crawlDir), route.screenshot),
        });
    }

    const accessibilityScore = Number(smokeDetails.accessibility?.score || 0);
    const failedRequests = [
      ...(smokeDetails.requestFailures || []),
      ...(smokeDetails.failedResponses || []),
      ...(sync.failedRequests || []),
    ];
    const consoleErrors = [...(smokeDetails.consoleErrors || []), ...(sync.consoleErrors || [])];
    const passed =
      smokePassed &&
      sync.passed === true &&
      accessibilityScore >= minA11yScore &&
      crawl?.success !== false &&
      screenshots.length > 0;

    const evidence = {
      timestamp: new Date().toISOString(),
      mode: options.headed ? 'headed' : 'headless',
      passed,
      baseUrl,
      runtimeCheck: {
        passed: smokePassed && sync.passed === true,
        httpStatus: smokeDetails.httpStatus || 0,
        loadTimeMs: smokeDetails.loadTimeMs || 0,
        consoleErrors,
        failedRequests,
      },
      accessibility: {
        score: accessibilityScore,
        minScore: minA11yScore,
        engine: smokeDetails.accessibility?.engine || 'none',
        violations: smokeDetails.accessibility?.violations || [],
      },
      screenshots,
      visualEvidence: {
        screenshots,
        routeInventory: visualInventory,
      },
      chromeDevtools: {
        available: chromeDevtools.available,
        required: chromeDevtools.required,
        status: chromeDevtools.status,
        passed: chromeDevtools.passed,
        evidence: path.relative(this.projectDir, chromeDevtoolsEvidencePath),
      },
      artifacts: {
        smoke: path.relative(this.projectDir, smokePath),
        sync: path.relative(this.projectDir, syncPath),
        crawl: path.relative(this.projectDir, path.join(crawlDir, 'crawl-results.json')),
        visualInventory: path.relative(this.projectDir, visualInventoryPath),
        screenshotsDir: path.relative(this.projectDir, screenshotsDir),
        chromeDevtools: path.relative(this.projectDir, chromeDevtoolsEvidencePath),
      },
    };

    this._writeJson(outputFile, evidence);
    console.log(`  Result: ${passed ? 'PASSED' : 'FAILED'}`);
    console.log(`  Screenshots: ${screenshots.length}`);
    console.log(`  A11Y: ${accessibilityScore}/${minA11yScore}`);
    return evidence;
  }

  _writeSmokeResult(filePath, passed, details) {
    const result = {
      timestamp: new Date().toISOString(),
      passed,
      url: details.url || '',
      httpStatus: details.httpStatus || 0,
      consoleErrors: details.consoleErrors || [],
      consoleWarnings: details.consoleWarnings || [],
      loadTimeMs: details.loadTimeMs || 0,
      requestFailures: details.requestFailures || [],
      failedResponses: details.failedResponses || [],
      screenshots: details.screenshots || {},
      accessibility: details.accessibility || { violations: 0, passes: 0, engine: 'none' },
    };

    if (details.error) result.error = details.error;

    this._writeJson(filePath, result);
    console.log(`  Wrote: ${path.relative(process.cwd(), filePath)}`);
    return result;
  }
}

module.exports = { PlaywrightTool, KNOWN_ROUTES };

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '--help') {
    console.log('  CoBolt Playwright - Browser Testing and Visual Regression');
    console.log();
    console.log('  Usage: node tools/cobolt-playwright.js <command> [options]');
    console.log();
    console.log('  Commands:');
    console.log('    test [--headed] [--project chromium]    Run E2E tests');
    console.log('    run [--url URL] [--tests path]          Backward-compatible validation runner');
    console.log('    smoke [--base-url URL]                  Browser smoke test (build gate)');
    console.log('    audit [--url URL] [--output file]       Accessibility audit');
    console.log('    check-sync [--url URL] [--output file]  Frontend/backend sync check');
    console.log('    crawl [--base-url URL] [--headed]       Crawl routes and screenshot');
    console.log('    visual-inventory [--base-url URL]       Summarize crawl screenshots and DOM capture');
    console.log('    headless-ux [--base-url URL]            Headless UX evidence bundle');
    console.log('    chrome-devtools-evidence [--base-url URL]  Write Chrome DevTools UAT evidence');
    console.log('    health [--base-url URL]                 HTTP health check all routes');
    console.log('    screenshot <url> [--name name]          Screenshot single URL');
    console.log('    report                                  Show latest test results');
    console.log('    install                                 Install Playwright browsers');
    console.log('    mcp-status                              Check Playwright + Chrome DevTools MCP status');
    console.log();
    process.exit(0);
  }

  const tool = new PlaywrightTool();

  switch (cmd) {
    case 'run':
    case 'test': {
      const options = {};
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--headed') options.headed = true;
        if (args[i] === '--project' && args[i + 1]) options.project = args[++i];
        if (args[i] === '--grep' && args[i + 1]) options.grep = args[++i];
        if (args[i] === '--update-snapshots') options.updateSnapshots = true;
        if ((args[i] === '--base-url' || args[i] === '--url') && args[i + 1]) options.baseUrl = args[++i];
        if (args[i] === '--skip-server') options.skipServer = true;
        if (args[i] === '--dir' && args[i + 1]) options.outputDir = args[++i];
        if (args[i] === '--tests' && args[i + 1]) options.testPath = args[++i];
      }
      const result = tool.runTests(options);
      process.exit(result.success ? 0 : 1);
      break;
    }

    case 'crawl': {
      const options = {};
      for (let i = 1; i < args.length; i++) {
        if ((args[i] === '--base-url' || args[i] === '--url') && args[i + 1]) options.baseUrl = args[++i];
        if (args[i] === '--headed') options.headed = true;
        if (args[i] === '--include-protected') options.includeProtected = true;
      }
      tool.crawl(options).then((result) => process.exit(result.success === false ? 1 : 0));
      break;
    }

    case 'visual-inventory': {
      const options = {};
      for (let i = 1; i < args.length; i++) {
        if ((args[i] === '--base-url' || args[i] === '--url') && args[i + 1]) options.baseUrl = args[++i];
        if (args[i] === '--out' && args[i + 1]) options.outputFile = args[++i];
      }
      const result = tool.buildVisualInventory(options);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'headless-ux': {
      const options = {};
      for (let i = 1; i < args.length; i++) {
        if ((args[i] === '--base-url' || args[i] === '--url') && args[i + 1]) options.baseUrl = args[++i];
        if (args[i] === '--output' && args[i + 1]) options.output = args[++i];
        if (args[i] === '--out-dir' && args[i + 1]) options.outputDir = args[++i];
        if (args[i] === '--include-protected') options.includeProtected = true;
        if (args[i] === '--headed') options.headed = true;
        if (args[i] === '--min-a11y-score' && args[i + 1]) options.minA11yScore = Number(args[++i]);
      }
      tool.headlessUx(options).then((result) => process.exit(result.passed ? 0 : 1));
      break;
    }

    case 'chrome-devtools-evidence': {
      const options = {};
      for (let i = 1; i < args.length; i++) {
        if ((args[i] === '--base-url' || args[i] === '--url') && args[i + 1]) options.baseUrl = args[++i];
        if (args[i] === '--output' && args[i + 1]) options.output = args[++i];
        if (args[i] === '--status' && args[i + 1]) options.status = args[++i];
        if (args[i] === '--console-errors' && args[i + 1]) options.consoleErrors = Number(args[++i]);
        if (args[i] === '--failed-requests' && args[i + 1]) options.failedRequests = Number(args[++i]);
        if (args[i] === '--screenshots' && args[i + 1]) options.screenshots = Number(args[++i]);
        if (args[i] === '--performance-traces' && args[i + 1]) options.performanceTraces = Number(args[++i]);
        if (args[i] === '--memory-snapshots' && args[i + 1]) options.memorySnapshots = Number(args[++i]);
        if (args[i] === '--lighthouse-report' && args[i + 1]) options.lighthouseReport = args[++i];
        if (args[i] === '--console-log' && args[i + 1]) options.consoleLog = args[++i];
        if (args[i] === '--network-log' && args[i + 1]) options.networkLog = args[++i];
        if (args[i] === '--performance-trace' && args[i + 1]) options.performanceTrace = args[++i];
        if (args[i] === '--memory-snapshot' && args[i + 1]) options.memorySnapshot = args[++i];
        if (args[i] === '--screenshot-artifact' && args[i + 1]) options.screenshotArtifact = args[++i];
        if (args[i] === '--lighthouse-performance' && args[i + 1]) {
          options.lighthouseScores = options.lighthouseScores || {};
          options.lighthouseScores.performance = Number(args[++i]);
        }
        if (args[i] === '--lighthouse-accessibility' && args[i + 1]) {
          options.lighthouseScores = options.lighthouseScores || {};
          options.lighthouseScores.accessibility = Number(args[++i]);
        }
        if (args[i] === '--lighthouse-best-practices' && args[i + 1]) {
          options.lighthouseScores = options.lighthouseScores || {};
          options.lighthouseScores.bestPractices = Number(args[++i]);
        }
        if (args[i] === '--lighthouse-seo' && args[i + 1]) {
          options.lighthouseScores = options.lighthouseScores || {};
          options.lighthouseScores.seo = Number(args[++i]);
        }
      }
      const result = tool.chromeDevtoolsEvidence(options);
      process.exit(result.passed ? 0 : 1);
      break;
    }

    case 'health': {
      const options = {};
      for (let i = 1; i < args.length; i++) {
        if ((args[i] === '--base-url' || args[i] === '--url') && args[i + 1]) options.baseUrl = args[++i];
      }
      tool.healthCheck(options).then((result) => process.exit(result.failed > 0 ? 1 : 0));
      break;
    }

    case 'screenshot': {
      const url = args[1];
      if (!url) {
        console.error('  URL required');
        process.exit(1);
      }

      const options = {};
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--name' && args[i + 1]) options.name = args[++i];
        if (args[i] === '--width' && args[i + 1]) options.width = parseInt(args[++i], 10);
        if (args[i] === '--height' && args[i + 1]) options.height = parseInt(args[++i], 10);
      }

      tool.screenshot(url, options).then((result) => process.exit(result.success ? 0 : 1));
      break;
    }

    case 'report':
      tool.showReport();
      break;

    case 'install':
      tool.installBrowsers();
      break;

    case 'smoke': {
      const options = {};
      for (let i = 1; i < args.length; i++) {
        if ((args[i] === '--base-url' || args[i] === '--url') && args[i + 1]) options.baseUrl = args[++i];
      }
      tool.smoke(options).then((result) => process.exit(result.passed ? 0 : 1));
      break;
    }

    case 'audit': {
      const options = {};
      for (let i = 1; i < args.length; i++) {
        if ((args[i] === '--base-url' || args[i] === '--url') && args[i + 1]) options.baseUrl = args[++i];
        if (args[i] === '--output' && args[i + 1]) options.output = args[++i];
        if (args[i] === '--standard' && args[i + 1]) options.standard = args[++i];
      }
      tool.audit(options).then((result) => process.exit(result.score >= 80 ? 0 : 1));
      break;
    }

    case 'check-sync': {
      const options = {};
      for (let i = 1; i < args.length; i++) {
        if ((args[i] === '--base-url' || args[i] === '--url') && args[i + 1]) options.baseUrl = args[++i];
        if (args[i] === '--output' && args[i + 1]) options.output = args[++i];
      }
      tool.checkSync(options).then((result) => process.exit(result.passed ? 0 : 1));
      break;
    }

    case 'mcp-status':
      tool.mcpStatus();
      break;

    default:
      console.error(`  Unknown command: ${cmd}`);
      process.exit(1);
  }
}
