#!/usr/bin/env node

// CoBolt Milestone Dashboard — Native project progress tracking
//
// Single source of truth: synthesizes milestone-tracker.json, story-tracker.json,
// cross-milestone-blocked-tasks.json, build-artifacts, and deferred-work to show
// the REAL status of every milestone.
//
// Usage:
//   node tools/cobolt-milestone-dashboard.js              # Full dashboard
//   node tools/cobolt-milestone-dashboard.js --json       # Machine-readable
//   node tools/cobolt-milestone-dashboard.js M1           # Single milestone detail
//   node tools/cobolt-milestone-dashboard.js sync         # Update all trackers with real counts
//   node tools/cobolt-milestone-dashboard.js sync M1      # Update specific milestone tracker
//
// Answers: "What's the complete status of the project right now?"

const fs = require('node:fs');
const path = require('node:path');
const { projectExecutionLedger, readExecutionProjection } = require('../lib/cobolt-execution-ledger');

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

function CWD(projectDir = process.cwd()) {
  return path.resolve(projectDir);
}
function PLANNING(projectDir = process.cwd()) {
  return path.join(CWD(projectDir), '_cobolt-output', 'latest', 'planning');
}
function BUILD(projectDir = process.cwd()) {
  return path.join(CWD(projectDir), '_cobolt-output', 'latest', 'build');
}

function readMilestonesProjection(projectDir = process.cwd()) {
  return (
    readExecutionProjection(projectDir, 'milestones') || {
      project: { tasksTotal: 0, tasksComplete: 0, tasksDeferred: 0, percentComplete: 0 },
      milestones: [],
    }
  );
}

function parseRegisteredTaskId(taskId) {
  const full = String(taskId || '').match(/^(M\d+):(E[A-Z0-9_]+-S\d+):(T\d+(?:\.\d+)?)$/i);
  if (full) return { milestone: full[1], storyId: full[2], localTaskId: full[3], fullTaskId: taskId };
  const story = String(taskId || '').match(/^(E[A-Z0-9_]+-S\d+):(T\d+(?:\.\d+)?)$/i);
  if (story) return { milestone: null, storyId: story[1], localTaskId: story[2], fullTaskId: taskId };
  return null;
}

function pushMapValue(map, key, value) {
  if (!key) return;
  const current = map.get(key) || [];
  current.push(value);
  map.set(key, current);
}

function buildTaskCatalog(msId, projectDir = process.cwd()) {
  const storyTracker = readJson(path.join(PLANNING(projectDir), 'story-tracker.json'));
  const stories = storyTracker?.stories || storyTracker || [];
  const storyList = Array.isArray(stories) ? stories : Object.values(stories);

  const catalog = {
    entries: [],
    byFull: new Map(),
    byStoryTask: new Map(),
    byLocal: new Map(),
  };

  for (const story of storyList) {
    if (story.milestone !== msId) continue;
    for (const task of story.tasks || []) {
      const localTaskId =
        task.localTaskId ||
        task.id ||
        String(task.taskId || '')
          .split(':')
          .pop();
      if (!localTaskId) continue;
      const fullTaskId = `${msId}:${story.id}:${localTaskId}`;
      const entry = { fullTaskId, storyId: story.id, localTaskId };
      catalog.entries.push(entry);
      catalog.byFull.set(fullTaskId, entry);
      pushMapValue(catalog.byStoryTask, `${story.id}:${localTaskId}`, entry);
      pushMapValue(catalog.byLocal, localTaskId, entry);
    }
  }

  return catalog;
}

function resolveArtifactTaskEntries(taskKey, catalog) {
  if (catalog.byFull.has(taskKey)) return [catalog.byFull.get(taskKey)];
  if (catalog.byStoryTask.has(taskKey)) return catalog.byStoryTask.get(taskKey);
  const localMatches = catalog.byLocal.get(taskKey) || [];
  return localMatches.length === 1 ? localMatches : [];
}

