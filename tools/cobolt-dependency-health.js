#!/usr/bin/env node

// CoBolt Dependency Health Scorer — deterministic dependency risk analysis
//
// Evaluates dependency health beyond CVE scanning:
// - Typosquat risk (Levenshtein distance from popular packages)
// - Wildcard/unpinned version detection
// - Non-registry source detection (git/URL deps)
// - License compliance (copyleft, unknown)
// - Staleness detection (severely outdated)
//
// Parses: package-lock.json, mix.lock, requirements.txt
//
// Usage:
//   node tools/cobolt-dependency-health.js check [--json] [--save]
//   node tools/cobolt-dependency-health.js check --cwd <project> --json
//   node tools/cobolt-dependency-health.js check --threshold B --fail-on-high
//
// Exit codes:
//   0 = health grade meets threshold and no configured hard-fail condition exists
//   1 = health grade below threshold or a hard-fail condition exists

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

// ── Popular Package Names (typosquat detection baseline) ──

const POPULAR_NPM_PACKAGES = new Set([
  'express',
  'react',
  'lodash',
  'axios',
  'webpack',
  'typescript',
  'jest',
  'moment',
  'chalk',
  'commander',
  'inquirer',
  'dotenv',
  'cors',
  'body-parser',
  'uuid',
  'debug',
  'yargs',
  'glob',
  'rimraf',
  'semver',
  'cheerio',
  'bcrypt',
  'jsonwebtoken',
  'mongoose',
  'sequelize',
  'prisma',
  'knex',
  'next',
  'nuxt',
  'vue',
  'angular',
  'svelte',
  'fastify',
  'koa',
  'hapi',
]);

const KNOWN_TYPOSQUAT_FALSE_POSITIVES = new Map([
  [
    'dargs',
    'Legitimate CLI argument serializer used by git-raw-commits; lockfile pins registry tarball and integrity.',
  ],
]);

// ── Levenshtein Distance ──────────────────────────────────

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// ── Lock File Parsers ─────────────────────────────────────

function parseNpmLock(projectDir) {
  const lockPath = path.join(projectDir, 'package-lock.json');
  if (!fs.existsSync(lockPath)) return null;

  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const deps = [];
    const packages = lock.packages || {};

    for (const [pkgPath, info] of Object.entries(packages)) {
      if (!pkgPath || pkgPath === '') continue;
      const name = pkgPath.replace(/^node_modules\//, '');
      if (name.includes('node_modules/')) continue;
      deps.push({
        name,
        version: info.version || 'unknown',
        resolved: info.resolved || '',
        dev: !!info.dev,
        license: info.license || 'unknown',
      });
    }
    return { ecosystem: 'npm', deps };
  } catch {
    return null;
  }
}

function parseMixLock(projectDir) {
  const candidates = [path.join(projectDir, 'mix.lock'), path.join(projectDir, 'app', 'mix.lock')];
  for (const lockPath of candidates) {
    if (!fs.existsSync(lockPath)) continue;
    try {
      const content = fs.readFileSync(lockPath, 'utf8');
      const deps = [];
      const re = /"(\w+)":\s*\{:hex,\s*:(\w+),\s*"([^"]+)"/g;
      let match;
      while ((match = re.exec(content)) !== null) {
        deps.push({ name: match[2], version: match[3], ecosystem: 'hex' });
      }
      return { ecosystem: 'hex', deps };
    } catch {}
  }
  return null;
}

function parseRequirements(projectDir) {
  const reqPath = path.join(projectDir, 'requirements.txt');
  if (!fs.existsSync(reqPath)) return null;
  try {
    const content = fs.readFileSync(reqPath, 'utf8');
    const deps = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
      const match = trimmed.match(/^([a-zA-Z0-9_-]+)\s*([><=!~]+\s*[\d.]+)?/);
      if (match) deps.push({ name: match[1], version: (match[2] || 'any').trim() });
    }
    return { ecosystem: 'pip', deps };
  } catch {
    return null;
  }
}

// ── Health Checks ─────────────────────────────────────────

