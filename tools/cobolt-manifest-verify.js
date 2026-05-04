#!/usr/bin/env node

// CoBolt Manifest Verify — Post-round file completeness checker
//
// Compares expected files from story-spec blueprints against actual disk state.
// Missing files = round incomplete. Used after each TDD GREEN round.
//
// Usage:
//   node tools/cobolt-manifest-verify.js <milestone> [--round <N>] [--json] [--strict]
//
// Sources of expected files:
//   1. Story spec blueprints: _cobolt-output/latest/build/story-specs/M{n}-*.json
//   2. Task manifest: _cobolt-output/latest/build/M{n}-task-manifest.json
//   3. Test plan: _cobolt-output/latest/build/M{n}-test-plan.json
//
// Returns exit 0 if all expected files exist, exit 1 if any are missing.

const fs = require('node:fs');
const path = require('node:path');

function usage() {
  return 'Usage: node tools/cobolt-manifest-verify.js <M1|M2|...> [--round N] [--json] [--strict]';
}

// ── Helpers ───────────────────────────────────────────────────

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function findFiles(dir, pattern) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (pattern.test(entry)) {
        results.push(path.join(dir, entry));
      }
    }
  } catch {
    /* ignore */
  }
  return results;
}

// ── File Extraction from Story Specs ──────────────────────────

function extractExpectedFiles(milestone, round) {
  const buildDir = path.join(process.cwd(), '_cobolt-output', 'latest', 'build');
  const expected = {
    source: [], // app source files
    test: [], // test files
    config: [], // config/migration files
  };

  // Source 1: Story spec blueprints
  const storySpecDirs = [path.join(buildDir, 'story-specs'), path.join(buildDir, milestone, 'story-specs')];

  for (const dir of storySpecDirs) {
    const specFiles = findFiles(dir, new RegExp(`^${milestone}-.*\\.json$`));
    for (const specFile of specFiles) {
      const spec = readJson(specFile);
      if (!spec) continue;

      // Extract files from story spec "files" or "filesToCreate" or "implementation"
      const fileEntries = spec.files || spec.filesToCreate || spec.implementation?.files || [];
      for (const entry of fileEntries) {
        const filePath = entry.path || entry.file || entry;
        if (typeof filePath !== 'string') continue;

        if (/test|spec|__test__|_test\.|\.test\.|\.spec\./.test(filePath)) {
          expected.test.push({ path: filePath, story: spec.storyId || spec.id || 'unknown', source: 'story-spec' });
        } else if (/migration|config|\.env|schema/.test(filePath)) {
          expected.config.push({ path: filePath, story: spec.storyId || spec.id || 'unknown', source: 'story-spec' });
        } else {
          expected.source.push({ path: filePath, story: spec.storyId || spec.id || 'unknown', source: 'story-spec' });
        }
      }

      // Extract from implementation.components
      const components = spec.implementation?.components || spec.components || [];
      for (const comp of components) {
        if (comp.file || comp.path) {
          expected.source.push({
            path: comp.file || comp.path,
            story: spec.storyId || spec.id || 'unknown',
            source: 'story-spec-component',
          });
        }
      }
    }
  }

  // Source 2: Task manifest
  const taskManifestPaths = [
    path.join(buildDir, `${milestone}-task-manifest.json`),
    path.join(buildDir, milestone, `${milestone}-task-manifest.json`),
  ];

  for (const manifestPath of taskManifestPaths) {
    const manifest = readJson(manifestPath);
    if (!manifest) continue;

    const tasks = manifest.tasks || manifest.rounds || [];
    const roundTasks = round ? tasks.filter((t) => t.round === round || t.roundNumber === round) : tasks;

    for (const task of roundTasks) {
      const files = task.files || task.expectedFiles || task.outputs || [];
      for (const f of files) {
        const filePath = f.path || f.file || f;
        if (typeof filePath !== 'string') continue;
        expected.source.push({ path: filePath, story: task.storyId || task.id || 'unknown', source: 'task-manifest' });
      }
    }
  }

  // Source 3: Test plan
  const testPlanPaths = [
    path.join(buildDir, `${milestone}-test-plan.json`),
    path.join(buildDir, milestone, `${milestone}-test-plan.json`),
  ];

  for (const planPath of testPlanPaths) {
    const plan = readJson(planPath);
    if (!plan) continue;

    const testFiles = plan.testFiles || plan.tests || [];
    for (const t of testFiles) {
      const filePath = t.path || t.file || t;
      if (typeof filePath !== 'string') continue;
      // Only include if not already in expected.test
      if (!expected.test.some((e) => e.path === filePath)) {
        expected.test.push({ path: filePath, story: t.storyId || 'test-plan', source: 'test-plan' });
      }
    }
  }

  return expected;
}

