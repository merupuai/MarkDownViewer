#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const jobRuntime = require('../cli/lib/job-runtime');
const { WorktreeManager } = require('./cobolt-worktree');
const { readExecutionProjection } = require('../lib/cobolt-execution-ledger');

function projectRoot(cwd = process.cwd()) {
  return path.resolve(cwd);
}

function _progressFile(cwd = process.cwd()) {
  return path.join(projectRoot(cwd), '_cobolt-output', 'audit', 'progress.json');
}

function progressLogFile(cwd = process.cwd()) {
  return path.join(projectRoot(cwd), '_cobolt-output', 'pipeline-progress.log');
}

function _findingsTrackerPath(cwd = process.cwd()) {
  return path.join(projectRoot(cwd), '_cobolt-output', 'latest', 'review', 'finding-tracker.json');
}

function renderBar(percentage, width = 30) {
  const filled = Math.round((percentage / 100) * width);
  const empty = width - filled;
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
  return `[${bar}] ${percentage}%`;
}

function readProgress(cwd = process.cwd()) {
  return readExecutionProjection(cwd, 'progress');
}

function readLogTail(lines = 20, cwd = process.cwd()) {
  try {
    if (!fs.existsSync(progressLogFile(cwd))) return '(no progress log yet)';
    const content = fs.readFileSync(progressLogFile(cwd), 'utf8');
    const allLines = content.trim().split('\n');
    return allLines.slice(-lines).join('\n');
  } catch {
    return '(error reading progress log)';
  }
}

function readJobSnapshot(cwd = process.cwd()) {
  const targetDir = jobRuntime.jobsDir(cwd);
  if (!fs.existsSync(targetDir)) {
    return {
      total: 0,
      active: [],
      recent: [],
    };
  }

  const jobs = fs
    .readdirSync(targetDir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => jobRuntime.readJob(path.basename(entry, '.json'), cwd))
    .filter(Boolean)
    .sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt || left.createdAt || 0);
      const rightTime = Date.parse(right.updatedAt || right.createdAt || 0);
      return rightTime - leftTime;
    });

  return {
    total: jobs.length,
    active: jobs
      .filter((job) => jobRuntime.ACTIVE_JOB_STATUSES.has(job.status))
      .slice(0, 5)
      .map((job) => ({
        id: job.id,
        command: job.command,
        status: job.status,
        updatedAt: job.updatedAt,
      })),
    recent: jobs.slice(0, 8).map((job) => ({
      id: job.id,
      command: job.command,
      status: job.status,
      updatedAt: job.updatedAt,
    })),
  };
}

function readFindingsSummary(cwd = process.cwd()) {
  const projection = readExecutionProjection(cwd, 'findings');
  if (!projection?.summary) {
    return { total: 0, open: 0, critical: 0, high: 0 };
  }

  return {
    total: Number(projection.summary.total || 0),
    open: Number(projection.summary.open || 0),
    critical: Number(projection.summary.critical || 0),
    high: Number(projection.summary.high || 0),
  };
}

function readWorktreeSummary(cwd = process.cwd()) {
  if (!fs.existsSync(path.join(projectRoot(cwd), '.git'))) {
    return {
      count: 0,
      active: [],
    };
  }

  try {
    const manager = new WorktreeManager(projectRoot(cwd));
    const worktrees = manager.listCobolt();
    return {
      count: worktrees.length,
      active: worktrees.slice(0, 6).map((worktree) => ({
        path: worktree.path,
        branch: worktree.branch,
      })),
    };
  } catch {
    return {
      count: 0,
      active: [],
    };
  }
}

function readMilestoneSnapshot(cwd = process.cwd()) {
  const projection = readExecutionProjection(cwd, 'milestones');
  const milestones = Array.isArray(projection?.milestones) ? projection.milestones : [];
  return {
    total: milestones.length,
    active: milestones.find((milestone) => milestone.status === 'building') || null,
    completed: milestones.filter((milestone) => milestone.status === 'complete').length,
    partial: milestones.filter((milestone) => milestone.status === 'partial').length,
    deferred: milestones.reduce((sum, milestone) => sum + Number(milestone?.tasks?.deferred || 0), 0),
    milestones: milestones.slice(0, 8).map((milestone) => ({
      id: milestone.id,
      status: milestone.status,
      percentComplete: milestone.percentComplete,
    })),
  };
}

function recommendFocus(snapshot) {
  if (snapshot.jobs.active.length > 0) {
    return `Monitor active ${snapshot.jobs.active[0].command} job ${snapshot.jobs.active[0].id}.`;
  }
  if (snapshot.findings.open > 0) {
    return `Address ${snapshot.findings.open} open finding(s) before advancing downstream stages.`;
  }
  if (snapshot.milestones.active) {
    return `Keep milestone ${snapshot.milestones.active.id} moving through the current build step.`;
  }
  if (snapshot.progress?.lastMessage) {
    return `Latest pipeline signal: ${snapshot.progress.lastMessage}`;
  }
  return 'No active pipeline work detected. Start a workflow or inspect the latest outputs.';
}

function readEstimates(cwd, progress) {
  try {
    const { safeBuildEstimates } = require('../lib/cobolt-estimates');
    return safeBuildEstimates(cwd, progress);
  } catch {
    return null;
  }
}

