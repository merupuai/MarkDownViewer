#!/usr/bin/env node

// CoBolt Fix Task Manifest - deterministic ownership-safe fix execution planning.

const fs = require('node:fs');
const path = require('node:path');

const { buildBundles, ACTIONABLE_STATUSES, resolveFindingFile } = require('./cobolt-fix-router');
const { normalizeMilestoneId } = require('../lib/cobolt-planning-artifacts');
const { projectExecutionLedger, syncFixExecutionLedger } = require('../lib/cobolt-execution-ledger');

const FRONTEND_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.vue',
  '.svelte',
  '.heex',
  '.html',
  '.css',
  '.scss',
  '.less',
  '.astro',
]);

const FOUNDATION_PREFIXES = new Set(['DB', 'ARCH', 'CONF', 'OPS', 'DEP', 'WIRE', 'APIWIRE', 'ROUTE', 'LIFECYCLE']);
const BACKEND_PREFIXES = new Set([
  'SEC',
  'AUTHZ',
  'AISEC',
  'PEN',
  'SIL',
  'API',
  'CONTRACT',
  'INT',
  'CODE',
  'DEBT',
  'PERF',
  'QRY',
]);
const FRONTEND_PREFIXES = new Set(['A11Y', 'UI', 'UIPH', 'DT', 'UX', 'I18N']);
const SERIAL_PREFIXES = new Set([
  'AISEC',
  'APIWIRE',
  'ARCH',
  'AUTHZ',
  'CONF',
  'CONTRACT',
  'COV',
  'DB',
  'DEP',
  'GAP',
  'ILL',
  'LIFECYCLE',
  'OPS',
  'PEN',
  'QRY',
  'ROUTE',
  'TEST',
  'STUB',
  'UIPH',
  'UAT',
  'WIRE',
]);
const SERIAL_FILE_PATTERNS = [
  /(^|[/\\])migrations?([/\\]|$)/i,
  /(^|[/\\])schema\.(sql|rb|exs?|ts|js)$/i,
  /(^|[/\\])package(-lock)?\.json$/i,
  /(^|[/\\])(pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|npm-shrinkwrap\.json)$/i,
  /(^|[/\\])(go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|mix\.exs|mix\.lock|requirements\.txt|poetry\.lock)$/i,
  /(^|[/\\])(\.env(\..*)?|docker-compose\.ya?ml|Dockerfile|helm|k8s|kubernetes)([/\\]|$)?/i,
  /(^|[/\\])\.?github[/\\]workflows[/\\]/i,
  /(^|[/\\])(\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml)$/i,
  /(^|[/\\])(vite|webpack|rollup|next|nuxt|svelte|tailwind|eslint|tsconfig|babel)\.config\./i,
];

function readJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function byNumericLocale(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function severityRank(severity) {
  switch (String(severity || '').toLowerCase()) {
    case 'critical':
      return 4;
    case 'high':
      return 3;
    case 'medium':
      return 2;
    default:
      return 1;
  }
}

function summarizeSeverity(findings) {
  const summary = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings || []) {
    const key = String(finding?.severity || 'low').toLowerCase();
    if (summary[key] == null) {
      summary.low += 1;
      continue;
    }
    summary[key] += 1;
  }
  return summary;
}

function effectiveContextFiles(bundle) {
  const explicit = Array.isArray(bundle?.contextFiles) ? bundle.contextFiles.filter(Boolean) : [];
  const derived = (bundle?.findings || []).map((finding) => resolveFindingFile(finding)).filter(Boolean);
  return unique([...explicit, ...derived]).sort(byNumericLocale);
}

function normalizeBundles(routing, tracker) {
  if (Array.isArray(routing?.bundles) && routing.bundles.length > 0) {
    return routing.bundles.map((bundle, index) => ({
      ...bundle,
      bundleId: bundle.bundleId || `bundle-${String(index + 1).padStart(3, '0')}`,
      contextFiles: effectiveContextFiles(bundle),
      findings: Array.isArray(bundle.findings) ? bundle.findings : [],
      prefixes: unique(bundle.prefixes || (bundle.findings || []).map((finding) => finding.prefix)).sort(
        byNumericLocale,
      ),
      rootCauses: unique(bundle.rootCauses || (bundle.findings || []).map((finding) => finding.rootCause)).sort(
        byNumericLocale,
      ),
    }));
  }

  const findings = Array.isArray(tracker?.findings)
    ? tracker.findings.filter((finding) => ACTIONABLE_STATUSES.has(String(finding?.status || '').toLowerCase()))
    : [];
  const fallbackRouting = buildBundles(findings, 1, new Set());
  return normalizeBundles(fallbackRouting, tracker);
}

