#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const domainIrPack = require('./cobolt-domain-ir-pack');

function printUsage(stream = process.stdout) {
  stream.write(
    `${[
      'Usage:',
      '  cobolt-build-ir-coverage-gate.js check --milestone M1 [--root <path>] [--json]',
      '  cobolt-build-ir-coverage-gate.js --help',
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

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function relative(projectRoot, filePath) {
  return path.relative(projectRoot, filePath).replace(/\\/g, '/');
}

function buildDir(projectRoot, milestone) {
  return path.join(projectRoot, '_cobolt-output', 'latest', 'build', milestone);
}

function withProjectRoot(projectRoot, callback) {
  const previous = process.cwd();
  process.chdir(projectRoot);
  try {
    return callback();
  } finally {
    process.chdir(previous);
  }
}

function runCheck(projectRoot, milestone, options = {}) {
  const root = path.resolve(projectRoot || process.cwd());
  const normalizedMilestone = normalizeMilestone(milestone);
  if (!normalizedMilestone) return { ok: false, reason: 'milestone-required' };

  const result = withProjectRoot(root, () => {
    const packs = domainIrPack.detectPacks();
    if (packs.length === 0) {
      return {
        ok: true,
        skipped: true,
        reason: 'no-domain-ir-packs-matched',
        packsMatched: [],
        totalMandatoryIRs: 0,
        missing: [],
        criticalMissing: [],
      };
    }

    const verdict = domainIrPack.verifyCoverage();
    return {
      ok: verdict.ok === true,
      skipped: false,
      reason: verdict.ok ? 'domain-ir-covered' : 'domain-ir-coverage-missing',
      packsMatched: verdict.packsMatched || packs.map((entry) => ({ domain: entry.domain, reasons: entry.reasons })),
      totalMandatoryIRs: verdict.totalMandatoryIRs || 0,
      missing: verdict.missing || [],
      criticalMissing: verdict.criticalMissing || [],
    };
  });

  const artifactPath = path.join(buildDir(root, normalizedMilestone), `${normalizedMilestone}-ir-coverage-gate.json`);
  const report = {
    generatedAt: new Date().toISOString(),
    tool: 'cobolt-build-ir-coverage-gate',
    milestone: normalizedMilestone,
    ok: result.ok,
    skipped: result.skipped === true,
    reason: result.reason,
    packsMatched: result.packsMatched,
    totalMandatoryIRs: result.totalMandatoryIRs,
    missing: result.missing,
    criticalMissing: result.criticalMissing,
    evidence: {
      implicitRequirements: relative(
        root,
        path.join(root, '_cobolt-output', 'latest', 'planning', 'implicit-requirements.md'),
      ),
      domainIrBundle: relative(root, path.join(root, '_cobolt-output', 'latest', 'planning', 'domain-ir-bundle.json')),
    },
  };

  if (options.write !== false) writeJson(artifactPath, report);
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
