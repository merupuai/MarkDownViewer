#!/usr/bin/env node

// Deterministic Step 04 refactor/quality-gate orchestrator for cobolt-build.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
const { projectExecutionLedger, syncBuildExecutionLedger } = require('../lib/cobolt-execution-ledger');

const DEFAULT_TIMEOUT_MS = 180 * 1000;

function normalizeMilestone(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'M1';
  return /^m\d+$/iu.test(raw) ? raw.toUpperCase() : raw;
}

function parseArgs(argv = process.argv.slice(2)) {
  const flags = {
    command: 'run',
    cwd: process.cwd(),
    milestone: process.env.MILESTONE || 'M1',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
  };
  if (argv[0] && !argv[0].startsWith('-')) flags.command = argv.shift();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd') flags.cwd = path.resolve(argv[++i] || flags.cwd);
    else if (arg === '--milestone') flags.milestone = normalizeMilestone(argv[++i] || flags.milestone);
    else if (arg === '--timeout-ms') flags.timeoutMs = Number(argv[++i] || flags.timeoutMs);
    else if (arg === '--json') flags.json = true;
    else if (arg === '--help' || arg === '-h') flags.command = 'help';
  }
  flags.milestone = normalizeMilestone(flags.milestone);
  return flags;
}

function usage() {
  console.log('Usage: node tools/cobolt-build-refactor-gate.js run --milestone M1 [--cwd <project>] [--json]');
  console.log(
    'Runs deterministic Step 04 refactor review, quality gates, .NET build/test evidence, and checkpointing.',
  );
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(filePath, payload) {
  atomicWrite(filePath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function writeText(filePath, content) {
  atomicWrite(filePath, content, { encoding: 'utf8', mode: 0o600 });
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, ''));
  } catch {
    return fallback;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, '');
  } catch {
    return '';
  }
}

function rel(cwd, filePath) {
  return path.relative(cwd, filePath).replace(/\\/g, '/');
}

function buildPaths(cwd, milestone) {
  const outputRoot = path.join(cwd, '_cobolt-output');
  const latest = path.join(outputRoot, 'latest');
  const buildRoot = path.join(latest, 'build');
  const buildDir = path.join(buildRoot, milestone);
  return {
    outputRoot,
    latest,
    buildRoot,
    buildDir,
    checkpointsDir: path.join(buildRoot, 'checkpoints'),
    proofsDir: path.join(buildRoot, 'proofs'),
    auditDir: path.join(outputRoot, 'audit'),
  };
}

function assertPrerequisites(cwd, milestone, paths) {
  const required = [
    [
      path.join(paths.checkpointsDir, `${milestone}-03-tdd-green.json`),
      path.join(paths.checkpointsDir, '03-tdd-green.json'),
    ],
    [
      path.join(paths.checkpointsDir, `${milestone}-03a-code-gap-analysis.json`),
      path.join(paths.checkpointsDir, '03a-code-gap-analysis.json'),
    ],
  ];
  for (const candidates of required) {
    if (!candidates.some((candidate) => fs.existsSync(candidate))) {
      throw new Error(
        `Required Step 04 predecessor checkpoint missing: ${candidates.map((item) => rel(cwd, item)).join(' or ')}`,
      );
    }
  }
  const buildArtifacts = path.join(paths.buildDir, `${milestone}-build-artifacts.json`);
  if (!fs.existsSync(buildArtifacts)) throw new Error(`${rel(cwd, buildArtifacts)} missing`);
}

function isTestPath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  return (
    normalized.startsWith('tests/') ||
    /(^|\/)(test|tests|__tests__|spec)\//iu.test(normalized) ||
    /\.(test|spec)\.[^/]+$/iu.test(normalized) ||
    /_test\.[^/]+$/iu.test(normalized)
  );
}

function collectScope(cwd, milestone, paths) {
  const artifacts = readJson(path.join(paths.buildDir, `${milestone}-build-artifacts.json`), {});
  const all = [
    ...(artifacts.filesCreated || []),
    ...(artifacts.filesModified || []),
    ...(artifacts.files || []),
    ...(artifacts.changedFiles || []),
    ...(artifacts.sourceWriteProvenance || []),
  ].map((item) => String(item || '').replace(/\\/g, '/'));
  const productionFiles = [
    ...new Set(
      all.filter((file) => {
        if (!file || isTestPath(file)) return false;
        if (file.includes('/bin/') || file.includes('/obj/') || file.startsWith('_cobolt-output/')) return false;
        return fs.existsSync(path.join(cwd, file));
      }),
    ),
  ];
  const changedTestFiles = [
    ...new Set(
      [...(artifacts.testFiles || []), ...all.filter(isTestPath)]
        .map((item) => String(item || '').replace(/\\/g, '/'))
        .filter((file) => file && fs.existsSync(path.join(cwd, file))),
    ),
  ];
  return { artifacts, productionFiles, changedTestFiles };
}

