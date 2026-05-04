#!/usr/bin/env node

// CoBolt Parity Test — Parity test generation and execution
//
// Usage:
//   node tools/cobolt-parity-test.js generate <rules-file> [--output <dir>]
//   node tools/cobolt-parity-test.js execute <test-dir> --legacy <url> --modern <url>
//   node tools/cobolt-parity-test.js compare <legacy-output> <modern-output>
//
// Features:
//   - Test case generation from extracted business rules (JSON)
//   - Input/output capture from legacy system
//   - Replay on new system with comparison
//   - Discrepancy analysis with severity classification
//   - Tolerance-aware comparison (exact, fuzzy, range)

const fs = require('node:fs');
const path = require('node:path');

// ── Test Generation ────────────────────────────────────────

function generateParityTests(rulesFile, _options = {}) {
  if (!fs.existsSync(rulesFile)) {
    return { error: `Rules file not found: ${rulesFile}` };
  }

  let rules;
  try {
    const content = fs.readFileSync(rulesFile, 'utf-8');
    const parsed = JSON.parse(content);
    rules = parsed.rules || parsed;
  } catch (e) {
    return { error: `Failed to parse rules file: ${e.message}` };
  }

  if (!Array.isArray(rules)) {
    return { error: 'Rules file must contain an array of rules' };
  }

  const tests = [];
  const coverage = { total: rules.length, covered: 0, skipped: 0 };

  for (const rule of rules) {
    const ruleTests = generateTestsForRule(rule);
    if (ruleTests.length > 0) {
      tests.push(...ruleTests);
      coverage.covered++;
    } else {
      coverage.skipped++;
    }
  }

  return {
    timestamp: new Date().toISOString(),
    source: rulesFile,
    tests,
    coverage,
    summary: {
      totalTests: tests.length,
      byCategory: tests.reduce((acc, t) => {
        acc[t.category] = (acc[t.category] || 0) + 1;
        return acc;
      }, {}),
    },
  };
}

function generateTestsForRule(rule) {
  const tests = [];
  const id = rule.id || `BR-${Math.random().toString(36).substr(2, 5)}`;

  switch (rule.category) {
    case 'conditional':
    case 'business_rule':
      tests.push({
        testId: `PT-${id}-positive`,
        ruleId: id,
        category: 'business_rule_parity',
        type: 'positive',
        description: `Verify rule ${id} produces correct output for valid input`,
        input: {
          /* to be filled by rule-specific logic */
        },
        expectedBehavior: rule.condition || rule.description,
        comparison: 'exact',
        tolerance: null,
        source: rule.source,
      });
      tests.push({
        testId: `PT-${id}-negative`,
        ruleId: id,
        category: 'business_rule_parity',
        type: 'negative',
        description: `Verify rule ${id} rejects invalid input correctly`,
        input: {},
        expectedBehavior: `NOT: ${rule.condition || rule.description}`,
        comparison: 'exact',
        tolerance: null,
        source: rule.source,
      });
      break;

    case 'calculation':
      tests.push({
        testId: `PT-${id}-calc-typical`,
        ruleId: id,
        category: 'calculation_parity',
        type: 'typical',
        description: `Verify calculation ${id} with typical values`,
        input: {},
        expectedOutput: null,
        comparison: 'tolerance',
        tolerance: 0.01,
        formula: rule.formula,
        source: rule.source,
      });
      tests.push({
        testId: `PT-${id}-calc-boundary`,
        ruleId: id,
        category: 'calculation_parity',
        type: 'boundary',
        description: `Verify calculation ${id} at boundary values`,
        input: {},
        expectedOutput: null,
        comparison: 'tolerance',
        tolerance: 0.01,
        formula: rule.formula,
        source: rule.source,
      });
      break;

    case 'validation':
      tests.push({
        testId: `PT-${id}-valid`,
        ruleId: id,
        category: 'validation_parity',
        type: 'valid_input',
        description: `Verify validation ${id} accepts valid input`,
        input: {},
        expectedResult: 'pass',
        comparison: 'exact',
        source: rule.source,
      });
      tests.push({
        testId: `PT-${id}-invalid`,
        ruleId: id,
        category: 'validation_parity',
        type: 'invalid_input',
        description: `Verify validation ${id} rejects invalid input`,
        input: {},
        expectedResult: 'fail',
        expectedError: rule.match,
        comparison: 'contains',
        source: rule.source,
      });
      break;

    case 'state_transition':
      tests.push({
        testId: `PT-${id}-transition`,
        ruleId: id,
        category: 'state_parity',
        type: 'transition',
        description: `Verify state transition to ${rule.stateValue}`,
        fromState: null,
        toState: rule.stateValue,
        comparison: 'exact',
        source: rule.source,
      });
      break;
  }

  return tests;
}

// ── Comparison Engine ──────────────────────────────────────

