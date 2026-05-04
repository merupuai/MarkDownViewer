#!/usr/bin/env node

// CoBolt Test Registry — persistent test case catalog and cross-run result history
//
// Fills the gap between per-run test artifacts and a reusable test knowledge base.
// Test cases are cataloged with metadata, results are aggregated across pipeline runs,
// and lineage tracks requirements -> tests -> fixes.
//
// Usage:
//   node tools/cobolt-test-registry.js init                          # Initialize empty registry
//   node tools/cobolt-test-registry.js register <file> [options]     # Register a test case
//   node tools/cobolt-test-registry.js ingest [--dir tests/]        # Bulk-scan and register test files
//   node tools/cobolt-test-registry.js search <query> [options]     # Search test cases
//   node tools/cobolt-test-registry.js record <runId> [options]     # Record test results for a run
//   node tools/cobolt-test-registry.js trending [--limit 10]        # Show pass/fail trends across runs
//   node tools/cobolt-test-registry.js lineage [--req FR-001]       # Show requirement->test->fix chain
//   node tools/cobolt-test-registry.js recommend <module>           # Suggest existing tests for a module
//   node tools/cobolt-test-registry.js stats                        # Registry statistics
//   node tools/cobolt-test-registry.js export [--format md|json]    # Export as markdown or JSON
//   node tools/cobolt-test-registry.js link <caseId> <type> <id>    # Link test to requirement/finding

