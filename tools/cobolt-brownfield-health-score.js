#!/usr/bin/env node

// CoBolt Brownfield Health Score — Deterministic health computation
//
// Computes weighted health score from CLI tool JSON outputs.
// Replaces LLM synthesis in P0 Step 0.6 and P3 Step 3.2.
//
// Formula: Code Quality 18% + Security 20% + Test Coverage 15% +
//          Architecture 15% + Dependencies 10% + Documentation 10% +
//          Git Health 7% + Ops Readiness 5%
//
// Usage:
//   node tools/cobolt-brownfield-health-score.js compute [--dir <path>]  # Compute from scan outputs
//   node tools/cobolt-brownfield-health-score.js compute --json           # Machine-readable
//   node tools/cobolt-brownfield-health-score.js grade                    # Grade only (A+ to F)
//   node tools/cobolt-brownfield-health-score.js verdict                  # Verdict only
//
// Exit codes:
//   0 = health grade >= C (proceed)
//   1 = health grade D or F (needs attention)
//   2 = usage error

const fs = require('node:fs');
const path = require('node:path');

// ── Path Resolution ─────────────────────────────────────────

const { paths: _paths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();

function outputDir(projectDir) {
  if (projectDir) return path.join(projectDir, '_cobolt-output', 'latest');
  const p = typeof _paths === 'function' ? _paths() : null;
  if (p) return path.join(p.outputRoot, 'latest');
  return path.join(process.cwd(), '_cobolt-output/latest');
}

// ── Weight Configuration ────────────────────────────────────

const WEIGHTS = {
  codeQuality: 0.18,
  security: 0.2,
  testCoverage: 0.15,
  architecture: 0.15,
  dependencies: 0.1,
  documentation: 0.1,
  gitHealth: 0.07,
  opsReadiness: 0.05,
};

// ── Score Extractors ────────────────────────────────────────

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    try {
      const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
      const objectStart = raw.indexOf('{');
      const arrayStart = raw.indexOf('[');
      const starts = [objectStart, arrayStart].filter((idx) => idx >= 0).sort((a, b) => a - b);
      if (starts.length === 0) return null;
      return JSON.parse(raw.slice(starts[0]));
    } catch {
      return null;
    }
  }
}

function scoreCodeQuality(healthData) {
  if (!healthData) return { score: 50, detail: 'No health scan data' };
  const lint = healthData.lint || healthData.codeQuality || {};
  const errors = lint.errors || lint.errorCount || 0;
  const warnings = lint.warnings || lint.warningCount || 0;

  let score = 100;
  score -= Math.min(50, errors * 5);
  score -= Math.min(30, warnings * 1);
  return { score: Math.max(0, score), detail: `${errors} errors, ${warnings} warnings` };
}

function scoreSecurity(scanData) {
  if (!scanData) return { score: 50, detail: 'No security scan data' };
  const findings = [];
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };

  if (Array.isArray(scanData.findings)) {
    findings.push(...scanData.findings);
  }

  if (Array.isArray(scanData.results)) {
    for (const result of scanData.results) {
      if (Array.isArray(result.findings)) {
        findings.push(...result.findings);
      } else if (result.status === 'FINDINGS') {
        findings.push({ severity: result.severity || result.level || 'medium' });
      }
    }
  }

  if (findings.length === 0 && scanData.summary?.totalFindings) {
    for (let i = 0; i < scanData.summary.totalFindings; i++) {
      findings.push({ severity: 'medium' });
    }
  }

  for (const f of findings) {
    const sev = (f.severity || f.level || 'low').toLowerCase();
    if (bySeverity[sev] !== undefined) bySeverity[sev]++;
  }

  let score = 100;
  score -= bySeverity.critical * 25;
  score -= bySeverity.high * 10;
  score -= bySeverity.medium * 3;
  score -= bySeverity.low * 1;
  return {
    score: Math.max(0, score),
    detail: `C:${bySeverity.critical} H:${bySeverity.high} M:${bySeverity.medium} L:${bySeverity.low}`,
    bySeverity,
  };
}