function summarizeMilestoneTasks(msId, projectDir = process.cwd()) {
  const catalog = buildTaskCatalog(msId, projectDir);
  const taskStates = new Map();
  for (const entry of catalog.entries) {
    taskStates.set(entry.fullTaskId, { storyId: entry.storyId, state: 'missing' });
  }

  const blockedBy = [];
  const unblockedTasks = [];
  const artifacts = readJson(path.join(BUILD(projectDir), msId, `${msId}-build-artifacts.json`));
  if (artifacts?.taskCompletion) {
    for (const [taskKey, tc] of Object.entries(artifacts.taskCompletion)) {
      const resolvedEntries = resolveArtifactTaskEntries(taskKey, catalog);
      if (resolvedEntries.length === 0 && catalog.entries.length === 0) {
        taskStates.set(taskKey, { storyId: null, state: tc.specStatus || 'missing' });
        continue;
      }
      for (const entry of resolvedEntries) {
        taskStates.set(entry.fullTaskId, { storyId: entry.storyId, state: tc.specStatus || 'missing' });
      }
    }
  }

  const reg = readJson(path.join(PLANNING(projectDir), 'cross-milestone-blocked-tasks.json'));
  for (const bt of reg?.blockedTasks || []) {
    if (bt.taskMilestone !== msId) continue;
    const parsed = parseRegisteredTaskId(bt.taskId);
    const fullTaskId = parsed?.fullTaskId || bt.taskId;
    const storyId = parsed?.storyId || null;
    if (!taskStates.has(fullTaskId)) {
      taskStates.set(fullTaskId, { storyId, state: 'missing' });
    }

    if (bt.status === 'deferred') {
      taskStates.set(fullTaskId, { storyId, state: 'deferred' });
      blockedBy.push(bt);
    } else if (bt.status === 'unblocked') {
      taskStates.set(fullTaskId, { storyId, state: 'deferred' });
      unblockedTasks.push(bt);
    } else if (bt.status === 'completed') {
      taskStates.set(fullTaskId, { storyId, state: 'complete' });
    }
  }

  const summary = { total: 0, complete: 0, deferred: 0, partial: 0, missing: 0 };
  for (const task of taskStates.values()) {
    summary.total++;
    if (task.state === 'complete') summary.complete++;
    else if (task.state === 'partial') summary.partial++;
    else if (task.state === 'deferred') summary.deferred++;
    else summary.missing++;
  }

  return { summary, blockedBy, unblockedTasks, taskStates };
}

function _getMilestoneIds(projectDir = process.cwd()) {
  return (readMilestonesProjection(projectDir).milestones || []).map((milestone) => milestone.id);
}

function _getMilestoneStatus(msId, projectDir = process.cwd()) {
  const result = {
    id: msId,
    status: 'pending',
    tasks: { total: 0, complete: 0, deferred: 0, partial: 0, missing: 0 },
    stories: { total: 0, complete: 0, partial: 0 },
    percentComplete: 0,
    deferredItems: [],
    blockedBy: [],
    unblockedTasks: [],
  };

  // 1. Check cobolt-state for completion
  const state = readJson(path.join(CWD(projectDir), 'cobolt-state.json'));
  const completedMs = state?.build?.milestoneLoop?.completed || [];
  const currentMs = state?.build?.currentMilestone || state?.currentMilestone;

  // 2. Check build checkpoint
  const completeCp = path.join(BUILD(projectDir), 'checkpoints', `${msId}-08-milestone-complete.json`);
  const hasCompleteCheckpoint = fs.existsSync(completeCp);

  // 3. Read build-artifacts.json for task completion (from spec-verify)
  const taskSummary = summarizeMilestoneTasks(msId, projectDir);
  result.tasks.total = taskSummary.summary.total;
  result.tasks.complete = taskSummary.summary.complete;
  result.tasks.deferred = taskSummary.summary.deferred;
  result.tasks.partial = taskSummary.summary.partial;
  result.tasks.missing = taskSummary.summary.missing;
  result.blockedBy.push(...taskSummary.blockedBy);
  result.unblockedTasks.push(...taskSummary.unblockedTasks);

  // 4. Read task manifest for total task count (if task catalog doesn't have it)
  if (result.tasks.total === 0) {
    const manifest = readJson(path.join(BUILD(projectDir), msId, `${msId}-task-manifest.json`));
    if (manifest) {
      for (const epic of manifest.epics || []) {
        for (const story of epic.stories || []) {
          result.tasks.total += (story.tasks || []).length;
        }
      }
    }
  }

  // 5. Read deferred-work.json for deferred item details (NOT for counting — avoids double-count)
  const dw = readJson(path.join(BUILD(projectDir), msId, `${msId}-deferred-work.json`));
  if (dw) {
    for (const cat of Object.values(dw.categories || {})) {
      for (const item of cat || []) {
        result.deferredItems.push(item);
      }
    }
  }

  // 6. Read story-tracker for story completion
  const storyTracker = readJson(path.join(PLANNING(projectDir), 'story-tracker.json'));
  if (storyTracker) {
    const stories = storyTracker.stories || storyTracker;
    const storyList = Array.isArray(stories) ? stories : Object.values(stories);
    for (const s of storyList) {
      if (s.milestone === msId) {
        result.stories.total++;
        if (s.status === 'completed' || s.status === 'done') result.stories.complete++;
        else if (s.status === 'partial') result.stories.partial++;
      }
    }
  }

  // 8. Compute percentage and status
  const effectiveTotal = result.tasks.total || 1;
  result.percentComplete = Math.round((result.tasks.complete / effectiveTotal) * 100);

  if (hasCompleteCheckpoint && result.tasks.deferred === 0 && result.blockedBy.length === 0) {
    result.status = 'complete';
  } else if (hasCompleteCheckpoint && (result.tasks.deferred > 0 || result.blockedBy.length > 0)) {
    result.status = 'partial';
  } else if (currentMs === msId) {
    result.status = 'building';
  } else if (completedMs.includes(msId)) {
    result.status = result.tasks.deferred > 0 ? 'partial' : 'complete';
  }

  return result;
}

