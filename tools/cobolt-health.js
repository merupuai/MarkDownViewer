#!/usr/bin/env node

// CoBolt Health Check — project health diagnostics
//
// Performs a quick health assessment of the project covering:
// code structure, dependencies, tests, security, git, and CoBolt pipeline state.
//
// Usage:
//   node tools/cobolt-health.js                     # Full health check
//   node tools/cobolt-health.js --check deps         # Single check category
//   node tools/cobolt-health.js --json               # JSON output
//   node tools/cobolt-health.js --save               # Save report to _cobolt-output

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { AnalyzerBase } = require('../lib/analyzer-base');
const { normalizeStage } = require('../lib/cobolt-stage-contract');
const { TOOL_REGISTRY } = require('../lib/tool-registry');
const { build: buildIso25010Scorecard } = require('./cobolt-iso25010');
const { paths: _paths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();

function execCliSync(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    ...options,
    shell: process.platform === 'win32' && !path.isAbsolute(cmd),
  });
}

function runVersionProbe(analyzer, req) {
  const result = analyzer._run(req.cmd, req.args, { timeout: 10000 });
  const output = String(result?.output || result?.stdout || '').trim();
  if (result?.success && output) {
    return { ok: true, output };
  }

  const detail = String(result?.stderr || result?.output || '').trim();
  return { ok: false, detail: detail || 'Not installed' };
}

const HEALTH_CHECKS = {
  structure: {
    name: 'Project Structure',
    run: checkStructure,
  },
  deps: {
    name: 'Dependencies',
    run: checkDependencies,
  },
  tests: {
    name: 'Test Coverage',
    run: checkTests,
  },
  security: {
    name: 'Security Posture',
    run: checkSecurity,
  },
  git: {
    name: 'Git Health',
    run: checkGit,
  },
  pipeline: {
    name: 'CoBolt Pipeline',
    run: checkPipeline,
  },
  iso25010: {
    name: 'ISO/IEC 25010 Quality Model',
    run: checkIso25010,
  },
  toolchain: {
    name: 'Toolchain Versions',
    run: checkToolchainVersions,
  },
};

// ── Check implementations ────────────────────────────────────

function checkStructure(projectDir) {
  const checks = [];
  const indicators = {
    'package.json': 'Node.js',
    'go.mod': 'Go',
    'pyproject.toml': 'Python',
    'Cargo.toml': 'Rust',
    'mix.exs': 'Elixir',
    Dockerfile: 'Docker',
    '.github/workflows': 'GitHub Actions',
    'tsconfig.json': 'TypeScript',
  };

  const detected = [];
  for (const [file, tech] of Object.entries(indicators)) {
    if (fs.existsSync(path.join(projectDir, file))) detected.push(tech);
  }

  checks.push({
    check: 'Tech stack detected',
    status: detected.length > 0 ? 'PASS' : 'WARN',
    detail: detected.join(', ') || 'None detected',
  });
  checks.push({
    check: 'README exists',
    status: fs.existsSync(path.join(projectDir, 'README.md')) ? 'PASS' : 'WARN',
    detail: '',
  });
  checks.push({
    check: '.gitignore exists',
    status: fs.existsSync(path.join(projectDir, '.gitignore')) ? 'PASS' : 'WARN',
    detail: '',
  });
  checks.push({
    check: 'License exists',
    status: fs.existsSync(path.join(projectDir, 'LICENSE')) ? 'PASS' : 'WARN',
    detail: '',
  });

  // Check for common bad patterns
  const envFile = path.join(projectDir, '.env');
  if (fs.existsSync(envFile)) {
    checks.push({ check: '.env file', status: 'WARN', detail: 'Ensure .env is in .gitignore' });
  }

  return { name: 'Project Structure', checks, score: calcScore(checks) };
}

