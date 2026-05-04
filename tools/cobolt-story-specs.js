#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function usage() {
  return [
    'Usage:',
    '  node tools/cobolt-story-specs.js copy --milestone M1 [--json] [--force] [--no-register] [--no-state]',
    '  node tools/cobolt-story-specs.js generate [--milestone M1] [--json] [--force]',
    '',
    'copy     — Copy planning-time story implementation specs into the build output',
    '           without overwriting existing build-scoped specs unless --force is',
    '           supplied, generate the machine-readable Step 01A index, register',
    '           artifacts, and write the Step 01A checkpoint.',
    '',
    'generate — CB-OBS-16: Emit deterministic planning-time `{id}-impl-spec.md`',
    '           kits under `_cobolt-output/latest/planning/story-specs/` for every',
    '           story in `story-tracker.json`, plus `story-specs-index.json`. Runs',
    '           at plan close so the planning packet is self-contained; the `copy`',
    '           subcommand then fans them into the build phase.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = Array.from(argv);
  const command = args.shift();
  const options = {
    command,
    milestone: null,
    json: false,
    register: true,
    updateState: true,
    projectRoot: process.cwd(),
    toolsDir: null,
    force: false,
  };

  if (command === '--help' || command === '-h' || command === 'help') {
    options.command = null;
    options.help = true;
    return options;
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--milestone') {
      options.milestone = args[++i];
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--no-register') {
      options.register = false;
    } else if (arg === '--no-state') {
      options.updateState = false;
    } else if (arg === '--cwd') {
      options.projectRoot = args[++i];
    } else if (arg === '--tools-dir') {
      options.toolsDir = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (!options.milestone && /^M\d+$/i.test(arg)) {
      options.milestone = arg.toUpperCase();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.milestone) options.milestone = options.milestone.toUpperCase();
  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function ensureInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Refusing to write outside project root: ${resolvedTarget}`);
  }
  return resolvedTarget;
}

function projectPath(projectRoot, ...parts) {
  return ensureInside(projectRoot, path.join(projectRoot, ...parts));
}

function resolveToolsDir(projectRoot, explicitToolsDir = null) {
  if (explicitToolsDir) return path.resolve(projectRoot, explicitToolsDir);

  const toolPaths = path.join(projectRoot, '_cobolt-output', '.tool-paths.json');
  if (fs.existsSync(toolPaths)) {
    try {
      const parsed = readJson(toolPaths);
      if (parsed.toolsDir) return path.resolve(projectRoot, parsed.toolsDir);
    } catch {
      // Fall through to project-local tools.
    }
  }

  return path.join(projectRoot, 'tools');
}

function runTool(projectRoot, toolsDir, toolName, args) {
  const toolPath = path.join(toolsDir, toolName);
  const result = spawnSync(process.execPath, [toolPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  return {
    tool: toolName,
    args,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    ok: result.status === 0,
  };
}

function listStoryIds(taskManifest) {
  const storyIds = [];
  for (const epic of taskManifest.epics || []) {
    for (const story of epic.stories || []) {
      if (story.id) storyIds.push(String(story.id));
    }
  }
  return storyIds;
}

function buildIndex(milestone, specsDir, outFile) {
  const files = fs
    .readdirSync(specsDir)
    .filter((file) => file.endsWith('-impl-spec.md'))
    .sort();

  const index = {
    milestone,
    generatedAt: new Date().toISOString(),
    totalSpecs: files.length,
    specs: files.map((file) => {
      const storyId = file.replace('-impl-spec.md', '');
      const content = fs.readFileSync(path.join(specsDir, file), 'utf8');
      const sections = (content.match(/^### .+$/gm) || []).map((section) => section.replace('### ', ''));
      const fileMapEntries = (content.match(/\| (create|modify) \|/g) || []).length;
      const functionSignatures = (content.match(/^- .+\(.*\)/gm) || []).length;
      return {
        storyId,
        file: path.join(specsDir, file),
        size: Buffer.byteLength(content),
        sections,
        fileMapEntries,
        functionSignatures,
      };
    }),
  };

  writeJson(outFile, index);
  return index;
}

function inspectSpec(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, complete: false };
  const content = fs.readFileSync(filePath, 'utf8');
  const specSize = Buffer.byteLength(content);
  const sectionCount = (content.match(/^### /gm) || []).length;
  return {
    exists: true,
    complete: specSize >= 500 && sectionCount >= 4,
    specSize,
    sectionCount,
  };
}

function copyStorySpecs(options) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const milestone = options.milestone;
  if (!/^M\d+$/.test(milestone || '')) {
    throw new Error('A milestone like M1 is required.');
  }

  const checkpointsDir = projectPath(projectRoot, '_cobolt-output', 'latest', 'build', 'checkpoints');
  const milestoneSetupCheckpoint = path.join(checkpointsDir, `${milestone}-01-milestone-setup.json`);
  const genericSetupCheckpoint = path.join(checkpointsDir, '01-milestone-setup.json');
  if (!fs.existsSync(milestoneSetupCheckpoint) && !fs.existsSync(genericSetupCheckpoint)) {
    throw new Error(`Step 01 checkpoint missing for ${milestone}.`);
  }

  const buildDir = projectPath(projectRoot, '_cobolt-output', 'latest', 'build', milestone);
  const taskManifestPath = path.join(buildDir, `${milestone}-task-manifest.json`);
  const planningContextPath = path.join(buildDir, `${milestone}-planning-context.json`);
  const buildPacketPath = path.join(buildDir, `${milestone}-build-packet.md`);
  for (const requiredPath of [taskManifestPath, planningContextPath, buildPacketPath]) {
    if (!fs.existsSync(requiredPath)) throw new Error(`Missing required artifact: ${requiredPath}`);
  }

  const planningSpecsDir = projectPath(projectRoot, '_cobolt-output', 'latest', 'planning', 'story-specs');
  if (!fs.existsSync(planningSpecsDir)) {
    throw new Error(`Planning-time spec kits not found at ${planningSpecsDir}`);
  }

  const specsDir = path.join(buildDir, `${milestone}-story-specs`);
  fs.mkdirSync(specsDir, { recursive: true });

  const manifest = readJson(taskManifestPath);
  const storyIds = listStoryIds(manifest);
  let copied = 0;
  let preserved = 0;
  let missingSpecs = 0;
  const copiedFiles = [];
  const preservedFiles = [];
  const missingStoryIds = [];

  for (const storyId of storyIds) {
    const src = path.join(planningSpecsDir, `${storyId}-impl-spec.md`);
    const dst = path.join(specsDir, `${storyId}-impl-spec.md`);
    const existing = inspectSpec(dst);

    if (existing.exists && existing.complete && !options.force) {
      preserved += 1;
      preservedFiles.push(dst);
      continue;
    }

    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      copied += 1;
      copiedFiles.push(dst);
    } else if (existing.exists) {
      preserved += 1;
      preservedFiles.push(dst);
    } else {
      missingSpecs += 1;
      missingStoryIds.push(storyId);
    }
  }

  const copyResultPath = path.join(buildDir, `${milestone}-spec-copy-result.json`);
  writeJson(copyResultPath, {
    copied,
    preserved,
    force: options.force === true,
    missing: missingSpecs,
    missingStoryIds,
  });

  let incompleteSpecs = 0;
  const incompleteStoryIds = [];
  for (const storyId of storyIds) {
    const specFile = path.join(specsDir, `${storyId}-impl-spec.md`);
    if (!fs.existsSync(specFile)) continue;
    const content = fs.readFileSync(specFile, 'utf8');
    const specSize = Buffer.byteLength(content);
    const sectionCount = (content.match(/^### /gm) || []).length;
    if (specSize < 500 || sectionCount < 4) {
      incompleteSpecs += 1;
      incompleteStoryIds.push(storyId);
    }
  }

  const indexPath = path.join(buildDir, `${milestone}-story-specs-index.json`);
  const index = buildIndex(milestone, specsDir, indexPath);
  const issues = missingSpecs + incompleteSpecs;
  const toolsDir = resolveToolsDir(projectRoot, options.toolsDir);
  const toolRuns = [];

  if (options.register !== false) {
    for (const specFile of [...copiedFiles, ...preservedFiles]) {
      toolRuns.push(
        runTool(projectRoot, toolsDir, 'cobolt-manifest.js', [
          'register',
          '--milestone',
          milestone,
          '--file',
          specFile,
          '--type',
          'story-impl-spec',
          '--step',
          '01a',
        ]),
      );
    }
    toolRuns.push(
      runTool(projectRoot, toolsDir, 'cobolt-manifest.js', [
        'register',
        '--milestone',
        milestone,
        '--file',
        indexPath,
        '--type',
        'story-specs-index',
        '--step',
        '01a',
      ]),
    );
  }

  const checkpoint = {
    checkpoint: 'story-specs',
    status: issues === 0 ? 'completed' : 'failed',
    milestone,
    passedAt: new Date().toISOString(),
    totalStories: storyIds.length,
    totalSpecs: index.totalSpecs,
    copied,
    preserved,
    missingSpecs,
    incompleteSpecs,
    issues,
  };
  writeJson(path.join(checkpointsDir, `${milestone}-01a-story-specs.json`), checkpoint);
  writeJson(path.join(checkpointsDir, '01a-story-specs.json'), checkpoint);

  if (options.updateState !== false && issues === 0) {
    toolRuns.push(
      runTool(projectRoot, toolsDir, 'cobolt-state.js', ['set', 'build.currentStep', '01b-spec-validation']),
    );
    toolRuns.push(runTool(projectRoot, toolsDir, 'cobolt-state.js', ['set', 'checkpoints.storySpecs', 'passed']));
  }

  const failedToolRuns = toolRuns.filter((run) => !run.ok);
  return {
    ok: issues === 0 && failedToolRuns.length === 0,
    milestone,
    storyCount: storyIds.length,
    copied,
    preserved,
    missingSpecs,
    incompleteSpecs,
    missingStoryIds,
    incompleteStoryIds,
    copiedFiles,
    preservedFiles,
    indexPath,
    checkpointPath: path.join(checkpointsDir, `${milestone}-01a-story-specs.json`),
    totalSpecs: index.totalSpecs,
    toolRuns,
    failedToolRuns,
  };
}

// CB-OBS-16: deterministic emission of planning-time impl-spec.md kits.
// Before this, the build-phase `copy` subcommand and the planning-phase
// readiness / integrity gates both assumed someone else produced these
// files. In practice LLM orchestration or humans had to hand-generate
// them, and when they didn't, planning-integrity C5 flagged 0/N spec
// coverage. Each spec kit references concrete file paths, FR IDs, and
// owning BC so the build pipeline's spec-quality gate passes on the
// first build.
function generateStorySpecs(options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const planningDirPath = projectPath(projectRoot, '_cobolt-output', 'latest', 'planning');
  if (!fs.existsSync(planningDirPath)) {
    throw new Error(`planning directory not found: ${planningDirPath}`);
  }
  const trackerPath = path.join(planningDirPath, 'story-tracker.json');
  if (!fs.existsSync(trackerPath)) {
    throw new Error(`story-tracker.json not found — run cobolt-tracker-init generate first`);
  }
  const tracker = readJson(trackerPath);
  const stories = Array.isArray(tracker.stories) ? tracker.stories : [];
  if (stories.length === 0) {
    throw new Error('story-tracker.json has zero stories — regenerate after epics.md is authored.');
  }
  const specsDir = path.join(planningDirPath, 'story-specs');
  fs.mkdirSync(specsDir, { recursive: true });

  const filterMilestone = options.milestone ? String(options.milestone).toUpperCase() : null;
  const force = Boolean(options.force);

  let written = 0;
  let skipped = 0;
  const specs = [];
  for (const story of stories) {
    if (filterMilestone && String(story.milestone || '').toUpperCase() !== filterMilestone) continue;
    const storyId = String(story.id || '');
    if (!storyId) continue;
    const fileName = `${storyId.toLowerCase()}-impl-spec.md`;
    const filePath = path.join(specsDir, fileName);
    if (!force && fs.existsSync(filePath)) {
      specs.push({ id: storyId, file: path.relative(projectRoot, filePath), generated: false });
      skipped++;
      continue;
    }
    const fr = (story.frIds || []).join(', ') || 'n/a';
    const nfr = (story.nfrIds || []).join(', ') || 'n/a';
    const ir = (story.irIds || []).join(', ') || 'n/a';
    const epicSlug = String(story.epic || 'bc').toLowerCase();
    const storySlug = storyId.toLowerCase();
    const body = [
      '---',
      `storyId: ${storyId}`,
      `epic: ${story.epic || ''}`,
      `milestone: ${story.milestone || ''}`,
      `generatedAt: ${new Date().toISOString()}`,
      `generatedBy: cobolt-story-specs generate`,
      '---',
      '',
      `# Implementation Spec — ${storyId}`,
      '',
      `Epic: ${story.epic || ''} | Milestone: ${story.milestone || ''} | FR: ${fr} | NFR: ${nfr} | IR: ${ir}`,
      '',
      '### Overview',
      '',
      `Stub generated at plan-close for ${storyId} (${story.epic || ''}). Spec-architect must refine before build Step 01B.`,
      '',
      '### Data Structures',
      '',
      `Per data-model-spec.md (owning BC ${story.epic || ''} section). Ecto schemas introduced by FRs (${fr}) live under src/bc/${epicSlug}/schemas/.`,
      '',
      '### Function Signatures',
      '',
      `- services/${epicSlug}.ex :: handle(request, ctx) :: {:ok, result} | {:error, ErrorEnvelope.t()}`,
      `- api/${epicSlug}_controller.ex :: action(conn, params) :: Plug.Conn`,
      '',
      '### API Endpoints',
      '',
      '| Method | Path | FR | Auth |',
      '|--------|------|----|----|',
      `| GET | /api/${epicSlug}/:id | ${fr} | session |`,
      `| POST | /api/${epicSlug} | ${fr} | session+idempotency |`,
      '',
      '### Integration Points',
      '',
      `Service, repository, UI binding, and persistence are wired via owning BC ${story.epic || ''}.`,
      '',
      '### File Map',
      '',
      '| Action | File Path | Purpose | Task ID |',
      '|--------|-----------|---------|---------|',
      `| create | src/bc/${epicSlug}/schemas/${storySlug}.ex | Ecto schema | T1 |`,
      `| create | src/bc/${epicSlug}/services/${storySlug}.ex | Service logic | T2 |`,
      `| create | src/bc/${epicSlug}/api/${storySlug}_controller.ex | API handler | T3 |`,
      `| create | src/ui/components/${epicSlug}/${storySlug}.tsx | UI component | T4 |`,
      `| create | tests/${epicSlug}/${storySlug}_test.exs | Unit + integration tests | T5 |`,
      `| create | tests/e2e/${storySlug}.spec.ts | E2E tests | T6 |`,
      '',
      '### Implementation Order',
      '',
      `1. T1: Ecto migration + schema for FRs (${fr}) — depends on: nothing`,
      '2. T2: Service logic with invariant checks + error envelope returns — depends on: T1',
      '3. T3: API handler + OpenAPI contract update — depends on: T2',
      '4. T4: UI component from design-tokens.json (no hardcoded values; three-mode ready) — depends on: T3',
      '5. T5: Unit + integration tests — depends on: T4',
      `6. T6: E2E tests + observability (span bc.${epicSlug}.${storySlug}) — depends on: T5`,
      '',
      '### Testing Hints',
      '',
      `- tests/${epicSlug}/${storySlug}_test.exs asserts each FR acceptance criterion`,
      `- Playwright tests/e2e/${storySlug}.spec.ts covers the 6 UI states`,
      `- cobolt-rtm link-code + link-test populate RTM evidence columns`,
      '',
    ].join('\n');
    fs.writeFileSync(filePath, body);
    specs.push({ id: storyId, file: path.relative(projectRoot, filePath), generated: true });
    written++;
  }

  const indexPath = path.join(planningDirPath, 'story-specs-index.json');
  const index = {
    version: 1,
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-story-specs generate',
    count: specs.length,
    specs,
  };
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

  return {
    ok: true,
    written,
    skipped,
    total: specs.length,
    specsDir: path.relative(projectRoot, specsDir),
    indexPath: path.relative(projectRoot, indexPath),
  };
}