function getMilestoneIds(projectDir = process.cwd()) {
  return (readMilestonesProjection(projectDir).milestones || []).map((milestone) => milestone.id);
}

function getMilestoneStatus(msId, projectDir = process.cwd()) {
  return (
    readMilestonesProjection(projectDir).milestones.find((milestone) => milestone.id === msId) || {
      id: msId,
      status: 'pending',
      tasks: { total: 0, complete: 0, deferred: 0, partial: 0, missing: 0 },
      stories: { total: 0, complete: 0, partial: 0 },
      percentComplete: 0,
      deferredItems: [],
      blockedBy: [],
      unblockedTasks: [],
      openFindings: 0,
      openFixes: 0,
    }
  );
}

// ── sync: update milestone-tracker.json with real counts ──
function cmdSync(args) {
  const targetMs = args[0]; // optional — sync specific milestone
  projectExecutionLedger(CWD());
  const trackerPath = path.join(PLANNING(), 'milestone-tracker.json');
  const tracker = readJson(trackerPath);
  if (!tracker) {
    console.error('milestone-tracker.json not found.');
    process.exit(2);
  }

  const milestones = tracker.milestones || tracker;
  const isList = Array.isArray(milestones);
  const msIds = targetMs ? [targetMs] : getMilestoneIds();

  let synced = 0;
  for (const msId of msIds) {
    const status = getMilestoneStatus(msId);
    const entry = isList ? milestones.find((m) => m.id === msId) : milestones[msId];
    if (!entry) continue;

    // Update with real counts
    entry.status = status.status;
    entry.tasksTotal = status.tasks.total;
    entry.tasksComplete = status.tasks.complete;
    entry.tasksDeferredCount = status.tasks.deferred;
    entry.percentComplete = status.percentComplete;
    entry.completedStories = status.stories.complete;
    entry.lastSyncedAt = new Date().toISOString();
    synced++;
  }

  writeJson(trackerPath, tracker);
  console.log(`Synced ${synced} milestone(s) in milestone-tracker.json.`);

  // Also update story-tracker with completion status
  const storyTrackerPath = path.join(PLANNING(), 'story-tracker.json');
  const storyTracker = readJson(storyTrackerPath);
  if (storyTracker) {
    let storyUpdates = 0;
    for (const msId of msIds) {
      const taskSummary = summarizeMilestoneTasks(msId);
      if (taskSummary.taskStates.size === 0) continue;

      const storyTaskSummary = {};
      for (const task of taskSummary.taskStates.values()) {
        if (!task.storyId) continue;
        if (!storyTaskSummary[task.storyId]) storyTaskSummary[task.storyId] = { total: 0, complete: 0 };
        storyTaskSummary[task.storyId].total++;
        if (task.state === 'complete') storyTaskSummary[task.storyId].complete++;
      }

      const storyData = storyTracker.stories || storyTracker;
      const storyEntries = Array.isArray(storyData) ? storyData : Object.values(storyData);
      for (const s of storyEntries) {
        if (s.milestone !== msId) continue;
        const counts = storyTaskSummary[s.id];
        if (counts && counts.total > 0 && counts.complete === counts.total) {
          if (s.status !== 'completed') {
            s.status = 'completed';
            s.completedAt = new Date().toISOString();
            storyUpdates++;
          }
        } else if (counts && counts.complete > 0) {
          if (s.status !== 'partial' && s.status !== 'completed') {
            s.status = 'partial';
            storyUpdates++;
          }
        }
      }
    }
    if (storyUpdates > 0) {
      writeJson(storyTrackerPath, storyTracker);
      console.log(`Updated ${storyUpdates} story statuses in story-tracker.json.`);
    }
  }
}