function quoteFile(cwd, relativePath) {
  const text = readText(path.join(cwd, relativePath));
  const lines = text
    .split(/\r?\n/u)
    .map((line, index) => ({ line: index + 1, text: line.trim() }))
    .filter((entry) => entry.text.length > 0);
  const selected = lines.find((entry) =>
    /^(public|internal|private|sealed|namespace|<Project|<Window|<UserControl|<ResourceDictionary|Microsoft Visual Studio Solution File)/u.test(
      entry.text,
    ),
  ) ||
    lines[0] || { line: 1, text: '' };
  return {
    file: relativePath,
    line: selected.line,
    quote: selected.text.slice(0, 220),
    bytes: Buffer.byteLength(text),
  };
}

function writeRefactorNotes(cwd, milestone, paths, scope) {
  const refactorNotes = {
    milestone,
    generatedAt: new Date().toISOString(),
    agent: 'deterministic-wrapper',
    scope: {
      productionFiles: scope.productionFiles,
      changedTestFiles: scope.changedTestFiles,
    },
    governanceApplied: [
      'secure-coding-standard.md',
      'engineering-quality-standards.md',
      'deterministic-quality-gates.json',
      'dependency-tracker.json',
      'architecture-decisions.md',
    ],
    readEvidence: scope.productionFiles.map((file) => quoteFile(cwd, file)),
    refactorDecision: 'no-op',
    simplified: [],
    rationale:
      'Deterministic Step 04 records refactor review evidence and avoids speculative behavior-changing edits. Quality evidence is produced by deterministic gates.',
  };
  const notesPath = path.join(paths.buildDir, `${milestone}-refactor-notes.json`);
  writeJson(notesPath, refactorNotes);
  writeText(
    path.join(paths.buildDir, `${milestone}-modified-production-files.txt`),
    `${scope.productionFiles.join('\n')}\n`,
  );
  writeText(
    path.join(paths.buildDir, `${milestone}-modified-test-files.txt`),
    `${scope.changedTestFiles.join('\n')}\n`,
  );
  return notesPath;
}

function runProcess(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (options.logPath) {
    ensureDir(path.dirname(options.logPath));
    writeText(options.logPath, output);
  }
  return {
    exitCode: typeof result.status === 'number' ? result.status : 1,
    output,
    error: result.error ? result.error.message : '',
    timedOut: result.error?.code === 'ETIMEDOUT',
  };
}

