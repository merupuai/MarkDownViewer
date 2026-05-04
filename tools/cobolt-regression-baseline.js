#!/usr/bin/env node

// CoBolt Regression Baseline — Cross-milestone regression detection
//
// Captures a test baseline at milestone completion. The regression gate hook
// uses these baselines to detect regressions before the next milestone starts.
//
// Usage:
//   node tools/cobolt-regression-baseline.js capture M1 --test-count 100 --pass-count 98 [--fail-count 2] [--exit-code 0] [--test-command "npm test"]
//   node tools/cobolt-regression-baseline.js check M2 --pass-count 90 --test-count 100
//   node tools/cobolt-regression-baseline.js list

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { atomicWriteJSON } = require('../lib/cobolt-atomic-write');

// ── Constants ────────────────────────────────────────────────

const REGRESSION_BLOCK_THRESHOLD = 0.05; // 5% regression triggers a block

// ── Path Resolution ──────────────────────────────────────────

const { paths: _paths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();

function baselinesDir(projectRoot) {
  const root = projectRoot || process.cwd();
  const p = typeof _paths === 'function' ? _paths(root) : null;
  if (p?.outputRoot) {
    return path.join(p.outputRoot, 'latest', 'build', 'baselines');
  }
  return path.join(root, '_cobolt-output', 'latest', 'build', 'baselines');
}

function baselineFile(milestone, projectRoot) {
  return path.join(baselinesDir(projectRoot), `${milestone}-baseline.json`);
}

// ── Milestone Number Extraction ──────────────────────────────

function milestoneNumber(milestone) {
  const m = String(milestone).match(/^M(\d+)$/);
  if (!m) return null;
  return parseInt(m[1], 10);
}

// ── Atomic Write ─────────────────────────────────────────────

function writeAtomicJson(filePath, data) {
  atomicWriteJSON(filePath, data, { mode: 0o600 });
}

// ── Core Functions ────────────────────────────────────────────

/**
 * Capture a test baseline for the given milestone.
 *
 * @param {string} milestone  - e.g. "M1"
 * @param {object} data       - { testCommand, testCount, passCount, failCount, exitCode, carryForward }
 * @param {object} [opts]     - { projectRoot }
 * @returns {object} The baseline object that was written
 */
function capture(milestone, data, opts = {}) {
  const { projectRoot } = opts;

  if (!milestone || !milestoneNumber(milestone)) {
    throw new Error(`Invalid milestone: "${milestone}" — must match ^M\\d+$`);
  }

  const testCount = Number(data.testCount ?? 0);
  const passCount = Number(data.passCount ?? 0);
  const failCount = Number(data.failCount ?? testCount - passCount);
  const exitCode = data.exitCode !== undefined ? Number(data.exitCode) : failCount > 0 ? 1 : 0;
  const testCommand = data.testCommand || 'npm test';

  // Stable content hash for output deduplication
  const hashInput = `${milestone}|${testCommand}|${testCount}|${passCount}|${failCount}`;
  const outputHash = crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 16);

  const baseline = {
    milestone,
    capturedAt: new Date().toISOString(),
    baseline: {
      testCommand,
      testCount,
      passCount,
      failCount,
      exitCode,
      outputHash,
    },
    carryForward: Array.isArray(data.carryForward) ? data.carryForward : [],
  };

  const fp = baselineFile(milestone, projectRoot);
  writeAtomicJson(fp, baseline);

  return baseline;
}

/**
 * Check for regression against the previous milestone's baseline.
 *
 * For M1: returns null (no previous baseline to compare against).
 * For M2+: reads M{n-1} baseline and computes regression rate.
 *
 * @param {string} currentMilestone - e.g. "M2"
 * @param {object} currentResults   - { passCount, testCount }
 * @param {object} [opts]           - { projectRoot }
 * @returns {object|null}
 *   null if no previous baseline (M1), otherwise:
 *   { prevMilestone, currentMilestone, prevPassCount, currentPassCount,
 *     regressionRate, shouldBlock, threshold }
 */
function checkRegression(currentMilestone, currentResults, opts = {}) {
  const { projectRoot } = opts;

  const currentN = milestoneNumber(currentMilestone);
  if (currentN === null) {
    throw new Error(`Invalid milestone: "${currentMilestone}"`);
  }

  // M1 has no previous baseline
  if (currentN <= 1) {
    return null;
  }

  const prevMilestone = `M${currentN - 1}`;
  const prevFile = baselineFile(prevMilestone, projectRoot);

  // No previous baseline — cannot check (non-blocking, return null)
  if (!fs.existsSync(prevFile)) {
    return null;
  }

  let prevBaseline;
  try {
    prevBaseline = JSON.parse(fs.readFileSync(prevFile, 'utf8'));
  } catch {
    return null;
  }

  const prevPassCount = prevBaseline.baseline.passCount;
  const currentPassCount = Number(currentResults.passCount ?? 0);

  // Regression rate: how much the pass count dropped as a fraction of the previous pass count
  // max(0, ...) ensures we never report negative regression (improvement is just 0)
  let regressionRate = 0;
  if (prevPassCount > 0) {
    regressionRate = Math.max(0, 1 - currentPassCount / prevPassCount);
  }

  const shouldBlock = regressionRate > REGRESSION_BLOCK_THRESHOLD;

  return {
    prevMilestone,
    currentMilestone,
    prevPassCount,
    currentPassCount,
    regressionRate,
    shouldBlock,
    threshold: REGRESSION_BLOCK_THRESHOLD,
  };
}

