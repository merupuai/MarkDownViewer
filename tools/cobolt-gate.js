#!/usr/bin/env node

// CoBolt Quality Gate — CLI wrapper for deterministic quality verification
//
// Wraps source/plugins/cobolt-toolgate.js for standalone CLI use.
// Runs real tools (ESLint, TypeScript, Prettier, Semgrep, etc.) before AI review.
//
// Usage:
//   node tools/cobolt-gate.js                         # Run all detected tools
//   node tools/cobolt-gate.js --categories lint,test   # Run specific categories
//   node tools/cobolt-gate.js --json                   # JSON output
//   node tools/cobolt-gate.js --save                   # Save report to _cobolt-output
//   node tools/cobolt-gate.js --strict                 # Exit 1 on any warnings too

const path = require('node:path');

// Import the real ToolGate from plugins
const { ToolGate, _testOnly: toolgateInternals } = require('../source/plugins/cobolt-toolgate');
const { isTestFile, scan: scanAssertionQuality } = require('./cobolt-test-assertion-quality');

const CATEGORY_ALIASES = {
  lint: 'lint',
  typecheck: 'typeCheck',
  security: 'security',
  format: 'format',
  deps: 'dependencyAudit',
  test: 'test',
  'test-quality': 'testQuality',
  'ops-patterns': 'opsPatterns',
};

const FAIL_CLOSED_REQUESTED_CATEGORIES = new Set(['security', 'deps', 'ops-patterns']);

const REQUESTED_CATEGORY_LABELS = {
  security: 'Security tooling',
  deps: 'Dependency audit tooling',
  'ops-patterns': 'Operational security pattern tooling',
};

const OPS_PATTERN_CHECKS = [
  {
    id: 'rate-limiting',
    label: 'rate limiting',
    pattern:
      /rate.?limit|rateLimit|RateLimit|throttl|slowapi|express-rate-limit|bottleneck|limiter|Plug\.Throttle|ExRated|hammer/u,
  },
  {
    id: 'retry-resilience',
    label: 'retry/resilience',
    pattern:
      /retry|backoff|circuit.?breaker|tenacity|resilience4j|polly|Req\.Steps|Tesla\.Middleware\.Retry|got\.retry|axios-retry|p-retry/u,
  },
  {
    id: 'security-headers',
    label: 'security headers',
    pattern:
      /helmet|secure_headers|Content-Security-Policy|X-Frame-Options|X-Content-Type-Options|HSTS|Strict-Transport-Security|put_secure_browser_headers|Plug\.SSL|django\.middleware\.security|SecurityMiddleware/u,
  },
  {
    id: 'error-tracking',
    label: 'error tracking',
    pattern: /sentry|bugsnag|rollbar|airbrake|honeybadger|Sentry|Bugsnag|datadog.?apm|newrelic|appsignal|error.?track/u,
  },
];

const OPS_PATTERN_EXTENSIONS = new Set([
  '.js',
  '.cjs',
  '.mjs',
  '.ts',
  '.tsx',
  '.py',
  '.go',
  '.ex',
  '.rb',
  '.rs',
  '.java',
]);
const OPS_PATTERN_EXCLUDED_DIRS = new Set([
  '.git',
  '.claude',
  '.codex',
  '_cobolt-output',
  'node_modules',
  'coverage',
  'dist',
  'build',
  'tools',
]);

function normalizeRequestedFiles(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/\r?\n|,/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveProjectDir(projectDir) {
  return projectDir ? path.resolve(projectDir) : undefined;
}

function resolveGateOutputPath(projectDir, outputPath) {
  if (!outputPath) return null;
  return path.isAbsolute(outputPath) ? outputPath : path.join(projectDir || process.cwd(), outputPath);
}

function applyChangedFileScope(projectDir, options) {
  if (!options.changed) return options;
  if ((options.files?.length || 0) > 0 || (options.testFiles?.length || 0) > 0) return options;

  const changedFiles = toolgateInternals.collectGitChangedFiles(projectDir, {
    baseRef: options.baseRef || options.since,
    includeUntracked: true,
  });
  const changedTestFiles = changedFiles.filter(toolgateInternals.isTestLikePath);
  return {
    ...options,
    files: changedFiles,
    testFiles: changedTestFiles,
    changedFiles,
  };
}

function summarizeCategories(results = []) {
  const categories = {};
  for (const result of results) {
    const categoryKey = CATEGORY_ALIASES[result.category] || result.category;
    if (!categories[categoryKey]) {
      categories[categoryKey] = {
        passed: true,
        status: 'PASS',
        errors: 0,
        warnings: 0,
        tools: [],
      };
    }

    const bucket = categories[categoryKey];
    bucket.tools.push(result.name);
    bucket.errors += result.errors || 0;
    bucket.warnings += result.warnings || 0;

    if (result.status !== 'PASS') {
      bucket.passed = false;
      bucket.status = result.status;
    }
  }

  return categories;
}

function missingRequestedCategoryResults(results = [], requestedCategories = null) {
  if (!Array.isArray(requestedCategories) || requestedCategories.length === 0) return [];

  const present = new Set(results.map((result) => result.category).filter(Boolean));
  return requestedCategories
    .filter((category) => FAIL_CLOSED_REQUESTED_CATEGORIES.has(category))
    .filter((category) => !present.has(category));
}

function readJsonLoose(filePath) {
  const fs = require('node:fs');
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, ''));
  } catch {
    return null;
  }
}