// ── Verification ──────────────────────────────────────────────

function verifyFiles(expectedFiles) {
  const results = {
    total: 0,
    present: 0,
    missing: 0,
    empty: 0,
    details: {
      present: [],
      missing: [],
      empty: [],
    },
  };

  const allFiles = [...expectedFiles.source, ...expectedFiles.test, ...expectedFiles.config];

  // Deduplicate by path
  const seen = new Set();
  const unique = [];
  for (const f of allFiles) {
    if (!seen.has(f.path)) {
      seen.add(f.path);
      unique.push(f);
    }
  }

  results.total = unique.length;

  for (const entry of unique) {
    const fullPath = path.join(process.cwd(), entry.path);

    if (!fs.existsSync(fullPath)) {
      results.missing++;
      results.details.missing.push(entry);
      continue;
    }

    try {
      const stat = fs.statSync(fullPath);
      if (stat.size === 0) {
        results.empty++;
        results.details.empty.push({ ...entry, size: 0 });
      } else {
        results.present++;
        results.details.present.push({ ...entry, size: stat.size });
      }
    } catch {
      results.missing++;
      results.details.missing.push(entry);
    }
  }

  return results;
}

// ── CLI ───────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error(usage());
    process.exit(1);
  }
  if (args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(usage());
    process.exit(0);
  }
  const milestone = args.find((a) => /^M\d+$/i.test(a));
  const jsonMode = args.includes('--json');
  const strict = args.includes('--strict');
  const roundIdx = args.indexOf('--round');
  const round = roundIdx >= 0 ? parseInt(args[roundIdx + 1], 10) : null;

  if (!milestone) {
    console.error(usage());
    process.exit(1);
  }

  const expected = extractExpectedFiles(milestone.toUpperCase(), round);
  const results = verifyFiles(expected);

  // Compute completeness percentage
  const completeness = results.total > 0 ? Math.round((results.present / results.total) * 100) : 100;

  const report = {
    milestone: milestone.toUpperCase(),
    round: round || 'all',
    completeness: `${completeness}%`,
    total: results.total,
    present: results.present,
    missing: results.missing,
    empty: results.empty,
    status: results.missing === 0 && results.empty === 0 ? 'PASS' : 'FAIL',
    missingFiles: results.details.missing.map((f) => ({
      path: f.path,
      story: f.story,
      source: f.source,
    })),
    emptyFiles: results.details.empty.map((f) => ({
      path: f.path,
      story: f.story,
    })),
  };

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\nManifest Verification: ${milestone.toUpperCase()}${round ? ` Round ${round}` : ''}`);
    console.log('─'.repeat(50));
    console.log(`Total expected files: ${results.total}`);
    console.log(`Present on disk:      ${results.present}`);
    console.log(`Missing:              ${results.missing}`);
    console.log(`Empty (0 bytes):      ${results.empty}`);
    console.log(`Completeness:         ${completeness}%`);
    console.log(`Status:               ${report.status}`);

    if (results.details.missing.length > 0) {
      console.log('\nMissing files:');
      for (const f of results.details.missing) {
        console.log(`  ✗ ${f.path} (${f.story}, ${f.source})`);
      }
    }

    if (results.details.empty.length > 0) {
      console.log('\nEmpty files (0 bytes):');
      for (const f of results.details.empty) {
        console.log(`  ⚠ ${f.path} (${f.story})`);
      }
    }
  }

  // Save results to build artifacts
  try {
    const outDir = path.join(process.cwd(), '_cobolt-output', 'latest', 'build');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const outPath = round
      ? path.join(outDir, `${milestone.toUpperCase()}-round-${round}-manifest-verify.json`)
      : path.join(outDir, `${milestone.toUpperCase()}-manifest-verify.json`);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  } catch {
    /* best effort */
  }

  if (strict && report.status === 'FAIL') {
    process.exit(1);
  } else if (results.missing > 0) {
    process.exit(1);
  }
}

// ── Programmatic API ──────────────────────────────────────────

module.exports = {
  extractExpectedFiles,
  verifyFiles,
};

if (require.main === module) {
  main();
}