/**
 * List all baseline files in the baselines directory.
 *
 * @param {object} [opts] - { projectRoot }
 * @returns {Array} Parsed baseline objects, sorted by milestone number ascending
 */
function listBaselines(opts = {}) {
  const { projectRoot } = opts;
  const dir = baselinesDir(projectRoot);

  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('-baseline.json'));
  const baselines = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), 'utf8');
      baselines.push(JSON.parse(content));
    } catch {
      // Skip malformed files
    }
  }

  // Sort by milestone number ascending
  baselines.sort((a, b) => {
    const na = milestoneNumber(a.milestone) ?? 0;
    const nb = milestoneNumber(b.milestone) ?? 0;
    return na - nb;
  });

  return baselines;
}

// ── CLI ───────────────────────────────────────────────────────

function usage() {
  return (
    'Usage:\n' +
    '  cobolt-regression-baseline.js capture <milestone> --test-count N --pass-count N [--fail-count N] [--exit-code N] [--test-command "cmd"]\n' +
    '  cobolt-regression-baseline.js check <milestone> --pass-count N --test-count N\n' +
    '  cobolt-regression-baseline.js list'
  );
}

function parseArgs(argv) {
  const args = { help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') {
      args.help = true;
    } else if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      args[key] = val;
    } else {
      positional.push(argv[i]);
    }
  }
  return { args, positional };
}

function main(argv) {
  const rawArgs = argv.slice(2);
  if (rawArgs.length === 0) {
    console.error(usage());
    return 1;
  }

  const { args, positional } = parseArgs(rawArgs);
  const [command, milestone] = positional;

  if (command === 'help' || args.help) {
    console.log(usage());
    return 0;
  }

  switch (command) {
    case 'capture': {
      if (!milestone) {
        console.error('Usage: cobolt-regression-baseline.js capture <milestone> --test-count N --pass-count N');
        return 1;
      }
      const result = capture(
        milestone,
        {
          testCommand: args['test-command'] || 'npm test',
          testCount: parseInt(args['test-count'] ?? '0', 10),
          passCount: parseInt(args['pass-count'] ?? '0', 10),
          failCount: args['fail-count'] !== undefined ? parseInt(args['fail-count'], 10) : undefined,
          exitCode: args['exit-code'] !== undefined ? parseInt(args['exit-code'], 10) : undefined,
        },
        {},
      );
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }

    case 'check': {
      if (!milestone) {
        console.error('Usage: cobolt-regression-baseline.js check <milestone> --pass-count N --test-count N');
        return 1;
      }
      const result = checkRegression(
        milestone,
        {
          passCount: parseInt(args['pass-count'] ?? '0', 10),
          testCount: parseInt(args['test-count'] ?? '0', 10),
        },
        {},
      );
      if (result === null) {
        console.log(JSON.stringify({ message: `No previous baseline for ${milestone} — skipping regression check` }));
        return 0;
      }
      console.log(JSON.stringify(result, null, 2));
      if (result.shouldBlock) {
        console.error(
          `[cobolt-regression-baseline] REGRESSION DETECTED: ${(result.regressionRate * 100).toFixed(1)}% regression ` +
            `(prev=${result.prevPassCount} passing, now=${result.currentPassCount} passing). ` +
            `Threshold: ${REGRESSION_BLOCK_THRESHOLD * 100}%`,
        );
        return 1;
      }
      return 0;
    }

    case 'list': {
      const all = listBaselines({});
      if (all.length === 0) {
        console.log('No baselines found.');
      } else {
        console.log(`Found ${all.length} baseline(s):`);
        for (const b of all) {
          console.log(
            `  ${b.milestone}  captured=${b.capturedAt}  pass=${b.baseline.passCount}/${b.baseline.testCount}`,
          );
        }
      }
      return 0;
    }

    default: {
      console.error(usage());
      return 1;
    }
  }
}

// Only run CLI when invoked directly
if (require.main === module) {
  process.exit(main(process.argv));
}

// ── Exports ───────────────────────────────────────────────────

module.exports = {
  capture,
  checkRegression,
  listBaselines,
  _testOnly: {
    REGRESSION_BLOCK_THRESHOLD,
  },
};
