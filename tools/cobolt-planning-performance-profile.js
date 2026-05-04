#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const {
  ARTIFACTS,
  SCHEMA_VERSION,
  artifactPath,
  evidenceLink,
  finding,
  parseArgs,
  printJsonOrHuman,
  readJson,
  resolvePlanningDir,
  resolveProjectRoot,
  toPosix,
  writeJson,
} = require('../lib/cobolt-planning-vnext');

const TOOL_ID = 'cobolt-planning-performance-profile';
const DEFAULT_TOTAL_BUDGET_BYTES = 25 * 1024 * 1024;
const DEFAULT_ARTIFACT_BUDGET_BYTES = 5 * 1024 * 1024;

function listFiles(rootDir) {
  const out = [];
  function walk(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) out.push(fullPath);
    }
  }
  walk(rootDir);
  return out.sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

function generatedAtFromJson(filePath) {
  const parsed = readJson(filePath, null);
  return parsed?.generatedAt || parsed?.updatedAt || parsed?.summary?.generatedAt || null;
}

function buildPlanningPerformanceProfile(options = {}) {
  const projectRoot = resolveProjectRoot(options);
  const planningDir = resolvePlanningDir(projectRoot, { create: options.write !== false });
  const totalBudgetBytes = Number(
    options.totalBudgetBytes || process.env.COBOLT_PLAN_PROFILE_TOTAL_BUDGET_BYTES || DEFAULT_TOTAL_BUDGET_BYTES,
  );
  const artifactBudgetBytes = Number(
    options.artifactBudgetBytes ||
      process.env.COBOLT_PLAN_PROFILE_ARTIFACT_BUDGET_BYTES ||
      DEFAULT_ARTIFACT_BUDGET_BYTES,
  );
  const files = listFiles(planningDir);
  const findings = [];

  const artifacts = files.map((filePath) => {
    const stat = fs.statSync(filePath);
    const relPath = toPosix(path.relative(projectRoot, filePath));
    if (stat.size > artifactBudgetBytes) {
      findings.push(
        finding(`PERF-ARTIFACT-BUDGET:${relPath}`, 'advisory', `${relPath} exceeds the per-artifact planning budget`, {
          path: relPath,
          bytes: stat.size,
          budgetBytes: artifactBudgetBytes,
        }),
      );
    }
    return {
      path: relPath,
      bytes: stat.size,
      mtime: stat.mtime.toISOString(),
      generatedAt: generatedAtFromJson(filePath),
      sha256: evidenceLink(projectRoot, relPath, filePath).sha256,
    };
  });

  const totalBytes = artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0);
  if (totalBytes > totalBudgetBytes) {
    findings.push(
      finding(
        'PERF-TOTAL-BUDGET',
        options.strict ? 'critical' : 'advisory',
        'planning artifact bytes exceed total planning budget',
        {
          totalBytes,
          budgetBytes: totalBudgetBytes,
        },
      ),
    );
  }

  const sourceLedger = readJson(path.join(planningDir, ARTIFACTS.sourceLedger), null);
  const manifest = readJson(path.join(planningDir, 'planning-manifest.json'), null);
  const changedInputs = (sourceLedger?.inputs || []).filter((input) => input.present === false || !input.sha256);
  const cacheableArtifacts = artifacts
    .filter((artifact) => artifact.sha256 && !artifact.path.endsWith(ARTIFACTS.performanceProfile))
    .map((artifact) => ({ path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes }));

  const report = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    generatedBy: TOOL_ID,
    projectRoot,
    planningDir,
    budgets: {
      totalBudgetBytes,
      artifactBudgetBytes,
    },
    summary: {
      status: findings.some((item) => item.severity === 'critical') ? 'blocked' : findings.length ? 'advisory' : 'pass',
      artifactCount: artifacts.length,
      totalBytes,
      largestArtifactBytes: artifacts.reduce((max, artifact) => Math.max(max, artifact.bytes), 0),
      cacheableArtifactCount: cacheableArtifacts.length,
      changedInputCount: changedInputs.length,
    },
    incremental: {
      sourceLedgerPresent: Boolean(sourceLedger),
      manifestPresent: Boolean(manifest),
      inputHashes: (sourceLedger?.inputs || []).map((input) => ({
        path: input.path,
        sha256: input.sha256 || null,
        present: input.present === true,
      })),
      changedInputs,
      cacheableArtifacts,
      invalidationReasons: changedInputs.map((input) => `input:${input.path}`),
    },
    artifacts,
    findings,
  };

  if (options.write !== false)
    writeJson(artifactPath(projectRoot, ARTIFACTS.performanceProfile, { planningDir }), report);
  return report;
}

function checkPlanningPerformanceProfile(options = {}) {
  const report = buildPlanningPerformanceProfile(options);
  return {
    ...report,
    passed: options.strict ? !report.findings.length : !report.findings.some((item) => item.severity === 'critical'),
  };
}

function render(report) {
  return `planning-performance-profile: ${report.summary.status}; artifacts=${report.summary.artifactCount} bytes=${report.summary.totalBytes}`;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === 'help') {
    process.stdout.write(
      'usage: cobolt-planning-performance-profile generate|check [--project <dir>] [--json] [--strict]\n',
    );
    return 0;
  }
  const report =
    options.command === 'check' ? checkPlanningPerformanceProfile(options) : buildPlanningPerformanceProfile(options);
  printJsonOrHuman(report, options.json, render);
  if (options.command === 'check' && report.passed === false) return 1;
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = {
  TOOL_ID,
  buildPlanningPerformanceProfile,
  checkPlanningPerformanceProfile,
  main,
};
