#!/usr/bin/env node

// CoBolt Replay Harness - deterministic regression scenarios for known pipeline failures.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
const { auditPlanningArtifacts } = require('./cobolt-planning-artifact-audit');
const { checkRuntimeContract } = require('./cobolt-runtime-contract');
const { checkFrontendRuntime } = require('./cobolt-frontend-runtime-check');
const { evaluatePromptBudget } = require('./cobolt-context-budget');
const { detectOverlappingChangedFiles } = require('./cobolt-branch-topology');
const { evaluateStopLineSignals } = require('./cobolt-stop-line');
const { checkUiPrEvidence } = require('./cobolt-ui-pr-evidence');

function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
  return fullPath;
}

const SCENARIOS = {
  'planning-artifact-path': {
    control: 'planning-artifact-audit',
    run(root) {
      // v0.47.5 — Fix 3 excludes _cobolt-output/runs/** from the misplacement
      // walk (historical run snapshots are intentional archives, not
      // misplacements). Exercise the detector with a non-runs misplacement
      // location (direct _cobolt-output/planning/) which IS still a real
      // misplacement class we want to catch.
      writeFile(root, '_cobolt-output/latest/planning/checkpoints/phase5-build-authorization.json', '{"ok":true}\n');
      writeFile(root, '_cobolt-output/planning/prd.md', `# PRD\n\nMisplaced.\n\n${'x'.repeat(600)}\n`);
      const report = auditPlanningArtifacts(root);
      return { passed: report.passed === false, report };
    },
  },
  'runtime-contract-elixir': {
    control: 'runtime-contract',
    run(root) {
      writeFile(root, '_cobolt-output/latest/planning/prd.md', '# PRD\n\nRuntime: Elixir 1.17+\n');
      writeFile(root, 'mix.exs', 'defmodule Demo.MixProject do\n  def project, do: [elixir: "~> 1.15"]\nend\n');
      const report = checkRuntimeContract(root);
      return { passed: report.passed === false, report };
    },
  },
  'tailwind-phoenix-source': {
    control: 'frontend-runtime-check',
    run(root) {
      writeFile(root, 'package.json', JSON.stringify({ dependencies: { tailwindcss: '^4.0.0' } }));
      writeFile(root, 'mix.exs', 'defmodule Demo.MixProject do\nend\n');
      writeFile(root, 'lib/demo_web/live/page_live.ex', 'defmodule DemoWeb.PageLive do\nend\n');
      writeFile(root, 'assets/css/app.css', '@import "tailwindcss";\n');
      const report = checkFrontendRuntime(root);
      return { passed: report.passed === false, report };
    },
  },
  'oversized-planning-prompt': {
    control: 'context-budget',
    run(root) {
      const report = evaluatePromptBudget(
        { skill: 'cobolt-plan', prompt: `Read prd.md\n${'x'.repeat(45000)}` },
        { projectRoot: root },
      );
      return { passed: report.passed === false, report };
    },
  },
  'branch-overlap': {
    control: 'branch-topology',
    run() {
      const overlaps = detectOverlappingChangedFiles({
        'feature/a': ['lib/auth.ex', 'README.md'],
        'feature/b': ['lib/auth.ex'],
      });
      return { passed: overlaps.length === 1, report: { overlaps } };
    },
  },
  'ui-pr-missing-evidence': {
    control: 'ui-pr-evidence',
    run(root) {
      const report = checkUiPrEvidence(root, { changedFiles: ['assets/css/app.css'] });
      return { passed: report.passed === false, report };
    },
  },
  'stop-line-fix-loop': {
    control: 'stop-line',
    run() {
      const report = evaluateStopLineSignals({ fixLoopsByFinding: { AUTH001: 3 } });
      return { passed: report.shouldStop === true, report };
    },
  },
};

function runReplayHarness(options = {}) {
  const selected = options.scenario && options.scenario !== 'all' ? [options.scenario] : Object.keys(SCENARIOS);
  const results = [];
  for (const scenarioId of selected) {
    const scenario = SCENARIOS[scenarioId];
    if (!scenario) {
      results.push({ scenario: scenarioId, passed: false, issue: 'unknown scenario' });
      continue;
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cobolt-replay-${scenarioId}-`));
    try {
      const result = scenario.run(tmpDir);
      results.push({ scenario: scenarioId, control: scenario.control, ...result });
    } catch (err) {
      results.push({ scenario: scenarioId, control: scenario.control, passed: false, issue: err.message });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  const report = {
    passed: results.every((result) => result.passed),
    generatedAt: new Date().toISOString(),
    results,
  };

  if (options.write && options.projectRoot) {
    const outDir = path.join(options.projectRoot, '_cobolt-output', 'replay');
    atomicWrite(path.join(outDir, 'replay-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  return report;
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'run';
  const json = argv.includes('--json');
  const scenarioIndex = argv.indexOf('--scenario');
  if (command !== 'run') {
    console.error('Usage: node tools/cobolt-replay-harness.js run [--scenario all] [--json]');
    process.exit(2);
  }
  const report = runReplayHarness({
    scenario: scenarioIndex !== -1 ? argv[scenarioIndex + 1] : 'all',
    write: argv.includes('--write'),
    projectRoot: process.cwd(),
  });
  if (json) console.log(JSON.stringify(report, null, 2));
  else if (report.passed) console.log(`[cobolt-replay-harness] ${report.results.length} replay scenario(s) passed.`);
  else
    for (const result of report.results.filter((entry) => !entry.passed))
      console.error(`[cobolt-replay-harness] ${result.scenario}: ${result.issue || 'control did not catch failure'}`);
  process.exit(report.passed ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  SCENARIOS,
  runReplayHarness,
};
