#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { projectExecutionLedger, syncBuildExecutionLedger } = require('../lib/cobolt-execution-ledger');

function parseArgs(argv) {
  const out = { command: 'run', milestone: null, cwd: process.cwd(), json: false, timeoutMs: 900000 };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--milestone') out.milestone = argv[++i];
    else if (arg === '--cwd') out.cwd = argv[++i];
    else if (arg === '--json') out.json = true;
    else if (arg === '--timeout-ms') out.timeoutMs = Number(argv[++i]) || out.timeoutMs;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 0) out.command = positional[0];
  if (!out.milestone) out.milestone = positional.find((value) => /^M\d+$/i.test(value));
  if (out.milestone) out.milestone = String(out.milestone).toUpperCase();
  return out;
}

function usage() {
  return [
    'Usage: node tools/cobolt-build-code-gap-step.js run --milestone M1 [--cwd <project>] [--json]',
    '',
    'Runs deterministic Build Step 03A components: spec verification, capability-edge proof,',
    'gap report consolidation, manifest registration, state handoff, checkpoint, and proof.',
  ].join('\n');
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value.endsWith('\n') ? value : `${value}\n`, 'utf8');
}

function removeIfExists(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best-effort cleanup only; the following deterministic command must still prove freshness.
  }
}

function projectPath(projectRoot, ...parts) {
  const root = path.resolve(projectRoot);
  const target = path.resolve(root, ...parts);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Refusing to write outside project root: ${target}`);
  }
  return target;
}

function resolveToolsDir(projectRoot) {
  if (process.env.COBOLT_TOOLS) return path.resolve(projectRoot, process.env.COBOLT_TOOLS);
  const toolPaths = projectPath(projectRoot, '_cobolt-output', '.tool-paths.json');
  const parsed = readJson(toolPaths, null);
  if (parsed?.toolsDir) return path.resolve(projectRoot, parsed.toolsDir);
  return path.resolve(__dirname);
}

function optionValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

function withProjectRoot(projectRoot, fn) {
  const previous = process.cwd();
  process.chdir(projectRoot);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

function getRoundStoryIds(testPlan, roundNum) {
  if (!roundNum || !testPlan) return null;
  const out = new Set();
  const rounds = Array.isArray(testPlan.rounds) ? testPlan.rounds : [];
  const round = rounds.find((entry) => Number(entry.round || entry.id || entry.index) === Number(roundNum));
  for (const testFile of round?.testFiles || []) {
    for (const storyId of testFile.stories || testFile.storyIds || []) out.add(storyId);
  }
  return out;
}

function getRoundTaskIds(taskManifest, roundNum) {
  if (!roundNum || !taskManifest) return null;
  const out = new Set();
  for (const epic of taskManifest.epics || []) {
    for (const story of epic.stories || []) {
      for (const task of story.tasks || []) {
        if (Number(task.wave || task.round) === Number(roundNum) && task.id) out.add(task.id);
      }
    }
  }
  return out;
}

function runSpecVerifyInProcess(projectRoot, toolPath, args) {
  return withProjectRoot(projectRoot, () => {
    const { parseImplSpec, verifySpec } = require(toolPath);
    const milestone = args.find((arg) => /^M\d+$/i.test(arg));
    const roundRaw = optionValue(args, '--round');
    const roundNum = roundRaw ? Number(roundRaw) : null;
    const outPath = optionValue(args, '--out');
    const jsonMode = args.includes('--json') || Boolean(outPath);
    if (!milestone) return { ok: false, status: 2, stdout: '', stderr: 'Milestone is required.' };

    const buildDir = path.join(projectRoot, '_cobolt-output', 'latest', 'build', milestone);
    const buildSpecsDir = path.join(buildDir, `${milestone}-story-specs`);
    const planningSpecsDir = path.join(projectRoot, '_cobolt-output', 'latest', 'planning', 'story-specs');
    const specsDir = fs.existsSync(buildSpecsDir) ? buildSpecsDir : planningSpecsDir;
    if (!fs.existsSync(specsDir)) {
      return { ok: false, status: 2, stdout: '', stderr: `Story specs directory not found: ${specsDir}` };
    }

    const specFiles = fs.readdirSync(specsDir).filter((file) => file.endsWith('-impl-spec.md'));
    if (specFiles.length === 0) {
      return { ok: false, status: 2, stdout: '', stderr: `No impl-spec files found in ${specsDir}` };
    }

    const taskManifest = readJson(path.join(buildDir, `${milestone}-task-manifest.json`), null);
    const testPlan = readJson(path.join(buildDir, `${milestone}-test-plan.json`), null);
    const roundStoryIds = getRoundStoryIds(testPlan, roundNum);
    const roundTaskIds = getRoundTaskIds(taskManifest, roundNum);
    const stories = [];
    const summary = {
      milestone,
      round: roundNum,
      stories: { total: 0, complete: 0, partial: 0, missing: 0 },
      tasks: { total: 0, complete: 0, partial: 0, missing: 0 },
      files: { total: 0, present: 0, missing: 0, empty: 0 },
      functions: { total: 0, found: 0, missing: 0 },
    };

    for (const specFile of specFiles) {
      const storyId = specFile.replace('-impl-spec.md', '');
      if (roundStoryIds && !roundStoryIds.has(storyId)) continue;
      const parsed = parseImplSpec(fs.readFileSync(path.join(specsDir, specFile), 'utf8'), storyId);
      const verified = verifySpec(parsed);
      if (roundTaskIds && roundTaskIds.size > 0) {
        for (const taskId of Object.keys(verified.tasks || {})) {
          if (!roundTaskIds.has(taskId)) delete verified.tasks[taskId];
        }
        verified.summary = { total: 0, complete: 0, partial: 0, missing: 0 };
        for (const task of Object.values(verified.tasks || {})) {
          verified.summary.total += 1;
          verified.summary[task.specStatus] += 1;
        }
      }
      stories.push(verified);
      const storyComplete =
        verified.summary.missing === 0 && verified.summary.partial === 0 && verified.summary.total > 0;
      const storyPartial = verified.summary.complete > 0 || verified.summary.partial > 0;
      summary.stories.total += 1;
      if (storyComplete) summary.stories.complete += 1;
      else if (storyPartial) summary.stories.partial += 1;
      else summary.stories.missing += 1;
      summary.tasks.total += verified.summary.total;
      summary.tasks.complete += verified.summary.complete;
      summary.tasks.partial += verified.summary.partial;
      summary.tasks.missing += verified.summary.missing;
      for (const file of verified.fileMap || []) {
        summary.files.total += 1;
        if (file.hasContent) summary.files.present += 1;
        else if (file.exists) summary.files.empty += 1;
        else summary.files.missing += 1;
      }
      for (const fn of verified.functions || []) {
        summary.functions.total += 1;
        if (fn.found) summary.functions.found += 1;
        else summary.functions.missing += 1;
      }
    }

    const pct = (value, total) => (total > 0 ? Number(((value / total) * 100).toFixed(1)) : 100);
    const passed =
      summary.files.missing === 0 &&
      summary.files.empty === 0 &&
      summary.functions.missing === 0 &&
      !(summary.files.total > 0 && summary.files.present === 0) &&
      !(summary.functions.total > 0 && summary.functions.found === 0);
    const output = {
      milestone,
      round: roundNum,
      verifiedAt: new Date().toISOString(),
      passed,
      completeness: {
        files: pct(summary.files.present, summary.files.total),
        functions: pct(summary.functions.found, summary.functions.total),
        tasks: pct(summary.tasks.complete, summary.tasks.total),
      },
      summary,
      stories,
      missingFiles: stories.flatMap((story) => story.fileMap || []).filter((file) => !file.hasContent),
      missingFunctions: stories.flatMap((story) => story.functions || []).filter((fn) => !fn.found),
      stubbedFunctions: stories.flatMap((story) => story.functions || []).filter((fn) => fn.found && fn.hasStubs),
      stubbedFiles: stories.flatMap((story) => story.fileMap || []).filter((file) => file.stubCount > 2),
    };
    if (outPath) writeJson(outPath, output);
    return {
      ok: passed,
      status: passed ? 0 : 1,
      tool: 'cobolt-spec-verify.js',
      args,
      stdout: jsonMode ? JSON.stringify(output, null, 2) : '',
      stderr: '',
      inProcess: true,
    };
  });
}

function runCapabilityGraphInProcess(projectRoot, toolPath, args) {
  return withProjectRoot(projectRoot, () => {
    const { checkCapabilityGraph } = require(toolPath);
    const outPath = optionValue(args, '--out');
    const stage = optionValue(args, '--stage') || 'final';
    const milestone = optionValue(args, '--milestone') || args.find((arg) => /^M\d+$/i.test(arg));
    const { result, exitCode } = checkCapabilityGraph({ projectRoot, stage, milestone });
    if (outPath) writeJson(outPath, result);
    return {
      ok: exitCode === 0,
      status: exitCode,
      tool: 'cobolt-capability-graph.js',
      args,
      stdout: args.includes('--json') || outPath ? JSON.stringify(result, null, 2) : '',
      stderr: '',
      inProcess: true,
    };
  });
}

function runManifestInProcess(projectRoot, toolPath, args) {
  return withProjectRoot(projectRoot, () => {
    const manifest = require(toolPath);
    if (args[0] !== 'register') return null;
    const registerArgs = {};
    for (let index = 1; index < args.length; index += 2) {
      const key = String(args[index] || '');
      if (!key.startsWith('--')) continue;
      registerArgs[key.slice(2)] = args[index + 1];
    }
    const result = manifest.register(registerArgs);
    return {
      ok: true,
      status: 0,
      tool: 'cobolt-manifest.js',
      args,
      stdout: result ? JSON.stringify(result, null, 2) : '',
      stderr: '',
      inProcess: true,
    };
  });
}

function runStateInProcess(projectRoot, toolPath, args) {
  return withProjectRoot(projectRoot, () => {
    if (args[0] !== 'batch-set') return null;
    if ((args.length - 1) % 2 !== 0) {
      return { ok: false, status: 2, tool: 'cobolt-state.js', args, stdout: '', stderr: 'batch-set requires pairs' };
    }
    const api = require(toolPath);
    const state = api.readState({ onCorrupt: 'repair' });
    const applied = [];
    for (let index = 1; index < args.length; index += 2) {
      api.enforceAutonomousFlagGuard('batch-set', args[index], args[index + 1]);
      api.setNestedValue(state, args[index], args[index + 1]);
      applied.push(args[index]);
    }
    api.writeState(state);
    return {
      ok: true,
      status: 0,
      tool: 'cobolt-state.js',
      args,
      stdout: `Batch-set ${applied.length} keys: ${applied.join(', ')}`,
      stderr: '',
      inProcess: true,
    };
  });
}

function runBundledNodeTool(projectRoot, toolsDir, toolName, args) {
  const toolPath = path.join(toolsDir, toolName);
  if (path.resolve(toolsDir) !== path.resolve(__dirname)) return null;
  if (toolName === 'cobolt-spec-verify.js') return runSpecVerifyInProcess(projectRoot, toolPath, args);
  if (toolName === 'cobolt-capability-graph.js') return runCapabilityGraphInProcess(projectRoot, toolPath, args);
  if (toolName === 'cobolt-manifest.js') return runManifestInProcess(projectRoot, toolPath, args);
  if (toolName === 'cobolt-state.js') return runStateInProcess(projectRoot, toolPath, args);
  return null;
}

function runNodeTool(projectRoot, toolsDir, toolName, args, options = {}) {
  const toolPath = path.join(toolsDir, toolName);
  if (!fs.existsSync(toolPath)) {
    return { ok: false, status: 127, tool: toolName, args, stdout: '', stderr: `Tool not found: ${toolPath}` };
  }
  const inProcess = runBundledNodeTool(projectRoot, toolsDir, toolName, args);
  if (inProcess) return inProcess;
  const result = spawnSync(process.execPath, [toolPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: options.timeoutMs || 120000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    ok: result.status === 0,
    status: result.status ?? (result.error ? 1 : 0),
    signal: result.signal || null,
    error: result.error ? String(result.error.message || result.error) : null,
    tool: toolName,
    args,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`${label} missing: ${filePath}`);
  return filePath;
}

function collectFiles(buildArtifacts) {
  const out = new Set();
  for (const key of ['files', 'filesCreated', 'filesModified', 'testFiles']) {
    for (const entry of buildArtifacts?.[key] || []) {
      if (typeof entry === 'string') out.add(entry);
      else if (entry?.path) out.add(entry.path);
    }
  }
  return [...out].sort();
}

function summarizeGaps(gaps) {
  const summary = { critical: 0, high: 0, medium: 0, low: 0, total: gaps.length };
  for (const gap of gaps) {
    const severity = ['critical', 'high', 'medium', 'low'].includes(gap.severity) ? gap.severity : 'medium';
    summary[severity] += 1;
  }
  return summary;
}

function specGaps(specReport) {
  const gaps = [];
  for (const file of specReport?.missingFiles || []) {
    gaps.push({
      severity: 'high',
      category: 'structural',
      requirement: file.taskId || file.storyId || 'impl-spec',
      description: `Missing file required by implementation spec: ${file.filePath || file.expectedFile || file}`,
      file: file.filePath || file.expectedFile || String(file),
      lineContext: 'file missing',
      suggestedFix: 'Create the file or update the implementation spec if the file is no longer required.',
      source: 'cobolt-spec-verify',
    });
  }
  for (const fn of specReport?.missingFunctions || []) {
    gaps.push({
      severity: 'high',
      category: 'structural',
      requirement: fn.taskId || fn.storyId || 'impl-spec',
      description: `Missing function required by implementation spec: ${fn.name || fn.signature || fn}`,
      file: fn.expectedFile || fn.filePath || '',
      lineContext: fn.signature || fn.name || 'function missing',
      suggestedFix: 'Implement the function or update the spec if this contract changed.',
      source: 'cobolt-spec-verify',
    });
  }
  for (const fn of specReport?.stubbedFunctions || []) {
    gaps.push({
      severity: 'high',
      category: 'behavioral',
      requirement: fn.taskId || fn.storyId || 'impl-spec',
      description: `Stubbed function remains in milestone implementation: ${fn.name || fn.signature || fn}`,
      file: fn.expectedFile || fn.filePath || '',
      lineContext: (fn.stubMarkers || []).join(', ') || 'stub marker',
      suggestedFix: 'Replace stubbed behavior with production implementation.',
      source: 'cobolt-spec-verify',
    });
  }
  for (const story of specReport?.stories || []) {
    for (const wiring of story.wiringGaps || []) {
      gaps.push({
        severity: 'medium',
        category: 'structural',
        requirement: story.storyId || 'impl-spec',
        description: wiring.description || 'Potential wiring gap detected by implementation spec verification.',
        file: wiring.file || wiring.handler || '',
        lineContext: JSON.stringify(wiring),
        suggestedFix: 'Wire the declared layer or add an explicit no-change proof.',
        source: 'cobolt-spec-verify',
      });
    }
  }
  if (specReport && specReport.passed === false && gaps.length === 0) {
    gaps.push({
      severity: 'high',
      category: 'structural',
      requirement: 'impl-spec',
      description: 'Implementation spec verification failed without a structured gap payload.',
      file: '',
      lineContext: 'spec verifier passed=false',
      suggestedFix: 'Inspect the spec verification report and repair the missing implementation contract.',
      source: 'cobolt-spec-verify',
    });
  }
  return gaps;
}

function capabilityGaps(capabilityReport) {
  const gaps = (capabilityReport?.proof?.missingEdges || []).map((edge) => ({
    severity: 'high',
    category: 'capability-edge',
    requirement: edge.featureId || edge.feature || edge.from || 'capability-graph',
    description: `Missing proof for capability surface edge: ${edge.surfaceId || edge.surface || edge.to || 'unknown surface'}`,
    file: edge.expectedFile || edge.file || '',
    lineContext: JSON.stringify(edge),
    suggestedFix:
      'Add implementation/regression proof for the impacted surface or mark it not applicable in the capability graph.',
    source: 'cobolt-capability-graph',
  }));
  const missingEdgeIssueKeys = new Set(
    (capabilityReport?.proof?.missingEdges || []).map((edge) => {
      const featureId = edge.featureId || edge.feature || edge.from || '';
      const surface = edge.surfaceId || edge.surface || edge.to || '';
      return `${featureId}|${surface}`;
    }),
  );
  for (const issue of capabilityReport?.issues || []) {
    const text = String(issue || '');
    const duplicatesMissingEdge = [...missingEdgeIssueKeys].some((key) => {
      const [featureId, surface] = key.split('|');
      if (!featureId || !surface) return false;
      return text.includes(String(featureId)) && text.includes(String(surface));
    });
    if (duplicatesMissingEdge) continue;
    gaps.push({
      severity: 'high',
      category: 'capability-graph',
      requirement: 'capability-graph',
      description: text || 'Capability graph check failed without a structured issue.',
      file: '',
      lineContext: 'capability graph issue',
      suggestedFix: 'Repair the capability graph, feature surface contract, or build proof evidence.',
      source: 'cobolt-capability-graph',
    });
  }
  if (capabilityReport && capabilityReport.passed === false && gaps.length === 0) {
    gaps.push({
      severity: 'high',
      category: 'capability-graph',
      requirement: 'capability-graph',
      description: 'Capability graph check failed without missing-edge or issue details.',
      file: '',
      lineContext: 'capability graph passed=false',
      suggestedFix: 'Inspect the capability graph report and repair the failed edge proof contract.',
      source: 'cobolt-capability-graph',
    });
  }
  return gaps;
}

function assertFreshReport(toolRun, reportPath, report, label) {
  if (!fs.existsSync(reportPath)) {
    throw new Error(
      `${label} failed with exit ${toolRun.status}: ${toolRun.stderr || toolRun.stdout || toolRun.error || 'no report produced'}`,
    );
  }
  if (toolRun.error || toolRun.signal) {
    throw new Error(
      `${label} did not execute cleanly: ${toolRun.error || `terminated by ${toolRun.signal}`}. Refusing to reuse stale report ${reportPath}.`,
    );
  }
  if (!toolRun.ok && report?.passed !== false) {
    throw new Error(
      `${label} exited ${toolRun.status} but did not produce an explicit failed report. Refusing to advance on contradictory evidence.`,
    );
  }
}

function assertHandoffRuns(manifestRuns, stateRun) {
  const failures = collectHandoffFailures(manifestRuns, stateRun);
  if (failures.length > 0) {
    throw new Error(`Step 03A handoff failed: ${failures.join('; ')}`);
  }
}

function collectHandoffFailures(manifestRuns, stateRun) {
  const failures = [
    ...manifestRuns.filter((run) => !run.ok).map((run) => `${run.tool} exited ${run.status}`),
    ...(!stateRun.ok ? [`${stateRun.tool} exited ${stateRun.status}`] : []),
  ];
  return failures;
}

function commandEvidence(run) {
  return {
    command: `node ${run.tool} ${(run.args || []).join(' ')}`.trim(),
    exit_code: run.status,
  };
}

function renderMarkdown(report) {
  const lines = [
    `# ${report.milestone} Code Gap Analysis`,
    '',
    `Analyzed at: ${report.analyzedAt}`,
    `Files analyzed: ${report.filesAnalyzed}`,
    '',
    '## Summary',
    '',
    `- Critical: ${report.summary.critical}`,
    `- High: ${report.summary.high}`,
    `- Medium: ${report.summary.medium}`,
    `- Low: ${report.summary.low}`,
    `- Total: ${report.summary.total}`,
    '',
    '## Gaps',
    '',
  ];
  if (report.gaps.length === 0) {
    lines.push('No deterministic code gaps found.');
  } else {
    for (const gap of report.gaps) {
      lines.push(`### ${gap.id} - ${gap.severity}`);
      lines.push('');
      lines.push(`- Category: ${gap.category}`);
      lines.push(`- Requirement: ${gap.requirement}`);
      lines.push(`- File: ${gap.file || '(not file-scoped)'}`);
      lines.push(`- Source: ${gap.source}`);
      lines.push(`- Description: ${gap.description}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

function runCodeGapStep(options) {
  const projectRoot = path.resolve(options.cwd || process.cwd());
  const milestone = options.milestone;
  if (!/^M\d+$/u.test(milestone || '')) throw new Error('A milestone like M1 is required.');

  const toolsDir = resolveToolsDir(projectRoot);
  const buildDir = projectPath(projectRoot, '_cobolt-output', 'latest', 'build', milestone);
  const checkpointsDir = projectPath(projectRoot, '_cobolt-output', 'latest', 'build', 'checkpoints');
  const proofDir = projectPath(projectRoot, '_cobolt-output', 'latest', 'build', 'proofs');
  const checkpoint03 = path.join(checkpointsDir, `${milestone}-03-tdd-green.json`);
  const checkpoint03Alias = path.join(checkpointsDir, '03-tdd-green.json');
  assertFile(fs.existsSync(checkpoint03) ? checkpoint03 : checkpoint03Alias, 'Step 03 checkpoint');

  const buildArtifactsPath = assertFile(path.join(buildDir, `${milestone}-build-artifacts.json`), 'Build artifacts');
  assertFile(path.join(buildDir, `${milestone}-task-manifest.json`), 'Task manifest');
  const planningContextPath = assertFile(path.join(buildDir, `${milestone}-planning-context.json`), 'Planning context');
  const planningContext = readJson(planningContextPath, {});
  if (Number(planningContext?.summary?.requiredMissing || 0) !== 0) {
    throw new Error(`${path.basename(planningContextPath)} reports missing required planning artifacts.`);
  }

  const specReportPath = path.join(buildDir, `${milestone}-spec-verify-full.json`);
  const specErrPath = path.join(buildDir, `${milestone}-spec-verify-full.stderr.log`);
  removeIfExists(specReportPath);
  removeIfExists(specErrPath);
  const specRun = runNodeTool(
    projectRoot,
    toolsDir,
    'cobolt-spec-verify.js',
    [milestone, '--json', '--out', specReportPath],
    { timeoutMs: options.timeoutMs },
  );
  writeText(specErrPath, specRun.stderr || '');
  const specReport = readJson(specReportPath, {});
  assertFreshReport(specRun, specReportPath, specReport, 'cobolt-spec-verify.js');
  assertFile(specReportPath, 'Spec verify report');

  const capabilityReportPath = path.join(buildDir, `${milestone}-capability-edge-proof-report.json`);
  const capabilityErrPath = path.join(buildDir, `${milestone}-capability-edge-proof-report.stderr.log`);
  removeIfExists(capabilityReportPath);
  removeIfExists(capabilityErrPath);
  const capabilityRun = runNodeTool(
    projectRoot,
    toolsDir,
    'cobolt-capability-graph.js',
    ['check', '--stage', 'build', '--milestone', milestone, '--json', '--out', capabilityReportPath],
    { timeoutMs: options.timeoutMs },
  );
  writeText(capabilityErrPath, capabilityRun.stderr || '');
  const capabilityReport = readJson(capabilityReportPath, {});
  assertFreshReport(capabilityRun, capabilityReportPath, capabilityReport, 'cobolt-capability-graph.js');
  assertFile(capabilityReportPath, 'Capability-edge proof report');

  const buildArtifacts = readJson(buildArtifactsPath, {});
  const filesAnalyzed = collectFiles(buildArtifacts);
  const gaps = [...specGaps(specReport), ...capabilityGaps(capabilityReport)].map((gap, index) => ({
    id: `GAP-${String(index + 1).padStart(3, '0')}`,
    ...gap,
  }));
  const summary = summarizeGaps(gaps);
  const codeGapReport = {
    milestone,
    analyzedAt: new Date().toISOString(),
    deterministicOnly: true,
    filesAnalyzed: filesAnalyzed.length,
    inputs: {
      buildArtifacts: path.relative(projectRoot, buildArtifactsPath).replaceAll('\\', '/'),
      planningContext: path.relative(projectRoot, planningContextPath).replaceAll('\\', '/'),
      specVerify: path.relative(projectRoot, specReportPath).replaceAll('\\', '/'),
      capabilityEdgeProof: path.relative(projectRoot, capabilityReportPath).replaceAll('\\', '/'),
    },
    summary,
    gaps,
  };

  const reportJsonPath = path.join(buildDir, `${milestone}-code-gap-report.json`);
  const reportMdPath = path.join(buildDir, `${milestone}-code-gap-report.md`);
  writeJson(reportJsonPath, codeGapReport);
  writeText(reportMdPath, renderMarkdown(codeGapReport));

  const manifestRuns = [
    [
      'register',
      '--milestone',
      milestone,
      '--file',
      path.relative(projectRoot, specReportPath),
      '--type',
      'spec-verify-report',
      '--step',
      '03a',
    ],
    [
      'register',
      '--milestone',
      milestone,
      '--file',
      path.relative(projectRoot, capabilityReportPath),
      '--type',
      'capability-edge-proof-report',
      '--step',
      '03a',
    ],
    [
      'register',
      '--milestone',
      milestone,
      '--file',
      path.relative(projectRoot, reportJsonPath),
      '--type',
      'code-gap-report',
      '--step',
      '03a',
    ],
  ].map((args) => runNodeTool(projectRoot, toolsDir, 'cobolt-manifest.js', args));

  const stateRun = runNodeTool(projectRoot, toolsDir, 'cobolt-state.js', [
    'batch-set',
    'build.currentStep',
    '03b-integration-smoke',
    'build.gapAnalysis.total',
    String(summary.total),
    'build.gapAnalysis.critical',
    String(summary.critical),
    'build.gapAnalysis.high',
    String(summary.high),
    'build.gapAnalysis.capabilityMissingEdges',
    String(capabilityReport?.proof?.missingEdges?.length || 0),
    'checkpoints.codeGapAnalysis',
    'passed',
  ]);

  const checkpoint = {
    checkpoint: 'code-gap-analysis',
    milestone,
    passedAt: new Date().toISOString(),
    totalGaps: summary.total,
    criticalGaps: summary.critical,
    highGaps: summary.high,
    capabilityMissingEdges: capabilityReport?.proof?.missingEdges?.length || 0,
    filesAnalyzed: filesAnalyzed.length,
    deterministicOnly: true,
  };
  writeJson(path.join(checkpointsDir, `${milestone}-03a-code-gap-analysis.json`), checkpoint);
  writeJson(path.join(checkpointsDir, '03a-code-gap-analysis.json'), checkpoint);

  const handoffFailures = collectHandoffFailures(manifestRuns, stateRun);
  const passed = summary.critical === 0 && summary.high === 0 && handoffFailures.length === 0;
  const proof = {
    step: '03a-code-gap-analysis',
    status: passed ? 'passed' : 'failed',
    milestone,
    passed,
    executedAt: new Date().toISOString(),
    tests: { planned: 0, executed: 0, passed: 0, failed: 0, skipped: 0 },
    commands_executed: [
      commandEvidence(specRun),
      commandEvidence(capabilityRun),
      ...manifestRuns.map(commandEvidence),
      commandEvidence(stateRun),
    ],
    commands: [
      {
        tool: 'cobolt-spec-verify.js',
        status: specRun.status,
        output: path.relative(projectRoot, specReportPath).replaceAll('\\', '/'),
      },
      {
        tool: 'cobolt-capability-graph.js',
        status: capabilityRun.status,
        output: path.relative(projectRoot, capabilityReportPath).replaceAll('\\', '/'),
      },
    ],
    artifacts: [specReportPath, capabilityReportPath, reportJsonPath, reportMdPath].map((file) =>
      path.relative(projectRoot, file).replaceAll('\\', '/'),
    ),
    summary,
    manifestRuns: manifestRuns.map((run) => ({ tool: run.tool, status: run.status, ok: run.ok })),
    stateRun: { status: stateRun.status, ok: stateRun.ok },
  };
  writeJson(path.join(proofDir, `${milestone}-03a-code-gap-analysis.proof.json`), proof);
  syncBuildExecutionLedger(projectRoot, milestone, {
    checkpointPath: path.join(checkpointsDir, `${milestone}-03a-code-gap-analysis.json`),
    checkpointId: '03a-code-gap-analysis',
  });
  projectExecutionLedger(projectRoot);

  assertHandoffRuns(manifestRuns, stateRun);

  if (!passed) {
    const err = new Error(`Critical/high code gaps remain: critical=${summary.critical}, high=${summary.high}`);
    err.report = { ...proof, codeGapReport: path.relative(projectRoot, reportJsonPath).replaceAll('\\', '/') };
    throw err;
  }

  return { ok: true, ...proof, codeGapReport: path.relative(projectRoot, reportJsonPath).replaceAll('\\', '/') };
}

function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      console.log(usage());
      return 0;
    }
    if (options.command !== 'run') {
      console.error(usage());
      return 2;
    }
    const result = runCodeGapStep(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`Step 03A code gap analysis passed for ${options.milestone}.`);
    return 0;
  } catch (error) {
    const payload = {
      ok: false,
      error: String(error?.message ? error.message : error),
      ...(error?.report ? { report: error.report } : {}),
    };
    if (options?.json) console.log(JSON.stringify(payload, null, 2));
    else console.error(payload.error);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  capabilityGaps,
  collectFiles,
  main,
  parseArgs,
  renderMarkdown,
  runManifestInProcess,
  runCodeGapStep,
  specGaps,
  summarizeGaps,
};
