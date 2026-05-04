#!/usr/bin/env node

// CoBolt Blocked Tasks — Cross-milestone task dependency management
//
// Manages a registry of tasks blocked by work in other milestones.
// Lifecycle: extract -> defer -> unblock -> sweep -> complete.
//
// Usage:
//   node tools/cobolt-blocked-tasks.js extract
//   node tools/cobolt-blocked-tasks.js defer <taskId> --blocked-by <taskId> --reason "..."
//   node tools/cobolt-blocked-tasks.js unblock <milestone>
//   node tools/cobolt-blocked-tasks.js sweep [--json]
//   node tools/cobolt-blocked-tasks.js complete <taskId>
//   node tools/cobolt-blocked-tasks.js check <milestone> [--json]
//   node tools/cobolt-blocked-tasks.js status [--json]
//
// Registry: _cobolt-output/latest/planning/cross-milestone-blocked-tasks.json

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { resolveStoryFile } = require('../lib/cobolt-planning-artifacts');
const { parseImplSpec, verifySpec } = require('./cobolt-spec-verify');
const USAGE = [
  'Usage: cobolt-blocked-tasks.js <command> [args]',
  '',
  'Commands:',
  '  extract',
  '  defer <taskId> --blocked-by <taskId> [--reason "..."]',
  '  unblock <milestone>',
  '  sweep [--json]',
  '  prepare <milestone> [--json]',
  '  reconcile <milestone> [--json]',
  '  complete <taskId>',
  '  check <milestone> [--json]',
  '  status [--json]',
  '  append-deferred <milestone> <category> <json>|--from-file <path>',
  '  generate-deferred-md [milestone]',
  '  summary',
].join('\n');

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}
function writeJson(p, d) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(d, null, 2));
}

