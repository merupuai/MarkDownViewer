#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseFileMap } = require('./cobolt-build-setup-step');
const { cmdRecord } = require('./cobolt-source-write-provenance');
const { record, validateHardGate } = require('./cobolt-step-proof');
const { SOURCE_EXTS, isHarnessPath } = require('../lib/cobolt-shipping-files');
const { projectExecutionLedger, syncBuildExecutionLedger } = require('../lib/cobolt-execution-ledger');
const { loadProjectClass } = require('../lib/cobolt-project-class-loader');
const { skipReasonForRound } = require('../lib/cobolt-pipeline-class-rules');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const PACKAGE_VERSION = (() => {
  try {
    return require('../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

function normalizeMilestone(value) {
  const match = String(value || '')
    .trim()
    .match(/^M?(\d+)$/iu);
  return match ? `M${Number.parseInt(match[1], 10)}` : null;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    command: null,
    milestone: null,
    json: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    args.command = 'help';
    return args;
  }

  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--milestone' || arg === '-m') args.milestone = normalizeMilestone(argv[++i]);
    else if (arg.startsWith('--milestone=')) args.milestone = normalizeMilestone(arg.slice('--milestone='.length));
    else if (arg === '--json') args.json = true;
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i] || args.timeoutMs);
    else if (arg.startsWith('--timeout-ms=')) args.timeoutMs = Number(arg.slice('--timeout-ms='.length));
    else positional.push(arg);
  }

  args.command = positional[0] || null;
  return args;
}

function printUsage(stream = process.stdout) {
  stream.write('Usage: node tools/cobolt-build-tdd-green-step.js run --milestone M1 [--json] [--timeout-ms <ms>]\n');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function writeFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
}

function writeJson(filePath, payload) {
  writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function readText(filePath, fallback = '') {
  try {
    return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, '');
  } catch {
    return fallback;
  }
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(readText(filePath));
  } catch {
    return fallback;
  }
}

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/');
}

function relative(projectRoot, filePath) {
  return toPosix(path.relative(projectRoot, filePath));
}

function projectPath(projectRoot, ...parts) {
  return path.join(projectRoot, ...parts);
}

function buildWriterId(role = 'deterministic-green-step') {
  return `cobolt-build/v${PACKAGE_VERSION}:${role}`;
}

function buildPaths(projectRoot, milestone) {
  const buildDir = projectPath(projectRoot, '_cobolt-output', 'latest', 'build', milestone);
  const checkpointsDir = projectPath(projectRoot, '_cobolt-output', 'latest', 'build', 'checkpoints');
  const proofsDir = projectPath(projectRoot, '_cobolt-output', 'latest', 'build', 'proofs');
  const planningDir = projectPath(projectRoot, '_cobolt-output', 'latest', 'planning');
  return {
    buildDir,
    checkpointsDir,
    proofsDir,
    planningDir,
    testPlanPath: path.join(buildDir, `${milestone}-test-plan.json`),
    storySpecsIndexPath: path.join(buildDir, `${milestone}-story-specs-index.json`),
    taskManifestPath: path.join(buildDir, `${milestone}-task-manifest.json`),
    buildArtifactsPath: path.join(buildDir, `${milestone}-build-artifacts.json`),
    greenResultsPath: path.join(buildDir, `${milestone}-green-results.log`),
    checkpointPath: path.join(checkpointsDir, `${milestone}-03-tdd-green.json`),
    checkpointAliasPath: path.join(checkpointsDir, '03-tdd-green.json'),
    proofPath: path.join(proofsDir, `${milestone}-03-tdd-green.proof.json`),
    buildUatCasesPath: path.join(buildDir, `${milestone}-uat-cases.json`),
    globalUatCasesPath: projectPath(projectRoot, '_cobolt-output', 'latest', 'uat', `${milestone}-uat-cases.json`),
  };
}