function buildOwnershipComponents(bundles) {
  const bundleIds = bundles.map((bundle) => bundle.bundleId);
  const adjacency = new Map(bundleIds.map((bundleId) => [bundleId, new Set()]));
  const fileToBundles = new Map();

  for (const bundle of bundles) {
    for (const filePath of bundle.contextFiles) {
      const owners = fileToBundles.get(filePath) || [];
      owners.push(bundle.bundleId);
      fileToBundles.set(filePath, owners);
    }
  }

  const collisions = [];
  for (const [filePath, owners] of fileToBundles.entries()) {
    if (owners.length <= 1) continue;
    collisions.push({ file: filePath, owners: [...owners].sort(byNumericLocale) });
    for (let i = 0; i < owners.length; i++) {
      for (let j = i + 1; j < owners.length; j++) {
        adjacency.get(owners[i]).add(owners[j]);
        adjacency.get(owners[j]).add(owners[i]);
      }
    }
  }

  const bundlesById = new Map(bundles.map((bundle) => [bundle.bundleId, bundle]));
  const visited = new Set();
  const components = [];

  for (const bundleId of bundleIds) {
    if (visited.has(bundleId)) continue;
    const stack = [bundleId];
    const componentIds = [];

    while (stack.length > 0) {
      const current = stack.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      componentIds.push(current);
      for (const neighbor of adjacency.get(current)) {
        if (!visited.has(neighbor)) stack.push(neighbor);
      }
    }

    components.push(componentIds.map((id) => bundlesById.get(id)));
  }

  return { components, collisions };
}

function determineLane(task) {
  if (task.assignedAgent === 'fix-lead') return 4;
  if (task.assignedAgent === 'cobolt-db-fix') return 1;
  if (task.prefixes.some((prefix) => FOUNDATION_PREFIXES.has(prefix))) return 1;
  if (task.assignedAgent === 'cobolt-backend-fix' || task.assignedAgent === 'cobolt-compliance-fix') {
    return 2;
  }
  if (task.assignedAgent === 'cobolt-frontend-fix') {
    return 3;
  }
  if (
    task.files.some((filePath) => FRONTEND_EXTENSIONS.has(path.extname(filePath).toLowerCase())) ||
    task.prefixes.some((prefix) => FRONTEND_PREFIXES.has(prefix))
  ) {
    return 3;
  }
  if (task.prefixes.some((prefix) => BACKEND_PREFIXES.has(prefix))) {
    return 2;
  }
  return 4;
}

function serialExecutionReason(task) {
  if (task.assignedAgent === 'fix-lead') {
    return 'fix-lead owns cross-cutting or escalated work and must execute serially';
  }

  const serialPrefix = (task.prefixes || []).find((prefix) => SERIAL_PREFIXES.has(prefix));
  if (serialPrefix) {
    return `${serialPrefix} findings can affect shared contracts, runtime wiring, data, infrastructure, or release risk`;
  }

  const serialFile = (task.files || []).find((filePath) =>
    SERIAL_FILE_PATTERNS.some((pattern) => pattern.test(String(filePath || '').replace(/\\/g, '/'))),
  );
  if (serialFile) {
    return `shared project artifact requires serial execution: ${serialFile}`;
  }

  return null;
}

function taskPriorityCompare(left, right) {
  const severityDelta = severityRank(right.highestSeverity) - severityRank(left.highestSeverity);
  if (severityDelta !== 0) return severityDelta;
  return byNumericLocale(left.id, right.id);
}