function checkTyposquatRisk(deps) {
  const findings = [];
  for (const dep of deps) {
    const name = dep.name.toLowerCase();
    if (KNOWN_TYPOSQUAT_FALSE_POSITIVES.has(name)) continue;
    for (const popular of POPULAR_NPM_PACKAGES) {
      if (name === popular) continue;
      const dist = levenshtein(name, popular);
      if (dist === 1 && name.length > 3) {
        // Exclude legitimate suffixed variants: "chalk5", "uuid4", "cors2"
        // These are popular + digit, not typosquats
        if (/\d+$/.test(name) && name.replace(/\d+$/, '') === popular) continue;
        // Exclude scoped packages that resolve to the popular one: "@scope/express"
        if (name.includes('/')) continue;
        // Exclude common prefix/suffix patterns: "my-express", "express-js"
        if (name.startsWith(`${popular}-`) || name.endsWith(`-${popular}`)) continue;

        findings.push({
          id: `DEP-TYPO-${String(findings.length + 1).padStart(3, '0')}`,
          type: 'typosquat-risk',
          severity: 'high',
          package: dep.name,
          version: dep.version,
          message: `Package "${dep.name}" is 1 edit away from popular "${popular}" — possible typosquat`,
          suggestion: `Verify this is the intended package and not a typosquat of "${popular}".`,
        });
      }
    }
  }
  return findings;
}

function checkNpmMetadata(projectDir) {
  const findings = [];
  const pkgPath = path.join(projectDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return findings;

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

  for (const [name, version] of Object.entries(allDeps)) {
    if (version === '*' || version === 'latest') {
      findings.push({
        id: `DEP-WILD-${String(findings.length + 1).padStart(3, '0')}`,
        type: 'wildcard-version',
        severity: 'high',
        package: name,
        version,
        message: `Package "${name}" uses wildcard version "${version}" — unpinned dependency`,
        suggestion: 'Pin to a specific semver range (^x.y.z or ~x.y.z).',
      });
    }

    if (version.includes('git') || version.includes('http') || version.includes('file:')) {
      findings.push({
        id: `DEP-GIT-${String(findings.length + 1).padStart(3, '0')}`,
        type: 'non-registry-source',
        severity: 'medium',
        package: name,
        version,
        message: `Package "${name}" installed from non-registry source`,
        suggestion: 'Prefer registry packages for supply chain security.',
      });
    }
  }

  // Staleness check via npm outdated (uses execFileSync — safe, no string interpolation)
  try {
    execFileSync('npm', ['outdated', '--json'], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    // npm outdated exits non-zero when outdated packages exist — parse stdout
    try {
      const outdated = JSON.parse(err.stdout || '{}');
      for (const [depName, info] of Object.entries(outdated)) {
        const currentMajor = parseInt((info.current || '0').split('.')[0], 10);
        const latestMajor = parseInt((info.latest || '0').split('.')[0], 10);
        if (latestMajor - currentMajor >= 2) {
          findings.push({
            id: `DEP-STALE-${String(findings.length + 1).padStart(3, '0')}`,
            type: 'severely-outdated',
            severity: 'medium',
            package: depName,
            version: info.current,
            latest: info.latest,
            message: `Package "${depName}" is ${latestMajor - currentMajor} major versions behind (${info.current} -> ${info.latest})`,
            suggestion: 'Update to latest major version or document why it is pinned.',
          });
        }
      }
    } catch {
      /* best-effort staleness check */
    }
  }

  return findings;
}

function checkLicenseRisk(deps) {
  const findings = [];
  const riskyLicenses = new Set(['GPL-3.0', 'AGPL-3.0', 'GPL-2.0', 'SSPL-1.0', 'EUPL-1.2']);
  const unknownLicenses = new Set(['unknown', 'UNLICENSED', '']);

  for (const dep of deps) {
    if (!dep.license) continue;
    if (riskyLicenses.has(dep.license)) {
      findings.push({
        id: `DEP-LIC-${String(findings.length + 1).padStart(3, '0')}`,
        type: 'copyleft-license',
        severity: 'medium',
        package: dep.name,
        license: dep.license,
        message: `Package "${dep.name}" uses copyleft license "${dep.license}"`,
        suggestion: 'Verify this is compatible with your project license.',
      });
    }
    if (unknownLicenses.has(dep.license)) {
      findings.push({
        id: `DEP-LIC-${String(findings.length + 1).padStart(3, '0')}`,
        type: 'unknown-license',
        severity: 'low',
        package: dep.name,
        license: dep.license || 'none',
        message: `Package "${dep.name}" has unknown or missing license`,
        suggestion: 'Check the package source for license information.',
      });
    }
  }
  return findings;
}

// ── Main ──────────────────────────────────────────────────

function check(projectDir, _options = {}) {
  const ecosystems = [];
  const allFindings = [];

  const npmData = parseNpmLock(projectDir);
  if (npmData) {
    ecosystems.push(npmData);
    allFindings.push(...checkTyposquatRisk(npmData.deps));
    allFindings.push(...checkLicenseRisk(npmData.deps));
  }

  const mixData = parseMixLock(projectDir);
  if (mixData) ecosystems.push(mixData);

  const pipData = parseRequirements(projectDir);
  if (pipData) ecosystems.push(pipData);

  allFindings.push(...checkNpmMetadata(projectDir));

  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const f of allFindings) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;

  const byType = {};
  for (const f of allFindings) byType[f.type] = (byType[f.type] || 0) + 1;

  const totalDeps = ecosystems.reduce((s, e) => s + e.deps.length, 0);
  const penalties = { high: 18, medium: 8, low: 2 };
  const totalPenalty = allFindings.reduce((s, f) => s + (penalties[f.severity] || 0), 0);
  const score = Math.max(0, 100 - totalPenalty);
  const grade =
    score >= 95
      ? 'A'
      : score >= 90
        ? 'A-'
        : score >= 85
          ? 'B+'
          : score >= 80
            ? 'B'
            : score >= 75
              ? 'B-'
              : score >= 70
                ? 'C'
                : score >= 60
                  ? 'D'
                  : 'F';

  return {
    findings: allFindings,
    summary: {
      totalDependencies: totalDeps,
      ecosystems: ecosystems.map((e) => ({ ecosystem: e.ecosystem, count: e.deps.length })),
      total: allFindings.length,
      bySeverity,
      byType,
    },
    score,
    grade,
    verdict: score >= 80 ? 'PASS' : score >= 65 ? 'WATCH' : 'FAIL',
    timestamp: new Date().toISOString(),
  };
}

function writeReport(projectDir, result) {
  const _p = typeof _paths === 'function' ? _paths(projectDir) : null;
  const outDir = _p ? _p.review() : path.join(projectDir, '_cobolt-output/latest/review');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const dest = path.join(outDir, 'dependency-health-report.json');
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, dest);
  return dest;
}