function sha256File(filePath) {
  return `sha256:${require('node:crypto').createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

const REG_PATH = () =>
  path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'cross-milestone-blocked-tasks.json');
const STORY_TRACKER = () => path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'story-tracker.json');
const STATE_PATH = () => path.join(process.cwd(), 'cobolt-state.json');
const BUILD_ROOT = () => path.join(process.cwd(), '_cobolt-output', 'latest', 'build');

function buildDir(milestone) {
  return path.join(BUILD_ROOT(), milestone);
}

function packetJsonPath(milestone) {
  return path.join(buildDir(milestone), `${milestone}-deferred-preamble.json`);
}

function packetMarkdownPath(milestone) {
  return path.join(buildDir(milestone), `${milestone}-deferred-preamble.md`);
}

function reconciliationPath(milestone) {
  return path.join(buildDir(milestone), `${milestone}-deferred-reconciliation.json`);
}

function loadRegistry() {
  return (
    readJson(REG_PATH()) || {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      blockedTasks: [],
    }
  );
}

function refreshPhase4BlockedTaskHash(registryPath) {
  const planningDir = path.dirname(registryPath);
  const checkpointPath = path.join(planningDir, 'checkpoints', 'phase4-delivery-breakdown.json');
  if (!fs.existsSync(checkpointPath)) return { updated: false, reason: 'phase4 checkpoint not found' };

  const checkpoint = readJson(checkpointPath);
  if (!checkpoint || typeof checkpoint !== 'object') {
    return { updated: false, reason: 'phase4 checkpoint unreadable' };
  }

  const hashMaps = [
    checkpoint.artifactHashes,
    checkpoint.evidenceHashes,
    checkpoint.integrity?.artifactHashes,
    checkpoint.integrity?.evidenceHashes,
  ].filter((value) => value && typeof value === 'object');
  if (hashMaps.length === 0) return { updated: false, reason: 'phase4 checkpoint has no artifact hash map' };

  const nextHash = sha256File(registryPath);
  let changed = false;
  for (const map of hashMaps) {
    for (const key of [
      'crossMilestoneBlockedTasks',
      'cross-milestone-blocked-tasks',
      'cross-milestone-blocked-tasks.json',
    ]) {
      if (map[key] !== nextHash) {
        map[key] = nextHash;
        changed = true;
      }
    }
  }

  if (!changed) return { updated: false, reason: 'hash already current', hash: nextHash };

  checkpoint.updatedAt = checkpoint.updatedAt || new Date().toISOString();
  checkpoint.lastMutableArtifactRefresh = {
    artifact: 'cross-milestone-blocked-tasks.json',
    refreshedAt: new Date().toISOString(),
    hash: nextHash,
    reason: 'blocked-task lifecycle update',
  };
  fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2), 'utf8');

  const auditPath = path.join(process.cwd(), '_cobolt-output', 'audit', 'phase4-mutable-artifact-refresh.jsonl');
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.appendFileSync(
    auditPath,
    `${JSON.stringify({
      at: checkpoint.lastMutableArtifactRefresh.refreshedAt,
      artifact: path.relative(process.cwd(), registryPath).replaceAll('\\', '/'),
      checkpoint: path.relative(process.cwd(), checkpointPath).replaceAll('\\', '/'),
      hash: nextHash,
      reason: 'blocked-task lifecycle update',
    })}\n`,
    'utf8',
  );

  return { updated: true, checkpointPath, hash: nextHash };
}

function saveRegistry(reg) {
  reg.updatedAt = new Date().toISOString();
  const registryPath = REG_PATH();
  writeJson(registryPath, reg);
  refreshPhase4BlockedTaskHash(registryPath);
}

function registrySemanticJson(reg) {
  const clone = JSON.parse(JSON.stringify(reg || {}));
  delete clone.updatedAt;
  return JSON.stringify(clone);
}

function normalizePathForOutput(filePath) {
  if (!filePath) return null;
  return path.relative(process.cwd(), filePath).replaceAll('\\', '/');
}

function parseTaskRef(ref) {
  if (!ref || typeof ref !== 'string') return null;
  // Full: M5:E7-S2:T08
  const full = ref.match(/^(M\d+):(E[A-Z0-9_]+-S\d+):(T\d+)$/i);
  if (full) return { milestone: full[1], epicStory: full[2], taskId: full[3], fullId: ref, isStoryLevel: false };
  // Story-level ALL: M5:E3-S2:ALL (all tasks in that story are blocked)
  const storyAll = ref.match(/^(M\d+):(E[A-Z0-9_]+-S\d+):ALL$/i);
  if (storyAll)
    return { milestone: storyAll[1], epicStory: storyAll[2], taskId: 'ALL', fullId: ref, isStoryLevel: true };
  // Partial without milestone: E3-S1:T04
  const partial = ref.match(/^(E[A-Z0-9_]+-S\d+):(T\d+)$/i);
  if (partial) return { milestone: null, epicStory: partial[1], taskId: partial[2], fullId: ref, isStoryLevel: false };
  return null;
}

function taskLocalId(task, storyId = null) {
  const candidates = [task?.id, task?.localTaskId, task?.taskId, task?.taskID, task?.localId].filter(Boolean);
  for (const candidate of candidates) {
    const value = String(candidate).trim();
    if (/^T\d+$/i.test(value)) return value.toUpperCase();

    const parsed = parseTaskRef(value);
    if (parsed?.taskId && (!storyId || parsed.epicStory?.toUpperCase() === String(storyId).toUpperCase())) {
      return parsed.taskId.toUpperCase();
    }
  }
  return null;
}

function taskFullRef(storyMilestone, storyId, task) {
  const localTaskId = taskLocalId(task, storyId);
  if (!storyMilestone || !storyId || !localTaskId) return null;
  return `${storyMilestone}:${storyId}:${localTaskId}`;
}

function isActionableBlockedTask(entry) {
  const taskRef = parseTaskRef(entry?.taskId);
  const blockedByRef = parseTaskRef(entry?.blockedBy);
  return Boolean(taskRef?.milestone && blockedByRef?.milestone);
}

function pruneMalformedBlockedTasks(reg) {
  if (!Array.isArray(reg?.blockedTasks)) return [];
  const malformed = [];
  reg.blockedTasks = reg.blockedTasks.filter((entry) => {
    if (isActionableBlockedTask(entry)) return true;
    malformed.push(entry);
    return false;
  });
  return malformed;
}

function resolveStoryMilestone(epicStoryId) {
  const tracker = readJson(STORY_TRACKER());
  if (!tracker) return null;
  const stories = tracker.stories || tracker;
  if (Array.isArray(stories)) {
    const s = stories.find((s) => s.id === epicStoryId);
    return s ? s.milestone : null;
  }
  if (stories[epicStoryId]) return stories[epicStoryId].milestone;
  return null;
}

function readTaskManifest(milestone) {
  return readJson(path.join(buildDir(milestone), `${milestone}-task-manifest.json`));
}

function countLocalTaskMatches(manifest, localTaskId, storyId) {
  if (!manifest) return { total: 0, matchingStory: 0 };
  let total = 0;
  let matchingStory = 0;
  for (const epic of manifest.epics || []) {
    for (const story of epic.stories || []) {
      for (const task of story.tasks || []) {
        if (task.id === localTaskId) {
          total++;
          if (story.id === storyId) matchingStory++;
        }
      }
    }
  }
  return { total, matchingStory };
}

function resolveTaskCompletion(milestone, epicStory, taskId) {
  const artifacts = readJson(path.join(buildDir(milestone), `${milestone}-build-artifacts.json`));
  if (!artifacts?.taskCompletion) return null;

  const manifest = readTaskManifest(milestone);
  const storyTaskId = `${epicStory}:${taskId}`;
  const fullTaskId = `${milestone}:${epicStory}:${taskId}`;
  const candidates = [fullTaskId, storyTaskId];

  const localMatches = countLocalTaskMatches(manifest, taskId, epicStory);
  if (localMatches.total === 0 || (localMatches.total === 1 && localMatches.matchingStory === 1)) {
    candidates.push(taskId);
  }

  for (const key of candidates) {
    const entry = artifacts.taskCompletion[key];
    if (entry) return { key, entry };
  }
  return null;
}

function _isTaskComplete(taskRef) {
  const parsed = parseTaskRef(taskRef);
  if (!parsed?.milestone) return false;

  // Check milestone-level completion (covers both task-level and story-level :ALL refs)
  const state = readJson(STATE_PATH());
  if (state) {
    const completed = state.build?.milestoneLoop?.completed || [];
    if (completed.includes(parsed.milestone)) return true;
    const cpPath = path.join(
      process.cwd(),
      '_cobolt-output',
      'latest',
      'build',
      'checkpoints',
      `${parsed.milestone}-08-milestone-complete.json`,
    );
    if (fs.existsSync(cpPath)) return true;
  }

  // Story-level :ALL — complete when the milestone is complete (checked above)
  // If milestone isn't complete, :ALL can't be complete either
  if (parsed.isStoryLevel) return false;

  // Task-level check via build-artifacts
  const artPath = path.join(
    process.cwd(),
    '_cobolt-output',
    'latest',
    'build',
    parsed.milestone,
    `${parsed.milestone}-build-artifacts.json`,
  );
  const artifacts = readJson(artPath);
  if (artifacts?.taskCompletion) {
    const tc = artifacts.taskCompletion[parsed.taskId];
    if (tc && tc.specStatus === 'complete') return true;
  }
  return false;
}

function isTaskCompleteRefined(taskRef) {
  const parsed = parseTaskRef(taskRef);
  if (!parsed?.milestone) return false;

  const exactTaskId = `${parsed.milestone}:${parsed.epicStory}:${parsed.taskId}`;
  const reg = loadRegistry();
  if (reg.blockedTasks.some((bt) => bt.taskId === exactTaskId && bt.status === 'completed')) {
    return true;
  }

  if (parsed.isStoryLevel) {
    const state = readJson(STATE_PATH());
    if (state) {
      const completed = state.build?.milestoneLoop?.completed || [];
      if (completed.includes(parsed.milestone)) return true;
    }
    const cpPath = path.join(BUILD_ROOT(), 'checkpoints', `${parsed.milestone}-08-milestone-complete.json`);
    return fs.existsSync(cpPath);
  }

  const completion = resolveTaskCompletion(parsed.milestone, parsed.epicStory, parsed.taskId);
  return completion?.entry?.specStatus === 'complete';
}

function resolveSpecPath(taskMilestone, storyId) {
  const buildSpec = path.join(BUILD_ROOT(), taskMilestone, `${taskMilestone}-story-specs`, `${storyId}-impl-spec.md`);
  if (fs.existsSync(buildSpec)) {
    return { path: buildSpec, source: 'build-story-specs' };
  }

  const planningSpec = path.join(
    process.cwd(),
    '_cobolt-output',
    'latest',
    'planning',
    'story-specs',
    `${storyId}-impl-spec.md`,
  );
  if (fs.existsSync(planningSpec)) {
    return { path: planningSpec, source: 'planning-story-specs' };
  }

  return { path: null, source: null };
}

function buildDeferredTaskContext(bt, currentMilestone) {
  const parsed = parseTaskRef(bt.taskId);
  if (!parsed?.milestone) return null;

  const spec = resolveSpecPath(bt.taskMilestone || parsed.milestone, parsed.epicStory);
  const storyFile = resolveStoryFile(parsed.epicStory, process.cwd());
  const blocker = parseTaskRef(bt.blockedBy);

  return {
    taskId: bt.taskId,
    storyTaskId: `${parsed.epicStory}:${parsed.taskId}`,
    localTaskId: parsed.taskId,
    storyId: parsed.epicStory,
    originalMilestone: bt.taskMilestone || parsed.milestone,
    currentMilestone,
    blockedBy: bt.blockedBy,
    blockerMilestone: bt.blockerMilestone || blocker?.milestone || null,
    reason: bt.reason || null,
    status: bt.status,
    deferredAt: bt.deferredAt || null,
    unblockedAt: bt.unblockedAt || null,
    specPath: normalizePathForOutput(spec.path),
    specSource: spec.source,
    storyFile: normalizePathForOutput(storyFile),
  };
}

function writeDeferredPacket(milestone, tasks) {
  const targetDir = buildDir(milestone);
  fs.mkdirSync(targetDir, { recursive: true });

  const jsonPath = packetJsonPath(milestone);
  const markdownPath = packetMarkdownPath(milestone);
  if (!tasks.length) {
    try {
      fs.rmSync(jsonPath, { force: true });
      fs.rmSync(markdownPath, { force: true });
    } catch {}
    return { jsonPath, markdownPath, count: 0 };
  }

  const packet = {
    milestone,
    generatedAt: new Date().toISOString(),
    count: tasks.length,
    tasks,
  };
  writeJson(jsonPath, packet);

  const lines = [
    '# Deferred Task Preamble',
    '',
    `Current milestone context: ${milestone}`,
    `Ready tasks: ${tasks.length}`,
    '',
    'These tasks keep their original milestone ownership and must be executed in the current codebase context.',
    '',
  ];
  for (const task of tasks) {
    lines.push(`- ${task.taskId}`);
    lines.push(`  blocker: ${task.blockedBy}`);
    lines.push(`  original milestone: ${task.originalMilestone}`);
    lines.push(`  story spec: ${task.specPath || 'missing'}`);
    lines.push(`  story file: ${task.storyFile || 'missing'}`);
  }
  fs.writeFileSync(markdownPath, `${lines.join('\n')}\n`);

  return { jsonPath, markdownPath, count: tasks.length };
}

function buildReadyTaskPacket(milestone) {
  const reg = loadRegistry();
  const tasks = reg.blockedTasks
    .filter((bt) => bt.status === 'unblocked' && isActionableBlockedTask(bt))
    .map((bt) => buildDeferredTaskContext(bt, milestone))
    .filter(Boolean)
    .sort((a, b) => a.taskId.localeCompare(b.taskId, undefined, { numeric: true }));

  const packet = writeDeferredPacket(milestone, tasks);
  return {
    milestone,
    count: tasks.length,
    tasks,
    packetPath: normalizePathForOutput(packet.jsonPath),
    markdownPath: normalizePathForOutput(packet.markdownPath),
  };
}

function verifyDeferredTask(packetTask) {
  if (!packetTask?.specPath) {
    return { taskId: packetTask?.taskId, storyId: packetTask?.storyId, specStatus: 'missing', reason: 'missing-spec' };
  }

  const resolvedSpecPath = path.resolve(process.cwd(), packetTask.specPath);
  if (!fs.existsSync(resolvedSpecPath)) {
    return { taskId: packetTask.taskId, storyId: packetTask.storyId, specStatus: 'missing', reason: 'missing-spec' };
  }

  const verified = verifySpec(parseImplSpec(fs.readFileSync(resolvedSpecPath, 'utf8'), packetTask.storyId));
  const task =
    verified.tasks[packetTask.localTaskId] ||
    verified.tasks[packetTask.storyTaskId] ||
    verified.tasks[packetTask.taskId] ||
    null;

  if (!task) {
    return {
      taskId: packetTask.taskId,
      storyId: packetTask.storyId,
      specStatus: 'missing',
      reason: 'task-not-in-spec',
    };
  }

  return {
    taskId: packetTask.taskId,
    storyId: packetTask.storyId,
    specStatus: task.specStatus,
    files: task.files,
    functions: task.functions,
    specPath: packetTask.specPath,
  };
}

function writeReconciliationReport(milestone, report) {
  writeJson(reconciliationPath(milestone), report);
}

function syncDashboardMilestones(milestones) {
  const dashboardTool = path.join(__dirname, 'cobolt-milestone-dashboard.js');
  if (!fs.existsSync(dashboardTool)) return;
  for (const milestone of milestones) {
    try {
      execFileSync('node', [dashboardTool, 'sync', milestone], {
        encoding: 'utf8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {}
  }
}

// ── extract: scan story-tracker for cross-milestone task deps ──
function cmdExtract() {
  const reg = loadRegistry();
  const before = registrySemanticJson(reg);
  const registryExists = fs.existsSync(REG_PATH());
  const pruned = pruneMalformedBlockedTasks(reg);
  const storyTracker = readJson(STORY_TRACKER());
  if (!storyTracker) {
    console.error('ERROR: story-tracker.json not found.');
    process.exit(2);
  }
  let extracted = 0;
  const stories = Array.isArray(storyTracker.stories || storyTracker)
    ? storyTracker.stories || storyTracker
    : Object.values(storyTracker);
  for (const story of stories) {
    const storyMs = story.milestone;
    if (!storyMs) continue;
    for (const task of story.tasks || []) {
      const taskFullId = taskFullRef(storyMs, story.id, task);
      if (!taskFullId) continue;
      const deps = [...(task.dependsOn || []), ...(task.blockedBy || [])];
      for (const dep of deps) {
        const depP = parseTaskRef(dep);
        if (!depP) continue;
        const depMs = depP.milestone || resolveStoryMilestone(depP.epicStory);
        if (!depMs || depMs === storyMs) continue;
        const blockerFullId = `${depMs}:${depP.epicStory}:${depP.taskId}`;
        if (reg.blockedTasks.some((bt) => bt.taskId === taskFullId && bt.blockedBy === blockerFullId)) continue;
        reg.blockedTasks.push({
          taskId: taskFullId,
          taskMilestone: storyMs,
          blockedBy: blockerFullId,
          blockerMilestone: depMs,
          reason: `Cross-milestone: ${story.id}:${task.id} depends on ${dep}`,
          status: 'deferred',
          deferredAt: new Date().toISOString(),
          unblockedAt: null,
          completedAt: null,
        });
        extracted++;
      }
    }
  }
  // Also scan story-level dependencies (epic-level blocking).
  // When a story itself has dependsOn/blockedBy referencing a story in another milestone,
  // ALL tasks in that story are blocked.
  for (const story of stories) {
    const storyMs = story.milestone;
    if (!storyMs) continue;
    const storyDeps = [...(story.dependsOn || []), ...(story.blockedBy || [])];
    for (const dep of storyDeps) {
      // Story-level refs can be "E3-S2" or "M5:E3-S2" (no task ID)
      const storyRef = dep.match(/^(?:(M\d+):)?(E[A-Z0-9_]+-S\d+)$/i);
      if (!storyRef) continue;
      const depMs = storyRef[1] || resolveStoryMilestone(storyRef[2]);
      if (!depMs || depMs === storyMs) continue;
      // Block ALL tasks in this story
      for (const task of story.tasks || []) {
        const taskFullId = taskFullRef(storyMs, story.id, task);
        if (!taskFullId) continue;
        const blockerFullId = `${depMs}:${storyRef[2]}:ALL`;
        if (reg.blockedTasks.some((bt) => bt.taskId === taskFullId && bt.blockedBy === blockerFullId)) continue;
        reg.blockedTasks.push({
          taskId: taskFullId,
          taskMilestone: storyMs,
          blockedBy: blockerFullId,
          blockerMilestone: depMs,
          reason: `Story-level: ${story.id} depends on ${dep} (all tasks blocked)`,
          status: 'deferred',
          deferredAt: new Date().toISOString(),
          unblockedAt: null,
          completedAt: null,
        });
        extracted++;
      }
    }
  }

  const changed = before !== registrySemanticJson(reg);
  if (changed || !registryExists) saveRegistry(reg);
  console.log(`Extracted ${extracted} cross-milestone task dependencies. Total: ${reg.blockedTasks.length}`);
  if (pruned.length > 0) console.log(`Pruned malformed blocked-task entries: ${pruned.length}`);
  console.log(`Changed: ${changed || !registryExists ? 'yes' : 'no'}`);
}

// ── defer: manually defer a task ──
function cmdDefer(args) {
  const taskId = args[0];
  const bbIdx = args.indexOf('--blocked-by');
  const rIdx = args.indexOf('--reason');
  if (!taskId || bbIdx < 0) {
    console.error('Usage: defer <taskId> --blocked-by <taskId> [--reason "..."]');
    process.exit(2);
  }
  const blockedBy = args[bbIdx + 1];
  const reason = rIdx >= 0 ? args[rIdx + 1] : 'Manually deferred';
  const reg = loadRegistry();
  if (reg.blockedTasks.some((bt) => bt.taskId === taskId && bt.blockedBy === blockedBy)) {
    console.log(`Already deferred: ${taskId}`);
    return;
  }
  const tp = parseTaskRef(taskId),
    bp = parseTaskRef(blockedBy);
  reg.blockedTasks.push({
    taskId,
    taskMilestone: tp ? tp.milestone : null,
    blockedBy,
    blockerMilestone: bp ? bp.milestone : null,
    reason,
    status: 'deferred',
    deferredAt: new Date().toISOString(),
    unblockedAt: null,
    completedAt: null,
  });
  saveRegistry(reg);
  console.log(`Deferred: ${taskId} blocked by ${blockedBy}`);
}

// ── unblock: scan after milestone completes ──
function cmdUnblock(args) {
  const milestone = args[0];
  if (!milestone) {
    console.error('Usage: unblock <milestone>');
    process.exit(2);
  }
  const reg = loadRegistry();
  let count = 0;
  for (const bt of reg.blockedTasks) {
    if (bt.status !== 'deferred') continue;
    if (bt.blockerMilestone === milestone || isTaskCompleteRefined(bt.blockedBy)) {
      bt.status = 'unblocked';
      bt.unblockedAt = new Date().toISOString();
      bt.unblockedByMilestone = milestone;
      count++;
      console.log(`  UNBLOCKED: ${bt.taskId} (was blocked by ${bt.blockedBy})`);
    }
  }
  saveRegistry(reg);
  console.log(`Unblocked ${count} tasks after ${milestone} completion.`);
  return count;
}

// ── sweep: list ready-to-build tasks ──
function cmdSweep(args) {
  const json = args.includes('--json');
  const reg = loadRegistry();
  const ready = reg.blockedTasks.filter((bt) => bt.status === 'unblocked' && isActionableBlockedTask(bt));
  const invalidReady = reg.blockedTasks.filter((bt) => bt.status === 'unblocked' && !isActionableBlockedTask(bt));
  if (json) {
    console.log(
      JSON.stringify({
        readyToBuild: ready,
        count: ready.length,
        remainingDeferred: reg.blockedTasks.filter((bt) => bt.status === 'deferred').length,
        completed: reg.blockedTasks.filter((bt) => bt.status === 'completed').length,
        invalidReadyCount: invalidReady.length,
      }),
    );
  } else {
    if (ready.length === 0) {
      console.log('No unblocked deferred tasks.');
    } else {
      console.log(`${ready.length} deferred task(s) ready to build:\n`);
      for (const bt of ready) {
        console.log(`  [READY] ${bt.taskId}`);
        console.log(`          Blocked by: ${bt.blockedBy} (now complete)`);
        console.log(`          Original milestone: ${bt.taskMilestone}\n`);
      }
    }
  }
  return ready;
}

function cmdPrepare(args) {
  const milestone = args[0];
  const json = args.includes('--json');
  if (!milestone) {
    console.error('Usage: prepare <milestone> [--json]');
    process.exit(2);
  }

  const packet = buildReadyTaskPacket(milestone);
  if (json) {
    console.log(JSON.stringify(packet));
    return packet;
  }

  if (packet.count === 0) {
    console.log(`No ready deferred tasks for ${milestone}.`);
    return packet;
  }

  console.log(`${packet.count} deferred task(s) prepared for ${milestone}:`);
  for (const task of packet.tasks) {
    console.log(`  [READY] ${task.taskId}`);
    console.log(`          spec: ${task.specPath || 'missing'}`);
  }
  console.log(`Packet: ${packet.packetPath}`);
  return packet;
}

// ── complete: mark deferred task as done ──
function cmdComplete(args) {
  const taskId = args[0];
  if (!taskId) {
    console.error('Usage: complete <taskId>');
    process.exit(2);
  }
  const reg = loadRegistry();
  const bt = reg.blockedTasks.find((bt) => bt.taskId === taskId);
  if (!bt) {
    console.error(`Not found: ${taskId}`);
    process.exit(1);
  }
  bt.status = 'completed';
  bt.completedAt = new Date().toISOString();
  saveRegistry(reg);
  console.log(`Completed: ${taskId}`);
}

function cmdReconcile(args) {
  const milestone = args[0];
  const json = args.includes('--json');
  if (!milestone) {
    console.error('Usage: reconcile <milestone> [--json]');
    process.exit(2);
  }

  const packet = buildReadyTaskPacket(milestone);
  const reg = loadRegistry();
  const completed = [];
  const remaining = [];

  for (const packetTask of packet.tasks) {
    const bt = reg.blockedTasks.find((entry) => entry.taskId === packetTask.taskId && entry.status === 'unblocked');
    if (!bt) continue;

    const verification = verifyDeferredTask(packetTask);
    if (verification.specStatus === 'complete') {
      bt.status = 'completed';
      bt.completedAt = new Date().toISOString();
      bt.completedInMilestone = milestone;
      bt.completedBy = 'reconcile';
      bt.verifiedSpecPath = packetTask.specPath;
      completed.push({ ...packetTask, verification });
    } else {
      remaining.push({ ...packetTask, verification });
    }
  }

  if (completed.length > 0) {
    saveRegistry(reg);
    syncDashboardMilestones([...new Set(completed.map((task) => task.originalMilestone).filter(Boolean))]);
  }

  const originalConsoleLog = console.log;
  try {
    if (json) console.log = () => {};
    cmdGenerateDeferredMd([]);
  } finally {
    console.log = originalConsoleLog;
  }
  const refreshedPacket = buildReadyTaskPacket(milestone);
  const report = {
    milestone,
    reconciledAt: new Date().toISOString(),
    completedCount: completed.length,
    remainingCount: refreshedPacket.count,
    completed,
    remaining,
    packetPath: refreshedPacket.packetPath,
  };
  writeReconciliationReport(milestone, report);

  if (json) {
    console.log(JSON.stringify(report));
    return report;
  }

  console.log(
    `Deferred reconciliation for ${milestone}: ${completed.length} completed, ${refreshedPacket.count} remaining ready.`,
  );
  return report;
}

// ── check: check deferred tasks for a milestone ──
function cmdCheck(args) {
  const milestone = args[0],
    json = args.includes('--json');
  if (!milestone) {
    console.error('Usage: check <milestone> [--json]');
    process.exit(2);
  }
  const reg = loadRegistry();
  const deferred = reg.blockedTasks.filter((bt) => bt.taskMilestone === milestone && bt.status === 'deferred');
  if (json) {
    console.log(JSON.stringify({ milestone, deferredTasks: deferred, count: deferred.length }));
  } else {
    if (deferred.length === 0) console.log(`No deferred tasks for ${milestone}.`);
    else {
      console.log(`${milestone} has ${deferred.length} deferred task(s):\n`);
      for (const bt of deferred) console.log(`  [DEFERRED] ${bt.taskId} <- ${bt.blockedBy} (${bt.reason})`);
    }
  }
  return deferred;
}

// ── append-deferred: incrementally add deferred items (called by Steps 03, 03A, 06) ──
function cmdAppendDeferred(args) {
  const milestone = args[0];
  const category = args[1]; // crossMilestoneBlocked|unimplementedFeatures|deferredFindings|techDebt|builderDeferrals
  const fromFileIdx = args.indexOf('--from-file');
  const jsonData = fromFileIdx >= 0 ? null : args[2]; // inline JSON or null if --from-file
  const fromFilePath = fromFileIdx >= 0 ? args[fromFileIdx + 1] : null;

  if (!milestone || !category || (!jsonData && !fromFilePath)) {
    console.error("Usage: append-deferred <milestone> <category> '<json>' OR --from-file <path>");
    process.exit(2);
  }

  let items;
  if (fromFilePath) {
    items = JSON.parse(fs.readFileSync(fromFilePath, 'utf8'));
    // Clean up temp file after reading
    try {
      fs.unlinkSync(fromFilePath);
    } catch {}
  } else {
    items = JSON.parse(jsonData);
  }
  const dwPath = path.join(
    process.cwd(),
    '_cobolt-output',
    'latest',
    'build',
    milestone,
    `${milestone}-deferred-work.json`,
  );
  const dw = readJson(dwPath) || {
    milestone,
    consolidatedAt: new Date().toISOString(),
    categories: {
      crossMilestoneBlocked: [],
      unimplementedFeatures: [],
      deferredFindings: [],
      techDebt: [],
      builderDeferrals: [],
    },
    totalCount: 0,
    incremental: true,
  };
  if (!dw.categories[category]) dw.categories[category] = [];
  const before = dw.categories[category].length;
  for (const item of Array.isArray(items) ? items : [items]) {
    dw.categories[category].push({ ...item, appendedAt: new Date().toISOString() });
  }
  dw.totalCount = Object.values(dw.categories).reduce((s, a) => s + a.length, 0);
  dw.lastAppendedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(dwPath), { recursive: true });
  writeJson(dwPath, dw);
  console.log(`Appended ${dw.categories[category].length - before} items to ${category} (total: ${dw.totalCount})`);
}

// ── generate-deferred-md: write committed DEFERRED.md to project root ──
function cmdGenerateDeferredMd(args) {
  const _milestone = args[0]; // optional — if provided, append this milestone's data
  const cwd = process.cwd();
  const deferredMdPath = path.join(cwd, 'DEFERRED.md');
  const reg = loadRegistry();

  // Collect per-milestone deferred-work.json files
  const buildDir = path.join(cwd, '_cobolt-output', 'latest', 'build');
  const milestoneData = [];

  if (fs.existsSync(buildDir)) {
    for (const entry of fs.readdirSync(buildDir)) {
      if (!entry.match(/^M\d+$/)) continue;
      const dwPath = path.join(buildDir, entry, `${entry}-deferred-work.json`);
      const dw = readJson(dwPath);
      if (dw && dw.totalCount > 0) milestoneData.push(dw);
    }
  }

  // Build markdown
  const lines = [
    '# Deferred Work',
    '',
    '> Auto-generated by CoBolt build pipeline. Committed with each milestone.',
    '> This file survives `_cobolt-output/` deletion. Source of truth for incomplete work.',
    '',
    `**Last updated**: ${new Date().toISOString()}`,
    '',
  ];

  // Cross-milestone blocked tasks
  const deferred = reg.blockedTasks.filter((bt) => bt.status === 'deferred' && isActionableBlockedTask(bt));
  const unblocked = reg.blockedTasks.filter((bt) => bt.status === 'unblocked' && isActionableBlockedTask(bt));
  if (deferred.length > 0 || unblocked.length > 0) {
    lines.push('## Cross-Milestone Blocked Tasks');
    lines.push('');
    if (deferred.length > 0) {
      lines.push(`### Still Blocked (${deferred.length})`);
      lines.push('');
      lines.push('| Task | Blocked By | Reason |');
      lines.push('|------|-----------|--------|');
      for (const bt of deferred) {
        lines.push(`| ${bt.taskId} | ${bt.blockedBy} | ${bt.reason || ''} |`);
      }
      lines.push('');
    }
    if (unblocked.length > 0) {
      lines.push(`### Ready to Build (${unblocked.length})`);
      lines.push('');
      lines.push('| Task | Was Blocked By | Unblocked At |');
      lines.push('|------|---------------|-------------|');
      for (const bt of unblocked) {
        lines.push(`| ${bt.taskId} | ${bt.blockedBy} | ${bt.unblockedAt || 'unknown'} |`);
      }
      lines.push('');
    }
  }

  // Per-milestone deferred work
  for (const dw of milestoneData) {
    lines.push(`## ${dw.milestone} — Deferred Work (${dw.totalCount} items)`);
    lines.push('');

    if ((dw.categories.crossMilestoneBlocked || []).length > 0) {
      lines.push('### Cross-Milestone Blocked');
      for (const item of dw.categories.crossMilestoneBlocked) {
        lines.push(`- **${item.taskId}** — blocked by ${item.blockedBy || 'unknown'}`);
      }
      lines.push('');
    }

    if ((dw.categories.unimplementedFeatures || []).length > 0) {
      lines.push('### Unimplemented Features');
      for (const item of dw.categories.unimplementedFeatures) {
        const desc = item.file || item.name || item.description || item.id || 'unknown';
        lines.push(`- **${item.type}**: ${desc} (source: ${item.source || 'unknown'})`);
      }
      lines.push('');
    }

    if ((dw.categories.deferredFindings || []).length > 0) {
      lines.push('### Deferred Findings');
      for (const item of dw.categories.deferredFindings) {
        lines.push(`- [${(item.severity || 'medium').toUpperCase()}] ${item.description || item.id}`);
      }
      lines.push('');
    }

    if ((dw.categories.techDebt || []).length > 0) {
      lines.push('### Tech Debt');
      for (const item of dw.categories.techDebt) {
        lines.push(`- [${(item.severity || 'low').toUpperCase()}] ${item.description || item.id}`);
      }
      lines.push('');
    }

    if ((dw.categories.builderDeferrals || []).length > 0) {
      lines.push('### Builder Deferrals (intentionally skipped by builders)');
      lines.push('');
      lines.push('| Task | Story | File | Reason | Blocker Type |');
      lines.push('|------|-------|------|--------|-------------|');
      for (const item of dw.categories.builderDeferrals) {
        lines.push(
          `| ${item.taskId || '-'} | ${item.storyId || '-'} | ${item.file || '-'} | ${item.reason || '-'} | ${item.blockerType || '-'} |`,
        );
      }
      lines.push('');
    }
  }

  if (milestoneData.length === 0 && deferred.length === 0 && unblocked.length === 0) {
    lines.push('No deferred work across any milestone.');
    lines.push('');
  }

  fs.writeFileSync(deferredMdPath, lines.join('\n'));
  console.log(`DEFERRED.md written to project root (${lines.length} lines).`);
  console.log('This file should be committed with the milestone.');
}