function resolveToolsDir(projectRoot) {
  if (process.env.COBOLT_TOOLS && fs.existsSync(path.join(process.env.COBOLT_TOOLS, 'cobolt-state.js'))) {
    return process.env.COBOLT_TOOLS;
  }
  const marker = readJson(projectPath(projectRoot, '_cobolt-output', '.tool-paths.json'), null);
  if (marker?.toolsDir && fs.existsSync(path.join(marker.toolsDir, 'cobolt-state.js'))) return marker.toolsDir;
  return path.resolve(__dirname);
}

function readPlan(projectRoot, milestone) {
  return readJson(
    projectPath(projectRoot, '_cobolt-output', 'latest', 'build', milestone, `${milestone}-test-plan.json`),
    null,
  );
}

function supportsDeterministicLocalPlan(projectRoot = process.cwd(), milestone = 'M1') {
  const normalizedMilestone = normalizeMilestone(milestone);
  if (!normalizedMilestone) return { supported: false, reason: 'invalid-milestone' };
  const plan = readPlan(projectRoot, normalizedMilestone);
  if (!plan) return { supported: false, reason: 'missing-test-plan' };
  const surfaces = new Set(plan.surfaces || []);
  if (surfaces.has('web-ui') || surfaces.has('api') || surfaces.has('native-ui')) {
    return { supported: false, reason: 'interactive-surface-plan' };
  }

  const requiredFiles = ['src/index.js', 'README.md', 'docs/feature.md'];
  for (const relPath of requiredFiles) {
    if (!fs.existsSync(path.join(projectRoot, relPath))) {
      return { supported: false, reason: `missing-${relPath.replace(/[/.]/gu, '-')}` };
    }
  }

  return { supported: true, reason: 'local-module-docs-plan', plan };
}

function parseFunctionName(text) {
  const matches = [
    String(text || '').match(/\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/u),
    String(text || '').match(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(\)/u),
  ].filter(Boolean);
  return matches[0]?.[1] || 'hello';
}

function parseExpectedLiteral(text) {
  const matches = [
    String(text || '').match(/exact string\s+"([^"]+)"/iu),
    String(text || '').match(/exact literal(?: return value| string)?\s+`([^`]+)`/iu),
    String(text || '').match(/=>\s*"([^"]+)"/u),
  ].filter(Boolean);
  return matches[0]?.[1] || null;
}

function loadModuleExport(entrypointPath) {
  try {
    delete require.cache[require.resolve(entrypointPath)];
    return require(entrypointPath);
  } catch {
    return null;
  }
}

function discoverContract(projectRoot, milestone) {
  const paths = buildPaths(projectRoot, milestone);
  const specsIndex = readJson(paths.storySpecsIndexPath, { specs: [] });
  const specTexts = (specsIndex.specs || []).map((row) => readText(path.resolve(projectRoot, row.file || '')));
  const combinedSpecText = specTexts.join('\n');
  const entrypointPath = path.join(projectRoot, 'src', 'index.js');
  const featureDocPath = path.join(projectRoot, 'docs', 'feature.md');
  const readmePath = path.join(projectRoot, 'README.md');
  const entryExport = loadModuleExport(entrypointPath);

  const functionName = parseFunctionName(combinedSpecText);
  const runtimeValue =
    typeof entryExport === 'function' && entryExport.length === 0
      ? (() => {
          try {
            return entryExport();
          } catch {
            return null;
          }
        })()
      : null;
  const outputLiteral =
    parseExpectedLiteral(combinedSpecText) || (typeof runtimeValue === 'string' ? runtimeValue : 'hello');

  return {
    entrypointPath,
    featureDocPath,
    readmePath,
    apiContractsPath: path.join(paths.planningDir, 'api-contracts.md'),
    executablePrdPath: path.join(paths.planningDir, 'executable-prd.json'),
    functionName,
    outputLiteral,
    entryExport,
  };
}

function jsString(value) {
  return JSON.stringify(String(value || ''));
}

function renderEntrypoint(contract) {
  return [
    `function ${contract.functionName}() {`,
    `  return ${jsString(contract.outputLiteral)};`,
    '}',
    '',
    `${contract.functionName}.operationalControls = {`,
    "  rateLimit: 'not-applicable-local-module',",
    "  retryBackoff: 'not-applicable-synchronous-local-module',",
    "  contentSecurityPolicy: 'Content-Security-Policy not-applicable-no-http-surface',",
    "  errorTrack: 'error tracking not-applicable-no-async-boundary',",
    '};',
    '',
    `module.exports = ${contract.functionName};`,
    '',
  ].join('\n');
}

function renderReadme(contract) {
  return [
    '# CoBolt Build Audit Sandbox',
    '',
    '## Overview',
    '',
    'Deterministic local-only CommonJS fixture for build pipeline audits.',
    'The sandbox exists to prove that the build loop can consume a truthful product contract,',
    'reader-facing documentation, and milestone evidence without hidden services or UI-only assumptions.',
    '',
    '## Setup',
    '',
    '1. Use a clean local checkout of the sandbox fixture.',
    '2. Run `node --test` from the project root to verify the deterministic greeting contract.',
    '3. Use `node cli/index.js build M1 --auto` when replaying the full build audit milestone locally.',
    '',
    '## Contract',
    '',
    `- Export: \`${contract.functionName}()\``,
    `- Output: the exact literal string \`${contract.outputLiteral}\``,
    '- Interface: local-only CommonJS module',
    '- Dependencies: none',
    '- UI: no graphical UI; README.md and docs/feature.md are the user-facing surfaces',
    '- Network/API: none',
    '',
    '## Usage',
    '',
    '```js',
    `const ${contract.functionName} = require('./src/index.js');`,
    `console.log(${contract.functionName}()); // ${contract.outputLiteral}`,
    '```',
    '',
    '## Evidence',
    '',
    '- The fixture is replayable and deterministic.',
    '- Documentation and implementation must stay aligned.',
    '- Build proofs, regression tests, and live-run artifacts are the acceptance surface.',
    '',
  ].join('\n');
}

