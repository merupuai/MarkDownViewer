#!/usr/bin/env node

// CoBolt Coverage Ratchet — Monotonic Coverage Enforcement
//
// Ensures test coverage never decreases across milestones.
// Uses per-milestone threshold files with a 1% tolerance band.
//
// Usage:
//   node tools/cobolt-coverage-ratchet.js capture M1        # Capture current coverage as M1 threshold
//   node tools/cobolt-coverage-ratchet.js check M2           # Check coverage against M1 threshold
//   node tools/cobolt-coverage-ratchet.js status              # Show all thresholds
//   node tools/cobolt-coverage-ratchet.js compare M1 M2       # Compare two milestones
//   node tools/cobolt-coverage-ratchet.js --json              # JSON output
//
// Threshold files: _cobolt-output/coverage/coverage-threshold-M{n}.json
// Tolerance: Coverage can drop by up to TOLERANCE% without failing.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { atomicWriteJSON } = require('../lib/cobolt-atomic-write');

const PROJECT_ROOT = process.cwd();
const COVERAGE_DIR = path.join(PROJECT_ROOT, '_cobolt-output', 'coverage');

// v0.65.3 (audit S2-F): tolerance is now configurable.
// COBOLT_COVERAGE_TOLERANCE=N.N — drop by up to N.N% per milestone without
// failing. Default 1.0% preserves prior behavior for backward compatibility.
// Set to 0 to enforce strict monotonicity (no coverage drop allowed).
function resolveTolerance() {
  const raw = process.env.COBOLT_COVERAGE_TOLERANCE;
  if (raw == null || raw === '') return 1.0;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 50) return parsed;
  // Reject NaN / negative / absurdly high; warn once, fall back to safe default.
  process.stderr.write(`[cobolt-coverage-ratchet] Invalid COBOLT_COVERAGE_TOLERANCE=${raw}. Using default 1.0%.\n`);
  return 1.0;
}
const TOLERANCE = resolveTolerance();

// ── Coverage Collection ───────────────────────────────────

/**
 * Collect current coverage metrics from the project.
 * Tries multiple strategies: c8/istanbul JSON, lcov, coverage-summary.
 * Returns { lines, functions, branches, statements } as percentages.
 */