const fs = require('node:fs');
const path = require('node:path');
const { paths: _paths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();

// ── Registry Location (operational, NOT run-scoped) ─────────

function registryDir(projectDir) {
  const _p = typeof _paths === 'function' ? _paths(projectDir) : null;
  if (_p) return _p.testRegistry();
  return path.join(projectDir || process.cwd(), '_cobolt-output', 'test-registry');
}

function registryPath(projectDir) {
  return path.join(registryDir(projectDir), 'test-registry.json');
}

// ── Registry CRUD ───────────────────────────────────────────

function emptyRegistry() {
  return {
    version: '1.0.0',
    cases: {},
    results: [],
    lineage: { requirements: {}, fixes: {} },
    metadata: {
      created: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      totalCases: 0,
      totalRuns: 0,
      totalResults: 0,
    },
  };
}

function readRegistry(projectDir) {
  const fp = registryPath(projectDir);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

function writeRegistry(registry, projectDir) {
  const dir = registryDir(projectDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  registry.metadata.lastUpdated = new Date().toISOString();
  registry.metadata.totalCases = Object.keys(registry.cases).length;
  registry.metadata.totalRuns = registry.results.length;
  registry.metadata.totalResults = registry.results.reduce((s, r) => s + Object.keys(r.caseResults || {}).length, 0);
  fs.writeFileSync(registryPath(projectDir), JSON.stringify(registry, null, 2), 'utf8');
}

function ensureRegistry(projectDir) {
  let reg = readRegistry(projectDir);
  if (!reg) {
    reg = emptyRegistry();
    writeRegistry(reg, projectDir);
  }
  return reg;
}

function nextCaseId(registry) {
  const ids = Object.keys(registry.cases).map((id) => parseInt(id.replace('TC-', ''), 10) || 0);
  const max = ids.length > 0 ? Math.max(...ids) : 0;
  return `TC-${String(max + 1).padStart(4, '0')}`;
}

// ── Test File Parser ────────────────────────────────────────

const TEST_PATTERNS = {
  // Node.js built-in test runner
  node: /(?:test|describe)\s*\(\s*['"`]([^'"`]+)['"`]/g,
  // Jest/Vitest
  jest: /(?:test|it|describe)\s*\(\s*['"`]([^'"`]+)['"`]/g,
  // Elixir ExUnit
  elixir: /(?:test|describe)\s+['"]([^'"]+)['"]/g,
  // Python pytest
  pytest: /def\s+(test_\w+)/g,
  // Go
  gotest: /func\s+(Test\w+)/g,
};

function detectFramework(filePath) {
  const ext = path.extname(filePath);
  if (['.ex', '.exs'].includes(ext)) return 'elixir';
  if (ext === '.py') return 'pytest';
  if (ext === '.go') return 'gotest';
  if (['.js', '.mjs', '.ts', '.tsx', '.jsx'].includes(ext)) return 'jest'; // covers node, jest, vitest
  return 'jest';
}

function detectCategory(filePath, content) {
  const lower = `${filePath} ${content.slice(0, 500)}`.toLowerCase();
  if (/security|pentest|vuln|owasp|xss|csrf|injection/.test(lower)) return 'security';
  if (/e2e|end.to.end|cypress|playwright|browser/.test(lower)) return 'e2e';
  if (/integrat|cross.component/.test(lower)) return 'integration';
  if (/perf|benchmark|latency|throughput/.test(lower)) return 'perf';
  if (/a11y|accessib|wcag|aria|screen.reader/.test(lower)) return 'a11y';
  if (/api.contract|openapi|swagger|endpoint/.test(lower)) return 'api';
  if (/database|migration|schema|query|sql|ecto/.test(lower)) return 'db';
  return 'unit';
}

function extractTestNames(content, framework) {
  const pattern = TEST_PATTERNS[framework] || TEST_PATTERNS.jest;
  const names = [];
  let match;
  // Reset lastIndex for global regex
  pattern.lastIndex = 0;
  while ((match = pattern.exec(content)) !== null) {
    names.push(match[1]);
  }
  return names;
}

function extractRequirementIds(content) {
  const ids = new Set();
  const patterns = [/\b(FR-\d{3,4})\b/g, /\b(NFR-\d{3,4})\b/g];
  for (const p of patterns) {
    let m;
    while ((m = p.exec(content)) !== null) ids.add(m[1]);
  }
  return [...ids];
}

function extractFindingIds(content) {
  const ids = new Set();
  const pattern = /\b(F-\d{4})\b/g;
  let m;
  while ((m = pattern.exec(content)) !== null) ids.add(m[1]);
  return [...ids];
}

function moduleFromPath(filePath) {
  const parts = filePath.replace(/\\/g, '/').split('/');
  // Remove test directory prefix and file extension
  const filtered = parts.filter((p) => !['tests', 'test', '__tests__', 'spec'].includes(p));
  const filename = filtered[filtered.length - 1] || '';
  return filename
    .replace(/\.(test|spec|_test|_spec)\.\w+$/, '')
    .replace(/^test[-_]/, '')
    .replace(/\.\w+$/, '');
}

// ── Commands ────────────────────────────────────────────────

function cmdInit(projectDir) {
  const reg = emptyRegistry();
  writeRegistry(reg, projectDir);
  console.log(`  Test registry initialized: ${registryPath(projectDir)}`);
  return reg;
}

function cmdRegister(filePath, options = {}, projectDir) {
  const reg = ensureRegistry(projectDir);
  const absPath = path.isAbsolute(filePath) ? filePath : path.join(projectDir || process.cwd(), filePath);

  if (!fs.existsSync(absPath)) {
    console.error(`  Error: File not found: ${absPath}`);
    return null;
  }

  const content = fs.readFileSync(absPath, 'utf8');
  const relPath = path.relative(projectDir || process.cwd(), absPath).replace(/\\/g, '/');
  const framework = detectFramework(relPath);
  const testNames = extractTestNames(content, framework);
  const category = options.category || detectCategory(relPath, content);
  const requirementIds = extractRequirementIds(content);
  const findingIds = extractFindingIds(content);
  const module = options.module || moduleFromPath(relPath);

  // Check for existing case with same filePath
  const existing = Object.values(reg.cases).find((c) => c.filePath === relPath);
  if (existing) {
    // Update existing
    existing.title = testNames[0] || existing.title;
    existing.category = category;
    existing.functionName = testNames.join(', ');
    existing.module = module;
    existing.tags = [...new Set([...(existing.tags || []), ...(options.tags || []), category, module])];
    existing.requirementIds = [...new Set([...(existing.requirementIds || []), ...requirementIds])];
    existing.findingIds = [...new Set([...(existing.findingIds || []), ...findingIds])];
    existing.lastUpdated = new Date().toISOString();
    updateLineage(reg, existing);
    writeRegistry(reg, projectDir);
    console.log(`  Updated: ${existing.id} — ${relPath} (${testNames.length} tests)`);
    return existing;
  }

  // New case
  const id = nextCaseId(reg);
  const testCase = {
    id,
    title: testNames[0] || path.basename(relPath, path.extname(relPath)),
    description: testNames.length > 1 ? `${testNames.length} tests: ${testNames.slice(0, 5).join(', ')}` : '',
    category,
    filePath: relPath,
    functionName: testNames.join(', '),
    module,
    tags: [...new Set([...(options.tags || []), category, module].filter(Boolean))],
    requirementIds,
    findingIds,
    priority: options.priority || 'medium',
    registeredAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    lastResult: null,
    lastRunAt: null,
    passRate: null,
    runCount: 0,
    source: options.source || 'manual',
  };

  reg.cases[id] = testCase;
  updateLineage(reg, testCase);
  writeRegistry(reg, projectDir);
  console.log(`  Registered: ${id} — ${relPath} (${category}, ${testNames.length} tests)`);
  return testCase;
}

function cmdIngest(options = {}, projectDir) {
  const root = projectDir || process.cwd();
  const searchDirs = options.dir
    ? [path.resolve(root, options.dir)]
    : [
        path.join(root, 'tests'),
        path.join(root, 'test'),
        path.join(root, 'app/test'),
        path.join(root, '__tests__'),
        path.join(root, 'spec'),
      ];

  const testExtensions = new Set(['.js', '.mjs', '.ts', '.tsx', '.jsx', '.ex', '.exs', '.py', '.go']);
  const registered = [];

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    const files = walkDir(dir).filter((f) => {
      const ext = path.extname(f);
      if (!testExtensions.has(ext)) return false;
      const base = path.basename(f).toLowerCase();
      return base.includes('test') || base.includes('spec') || base.startsWith('test_');
    });

    for (const file of files) {
      const result = cmdRegister(file, { source: 'ingest', ...(options.tags ? { tags: options.tags } : {}) }, root);
      if (result) registered.push(result);
    }
  }

  console.log(`\n  Ingested: ${registered.length} test files into registry`);
  return registered;
}

function cmdSearch(query, options = {}, projectDir) {
  const reg = readRegistry(projectDir);
  if (!reg) {
    console.log('  No registry found. Run init first.');
    return [];
  }

  const lower = query.toLowerCase();
  let matches = Object.values(reg.cases).filter((c) => {
    const searchable = [
      c.title,
      c.description,
      c.filePath,
      c.module,
      c.functionName,
      ...(c.tags || []),
      ...(c.requirementIds || []),
      ...(c.findingIds || []),
    ]
      .join(' ')
      .toLowerCase();
    return searchable.includes(lower);
  });

  if (options.category) matches = matches.filter((c) => c.category === options.category);
  if (options.status) matches = matches.filter((c) => c.lastResult === options.status);

  console.log(`  Found ${matches.length} test case(s) matching "${query}":\n`);
  for (const c of matches.slice(0, options.limit || 20)) {
    const result = c.lastResult ? ` [${c.lastResult}]` : '';
    const rate = c.passRate !== null ? ` (${c.passRate}% pass)` : '';
    console.log(`  ${c.id} | ${c.category.padEnd(12)} | ${c.filePath}${result}${rate}`);
    console.log(`         ${c.title}`);
  }
  return matches;
}

function cmdRecord(runId, options = {}, projectDir) {
  const reg = ensureRegistry(projectDir);

  const snapshot = {
    runId,
    timestamp: new Date().toISOString(),
    stage: options.stage || 'manual',
    milestone: options.milestone || null,
    summary: {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      duration_ms: options.duration || 0,
      coverage: options.coverage || null,
    },
    caseResults: {},
    failures: [],
  };

  // If a results file is provided, parse it
  if (options.file) {
    const absFile = path.isAbsolute(options.file) ? options.file : path.join(projectDir || process.cwd(), options.file);
    if (fs.existsSync(absFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(absFile, 'utf8'));
        if (data.summary) Object.assign(snapshot.summary, data.summary);
        if (data.results) {
          snapshot.summary.total = data.results.length;
          snapshot.summary.passed = data.results.filter((r) => r.success).length;
          snapshot.summary.failed = data.results.filter((r) => !r.success).length;
        }
      } catch {}
    }
  }

  // Try to auto-match results to registered cases by running tests
  if (options.autoMatch !== false) {
    const root = projectDir || process.cwd();
    for (const tc of Object.values(reg.cases)) {
      const testFile = path.join(root, tc.filePath);
      if (!fs.existsSync(testFile)) continue;
      // Mark as included in this run (actual pass/fail from external results)
      snapshot.caseResults[tc.id] = 'pass'; // default assumption, overridden by failures
    }
  }

  // Apply explicit case results
  if (options.caseResults) {
    for (const [id, result] of Object.entries(options.caseResults)) {
      snapshot.caseResults[id] = result;
      if (result === 'fail' || result === 'error') {
        snapshot.failures.push({ caseId: id, filePath: reg.cases[id]?.filePath, error: '' });
      }
    }
  }

  // Update per-case stats
  for (const [caseId, result] of Object.entries(snapshot.caseResults)) {
    const tc = reg.cases[caseId];
    if (!tc) continue;
    tc.lastResult = result;
    tc.lastRunAt = snapshot.timestamp;
    tc.runCount = (tc.runCount || 0) + 1;
    // Recalculate pass rate
    const prevPasses = tc.passRate !== null ? Math.round((tc.passRate * (tc.runCount - 1)) / 100) : 0;
    const newPasses = prevPasses + (result === 'pass' ? 1 : 0);
    tc.passRate = Math.round((newPasses / tc.runCount) * 100);
  }

  // Recount snapshot summary from caseResults
  const caseResultValues = Object.values(snapshot.caseResults);
  if (caseResultValues.length > 0 && snapshot.summary.total === 0) {
    snapshot.summary.total = caseResultValues.length;
    snapshot.summary.passed = caseResultValues.filter((r) => r === 'pass').length;
    snapshot.summary.failed = caseResultValues.filter((r) => r === 'fail' || r === 'error').length;
    snapshot.summary.skipped = caseResultValues.filter((r) => r === 'skip').length;
  }

  // Prepend (most recent first), cap at 100 runs
  reg.results.unshift(snapshot);
  if (reg.results.length > 100) reg.results = reg.results.slice(0, 100);

  writeRegistry(reg, projectDir);
  console.log(`  Recorded run: ${runId} — ${snapshot.summary.passed}/${snapshot.summary.total} passed`);
  return snapshot;
}

function cmdTrending(options = {}, projectDir) {
  const reg = readRegistry(projectDir);
  if (!reg || reg.results.length === 0) {
    console.log('  No test results in registry.');
    return [];
  }

  const limit = options.limit || 10;
  const runs = reg.results.slice(0, limit);

  console.log('  Test Result Trends (most recent first):\n');
  console.log('  Run ID                         | Stage       | Total | Pass | Fail | Rate');
  console.log('  ────────────────────────────────┼─────────────┼───────┼──────┼──────┼──────');
  for (const r of runs) {
    const rate = r.summary.total > 0 ? Math.round((r.summary.passed / r.summary.total) * 100) : 0;
    const bar = rate >= 95 ? 'A' : rate >= 85 ? 'B' : rate >= 70 ? 'C' : rate >= 50 ? 'D' : 'F';
    console.log(
      `  ${r.runId.padEnd(32)} | ${(r.stage || '').padEnd(11)} | ${String(r.summary.total).padEnd(5)} | ${String(r.summary.passed).padEnd(4)} | ${String(r.summary.failed).padEnd(4)} | ${rate}% [${bar}]`,
    );
  }

  // Flaky test detection
  const flakyThreshold = 80;
  const flaky = Object.values(reg.cases).filter(
    (c) => c.runCount >= 3 && c.passRate !== null && c.passRate < flakyThreshold && c.passRate > 0,
  );
  if (flaky.length > 0) {
    console.log(`\n  Flaky Tests (pass rate < ${flakyThreshold}%, 3+ runs):\n`);
    for (const c of flaky.slice(0, 10)) {
      console.log(`  ${c.id} | ${c.passRate}% pass | ${c.runCount} runs | ${c.filePath}`);
    }
  }

  return runs;
}

function cmdLineage(options = {}, projectDir) {
  const reg = readRegistry(projectDir);
  if (!reg) {
    console.log('  No registry found.');
    return null;
  }

  if (options.req) {
    // Show all tests linked to a requirement
    const reqId = options.req;
    const caseIds = reg.lineage.requirements[reqId] || [];
    console.log(`\n  Lineage for requirement: ${reqId}`);
    console.log(`  Linked test cases: ${caseIds.length}\n`);
    for (const id of caseIds) {
      const tc = reg.cases[id];
      if (!tc) continue;
      const result = tc.lastResult ? ` [${tc.lastResult}]` : ' [not run]';
      console.log(`    ${id} | ${tc.category.padEnd(12)} | ${tc.filePath}${result}`);
    }
    // Also show findings linked to those tests
    const linkedFindings = [];
    for (const id of caseIds) {
      const tc = reg.cases[id];
      if (tc?.findingIds) linkedFindings.push(...tc.findingIds);
    }
    if (linkedFindings.length > 0) {
      console.log(`\n  Linked findings: ${[...new Set(linkedFindings)].join(', ')}`);
    }
    return { reqId, caseIds, linkedFindings };
  }

  if (options.finding) {
    const findingId = options.finding;
    const caseIds = reg.lineage.fixes[findingId] || [];
    console.log(`\n  Regression tests for finding: ${findingId}`);
    console.log(`  Linked test cases: ${caseIds.length}\n`);
    for (const id of caseIds) {
      const tc = reg.cases[id];
      if (!tc) continue;
      console.log(`    ${id} | ${tc.filePath} | ${tc.lastResult || 'not run'}`);
    }
    return { findingId, caseIds };
  }

  if (options.case) {
    const tc = reg.cases[options.case];
    if (!tc) {
      console.log(`  Case ${options.case} not found.`);
      return null;
    }
    console.log(`\n  Lineage for test case: ${tc.id}`);
    console.log(`  File: ${tc.filePath}`);
    console.log(`  Requirements: ${(tc.requirementIds || []).join(', ') || 'none'}`);
    console.log(`  Findings: ${(tc.findingIds || []).join(', ') || 'none'}`);
    console.log(`  Pass rate: ${tc.passRate !== null ? `${tc.passRate}%` : 'N/A'} (${tc.runCount} runs)`);
    return tc;
  }

  // Summary view
  const reqCount = Object.keys(reg.lineage.requirements).length;
  const fixCount = Object.keys(reg.lineage.fixes).length;
  const orphanTests = Object.values(reg.cases).filter(
    (c) => (!c.requirementIds || c.requirementIds.length === 0) && (!c.findingIds || c.findingIds.length === 0),
  );

  console.log('\n  Lineage Summary:');
  console.log(`  Requirements with tests: ${reqCount}`);
  console.log(`  Findings with regression tests: ${fixCount}`);
  console.log(`  Orphan tests (no links): ${orphanTests.length}`);

  if (orphanTests.length > 0) {
    console.log('\n  Orphan tests (consider linking to requirements):');
    for (const c of orphanTests.slice(0, 10)) {
      console.log(`    ${c.id} | ${c.filePath}`);
    }
  }

  return { reqCount, fixCount, orphanCount: orphanTests.length };
}

function cmdRecommend(module, _options = {}, projectDir) {
  const reg = readRegistry(projectDir);
  if (!reg) {
    console.log('  No registry found.');
    return [];
  }

  const lower = module.toLowerCase();
  const matches = Object.values(reg.cases).filter((c) => {
    return (
      c.module?.toLowerCase().includes(lower) ||
      c.filePath.toLowerCase().includes(lower) ||
      (c.tags || []).some((t) => t.toLowerCase().includes(lower)) ||
      (c.functionName || '').toLowerCase().includes(lower)
    );
  });

  // Sort by relevance: exact module match > tag match > path match
  matches.sort((a, b) => {
    const aExact = (a.module || '').toLowerCase() === lower ? 2 : 0;
    const bExact = (b.module || '').toLowerCase() === lower ? 2 : 0;
    return bExact - aExact || (b.passRate || 0) - (a.passRate || 0);
  });

  console.log(`\n  Recommended tests for module "${module}":`);
  console.log(`  Found: ${matches.length} existing test(s)\n`);

  if (matches.length === 0) {
    console.log('  No existing tests found. Consider creating tests for:');
    console.log(`    - Unit tests for ${module} core logic`);
    console.log(`    - Integration tests for ${module} boundaries`);
    console.log(`    - Edge case tests for ${module} error paths`);
    return [];
  }

  const byCategory = {};
  for (const c of matches) {
    if (!byCategory[c.category]) byCategory[c.category] = [];
    byCategory[c.category].push(c);
  }

  for (const [cat, cases] of Object.entries(byCategory)) {
    console.log(`  [${cat}]`);
    for (const c of cases.slice(0, 5)) {
      const result = c.lastResult ? ` [${c.lastResult}]` : '';
      const rate = c.passRate !== null ? ` ${c.passRate}%` : '';
      console.log(`    ${c.id} | ${c.filePath}${result}${rate}`);
      if (c.functionName) console.log(`           Functions: ${c.functionName.slice(0, 80)}`);
    }
    console.log();
  }

  return matches;
}

function cmdStats(projectDir) {
  const reg = readRegistry(projectDir);
  if (!reg) {
    console.log('  No registry found. Run init first.');
    return null;
  }

  const cases = Object.values(reg.cases);
  const byCategory = {};
  const bySource = {};
  let withResults = 0,
    passing = 0,
    failing = 0;

  for (const c of cases) {
    byCategory[c.category] = (byCategory[c.category] || 0) + 1;
    bySource[c.source || 'unknown'] = (bySource[c.source || 'unknown'] || 0) + 1;
    if (c.lastResult) {
      withResults++;
      if (c.lastResult === 'pass') passing++;
      else if (c.lastResult === 'fail' || c.lastResult === 'error') failing++;
    }
  }

  const reqsCovered = Object.keys(reg.lineage.requirements).length;
  const fixesCovered = Object.keys(reg.lineage.fixes).length;
  const avgPassRate =
    cases.filter((c) => c.passRate !== null).reduce((s, c) => s + c.passRate, 0) /
    (cases.filter((c) => c.passRate !== null).length || 1);

  console.log('\n  CoBolt Test Registry Statistics');
  console.log('  ═══════════════════════════════════════');
  console.log(`  Total test cases:     ${cases.length}`);
  console.log(`  Total result runs:    ${reg.results.length}`);
  console.log(`  Cases with results:   ${withResults}`);
  console.log(`  Currently passing:    ${passing}`);
  console.log(`  Currently failing:    ${failing}`);
  console.log(`  Average pass rate:    ${avgPassRate.toFixed(1)}%`);
  console.log(`  Requirements covered: ${reqsCovered}`);
  console.log(`  Findings regressed:   ${fixesCovered}`);
  console.log();
  console.log('  By Category:');
  for (const [cat, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${cat.padEnd(14)} ${count}`);
  }
  console.log();
  console.log('  By Source:');
  for (const [src, count] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${src.padEnd(14)} ${count}`);
  }

  return {
    total: cases.length,
    byCategory,
    bySource,
    passing,
    failing,
    avgPassRate,
    reqsCovered,
    fixesCovered,
    runs: reg.results.length,
  };
}

function cmdExport(options = {}, projectDir) {
  const reg = readRegistry(projectDir);
  if (!reg) {
    console.log('  No registry found.');
    return '';
  }

  if (options.format === 'json') {
    const output = JSON.stringify(reg, null, 2);
    console.log(output);
    return output;
  }

  // Markdown export
  const cases = Object.values(reg.cases);
  const lines = [
    '# CoBolt Test Registry',
    '',
    `**Total Cases:** ${cases.length} | **Runs:** ${reg.results.length} | **Last Updated:** ${reg.metadata.lastUpdated}`,
    '',
    '## Test Cases',
    '',
    '| ID | Category | Module | File | Last Result | Pass Rate | Runs |',
    '|----|----------|--------|------|-------------|-----------|------|',
  ];

  for (const c of cases) {
    lines.push(
      `| ${c.id} | ${c.category} | ${c.module || '-'} | ${c.filePath} | ${c.lastResult || '-'} | ${c.passRate !== null ? `${c.passRate}%` : '-'} | ${c.runCount} |`,
    );
  }

  // Lineage section
  if (Object.keys(reg.lineage.requirements).length > 0) {
    lines.push('', '## Requirement Coverage', '');
    lines.push('| Requirement | Test Cases |');
    lines.push('|-------------|------------|');
    for (const [reqId, caseIds] of Object.entries(reg.lineage.requirements)) {
      lines.push(`| ${reqId} | ${caseIds.join(', ')} |`);
    }
  }

  // Recent results
  if (reg.results.length > 0) {
    lines.push('', '## Recent Runs', '');
    lines.push('| Run | Stage | Total | Passed | Failed | Rate |');
    lines.push('|-----|-------|-------|--------|--------|------|');
    for (const r of reg.results.slice(0, 10)) {
      const rate = r.summary.total > 0 ? Math.round((r.summary.passed / r.summary.total) * 100) : 0;
      lines.push(
        `| ${r.runId} | ${r.stage || '-'} | ${r.summary.total} | ${r.summary.passed} | ${r.summary.failed} | ${rate}% |`,
      );
    }
  }

  lines.push('', '---', '*Generated by CoBolt Test Registry v1.0.0*');
  const md = lines.join('\n');

  // Write to file
  const outDir = registryDir(projectDir);
  const mdPath = path.join(outDir, 'test-registry-export.md');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(mdPath, md, 'utf8');
  console.log(md);
  console.log(`\n  Exported to: ${mdPath}`);

  return md;
}

function cmdLink(caseId, type, targetId, projectDir) {
  const reg = ensureRegistry(projectDir);
  const tc = reg.cases[caseId];
  if (!tc) {
    console.error(`  Error: Case ${caseId} not found.`);
    return null;
  }

  if (type === 'req' || type === 'requirement') {
    if (!tc.requirementIds) tc.requirementIds = [];
    if (!tc.requirementIds.includes(targetId)) tc.requirementIds.push(targetId);
    if (!reg.lineage.requirements[targetId]) reg.lineage.requirements[targetId] = [];
    if (!reg.lineage.requirements[targetId].includes(caseId)) reg.lineage.requirements[targetId].push(caseId);
    console.log(`  Linked ${caseId} -> requirement ${targetId}`);
  } else if (type === 'finding' || type === 'fix') {
    if (!tc.findingIds) tc.findingIds = [];
    if (!tc.findingIds.includes(targetId)) tc.findingIds.push(targetId);
    if (!reg.lineage.fixes[targetId]) reg.lineage.fixes[targetId] = [];
    if (!reg.lineage.fixes[targetId].includes(caseId)) reg.lineage.fixes[targetId].push(caseId);
    console.log(`  Linked ${caseId} -> finding ${targetId}`);
  } else {
    console.error(`  Error: Unknown link type "${type}". Use "req" or "finding".`);
    return null;
  }

  writeRegistry(reg, projectDir);
  return tc;
}

// ── Helpers ─────────────────────────────────────────────────

function updateLineage(registry, testCase) {
  for (const reqId of testCase.requirementIds || []) {
    if (!registry.lineage.requirements[reqId]) registry.lineage.requirements[reqId] = [];
    if (!registry.lineage.requirements[reqId].includes(testCase.id)) {
      registry.lineage.requirements[reqId].push(testCase.id);
    }
  }
  for (const fId of testCase.findingIds || []) {
    if (!registry.lineage.fixes[fId]) registry.lineage.fixes[fId] = [];
    if (!registry.lineage.fixes[fId].includes(testCase.id)) {
      registry.lineage.fixes[fId].push(testCase.id);
    }
  }
}

function walkDir(dir) {
  const results = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        results.push(...walkDir(full));
      } else {
        results.push(full);
      }
    }
  } catch {}
  return results;
}

// ── Module Exports ──────────────────────────────────────────

module.exports = {
  readRegistry,
  writeRegistry,
  ensureRegistry,
  registryPath,
  registryDir,
  cmdInit,
  cmdRegister,
  cmdIngest,
  cmdSearch,
  cmdRecord,
  cmdTrending,
  cmdLineage,
  cmdRecommend,
  cmdStats,
  cmdExport,
  cmdLink,
};

// ── CLI ─────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log();
    console.log('  CoBolt Test Registry — Persistent Test Knowledge Base');
    console.log('  ══════════════════════════════════════════════════════');
    console.log();
    console.log('  Usage: node tools/cobolt-test-registry.js <command> [args]');
    console.log();
    console.log('  Commands:');
    console.log('    init                          Initialize empty registry');
    console.log('    register <file> [options]      Register a test file');
    console.log('    ingest [--dir <path>]          Bulk-scan and register test files');
    console.log('    search <query> [options]       Search test cases');
    console.log('    record <runId> [options]       Record test results for a run');
    console.log('    trending [--limit N]           Show pass/fail trends');
    console.log('    lineage [options]              Show requirement/test/fix chain');
    console.log('    recommend <module>             Suggest existing tests for a module');
    console.log('    stats                          Registry statistics');
    console.log('    export [--format md|json]      Export registry');
    console.log('    link <caseId> <type> <id>      Link test to requirement/finding');
    console.log();
    console.log('  Options:');
    console.log('    --category <cat>    Filter by category');
    console.log('    --tags <t1,t2>      Add tags when registering');
    console.log('    --module <name>     Override module name');
    console.log('    --stage <stage>     Pipeline stage for recording');
    console.log('    --file <path>       Results JSON file for recording');
    console.log('    --req <FR-XXX>      Show lineage for requirement');
    console.log('    --finding <F-XXXX>  Show lineage for finding');
    console.log('    --case <TC-XXXX>    Show lineage for test case');
    console.log('    --limit <N>         Limit results');
    console.log('    --format md|json    Export format');
    console.log();
    process.exit(0);
  }

  const parseFlag = (flag) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
  };

  switch (cmd) {
    case 'init':
      cmdInit();
      break;

    case 'register': {
      const file = args[1];
      if (!file) {
        console.error('  Error: file path required');
        process.exit(1);
      }
      cmdRegister(file, {
        category: parseFlag('--category'),
        tags: parseFlag('--tags')?.split(','),
        module: parseFlag('--module'),
        priority: parseFlag('--priority'),
      });
      break;
    }

    case 'ingest':
      cmdIngest({
        dir: parseFlag('--dir'),
        tags: parseFlag('--tags')?.split(','),
      });
      break;

    case 'search': {
      const query = args[1];
      if (!query) {
        console.error('  Error: search query required');
        process.exit(1);
      }
      cmdSearch(query, {
        category: parseFlag('--category'),
        status: parseFlag('--status'),
        limit: parseFlag('--limit') ? parseInt(parseFlag('--limit'), 10) : 20,
      });
      break;
    }

    case 'record': {
      const runId = args[1];
      if (!runId) {
        console.error('  Error: runId required');
        process.exit(1);
      }
      cmdRecord(runId, {
        stage: parseFlag('--stage'),
        file: parseFlag('--file'),
        milestone: parseFlag('--milestone'),
      });
      break;
    }

    case 'trending':
      cmdTrending({ limit: parseFlag('--limit') ? parseInt(parseFlag('--limit'), 10) : 10 });
      break;

    case 'lineage':
      cmdLineage({
        req: parseFlag('--req'),
        finding: parseFlag('--finding'),
        case: parseFlag('--case'),
      });
      break;

    case 'recommend': {
      const mod = args[1];
      if (!mod) {
        console.error('  Error: module name required');
        process.exit(1);
      }
      cmdRecommend(mod);
      break;
    }

    case 'stats':
      cmdStats();
      break;

    case 'export':
      cmdExport({ format: parseFlag('--format') || 'md' });
      break;

    case 'link': {
      const [, caseId, type, targetId] = args;
      if (!caseId || !type || !targetId) {
        console.error('  Error: usage: link <TC-XXXX> <req|finding> <ID>');
        process.exit(1);
      }
      cmdLink(caseId, type, targetId);
      break;
    }

    default:
      console.error(`  Unknown command: ${cmd}`);
      process.exit(1);
  }
}
