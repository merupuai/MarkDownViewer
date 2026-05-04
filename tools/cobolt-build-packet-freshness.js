#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { buildPlanIngestionManifest } = require('./cobolt-plan-ingestion-manifest');

const VOLATILE_SOURCE_PATHS = new Set([
  '_cobolt-output/latest/planning/frontend-completeness-report.json',
  '_cobolt-output/latest/planning/rtm.json',
]);

function isVolatileSourcePath(filePath) {
  return VOLATILE_SOURCE_PATHS.has(toPosix(filePath));
}

function normalizeMilestone(value) {
  const match = String(value || '')
    .trim()
    .match(/^M?(\d+)$/i);
  return match ? `M${Number.parseInt(match[1], 10)}` : null;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, ''));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/');
}

function relativePath(projectRoot, filePath) {
  return toPosix(path.relative(projectRoot, filePath));
}

function sha256File(filePath) {
  try {
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
  } catch {
    return null;
  }
}

function buildDir(projectRoot, milestone) {
  return path.join(projectRoot, '_cobolt-output', 'latest', 'build', milestone);
}

function defaultSnapshotPath(projectRoot, milestone) {
  return path.join(buildDir(projectRoot, milestone), `${milestone}-build-packet-sources.json`);
}

function defaultPlanIngestionPath(projectRoot, milestone) {
  return path.join(buildDir(projectRoot, milestone), `${milestone}-plan-ingestion-manifest.json`);
}

function defaultBuildPacketPath(projectRoot, milestone) {
  return path.join(buildDir(projectRoot, milestone), `${milestone}-build-packet.md`);
}

function collectSources(projectRoot, manifest) {
  const root = path.resolve(projectRoot);
  const byPath = new Map();

  for (const artifact of manifest?.artifacts || []) {
    for (const resolvedFile of artifact.resolvedFiles || []) {
      const relative = toPosix(resolvedFile.path);
      if (isVolatileSourcePath(relative)) continue;
      if (!relative) continue;
      const absolute = path.join(root, relative.replaceAll('/', path.sep));
      const stat = fs.existsSync(absolute) ? fs.statSync(absolute) : null;
      const entry = byPath.get(relative) || {
        path: relative,
        artifactIds: [],
        buildConsumers: [],
        gateTiers: [],
        exists: false,
        size: 0,
        updatedAt: null,
        sha256: null,
      };
      if (!entry.artifactIds.includes(artifact.artifactId)) entry.artifactIds.push(artifact.artifactId);
      for (const consumer of artifact.buildConsumers || []) {
        if (!entry.buildConsumers.includes(consumer)) entry.buildConsumers.push(consumer);
      }
      if (artifact.gateTier && !entry.gateTiers.includes(artifact.gateTier)) entry.gateTiers.push(artifact.gateTier);
      entry.exists = Boolean(stat?.isFile());
      entry.size = stat?.size || 0;
      entry.updatedAt = stat?.mtime?.toISOString?.() || null;
      entry.sha256 = entry.exists ? sha256File(absolute) : null;
      byPath.set(relative, entry);
    }
  }

  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }));
}

function computeDigest(sources) {
  const canonical = (sources || [])
    .map((entry) => `${entry.path}:${entry.sha256 || 'missing'}`)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .join('\n');
  return `sha256:${crypto.createHash('sha256').update(canonical).digest('hex')}`;
}

function buildFreshnessSnapshot(projectRoot = process.cwd(), options = {}) {
  const root = path.resolve(projectRoot);
  const milestone = normalizeMilestone(options.milestone) || 'M1';
  const planIngestionPath = options.planIngestionPath || defaultPlanIngestionPath(root, milestone);
  const manifest =
    options.planIngestion || readJson(planIngestionPath, null) || buildPlanIngestionManifest(root, { milestone });
  const sources = collectSources(root, manifest);

  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-build-packet-freshness',
    milestone,
    passed: manifest?.passed !== false,
    issues: Array.isArray(manifest?.issues) ? manifest.issues : [],
    planIngestionPath: fs.existsSync(planIngestionPath) ? relativePath(root, planIngestionPath) : null,
    buildPacketPath: relativePath(root, defaultBuildPacketPath(root, milestone)),
    trackedSources: sources.length,
    sourceDigest: computeDigest(sources),
    sources,
  };
}

function writeBuildPacketFreshnessSnapshot(projectRoot = process.cwd(), options = {}) {
  const root = path.resolve(projectRoot);
  const milestone = normalizeMilestone(options.milestone) || 'M1';
  const snapshot = buildFreshnessSnapshot(root, options);
  const outputPath = options.outputPath || defaultSnapshotPath(root, milestone);
  writeJson(outputPath, snapshot);
  return { snapshot, outputPath };
}