// ── summary: cross-milestone deferred work dashboard ──
function cmdSummary(_args) {
  const cwd = process.cwd();
  const reg = loadRegistry();
  const buildDir = path.join(cwd, '_cobolt-output', 'latest', 'build');

  console.log('\n═══ Deferred Work Dashboard ═══\n');

  // Registry summary
  const d = reg.blockedTasks.filter((bt) => bt.status === 'deferred').length;
  const u = reg.blockedTasks.filter((bt) => bt.status === 'unblocked').length;
  const c = reg.blockedTasks.filter((bt) => bt.status === 'completed').length;
  console.log(`Cross-Milestone Registry: ${reg.blockedTasks.length} total`);
  console.log(`  Blocked (waiting):  ${d}`);
  console.log(`  Unblocked (ready):  ${u}`);
  console.log(`  Completed (done):   ${c}`);
  console.log('');

  // Per-milestone summary
  let grandTotal = 0;
  if (fs.existsSync(buildDir)) {
    for (const entry of fs.readdirSync(buildDir).sort()) {
      if (!entry.match(/^M\d+$/)) continue;
      const dwPath = path.join(buildDir, entry, `${entry}-deferred-work.json`);
      const dw = readJson(dwPath);
      if (!dw) continue;
      const total = dw.totalCount || 0;
      if (total === 0) continue;
      grandTotal += total;
      const cats = dw.categories || {};
      console.log(`${entry}: ${total} deferred items`);
      if ((cats.crossMilestoneBlocked || []).length)
        console.log(`  Cross-milestone blocked: ${cats.crossMilestoneBlocked.length}`);
      if ((cats.unimplementedFeatures || []).length)
        console.log(`  Unimplemented features:  ${cats.unimplementedFeatures.length}`);
      if ((cats.deferredFindings || []).length)
        console.log(`  Deferred findings:       ${cats.deferredFindings.length}`);
      if ((cats.techDebt || []).length) console.log(`  Tech debt:               ${cats.techDebt.length}`);
    }
  }

  console.log(`\nGrand total: ${grandTotal} deferred items across all milestones.`);

  // Check DEFERRED.md
  const deferredMd = path.join(cwd, 'DEFERRED.md');
  if (fs.existsSync(deferredMd)) {
    const stat = fs.statSync(deferredMd);
    console.log(`DEFERRED.md: present (${stat.size} bytes, last modified: ${stat.mtime.toISOString()})`);
  } else {
    console.log('DEFERRED.md: NOT FOUND — run "cobolt-blocked-tasks.js generate-deferred-md" to create.');
  }
  console.log('');
}

