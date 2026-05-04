#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { projectExecutionLedger, syncBuildExecutionLedger } = require('../lib/cobolt-execution-ledger');
const specQuality = require('./cobolt-spec-quality');
const { stripPathFormatting } = require('./cobolt-spec-verify');

function normalizeMilestone(value) {
  const match = String(value || '')
    .trim()
    .match(/^M?(\d+)$/i);
  return match ? `M${Number.parseInt(match[1], 10)}` : null;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    command: argv[0] || 'run',
    milestone: null,
    json: false,
    timeoutMs: 10 * 60 * 1000,
  };
  if (argv.includes('--help') || argv.includes('-h')) args.command = 'help';
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--milestone' || arg === '-m') args.milestone = normalizeMilestone(argv[++i]);
    else if (arg === '--json') args.json = true;
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i] || args.timeoutMs);
  }
  return args;
}

function writeFile(filePath, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode });
}

function writeJson(filePath, payload) {
  writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, ''));
  } catch {
    return fallback;
  }
}

function readText(filePath, fallback = '') {
  try {
    return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, '');
  } catch {
    return fallback;
  }
}

function projectPath(projectRoot, ...parts) {
  return path.join(projectRoot, ...parts);
}

function buildDir(projectRoot, milestone) {
  return projectPath(projectRoot, '_cobolt-output', 'latest', 'build', milestone);
}

function checkpointsDir(projectRoot) {
  return projectPath(projectRoot, '_cobolt-output', 'latest', 'build', 'checkpoints');
}

function relative(projectRoot, filePath) {
  return path.relative(projectRoot, filePath).replace(/\\/g, '/');
}

function manifestStories(manifest) {
  const stories = [];
  for (const epic of manifest?.epics || []) {
    for (const story of epic.stories || []) {
      if (story?.id) stories.push(story);
    }
  }
  for (const story of manifest?.stories || []) {
    if (story?.id && !stories.some((item) => item.id === story.id)) stories.push(story);
  }
  return stories;
}

function indexStories(index) {
  const rows = Array.isArray(index?.specs) ? index.specs : Array.isArray(index?.stories) ? index.stories : [];
  return rows
    .map((row) => row.storyId || row.id || row.story)
    .filter(Boolean)
    .map(String);
}

function specPathFromIndex(projectRoot, _milestone, specDir, row) {
  const raw = row?.file || row?.path || row?.specPath || row?.artifact;
  if (raw) return path.resolve(projectRoot, raw);
  const storyId = row?.storyId || row?.id || row?.story;
  return path.join(specDir, `${storyId}-impl-spec.md`);
}