function summarizeDrift(previousSources, currentSources) {
  const previous = new Map(
    (previousSources || []).filter((entry) => !isVolatileSourcePath(entry?.path)).map((entry) => [entry.path, entry]),
  );
  const current = new Map(
    (currentSources || []).filter((entry) => !isVolatileSourcePath(entry?.path)).map((entry) => [entry.path, entry]),
  );
  const changedSources = [];
  const removedSources = [];
  const addedSources = [];

  for (const [filePath, previousEntry] of previous.entries()) {
    const currentEntry = current.get(filePath);
    if (!currentEntry) {
      removedSources.push({
        path: filePath,
        previousSha256: previousEntry.sha256 || null,
      });
      continue;
    }
    if ((previousEntry.sha256 || null) !== (currentEntry.sha256 || null)) {
      changedSources.push({
        path: filePath,
        previousSha256: previousEntry.sha256 || null,
        currentSha256: currentEntry.sha256 || null,
      });
    }
  }

  for (const [filePath, currentEntry] of current.entries()) {
    if (previous.has(filePath)) continue;
    addedSources.push({
      path: filePath,
      currentSha256: currentEntry.sha256 || null,
    });
  }

  return { changedSources, removedSources, addedSources };
}

function checkBuildPacketFreshness(projectRoot = process.cwd(), options = {}) {
  const root = path.resolve(projectRoot);
  const milestone = normalizeMilestone(options.milestone) || 'M1';
  const snapshotPath = options.snapshotPath || defaultSnapshotPath(root, milestone);
  const buildPacketPath = defaultBuildPacketPath(root, milestone);
  const buildPacketExists = fs.existsSync(buildPacketPath);

  if (!fs.existsSync(snapshotPath)) {
    return {
      version: '1.0.0',
      checkedAt: new Date().toISOString(),
      generatedBy: 'cobolt-build-packet-freshness',
      milestone,
      status: buildPacketExists ? 'fail' : 'not_applicable',
      passed: buildPacketExists !== true,
      snapshotPath: buildPacketExists ? relativePath(root, snapshotPath) : null,
      buildPacketPath: relativePath(root, buildPacketPath),
      reason: buildPacketExists ? 'build-packet-source-snapshot-missing' : 'build-packet-not-generated',
      trackedSources: 0,
      currentTrackedSources: 0,
      snapshotDigest: null,
      currentDigest: null,
      changedSources: [],
      removedSources: [],
      addedSources: [],
      manifestIssues: [],
    };
  }

  const snapshot = readJson(snapshotPath, { sources: [] });
  const currentSnapshot = buildFreshnessSnapshot(root, { milestone });
  const drift = summarizeDrift(snapshot.sources || [], currentSnapshot.sources || []);
  const manifestIssues = currentSnapshot.passed === false ? currentSnapshot.issues || [] : [];
  const passed =
    manifestIssues.length === 0 &&
    drift.changedSources.length === 0 &&
    drift.removedSources.length === 0 &&
    drift.addedSources.length === 0;

  return {
    version: '1.0.0',
    checkedAt: new Date().toISOString(),
    generatedBy: 'cobolt-build-packet-freshness',
    milestone,
    status: passed ? 'pass' : 'fail',
    passed,
    snapshotPath: relativePath(root, snapshotPath),
    buildPacketPath: relativePath(root, buildPacketPath),
    reason: passed ? 'fresh' : 'stale-plan-artifacts',
    trackedSources: Array.isArray(snapshot.sources) ? snapshot.sources.length : 0,
    currentTrackedSources: Array.isArray(currentSnapshot.sources) ? currentSnapshot.sources.length : 0,
    snapshotDigest: snapshot.sourceDigest || null,
    currentDigest: currentSnapshot.sourceDigest || null,
    changedSources: drift.changedSources,
    removedSources: drift.removedSources,
    addedSources: drift.addedSources,
    manifestIssues,
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    command: argv[0] || 'check',
    json: false,
    milestone: null,
    outputPath: null,
    projectRoot: process.cwd(),
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') args.json = true;
    else if (arg === '--milestone') args.milestone = argv[++index] || null;
    else if (arg === '--output') args.outputPath = argv[++index] || null;
    else if (arg === '--project') args.projectRoot = path.resolve(argv[++index] || args.projectRoot);
  }
  return args;
}

function main() {
  const args = parseArgs();
  if (!['snapshot', 'check'].includes(args.command)) {
    console.log(
      'Usage: node tools/cobolt-build-packet-freshness.js snapshot|check [--milestone M1] [--project <dir>] [--output <path>] [--json]',
    );
    process.exit(args.command ? 2 : 0);
  }

  const result =
    args.command === 'snapshot'
      ? writeBuildPacketFreshnessSnapshot(args.projectRoot, {
          milestone: args.milestone,
          outputPath: args.outputPath,
        }).snapshot
      : checkBuildPacketFreshness(args.projectRoot, {
          milestone: args.milestone,
          snapshotPath: args.outputPath,
        });

  if (args.json || args.command === 'check') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `[cobolt-build-packet-freshness] tracked=${result.trackedSources} digest=${result.sourceDigest || result.currentDigest || 'n/a'}`,
    );
  }
  process.exit(result.passed ? 0 : 1);
}

if (require.main === module) main();

module.exports = {
  buildFreshnessSnapshot,
  checkBuildPacketFreshness,
  collectSources,
  computeDigest,
  writeBuildPacketFreshnessSnapshot,
};