module.exports = { check, writeReport, levenshtein, parseNpmLock, parseMixLock };

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === 'check') {
    const options = {};
    let projectDir = process.cwd();
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--json') options.json = true;
      else if (args[i] === '--save') options.save = true;
      else if (args[i] === '--fail-on-high') options.failOnHigh = true;
      else if (args[i] === '--threshold' && args[i + 1]) options.threshold = args[++i];
      else if (args[i] === '--cwd' && args[i + 1]) projectDir = path.resolve(args[++i]);
    }

    const result = check(projectDir, options);

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\n  CoBolt Dependency Health — ${result.summary.totalDependencies} dependencies`);
      console.log('  ══════════════════════════════════════════════');
      for (const eco of result.summary.ecosystems) console.log(`  ${eco.ecosystem}: ${eco.count} packages`);
      console.log(
        `  Findings: ${result.summary.total} (high: ${result.summary.bySeverity.high || 0}, medium: ${result.summary.bySeverity.medium || 0}, low: ${result.summary.bySeverity.low || 0})`,
      );
      console.log(`  Grade: ${result.grade} (${result.score}%) — ${result.verdict}`);
      console.log('  ══════════════════════════════════════════════');
      for (const f of result.findings.slice(0, 20)) {
        const icon = f.severity === 'high' ? '\u2717' : f.severity === 'medium' ? '\u26A0' : '\u2022';
        console.log(`  ${icon} [${f.type}] ${f.package}@${f.version || '?'} — ${f.message}`);
      }
    }

    if (options.save) {
      const dest = writeReport(projectDir, result);
      if (!options.json) console.log(`\n  Report saved: ${dest}`);
    }

    const gradeOrder = ['A', 'A-', 'B+', 'B', 'B-', 'C', 'D', 'F'];
    if (options.failOnHigh && (result.summary.bySeverity.high || 0) > 0) {
      process.exit(1);
    }
    if (options.threshold) {
      const thresholdIdx = gradeOrder.indexOf(options.threshold);
      const actualIdx = gradeOrder.indexOf(result.grade);
      process.exit(actualIdx <= thresholdIdx ? 0 : 1);
    }
    process.exit(result.verdict === 'FAIL' ? 1 : 0);
  }

  console.log('  CoBolt Dependency Health');
  console.log(
    '  Usage: node tools/cobolt-dependency-health.js check [--cwd <project>] [--json] [--save] [--threshold B] [--fail-on-high]',
  );
}
