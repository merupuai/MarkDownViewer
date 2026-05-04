#!/usr/bin/env node

// CoBolt Planning Artifact Path Audit
//
// Detects a common planning failure mode: an agent creates the right artifact
// name in the wrong output directory, leaving the canonical planning packet
// incomplete and forcing a do-over.

const fs = require('node:fs');
const path = require('node:path');

const { resolveReadablePlanningDir } = require('../lib/cobolt-planning-artifacts');

function loadDependencies(projectRoot) {
  const candidates = [
    path.join(projectRoot, 'source', 'schemas', 'artifact-dependencies.json'),
    path.resolve(__dirname, '../source/schemas/artifact-dependencies.json'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, 'utf8'));
    } catch {
      /* try next */
    }
  }

  return null;
}

function normalizeRelative(value) {
  return String(value || '').replaceAll('\\', '/');
}

function isInside(candidate, base) {
  const relative = path.relative(path.resolve(base), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function statFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return {
      path: filePath,
      size: stat.size,
    };
  } catch {
    return null;
  }
}

function listStaticPlanningArtifacts(deps) {
  return Object.entries(deps?.artifacts || {})
    .filter(([, artifact]) => {
      const artifactPath = normalizeRelative(artifact.path);
      return artifact.category === 'planning' && artifactPath.startsWith('_cobolt-output/latest/planning/');
    })
    .map(([id, artifact]) => {
      const artifactPath = normalizeRelative(artifact.path);
      return {
        id,
        description: artifact.description || id,
        relativePath: artifactPath.slice('_cobolt-output/latest/planning/'.length),
        minBytes: Number.isFinite(Number(artifact.minBytes)) ? Number(artifact.minBytes) : 1,
        optional: artifact.optional === true || artifact.critical === false,
      };
    })
    .filter((artifact) => artifact.relativePath && !artifact.relativePath.includes('*'));
}

function walkFiles(root, options = {}) {
  const results = [];
  const maxFiles = options.maxFiles || 5000;
  const skipDirNames = new Set(['node_modules', '.git', '_versions', 'runs']);
  const skipResolved = new Set((options.skipDirs || []).map((dir) => path.resolve(dir).toLowerCase()));

  function visit(dir) {
    if (results.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirNames.has(entry.name)) continue;
        const resolved = path.resolve(fullPath).toLowerCase();
        if (skipResolved.has(resolved)) continue;
        visit(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
      if (results.length >= maxFiles) return;
    }
  }

  if (fs.existsSync(root)) visit(root);
  return results;
}

function findMisplacedCandidates(projectRoot, planningDir, artifact) {
  const outputRoot = path.join(projectRoot, '_cobolt-output');
  const expectedPath = path.join(planningDir, artifact.relativePath.replaceAll('/', path.sep));
  const expectedBase = path.basename(artifact.relativePath);
  const expectedStat = statFile(expectedPath);
  const expectedOk = Boolean(expectedStat && expectedStat.size >= artifact.minBytes);

  if (expectedOk) return [];

  const files = walkFiles(outputRoot, { skipDirs: [planningDir] });
  return files
    .filter((candidate) => path.basename(candidate) === expectedBase)
    .filter((candidate) => path.resolve(candidate) !== path.resolve(expectedPath))
    .filter((candidate) => !isInside(candidate, planningDir))
    .map((candidate) => statFile(candidate))
    .filter(Boolean)
    .filter((candidate) => candidate.size >= artifact.minBytes)
    .map((candidate) => ({
      path: path.relative(projectRoot, candidate.path).replaceAll('\\', '/'),
      size: candidate.size,
    }));
}

function auditPlanningArtifacts(projectRoot = process.cwd()) {
  const root = path.resolve(projectRoot);
  const deps = loadDependencies(root);
  const planningDir = resolveReadablePlanningDir(root, { allowLatestFallback: true });
  const artifacts = listStaticPlanningArtifacts(deps);
  const misplaced = [];
  const missingCanonical = [];

  if (!deps) {
    return {
      passed: false,
      projectRoot: root,
      canonicalPlanningDir: planningDir,
      checked: 0,
      misplaced,
      missingCanonical,
      message: 'artifact-dependencies.json could not be loaded',
    };
  }

  if (!planningDir) {
    return {
      passed: false,
      projectRoot: root,
      canonicalPlanningDir: null,
      checked: artifacts.length,
      misplaced,
      missingCanonical,
      message: 'canonical planning directory could not be resolved',
    };
  }

  for (const artifact of artifacts) {
    const expectedPath = path.join(planningDir, artifact.relativePath.replaceAll('/', path.sep));
    const expectedStat = statFile(expectedPath);
    const exists = Boolean(expectedStat);
    const size = expectedStat?.size || 0;
    const canonicalOk = exists && size >= artifact.minBytes;

    if (!canonicalOk && !artifact.optional) {
      missingCanonical.push({
        artifactId: artifact.id,
        expectedPath: path.relative(root, expectedPath).replaceAll('\\', '/'),
        exists,
        size,
        minBytes: artifact.minBytes,
      });
    }

    const found = findMisplacedCandidates(root, planningDir, artifact);
    if (found.length > 0) {
      misplaced.push({
        artifactId: artifact.id,
        expectedPath: path.relative(root, expectedPath).replaceAll('\\', '/'),
        expectedSize: size,
        minBytes: artifact.minBytes,
        found,
      });
    }
  }

  const passed = misplaced.length === 0;
  return {
    passed,
    projectRoot: root,
    canonicalPlanningDir: path.relative(root, planningDir).replaceAll('\\', '/'),
    checked: artifacts.length,
    misplaced,
    missingCanonical,
    message: passed
      ? `Planning artifact path audit passed (${artifacts.length} static planning artifacts checked).`
      : `Planning artifact path audit failed: ${misplaced.length} misplaced artifact(s) found.`,
  };
}

function printText(result) {
  console.log(result.message);
  if (result.canonicalPlanningDir) console.log(`Canonical planning dir: ${result.canonicalPlanningDir}`);
  if (result.misplaced.length > 0) {
    console.log('\nMisplaced artifacts:');
    for (const item of result.misplaced) {
      console.log(`- ${item.artifactId}: expected ${item.expectedPath}`);
      for (const found of item.found) {
        console.log(`  found ${found.path} (${found.size}B)`);
      }
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0] && !args[0].startsWith('--') ? args[0] : 'audit';
  const json = args.includes('--json');
  const projectIdx = args.indexOf('--project');
  const projectRoot = projectIdx >= 0 ? args[projectIdx + 1] : process.cwd();

  if (!['audit', 'check'].includes(command)) {
    console.error('Usage: node tools/cobolt-planning-artifact-audit.js [audit|check] [--json] [--project <dir>]');
    process.exit(2);
  }

  const result = auditPlanningArtifacts(projectRoot);
  if (json) console.log(JSON.stringify(result, null, 2));
  else printText(result);
  process.exit(result.passed ? 0 : 1);
}

if (require.main === module) main();

module.exports = {
  auditPlanningArtifacts,
  listStaticPlanningArtifacts,
  findMisplacedCandidates,
};
