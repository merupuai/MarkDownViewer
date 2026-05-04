#!/usr/bin/env node

// CoBolt Runtime Contract - verifies generated runtime manifests match planning docs.

const fs = require('node:fs');
const path = require('node:path');

const PLANNING_FILES = [
  'prd.md',
  'feature-prd.md',
  'trd.md',
  'architecture.md',
  'system-architecture.md',
  'master-plan.md',
  'milestones.md',
];

const RUNTIME_PATTERNS = {
  elixir: /\bElixir\b[^\n\r|,;)]{0,40}?(?:>=|~>|=|:)?\s*v?(\d+(?:\.\d+){0,2})\s*\+?/gi,
  node: /\bNode(?:\.js)?\b[^\n\r|,;)]{0,40}?(?:>=|~>|=|:)?\s*v?(\d+(?:\.\d+){0,2})\s*\+?/gi,
};

function normalizeVersion(value) {
  const match = String(value || '').match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return [match[1], match[2] || '0', match[3] || '0'].map((part) => Number.parseInt(part, 10));
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index++) {
    if ((left[index] || 0) > (right[index] || 0)) return 1;
    if ((left[index] || 0) < (right[index] || 0)) return -1;
  }
  return 0;
}

function formatVersion(version) {
  return Array.isArray(version) ? version.join('.') : String(version || '');
}

function collectPlanningText(projectRoot) {
  const planningDir = path.join(projectRoot, '_cobolt-output', 'latest', 'planning');
  if (!fs.existsSync(planningDir)) return { planningDir, text: '', files: [] };

  const files = [];
  const chunks = [];
  for (const file of PLANNING_FILES) {
    const filePath = path.join(planningDir, file);
    if (!fs.existsSync(filePath)) continue;
    files.push(filePath);
    chunks.push(fs.readFileSync(filePath, 'utf8'));
  }

  return { planningDir, text: chunks.join('\n\n'), files };
}

function extractPlannedRuntimeMinimums(text) {
  const requirements = {};
  for (const [runtime, pattern] of Object.entries(RUNTIME_PATTERNS)) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const version = normalizeVersion(match[1]);
      if (!version) continue;
      if (!requirements[runtime] || compareVersions(version, requirements[runtime].minimum) > 0) {
        requirements[runtime] = {
          runtime,
          minimum: version,
          evidence: match[0].trim(),
        };
      }
    }
  }
  return requirements;
}

function extractElixirManifest(projectRoot) {
  const mixPath = path.join(projectRoot, 'mix.exs');
  if (!fs.existsSync(mixPath)) return null;
  const content = fs.readFileSync(mixPath, 'utf8');
  const match = content.match(/elixir:\s*["']([^"']+)["']/);
  const minimum = normalizeVersion(match?.[1]);
  return {
    runtime: 'elixir',
    path: mixPath,
    spec: match?.[1] || null,
    minimum,
  };
}

function extractNodeManifest(projectRoot) {
  const packagePath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(packagePath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    const spec = pkg.engines?.node || null;
    const minimum = normalizeVersion(spec);
    return {
      runtime: 'node',
      path: packagePath,
      spec,
      minimum,
    };
  } catch {
    return null;
  }
}

function extractRuntimeManifests(projectRoot) {
  return {
    elixir: extractElixirManifest(projectRoot),
    node: extractNodeManifest(projectRoot),
  };
}

function checkRuntimeContract(projectRoot = process.cwd()) {
  const planning = collectPlanningText(projectRoot);
  const requirements = extractPlannedRuntimeMinimums(planning.text);
  const manifests = extractRuntimeManifests(projectRoot);
  const issues = [];

  for (const [runtime, requirement] of Object.entries(requirements)) {
    const manifest = manifests[runtime];
    if (!manifest) continue;
    if (!manifest.minimum) {
      issues.push(
        `${runtime} manifest ${path.relative(projectRoot, manifest.path)} does not declare a parseable version`,
      );
      continue;
    }
    if (compareVersions(manifest.minimum, requirement.minimum) < 0) {
      issues.push(
        `${runtime} manifest ${path.relative(projectRoot, manifest.path)} declares ${manifest.spec}, ` +
          `but planning requires ${runtime} ${formatVersion(requirement.minimum)} or newer (${requirement.evidence})`,
      );
    }
  }

  return {
    passed: issues.length === 0,
    issues,
    planningFiles: planning.files.map((filePath) => path.relative(projectRoot, filePath).replaceAll('\\', '/')),
    requirements: Object.fromEntries(
      Object.entries(requirements).map(([runtime, requirement]) => [
        runtime,
        {
          minimum: formatVersion(requirement.minimum),
          evidence: requirement.evidence,
        },
      ]),
    ),
    manifests: Object.fromEntries(
      Object.entries(manifests)
        .filter(([, manifest]) => manifest)
        .map(([runtime, manifest]) => [
          runtime,
          {
            path: path.relative(projectRoot, manifest.path).replaceAll('\\', '/'),
            spec: manifest.spec,
            minimum: manifest.minimum ? formatVersion(manifest.minimum) : null,
          },
        ]),
    ),
  };
}

function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  const report = checkRuntimeContract(process.cwd());
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.passed) {
    console.log('[cobolt-runtime-contract] Runtime manifests satisfy planning contracts.');
  } else {
    for (const issue of report.issues) {
      console.error(`[cobolt-runtime-contract] ${issue}`);
    }
  }
  process.exit(report.passed ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  checkRuntimeContract,
  extractPlannedRuntimeMinimums,
  normalizeVersion,
  compareVersions,
};