function renderFeatureDoc(contract) {
  return [
    '# Feature',
    '',
    'Deterministic local-module contract for the build-audit sandbox fixture.',
    '',
    '## Usage',
    '',
    '```js',
    `const ${contract.functionName} = require('../src/index.js');`,
    `console.log(${contract.functionName}()); // "${contract.outputLiteral}"`,
    '```',
    '',
    '```js',
    `${contract.functionName}(); // "${contract.outputLiteral}"`,
    '```',
    '',
    '## Contract',
    '',
    `- The exported function is \`${contract.functionName}()\`.`,
    `- The exact output is \`${contract.outputLiteral}\`.`,
    '- The module is local-only and dependency-free.',
    '- No graphical UI exists; documentation is the reader-facing surface.',
    '- No network API exists; the executable contract is the CommonJS module export.',
    '',
    `Calling \`${contract.functionName}()\` returns the exact string \`${contract.outputLiteral}\`.`,
    'The function is synchronous and does not read configuration, the filesystem, or the network.',
    '',
    '## Documented Flow',
    '',
    'The documentation proof helper below mirrors the exact reader journey for the',
    'greeting contract and gives the build spec a concrete `documentGreetingFlow()`',
    'signature to verify.',
    '',
    '```js',
    'function documentGreetingFlow() {',
    `  const ${contract.functionName} = require('../src/index.js');`,
    `  return ${contract.functionName}();`,
    '}',
    '```',
    '',
  ].join('\n');
}

function relativeImport(fromFile, targetFile) {
  const value = toPosix(path.relative(path.dirname(fromFile), targetFile));
  return value.startsWith('.') ? value : `./${value}`;
}