function buildExecutionGroups(waveNumber, waveTasks) {
  const serialTasks = waveTasks
    .filter((task) => task.coordination.requiresSerialExecution === true)
    .sort(taskPriorityCompare);
  const parallelTasks = waveTasks
    .filter((task) => task.coordination.requiresSerialExecution !== true)
    .sort(taskPriorityCompare);

  const groups = [];
  let groupIndex = 1;

  for (const task of serialTasks) {
    groups.push({
      groupId: `W${waveNumber}-G${String(groupIndex).padStart(2, '0')}`,
      executionMode: 'sequential',
      canParallelize: false,
      taskIds: [task.id],
      reason: task.coordination.serialReason || 'task requires serial execution',
    });
    groupIndex += 1;
  }

  if (parallelTasks.length > 0) {
    groups.push({
      groupId: `W${waveNumber}-G${String(groupIndex).padStart(2, '0')}`,
      executionMode: 'parallel',
      canParallelize: parallelTasks.length > 1,
      taskIds: parallelTasks.map((task) => task.id),
      reason:
        parallelTasks.length > 1
          ? 'parallel-safe tasks have disjoint file ownership and no serial risk marker'
          : 'single parallel-safe task has no serial risk marker',
    });
  }

  return groups;
}

function laneLabel(lane) {
  switch (lane) {
    case 1:
      return 'foundation';
    case 2:
      return 'application';
    case 3:
      return 'frontend';
    default:
      return 'cross-cutting';
  }
}

function summarizePlanningContext(context) {
  if (!context) {
    return {
      requiredPresent: 0,
      requiredMissing: 0,
      optionalPresent: 0,
      optionalMissing: 0,
      totalStories: 0,
      totalTasks: 0,
      storyCoverage: 0,
    };
  }

  return {
    requiredPresent: Number(context?.summary?.requiredPresent || 0),
    requiredMissing: Number(context?.summary?.requiredMissing || 0),
    optionalPresent: Number(context?.summary?.optionalPresent || 0),
    optionalMissing: Number(context?.summary?.optionalMissing || 0),
    totalStories: Number(context?.summary?.totalStories || 0),
    totalTasks: Number(context?.summary?.totalTasks || 0),
    storyCoverage: Number(context?.storyCoverage?.coverage || 0),
  };
}

function inferPlanningLinks(files, context) {
  const stories = Array.isArray(context?.stories) ? context.stories : [];
  const tasks = Array.isArray(context?.tasks) ? context.tasks : [];

  const relatedStories = stories
    .filter((story) => {
      if (!story?.absoluteStoryFile) return false;
      const storyFile = String(story.absoluteStoryFile).replace(/\\/g, '/');
      return files.some((filePath) => storyFile.includes(String(path.basename(filePath)).replace(/\\/g, '/')));
    })
    .map((story) => story.id)
    .filter(Boolean);

  const relatedTasks = tasks
    .filter((task) => {
      const taskFiles = Array.isArray(task?.files) ? task.files : [];
      return taskFiles.some((taskFile) => files.includes(taskFile));
    })
    .map((task) => task.id)
    .filter(Boolean);

  return {
    relatedStories: unique(relatedStories).sort(byNumericLocale),
    relatedTasks: unique(relatedTasks).sort(byNumericLocale),
  };
}

function buildTask(component, index, context) {
  const bundles = component.filter(Boolean);
  const findings = bundles.flatMap((bundle) => bundle.findings || []);
  const files = unique(bundles.flatMap((bundle) => bundle.contextFiles || [])).sort(byNumericLocale);
  const agents = unique(bundles.map((bundle) => bundle.agent).filter(Boolean)).sort(byNumericLocale);
  const assignedAgent = agents.length === 1 ? agents[0] : 'fix-lead';
  const clusters = unique(bundles.map((bundle) => bundle.cluster).filter(Boolean)).sort(byNumericLocale);
  const prefixes = unique(findings.map((finding) => finding.prefix).filter(Boolean)).sort(byNumericLocale);
  const severity = summarizeSeverity(findings);
  const highestSeverity =
    [...findings]
      .sort((left, right) => severityRank(right.severity) - severityRank(left.severity))
      .map((finding) => String(finding.severity || 'low').toLowerCase())[0] || 'low';
  const planningLinks = inferPlanningLinks(files, context);
  const lane = determineLane({ assignedAgent, prefixes, files });
  const serialReason = serialExecutionReason({ assignedAgent, prefixes, files });

  return {
    id: `FX-${String(index + 1).padStart(3, '0')}`,
    title: `Resolve ${clusters.join(', ') || 'general'} findings`,
    assignedAgent,
    wave: 0,
    lane,
    laneLabel: laneLabel(lane),
    dependsOn: [],
    highestSeverity,
    severity,
    findings: findings.map((finding) => finding.id).sort(byNumericLocale),
    sourceBundleIds: bundles.map((bundle) => bundle.bundleId).sort(byNumericLocale),
    clusters,
    prefixes,
    files,
    relatedStories: planningLinks.relatedStories,
    relatedTasks: planningLinks.relatedTasks,
    coordination: {
      mergedForOwnership: bundles.length > 1,
      mergedReason: bundles.length > 1 ? 'shared-file-ownership' : null,
      requiresSerialExecution: Boolean(serialReason),
      executionMode: serialReason ? 'sequential' : 'parallel-safe',
      serialReason,
    },
    rationale:
      lane === 1
        ? 'Foundation fixes land before application and UI work.'
        : lane === 3
          ? 'Frontend fixes wait for lower-layer contract and data changes.'
          : lane === 4
            ? 'Cross-cutting ownership collisions are serialized through fix-lead.'
            : 'Application fixes can run after foundation changes stabilize.',
  };
}

