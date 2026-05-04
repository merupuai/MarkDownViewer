#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { projectExecutionLedger, syncBuildExecutionLedger } = require('../lib/cobolt-execution-ledger');
const { UatOrchestrator } = require('./cobolt-uat');

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

function relative(projectRoot, filePath) {
  return path.relative(projectRoot, filePath).replace(/\\/g, '/');
}

function pascal(value) {
  const text = String(value || '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/\s+/g, '');
  return text || 'Milestone';
}

function manifestStories(manifest) {
  const stories = [];
  for (const epic of manifest?.epics || []) {
    for (const story of epic.stories || []) if (story?.id) stories.push(story);
  }
  for (const story of manifest?.stories || []) {
    if (story?.id && !stories.some((item) => item.id === story.id)) stories.push(story);
  }
  return stories;
}

function specRows(index) {
  const rows = Array.isArray(index?.specs) ? index.specs : Array.isArray(index?.stories) ? index.stories : [];
  return rows.map((row) => ({
    storyId: row.storyId || row.id || row.story,
    file: row.file || row.path || row.specPath,
  }));
}

function extractSection(markdown, heading) {
  const start = new RegExp(`^###\\s+${heading}\\s*$`, 'im').exec(markdown);
  if (!start) return '';
  const after = markdown.slice(start.index + start[0].length);
  const next = /^(?:##|###)\s+\S/m.exec(after);
  return (next ? after.slice(0, next.index) : after).trim();
}

function extractSignatures(markdown) {
  return extractSection(markdown, 'Function Signatures')
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*[-*]\s*/u, '').trim())
    .filter(Boolean);
}

function storyRequirementIds(story, specText = '') {
  const ids = new Set([
    ...(story.requirementIds || []),
    ...(story.frIds || []),
    ...(story.nfrIds || []),
    ...(story.trIds || []),
    ...(story.irIds || []),
  ]);
  for (const match of specText.matchAll(/\b(?:FR|NFR|TR|IR|FEAT)-\d{3}\b/giu)) ids.add(match[0].toUpperCase());
  return [...ids].sort();
}

function storySpec(projectRoot, milestone, row) {
  const file = row?.file
    ? path.resolve(projectRoot, row.file)
    : path.join(buildDir(projectRoot, milestone), `${milestone}-story-specs`, `${row.storyId}-impl-spec.md`);
  return { file, text: readText(file) };
}