function scoreTestCoverage(healthData) {
  if (!healthData) return { score: 30, detail: 'No test data' };
  const test = healthData.test || healthData.testCoverage || healthData.results?.tests || {};
  const coverage = test.coverage || test.coveragePercent || 0;
  const hasTests = test.hasTests !== undefined ? test.hasTests : coverage > 0;

  if (!hasTests && typeof test.score === 'number') {
    return { score: Math.min(100, Math.max(0, test.score)), detail: `Health section score ${test.score}%` };
  }

  if (!hasTests) return { score: 0, detail: 'No tests found' };
  // Linear scale: 0% = 0, 80% = 80, 100% = 100
  return { score: Math.min(100, Math.round(coverage)), detail: `${coverage}% coverage` };
}

function scoreArchitecture(healthData) {
  if (!healthData) return { score: 50, detail: 'No architecture data' };
  if (typeof healthData.results?.structure?.score === 'number') {
    return {
      score: Math.min(100, Math.max(0, healthData.results.structure.score)),
      detail: `Health section score ${healthData.results.structure.score}%`,
    };
  }

  const arch = healthData.architecture || healthData.structure || {};
  let score = 60; // Base for existing projects

  // Positive signals
  if (arch.hasModules || arch.hasLayers) score += 15;
  if (arch.hasSeparation) score += 10;
  if (arch.hasConfig) score += 5;

  // Negative signals
  if (arch.circularDeps) score -= 20;
  if (arch.godModules) score -= 15;
  if (arch.deepNesting) score -= 10;

  return { score: Math.max(0, Math.min(100, score)), detail: `Score: ${Math.max(0, Math.min(100, score))}` };
}

function scoreDependencies(sbomData, scanData) {
  if (!sbomData && !scanData) return { score: 50, detail: 'No dependency data' };
  let score = 100;
  const detail = [];

  if (sbomData) {
    const components = sbomData.components || [];
    const total = components.length;
    detail.push(`${total} deps`);
  }

  if (scanData) {
    // Check for dependency-related findings
    const depFindings = [];
    for (const finding of scanData.findings || []) {
      depFindings.push(finding);
    }
    for (const result of scanData.results || []) {
      if (
        (result.category || '').toLowerCase().includes('dep') ||
        (result.tool || '').toLowerCase().includes('audit')
      ) {
        if (Array.isArray(result.findings) && result.findings.length > 0) {
          depFindings.push(...result.findings);
        } else if (result.status === 'FINDINGS') {
          depFindings.push({ severity: result.severity || 'high' });
        }
      }
    }
    const critical = depFindings.filter((f) => (f.severity || '').toLowerCase() === 'critical').length;
    const high = depFindings.filter((f) => (f.severity || '').toLowerCase() === 'high').length;
    score -= critical * 20;
    score -= high * 5;
    detail.push(`${critical} critical CVEs, ${high} high`);
  }

  return { score: Math.max(0, score), detail: detail.join('; ') };
}

function scoreDocumentation(dir) {
  let score = 0;
  const checks = [
    { file: 'README.md', points: 30 },
    { file: 'CHANGELOG.md', points: 15 },
    { file: 'CONTRIBUTING.md', points: 10 },
    { file: 'LICENSE', points: 10 },
    { file: 'docs', points: 15, isDir: true },
    { file: '.env.example', points: 10 },
    { file: 'API.md', points: 10, alternatives: ['api-docs', 'swagger.json', 'openapi.yaml', 'openapi.json'] },
  ];

  for (const check of checks) {
    const fp = path.join(dir, check.file);
    if (check.isDir ? fs.existsSync(fp) && fs.statSync(fp).isDirectory() : fs.existsSync(fp)) {
      score += check.points;
    } else if (check.alternatives) {
      if (check.alternatives.some((a) => fs.existsSync(path.join(dir, a)))) {
        score += check.points;
      }
    }
  }

  return { score: Math.min(100, score), detail: `${score}/100` };
}