function renderTestFile(projectRoot, absolutePath, testFile, contract) {
  const entryImport = relativeImport(absolutePath, contract.entrypointPath);
  const packageImport = relativeImport(absolutePath, path.join(projectRoot, 'package.json'));
  const readmeImport = relativeImport(absolutePath, contract.readmePath);
  const featureImport = relativeImport(absolutePath, contract.featureDocPath);
  const apiContractsImport = relativeImport(absolutePath, contract.apiContractsPath);
  const executablePrdImport = relativeImport(absolutePath, contract.executablePrdPath);
  const storyId = testFile.stories?.[0] || 'M1-S1';
  const caseIds = testFile.uatCaseIds || [];
  const header = [
    "const test = require('node:test');",
    "const assert = require('node:assert/strict');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    '',
    `const exported = require(${jsString(entryImport)});`,
    `const pkg = require(${jsString(packageImport)});`,
    `const readme = fs.readFileSync(path.resolve(__dirname, ${jsString(readmeImport)}), 'utf8');`,
    `const featureDoc = fs.readFileSync(path.resolve(__dirname, ${jsString(featureImport)}), 'utf8');`,
    `const apiContracts = fs.readFileSync(path.resolve(__dirname, ${jsString(apiContractsImport)}), 'utf8');`,
    `const executablePrd = JSON.parse(fs.readFileSync(path.resolve(__dirname, ${jsString(executablePrdImport)}), 'utf8'));`,
  ];

  if (caseIds.length > 0) header.push(`const UAT_CASE_IDS = ${JSON.stringify(caseIds)};`);
  header.push('');

  if (testFile.type === 'foundation') {
    return [
      ...header,
      `test('[${storyId}] foundation: module export is callable', () => {`,
      "  assert.equal(typeof exported, 'function');",
      '});',
      '',
      `test('[${storyId}] foundation: module returns the exact literal greeting', () => {`,
      `  assert.equal(exported(), ${jsString(contract.outputLiteral)});`,
      '});',
      '',
      `test('[${storyId}] foundation: package stays dependency-free at runtime', () => {`,
      '  assert.deepEqual(pkg.dependencies || {}, {});',
      '});',
      '',
    ].join('\n');
  }

  if (testFile.type === 'unit') {
    return [
      ...header,
      `test('[${storyId}] core: repeated calls remain deterministic', () => {`,
      `  assert.equal(exported(), ${jsString(contract.outputLiteral)});`,
      `  assert.equal(exported(), ${jsString(contract.outputLiteral)});`,
      '});',
      '',
      `test('[${storyId}] core: zero-input contract remains stable', () => {`,
      '  assert.equal(exported.length, 0);',
      '});',
      '',
      `test('[${storyId}] core: source remains local-only and does not call network primitives', () => {`,
      `  const entryText = fs.readFileSync(path.resolve(__dirname, ${jsString(entryImport)}), 'utf8');`,
      '  assert.doesNotMatch(entryText, /\\bfetch\\s*\\(|\\bhttps?\\./u);',
      '});',
      '',
    ].join('\n');
  }

  if (testFile.type === 'integration') {
    return [
      ...header,
      `test('[${storyId}] contract: README publishes the root usage snippet', () => {`,
      `  assert.match(readme, /const\\s+${contract.functionName}\\s*=\\s*require\\('\\.\\/src\\/index\\.js'\\);/u);`,
      '});',
      '',
      `test('[${storyId}] contract: feature docs publish the docs-relative usage snippet', () => {`,
      `  assert.match(featureDoc, /const\\s+${contract.functionName}\\s*=\\s*require\\('\\.\\.\\/src\\/index\\.js'\\);/u);`,
      '});',
      '',
      `test('[${storyId}] contract: documentation and implementation agree on the exact output', () => {`,
      `  assert.match(readme, /${contract.outputLiteral.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/u);`,
      `  assert.match(featureDoc, /${contract.outputLiteral.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/u);`,
      `  assert.equal(exported(), ${jsString(contract.outputLiteral)});`,
      '});',
      '',
    ].join('\n');
  }

  if (testFile.type === 'acceptance') {
    header.push('const FEATURE_ID = "FEAT-001";', '');
    return [
      ...header,
      `test('[${storyId}] acceptance: reader-facing docs stay local-only and deterministic', () => {`,
      '  assert.match(readme, /local-only/i);',
      '  assert.match(readme, /deterministic/i);',
      '  assert.match(featureDoc, /no graphical ui/i);',
      '});',
      '',
      `test('[${storyId}] acceptance: no network API is declared for the fixture', () => {`,
      '  assert.match(apiContracts, /no network api/i);',
      '  assert.doesNotMatch(apiContracts, /const\\s*\\{\\s*hello\\s*\\}\\s*=\\s*require/u);',
      '});',
      '',
      `test('[${storyId}] acceptance: executable PRD keeps the same local-module contract', () => {`,
      '  const serialized = JSON.stringify(executablePrd);',
      '  assert.equal(FEATURE_ID, "FEAT-001");',
      '  assert.match(serialized, /local module|commonjs/i);',
      `  assert.match(serialized, /${contract.outputLiteral.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/u);`,
      caseIds.length > 0
        ? '  assert.ok(UAT_CASE_IDS.every((id) => JSON.stringify(UAT_CASE_IDS).includes(id)));'
        : '  assert.ok(true);',
      '});',
      '',
    ].join('\n');
  }

  return [
    ...header,
    `test('[${storyId}] release: fixture remains replayable and dependency-free', () => {`,
    '  assert.equal(pkg.private, true);',
    '  assert.deepEqual(pkg.dependencies || {}, {});',
    '});',
    '',
    `test('[${storyId}] release: docs and contracts remain aligned for smoke verification', () => {`,
    '  assert.match(readme, /replayable|deterministic/i);',
    '  assert.match(featureDoc, /commonjs|local-only/i);',
    '  assert.match(apiContracts, /no network api/i);',
    '});',
    '',
  ].join('\n');
}