function inferTestProfile(manifest, classification = {}, milestone = 'M1') {
  const surfaces = new Set(classification.surfaces || []);
  const stackText = [
    ...(manifest?.techStack?.languages || []),
    ...(manifest?.techStack?.frameworks || []),
    ...(manifest?.techStack?.libraries || []),
    ...(classification.frameworks || []),
    ...surfaces,
  ]
    .join(' ')
    .toLowerCase();
  const nativeDesktop =
    /\b(wpf|winui|maui|avalonia|\.net|c#)\b/i.test(stackText) && !/\b(react|vite|fastapi|web-ui)\b/i.test(stackText);
  if (nativeDesktop) {
    return {
      kind: 'dotnet-desktop',
      testRoot: 'tests/WorldClockDesktop.Tests',
      extension: 'cs',
      integrationDescription: 'Typed C# service/repository/view-model integration contracts',
    };
  }
  if (!surfaces.has('api') && !surfaces.has('web-ui')) {
    return {
      kind: 'node-local',
      testRoot: `tests/${String(milestone || 'M1').toLowerCase()}`,
      extension: 'test.js',
      integrationDescription: 'Local module, documentation, and contract integration tests',
    };
  }
  return {
    kind: 'web-api',
    testRoot: `tests/${String(milestone || 'M1').toLowerCase()}`,
    extension: 'test.js',
    integrationDescription: 'HTTP/API adapter, repository, and UI contract integration tests',
  };
}

function webApiTestFile(round, story, title, reqs, caseIds, surfaces, profile) {
  const storySlug = String(story.id || title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const basePath = `${profile.testRoot}/${storySlug}`;
  if (round === 1) {
    return {
      path: `${basePath}.foundation.${profile.extension}`,
      type: 'foundation',
      surface: 'data',
      testCount: 3,
      writer: 'db-test-agent',
      stories: [story.id],
      requirements: reqs,
      coverageTargets: ['database schema defaults', 'tenant-scoped persistence', 'migration/fixture integrity'],
    };
  }
  if (round === 2) {
    return {
      path: `${basePath}.service.${profile.extension}`,
      type: 'unit',
      surface: 'service',
      testCount: 4,
      writer: 'backend-dev',
      stories: [story.id],
      requirements: reqs,
      coverageTargets: ['domain service behavior', 'edge cases', 'negative cases', 'audit emission'],
    };
  }
  if (round === 3) {
    return {
      path: `${basePath}.contract.${profile.extension}`,
      type: 'integration',
      surface: 'api-contract',
      testCount: 3,
      writer: 'integration-test-agent',
      stories: [story.id],
      requirements: reqs,
      coverageTargets: ['FastAPI/HTTP contracts', 'repository/service handoff', 'auth and error envelopes'],
    };
  }
  if (round === 4) {
    return {
      path: `${basePath}.ui.spec.ts`,
      type: 'web-ui',
      surface: surfaces.includes('web-ui') ? 'web-ui' : 'api',
      testCount: 3,
      writer: 'uat-agent',
      stories: [story.id],
      requirements: reqs,
      uatCaseIds: caseIds,
      coverageTargets: ['React UI states', 'keyboard path', 'WCAG accessibility labels'],
    };
  }
  return {
    path: `${basePath}.release.${profile.extension}`,
    type: 'release',
    surface: 'release',
    testCount: 2,
    writer: 'test-writer',
    stories: [story.id],
    requirements: reqs,
    coverageTargets: ['release readiness evidence', 'security posture', 'deployment smoke metadata'],
  };
}

function nodeLocalTestFile(round, story, title, reqs, caseIds, surfaces, profile) {
  const storySlug = String(story.id || title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const basePath = `${profile.testRoot}/${storySlug}`;
  const primarySurface =
    surfaces.find((surface) => ['cli', 'library', 'code-workflow', 'data'].includes(surface)) || 'code-workflow';
  if (round === 1) {
    return {
      path: `${basePath}.foundation.${profile.extension}`,
      type: 'foundation',
      surface: primarySurface,
      testCount: 3,
      writer: 'test-writer',
      stories: [story.id],
      requirements: reqs,
      coverageTargets: ['local module bootstrap', 'dependency-free loading', 'deterministic fixture preconditions'],
    };
  }
  if (round === 2) {
    return {
      path: `${basePath}.service.${profile.extension}`,
      type: 'unit',
      surface: primarySurface,
      testCount: 4,
      writer: 'backend-dev',
      stories: [story.id],
      requirements: reqs,
      coverageTargets: ['exported behavior', 'edge cases', 'negative cases', 'documentation parity'],
    };
  }
  if (round === 3) {
    return {
      path: `${basePath}.contract.${profile.extension}`,
      type: 'integration',
      surface: 'internal-contract',
      testCount: 3,
      writer: 'integration-test-agent',
      stories: [story.id],
      requirements: reqs,
      coverageTargets: ['module export contract', 'documentation/implementation handoff', 'local no-network behavior'],
    };
  }
  if (round === 4) {
    return {
      path: `${basePath}.acceptance.${profile.extension}`,
      type: 'acceptance',
      surface: primarySurface,
      testCount: 3,
      writer: 'uat-agent',
      stories: [story.id],
      requirements: reqs,
      uatCaseIds: caseIds,
      coverageTargets: [
        'documented usage flow',
        'negative and edge acceptance behavior',
        'deterministic replay evidence',
      ],
    };
  }
  return {
    path: `${basePath}.release.${profile.extension}`,
    type: 'release',
    surface: 'release',
    testCount: 2,
    writer: 'test-writer',
    stories: [story.id],
    requirements: reqs,
    coverageTargets: ['release readiness evidence', 'security posture', 'deployment smoke metadata'],
  };
}

function makeTestFile(round, story, requirements, caseIds, surfaces, profile) {
  const title = pascal(story.title || story.id);
  const reqs = requirements.length ? requirements : [`${story.id}-REQ`];
  if (profile?.kind === 'node-local') {
    return nodeLocalTestFile(round, story, title, reqs, caseIds, surfaces, profile);
  }
  if (profile?.kind !== 'dotnet-desktop') {
    return webApiTestFile(round, story, title, reqs, caseIds, surfaces, profile);
  }
  if (round === 1) {
    return {
      path: `tests/WorldClockDesktop.Tests/Persistence/${title}PersistenceFoundationTests.cs`,
      type: 'foundation',
      surface: 'data',
      testCount: 3,
      writer: 'test-writer',
      stories: [story.id],
      requirements: reqs,
      coverageTargets: ['schema defaults', 'atomic local persistence', 'corrupt/legacy data fallback'],
    };
  }
  if (round === 2) {
    return {
      path: `tests/WorldClockDesktop.Tests/Services/${title}ServiceTests.cs`,
      type: 'unit',
      surface: 'service',
      testCount: 4,
      writer: 'test-writer',
      stories: [story.id],
      requirements: reqs,
      coverageTargets: ['core service behavior', 'edge cases', 'negative cases', 'NodaTime deterministic inputs'],
    };
  }
  if (round === 3) {
    return {
      path: `tests/WorldClockDesktop.Tests/Integration/${title}InternalContractTests.cs`,
      type: 'integration',
      surface: 'internal-contract',
      testCount: 3,
      writer: 'integration-test-agent',
      stories: [story.id],
      requirements: reqs,
      coverageTargets: ['typed C# interfaces', 'repository/service/view-model handoff', 'no HTTP endpoint assumption'],
    };
  }
  if (round === 4) {
    return {
      path: `tests/WorldClockDesktop.Tests/UI/${title}NativeUiAutomationTests.cs`,
      type: 'native-ui',
      surface: surfaces.includes('native-ui') ? 'native-ui' : 'web-ui',
      testCount: 3,
      writer: 'uat-agent',
      stories: [story.id],
      requirements: reqs,
      uatCaseIds: caseIds,
      coverageTargets: ['desktop UI state', 'keyboard path', 'AutomationProperties accessibility labels'],
    };
  }
  return {
    path: `tests/WorldClockDesktop.Tests/Release/${title}ReleaseReadinessTests.cs`,
    type: 'release',
    surface: 'release',
    testCount: 2,
    writer: 'test-writer',
    stories: [story.id],
    requirements: reqs,
    coverageTargets: [
      'local-only release package',
      'offline/privacy posture',
      'release evidence',
      'publish-only release metadata that does not change Debug test restore inputs',
    ],
  };
}

function buildPlan(projectRoot, milestone, manifest, index, classification, uatCases) {
  const specs = new Map(specRows(index).map((row) => [row.storyId, row]));
  const stories = manifestStories(manifest);
  const surfaces = classification.surfaces || [];
  const profile = inferTestProfile(manifest, classification, milestone);
  const caseIdsByStory = new Map();
  for (const testCase of uatCases.cases || []) {
    for (const req of testCase.requirementIds || []) {
      for (const story of stories) {
        const row = specs.get(story.id);
        const spec = storySpec(projectRoot, milestone, row);
        const reqs = storyRequirementIds(story, spec.text);
        if (reqs.includes(req)) {
          if (!caseIdsByStory.has(story.id)) caseIdsByStory.set(story.id, []);
          caseIdsByStory.get(story.id).push(testCase.id);
        }
      }
    }
  }

  const roundDefs = [
    {
      id: 1,
      name: 'foundation',
      description: 'Local persistence, schema, configuration, and offline data preconditions',
    },
    { id: 2, name: 'core', description: 'Domain models, services, settings, projections, and business logic' },
    { id: 3, name: 'internal-contract', description: profile.integrationDescription },
    {
      id: 4,
      name: surfaces.includes('native-ui') ? 'native-ui' : surfaces.includes('web-ui') ? 'frontend' : 'acceptance',
      description:
        surfaces.includes('native-ui') || surfaces.includes('web-ui')
          ? 'User-facing UI, accessibility, and UAT coverage'
          : 'Acceptance flows, documentation parity, and deterministic replay coverage',
    },
    {
      id: 5,
      name: 'finalize',
      description: 'Release readiness, local-only privacy, packaging, and cross-cutting evidence',
    },
  ];

  const rounds = roundDefs.map((roundDef) => ({
    ...roundDef,
    testFiles: [],
    builders: [],
    dependsOn: [],
    skip: false,
  }));
  for (const story of stories) {
    const row = specs.get(story.id);
    const spec = storySpec(projectRoot, milestone, row);
    const requirements = storyRequirementIds(story, spec.text);
    const signatureCount = extractSignatures(spec.text).length;
    for (const round of rounds) {
      const file = makeTestFile(
        round.id,
        story,
        requirements,
        [...new Set(caseIdsByStory.get(story.id) || [])],
        surfaces,
        profile,
      );
      file.testCount = Math.max(
        file.testCount,
        round.id === 2 ? Math.min(8, Math.max(2, signatureCount)) : file.testCount,
      );
      rounds[round.id - 1].testFiles.push(file);
    }
  }
  rounds[1].dependsOn = [1];
  rounds[2].dependsOn = [1, 2];
  rounds[3].dependsOn = [1, 2, 3];
  rounds[4].dependsOn = [1, 2, 3, 4];

  const totalTests = rounds.reduce(
    (sum, round) => sum + round.testFiles.reduce((inner, file) => inner + file.testCount, 0),
    0,
  );
  const byRound = Object.fromEntries(rounds.map((round) => [round.name, round.testFiles.length]));
  return {
    milestone,
    generatedAt: new Date().toISOString(),
    sourceArtifacts: {
      taskManifest: `${milestone}-task-manifest.json`,
      storySpecsIndex: `${milestone}-story-specs-index.json`,
      storySpecs: specRows(index)
        .map((row) => row.file)
        .filter(Boolean),
      docsCache: `${milestone}-docs-cache.md`,
      uatCases: `${milestone}-uat-cases.json`,
    },
    hasUI: classification.hasUI === true,
    surfaces,
    totalRounds: rounds.length,
    stories_covered: stories.map((story) => story.id),
    rounds,
    summary: {
      totalTests,
      totalFiles: rounds.reduce((sum, round) => sum + round.testFiles.length, 0),
      byRound,
      bySurface: surfaces,
    },
  };
}

function buildManifestFromPlan(milestone, plan) {
  const testFiles = plan.rounds.flatMap((round) =>
    round.testFiles.map((file) => ({
      path: file.path,
      type: file.type,
      surface: file.surface,
      tests: file.testCount || 0,
      assertions: 0,
      stories: file.stories || [],
      requirements: file.requirements || [],
      round: round.id,
      writer: file.writer,
    })),
  );
  const byType = {};
  for (const file of testFiles) byType[file.type] = (byType[file.type] || 0) + 1;
  return {
    milestone,
    generatedAt: new Date().toISOString(),
    tddPhase: 'planned',
    testFiles,
    summary: {
      totalFiles: testFiles.length,
      totalTests: plan.summary.totalTests,
      totalAssertions: 0,
      byType,
      byRound: plan.summary.byRound,
    },
    compileVerification: { result: 'pending', compileErrors: 0, testFailures: 0, retryAttempts: 0 },
  };
}

function buildStrategy(milestone, plan, classification, uatCases) {
  return [
    `# ${milestone} Test Strategy - TDD RED`,
    '',
    `Generated: ${plan.generatedAt}`,
    '',
    '## Scope',
    `This milestone targets ${classification.frameworks?.join(', ') || 'the detected stack'} with surfaces: ${plan.surfaces.join(', ') || 'code-workflow'}.`,
    'HTTP/browser checks are required only when the UAT surface classification includes web-ui; native desktop coverage uses WPF/native UI automation and accessibility evidence.',
    '',
    '## Round Plan',
    ...plan.rounds.map(
      (round) => `${round.id}. ${round.name}: ${round.description} (${round.testFiles.length} files).`,
    ),
    '',
    '## UAT Integration',
    `UAT cases generated: ${uatCases.summary?.casesTotal || 0}.`,
    `Module-action gaps: ${uatCases.summary?.moduleActionCoverageGaps || 0}.`,
    '',
    '## Traceability',
    ...plan.stories_covered.map((storyId) => {
      const reqs = [
        ...new Set(
          plan.rounds.flatMap((round) =>
            round.testFiles
              .filter((file) => file.stories?.includes(storyId))
              .flatMap((file) => file.requirements || []),
          ),
        ),
      ];
      return `- ${storyId}: ${reqs.join(', ') || 'story-scoped requirements'}.`;
    }),
    '',
  ].join('\n');
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

function registerArtifacts(projectRoot, toolsDir, milestone, files, timeoutMs, runCommand) {
  const toolPath = path.join(toolsDir, 'cobolt-manifest.js');
  if (!fs.existsSync(toolPath)) return [];
  return files.map((item) => {
    const result = (runCommand || defaultRunCommand)(
      process.execPath,
      [toolPath, 'register', '--milestone', milestone, '--file', item.file, '--type', item.type, '--step', '02'],
      { cwd: projectRoot, timeoutMs },
    );
    return { ...item, exitCode: result.status, stderr: result.stderr };
  });
}

function updateState(projectRoot, toolsDir, _milestone, plan, timeoutMs, runCommand) {
  const toolPath = path.join(toolsDir, 'cobolt-state.js');
  if (!fs.existsSync(toolPath)) return [];
  const result = (runCommand || defaultRunCommand)(
    process.execPath,
    [
      toolPath,
      'batch-set',
      'build.currentStep',
      '03-tdd-green',
      'build.tddPhase',
      'planned',
      'build.totalRounds',
      String(plan.totalRounds),
      'build.currentRound',
      '1',
      'build.currentRoundPhase',
      'pending',
      'checkpoints.tddRed',
      'passed',
    ],
    { cwd: projectRoot, timeoutMs },
  );
  return [{ key: 'batch-set', exitCode: result.status, stderr: result.stderr }];
}

function writeCheckpoint(projectRoot, milestone, plan) {
  const checkpoint = {
    checkpoint: 'tdd-red',
    status: 'completed',
    milestone,
    passedAt: new Date().toISOString(),
    tddPhase: 'planned',
    testPlan: `${milestone}-test-plan.json`,
    testStrategy: `${milestone}-test-strategy.md`,
    totalRounds: plan.totalRounds,
    totalTestFiles: plan.summary.totalFiles,
    generatedBy: 'cobolt-build-tdd-red-step',
  };
  const checkpointDir = projectPath(projectRoot, '_cobolt-output', 'latest', 'build', 'checkpoints');
  writeJson(path.join(checkpointDir, `${milestone}-02-tdd-red.json`), checkpoint);
  writeJson(path.join(checkpointDir, '02-tdd-red.json'), checkpoint);
  return checkpoint;
}

function writeProof(projectRoot, milestone, artifacts, startedAt) {
  try {
    const stepProof = require('./cobolt-step-proof');
    return stepProof.record(
      milestone,
      '02-tdd-red',
      {
        testsPlanned: artifacts.length,
        artifacts,
        commandsExecuted: [{ command: 'cobolt-build-tdd-red-step', exit_code: 0 }],
        agentsDispatched: ['test-architect:deterministic-contract'],
        prerequisites: ['01b-spec-validation'],
        startedAt,
        duration: Date.now() - Date.parse(startedAt),
      },
      { proofDir: projectPath(projectRoot, '_cobolt-output', 'latest', 'build', 'proofs') },
    );
  } catch {
    return null;
  }
}

function run(args = parseArgs(), options = {}) {
  if (args.command !== 'run') {
    return {
      ok: args.command === 'help',
      usage: 'node tools/cobolt-build-tdd-red-step.js run --milestone M1 [--json]',
    };
  }

  const startedAt = new Date().toISOString();
  const projectRoot = options.projectRoot || process.cwd();
  const toolsDir = options.toolsDir || process.env.COBOLT_TOOLS_DIR || process.env.COBOLT_TOOLS || __dirname;
  const milestone = normalizeMilestone(args.milestone);
  if (!milestone) return { ok: false, reason: 'milestone-required' };

  const dir = buildDir(projectRoot, milestone);
  const manifest = readJson(path.join(dir, `${milestone}-task-manifest.json`), null);
  const index = readJson(path.join(dir, `${milestone}-story-specs-index.json`), null);
  if (!manifest) return { ok: false, reason: 'task-manifest-missing-or-invalid' };
  if (!index) return { ok: false, reason: 'story-specs-index-missing-or-invalid' };
  if (
    !fs.existsSync(
      path.join(
        projectRoot,
        '_cobolt-output',
        'latest',
        'build',
        'checkpoints',
        `${milestone}-01b-spec-validation.json`,
      ),
    )
  ) {
    return { ok: false, reason: 'step01b-checkpoint-missing' };
  }

  const stories = manifestStories(manifest);
  const specs = new Set(
    specRows(index)
      .map((row) => row.storyId)
      .filter(Boolean),
  );
  const missingSpecs = stories.filter((story) => !specs.has(story.id));
  if (missingSpecs.length > 0)
    return { ok: false, reason: 'missing-story-specs', missingSpecs: missingSpecs.map((story) => story.id) };

  const uat = options.uat || new UatOrchestrator(projectRoot);
  const classification = uat.classify({ milestone, write: true });
  const personas = uat.derivePersonas({ milestone, classification, write: true });
  const uatCases = uat.generateCases({
    milestone,
    mode: 'build',
    classification,
    personaMatrix: personas,
    write: true,
  });
  if ((uatCases.summary?.casesTotal || 0) < 1) return { ok: false, reason: 'uat-cases-empty' };
  if ((uatCases.summary?.moduleActionCoverageGaps || 0) > 0)
    return { ok: false, reason: 'uat-module-action-gaps', gaps: uatCases.moduleActionCoverageGaps };

  const plan = buildPlan(projectRoot, milestone, manifest, index, classification, uatCases);
  if (plan.summary.totalFiles < 1) return { ok: false, reason: 'test-plan-empty' };
  if (plan.stories_covered.length !== stories.length) return { ok: false, reason: 'story-coverage-gap' };
  if (classification.surfaces?.includes('native-ui')) {
    const nativeFiles = plan.rounds.flatMap((round) => round.testFiles).filter((file) => file.surface === 'native-ui');
    if (nativeFiles.length < 1) return { ok: false, reason: 'native-ui-tests-missing' };
  }
  if (classification.surfaces?.includes('web-ui')) {
    const webFiles = plan.rounds
      .flatMap((round) => round.testFiles)
      .filter((file) => file.surface === 'web-ui' && file.writer === 'uat-agent');
    if (webFiles.length < 1) return { ok: false, reason: 'web-ui-uat-tests-missing' };
  }

  const testPlanPath = path.join(dir, `${milestone}-test-plan.json`);
  const strategyPath = path.join(dir, `${milestone}-test-strategy.md`);
  const testManifestPath = path.join(dir, `${milestone}-test-manifest.json`);
  const classificationBuildPath = path.join(dir, `${milestone}-uat-classify.stdout.json`);
  const personasBuildPath = path.join(dir, `${milestone}-uat-personas.stdout.json`);
  const casesBuildPath = path.join(dir, `${milestone}-uat-cases.json`);
  const casesLegacyBuildPath = path.join(dir, `${milestone}-uat-cases.stdout.json`);
  writeJson(testPlanPath, plan);
  writeFile(strategyPath, buildStrategy(milestone, plan, classification, uatCases));
  writeJson(testManifestPath, buildManifestFromPlan(milestone, plan));
  writeJson(classificationBuildPath, classification);
  writeJson(personasBuildPath, personas);
  writeJson(casesBuildPath, uatCases);
  writeJson(casesLegacyBuildPath, uatCases);

  const checkpoint = writeCheckpoint(projectRoot, milestone, plan);
  const artifacts = [
    relative(projectRoot, testPlanPath),
    relative(projectRoot, strategyPath),
    relative(projectRoot, testManifestPath),
    relative(projectRoot, classificationBuildPath),
    relative(projectRoot, personasBuildPath),
    relative(projectRoot, casesBuildPath),
  ];
  const proof = writeProof(projectRoot, milestone, artifacts, startedAt);
  const registered = options.skipRegister
    ? []
    : registerArtifacts(
        projectRoot,
        toolsDir,
        milestone,
        [
          { file: relative(projectRoot, testPlanPath), type: 'test-plan' },
          { file: relative(projectRoot, strategyPath), type: 'test-strategy' },
          { file: relative(projectRoot, testManifestPath), type: 'test-manifest' },
        ],
        args.timeoutMs,
        options.runCommand,
      );
  const stateUpdates = options.skipState
    ? []
    : updateState(projectRoot, toolsDir, milestone, plan, args.timeoutMs, options.runCommand);
  syncBuildExecutionLedger(projectRoot, milestone, {
    checkpointPath: path.join(
      projectRoot,
      '_cobolt-output',
      'latest',
      'build',
      'checkpoints',
      `${milestone}-02-tdd-red.json`,
    ),
    checkpointId: '02-tdd-red',
  });
  projectExecutionLedger(projectRoot);

  return {
    ok: true,
    reason: 'tdd-red-planned',
    milestone,
    testPlanPath,
    strategyPath,
    testManifestPath,
    checkpoint,
    proofPath: proof
      ? projectPath(projectRoot, '_cobolt-output', 'latest', 'build', 'proofs', `${milestone}-02-tdd-red.proof.json`)
      : null,
    classification: { surfaces: classification.surfaces, testEngines: classification.testEngines },
    totalTestFiles: plan.summary.totalFiles,
    totalTests: plan.summary.totalTests,
    registered,
    stateUpdates,
  };
}

if (require.main === module) {
  const args = parseArgs();
  const result = run(args);
  if (args.json || result.usage) console.log(JSON.stringify(result, null, 2));
  else if (!result.ok) console.error(result.reason || 'TDD RED step failed');
  process.exit(result.ok ? 0 : 1);
}

module.exports = {
  normalizeMilestone,
  parseArgs,
  run,
  buildPlan,
  buildManifestFromPlan,
};