function scoreGitHealth(dir) {
  let score = 50; // Base if git exists
  const gitDir = path.join(dir, '.git');
  if (!fs.existsSync(gitDir)) return { score: 0, detail: 'No git repository' };

  // Check for .gitignore
  if (fs.existsSync(path.join(dir, '.gitignore'))) score += 15;
  // Check for meaningful commit history (HEAD exists)
  if (fs.existsSync(path.join(gitDir, 'HEAD'))) score += 10;
  // Check for branches (refs/heads has more than just main)
  const refsDir = path.join(gitDir, 'refs', 'heads');
  if (fs.existsSync(refsDir)) {
    try {
      const branches = fs.readdirSync(refsDir);
      if (branches.length > 1) score += 10;
    } catch {
      /* ignore */
    }
  }
  // Check for CI config
  const ciConfigs = ['.github/workflows', '.gitlab-ci.yml', 'Jenkinsfile', '.circleci', '.travis.yml'];
  if (ciConfigs.some((c) => fs.existsSync(path.join(dir, c)))) score += 15;

  return { score: Math.min(100, score), detail: `${Math.min(100, score)}/100` };
}

function scoreOpsReadiness(dir) {
  let score = 0;
  const checks = [
    { pattern: 'Dockerfile', points: 20 },
    { pattern: 'docker-compose.yml', points: 15, alternatives: ['docker-compose.yaml', 'compose.yml', 'compose.yaml'] },
    { pattern: '.env.example', points: 10, alternatives: ['.env.cobolt'] },
    { pattern: 'Makefile', points: 10 },
    { pattern: 'Procfile', points: 10, alternatives: ['fly.toml', 'render.yaml', 'railway.toml'] },
    { pattern: 'health', points: 15 }, // Check if any file contains "health" endpoint
    { pattern: '.github/workflows', points: 20, isDir: true },
  ];

  for (const check of checks) {
    const fp = path.join(dir, check.pattern);
    if (check.isDir ? fs.existsSync(fp) && fs.statSync(fp).isDirectory() : fs.existsSync(fp)) {
      score += check.points;
    } else if (check.alternatives) {
      if (check.alternatives.some((a) => fs.existsSync(path.join(dir, a)))) {
        score += check.points;
      }
    }
  }

  return { score: Math.min(100, score), detail: `${Math.min(100, score)}/100` };
}

// ── Grade / Verdict ─────────────────────────────────────────

function computeGrade(score) {
  if (score >= 95) return 'A+';
  if (score >= 90) return 'A';
  if (score >= 85) return 'A-';
  if (score >= 80) return 'B+';
  if (score >= 75) return 'B';
  if (score >= 70) return 'B-';
  if (score >= 65) return 'C+';
  if (score >= 60) return 'C';
  if (score >= 55) return 'C-';
  if (score >= 50) return 'D';
  if (score >= 40) return 'D-';
  return 'F';
}

function computeVerdict(healthScore, securityScore, depScore) {
  // readinessScore = healthScore*0.4 + issueSeverityScore*0.3 + depRisk*0.2 + archScore*0.1
  const readiness = healthScore * 0.4 + securityScore * 0.3 + depScore * 0.2 + healthScore * 0.1;
  if (readiness >= 70) return { verdict: 'EXTEND', detail: 'Safe to extend existing codebase' };
  if (readiness >= 40) return { verdict: 'MODERNIZE', detail: 'Incremental modernization recommended' };
  return { verdict: 'REBUILD', detail: 'Consider rebuilding from scratch' };
}

// ── Main ────────────────────────────────────────────────────