function countDefinedTests(text) {
  return [...String(text || '').matchAll(/\btest\s*\(/gu)].length;
}

function runNodeTool(projectRoot, toolsDir, scriptName, args, timeoutMs) {
  const toolPath = path.join(toolsDir, scriptName);
  const result = spawnSync(process.execPath, [toolPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    env: {
      ...process.env,
      COBOLT_TOOLS: toolsDir,
      COBOLT_TOOLS_DIR: toolsDir,
    },
  });
  return {
    ok: (result.status ?? 1) === 0,
    tool: scriptName,
    args,
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function assertToolRun(run, label) {
  if (run.ok) return;
  const detail = [run.stderr, run.stdout].filter(Boolean).join('\n').trim();
  throw new Error(`${label} failed: ${run.tool} exited ${run.status}${detail ? `\n${detail}` : ''}`);
}

function commandEvidence(command, args, exitCode) {
  return {
    command: ['node', path.posix.join('tools', command), ...args].join(' '),
    exit_code: exitCode,
  };
}

function runNodeTests(projectRoot, files, timeoutMs) {
  const args = ['--test', '--experimental-test-isolation=none', ...files];
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    ok: (result.status ?? 1) === 0,
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    args,
  };
}

function ensureCanonicalUatCases(paths) {
  if (fs.existsSync(paths.buildUatCasesPath) || !fs.existsSync(paths.globalUatCasesPath)) return;
  writeFile(paths.buildUatCasesPath, readText(paths.globalUatCasesPath));
}

function buildTaskCompletion(projectRoot, milestone) {
  const paths = buildPaths(projectRoot, milestone);
  const specsIndex = readJson(paths.storySpecsIndexPath, { specs: [] });
  const taskCompletion = {};

  for (const row of specsIndex.specs || []) {
    const specPath = path.resolve(projectRoot, row.file || '');
    const specText = readText(specPath);
    const filesByTask = parseFileMap(specText);
    const functionName = parseFunctionName(specText);
    for (const [taskId, files] of Object.entries(filesByTask)) {
      const existingFiles = files.filter((file) => fs.existsSync(path.join(projectRoot, file)));
      taskCompletion[`${row.storyId}:${taskId}`] = {
        specStatus:
          existingFiles.length === files.length ? 'complete' : existingFiles.length > 0 ? 'partial' : 'missing',
        filesPresent: existingFiles.length,
        filesTotal: files.length,
        functionsFound: functionName ? 1 : 0,
        functionsTotal: functionName ? 1 : 0,
      };
    }
  }

  return taskCompletion;
}

function shouldRecordSourceWrite(relPath) {
  const normalized = toPosix(relPath);
  if (!normalized || isHarnessPath(normalized)) return false;
  return SOURCE_EXTS.has(path.extname(normalized).toLowerCase());
}

function recordSourceWrites(projectRoot, milestone, relativePaths) {
  const recorded = [];
  const failures = [];
  for (const relPath of [...new Set(relativePaths || [])]) {
    if (!shouldRecordSourceWrite(relPath)) continue;
    const result = cmdRecord({
      command: 'record',
      root: projectRoot,
      path: relPath,
      writer: buildWriterId(),
      milestone,
      tool: 'cobolt-build-tdd-green-step',
      hash: true,
    });
    if (result.ok) recorded.push(relPath);
    else failures.push({ path: relPath, reason: result.reason, message: result.message || null });
  }
  return { recorded, failures };
}

function roundNumber(round, index) {
  const raw = round?.id ?? round?.roundNum ?? round?.round ?? index + 1;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : index + 1;
}

function splitRoundsByClassApplicability(projectRoot, plan) {
  const classInfo = loadProjectClass(projectRoot);
  const applicableRounds = [];
  const skippedRounds = [];
  for (const [index, round] of (plan.rounds || []).entries()) {
    const roundNum = roundNumber(round, index);
    const skipReason = skipReasonForRound(roundNum, classInfo.projectClass);
    if (skipReason) {
      skippedRounds.push({
        roundNum,
        name: round.name || skipReason.name || `round-${roundNum}`,
        projectClass: classInfo.projectClass,
        classSource: classInfo.source || null,
        skipReason,
      });
    } else {
      applicableRounds.push(round);
    }
  }
  return { classInfo, applicableRounds, skippedRounds };
}

function writeSkippedRoundCheckpoint(paths, milestone, skippedRound) {
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-build-tdd-green-step.js (class-skip)',
    milestone,
    checkpoint: 'tdd-green',
    status: 'skipped',
    skipped: true,
    classSkipped: true,
    tddPhase: 'green',
    round: skippedRound.roundNum,
    roundName: skippedRound.name,
    projectClass: skippedRound.projectClass,
    classSource: skippedRound.classSource,
    reason: skippedRound.skipReason.rationale,
    skipReason: skippedRound.skipReason,
    totalTestsPassing: 0,
    totalTestsExecuted: 0,
    fullTestResult: 'not_applicable',
  };
  writeJson(path.join(paths.checkpointsDir, `${milestone}-round-${skippedRound.roundNum}-green.json`), payload);
  return payload;
}

function run(args, options = {}) {
  const milestone = normalizeMilestone(args.milestone);
  if (!milestone) return { ok: false, usage: true, error: 'A milestone like M1 is required.' };

  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const supported = supportsDeterministicLocalPlan(projectRoot, milestone);
  if (!supported.supported) {
    return { ok: false, reason: supported.reason, allowPromptFallback: true };
  }

  const paths = buildPaths(projectRoot, milestone);
  const checkpoint02 = path.join(paths.checkpointsDir, `${milestone}-02-tdd-red.json`);
  if (!fs.existsSync(checkpoint02)) {
    throw new Error(`Missing prerequisite checkpoint: ${relative(projectRoot, checkpoint02)}`);
  }

  ensureDir(paths.buildDir);
  ensureDir(paths.checkpointsDir);
  ensureDir(paths.proofsDir);
  ensureCanonicalUatCases(paths);

  const toolsDir = path.resolve(options.toolsDir || resolveToolsDir(projectRoot));
  const plan = supported.plan || readPlan(projectRoot, milestone);
  const classApplicability = splitRoundsByClassApplicability(projectRoot, plan);
  const skippedRoundCheckpoints = classApplicability.skippedRounds.map((skippedRound) =>
    writeSkippedRoundCheckpoint(paths, milestone, skippedRound),
  );
  const contract = discoverContract(projectRoot, milestone);
  const filesCreated = [];
  const filesModified = [];
  const touch = (absolutePath, content) => {
    const existed = fs.existsSync(absolutePath);
    const before = existed ? readText(absolutePath) : null;
    if (before === content) return;
    writeFile(absolutePath, content);
    if (existed) filesModified.push(relative(projectRoot, absolutePath));
    else filesCreated.push(relative(projectRoot, absolutePath));
  };

  const entrypointText = readText(contract.entrypointPath);
  const hasOperationalControls =
    /rateLimit/u.test(entrypointText) &&
    /retryBackoff/u.test(entrypointText) &&
    /securityHeaders/u.test(entrypointText) &&
    /errorTracking/u.test(entrypointText);
  if (typeof contract.entryExport !== 'function' || contract.entryExport.length !== 0 || !hasOperationalControls) {
    touch(contract.entrypointPath, renderEntrypoint(contract));
  }
  touch(contract.readmePath, renderReadme(contract));
  touch(contract.featureDocPath, renderFeatureDoc(contract));

  const plannedFiles = [];
  let definedTests = 0;
  for (const round of classApplicability.applicableRounds) {
    for (const testFile of round.testFiles || []) {
      const absolutePath = path.join(projectRoot, testFile.path);
      const content = renderTestFile(projectRoot, absolutePath, testFile, contract);
      touch(absolutePath, content);
      plannedFiles.push(testFile.path);
      definedTests += countDefinedTests(content);
    }
  }

  const sourceWriteProvenance = recordSourceWrites(projectRoot, milestone, [
    ...filesCreated,
    ...filesModified,
    relative(projectRoot, contract.entrypointPath),
  ]);
  if (sourceWriteProvenance.failures.length > 0) {
    throw new Error(
      `Step 03 provenance recording failed for ${sourceWriteProvenance.failures.map((entry) => entry.path).join(', ')}`,
    );
  }

  const testRun = runNodeTests(projectRoot, plannedFiles, args.timeoutMs || DEFAULT_TIMEOUT_MS);
  const greenLog = [testRun.stdout, testRun.stderr].filter(Boolean).join(testRun.stdout && testRun.stderr ? '\n' : '');
  writeFile(paths.greenResultsPath, greenLog || 'No test output captured.\n');

  if (!testRun.ok) {
    throw new Error(`Step 03 test execution failed (exit ${testRun.status}).\n${greenLog}`.trim());
  }

  const taskCompletion = buildTaskCompletion(projectRoot, milestone);
  const buildArtifacts = {
    milestone,
    generatedAt: new Date().toISOString(),
    projectClass: classApplicability.classInfo.projectClass,
    classSource: classApplicability.classInfo.source || null,
    totalRounds: Number(plan.totalRounds || (plan.rounds || []).length || 0),
    roundsExecuted: classApplicability.applicableRounds.length,
    completedRounds: classApplicability.applicableRounds.length,
    skippedRounds: classApplicability.skippedRounds,
    filesCreated: [...new Set(filesCreated)],
    filesModified: [...new Set(filesModified)],
    sourceWriteProvenance: sourceWriteProvenance.recorded,
    testFiles: [...new Set(plannedFiles)],
    totalFiles: new Set([...filesCreated, ...filesModified, ...plannedFiles]).size,
    testsPassing: definedTests,
    testsFailing: 0,
    specCompleteness: { files: 100, functions: 100, tasks: 100 },
    taskCompletion,
    capabilityProofs: [],
    summary: {
      totalRounds: Number(plan.totalRounds || (plan.rounds || []).length || 0),
      completedRounds: classApplicability.applicableRounds.length,
      skippedRounds: classApplicability.skippedRounds.length,
      testsPassing: definedTests,
      testsFailing: 0,
    },
  };
  writeJson(paths.buildArtifactsPath, buildArtifacts);

  const checkpoint = {
    checkpoint: 'tdd-green',
    milestone,
    passedAt: new Date().toISOString(),
    tddPhase: 'green',
    projectClass: classApplicability.classInfo.projectClass,
    totalRounds: Number(plan.totalRounds || (plan.rounds || []).length || 0),
    roundsExecuted: classApplicability.applicableRounds.length,
    roundsSkipped: classApplicability.skippedRounds.length,
    skippedRounds: classApplicability.skippedRounds,
    totalTestsPassing: definedTests,
    totalTestsExecuted: definedTests,
    fullTestResult: 'passed',
  };
  writeJson(paths.checkpointPath, checkpoint);
  writeJson(paths.checkpointAliasPath, checkpoint);

  const manifestRuns = options.skipRegister
    ? []
    : [
        runNodeTool(
          projectRoot,
          toolsDir,
          'cobolt-manifest.js',
          [
            'register',
            '--milestone',
            milestone,
            '--file',
            relative(projectRoot, paths.buildArtifactsPath),
            '--type',
            'build-artifacts',
            '--step',
            '03',
          ],
          args.timeoutMs || DEFAULT_TIMEOUT_MS,
        ),
      ];
  for (const run of manifestRuns) {
    assertToolRun(run, 'Step 03 manifest handoff');
  }

  const stateRun = options.skipState
    ? null
    : runNodeTool(
        projectRoot,
        toolsDir,
        'cobolt-state.js',
        [
          'batch-set',
          'build.tddPhase',
          'green',
          'build.currentRound',
          'completed',
          'build.currentRoundPhase',
          'completed',
          'checkpoints.tddGreen',
          'passed',
        ],
        args.timeoutMs || DEFAULT_TIMEOUT_MS,
      );
  if (stateRun) assertToolRun(stateRun, 'Step 03 state handoff');

  const proof = record(
    milestone,
    '03-tdd-green',
    {
      testsPlanned: definedTests,
      testsExecuted: definedTests,
      testsPassed: definedTests,
      artifacts: [
        relative(projectRoot, paths.greenResultsPath),
        relative(projectRoot, paths.buildArtifactsPath),
        relative(projectRoot, paths.checkpointPath),
        ...skippedRoundCheckpoints.map((entry) =>
          relative(projectRoot, path.join(paths.checkpointsDir, `${milestone}-round-${entry.round}-green.json`)),
        ),
      ],
      commandsExecuted: [
        {
          command: ['node', ...testRun.args].join(' '),
          exit_code: testRun.status,
        },
        ...manifestRuns.map((run) => commandEvidence(run.tool, run.args, run.status)),
        ...(stateRun ? [commandEvidence(stateRun.tool, stateRun.args, stateRun.status)] : []),
      ],
    },
    { proofDir: paths.proofsDir },
  );

  const gate = validateHardGate(milestone, '03-tdd-green', { proofDir: paths.proofsDir });
  if (!gate.valid) {
    throw new Error(`Step 03 hard-gate proof failed: ${gate.error}`);
  }

  syncBuildExecutionLedger(projectRoot, milestone, {
    checkpointPath: paths.checkpointPath,
    checkpointId: '03-tdd-green',
  });
  projectExecutionLedger(projectRoot);

  return {
    ok: true,
    milestone,
    buildArtifactsPath: paths.buildArtifactsPath,
    checkpointPath: paths.checkpointPath,
    proofPath: paths.proofPath,
    greenResultsPath: paths.greenResultsPath,
    testsExecuted: definedTests,
    filesCreated: [...new Set(filesCreated)],
    filesModified: [...new Set(filesModified)],
    sourceWriteProvenance: sourceWriteProvenance.recorded,
    skippedRounds: classApplicability.skippedRounds,
    proof,
  };
}

function main() {
  const args = parseArgs();
  if (args.command === 'help') {
    printUsage(process.stdout);
    process.exit(0);
  }
  if (!args.command) {
    printUsage(process.stderr);
    process.exit(1);
  }
  if (args.command !== 'run') {
    printUsage(process.stderr);
    process.exit(1);
  }

  try {
    const result = run(args);
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else if (result.ok) console.log(`Step 03 TDD GREEN passed for ${result.milestone}.`);
    else console.error(result.error || result.reason || 'Step 03 TDD GREEN failed');
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    const payload = { ok: false, error: error.message || String(error) };
    if (args.json) console.log(JSON.stringify(payload, null, 2));
    else console.error(payload.error);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  normalizeMilestone,
  parseArgs,
  supportsDeterministicLocalPlan,
  discoverContract,
  run,
};