function assignWaves(tasks) {
  const laneValues = unique(tasks.map((task) => task.lane)).sort((left, right) => left - right);
  const laneToWave = new Map(laneValues.map((lane, index) => [lane, index + 1]));

  for (const task of tasks) {
    task.wave = laneToWave.get(task.lane);
  }

  for (const task of tasks) {
    task.dependsOn = tasks
      .filter((candidate) => candidate.wave < task.wave)
      .map((candidate) => candidate.id)
      .sort(byNumericLocale);
  }

  const waves = laneValues.map((lane) => {
    const waveNumber = laneToWave.get(lane);
    const waveTasks = tasks.filter((task) => task.wave === waveNumber);
    const serialTaskIds = waveTasks
      .filter((task) => task.coordination.requiresSerialExecution === true)
      .map((task) => task.id)
      .sort(byNumericLocale);
    const parallelTaskIds = waveTasks
      .filter((task) => task.coordination.requiresSerialExecution !== true)
      .map((task) => task.id)
      .sort(byNumericLocale);
    const executionGroups = buildExecutionGroups(waveNumber, waveTasks);
    const executionMode =
      serialTaskIds.length === 0 ? 'parallel' : parallelTaskIds.length === 0 ? 'sequential' : 'hybrid';

    return {
      waveNumber,
      lane: laneLabel(lane),
      taskIds: waveTasks.map((task) => task.id).sort(byNumericLocale),
      canParallelize: executionMode === 'parallel',
      executionMode,
      serialTaskIds,
      parallelTaskIds,
      executionGroups,
    };
  });

  return { tasks, waves };
}