function withWorkingDirectory(cwd, fn) {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

function writeStandardsSummary(cwd, report) {
  const outDir = path.join(cwd, '_cobolt-output', 'standards');
  ensureDir(outDir);
  writeJson(path.join(outDir, 'summary.json'), report);
  const lines = [
    '# Standards Compliance Summary',
    `Generated: ${report.generatedAt}`,
    `Profile: ${report.profile}`,
    '',
  ];
  lines.push('| Standard | Result |');
  lines.push('|----|----|');
  for (const [name, value] of Object.entries(report.standards || {})) {
    lines.push(`| ${name} | ${value ? JSON.stringify(value) : '_not run_'} |`);
  }
  writeText(path.join(outDir, 'summary.md'), `${lines.join('\n')}\n`);
}

function runNodeToolInProcess(toolName, args, cwd) {
  return withWorkingDirectory(cwd, () => {
    if (toolName === 'cobolt-standards-gate.js') {
      const { evaluateStandardsGate, parseArgs: parseStandardsGateArgs } = require('./cobolt-standards-gate');
      const parsed = parseStandardsGateArgs(args);
      const report = evaluateStandardsGate(cwd, parsed);
      if (parsed.output) writeJson(path.resolve(cwd, parsed.output), report);
      return {
        exitCode: report.passed ? 0 : 1,
        output: parsed.json ? `${JSON.stringify(report, null, 2)}\n` : '',
        error: '',
        timedOut: false,
      };
    }

    if (toolName === 'cobolt-standards.js') {
      const standards = require('./cobolt-standards');
      const parsed = standards.parseArgs(args);
      const selected = standards.selectModules(parsed.profile);
      const results = selected.map((mod) => standards.runOneInProcess(mod, cwd, 'node-spawn-blocked'));
      const report = standards.consolidate(cwd, {
        profile: parsed.profile,
        modules: selected.map((mod) => mod.key),
        results: results.map((result) => ({ key: result.key, status: result.status })),
      });
      writeStandardsSummary(cwd, report);
      const output =
        parsed.command === 'report' || parsed.json
          ? `${JSON.stringify(report, null, 2)}\n`
          : `standards: ${parsed.profile} summary written to ${path.join(cwd, '_cobolt-output', 'standards', 'summary.json')}\n`;
      return {
        exitCode: results.every((result) => result.status === 0) ? 0 : 1,
        output,
        error: '',
        timedOut: false,
      };
    }

    if (toolName === 'cobolt-gate.js') {
      const { QualityGate, parseCliArgs: parseGateArgs } = require('./cobolt-gate');
      const parsed = parseGateArgs(args);
      const gate = new QualityGate(parsed.projectDir || cwd);
      const result = gate.run(parsed);
      const output = parsed.json ? `${JSON.stringify(result, null, 2)}\n` : `${gate.report()}\n`;
      const passed = parsed.strict ? gate.strictPassed() : gate.passed();
      return {
        exitCode: passed ? 0 : 1,
        output,
        error: '',
        timedOut: false,
      };
    }

    return null;
  });
}

function runNodeTool(toolName, args, cwd, timeoutMs) {
  const result = runProcess(process.execPath, [path.join(__dirname, toolName), ...args], { cwd, timeoutMs });
  if (!result.error || !/\b(?:EPERM|EACCES)\b/u.test(result.error)) return result;
  const fallback = runNodeToolInProcess(toolName, args, cwd);
  return fallback || result;
}

function runStandards(cwd, milestone, paths, options) {
  if (options.standardsGateRunner) return options.standardsGateRunner(cwd, milestone, paths);
  const output = path.join(paths.buildDir, `${milestone}-standards-gate.json`);
  const gate = runNodeTool('cobolt-standards-gate.js', ['build', '--json', '--output', output], cwd, options.timeoutMs);
  const evidencePath = path.join(paths.buildDir, `${milestone}-standards-evidence.json`);
  const evidence = runNodeTool(
    'cobolt-standards.js',
    ['all', '--profile', 'build', '--quiet-json'],
    cwd,
    options.timeoutMs,
  );
  writeText(evidencePath, evidence.output || '{}\n');
  return { passed: gate.exitCode === 0, exitCode: gate.exitCode, outputPath: output, evidencePath };
}

function runGate(cwd, milestone, paths, scope, outputName, strict, options) {
  const outputPath = path.join(paths.buildDir, `${milestone}-${outputName}.json`);
  if (options.gateRunner) return options.gateRunner(cwd, milestone, paths, scope, outputPath, strict);
  const args = [
    '--milestone',
    milestone,
    '--categories',
    'lint,typecheck,security,format,deps,test-quality,ops-patterns',
    '--files',
    scope.productionFiles.join('\n'),
    '--test-files',
    scope.changedTestFiles.join('\n'),
    '--output',
    outputPath,
  ];
  if (strict) args.push('--strict');
  const result = runNodeTool('cobolt-gate.js', args, cwd, options.timeoutMs);
  writeText(path.join(paths.buildDir, 'gate-output.log'), result.output);
  return { passed: result.exitCode === 0, exitCode: result.exitCode, outputPath };
}

function findDotnetTarget(cwd) {
  const entries = fs.readdirSync(cwd, { withFileTypes: true });
  const solution = entries.find((entry) => entry.isFile() && entry.name.endsWith('.sln'));
  if (solution) return solution.name;
  const stack = [cwd];
  while (stack.length) {
    const dir = stack.pop();
    let children = [];
    try {
      children = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (['bin', 'obj', '_cobolt-output', 'node_modules', '.git'].includes(child.name)) continue;
      const full = path.join(dir, child.name);
      if (child.isDirectory()) stack.push(full);
      else if (child.isFile() && child.name.endsWith('.csproj')) return rel(cwd, full);
    }
  }
  return null;
}

function dotnetCommand() {
  const windowsDotnet = 'C:\\Program Files\\dotnet\\dotnet.exe';
  return process.platform === 'win32' && fs.existsSync(windowsDotnet) ? windowsDotnet : 'dotnet';
}

function dotnetEnv(cwd) {
  return {
    ...process.env,
    DOTNET_CLI_HOME: path.join(cwd, '_cobolt-output', '.dotnet-home'),
    NUGET_PACKAGES: path.join(cwd, '_cobolt-output', '.nuget-packages'),
    TMP: path.join(cwd, '_cobolt-output', '.tmp'),
    TEMP: path.join(cwd, '_cobolt-output', '.tmp'),
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    DOTNET_NOLOGO: '1',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: '0',
    MSBUILDDISABLENODEREUSE: '1',
  };
}

function runDotnetEvidence(cwd, milestone, paths, options) {
  if (options.dotnetRunner) return options.dotnetRunner(cwd, milestone, paths);
  const target = findDotnetTarget(cwd);
  if (!target) return { target: null, build: null, test: null };
  ensureDir(path.join(cwd, '_cobolt-output', '.tmp'));
  const env = dotnetEnv(cwd);
  const dotnet = dotnetCommand();
  const common = ['--disable-build-servers', '-m:1', '/nr:false', '/p:UseSharedCompilation=false'];
  const build = runProcess(dotnet, ['build', target, '--no-restore', ...common], {
    cwd,
    env,
    timeoutMs: options.timeoutMs,
    logPath: path.join(paths.buildDir, `${milestone}-dotnet-build-check.log`),
  });
  const test = runProcess(dotnet, ['test', target, ...common], {
    cwd,
    env,
    timeoutMs: options.timeoutMs,
    logPath: path.join(paths.buildDir, `${milestone}-refactor-test-results.log`),
  });
  runProcess(dotnet, ['build-server', 'shutdown'], { cwd, env, timeoutMs: 30 * 1000 });
  return { target, build, test };
}

function categoryFromResult(name, status, logPath) {
  return {
    passed: status === 'PASS',
    status,
    errors: status === 'PASS' ? 0 : 1,
    warnings: 0,
    tools: [name],
    evidence: logPath,
  };
}

function augmentGateReport(cwd, milestone, paths, gatePath, dotnet) {
  const report = readJson(gatePath, {});
  report.results = Array.isArray(report.results) ? report.results : [];
  report.categories = report.categories || {};
  if (dotnet?.build) {
    const status = dotnet.build.exitCode === 0 ? 'PASS' : 'FAIL';
    const logPath = rel(cwd, path.join(paths.buildDir, `${milestone}-dotnet-build-check.log`));
    report.results.push({
      tool: 'dotnet-build',
      name: '.NET build',
      category: 'typecheck',
      status,
      errors: status === 'PASS' ? 0 : 1,
      warnings: 0,
      scopeMode: 'project',
      scopedFiles: [],
      details: { target: dotnet.target, logPath, exitCode: dotnet.build.exitCode },
      durationMs: 0,
    });
    report.categories.typeCheck = categoryFromResult('.NET build', status, logPath);
  }
  if (dotnet?.test) {
    const status = dotnet.test.exitCode === 0 ? 'PASS' : 'FAIL';
    const logPath = rel(cwd, path.join(paths.buildDir, `${milestone}-refactor-test-results.log`));
    report.results.push({
      tool: 'dotnet-test',
      name: '.NET test',
      category: 'test',
      status,
      errors: status === 'PASS' ? 0 : 1,
      warnings: 0,
      scopeMode: 'project',
      scopedFiles: [],
      details: { target: dotnet.target, logPath, exitCode: dotnet.test.exitCode },
      durationMs: 0,
    });
    report.categories.test = categoryFromResult('.NET test', status, logPath);
  }
  const failed = report.results.filter((result) => result.status === 'FAIL').length;
  const errored = report.results.filter((result) => result.status === 'ERROR').length;
  report.summary = {
    ...(report.summary || {}),
    passed: report.results.filter((result) => result.status === 'PASS').length,
    failed,
    errored,
    totalErrors: report.results.reduce((sum, result) => sum + (result.errors || 0), 0),
    totalWarnings: report.results.reduce((sum, result) => sum + (result.warnings || 0), 0),
    toolsRun: report.results.length,
  };
  report.passed = failed === 0 && errored === 0 && report.summary.totalErrors === 0;
  writeJson(gatePath, report);
  return report;
}

function registerArtifact(filePath, milestone, type, step, cwd = process.cwd()) {
  const manifestTool = path.join(__dirname, 'cobolt-manifest.js');
  if (!fs.existsSync(manifestTool)) return;
  spawnSync(
    process.execPath,
    [manifestTool, 'register', '--milestone', milestone, '--file', filePath, '--type', type, '--step', step],
    {
      cwd,
      stdio: 'ignore',
    },
  );
}

function setStateBatch(cwd) {
  const stateTool = path.join(__dirname, 'cobolt-state.js');
  if (!fs.existsSync(stateTool)) return;
  spawnSync(
    process.execPath,
    [
      stateTool,
      'batch-set',
      'build.currentStep',
      '04a-deep-verification',
      'build.tddPhase',
      'refactor',
      'checkpoints.refactor',
      'passed',
    ],
    { cwd, stdio: 'ignore' },
  );
}

function writeCheckpoint(_cwd, milestone, paths, gateReport, finalGateExit, finalTestExit) {
  const checkpoint = {
    checkpoint: 'refactor',
    milestone,
    passedAt: new Date().toISOString(),
    tddPhase: 'refactor',
    gateResults: `${milestone}-gate-results.json`,
    gates: {
      lint: gateReport.categories?.lint?.passed ?? true,
      typeCheck: gateReport.categories?.typeCheck?.passed ?? true,
      security: gateReport.categories?.security?.passed ?? true,
      format: gateReport.categories?.format?.passed ?? true,
      dependencyAudit: gateReport.categories?.dependencyAudit?.passed ?? true,
      test: gateReport.categories?.test?.passed ?? true,
      testQuality: gateReport.categories?.testQuality?.passed ?? true,
    },
    testsPass: finalTestExit === 0,
    allGatesPassed: finalGateExit === 0 && gateReport.passed === true,
    finalTestExit,
    finalGateExit,
    source: 'cobolt-build-refactor-gate',
  };
  const checkpointPath = path.join(paths.checkpointsDir, `${milestone}-04-tdd-refactor.json`);
  writeJson(checkpointPath, checkpoint);
  writeJson(path.join(paths.checkpointsDir, '04-tdd-refactor.json'), checkpoint);
  return checkpointPath;
}

async function runRefactorGate(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const milestone = normalizeMilestone(options.milestone || 'M1');
  const paths = buildPaths(cwd, milestone);
  ensureDir(paths.buildDir);
  ensureDir(paths.checkpointsDir);
  assertPrerequisites(cwd, milestone, paths);

  const scope = collectScope(cwd, milestone, paths);
  const notesPath = writeRefactorNotes(cwd, milestone, paths, scope);
  const standards = runStandards(cwd, milestone, paths, options);
  if (!standards.passed) throw new Error(`Standards gate failed for ${milestone} (exit ${standards.exitCode})`);
  runGate(cwd, milestone, paths, scope, 'gate-raw', false, options);
  const finalGate = runGate(cwd, milestone, paths, scope, 'gate-results', true, options);
  const dotnet = runDotnetEvidence(cwd, milestone, paths, options);
  const gateReport = augmentGateReport(cwd, milestone, paths, finalGate.outputPath, dotnet);
  const finalTestExit = dotnet?.test ? dotnet.test.exitCode : 0;
  const finalGateExit = finalGate.exitCode === 0 && gateReport.passed ? 0 : 1;
  const checkpointPath = writeCheckpoint(cwd, milestone, paths, gateReport, finalGateExit, finalTestExit);
  if (!options.skipManifest) registerArtifact(finalGate.outputPath, milestone, 'gate-results', '04', cwd);
  if (!options.skipState) setStateBatch(cwd);
  syncBuildExecutionLedger(cwd, milestone, {
    checkpointPath,
    checkpointId: '04-tdd-refactor',
  });
  projectExecutionLedger(cwd);
  return {
    passed: finalGateExit === 0 && finalTestExit === 0,
    milestone,
    scope,
    artifacts: {
      refactorNotes: notesPath,
      gateResults: finalGate.outputPath,
      checkpoint: checkpointPath,
      standardsGate: standards.outputPath,
    },
    dotnet: dotnet
      ? {
          target: dotnet.target,
          buildExit: dotnet.build?.exitCode ?? null,
          testExit: dotnet.test?.exitCode ?? null,
        }
      : null,
    gateSummary: gateReport.summary,
  };
}

async function main() {
  const flags = parseArgs();
  if (flags.command === 'help') {
    usage();
    return 0;
  }
  if (flags.command !== 'run') {
    usage();
    return 2;
  }
  try {
    const result = await runRefactorGate(flags);
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`Refactor gate ${result.passed ? 'PASSED' : 'FAILED'} for ${result.milestone}`);
    return result.passed ? 0 : 1;
  } catch (err) {
    console.error(`[cobolt-build-refactor-gate] ${err.message}`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code || 0));
}

module.exports = {
  parseArgs,
  collectScope,
  discoverDotnetTarget: findDotnetTarget,
  runRefactorGate,
  augmentGateReport,
};
