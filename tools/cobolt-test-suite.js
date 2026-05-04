#!/usr/bin/env node

// CoBolt Test Suite — scenario-based test orchestration with autonomous + normal modes
//
// Usage:
//   node tools/cobolt-test-suite.js run "test login flow" --mode autonomous --scope security,api
//   node tools/cobolt-test-suite.js run "audit test coverage" --mode normal
//   node tools/cobolt-test-suite.js report                    # Show latest test suite report
//   node tools/cobolt-test-suite.js report --format md        # Markdown report
//   node tools/cobolt-test-suite.js history                   # List all test suite runs
//   node tools/cobolt-test-suite.js categories                # List available test categories

const fs = require('node:fs');
const path = require('node:path');
const { paths: _paths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();
const testRegistry = (() => {
  try {
    return require('./cobolt-test-registry');
  } catch {
    return null;
  }
})();

const CATEGORIES = {
  unit: { name: 'Unit Tests', agent: 'test-writer', tier: 'sonnet', icon: 'U' },
  integration: { name: 'Integration Tests', agent: 'integration-test-agent', tier: 'sonnet', icon: 'I' },
  e2e: { name: 'End-to-End Tests', agent: 'uat-agent', tier: 'sonnet', icon: 'E' },
  security: { name: 'Security Tests', agent: 'pentest-agent', tier: 'opus', icon: 'S' },
  perf: { name: 'Performance Tests', agent: 'performance-reviewer', tier: 'sonnet', icon: 'P' },
  a11y: { name: 'Accessibility', agent: 'accessibility-reviewer', tier: 'sonnet', icon: 'A' },
  api: { name: 'API Contract', agent: 'api-contract-reviewer', tier: 'sonnet', icon: 'C' },
  db: { name: 'Database Tests', agent: 'db-test-agent', tier: 'sonnet', icon: 'D' },
};

const ESCALATION_TIERS = [
  { agent: 'fix-agent', tier: 'sonnet', label: 'Standard Fix' },
  { agent: 'fix-agent', tier: 'sonnet', label: 'Standard Fix (Retry)' },
  { agent: 'fix-lead', tier: 'sonnet', label: 'Complex Fix (Lead)' },
  { agent: 'resolve-lead', tier: 'opus', label: 'Root Cause Analysis' },
  { agent: 'architect', tier: 'opus', label: 'Architectural Redesign' },
];

const GRADES = [
  { min: 95, grade: 'A', label: 'Excellent' },
  { min: 85, grade: 'B', label: 'Good' },
  { min: 70, grade: 'C', label: 'Needs Work' },
  { min: 50, grade: 'D', label: 'Poor' },
  { min: 0, grade: 'F', label: 'Critical' },
];

class TestSuiteOrchestrator {
  constructor(projectDir) {
    this.projectDir = projectDir || process.cwd();
    this._p = typeof _paths === 'function' ? _paths(this.projectDir) : null;
  }

  _outputDir() {
    const base = this._p ? this._p.currentRun() : path.join(this.projectDir, '_cobolt-output/latest');
    return path.join(base, 'test-suite');
  }

  _ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Parse scenario into test specifications.
   */
  parseScenario(scenario, options = {}) {
    const scope = options.scope
      ? options.scope
          .split(',')
          .map((s) => s.trim())
          .filter((s) => CATEGORIES[s])
      : Object.keys(CATEGORIES);

    const spec = {
      scenario,
      categories: scope,
      mode: options.mode === 'auto' ? 'autonomous' : options.mode || 'normal',
      threshold: options.threshold || 80,
      timestamp: new Date().toISOString(),
      specifications: [],
    };

    // Write scenario spec
    const outDir = this._ensureDir(this._outputDir());
    const specPath = path.join(outDir, 'scenario-spec.json');
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8');

    return { spec, path: specPath };
  }

  /**
   * Compute grade from score.
   */
  computeGrade(score) {
    for (const g of GRADES) {
      if (score >= g.min) return g;
    }
    return GRADES[GRADES.length - 1];
  }

  /**
   * Initialize a new test suite run.
   */
  initRun(scenario, options = {}) {
    const { spec, path: specPath } = this.parseScenario(scenario, options);
    const outDir = this._outputDir();

    // Load report template
    const templatePath = path.join(this.projectDir, 'source/templates/test-suite-report.json');
    let report;
    if (fs.existsSync(templatePath)) {
      report = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    } else {
      report = {
        version: '1.0.0',
        summary: {},
        categories: {},
        observations: [],
        suggestions: [],
        remediation_plan: [],
        fix_history: [],
        evidence: {},
      };
    }

    report.timestamp = new Date().toISOString();
    report.scenario = scenario;
    report.mode = options.mode || 'normal';
    report.summary.categories_tested = spec.categories.length;

    // Initialize category slots
    for (const cat of spec.categories) {
      report.categories[cat] = {
        score: 0,
        tests: 0,
        passed: 0,
        failed: 0,
        findings: [],
        agent: CATEGORIES[cat].agent,
        status: 'pending',
      };
    }

    const reportPath = path.join(outDir, 'test-suite-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

    return {
      spec,
      specPath,
      reportPath,
      outDir,
      categories: spec.categories.map((c) => ({
        id: c,
        ...CATEGORIES[c],
      })),
    };
  }

  /**
   * Update test results for a category.
   */
  updateCategory(category, results) {
    const outDir = this._outputDir();
    const reportPath = path.join(outDir, 'test-suite-report.json');
    if (!fs.existsSync(reportPath)) return null;

    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    if (report.categories[category]) {
      Object.assign(report.categories[category], results);
    }

    // Recompute summary
    let totalTests = 0,
      totalPassed = 0,
      totalFailed = 0;
    for (const cat of Object.values(report.categories)) {
      totalTests += cat.tests || 0;
      totalPassed += cat.passed || 0;
      totalFailed += cat.failed || 0;
    }

    report.summary.total_tests = totalTests;
    report.summary.passed = totalPassed;
    report.summary.failed = totalFailed;
    report.summary.score = totalTests > 0 ? Math.round((totalPassed / totalTests) * 100) : 0;
    report.summary.grade = this.computeGrade(report.summary.score).grade;

    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    return report;
  }

  /**
   * Record a fix iteration (autonomous mode).
   */
  recordFixIteration(iteration) {
    const outDir = this._outputDir();
    const iterPath = path.join(outDir, 'fix-iterations.json');

    let data = { iterations: [], final_status: 'in_progress' };
    if (fs.existsSync(iterPath)) {
      data = JSON.parse(fs.readFileSync(iterPath, 'utf8'));
    }

    data.iterations.push(iteration);
    fs.writeFileSync(iterPath, JSON.stringify(data, null, 2), 'utf8');

    // Also update the report fix_history
    const reportPath = path.join(outDir, 'test-suite-report.json');
    if (fs.existsSync(reportPath)) {
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      report.fix_history = data.iterations;
      report.summary.fix_iterations = data.iterations.length;
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    }

    return data;
  }

  /**
   * Finalize the report.
   */
  finalize(status) {
    const outDir = this._outputDir();
    const reportPath = path.join(outDir, 'test-suite-report.json');
    if (!fs.existsSync(reportPath)) return null;

    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    report.summary.duration_ms = Date.now() - new Date(report.timestamp).getTime();
    report.summary.findings_total = report.observations.length;
    report.summary.findings_fixed = report.observations.filter((o) => o.status === 'fixed').length;

    // Generate markdown
    const md = this.toMarkdown(report);
    const mdPath = path.join(outDir, 'test-suite-report.md');
    fs.writeFileSync(mdPath, md, 'utf8');

    // Update fix iterations final status
    const iterPath = path.join(outDir, 'fix-iterations.json');
    if (fs.existsSync(iterPath)) {
      const data = JSON.parse(fs.readFileSync(iterPath, 'utf8'));
      data.final_status = status || (report.summary.failed === 0 ? 'all_passed' : 'partial');
      fs.writeFileSync(iterPath, JSON.stringify(data, null, 2), 'utf8');
    }

    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

    // ── Sync to Test Registry ──────────────────────────────────
    if (testRegistry) {
      try {
        const _reg = testRegistry.ensureRegistry(this.projectDir);
        // Register test files from evidence
        if (report.evidence) {
          const allFiles = [
            ...(report.evidence.test_files_created || []),
            ...(report.evidence.test_files_modified || []),
          ];
          for (const f of allFiles) {
            testRegistry.cmdRegister(f, { source: 'agent' }, this.projectDir);
          }
        }
        // Record results snapshot
        const runMeta = path.join(this._outputDir(), '..', 'meta.json');
        let runId = `test-suite-${new Date().toISOString().slice(0, 10)}`;
        try {
          if (fs.existsSync(runMeta)) {
            const meta = JSON.parse(fs.readFileSync(runMeta, 'utf8'));
            if (meta.runId) runId = meta.runId;
          }
        } catch {}
        testRegistry.cmdRecord(
          runId,
          {
            stage: 'test-suite',
            milestone: null,
            duration: report.summary.duration_ms || 0,
            coverage: report.summary.coverage || null,
            caseResults: {},
          },
          this.projectDir,
        );
      } catch {
        /* best-effort registry sync */
      }
    }

    return { report, reportPath, mdPath };
  }

  /**
   * Get the latest report.
   */
  getReport() {
    const reportPath = path.join(this._outputDir(), 'test-suite-report.json');
    if (!fs.existsSync(reportPath)) return null;
    return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  }

  /**
   * List all test suite runs.
   */
  history() {
    const baseDir = this._p ? path.dirname(this._p.currentRun()) : path.join(this.projectDir, '_cobolt-output');
    const runs = [];

    if (!fs.existsSync(baseDir)) return runs;

    // Check latest
    const latestReport = path.join(baseDir, 'latest', 'test-suite', 'test-suite-report.json');
    if (fs.existsSync(latestReport)) {
      try {
        const data = JSON.parse(fs.readFileSync(latestReport, 'utf8'));
        runs.push({
          path: latestReport,
          scenario: data.scenario,
          mode: data.mode,
          grade: data.summary.grade,
          score: data.summary.score,
          timestamp: data.timestamp,
        });
      } catch {}
    }

    // Check date-organized runs
    const runsDir = path.join(baseDir, 'runs');
    if (fs.existsSync(runsDir)) {
      try {
        for (const dateDir of fs.readdirSync(runsDir).reverse().slice(0, 10)) {
          const datePath = path.join(runsDir, dateDir);
          if (!fs.statSync(datePath).isDirectory()) continue;
          for (const runDir of fs.readdirSync(datePath).reverse()) {
            const rp = path.join(datePath, runDir, 'test-suite', 'test-suite-report.json');
            if (fs.existsSync(rp)) {
              try {
                const data = JSON.parse(fs.readFileSync(rp, 'utf8'));
                runs.push({
                  path: rp,
                  scenario: data.scenario,
                  mode: data.mode,
                  grade: data.summary.grade,
                  score: data.summary.score,
                  timestamp: data.timestamp,
                });
              } catch {}
            }
          }
        }
      } catch {}
    }

    return runs;
  }

  /**
   * Convert report to Markdown.
   */
  toMarkdown(report) {
    if (!report) report = this.getReport();
    if (!report) return '# No test suite report found.\n';

    const s = report.summary;
    const gradeInfo = this.computeGrade(s.score);
    const lines = [
      '# CoBolt Test Suite Report',
      '',
      `**Scenario:** ${report.scenario}`,
      `**Mode:** ${report.mode === 'autonomous' ? 'Autonomous (test + fix)' : 'Normal (test + report)'}`,
      `**Date:** ${report.timestamp}`,
      `**Duration:** ${s.duration_ms ? `${(s.duration_ms / 1000).toFixed(1)}s` : 'N/A'}`,
      '',
      '## Overall Score',
      '',
      `| Grade | Score | Tests | Passed | Failed | Coverage |`,
      `|-------|-------|-------|--------|--------|----------|`,
      `| **${s.grade}** (${gradeInfo.label}) | ${s.score}% | ${s.total_tests} | ${s.passed} | ${s.failed} | ${s.coverage || 'N/A'}% |`,
      '',
    ];

    // Category breakdown
    if (Object.keys(report.categories).length > 0) {
      lines.push('## Category Breakdown', '');
      lines.push('| Category | Score | Tests | Passed | Failed | Agent |');
      lines.push('|----------|-------|-------|--------|--------|-------|');
      for (const [catId, cat] of Object.entries(report.categories)) {
        const catInfo = CATEGORIES[catId] || {};
        const catScore = cat.tests > 0 ? Math.round((cat.passed / cat.tests) * 100) : 0;
        lines.push(
          `| ${catInfo.name || catId} | ${catScore}% | ${cat.tests} | ${cat.passed} | ${cat.failed} | ${cat.agent || 'N/A'} |`,
        );
      }
      lines.push('');
    }

    // Fix history (autonomous mode)
    if (report.fix_history && report.fix_history.length > 0) {
      lines.push('## Fix History (Autonomous)', '');
      lines.push('| Iteration | Agent | Tier | Failures In | Failures Out | Fixes |');
      lines.push('|-----------|-------|------|-------------|--------------|-------|');
      for (const iter of report.fix_history) {
        lines.push(
          `| ${iter.iteration} | ${iter.agent} | ${iter.model_tier} | ${iter.failures_in} | ${iter.failures_out} | ${(iter.fixes_applied || []).length} |`,
        );
      }
      lines.push('');
    }

    // Observations
    if (report.observations && report.observations.length > 0) {
      lines.push('## Observations', '');
      for (const obs of report.observations) {
        lines.push(`### ${obs.id}: ${obs.title}`);
        lines.push(`- **Category:** ${obs.category} | **Severity:** ${obs.severity}`);
        if (obs.file) lines.push(`- **Location:** ${obs.file}${obs.line ? `:${obs.line}` : ''}`);
        if (obs.description) lines.push(`- ${obs.description}`);
        lines.push('');
      }
    }

    // Suggestions
    if (report.suggestions && report.suggestions.length > 0) {
      lines.push('## Suggestions', '');
      lines.push('| Priority | Effort | Category | Suggestion |');
      lines.push('|----------|--------|----------|------------|');
      for (const sug of report.suggestions) {
        lines.push(`| ${sug.priority} | ${sug.effort || 'N/A'} | ${sug.category || 'N/A'} | ${sug.title} |`);
      }
      lines.push('');
    }

    // Remediation plan
    if (report.remediation_plan && report.remediation_plan.length > 0) {
      lines.push('## Remediation Plan', '');
      for (const step of report.remediation_plan) {
        lines.push(
          `${step.order}. **${step.action}** (${step.category || 'general'}, effort: ${step.effort || 'N/A'}, impact: ${step.impact || 'N/A'})`,
        );
      }
      lines.push('');
    }

    lines.push('---', `*Generated by CoBolt Test Suite v${report.version}*`);
    return lines.join('\n');
  }
}

// ── Module exports ───────────────────────────────────────────

module.exports = { TestSuiteOrchestrator, CATEGORIES, ESCALATION_TIERS, GRADES };

// ── CLI ──────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '--help') {
    console.log('  CoBolt Test Suite — Scenario-Based Test Orchestration');
    console.log('  ═══════════════════════════════════════════════════════');
    console.log();
    console.log('  Usage: node tools/cobolt-test-suite.js <command> [args]');
    console.log();
    console.log('  Commands:');
    console.log('    run <scenario> [options]   Initialize a test suite run');
    console.log('    report [--format md|json]  Show latest test suite report');
    console.log('    history                    List all test suite runs');
    console.log('    categories                 List available test categories');
    console.log();
    console.log('  Run options:');
    console.log('    --mode auto|autonomous|normal  Test mode (default: normal)');
    console.log('    --scope cat1,cat2,...      Test categories to run');
    console.log('    --threshold N              Pass threshold percentage (default: 80)');
    console.log();
    process.exit(0);
  }

  const orch = new TestSuiteOrchestrator();

  switch (cmd) {
    case 'run': {
      const scenario = args[1];
      if (!scenario) {
        console.error('  Error: scenario description required');
        process.exit(1);
      }

      const options = {};
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--mode' && args[i + 1]) {
          options.mode = args[++i];
          if (options.mode === 'auto') options.mode = 'autonomous';
        } else if (args[i] === '--scope' && args[i + 1]) options.scope = args[++i];
        else if (args[i] === '--threshold' && args[i + 1]) options.threshold = parseInt(args[++i], 10);
      }

      const run = orch.initRun(scenario, options);
      console.log(`  Test Suite initialized`);
      console.log(`  Mode: ${options.mode || 'normal'}`);
      console.log(`  Categories: ${run.categories.map((c) => c.id).join(', ')}`);
      console.log(`  Spec: ${run.specPath}`);
      console.log(`  Report: ${run.reportPath}`);
      break;
    }

    case 'report': {
      const format = args.includes('--format') ? args[args.indexOf('--format') + 1] : 'md';
      const report = orch.getReport();
      if (!report) {
        console.log('  No test suite report found.');
        process.exit(0);
      }

      if (format === 'json') {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(orch.toMarkdown(report));
      }
      break;
    }

    case 'history': {
      const runs = orch.history();
      if (runs.length === 0) {
        console.log('  No test suite runs found.');
        break;
      }
      console.log('  Test Suite History:');
      console.log();
      for (const run of runs) {
        console.log(
          `  [${run.grade}] ${run.score}% | ${run.mode.padEnd(10)} | ${run.scenario.slice(0, 50)} | ${run.timestamp}`,
        );
      }
      break;
    }

    case 'categories': {
      console.log('  Available Test Categories:');
      console.log();
      console.log('  ID            Name                  Agent                     Tier');
      console.log('  ─────────────────────────────────────────────────────────────────────');
      for (const [id, cat] of Object.entries(CATEGORIES)) {
        console.log(`  ${id.padEnd(14)} ${cat.name.padEnd(22)} ${cat.agent.padEnd(26)} ${cat.tier}`);
      }
      break;
    }

    default:
      console.error(`  Unknown command: ${cmd}`);
      process.exit(1);
  }
}