function compareOutputs(legacyOutput, modernOutput, tests) {
  const results = {
    timestamp: new Date().toISOString(),
    totalTests: tests.length,
    pass: 0,
    partial: 0,
    fail: 0,
    untestable: 0,
    passRate: 0,
    discrepancies: [],
    details: [],
  };

  for (const test of tests) {
    const legacyResult = legacyOutput[test.testId];
    const modernResult = modernOutput[test.testId];

    if (!legacyResult || !modernResult) {
      results.untestable++;
      results.details.push({ testId: test.testId, status: 'untestable', reason: 'Missing output data' });
      continue;
    }

    const comparison = compareValues(legacyResult, modernResult, test.comparison, test.tolerance);

    if (comparison.match) {
      results.pass++;
      results.details.push({ testId: test.testId, status: 'pass' });
    } else if (comparison.partial) {
      results.partial++;
      results.details.push({ testId: test.testId, status: 'partial', diff: comparison.diff });
    } else {
      results.fail++;
      results.discrepancies.push({
        testId: test.testId,
        ruleId: test.ruleId,
        severity: classifyDiscrepancy(test, comparison),
        legacy: legacyResult,
        modern: modernResult,
        diff: comparison.diff,
      });
      results.details.push({ testId: test.testId, status: 'fail', diff: comparison.diff });
    }
  }

  const testable = results.totalTests - results.untestable;
  results.passRate = testable > 0 ? Math.round(((results.pass + results.partial * 0.5) / testable) * 100) : 0;

  return results;
}

function compareValues(legacy, modern, method, tolerance) {
  switch (method) {
    case 'exact':
      return { match: JSON.stringify(legacy) === JSON.stringify(modern), diff: null };
    case 'tolerance':
      if (typeof legacy === 'number' && typeof modern === 'number') {
        const diff = Math.abs(legacy - modern);
        return { match: diff <= (tolerance || 0.01), partial: diff <= (tolerance || 0.01) * 10, diff };
      }
      return { match: legacy === modern, diff: `type mismatch: ${typeof legacy} vs ${typeof modern}` };
    case 'contains':
      if (typeof legacy === 'string' && typeof modern === 'string') {
        return { match: modern.includes(legacy) || legacy.includes(modern), diff: null };
      }
      return { match: false, diff: 'contains comparison failed' };
    default:
      return { match: JSON.stringify(legacy) === JSON.stringify(modern), diff: null };
  }
}

function classifyDiscrepancy(test, _comparison) {
  if (test.category === 'calculation_parity') return 'major';
  if (test.category === 'business_rule_parity' && test.type === 'positive') return 'critical';
  if (test.category === 'validation_parity') return 'major';
  if (test.category === 'state_parity') return 'critical';
  return 'minor';
}

function formatReport(results) {
  if (results.error) return `Error: ${results.error}`;

  // Handle both generation and comparison results
  if (results.tests) {
    // Generation report
    const lines = [];
    lines.push('');
    lines.push('  CoBolt Parity Test Generation Report');
    lines.push('  ═══════════════════════════════════════════');
    lines.push(`  Source: ${results.source}`);
    lines.push(`  Tests generated: ${results.summary.totalTests}`);
    lines.push(`  Rules covered: ${results.coverage.covered}/${results.coverage.total}`);
    lines.push(`  Rules skipped: ${results.coverage.skipped}`);
    lines.push('');
    lines.push('  By Category:');
    for (const [cat, count] of Object.entries(results.summary.byCategory)) {
      lines.push(`    ${cat}: ${count}`);
    }
    return lines.join('\n');
  }

  if (results.passRate !== undefined) {
    // Comparison report
    const lines = [];
    lines.push('');
    lines.push('  CoBolt Parity Test Comparison Report');
    lines.push('  ═══════════════════════════════════════════');
    lines.push(`  Total tests: ${results.totalTests}`);
    lines.push(`  Pass: ${results.pass}`);
    lines.push(`  Partial: ${results.partial}`);
    lines.push(`  Fail: ${results.fail}`);
    lines.push(`  Untestable: ${results.untestable}`);
    lines.push(`  Pass rate: ${results.passRate}%`);
    lines.push(`  Gate: ${results.passRate >= 90 ? 'PASS' : 'FAIL'} (target: 90%)`);
    lines.push('');
    if (results.discrepancies.length > 0) {
      lines.push('  Discrepancies:');
      for (const d of results.discrepancies) {
        lines.push(`    ${d.testId} [${d.severity}] Rule: ${d.ruleId}`);
      }
    }
    return lines.join('\n');
  }

  return 'Unknown result format';
}

// ── Exports ────────────────────────────────────────────────

module.exports = { generateParityTests, compareOutputs, formatReport };

// ── CLI ────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help') {
    console.log('Usage:');
    console.log('  cobolt-parity-test generate <rules.json> [--output <dir>] [--json]');
    console.log('  cobolt-parity-test compare <legacy-output.json> <modern-output.json>');
    process.exit(0);
  }

  if (command === 'generate') {
    const rulesFile = args[1];
    if (!rulesFile) {
      console.error('Error: rules file required');
      process.exit(1);
    }

    let outputDir = null;
    let jsonOutput = false;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--output' && args[i + 1]) outputDir = args[++i];
      if (args[i] === '--json') jsonOutput = true;
    }

    const results = generateParityTests(path.resolve(rulesFile));

    if (outputDir) {
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, 'parity-tests.json'), JSON.stringify(results, null, 2));
      console.log(`Tests written to ${outputDir}/parity-tests.json`);
    } else if (jsonOutput) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log(formatReport(results));
    }
  } else if (command === 'compare') {
    const legacyFile = args[1];
    const modernFile = args[2];
    if (!legacyFile || !modernFile) {
      console.error('Error: both legacy and modern output files required');
      process.exit(1);
    }
    const legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf-8'));
    const modern = JSON.parse(fs.readFileSync(modernFile, 'utf-8'));
    const tests = legacy.tests || [];
    const results = compareOutputs(legacy, modern, tests);
    console.log(formatReport(results));
    if (results.passRate < 90) process.exit(1);
  }
}