function buildCommandCenterSnapshot(cwd = process.cwd()) {
  const progress = readProgress(cwd);
  const snapshot = {
    generatedAt: new Date().toISOString(),
    projectRoot: projectRoot(cwd),
    progress,
    jobs: readJobSnapshot(cwd),
    findings: readFindingsSummary(cwd),
    worktrees: readWorktreeSummary(cwd),
    milestones: readMilestoneSnapshot(cwd),
    estimates: progress ? readEstimates(cwd, progress) : null,
  };
  snapshot.recommendedFocus = recommendFocus(snapshot);
  return snapshot;
}

function displayProgress(snapshot) {
  if (!snapshot.progress && snapshot.jobs.total === 0 && snapshot.milestones.total === 0) {
    console.log('No pipeline progress recorded yet.');
    console.log('Run a CoBolt pipeline command to start tracking.');
    return;
  }

  console.log();
  console.log('  CoBolt Command Center');
  console.log('  '.concat('═'.repeat(56)));

  if (snapshot.progress) {
    const state = snapshot.progress;
    const age = Math.floor((Date.now() - new Date(state.timestamp).getTime()) / 1000);
    const stale = age > 60 ? ` (last update ${age}s ago)` : '';
    console.log(`  ${renderBar(state.percentage)}`);
    console.log(`  Stage:      ${state.stageLabel || state.stage}`);
    if (state.milestone) console.log(`  Milestone:  ${state.milestone}`);
    console.log(`  Elapsed:    ${state.elapsed}`);
    if (snapshot.estimates) {
      const e = snapshot.estimates;
      console.log(`  ETA:        ~${e.thisMilestone.etaLabel} this milestone  ·  ~${e.pipeline.etaLabel} pipeline`);
      console.log(
        `  Cost est:   ~${e.thisMilestone.costLabel} this milestone  ·  ~${e.pipeline.costLabel} pipeline  (${e.modelTier}, ${e.confidence})`,
      );
    }
    console.log(`  Last:       ${state.lastMessage}${stale}`);
    if (state.lastAgent) console.log(`  Agent:      ${state.lastAgent}`);
    console.log();
  }

  console.log(`  Jobs:       ${snapshot.jobs.active.length} active / ${snapshot.jobs.total} recorded`);
  for (const job of snapshot.jobs.active.slice(0, 3)) {
    console.log(`              ${job.command} ${job.id} (${job.status})`);
  }

  console.log(`  Findings:   ${snapshot.findings.open} open / ${snapshot.findings.total} total`);
  if (snapshot.findings.critical || snapshot.findings.high) {
    console.log(`              Critical=${snapshot.findings.critical} High=${snapshot.findings.high}`);
  }

  console.log(`  Worktrees:  ${snapshot.worktrees.count}`);
  if (snapshot.worktrees.active.length > 0) {
    for (const worktree of snapshot.worktrees.active.slice(0, 3)) {
      console.log(`              ${worktree.branch || '(detached)'} -> ${worktree.path}`);
    }
  }

  console.log(`  Milestones: ${snapshot.milestones.completed} complete, ${snapshot.milestones.partial} partial`);
  if (snapshot.milestones.active) {
    console.log(
      `              Active ${snapshot.milestones.active.id} at ${snapshot.milestones.active.percentComplete}%`,
    );
  }
  if (snapshot.milestones.deferred > 0) {
    console.log(`              Deferred tasks: ${snapshot.milestones.deferred}`);
  }

  console.log();
  console.log(`  Focus:      ${snapshot.recommendedFocus}`);
  console.log();
}

function followProgress(cwd = process.cwd()) {
  let lastTimestamp = '';
  console.log('Watching pipeline progress (Ctrl+C to stop)...\n');

  const poll = () => {
    const snapshot = buildCommandCenterSnapshot(cwd);
    const state = snapshot.progress;
    if (state && state.timestamp !== lastTimestamp) {
      lastTimestamp = state.timestamp;
      const bar = renderBar(state.percentage, 20);
      const time = new Date(state.timestamp).toLocaleTimeString('en-GB', { hour12: false });
      process.stdout.write(
        `${`\r${time} ${bar} ${state.stageLabel || state.stage} │ ${(state.lastMessage || '').slice(0, 60)}`.padEnd(120)}\n`,
      );
    }
  };

  poll();
  const interval = setInterval(poll, 5000);
  process.on('SIGINT', () => {
    clearInterval(interval);
    console.log('\nStopped watching.');
    process.exit(0);
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node tools/cobolt-progress.js [options]');
    console.log('');
    console.log('Options:');
    console.log('  --json           Output the command-center snapshot as JSON');
    console.log('  --follow         Poll every 5s (tail -f style)');
    console.log('  --log [N]        Show last N lines of the progress log (default: 20)');
    console.log('  --help           Show this help');
    process.exit(0);
  }

  if (args.includes('--follow') || args.includes('-f')) {
    followProgress();
  } else if (args.includes('--log')) {
    const idx = args.indexOf('--log');
    const lines = parseInt(args[idx + 1], 10) || 20;
    console.log(readLogTail(lines));
  } else if (args.includes('--json')) {
    console.log(JSON.stringify(buildCommandCenterSnapshot(), null, 2));
  } else {
    displayProgress(buildCommandCenterSnapshot());
  }
}

module.exports = {
  buildCommandCenterSnapshot,
  displayProgress,
  readFindingsSummary,
  readJobSnapshot,
  readLogTail,
  readMilestoneSnapshot,
  readProgress,
  readWorktreeSummary,
  renderBar,
};