function computeHealthScore(dir) {
  const od = outputDir(dir);

  // Load scan outputs
  const healthData =
    loadJson(path.join(od, 'brownfield', 'health-scan.json')) || loadJson(path.join(od, 'health-scan.json'));
  const scanData =
    loadJson(path.join(od, 'brownfield', 'security-scan.json')) || loadJson(path.join(od, 'security-scan.json'));
  const sbomData = loadJson(path.join(od, 'brownfield', 'sbom.json')) || loadJson(path.join(od, 'sbom.json'));

  // Compute dimension scores
  const dimensions = {
    codeQuality: scoreCodeQuality(healthData),
    security: scoreSecurity(scanData),
    testCoverage: scoreTestCoverage(healthData),
    architecture: scoreArchitecture(healthData),
    dependencies: scoreDependencies(sbomData, scanData),
    documentation: scoreDocumentation(dir),
    gitHealth: scoreGitHealth(dir),
    opsReadiness: scoreOpsReadiness(dir),
  };

  // Weighted total
  let weightedTotal = 0;
  for (const [key, dim] of Object.entries(dimensions)) {
    weightedTotal += dim.score * WEIGHTS[key];
  }
  const healthScore = Math.round(weightedTotal * 10) / 10;
  const grade = computeGrade(healthScore);

  const verdictResult = computeVerdict(healthScore, dimensions.security.score, dimensions.dependencies.score);

  return {
    healthScore,
    grade,
    verdict: verdictResult.verdict,
    verdictDetail: verdictResult.detail,
    dimensions: Object.fromEntries(Object.entries(dimensions).map(([k, v]) => [k, { ...v, weight: WEIGHTS[k] }])),
    weights: WEIGHTS,
    timestamp: new Date().toISOString(),
    generatedBy: 'cobolt-brownfield-health-score',
    dataAvailability: {
      healthScan: !!healthData,
      securityScan: !!scanData,
      sbom: !!sbomData,
    },
  };
}

// ── CLI ─────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const dirIdx = args.indexOf('--dir');
  const dir = dirIdx !== -1 && args[dirIdx + 1] ? path.resolve(args[dirIdx + 1]) : process.cwd();
  const jsonMode = args.includes('--json');

  switch (cmd) {
    case 'compute': {
      const result = computeHealthScore(dir);

      if (jsonMode) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log('[cobolt-brownfield-health-score] Health Assessment');
        console.log(`  Score: ${result.healthScore}/100 | Grade: ${result.grade} | Verdict: ${result.verdict}`);
        console.log(`  ${result.verdictDetail}`);
        console.log('');
        console.log('  Dimensions:');
        for (const [name, dim] of Object.entries(result.dimensions)) {
          const pct = (dim.weight * 100).toFixed(0);
          console.log(`    ${name.padEnd(15)} ${dim.score.toString().padStart(3)}/100 (${pct}%) — ${dim.detail}`);
        }
      }

      // Write to output
      const outPath = path.join(outputDir(dir), 'brownfield', 'health-score.json');
      const outDir = path.dirname(outPath);
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

      process.exit(result.healthScore >= 50 ? 0 : 1);
      break;
    }
    case 'grade': {
      const result = computeHealthScore(dir);
      console.log(result.grade);
      process.exit(result.healthScore >= 50 ? 0 : 1);
      break;
    }
    case 'verdict': {
      const result = computeHealthScore(dir);
      console.log(result.verdict);
      process.exit(0);
      break;
    }
    default:
      console.log('CoBolt Brownfield Health Score — Deterministic health computation');
      console.log('');
      console.log('Usage:');
      console.log('  node tools/cobolt-brownfield-health-score.js compute [--dir <path>] [--json]');
      console.log('  node tools/cobolt-brownfield-health-score.js grade');
      console.log('  node tools/cobolt-brownfield-health-score.js verdict');
      console.log('');
      console.log('Weights: Security 20%, Code Quality 18%, Test Coverage 15%,');
      console.log('         Architecture 15%, Dependencies 10%, Documentation 10%,');
      console.log('         Git Health 7%, Ops Readiness 5%');
      process.exit(cmd ? 2 : 0);
  }
}

module.exports = { computeHealthScore };