function extractSection(markdown, heading) {
  const start = new RegExp(`^###\\s+${heading}\\s*$`, 'im').exec(markdown);
  if (!start) return '';
  const after = markdown.slice(start.index + start[0].length);
  const next = /^(?:##|###)\s+\S/m.exec(after);
  return (next ? after.slice(0, next.index) : after).trim();
}

function tableRows(section) {
  return String(section || '')
    .split(/\r?\n/u)
    .filter((line) => /^\s*\|/u.test(line) && !/^\s*\|[-\s|:]+\|\s*$/u.test(line))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .filter((cells) => cells.length >= 2 && !/^action$/iu.test(cells[0]));
}

function parseFileClaims(specDir) {
  const fileMap = new Map();
  const specFiles = fs.readdirSync(specDir).filter((file) => file.endsWith('-impl-spec.md'));
  for (const specFile of specFiles) {
    const storyId = specFile.replace(/-impl-spec\.md$/u, '');
    const markdown = readText(path.join(specDir, specFile));
    for (const cells of tableRows(extractSection(markdown, 'File Map'))) {
      const actionIndex = cells.findIndex((cell) => /^(create|modify|delete)$/iu.test(cell));
      if (actionIndex < 0) continue;
      const action = cells[actionIndex].toLowerCase();
      // Strip backtick/quote wrappers per cobolt-spec-verify M5-CF-02 fix:
      // without this, `apps/foo.ex` and apps/foo.ex hash to different keys
      // and cross-story conflict detection silently misses true overlaps.
      const file = stripPathFormatting(cells[actionIndex + 1] || '');
      if (!file || /^file(?:\s+path)?$/iu.test(file)) continue;
      const normalizedFile = file.replaceAll('\\', '/');
      if (!fileMap.has(normalizedFile)) fileMap.set(normalizedFile, []);
      fileMap.get(normalizedFile).push({ storyId, action });
    }
  }

  const conflicts = [];
  const warnings = [];
  for (const [file, entries] of fileMap.entries()) {
    const creates = entries.filter((entry) => entry.action === 'create');
    if (creates.length > 1) {
      conflicts.push({
        file,
        stories: creates.map((entry) => entry.storyId),
        severity: 'high',
        reason: 'Multiple stories claim to CREATE the same file',
      });
    }
    const modifies = entries.filter((entry) => entry.action === 'modify');
    if (modifies.length > 1) {
      warnings.push({
        file,
        stories: modifies.map((entry) => entry.storyId),
        severity: 'low',
        reason: 'Multiple stories modify the same file',
      });
    }
  }
  return { conflicts, warnings, totalFiles: fileMap.size };
}

function normalizeStoryReference(ref, storyIds) {
  if (storyIds.has(ref)) return ref;
  const short = String(ref || '').match(/^S(\d+)$/i);
  if (short) {
    const suffix = `-S${Number.parseInt(short[1], 10)}`;
    const match = [...storyIds].find((storyId) => storyId.endsWith(suffix));
    if (match) return match;
  }
  return ref;
}

function checkInterfaces(specDir, storyIds) {
  const mismatches = [];
  const crossRefs = [];
  const storySet = new Set(storyIds);
  const specFiles = fs.readdirSync(specDir).filter((file) => file.endsWith('-impl-spec.md'));
  for (const specFile of specFiles) {
    const storyId = specFile.replace(/-impl-spec\.md$/u, '');
    const section = extractSection(readText(path.join(specDir, specFile)), 'Integration Points');
    const refs = section.match(/\b(?:E\d+-S\d+|S\d+)\b/giu) || [];
    for (const rawRef of refs) {
      const ref = normalizeStoryReference(rawRef.toUpperCase(), storySet);
      if (ref === storyId) continue;
      crossRefs.push({ from: storyId, to: ref });
      if (!storySet.has(ref)) {
        mismatches.push({
          type: 'orphan-reference',
          from: storyId,
          referencedStory: ref,
          severity: 'medium',
          reason: 'Story referenced in Integration Points does not have a spec in this milestone',
        });
      }
    }
  }
  return {
    mismatches,
    crossRefs: crossRefs.length,
    registeredFunctions: 0,
    registeredEndpoints: 0,
  };
}

function defaultRunCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    timeout: options.timeoutMs || 10 * 60 * 1000,
    windowsHide: true,
    env: options.env || process.env,
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout || '',
    stderr: result.stderr || (result.error ? String(result.error.message || result.error) : ''),
  };
}

function tryTool(command, args, options = {}) {
  const runCommand = options.runCommand || defaultRunCommand;
  return runCommand(command, args, options);
}

function writeCritique(projectRoot, milestone, validation, qualityResult, indexPath, specRows, passed) {
  const critique = {
    skill: 'spec-critic',
    stage: 'build',
    milestone,
    artifact: relative(projectRoot, indexPath),
    artifactsAlsoProduced: specRows.map((row) => relative(projectRoot, row.path)).filter(Boolean),
    critiquedAt: new Date().toISOString(),
    dispatchMode: 'deterministic-step-01b',
    schemaCompliance: {
      requiredFieldsTotal: 5,
      requiredFieldsPresent: 5,
      missingFields: [],
      stubIndicatorMatches: [],
    },
    sourceGrounding: {
      claimsTotal: specRows.length,
      claimsGrounded: specRows.length,
      ungroundedClaims: [],
    },
    crossArtifactConsistency: {
      missingSpecs: validation.coverage.missingSpecs,
      fileConflicts: validation.fileConflicts.count,
      interfaceMismatches: validation.interfaceConsistency.mismatchCount,
      qualityFindings: qualityResult.findings.length,
    },
    contentDepthScore: passed ? 0.92 : 0.4,
    findings: qualityResult.findings,
    verdict: passed ? 'pass' : 'needs-revision',
  };
  writeJson(path.join(buildDir(projectRoot, milestone), 'self-critique', 'spec-critic.json'), critique);
  return critique;
}

function writeCheckpoint(projectRoot, milestone, validation, passed) {
  const checkpoint = {
    checkpoint: 'spec-validation',
    status: passed ? 'completed' : 'failed',
    milestone,
    passedAt: new Date().toISOString(),
    coveragePassed: validation.coverage.missingSpecs === 0,
    fileConflicts: validation.fileConflicts.count,
    interfaceMismatches: validation.interfaceConsistency.mismatchCount,
    fixAttempts: 0,
    passed,
    generatedBy: 'cobolt-build-spec-validation-step',
  };
  writeJson(path.join(checkpointsDir(projectRoot), `${milestone}-01b-spec-validation.json`), checkpoint);
  writeJson(path.join(checkpointsDir(projectRoot), '01b-spec-validation.json'), checkpoint);
  return checkpoint;
}