// ── status: full registry ──
function cmdStatus(args) {
  const json = args.includes('--json');
  const reg = loadRegistry();
  const d = reg.blockedTasks.filter((bt) => bt.status === 'deferred').length;
  const u = reg.blockedTasks.filter((bt) => bt.status === 'unblocked').length;
  const c = reg.blockedTasks.filter((bt) => bt.status === 'completed').length;
  if (json) {
    console.log(
      JSON.stringify({
        total: reg.blockedTasks.length,
        deferred: d,
        unblocked: u,
        completed: c,
        tasks: reg.blockedTasks,
      }),
    );
  } else {
    console.log(`\nBlocked Tasks Registry: ${reg.blockedTasks.length} total (deferred=${d}, ready=${u}, done=${c})`);
    for (const bt of reg.blockedTasks) {
      const icon = bt.status === 'completed' ? 'DONE' : bt.status === 'unblocked' ? 'READY' : 'WAIT';
      console.log(`  [${icon}] ${bt.taskId} <- ${bt.blockedBy}`);
    }
  }
}

function printUsage(code) {
  const stream = code === 0 ? process.stdout : process.stderr;
  stream.write(`${USAGE}\n`);
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 0) {
    printUsage(1);
    process.exit(1);
  }

  const args = argv;
  const cmd = args[0],
    rest = args.slice(1);
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    printUsage(0);
    process.exit(0);
  }
  const cmds = {
    extract: cmdExtract,
    defer: cmdDefer,
    unblock: cmdUnblock,
    sweep: cmdSweep,
    prepare: cmdPrepare,
    reconcile: cmdReconcile,
    complete: cmdComplete,
    check: cmdCheck,
    status: cmdStatus,
    'append-deferred': cmdAppendDeferred,
    'generate-deferred-md': cmdGenerateDeferredMd,
    summary: cmdSummary,
  };
  if (!cmds[cmd]) {
    printUsage(1);
    process.exit(1);
  }
  cmds[cmd](rest);
}

if (require.main === module) main();
module.exports = {
  loadRegistry,
  saveRegistry,
  refreshPhase4BlockedTaskHash,
  parseTaskRef,
  taskLocalId,
  isActionableBlockedTask,
  pruneMalformedBlockedTasks,
  resolveTaskCompletion,
  isTaskComplete: isTaskCompleteRefined,
  buildReadyTaskPacket,
  verifyDeferredTask,
  cmdExtract,
  cmdUnblock,
  cmdSweep,
  cmdPrepare,
  cmdReconcile,
};
