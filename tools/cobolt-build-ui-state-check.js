#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const frontendCompleteness = require('./cobolt-frontend-completeness');

function printUsage(stream = process.stdout) {
  stream.write(
    `${[
      'Usage:',
      '  cobolt-build-ui-state-check.js check --milestone M1 [--root <path>] [--json]',
      '  cobolt-build-ui-state-check.js --help',
    ].join('\n')}\n`,
  );
}

function normalizeMilestone(value) {
  const match = String(value || '')
    .trim()
    .match(/^M?(\d+)$/i);
  return match ? `M${Number.parseInt(match[1], 10)}` : null;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    command: null,
    root: process.cwd(),
    milestone: null,
    json: false,
    help: false,
    write: true,
  };

  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--no-write') args.write = false;
    else if (arg === '--root') {
      args.root = argv[i + 1] || args.root;
      i += 1;
    } else if (arg.startsWith('--root=')) args.root = arg.slice('--root='.length);
    else if (arg === '--milestone' || arg === '-m') {
      args.milestone = normalizeMilestone(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--milestone=')) args.milestone = normalizeMilestone(arg.slice('--milestone='.length));
    else positional.push(arg);
  }

  args.command = positional[0] || null;
  return args;
}

function buildDir(projectRoot, milestone) {
  return path.join(projectRoot, '_cobolt-output', 'latest', 'build', milestone);
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, ''));
  } catch {
    return null;
  }
}

function normalizeLayerStatus(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function layerPassed(value) {
  return ['passed', 'warning', 'skipped-no-ui', 'not_applicable_native_desktop'].includes(normalizeLayerStatus(value));
}

function relative(projectRoot, filePath) {
  return path.relative(projectRoot, filePath).replace(/\\/g, '/');
}

function runCheck(projectRoot, milestone, options = {}) {
  const root = path.resolve(projectRoot || process.cwd());
  const normalizedMilestone = normalizeMilestone(milestone);
  if (!normalizedMilestone) {
    return { ok: false, reason: 'milestone-required' };
  }

  const completeness = frontendCompleteness.run(root, { writeReport: false });
  const validationPath = path.join(
    root,
    '_cobolt-output',
    'latest',
    'build',
    normalizedMilestone,
    `${normalizedMilestone}-validation-results.json`,
  );
  const validation = readJson(validationPath);
  const l4bStatus = validation?.layers?.L4b_ui_integrity?.status || null;
  const l4Status = validation?.layers?.L4_playwright_ui?.status || null;
  const uatVerdictPath = path.join(root, '_cobolt-output', 'latest', 'uat', `${normalizedMilestone}-uat-verdict.json`);
  const chromeEvidencePath = path.join(root, '_cobolt-output', 'latest', 'uat', 'chrome-devtools-evidence.json');

  let ok = false;
  let reason = 'planning-ui-state-gaps';
  if (completeness.uiRequired === false) {
    ok = true;
    reason = 'ui-not-required';
  } else if (completeness.passed !== true) {
    ok = false;
    reason = 'planning-ui-state-gaps';
  } else if (validation && (!layerPassed(l4bStatus) || (l4Status && !layerPassed(l4Status)))) {
    ok = false;
    reason = 'runtime-ui-verdict-failed';
  } else {
    ok = true;
    reason = 'ui-state-covered';
  }

  const artifactPath = path.join(buildDir(root, normalizedMilestone), `${normalizedMilestone}-ui-state-check.json`);
  const report = {
    generatedAt: new Date().toISOString(),
    tool: 'cobolt-build-ui-state-check',
    milestone: normalizedMilestone,
    ok,
    reason,
    uiRequired: completeness.uiRequired === true,
    skipped: completeness.skipped === true,
    planningVerdict: {
      passed: completeness.passed === true,
      score: typeof completeness.score === 'number' ? completeness.score : null,
      findings: Array.isArray(completeness.findings) ? completeness.findings : [],
      issues: Array.isArray(completeness.issues) ? completeness.issues : [],
    },
    validationVerdict: validation
      ? {
          overallStatus: validation.overallStatus || null,
          l4bUiIntegrity: l4bStatus,
          l4BrowserUi: l4Status,
          validationPath: relative(root, validationPath),
        }
      : null,
    evidence: {
      uxPlanningArtifact: relative(
        root,
        path.join(root, '_cobolt-output', 'latest', 'planning', 'frontend-completeness-report.json'),
      ),
      uatVerdict: fs.existsSync(uatVerdictPath) ? relative(root, uatVerdictPath) : null,
      chromeDevtoolsEvidence: fs.existsSync(chromeEvidencePath) ? relative(root, chromeEvidencePath) : null,
    },
  };

  if (options.write !== false) {
    writeJson(artifactPath, report);
  }

  return {
    ...report,
    artifactPath,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage(process.stdout);
    return 0;
  }
  if (!args.command) {
    printUsage(process.stderr);
    return 1;
  }
  if (args.command !== 'check') {
    printUsage(process.stderr);
    return 1;
  }
  if (!args.milestone) {
    process.stderr.write('Missing --milestone M{n}.\n');
    return 1;
  }

  const result = runCheck(args.root, args.milestone, { write: args.write });
  if (!result.ok && result.reason === 'milestone-required') {
    process.stderr.write('Missing --milestone M{n}.\n');
    return 1;
  }

  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${result.artifactPath}\n`);
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  normalizeMilestone,
  parseArgs,
  runCheck,
};