// ── display: show dashboard ──
function cmdDisplay(args) {
  const json = args.includes('--json');
  const targetMs = args.find((a) => /^M\d+$/i.test(a));
  const msIds = targetMs ? [targetMs] : getMilestoneIds();

  if (msIds.length === 0) {
    console.log('No milestones found. Run /cobolt-plan project first.');
    return;
  }

  const allStatus = msIds.map((id) => getMilestoneStatus(id));
  const projectTotal = allStatus.reduce((s, m) => s + m.tasks.total, 0);
  const projectComplete = allStatus.reduce((s, m) => s + m.tasks.complete, 0);
  const projectDeferred = allStatus.reduce((s, m) => s + m.tasks.deferred, 0);
  const projectPct = projectTotal > 0 ? Math.round((projectComplete / projectTotal) * 100) : 0;

  if (json) {
    console.log(
      JSON.stringify(
        {
          project: {
            tasksTotal: projectTotal,
            tasksComplete: projectComplete,
            tasksDeferred: projectDeferred,
            percentComplete: projectPct,
          },
          milestones: allStatus,
          generatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    return;
  }

  // Human-readable dashboard
  console.log(`\n${'='.repeat(65)}`);
  console.log('  CoBolt Milestone Dashboard');
  console.log(
    '  Project: ' +
      projectComplete +
      '/' +
      projectTotal +
      ' tasks (' +
      projectPct +
      '%)' +
      (projectDeferred > 0 ? `  [${projectDeferred} deferred]` : ''),
  );
  console.log(`${'='.repeat(65)}\n`);

  for (const ms of allStatus) {
    const bar = makeBar(ms.percentComplete, 20);
    const statusIcon = { complete: 'DONE', partial: 'PART', building: 'BUILD', pending: '----' }[ms.status] || '????';

    console.log(
      `  [${statusIcon}] ${ms.id}: ${bar} ${ms.percentComplete}%  (${ms.tasks.complete}/${ms.tasks.total} tasks)`,
    );

    if (ms.tasks.deferred > 0) {
      console.log(`          Deferred: ${ms.tasks.deferred} task(s)`);
    }
    if (ms.blockedBy.length > 0) {
      for (const bt of ms.blockedBy) {
        console.log(`          BLOCKED: ${bt.taskId} <- ${bt.blockedBy}`);
      }
    }
    if (ms.unblockedTasks.length > 0) {
      for (const bt of ms.unblockedTasks) {
        console.log(`          READY: ${bt.taskId} (unblocked, pending build)`);
      }
    }
  }

  console.log(`\n${'-'.repeat(65)}`);

  // Deferred work summary
  const totalDeferred = allStatus.reduce((s, m) => s + m.deferredItems.length, 0);
  if (totalDeferred > 0) {
    console.log(`  Deferred items across all milestones: ${totalDeferred}`);
    const deferredMd = path.join(CWD(), 'DEFERRED.md');
    if (fs.existsSync(deferredMd)) {
      console.log('  DEFERRED.md: present (committed)');
    } else {
      console.log('  DEFERRED.md: MISSING — run: node tools/cobolt-blocked-tasks.js generate-deferred-md');
    }
  } else {
    console.log('  No deferred work. All tasks accounted for.');
  }
  console.log('');
}

function makeBar(pct, width) {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  return `[${'#'.repeat(filled)}${'-'.repeat(empty)}]`;
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'sync') {
    cmdSync(args.slice(1));
  } else {
    cmdDisplay(args);
  }
}

if (require.main === module) main();
module.exports = { getMilestoneStatus, getMilestoneIds };