function collectCoverage() {
  // Strategy 1: c8/istanbul coverage-summary.json
  const candidates = [
    path.join(PROJECT_ROOT, 'coverage', 'coverage-summary.json'),
    path.join(PROJECT_ROOT, '.nyc_output', 'coverage-summary.json'),
    path.join(PROJECT_ROOT, 'coverage', 'coverage-final.json'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        const data = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        // coverage-summary.json format
        if (data.total) {
          return {
            lines: data.total.lines?.pct ?? 0,
            functions: data.total.functions?.pct ?? 0,
            branches: data.total.branches?.pct ?? 0,
            statements: data.total.statements?.pct ?? 0,
            source: candidate,
          };
        }
        // coverage-final.json — compute aggregates
        if (!data.total) {
          const files = Object.values(data);
          if (files.length > 0) {
            let totalS = 0,
              coveredS = 0,
              totalB = 0,
              coveredB = 0,
              totalF = 0,
              coveredF = 0;
            for (const file of files) {
              if (file.s) {
                for (const v of Object.values(file.s)) {
                  totalS++;
                  if (v > 0) coveredS++;
                }
              }
              if (file.b) {
                for (const v of Object.values(file.b)) {
                  for (const c of v) {
                    totalB++;
                    if (c > 0) coveredB++;
                  }
                }
              }
              if (file.f) {
                for (const v of Object.values(file.f)) {
                  totalF++;
                  if (v > 0) coveredF++;
                }
              }
            }
            return {
              lines: totalS > 0 ? Math.round((coveredS / totalS) * 10000) / 100 : 0,
              functions: totalF > 0 ? Math.round((coveredF / totalF) * 10000) / 100 : 0,
              branches: totalB > 0 ? Math.round((coveredB / totalB) * 10000) / 100 : 0,
              statements: totalS > 0 ? Math.round((coveredS / totalS) * 10000) / 100 : 0,
              source: candidate,
            };
          }
        }
      } catch {
        /* try next */
      }
    }
  }

  // Strategy 2: Run tests with coverage and parse output
  try {
    const _output = execFileSync('npx', ['c8', '--reporter=json-summary', 'node', '--test', 'tests/'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Re-read the generated summary
    const summaryPath = path.join(PROJECT_ROOT, 'coverage', 'coverage-summary.json');
    if (fs.existsSync(summaryPath)) {
      const data = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
      if (data.total) {
        return {
          lines: data.total.lines?.pct ?? 0,
          functions: data.total.functions?.pct ?? 0,
          branches: data.total.branches?.pct ?? 0,
          statements: data.total.statements?.pct ?? 0,
          source: summaryPath,
        };
      }
    }
  } catch {
    /* coverage run failed */
  }

  return null;
}

// ── Threshold Management ──────────────────────────────────

function thresholdPath(milestone) {
  return path.join(COVERAGE_DIR, `coverage-threshold-${milestone}.json`);
}

function readThreshold(milestone) {
  const fp = thresholdPath(milestone);
  try {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    /* corrupted */
  }
  return null;
}

function writeThreshold(milestone, coverage) {
  const data = {
    milestone,
    capturedAt: new Date().toISOString(),
    tolerance: TOLERANCE,
    thresholds: {
      lines: coverage.lines,
      functions: coverage.functions,
      branches: coverage.branches,
      statements: coverage.statements,
    },
    source: coverage.source || 'manual',
  };
  const fp = thresholdPath(milestone);
  atomicWriteJSON(fp, data, { mode: 0o600 });
  return data;
}

function listThresholds() {
  try {
    if (!fs.existsSync(COVERAGE_DIR)) return [];
    return fs
      .readdirSync(COVERAGE_DIR)
      .filter((f) => f.startsWith('coverage-threshold-') && f.endsWith('.json'))
      .map((f) => {
        const milestone = f.replace('coverage-threshold-', '').replace('.json', '');
        const data = readThreshold(milestone);
        return { milestone, ...data };
      })
      .filter(Boolean)
      .sort((a, b) => {
        const numA = parseInt(a.milestone.replace(/\D/g, ''), 10) || 0;
        const numB = parseInt(b.milestone.replace(/\D/g, ''), 10) || 0;
        return numA - numB;
      });
  } catch {
    return [];
  }
}

// ── Ratchet Check ─────────────────────────────────────────

/**
 * Check current coverage against the previous milestone's threshold.
 * @param {string} currentMilestone - e.g., "M2"
 * @returns {{ passed, metrics[], previousMilestone, violations[] }}
 */
function checkRatchet(currentMilestone) {
  // Find the previous milestone threshold
  const thresholds = listThresholds();
  const currentNum = parseInt(currentMilestone.replace(/\D/g, ''), 10) || 0;

  // Find the highest milestone threshold below current
  let previous = null;
  for (const t of thresholds) {
    const num = parseInt(t.milestone.replace(/\D/g, ''), 10) || 0;
    if (num < currentNum) {
      if (!previous || num > parseInt(previous.milestone.replace(/\D/g, ''), 10)) {
        previous = t;
      }
    }
  }

  if (!previous) {
    return {
      passed: true,
      message: `No previous milestone threshold found for ${currentMilestone}. First milestone — no ratchet check needed.`,
      previousMilestone: null,
      violations: [],
    };
  }

  // Collect current coverage
  const current = collectCoverage();
  if (!current) {
    return {
      passed: false,
      message: 'Cannot collect coverage metrics. Run tests with coverage first.',
      previousMilestone: previous.milestone,
      violations: [{ metric: 'all', reason: 'No coverage data available' }],
    };
  }

  // Compare each metric with tolerance
  const metrics = ['lines', 'functions', 'branches', 'statements'];
  const violations = [];
  const results = [];

  for (const metric of metrics) {
    const threshold = previous.thresholds[metric] || 0;
    const actual = current[metric] || 0;
    const delta = actual - threshold;
    const belowTolerance = actual < threshold - TOLERANCE;

    results.push({
      metric,
      threshold,
      actual,
      delta: Math.round(delta * 100) / 100,
      passed: !belowTolerance,
    });

    if (belowTolerance) {
      violations.push({
        metric,
        threshold,
        actual,
        delta: Math.round(delta * 100) / 100,
        reason: `${metric} dropped from ${threshold}% to ${actual}% (${delta.toFixed(1)}%, exceeds ${TOLERANCE}% tolerance)`,
      });
    }
  }

  return {
    passed: violations.length === 0,
    message:
      violations.length === 0
        ? `Coverage ratchet passed: ${currentMilestone} meets ${previous.milestone} thresholds (${TOLERANCE}% tolerance).`
        : `Coverage ratchet FAILED: ${violations.length} metric(s) dropped beyond ${TOLERANCE}% tolerance.`,
    previousMilestone: previous.milestone,
    currentMilestone,
    metrics: results,
    violations,
  };
}

// ── CLI ───────────────────────────────────────────────────

function printStatus() {
  const thresholds = listThresholds();
  if (thresholds.length === 0) {
    console.log('No coverage thresholds captured yet.');
    console.log('Run: node tools/cobolt-coverage-ratchet.js capture M1');
    return;
  }

  console.log();
  console.log('  Coverage Ratchet Thresholds');
  console.log(`  ${'\u2550'.repeat(60)}`);

  for (const t of thresholds) {
    console.log(
      `  ${t.milestone.padEnd(6)} | Lines: ${t.thresholds.lines}% | Fn: ${t.thresholds.functions}% | Branch: ${t.thresholds.branches}% | Stmt: ${t.thresholds.statements}%`,
    );
  }
  console.log(`  Tolerance: ${TOLERANCE}%`);
  console.log();
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log('Usage: node tools/cobolt-coverage-ratchet.js <command> [milestone]');
    console.log('');
    console.log('Commands:');
    console.log('  capture M1    Capture current coverage as milestone M1 threshold');
    console.log('  check M2      Check coverage against previous milestone threshold');
    console.log('  status        Show all captured thresholds');
    console.log('  compare M1 M2 Compare two milestones');
    console.log('');
    console.log('Options:');
    console.log('  --json        JSON output');
    process.exit(0);
  }

  const command = args[0];

  if (command === 'status') {
    if (jsonMode) {
      console.log(JSON.stringify(listThresholds(), null, 2));
    } else {
      printStatus();
    }
  } else if (command === 'capture') {
    const milestone = args[1];
    if (!milestone) {
      console.error('Usage: capture <milestone>');
      process.exit(1);
    }
    const coverage = collectCoverage();
    if (!coverage) {
      console.error('Cannot collect coverage. Run tests with coverage first.');
      process.exit(1);
    }
    const saved = writeThreshold(milestone, coverage);
    if (jsonMode) {
      console.log(JSON.stringify(saved, null, 2));
    } else {
      console.log(`Captured coverage threshold for ${milestone}:`);
      console.log(
        `  Lines: ${coverage.lines}% | Functions: ${coverage.functions}% | Branches: ${coverage.branches}% | Statements: ${coverage.statements}%`,
      );
    }
  } else if (command === 'check') {
    const milestone = args[1];
    if (!milestone) {
      console.error('Usage: check <milestone>');
      process.exit(1);
    }
    const result = checkRatchet(milestone);
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.message);
      if (result.violations && result.violations.length > 0) {
        for (const v of result.violations) {
          console.log(`  FAIL: ${v.reason}`);
        }
      }
    }
    if (!result.passed) process.exit(1);
  } else if (command === 'compare') {
    const m1 = args[1],
      m2 = args[2];
    if (!m1 || !m2) {
      console.error('Usage: compare <milestone1> <milestone2>');
      process.exit(1);
    }
    const t1 = readThreshold(m1),
      t2 = readThreshold(m2);
    if (!t1) {
      console.error(`No threshold for ${m1}`);
      process.exit(1);
    }
    if (!t2) {
      console.error(`No threshold for ${m2}`);
      process.exit(1);
    }
    const comparison = { m1, m2, metrics: {} };
    for (const metric of ['lines', 'functions', 'branches', 'statements']) {
      comparison.metrics[metric] = {
        [m1]: t1.thresholds[metric],
        [m2]: t2.thresholds[metric],
        delta: Math.round((t2.thresholds[metric] - t1.thresholds[metric]) * 100) / 100,
      };
    }
    console.log(jsonMode ? JSON.stringify(comparison, null, 2) : JSON.stringify(comparison, null, 2));
  } else {
    console.error(`Unknown command: ${command}. Use --help.`);
    process.exit(1);
  }
}

module.exports = { collectCoverage, checkRatchet, readThreshold, writeThreshold, listThresholds, TOLERANCE };
