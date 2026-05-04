#!/usr/bin/env node

// Deterministic Step 04B issue-registry wrapper for cobolt-build.

const fs = require('node:fs');
const path = require('node:path');

const { projectExecutionLedger, syncBuildExecutionLedger } = require('../lib/cobolt-execution-ledger');

function normalizeMilestone(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'M1';
  return /^m\d+$/iu.test(raw) ? raw.toUpperCase() : raw;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = { command: 'run', cwd: process.cwd(), milestone: process.env.MILESTONE || 'M1', json: false };
  if (argv[0] && !argv[0].startsWith('-')) args.command = argv.shift();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cwd') args.cwd = path.resolve(argv[++i] || args.cwd);
    else if (arg === '--milestone') args.milestone = normalizeMilestone(argv[++i] || args.milestone);
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.command = 'help';
  }
  args.milestone = normalizeMilestone(args.milestone);
  return args;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function rel(cwd, filePath) {
  return path.relative(cwd, filePath).replace(/\\/g, '/');
}

function buildPaths(cwd, milestone) {
  const buildRoot = path.join(cwd, '_cobolt-output', 'latest', 'build');
  const buildDir = path.join(buildRoot, milestone);
  return {
    buildRoot,
    buildDir,
    checkpointsDir: path.join(buildRoot, 'checkpoints'),
    proofsDir: path.join(buildRoot, 'proofs'),
  };
}

function run(args = parseArgs(), options = {}) {
  if (args.command !== 'run') {
    return { ok: args.command === 'help', help: true };
  }

  const cwd = path.resolve(options.projectRoot || args.cwd || process.cwd());
  const milestone = normalizeMilestone(args.milestone);
  const paths = buildPaths(cwd, milestone);
  ensureDir(paths.buildDir);
  ensureDir(paths.checkpointsDir);
  ensureDir(paths.proofsDir);

  const requiredSidecars = [
    `${milestone}-wiring-check.json`,
    `${milestone}-api-contract-check.json`,
    `${milestone}-worker-lifecycle.json`,
    `${milestone}-illusion-report.json`,
  ];
  const presentSidecars = requiredSidecars.filter((file) => fs.existsSync(path.join(paths.buildDir, file)));
  if (!fs.existsSync(path.join(paths.buildDir, `${milestone}-illusion-report.json`))) {
    throw new Error(`${rel(cwd, path.join(paths.buildDir, `${milestone}-illusion-report.json`))} missing`);
  }

  const registryPath = path.join(paths.buildDir, `${milestone}-issues-registry.json`);
  const reportPath = path.join(paths.buildDir, `${milestone}-04b-rollup-report.json`);
  const { rollup } = options.rollupModule || require('./cobolt-build-tool-rollup');
  const report = rollup({
    dir: paths.buildDir,
    milestone,
    output: registryPath,
    reportOutput: reportPath,
    merge: true,
    json: true,
    dryRun: false,
  });
  writeJson(reportPath, report);

  const silentDropped = (report.sidecars || []).some(
    (sidecar) => sidecar.present && sidecar.parsed && sidecar.added === 0 && sidecar.note && sidecar.findings === 0,
  );
  const ok = report.ok === true && !silentDropped;
  const checkpoint = {
    checkpoint: 'build-issue-registry',
    milestone,
    status: ok ? 'passed' : 'failed',
    passed: ok,
    completedAt: new Date().toISOString(),
    registryPath: rel(cwd, registryPath),
    reportPath: rel(cwd, reportPath),
    totalIssues: report.summary?.totalIssuesAfter || 0,
    sidecarsFound: report.summary?.sidecarsFound || presentSidecars.length,
    silentDropped,
  };
  writeJson(path.join(paths.checkpointsDir, `${milestone}-04b-build-issue-registry.json`), checkpoint);
  writeJson(path.join(paths.checkpointsDir, '04b-build-issue-registry.json'), checkpoint);
  writeJson(path.join(paths.proofsDir, `${milestone}-04b-build-issue-registry.proof.json`), {
    step: '04b-build-issue-registry',
    status: ok ? 'passed' : 'failed',
    milestone,
    runtime: 'codex-cli',
    completedAt: new Date().toISOString(),
    commands_executed: [
      {
        command: `node tools/cobolt-build-tool-rollup.js --dir ${rel(cwd, paths.buildDir)} --milestone ${milestone} --output ${rel(cwd, registryPath)} --report-output ${rel(cwd, reportPath)} --merge --json`,
        exit_code: ok ? 0 : 2,
      },
    ],
    artifacts: [registryPath, reportPath].map((file) => rel(cwd, file)),
    evidence: { registry: rel(cwd, registryPath), report: rel(cwd, reportPath) },
  });
  syncBuildExecutionLedger(cwd, milestone, {
    checkpointPath: path.join(paths.checkpointsDir, `${milestone}-04b-build-issue-registry.json`),
    checkpointId: '04b-build-issue-registry',
  });
  projectExecutionLedger(cwd);

  return { ok, passed: ok, milestone, registryPath, reportPath, silentDropped, report };
}

function main() {
  const args = parseArgs();
  try {
    const result = run(args);
    if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else console.log(`Step 04B ${result.ok ? 'passed' : 'failed'} for ${result.milestone || args.milestone}`);
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    const result = { ok: false, error: err.message };
    if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else console.error(err.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { run, parseArgs, normalizeMilestone };