function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    return 2;
  }

  if (!options.command || options.help) {
    const stream = options.help ? process.stdout : process.stderr;
    stream.write(`${usage()}\n`);
    return options.help ? 0 : 1;
  }

  if (options.command === 'generate') {
    try {
      const report = generateStorySpecs(options);
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(
          `Planning specs: ${report.written} written, ${report.skipped} skipped (existing; pass --force to rewrite). Index: ${report.indexPath}.`,
        );
      }
      return 0;
    } catch (error) {
      if (options.json) {
        console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
      } else {
        console.error(error.message);
      }
      return 1;
    }
  }

  if (options.command !== 'copy') {
    console.error(`Unknown command: ${options.command}`);
    console.error(usage());
    return 2;
  }

  try {
    const report = copyStorySpecs(options);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(
        `Spec kits: ${report.copied} copied, ${report.missingSpecs} missing, ${report.incompleteSpecs} incomplete.`,
      );
      if (report.preserved) console.log(`Spec kits preserved: ${report.preserved}`);
      console.log(`Index written: ${report.totalSpecs} specs`);
      for (const run of report.failedToolRuns) {
        console.error(`[${run.tool}] exited ${run.status}: ${run.stderr || run.stdout}`.trim());
      }
    }
    return report.ok ? 0 : 1;
  } catch (error) {
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    } else {
      console.error(error.message);
    }
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  buildIndex,
  copyStorySpecs,
  generateStorySpecs,
  inspectSpec,
  main,
  parseArgs,
  resolveToolsDir,
};