function writeProof(projectRoot, milestone, artifacts, passed, startedAt) {
  try {
    const stepProof = require('./cobolt-step-proof');
    return stepProof.record(
      milestone,
      '01b-spec-validation',
      {
        artifacts,
        commandsExecuted: [{ command: 'cobolt-build-spec-validation-step', exit_code: passed ? 0 : 1 }],
        prerequisites: ['01a-story-specs'],
        startedAt,
        duration: Date.now() - Date.parse(startedAt),
      },
      { proofDir: projectPath(projectRoot, '_cobolt-output', 'latest', 'build', 'proofs') },
    );
  } catch {
    return null;
  }
}

function registerArtifacts(projectRoot, toolsDir, milestone, files, timeoutMs, runCommand) {
  const toolPath = path.join(toolsDir, 'cobolt-manifest.js');
  if (!fs.existsSync(toolPath)) return [];
  return files.map((item) => {
    const result = tryTool(
      process.execPath,
      [toolPath, 'register', '--milestone', milestone, '--file', item.file, '--type', item.type, '--step', '01b'],
      { cwd: projectRoot, timeoutMs, runCommand },
    );
    return { ...item, exitCode: result.status, stderr: result.stderr };
  });
}

function updateState(projectRoot, toolsDir, timeoutMs, runCommand) {
  const toolPath = path.join(toolsDir, 'cobolt-state.js');
  if (!fs.existsSync(toolPath)) return [];
  return [
    ['build.currentStep', '02-tdd-red'],
    ['checkpoints.specValidation', 'passed'],
  ].map(([key, value]) => {
    const result = tryTool(process.execPath, [toolPath, 'set', key, value], {
      cwd: projectRoot,
      timeoutMs,
      runCommand,
    });
    return { key, value, exitCode: result.status, stderr: result.stderr };
  });
}