function findMilestoneBuildArtifact(projectDir, milestone, filename) {
  const path = require('node:path');
  const fs = require('node:fs');
  const candidates = [];
  if (milestone) {
    candidates.push(path.join(projectDir, '_cobolt-output', 'latest', 'build', milestone, `${milestone}-${filename}`));
  }
  const latestBuild = path.join(projectDir, '_cobolt-output', 'latest', 'build');
  try {
    for (const entry of fs.readdirSync(latestBuild, { withFileTypes: true })) {
      if (entry.isDirectory() && /^M\d+$/iu.test(entry.name)) {
        candidates.push(path.join(latestBuild, entry.name, `${entry.name}-${filename}`));
      }
    }
  } catch {
    /* no latest build dir */
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function cleanSecurityScanEvidence(projectDir, milestone) {
  const reportPath = findMilestoneBuildArtifact(projectDir, milestone, 'security-scan-report.json');
  const report = reportPath ? readJsonLoose(reportPath) : null;
  if (!report || report.summary?.posture !== 'CLEAN') return null;
  const results = Array.isArray(report.results) ? report.results : [];
  const findingCount = Number(report.summary?.totalFindings || 0);
  if (findingCount !== 0) return null;
  return { reportPath, report, results };
}

function hasCleanSecurityEvidence(evidence) {
  if (!evidence) return false;
  return evidence.results.some(
    (result) =>
      ['sast', 'secrets', 'security'].includes(String(result.category || '').toLowerCase()) &&
      ['PASS', 'SKIPPED'].includes(String(result.status || '').toUpperCase()),
  );
}

function hasCleanDependencyEvidence(evidence) {
  if (!evidence) return false;
  return evidence.results.some(
    (result) =>
      ['deps', 'dependency', 'dependencyAudit'.toLowerCase()].includes(String(result.category || '').toLowerCase()) &&
      ['PASS', 'SKIPPED'].includes(String(result.status || '').toUpperCase()),
  );
}

function appRuntimeMakesOpsPatternsNotApplicable(projectDir) {
  const path = require('node:path');
  const runtime = readJsonLoose(path.join(projectDir, '_cobolt-output', 'latest', 'runtime', 'app-runtime-check.json'));
  const surfaces = runtime?.surfaces || {};
  return runtime?.status === 'passed' && surfaces.hasDesktop === true && surfaces.hasApi === false;
}

function normalizeProjectPath(filePath) {
  return String(filePath || '').replace(/\\/gu, '/');
}

function walkOpsPatternFiles(projectDir, scopedFiles = []) {
  const path = require('node:path');
  const fs = require('node:fs');
  const files = [];

  if (Array.isArray(scopedFiles) && scopedFiles.length > 0) {
    for (const filePath of scopedFiles) {
      const absolute = path.resolve(projectDir, filePath);
      if (
        fs.existsSync(absolute) &&
        fs.statSync(absolute).isFile() &&
        OPS_PATTERN_EXTENSIONS.has(path.extname(absolute))
      ) {
        files.push(absolute);
      }
    }
    return files;
  }

  const stack = [projectDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let children = [];
    try {
      children = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (OPS_PATTERN_EXCLUDED_DIRS.has(child.name)) continue;
      const fullPath = path.join(dir, child.name);
      if (child.isDirectory()) {
        stack.push(fullPath);
      } else if (child.isFile() && OPS_PATTERN_EXTENSIONS.has(path.extname(child.name))) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function deterministicOpsPatternResult(projectDir, scopedFiles = []) {
  const path = require('node:path');
  const fs = require('node:fs');
  const scopedMode = Array.isArray(scopedFiles) && scopedFiles.length > 0;
  let files = walkOpsPatternFiles(projectDir, scopedFiles);
  let scopeMode = scopedMode ? 'file-scoped' : 'project-wide';
  let reason =
    'Used built-in JavaScript scanner for ops-patterns so Windows hosts are not dependent on grep availability.';

  if (scopedMode && files.length === 0) {
    files = walkOpsPatternFiles(projectDir);
    scopeMode = 'project-wide';
    reason =
      'Requested scope contained no eligible source files; fell back to a project-wide ops-pattern scan using the built-in JavaScript scanner.';
  }

  if (files.length === 0) return null;

  const checks = OPS_PATTERN_CHECKS.map((check) => ({ ...check, files: [] }));
  for (const filePath of files) {
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    for (const check of checks) {
      if (check.pattern.test(content)) {
        check.files.push(normalizeProjectPath(path.relative(projectDir, filePath)));
      }
    }
  }

  const summarized = checks.map((check) => ({
    id: check.id,
    label: check.label,
    passed: check.files.length > 0,
    files: [...new Set(check.files)].slice(0, 10),
  }));
  const missing = summarized.filter((check) => !check.passed);

  return {
    tool: 'deterministic-ops-patterns',
    name: 'Deterministic Ops Pattern Scan',
    category: 'ops-patterns',
    status: missing.length === 0 ? 'PASS' : 'FAIL',
    errors: missing.length,
    warnings: 0,
    scopeMode,
    scopedFiles: files.map((filePath) => normalizeProjectPath(path.relative(projectDir, filePath))),
    details: {
      source: 'node-fallback',
      reason,
      checks: summarized,
      missing: missing.map((check) => check.id),
    },
    durationMs: 0,
  };
}

function evidencePassResult(category, name, details) {
  return {
    tool: `evidence-${category}`,
    name,
    category,
    status: 'PASS',
    errors: 0,
    warnings: 0,
    scopeMode: 'evidence-backed',
    scopedFiles: [],
    details,
    durationMs: 0,
  };
}

function evidenceBackedRequestedCategoryResults(results = [], requestedCategories = null, options = {}) {
  if (!Array.isArray(requestedCategories) || requestedCategories.length === 0) return [];
  const present = new Set(results.map((result) => result.category).filter(Boolean));
  const fallbacks = [];
  const evidence = cleanSecurityScanEvidence(options.projectDir || process.cwd(), options.milestone);

  if (requestedCategories.includes('security') && !present.has('security') && hasCleanSecurityEvidence(evidence)) {
    fallbacks.push(
      evidencePassResult('security', 'CoBolt Security Scan Evidence', {
        source: evidence.reportPath,
        posture: evidence.report.summary?.posture,
        totalFindings: evidence.report.summary?.totalFindings || 0,
      }),
    );
    present.add('security');
  }

  if (requestedCategories.includes('deps') && !present.has('deps') && hasCleanDependencyEvidence(evidence)) {
    fallbacks.push(
      evidencePassResult('deps', 'CoBolt Dependency Scan Evidence', {
        source: evidence.reportPath,
        posture: evidence.report.summary?.posture,
        totalFindings: evidence.report.summary?.totalFindings || 0,
      }),
    );
    present.add('deps');
  }

  if (requestedCategories.includes('ops-patterns') && !present.has('ops-patterns')) {
    const opsPatternResult = deterministicOpsPatternResult(options.projectDir || process.cwd(), options.files || []);
    if (opsPatternResult) {
      fallbacks.push(opsPatternResult);
      present.add('ops-patterns');
    }
  }

  if (
    requestedCategories.includes('ops-patterns') &&
    !present.has('ops-patterns') &&
    appRuntimeMakesOpsPatternsNotApplicable(options.projectDir || process.cwd())
  ) {
    fallbacks.push(
      evidencePassResult('ops-patterns', 'Desktop Runtime Ops Pattern Applicability', {
        status: 'not_applicable',
        reason: 'Local-only desktop app has no HTTP API/server surface for rate-limit/header checks.',
      }),
    );
  }

  return fallbacks;
}

function writeJsonReport(filePath, data) {
  const fs = require('node:fs');
  const path = require('node:path');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function determineScopeMode(results = [], options = {}) {
  const requestedScope = (options.files?.length || 0) > 0 || (options.testFiles?.length || 0) > 0;
  if (!requestedScope) return 'project-wide';

  const modes = new Set(results.map((result) => result.scopeMode).filter(Boolean));
  if (modes.size === 0) return 'project-wide-fallback';
  if (modes.size === 1) return [...modes][0];
  return 'hybrid';
}

function parseCliArgs(args) {
  const options = { save: true, files: [], testFiles: [], cache: true };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--categories' && args[i + 1]) {
      options.categories = args[++i];
    } else if ((args[i] === '--project' || args[i] === '--project-dir' || args[i] === '--cwd') && args[i + 1]) {
      options.projectDir = resolveProjectDir(args[++i]);
    } else if (args[i] === '--json') {
      options.json = true;
    } else if (args[i] === '--save') {
      options.save = true;
    } else if (args[i] === '--no-save') {
      options.save = false;
    } else if (args[i] === '--cache') {
      options.cache = true;
    } else if (args[i] === '--no-cache') {
      options.cache = false;
    } else if (args[i] === '--changed') {
      options.changed = true;
    } else if ((args[i] === '--since' || args[i] === '--base' || args[i] === '--base-ref') && args[i + 1]) {
      options.baseRef = args[++i];
    } else if (args[i] === '--strict') {
      options.strict = true;
    } else if (args[i] === '--output' && args[i + 1]) {
      options.output = args[++i];
    } else if (args[i] === '--files' && args[i + 1]) {
      options.files = normalizeRequestedFiles(args[++i]);
    } else if (args[i] === '--test-files' && args[i + 1]) {
      options.testFiles = normalizeRequestedFiles(args[++i]);
    } else if (args[i] === '--milestone' && args[i + 1]) {
      options.milestone = args[++i];
    } else if (args[i] === '--help') {
      options.help = true;
    } else if (!args[i].startsWith('-') && !options.categories) {
      options.categories = args[i];
    }
  }

  return options;
}

// ── Extended gate with summary formatting ────────────────────

class QualityGate extends ToolGate {
  /**
   * Run gate and produce structured result.
   */
  run(options = {}) {
    const runOptions = applyChangedFileScope(this.projectDir, options);
    const categories = runOptions.categories
      ? runOptions.categories
          .split(',')
          .map((category) => category.trim())
          .filter(Boolean)
      : null;
    const evidenceResults = evidenceBackedRequestedCategoryResults([], categories, {
      projectDir: this.projectDir,
      milestone: runOptions.milestone,
      files: runOptions.files,
    });
    const evidenceCategories = new Set(evidenceResults.map((result) => result.category));
    const toolCategories = Array.isArray(categories)
      ? categories.filter((category) => !evidenceCategories.has(category))
      : categories;

    this.runAll(toolCategories, {
      files: runOptions.files,
      testFiles: runOptions.testFiles,
      cache: runOptions.cache !== false,
    });

    for (const fallback of evidenceResults) {
      this.results.push(fallback);
    }

    for (const fallback of evidenceBackedRequestedCategoryResults(this.results, categories, {
      projectDir: this.projectDir,
      milestone: runOptions.milestone,
      files: runOptions.files,
    })) {
      this.results.push(fallback);
    }

    for (const category of missingRequestedCategoryResults(this.results, categories)) {
      this.results.push({
        tool: `missing-${category}`,
        name: REQUESTED_CATEGORY_LABELS[category] || `Missing ${category} tooling`,
        category,
        status: 'FAIL',
        errors: 1,
        warnings: 0,
        scopeMode: 'project-wide',
        scopedFiles: [],
        details: {
          message:
            `Category "${category}" was explicitly requested, but no matching tool executed. ` +
            'Install the required toolchain or run `npm run tools:install` / `npm run tools:quality -- --install`.',
        },
        durationMs: 0,
      });
    }

    const assertionQuality = this.runAssertionQuality(runOptions, categories);
    if (assertionQuality) {
      this.results.push(assertionQuality);
    }

    const result = {
      timestamp: new Date().toISOString(),
      projectDir: this.projectDir,
      passed: this.passed(),
      strict: runOptions.strict ? this.strictPassed() : undefined,
      summary: this.summarize(),
      results: this.results,
      categories: summarizeCategories(this.results),
      scope: {
        mode: determineScopeMode(this.results, runOptions),
        requestedFiles: runOptions.files || [],
        requestedTestFiles: runOptions.testFiles || [],
        changedFiles: runOptions.changedFiles || [],
        changed: runOptions.changed || false,
        baseRef: runOptions.baseRef || null,
        cache: runOptions.cache !== false,
        milestone: runOptions.milestone || null,
      },
    };

    if (runOptions.save) {
      const savedPath = this.save();
      result.reportPath = savedPath;
    }

    if (runOptions.output) {
      const outputPath = resolveGateOutputPath(this.projectDir, runOptions.output);
      writeJsonReport(outputPath, result);
      result.outputPath = outputPath;
    }

    return result;
  }

  runAssertionQuality(options = {}, categories = null) {
    if (categories && !categories.includes('test') && !categories.includes('test-quality')) {
      return null;
    }

    const explicitTestQuality = categories?.includes('test-quality') || false;
    const scopedFiles = options.testFiles?.length
      ? options.testFiles
      : (options.files || []).filter((filePath) => isTestFile(filePath));

    if ((!scopedFiles || scopedFiles.length === 0) && !explicitTestQuality) return null;

    const startTime = Date.now();
    const projectWideFallback = explicitTestQuality && (!scopedFiles || scopedFiles.length === 0);
    const report = scanAssertionQuality(this.projectDir, projectWideFallback ? null : scopedFiles);

    if (explicitTestQuality && report.summary.filesScanned === 0) {
      report.findings.unshift({
        id: 'TAQ-000',
        check: 'no-tests-discovered',
        file: '(project-wide)',
        line: 1,
        snippet: 'No test files discovered',
        message: 'test-quality was requested explicitly, but no test files were found to scan',
      });
      report.summary.errors += 1;
      report.summary.pass = false;
    }

    return {
      tool: 'assertion-quality',
      name: 'Assertion Quality',
      category: 'test-quality',
      status: report.summary.pass ? 'PASS' : 'FAIL',
      errors: report.summary.errors,
      warnings: report.summary.lowDensity,
      scopeMode: projectWideFallback ? 'project-wide' : 'file-scoped',
      scopedFiles: projectWideFallback ? [] : scopedFiles,
      details: report,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Strict pass — no warnings either.
   */
  strictPassed() {
    return this.results.every((r) => r.status === 'PASS' && (r.warnings || 0) === 0);
  }

  /**
   * Summarize results for display.
   */
  summarize() {
    const passed = this.results.filter((r) => r.status === 'PASS').length;
    const failed = this.results.filter((r) => r.status === 'FAIL').length;
    const errored = this.results.filter((r) => r.status === 'ERROR').length;
    const totalErrors = this.results.reduce((s, r) => s + (r.errors || 0), 0);
    const totalWarnings = this.results.reduce((s, r) => s + (r.warnings || 0), 0);

    return { passed, failed, errored, totalErrors, totalWarnings, toolsRun: this.results.length };
  }

  /**
   * Format results as Markdown.
   */
  toMarkdown() {
    const s = this.summarize();
    const lines = [
      '# Quality Gate Report',
      '',
      `**Date:** ${new Date().toISOString()}`,
      `**Verdict:** ${this.passed() ? 'PASS' : 'FAIL'}`,
      '',
      '## Summary',
      '',
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Tools Run | ${s.toolsRun} |`,
      `| Passed | ${s.passed} |`,
      `| Failed | ${s.failed} |`,
      `| Errors | ${s.totalErrors} |`,
      `| Warnings | ${s.totalWarnings} |`,
      '',
      '## Results',
      '',
      '| Tool | Category | Status | Errors | Warnings | Duration |',
      '|------|----------|--------|--------|----------|----------|',
    ];

    for (const r of this.results) {
      const icon = r.status === 'PASS' ? '\u2713' : r.status === 'FAIL' ? '\u2717' : '?';
      lines.push(
        `| ${icon} ${r.name} | ${r.category} | ${r.status} | ${r.errors || 0} | ${r.warnings || 0} | ${r.durationMs}ms |`,
      );
    }

    return lines.join('\n');
  }
}

// ── Module exports ───────────────────────────────────────────

module.exports = {
  QualityGate,
  parseCliArgs,
  _testOnly: {
    determineScopeMode,
    applyChangedFileScope,
    normalizeRequestedFiles,
    resolveGateOutputPath,
    resolveProjectDir,
    summarizeCategories,
    missingRequestedCategoryResults,
    evidenceBackedRequestedCategoryResults,
  },
};

// ── CLI ──────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const options = parseCliArgs(args);

  if (options.help) {
    console.log(
      '  Usage: node tools/cobolt-gate.js [--project path] [--categories lint,test,test-quality,format,security,typecheck,deps,ops-patterns] [--json] [--strict] [--output path] [--files file1,file2] [--test-files test1,test2] [--changed] [--since ref] [--no-cache] [--milestone M1]',
    );
    console.log('  Categories: lint, typecheck, format, security, test, test-quality, deps, ops-patterns');
    process.exit(0);
  }

  const gate = new QualityGate(options.projectDir);
  const result = gate.run(options);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(gate.report());
    if (result.reportPath) console.log(`  Report saved: ${result.reportPath}`);
  }

  if (options.strict) {
    process.exit(gate.strictPassed() ? 0 : 1);
  } else {
    process.exit(gate.passed() ? 0 : 1);
  }
}