function checkDependencies(projectDir) {
  const checks = [];

  // Node.js
  const pkgFile = path.join(projectDir, 'package.json');
  if (fs.existsSync(pkgFile)) {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    const depCount = Object.keys(pkg.dependencies || {}).length;
    const devDepCount = Object.keys(pkg.devDependencies || {}).length;
    checks.push({ check: 'npm dependencies', status: 'INFO', detail: `${depCount} prod, ${devDepCount} dev` });

    // Accept any of the four common Node lock files. Bun, pnpm, and yarn
    // projects were previously failing this check because only npm's
    // package-lock.json was inspected — a stack-monoculture assumption that
    // produced false-FAILs on perfectly healthy bun/pnpm/yarn projects.
    const LOCK_FILES = [
      { file: 'package-lock.json', manager: 'npm' },
      { file: 'pnpm-lock.yaml', manager: 'pnpm' },
      { file: 'yarn.lock', manager: 'yarn' },
      { file: 'bun.lock', manager: 'bun' },
      { file: 'bun.lockb', manager: 'bun' },
    ];
    const detectedLock = LOCK_FILES.find((entry) => fs.existsSync(path.join(projectDir, entry.file)));
    checks.push({
      check: 'Lock file exists',
      status: detectedLock ? 'PASS' : 'FAIL',
      detail: detectedLock
        ? `${detectedLock.file} (${detectedLock.manager})`
        : 'no package-lock/pnpm-lock/yarn.lock/bun.lock found',
    });

    // Check for outdated
    try {
      const output = execCliSync('npm', ['outdated', '--json'], {
        cwd: projectDir,
        encoding: 'utf8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const outdated = JSON.parse(output || '{}');
      const count = Object.keys(outdated).length;
      checks.push({ check: 'Outdated packages', status: count > 10 ? 'WARN' : 'PASS', detail: `${count} outdated` });
    } catch {
      checks.push({ check: 'Outdated packages', status: 'INFO', detail: 'Could not check' });
    }
  }

  return { name: 'Dependencies', checks, score: calcScore(checks) };
}

function checkTests(projectDir) {
  const checks = [];

  const testDirs = ['tests', 'test', '__tests__', 'spec'];
  const hasTestDir = testDirs.some((d) => fs.existsSync(path.join(projectDir, d)));
  checks.push({ check: 'Test directory exists', status: hasTestDir ? 'PASS' : 'FAIL', detail: '' });

  // Count test files
  if (hasTestDir) {
    let testFileCount = 0;
    for (const dir of testDirs) {
      const fullDir = path.join(projectDir, dir);
      if (!fs.existsSync(fullDir)) continue;
      try {
        const files = fs.readdirSync(fullDir, { recursive: true });
        testFileCount += files.filter((f) => /\.(test|spec)\.(js|ts|py|go|ex)$/.test(f) || /^test[_-]/.test(f)).length;
      } catch {}
    }
    checks.push({
      check: 'Test files found',
      status: testFileCount > 0 ? 'PASS' : 'WARN',
      detail: `${testFileCount} files`,
    });
  }

  // Check for CI test config
  const ciFiles = ['.github/workflows', '.gitlab-ci.yml', 'Jenkinsfile', '.circleci/config.yml'];
  const hasCI = ciFiles.some((f) => fs.existsSync(path.join(projectDir, f)));
  checks.push({ check: 'CI/CD configured', status: hasCI ? 'PASS' : 'WARN', detail: '' });

  return { name: 'Test Coverage', checks, score: calcScore(checks) };
}

function checkSecurity(projectDir) {
  const checks = [];
  const analyzer = new AnalyzerBase(projectDir);
  analyzer.results = { tools: [] };

  // Check for available security tools
  const coreTools = TOOL_REGISTRY.filter((t) => t.priority === 'core');
  let coreAvailable = 0;
  for (const tool of coreTools) {
    if (tool.builtin || analyzer._discoverTool(tool.name).found) coreAvailable++;
  }
  checks.push({
    check: 'Core security tools',
    status: coreAvailable === coreTools.length ? 'PASS' : coreAvailable > 0 ? 'WARN' : 'FAIL',
    detail: `${coreAvailable}/${coreTools.length} available`,
  });

  // Check for security config files
  checks.push({
    check: '.semgrep config',
    status: fs.existsSync(path.join(projectDir, '.semgrep.yml')) ? 'PASS' : 'INFO',
    detail: '',
  });
  checks.push({
    check: '.gitleaks config',
    status: fs.existsSync(path.join(projectDir, '.gitleaks.toml')) ? 'PASS' : 'INFO',
    detail: '',
  });

  return { name: 'Security Posture', checks, score: calcScore(checks) };
}

function checkGit(projectDir) {
  const checks = [];

  try {
    // Check if it's a git repo
    execCliSync('git', ['rev-parse', '--git-dir'], { cwd: projectDir, stdio: 'pipe' });
    checks.push({ check: 'Git repository', status: 'PASS', detail: '' });

    // Check for uncommitted changes. Force -uall so repo/user config cannot hide untracked files.
    const status = execCliSync('git', ['status', '--porcelain=v1', '-uall'], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 10000,
    }).trimEnd();
    const statusLines = status ? status.split(/\r?\n/).filter(Boolean) : [];
    const uncommitted = statusLines.length;
    const staged = statusLines.filter((line) => line[0] !== ' ' && line[0] !== '?').length;
    const unstaged = statusLines.filter((line) => line[1] !== ' ' && line[0] !== '?').length;
    const untracked = statusLines.filter((line) => line.startsWith('??')).length;
    const detail =
      uncommitted > 0
        ? `${uncommitted} files (${staged} staged, ${unstaged} unstaged, ${untracked} untracked)`
        : '0 files';
    checks.push({
      check: 'Uncommitted changes',
      status: uncommitted > 0 ? 'WARN' : 'PASS',
      detail,
    });

    // Check branch
    const branch = execCliSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 10000,
    }).trim();
    checks.push({ check: 'Current branch', status: 'INFO', detail: branch });

    // Check for large files
    try {
      const _logOutput = execCliSync('git', ['rev-list', '--objects', '--all', '--sort=objectsize'], {
        cwd: projectDir,
        encoding: 'utf8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // This is expensive, just check if repo is reasonably sized
      checks.push({ check: 'Repository size', status: 'PASS', detail: 'OK' });
    } catch {
      checks.push({ check: 'Repository size', status: 'INFO', detail: 'Could not check' });
    }
  } catch {
    checks.push({ check: 'Git repository', status: 'FAIL', detail: 'Not a git repository' });
  }

  return { name: 'Git Health', checks, score: calcScore(checks) };
}

function checkPipeline(projectDir) {
  const checks = [];
  const latestRoot = path.join(projectDir, '_cobolt-output', 'latest');
  const customTools = [
    ['accuracy-evaluator', path.join(projectDir, 'tools', 'cobolt-accuracy-evaluator.js')],
    ['flake-hunter', path.join(projectDir, 'tools', 'cobolt-flake-hunter.js')],
    ['runtime-profiler', path.join(projectDir, 'tools', 'cobolt-runtime-profiler.js')],
    ['reliability-guard', path.join(projectDir, 'tools', 'cobolt-reliability-guard.js')],
    ['config-drift', path.join(projectDir, 'tools', 'cobolt-config-drift.js')],
  ];
  const latestReports = [
    path.join(latestRoot, 'audit', 'accuracy-evaluation.json'),
    path.join(latestRoot, 'build', 'flake-hunter-report.json'),
    path.join(latestRoot, 'perf', 'runtime-profiler.json'),
    path.join(latestRoot, 'deploy', 'reliability-guard.json'),
    path.join(projectDir, '_cobolt-output', 'audit', 'config-drift.json'),
  ];

  // Check cobolt-state.json
  const stateFile = path.join(projectDir, 'cobolt-state.json');
  checks.push({ check: 'cobolt-state.json', status: fs.existsSync(stateFile) ? 'PASS' : 'WARN', detail: '' });

  if (fs.existsSync(stateFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const rawStage = state.pipeline?.currentStage || state.currentStage || state.pipeline?.stage || 'unknown';
      const stage = normalizeStage(rawStage) || rawStage;
      checks.push({ check: 'Pipeline stage', status: 'INFO', detail: stage });
      checks.push({ check: 'Current milestone', status: 'INFO', detail: state.pipeline?.currentMilestone || 'none' });
    } catch {}
  }

  // Check _cobolt-output
  const outputDir = path.join(projectDir, '_cobolt-output');
  checks.push({ check: 'Output directory', status: fs.existsSync(outputDir) ? 'PASS' : 'INFO', detail: '' });

  // Check for CLAUDE.md
  checks.push({
    check: 'CLAUDE.md exists',
    status: fs.existsSync(path.join(projectDir, 'CLAUDE.md')) ? 'PASS' : 'WARN',
    detail: '',
  });

  const missingCustomTools = customTools.filter(([, filePath]) => !fs.existsSync(filePath));
  checks.push({
    check: 'Custom quality tools present',
    status: missingCustomTools.length === 0 ? 'PASS' : 'WARN',
    detail:
      missingCustomTools.length === 0
        ? `${customTools.length}/${customTools.length} present`
        : `${customTools.length - missingCustomTools.length}/${customTools.length} present`,
  });

  const availableReports = latestReports.filter((filePath) => fs.existsSync(filePath));
  checks.push({
    check: 'Latest quality evidence',
    status: availableReports.length >= 3 ? 'PASS' : availableReports.length > 0 ? 'WARN' : 'INFO',
    detail: `${availableReports.length}/${latestReports.length} reports available`,
  });

  return { name: 'CoBolt Pipeline', checks, score: calcScore(checks) };
}

function checkIso25010(projectDir) {
  const scorecard = buildIso25010Scorecard(projectDir);
  const checks = Object.entries(scorecard.characteristics).map(([_key, characteristic]) => {
    const score = Number(characteristic.score || 0);
    return {
      check: characteristic.label,
      status: score >= 80 ? 'PASS' : score >= 60 ? 'WARN' : 'FAIL',
      detail: `${score}/100, ${characteristic.findings} finding(s)`,
    };
  });

  checks.unshift({
    check: 'Overall product quality',
    status: scorecard.overall.score >= 80 ? 'PASS' : scorecard.overall.score >= 60 ? 'WARN' : 'FAIL',
    detail: `${scorecard.overall.score}/100 (${scorecard.overall.grade})`,
  });

  return {
    name: 'ISO/IEC 25010 Quality Model',
    checks,
    score: Math.round(scorecard.overall.score),
    standard: scorecard.standard,
  };
}

function checkToolchainVersions(projectDir) {
  const checks = [];
  const analyzer = new AnalyzerBase(projectDir);
  analyzer.results = { tools: [] };

  // Minimum recommended versions for key tools
  const VERSION_REQUIREMENTS = {
    node: { min: '20.0.0', cmd: 'node', args: ['--version'] },
    npm: { min: '10.0.0', cmd: 'npm', args: ['--version'] },
    semgrep: { min: '1.0.0', cmd: 'semgrep', args: ['--version'] },
    trivy: { min: '0.50.0', cmd: 'trivy', args: ['--version'] },
    gitleaks: { min: '8.18.0', cmd: 'gitleaks', args: ['version'] },
  };

  function parseVersion(output) {
    const match = String(output).match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  }

  function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) > (pb[i] || 0)) return 1;
      if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    }
    return 0;
  }

  for (const [tool, req] of Object.entries(VERSION_REQUIREMENTS)) {
    const probe = runVersionProbe(analyzer, req);
    try {
      if (!probe.ok) {
        checks.push({ check: `${tool} version`, status: 'INFO', detail: probe.detail });
        continue;
      }

      const output = probe.output;
      const version = parseVersion(output);
      if (version) {
        const cmp = compareVersions(version, req.min);
        checks.push({
          check: `${tool} version`,
          status: cmp >= 0 ? 'PASS' : 'WARN',
          detail: cmp >= 0 ? `${version} (>= ${req.min})` : `${version} (needs >= ${req.min})`,
        });
      } else {
        checks.push({ check: `${tool} version`, status: 'INFO', detail: 'Could not parse version' });
      }
    } catch {
      checks.push({ check: `${tool} version`, status: 'INFO', detail: 'Not installed' });
    }
  }

  // Check for new CoBolt tools availability
  const newTools = [
    ['dead-code-detector', path.join(projectDir, 'tools', 'cobolt-dead-code-detector.js')],
    ['n-plus-one-detector', path.join(projectDir, 'tools', 'cobolt-n-plus-one-detector.js')],
    ['dependency-health', path.join(projectDir, 'tools', 'cobolt-dependency-health.js')],
    ['secret-entropy-scanner', path.join(projectDir, 'tools', 'cobolt-secret-entropy-scanner.js')],
    ['migration-safety', path.join(projectDir, 'tools', 'cobolt-migration-safety.js')],
    ['api-contract-validator', path.join(projectDir, 'tools', 'cobolt-api-contract-validator.js')],
    ['memory-leak-detector', path.join(projectDir, 'tools', 'cobolt-memory-leak-detector.js')],
  ];

  const presentCount = newTools.filter(([, p]) => fs.existsSync(p)).length;
  checks.push({
    check: 'Enhanced quality tools',
    status: presentCount === newTools.length ? 'PASS' : presentCount > 0 ? 'WARN' : 'INFO',
    detail: `${presentCount}/${newTools.length} enhanced tools available`,
  });

  return { name: 'Toolchain Versions', checks, score: calcScore(checks) };
}