function buildFixTaskManifest({
  tracker,
  routing,
  context = null,
  trackerPath = null,
  routingPath = null,
  contextPath = null,
}) {
  const bundles = normalizeBundles(routing, tracker);
  const deferred = unique(routing?.deferred || []);
  const { components, collisions } = buildOwnershipComponents(bundles);
  const milestone = normalizeMilestoneId(context?.milestone || tracker?.milestone || 'M0') || 'M0';
  const tasks = components.map((component, index) => buildTask(component, index, context));
  const planned = assignWaves(tasks);
  const planningSummary = summarizePlanningContext(context);
  const warnings = [];

  if (planningSummary.requiredMissing > 0) {
    warnings.push(`Planning context reports ${planningSummary.requiredMissing} missing required artifacts.`);
  }
  if (collisions.length > 0) {
    warnings.push(`Resolved ${collisions.length} shared-file ownership collision(s) into merged tasks.`);
  }
  if (planned.tasks.length === 0) {
    warnings.push('No actionable fix tasks were derived from the tracker/routing input.');
  }

  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-fix-task-manifest',
    milestone,
    trackerPath,
    routingPath,
    contextPath,
    planningContext: {
      milestone: normalizeMilestoneId(context?.milestone) || milestone,
      planningDir: context?.planningDir || null,
      ...planningSummary,
    },
    summary: {
      actionableFindings: (tracker?.findings || []).filter((finding) =>
        ACTIONABLE_STATUSES.has(String(finding?.status || '').toLowerCase()),
      ).length,
      deferredFindings: deferred.length,
      bundleCount: bundles.length,
      taskCount: planned.tasks.length,
      waveCount: planned.waves.length,
      ownershipCollisionsResolved: collisions.length,
      escalatedTasks: planned.tasks.filter((task) => task.assignedAgent === 'fix-lead').length,
      serialTasks: planned.tasks.filter((task) => task.coordination.requiresSerialExecution === true).length,
      parallelSafeTasks: planned.tasks.filter((task) => task.coordination.requiresSerialExecution !== true).length,
      hybridWaves: planned.waves.filter((wave) => wave.executionMode === 'hybrid').length,
      parallelExecutionGroups: planned.waves
        .flatMap((wave) => wave.executionGroups || [])
        .filter((group) => group.executionMode === 'parallel').length,
      serialExecutionGroups: planned.waves
        .flatMap((wave) => wave.executionGroups || [])
        .filter((group) => group.executionMode === 'sequential').length,
    },
    deferredFindings: deferred.sort(byNumericLocale),
    ownershipCollisions: collisions,
    tasks: planned.tasks,
    waves: planned.waves,
    fileOwnership: Object.fromEntries(
      planned.tasks
        .flatMap((task) => task.files.map((filePath) => [filePath, { taskId: task.id, new: !fs.existsSync(filePath) }]))
        .sort((left, right) => byNumericLocale(left[0], right[0])),
    ),
    warnings,
  };
}

function parseArgs(args) {
  const get = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : null;
  };

  return {
    trackerPath: get('--tracker'),
    routingPath: get('--routing'),
    contextPath: get('--context'),
    outputPath: get('--output'),
    jsonMode: args.includes('--json'),
  };
}

function cmdBuild(args) {
  const { trackerPath, routingPath, contextPath, outputPath, jsonMode } = parseArgs(args);
  if (!trackerPath || !outputPath) {
    console.error(
      'Usage: node tools/cobolt-fix-task-manifest.js build --tracker <path> [--routing <path>] [--context <path>] --output <path> [--json]',
    );
    process.exit(2);
  }

  const tracker = readJson(trackerPath);
  if (!tracker) {
    console.error(`Tracker not found or unreadable: ${trackerPath}`);
    process.exit(2);
  }

  const routing = readJson(routingPath);
  const context = readJson(contextPath);
  const manifest = buildFixTaskManifest({ tracker, routing, context, trackerPath, routingPath, contextPath });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  syncFixExecutionLedger(process.cwd(), manifest.milestone, {
    findingTrackerPath: trackerPath,
    manifestPath: outputPath,
  });
  projectExecutionLedger(process.cwd());

  if (jsonMode) {
    console.log(JSON.stringify(manifest, null, 2));
  } else {
    console.log(
      `[cobolt-fix-task-manifest] ${manifest.summary.taskCount} task(s), ${manifest.summary.waveCount} wave(s)`,
    );
    console.log(`  Milestone: ${manifest.milestone}`);
    console.log(`  Ownership collisions resolved: ${manifest.summary.ownershipCollisionsResolved}`);
    console.log(`  Escalated tasks: ${manifest.summary.escalatedTasks}`);
    console.log(`  Serial tasks: ${manifest.summary.serialTasks}`);
    console.log(`  Parallel-safe tasks: ${manifest.summary.parallelSafeTasks}`);
    console.log(`  Hybrid waves: ${manifest.summary.hybridWaves}`);
  }
}

if (require.main === module) {
  const [, , command, ...args] = process.argv;
  switch (command) {
    case 'build':
      cmdBuild(args);
      break;
    default:
      console.log('CoBolt Fix Task Manifest - deterministic fix execution planning');
      console.log('');
      console.log('Usage:');
      console.log(
        '  node tools/cobolt-fix-task-manifest.js build --tracker <path> [--routing <path>] [--context <path>] --output <path> [--json]',
      );
      process.exit(command ? 2 : 0);
  }
}

module.exports = {
  buildFixTaskManifest,
  buildOwnershipComponents,
  buildExecutionGroups,
  determineLane,
  serialExecutionReason,
  assignWaves,
};