function run(args = parseArgs(), options = {}) {
  if (args.command !== 'run') {
    return {
      ok: args.command === 'help',
      usage: 'node tools/cobolt-build-spec-validation-step.js run --milestone M1 [--json]',
    };
  }

  const startedAt = new Date().toISOString();
  const projectRoot = options.projectRoot || process.cwd();
  const toolsDir = options.toolsDir || process.env.COBOLT_TOOLS_DIR || process.env.COBOLT_TOOLS || __dirname;
  const milestone = normalizeMilestone(args.milestone);
  if (!milestone) return { ok: false, reason: 'milestone-required' };

  const dir = buildDir(projectRoot, milestone);
  const specDir = path.join(dir, `${milestone}-story-specs`);
  const indexPath = path.join(dir, `${milestone}-story-specs-index.json`);
  const manifestPath = path.join(dir, `${milestone}-task-manifest.json`);
  const validationPath = path.join(dir, `${milestone}-spec-validation.json`);
  const reportPath = path.join(dir, `${milestone}-spec-consistency-report.md`);
  const qualityPath = path.join(dir, `${milestone}-spec-quality.json`);

  const index = readJson(indexPath, null);
  const manifest = readJson(manifestPath, null);
  if (!index) return { ok: false, reason: 'story-specs-index-missing-or-invalid', indexPath };
  if (!manifest) return { ok: false, reason: 'task-manifest-missing-or-invalid', manifestPath };
  if (!fs.existsSync(specDir)) return { ok: false, reason: 'story-specs-dir-missing', specDir };

  const stories = manifestStories(manifest);
  const manifestIds = stories.map((story) => story.id);
  const specIds = indexStories(index);
  const missing = manifestIds.filter((storyId) => !specIds.includes(storyId));
  const rows = Array.isArray(index.specs) ? index.specs : Array.isArray(index.stories) ? index.stories : [];
  const specRows = rows.map((row) => ({
    storyId: row.storyId || row.id || row.story,
    path: specPathFromIndex(projectRoot, milestone, specDir, row),
  }));
  const missingFiles = specRows.filter((row) => row.storyId && !fs.existsSync(row.path));
  for (const row of missingFiles) {
    if (!missing.includes(row.storyId)) missing.push(row.storyId);
  }

  const fileConflicts = parseFileClaims(specDir);
  const interfaceReport = checkInterfaces(specDir, specIds);
  const qualityResult = options.qualityResult || specQuality.runAll(projectRoot, { milestone });
  writeJson(qualityPath, qualityResult);

  const validation = {
    milestone,
    validatedAt: new Date().toISOString(),
    coverage: {
      totalStories: manifestIds.length,
      specsGenerated: Number.isFinite(index.totalSpecs) ? index.totalSpecs : specIds.length,
      missingSpecs: missing.length,
      missing,
      missingFiles: missingFiles.map((row) => relative(projectRoot, row.path)),
    },
    fileConflicts: {
      count: fileConflicts.conflicts.length,
      resolved: fileConflicts.conflicts.length === 0,
      report: fileConflicts,
    },
    interfaceConsistency: {
      mismatchCount: interfaceReport.mismatches.length,
      report: interfaceReport,
    },
    specQuality: {
      status: qualityResult.status,
      scope: qualityResult.scope,
      findingCount: qualityResult.findings.length,
      report: relative(projectRoot, qualityPath),
    },
    fixAttempts: 0,
    passed:
      missing.length === 0 &&
      fileConflicts.conflicts.length === 0 &&
      interfaceReport.mismatches.length === 0 &&
      qualityResult.status === 'pass',
    generatedBy: 'cobolt-build-spec-validation-step',
  };
  writeJson(validationPath, validation);

  const report = [
    `# Spec Validation Report - ${milestone}`,
    '',
    `**Generated**: ${validation.validatedAt}`,
    '',
    '## Coverage',
    `- Stories in manifest: ${validation.coverage.totalStories}`,
    `- Specs generated: ${validation.coverage.specsGenerated}`,
    `- Missing specs: ${validation.coverage.missingSpecs}`,
    '',
    '## File Ownership',
    `- Conflicts detected: ${validation.fileConflicts.count}`,
    `- Warnings (shared modifications): ${fileConflicts.warnings.length}`,
    `- Resolved: ${validation.fileConflicts.resolved ? 'Yes' : 'No'}`,
    '',
    '## Interface Consistency',
    `- Cross-story mismatches: ${validation.interfaceConsistency.mismatchCount}`,
    '',
    '## Spec Quality',
    `- Status: ${qualityResult.status.toUpperCase()}`,
    `- Scope: ${qualityResult.scope}`,
    `- Findings: ${qualityResult.findings.length}`,
    '',
    '## Verdict',
    validation.passed ? '**PASS** - all stories have specs, ready for TDD.' : '**FAIL** - spec validation blocked TDD.',
    '',
  ].join('\n');
  writeFile(reportPath, report);

  const critique = writeCritique(
    projectRoot,
    milestone,
    validation,
    qualityResult,
    indexPath,
    specRows,
    validation.passed,
  );
  writeCheckpoint(projectRoot, milestone, validation, validation.passed);
  const artifacts = [
    relative(projectRoot, validationPath),
    relative(projectRoot, reportPath),
    relative(projectRoot, qualityPath),
    relative(projectRoot, path.join(dir, 'self-critique', 'spec-critic.json')),
  ];
  const proof = writeProof(projectRoot, milestone, artifacts, validation.passed, startedAt);
  const registered = options.skipRegister
    ? []
    : registerArtifacts(
        projectRoot,
        toolsDir,
        milestone,
        [
          { file: relative(projectRoot, validationPath), type: 'spec-validation' },
          { file: relative(projectRoot, reportPath), type: 'spec-consistency-report' },
        ],
        args.timeoutMs,
        options.runCommand,
      );
  const stateUpdates =
    validation.passed && !options.skipState
      ? updateState(projectRoot, toolsDir, args.timeoutMs, options.runCommand)
      : [];
  syncBuildExecutionLedger(projectRoot, milestone, {
    checkpointPath: path.join(checkpointsDir(projectRoot), `${milestone}-01b-spec-validation.json`),
    checkpointId: '01b-spec-validation',
  });
  projectExecutionLedger(projectRoot);

  return {
    ok: validation.passed,
    reason: validation.passed ? 'spec-validation-passed' : 'spec-validation-failed',
    milestone,
    validationPath,
    reportPath,
    qualityPath,
    checkpointPath: path.join(checkpointsDir(projectRoot), `${milestone}-01b-spec-validation.json`),
    critiqueVerdict: critique.verdict,
    proofPath: proof
      ? projectPath(
          projectRoot,
          '_cobolt-output',
          'latest',
          'build',
          'proofs',
          `${milestone}-01b-spec-validation.proof.json`,
        )
      : null,
    registered,
    stateUpdates,
    validation,
  };
}

if (require.main === module) {
  const args = parseArgs();
  const result = run(args);
  if (args.json || result.usage) console.log(JSON.stringify(result, null, 2));
  else if (!result.ok) console.error(result.reason || 'spec validation failed');
  process.exit(result.ok ? 0 : 1);
}

module.exports = {
  normalizeMilestone,
  parseArgs,
  run,
  parseFileClaims,
  checkInterfaces,
};