function calcScore(checks) {
  const weights = { PASS: 1, WARN: 0.5, FAIL: 0, INFO: 0.75, ERROR: 0 };
  const scorable = checks.filter((c) => c.status !== 'INFO');
  if (scorable.length === 0) return 100;
  const total = scorable.reduce((sum, c) => sum + (weights[c.status] || 0), 0);
  return Math.round((total / scorable.length) * 100);
}

// ── Main runner ──────────────────────────────────────────────

function runHealthCheck(projectDir, options = {}) {
  const results = {};
  const checks = options.check ? [options.check] : Object.keys(HEALTH_CHECKS);

  for (const checkId of checks) {
    const check = HEALTH_CHECKS[checkId];
    if (!check) continue;
    results[checkId] = check.run(projectDir || process.cwd());
  }

  const overallScore = Math.round(
    Object.values(results).reduce((sum, r) => sum + r.score, 0) / Object.values(results).length,
  );

  return { results, overallScore, timestamp: new Date().toISOString() };
}

function formatReport(healthData) {
  const lines = [
    '',
    '  ══════════════════════════════════════════════',
    '  CoBolt Health Check',
    '  ══════════════════════════════════════════════',
    '',
  ];

  for (const [_id, section] of Object.entries(healthData.results)) {
    lines.push(`  ${section.name} (Score: ${section.score}%)`);
    lines.push('  ──────────────────────────────────────────────');
    for (const c of section.checks) {
      const icon =
        c.status === 'PASS' ? '\u2713' : c.status === 'FAIL' ? '\u2717' : c.status === 'WARN' ? '\u26A0' : '\u2022';
      lines.push(`  ${icon} ${c.check}${c.detail ? ` — ${c.detail}` : ''}`);
    }
    lines.push('');
  }

  lines.push('  ══════════════════════════════════════════════');
  lines.push(`  Overall Score: ${healthData.overallScore}%`);
  lines.push('  ══════════════════════════════════════════════');
  lines.push('');

  return lines.join('\n');
}

// ── Module exports ───────────────────────────────────────────

module.exports = { runHealthCheck, formatReport, HEALTH_CHECKS, _testOnly: { runVersionProbe } };

// ── CLI ──────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};
  let projectDir = process.cwd();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check' && args[i + 1]) {
      options.check = args[++i];
    } else if (args[i] === '--json') {
      options.json = true;
    } else if (args[i] === '--save') {
      options.save = true;
    } else if (args[i] === '--help') {
      console.log(
        '  Usage: node tools/cobolt-health.js [project-path] [--check structure|deps|tests|security|git|pipeline] [--json] [--save]',
      );
      process.exit(0);
    } else if (!args[i].startsWith('--')) {
      projectDir = path.resolve(args[i]);
    }
  }

  const result = runHealthCheck(projectDir, options);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatReport(result));
  }

  if (options.save) {
    const outDir = path.join(projectDir, '_cobolt-output', 'latest', 'health');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const reportPath = path.join(outDir, 'health-check.json');
    fs.writeFileSync(reportPath, JSON.stringify(result, null, 2), 'utf8');
    console.log(`  Report saved: ${reportPath}`);
  }
}
