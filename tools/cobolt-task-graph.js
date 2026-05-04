#!/usr/bin/env node

// CoBolt task graph orchestrator.
//
// Deterministic DAG runner for CoBolt-native task packs. It is intentionally
// not a public cobolt-cli root command; use it through cobolt-tools when an
// operator wants an ad hoc dependency graph with durable state and a local
// run board.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { atomicWrite, atomicWriteJSON } = require('../lib/cobolt-atomic-write');
const { appendExecutionEvent } = require('../lib/cobolt-execution-ledger');
const { paths } = require('../lib/cobolt-paths');

const VERSION = '1.0.0';
const DEFAULT_TASK_TIMEOUT_MS = 20 * 60 * 1000;
const OUTPUT_LIMIT = 64 * 1024;
const VALID_TYPES = new Set(['command', 'tool', 'manual']);
const VALID_COMPLEXITY = new Set(['HIGH', 'MED', 'LOW']);
const DEFAULT_MODEL_PROFILE = {
  HIGH: 'frontier',
  MED: 'balanced',
  LOW: 'fast',
};

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    command: argv[0] && !argv[0].startsWith('--') ? argv[0] : 'help',
    graphPath: null,
    runId: null,
    cwd: process.cwd(),
    json: false,
    taskTimeoutMs: DEFAULT_TASK_TIMEOUT_MS,
    initOnly: false,
    statePath: null,
  };

  const start = options.command === 'help' ? 0 : 1;
  for (let index = start; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--graph' || arg === '-g') options.graphPath = path.resolve(argv[++index] || '');
    else if (arg.startsWith('--graph=')) options.graphPath = path.resolve(arg.slice('--graph='.length));
    else if (arg === '--run-id') options.runId = String(argv[++index] || '').trim();
    else if (arg.startsWith('--run-id=')) options.runId = String(arg.slice('--run-id='.length)).trim();
    else if (arg === '--cwd') options.cwd = path.resolve(argv[++index] || '.');
    else if (arg.startsWith('--cwd=')) options.cwd = path.resolve(arg.slice('--cwd='.length));
    else if (arg === '--json') options.json = true;
    else if (arg === '--task-timeout-ms') options.taskTimeoutMs = Number(argv[++index] || DEFAULT_TASK_TIMEOUT_MS);
    else if (arg.startsWith('--task-timeout-ms=')) {
      options.taskTimeoutMs = Number(arg.slice('--task-timeout-ms='.length));
    } else if (arg === '--init-only') options.initOnly = true;
    else if (arg === '--state') options.statePath = path.resolve(argv[++index] || '');
    else if (arg.startsWith('--state=')) options.statePath = path.resolve(arg.slice('--state='.length));
    else if (arg === '--help' || arg === '-h') options.command = 'help';
  }
  if (!Number.isFinite(options.taskTimeoutMs) || options.taskTimeoutMs <= 0) {
    options.taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS;
  }
  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeId(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function slug(value) {
  const normalized = normalizeId(value).toLowerCase();
  return normalized || 'task-graph';
}

function timestampSlug() {
  return new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14);
}

function defaultRunId(graph) {
  return `${slug(graph.title || 'task-graph')}-${timestampSlug()}`;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) => (Array.isArray(entry) ? entry : [entry]))
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
}

function normalizeTask(raw = {}) {
  const complexity = String(raw.complexity || raw.risk || 'MED').toUpperCase();
  const type = String(raw.type || (raw.tool ? 'tool' : raw.exec ? 'command' : 'manual')).toLowerCase();
  return {
    id: normalizeId(raw.id),
    title: String(raw.title || raw.name || raw.id || '').trim(),
    description: String(raw.description || raw.prompt || raw.subtask_prompt || '').trim(),
    type,
    dependsOn: normalizeStringArray(raw.dependsOn || raw.depends_on || raw.dependencies),
    complexity: VALID_COMPLEXITY.has(complexity) ? complexity : 'MED',
    modelProfile: raw.modelProfile || raw.model || null,
    owner: raw.owner || null,
    writeScope: normalizeStringArray(raw.writeScope || raw.write_scope || raw.writes),
    evidence: normalizeStringArray(raw.evidence || raw.evidenceArtifacts),
    timeoutMs: Number(raw.timeoutMs || raw.timeout_ms || 0) || null,
    continueOnFailure: Boolean(raw.continueOnFailure || raw.continue_on_failure),
    exec: raw.exec || null,
    tool: raw.tool || null,
    metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {},
  };
}

function normalizeGraph(graph = {}) {
  const tasks = Array.isArray(graph.tasks) ? graph.tasks.map(normalizeTask) : [];
  const modelProfiles = {
    ...DEFAULT_MODEL_PROFILE,
    ...(graph.modelProfiles || graph.models || {}),
  };
  return {
    version: graph.version || VERSION,
    title: String(graph.title || 'CoBolt Task Graph').trim(),
    description: String(graph.description || '').trim(),
    modelProfiles,
    tasks,
    metadata: graph.metadata && typeof graph.metadata === 'object' ? graph.metadata : {},
  };
}

function loadGraph(graphPath) {
  if (!graphPath) throw new Error('Missing --graph <path>.');
  if (!fs.existsSync(graphPath)) throw new Error(`Graph file not found: ${graphPath}`);
  return normalizeGraph(readJson(graphPath));
}

function buildIndexes(tasks) {
  const byId = new Map();
  for (const task of tasks) byId.set(task.id, task);
  const outgoing = new Map();
  const indegree = new Map();
  for (const task of tasks) {
    outgoing.set(task.id, []);
    indegree.set(task.id, 0);
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      outgoing.get(dep)?.push(task.id);
      indegree.set(task.id, (indegree.get(task.id) || 0) + 1);
    }
  }
  return { byId, outgoing, indegree };
}

function detectCycles(tasks) {
  const { outgoing } = buildIndexes(tasks);
  const color = new Map(tasks.map((task) => [task.id, 0]));
  const stack = [];
  const cycles = [];

  function visit(id) {
    color.set(id, 1);
    stack.push(id);
    for (const next of outgoing.get(id) || []) {
      const nextColor = color.get(next) || 0;
      if (nextColor === 0) visit(next);
      else if (nextColor === 1) {
        const start = stack.indexOf(next);
        if (start >= 0) cycles.push([...stack.slice(start), next]);
      }
    }
    stack.pop();
    color.set(id, 2);
  }

  for (const task of tasks) {
    if ((color.get(task.id) || 0) === 0) visit(task.id);
  }
  return cycles;
}

function computeRanks(tasks) {
  const { outgoing, indegree } = buildIndexes(tasks);
  const queue = tasks
    .filter((task) => (indegree.get(task.id) || 0) === 0)
    .map((task) => task.id)
    .sort();
  const ranks = [];
  const rankById = new Map();
  const remainingIndegree = new Map(indegree);

  while (queue.length > 0) {
    const current = [...queue].sort();
    queue.length = 0;
    const rank = [];
    for (const id of current) {
      if (rankById.has(id)) continue;
      rankById.set(id, ranks.length);
      rank.push(id);
      for (const next of outgoing.get(id) || []) {
        remainingIndegree.set(next, (remainingIndegree.get(next) || 0) - 1);
        if ((remainingIndegree.get(next) || 0) === 0) queue.push(next);
      }
    }
    if (rank.length > 0) ranks.push(rank);
  }

  return { ranks, rankById };
}

function longestPath(tasks) {
  const { ranks } = computeRanks(tasks);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const lengthById = new Map();
  const predecessor = new Map();
  for (const rank of ranks) {
    for (const id of rank) {
      const task = byId.get(id);
      let bestLength = 1;
      let bestPredecessor = null;
      for (const dep of task.dependsOn) {
        const candidate = (lengthById.get(dep) || 1) + 1;
        if (candidate > bestLength) {
          bestLength = candidate;
          bestPredecessor = dep;
        }
      }
      lengthById.set(id, bestLength);
      if (bestPredecessor) predecessor.set(id, bestPredecessor);
    }
  }
  let end = null;
  let max = 0;
  for (const [id, length] of lengthById.entries()) {
    if (length > max) {
      max = length;
      end = id;
    }
  }
  const pathIds = [];
  while (end) {
    pathIds.unshift(end);
    end = predecessor.get(end);
  }
  return { length: max, taskIds: pathIds };
}

function writeScopeConflict(left, right) {
  const a = left.writeScope.map((entry) => entry.replace(/\\/g, '/'));
  const b = right.writeScope.map((entry) => entry.replace(/\\/g, '/'));
  for (const leftScope of a) {
    for (const rightScope of b) {
      if (leftScope === rightScope) return leftScope;
      if (!leftScope.includes('*') && !rightScope.includes('*')) {
        if (leftScope.startsWith(`${rightScope}/`) || rightScope.startsWith(`${leftScope}/`)) {
          return `${leftScope} <-> ${rightScope}`;
        }
      }
    }
  }
  return null;
}

function validateGraph(graph) {
  const errors = [];
  const warnings = [];
  const tasks = graph.tasks || [];

  if (!graph.title) errors.push('Graph title is required.');
  if (tasks.length === 0) errors.push('Graph must contain at least one task.');

  const ids = new Set();
  for (const task of tasks) {
    if (!task.id) errors.push('Every task must have a non-empty id.');
    else if (ids.has(task.id)) errors.push(`Duplicate task id: ${task.id}`);
    else ids.add(task.id);
    if (!VALID_TYPES.has(task.type)) errors.push(`Task ${task.id || '(missing id)'} has invalid type: ${task.type}`);
    if (task.dependsOn.includes(task.id)) errors.push(`Task ${task.id} cannot depend on itself.`);
    if (task.type === 'command') {
      if (!task.exec || typeof task.exec.command !== 'string' || task.exec.command.trim() === '') {
        errors.push(`Command task ${task.id} requires exec.command.`);
      }
      if (task.exec?.args !== undefined && !Array.isArray(task.exec.args)) {
        errors.push(`Command task ${task.id} exec.args must be an array when present.`);
      }
    }
    if (task.type === 'tool') {
      if (!task.tool || typeof task.tool.name !== 'string' || task.tool.name.trim() === '') {
        errors.push(`Tool task ${task.id} requires tool.name.`);
      }
      if (task.tool?.args !== undefined && !Array.isArray(task.tool.args)) {
        errors.push(`Tool task ${task.id} tool.args must be an array when present.`);
      }
    }
  }

  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) errors.push(`Task ${task.id} depends on unknown task: ${dep}`);
    }
  }

  const cycles = detectCycles(tasks);
  for (const cycle of cycles) errors.push(`Cycle detected: ${cycle.join(' -> ')}`);

  let ranks = [];
  let rankById = new Map();
  if (errors.length === 0) {
    const rankInfo = computeRanks(tasks);
    ranks = rankInfo.ranks;
    rankById = rankInfo.rankById;
    for (const rank of ranks) {
      for (let i = 0; i < rank.length; i += 1) {
        for (let j = i + 1; j < rank.length; j += 1) {
          const left = tasks.find((task) => task.id === rank[i]);
          const right = tasks.find((task) => task.id === rank[j]);
          const conflict = writeScopeConflict(left, right);
          if (conflict) {
            errors.push(
              `Same-rank write-scope conflict in rank ${rankById.get(left.id)}: ${left.id} and ${right.id} both write ${conflict}`,
            );
          }
        }
      }
    }
  }

  if (errors.length === 0 && ranks.every((rank) => rank.length === 1) && tasks.length > 2) {
    warnings.push(
      'Graph is fully linear. Re-check whether read-only discovery, tests, docs, or validation can fan out.',
    );
  }

  const criticalPath = errors.length === 0 ? longestPath(tasks) : { length: 0, taskIds: [] };
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    taskCount: tasks.length,
    ranks,
    rankCount: ranks.length,
    parallelRankCount: ranks.filter((rank) => rank.length > 1).length,
    criticalPath,
  };
}

function resolveOutputDir(projectRoot, runId) {
  const latest = paths(projectRoot).latest();
  return path.join(latest, 'task-graph', runId);
}

function buildRunState(graph, validation, options = {}) {
  const runId = options.runId || defaultRunId(graph);
  const rankById = new Map();
  validation.ranks.forEach((rank, index) => {
    for (const id of rank) rankById.set(id, index);
  });
  return {
    version: VERSION,
    runId,
    title: graph.title,
    description: graph.description,
    status: 'READY',
    cwd: path.resolve(options.cwd || process.cwd()),
    graphPath: options.graphPath || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    boardPath: null,
    statePath: null,
    ranks: validation.ranks,
    modelProfiles: graph.modelProfiles,
    tasks: graph.tasks.map((task) => ({
      id: task.id,
      title: task.title || task.id,
      description: task.description,
      type: task.type,
      rank: rankById.get(task.id) || 0,
      dependsOn: task.dependsOn,
      complexity: task.complexity,
      modelProfile: task.modelProfile || graph.modelProfiles[task.complexity] || DEFAULT_MODEL_PROFILE[task.complexity],
      owner: task.owner,
      writeScope: task.writeScope,
      evidence: task.evidence,
      status: 'PENDING',
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      exitCode: null,
      reason: null,
      stdoutPath: null,
      stderrPath: null,
      outputTail: '',
      metadata: task.metadata,
    })),
    summary: {
      taskCount: graph.tasks.length,
      passed: 0,
      failed: 0,
      skipped: 0,
      canceled: 0,
      pending: graph.tasks.length,
      running: 0,
      criticalPath: validation.criticalPath,
      warnings: validation.warnings,
    },
  };
}

function summarizeState(state) {
  const counts = {
    taskCount: state.tasks.length,
    passed: 0,
    failed: 0,
    skipped: 0,
    canceled: 0,
    pending: 0,
    running: 0,
  };
  for (const task of state.tasks) {
    if (task.status === 'PASSED') counts.passed += 1;
    else if (task.status === 'FAILED') counts.failed += 1;
    else if (task.status === 'SKIPPED') counts.skipped += 1;
    else if (task.status === 'CANCELED') counts.canceled += 1;
    else if (task.status === 'RUNNING') counts.running += 1;
    else counts.pending += 1;
  }
  state.summary = {
    ...state.summary,
    ...counts,
  };
  state.updatedAt = new Date().toISOString();
  return state.summary;
}

function taskById(state, id) {
  return state.tasks.find((task) => task.id === id);
}

function saveState(runDir, state) {
  summarizeState(state);
  state.statePath = path.join(runDir, 'state.json');
  state.boardPath = path.join(runDir, 'run-board.html');
  atomicWriteJSON(state.statePath, state);
  atomicWrite(state.boardPath, renderBoardHtml(state), { encoding: 'utf8', mode: 0o600 });
  return state;
}

function appendRunEvent(runDir, event) {
  fs.mkdirSync(runDir, { recursive: true });
  fs.appendFileSync(
    path.join(runDir, 'events.jsonl'),
    `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
    'utf8',
  );
}

function recordExecutionLedger(projectRoot, state, eventType, severity = 'info') {
  try {
    appendExecutionEvent(projectRoot, {
      event_type: eventType,
      source: 'tool',
      severity,
      artifactPaths: [state.statePath, state.boardPath].filter(Boolean),
      data: {
        action: 'task-graph',
        runId: state.runId,
        status: state.status,
        summary: state.summary,
      },
      metadata: {
        tool: 'cobolt-task-graph',
        stage: 'task-graph',
      },
    });
  } catch {
    // Execution ledger integration is best effort for this operator surface.
  }
}

function clip(value, limit = OUTPUT_LIMIT) {
  const text = String(value || '');
  return text.length > limit ? text.slice(text.length - limit) : text;
}

function resolveTaskCwd(projectRoot, task) {
  const explicit = task.exec?.cwd || task.tool?.cwd;
  if (!explicit) return projectRoot;
  return path.isAbsolute(explicit) ? explicit : path.resolve(projectRoot, explicit);
}

function spawnTaskProcess(projectRoot, task) {
  if (task.type === 'tool') {
    const toolName = task.tool.name;
    const args = Array.isArray(task.tool.args) ? task.tool.args.map(String) : [];
    return {
      command: process.execPath,
      args: [path.join(__dirname, 'index.js'), toolName, ...args],
      cwd: resolveTaskCwd(projectRoot, task),
    };
  }
  const args = Array.isArray(task.exec.args) ? task.exec.args.map(String) : [];
  return {
    command: task.exec.command,
    args,
    cwd: resolveTaskCwd(projectRoot, task),
  };
}

function runProcess(spec, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: process.env,
      windowsHide: true,
      shell: false,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore kill failure.
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout = clip(stdout + chunk.toString());
    });
    child.stderr.on('data', (chunk) => {
      stderr = clip(stderr + chunk.toString());
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: clip(`${stderr}\n${err.message}`), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? 124 : code || 0, stdout, stderr, timedOut });
    });
  });
}

async function runTask(projectRoot, runDir, state, graphTask, stateTask, options = {}) {
  if (graphTask.type === 'manual') {
    stateTask.status = 'SKIPPED';
    stateTask.reason = 'manual-task';
    stateTask.finishedAt = new Date().toISOString();
    appendRunEvent(runDir, { type: 'task-skipped', taskId: graphTask.id, reason: stateTask.reason });
    saveState(runDir, state);
    return stateTask;
  }

  stateTask.status = 'RUNNING';
  stateTask.startedAt = new Date().toISOString();
  appendRunEvent(runDir, { type: 'task-started', taskId: graphTask.id });
  saveState(runDir, state);

  const started = Date.now();
  const spec = spawnTaskProcess(projectRoot, graphTask);
  const timeoutMs = graphTask.timeoutMs || options.taskTimeoutMs || DEFAULT_TASK_TIMEOUT_MS;
  const result = await runProcess(spec, timeoutMs);
  const durationMs = Date.now() - started;

  const logsDir = path.join(runDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const stdoutPath = path.join(logsDir, `${graphTask.id}.stdout.log`);
  const stderrPath = path.join(logsDir, `${graphTask.id}.stderr.log`);
  atomicWrite(stdoutPath, result.stdout || '', { encoding: 'utf8', mode: 0o600 });
  atomicWrite(stderrPath, result.stderr || '', { encoding: 'utf8', mode: 0o600 });

  stateTask.status = result.exitCode === 0 ? 'PASSED' : 'FAILED';
  stateTask.exitCode = result.exitCode;
  stateTask.reason = result.timedOut ? `timeout after ${timeoutMs}ms` : null;
  stateTask.stdoutPath = stdoutPath;
  stateTask.stderrPath = stderrPath;
  stateTask.outputTail = clip([result.stdout, result.stderr].filter(Boolean).join('\n'), 4000);
  stateTask.finishedAt = new Date().toISOString();
  stateTask.durationMs = durationMs;
  appendRunEvent(runDir, {
    type: stateTask.status === 'PASSED' ? 'task-passed' : 'task-failed',
    taskId: graphTask.id,
    exitCode: stateTask.exitCode,
    durationMs,
    reason: stateTask.reason,
  });
  saveState(runDir, state);
  return stateTask;
}

function shouldSkipTask(state, task) {
  const failedDeps = [];
  for (const dep of task.dependsOn) {
    const depState = taskById(state, dep);
    if (!depState) continue;
    if (['FAILED', 'SKIPPED', 'CANCELED'].includes(depState.status)) failedDeps.push(dep);
  }
  return failedDeps;
}

function hasCancelRequest(runDir) {
  return fs.existsSync(path.join(runDir, 'cancel.requested'));
}

async function runGraph(options = {}) {
  const projectRoot = path.resolve(options.cwd || process.cwd());
  const graph = options.graph || loadGraph(options.graphPath);
  const validation = validateGraph(graph);
  if (!validation.ok) {
    return {
      ok: false,
      _exit: 1,
      graph,
      validation,
    };
  }

  const runId = options.runId || defaultRunId(graph);
  const runDir = resolveOutputDir(projectRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const state = buildRunState(graph, validation, { ...options, cwd: projectRoot, runId });
  saveState(runDir, state);
  atomicWriteJSON(path.join(runDir, 'graph.json'), graph);
  appendRunEvent(runDir, { type: options.initOnly ? 'board-initialized' : 'run-created', runId });
  recordExecutionLedger(projectRoot, state, 'artifact_written');

  if (options.initOnly) {
    return {
      ok: true,
      runDir,
      state,
      validation,
      _exit: 0,
    };
  }

  state.status = 'RUNNING';
  state.startedAt = new Date().toISOString();
  saveState(runDir, state);
  const graphTasksById = new Map(graph.tasks.map((task) => [task.id, task]));

  for (const rank of validation.ranks) {
    if (hasCancelRequest(runDir)) {
      for (const taskId of rank) {
        const stateTask = taskById(state, taskId);
        if (stateTask && stateTask.status === 'PENDING') {
          stateTask.status = 'CANCELED';
          stateTask.reason = 'cancel-requested';
        }
      }
      state.status = 'CANCELED';
      break;
    }

    const runnable = [];
    for (const taskId of rank) {
      const graphTask = graphTasksById.get(taskId);
      const stateTask = taskById(state, taskId);
      const failedDeps = shouldSkipTask(state, graphTask);
      if (failedDeps.length > 0 && !graphTask.continueOnFailure) {
        stateTask.status = 'SKIPPED';
        stateTask.reason = `upstream failed or skipped: ${failedDeps.join(', ')}`;
        stateTask.finishedAt = new Date().toISOString();
        appendRunEvent(runDir, { type: 'task-skipped', taskId, reason: stateTask.reason });
      } else {
        runnable.push({ graphTask, stateTask });
      }
    }
    saveState(runDir, state);
    await Promise.all(
      runnable.map(({ graphTask, stateTask }) => runTask(projectRoot, runDir, state, graphTask, stateTask, options)),
    );
  }

  summarizeState(state);
  if (state.status !== 'CANCELED') {
    state.status = state.summary.failed > 0 ? 'FAILED' : 'COMPLETED';
  }
  state.finishedAt = new Date().toISOString();
  saveState(runDir, state);
  appendRunEvent(runDir, { type: 'run-finished', runId, status: state.status, summary: state.summary });
  recordExecutionLedger(
    projectRoot,
    state,
    state.status === 'FAILED' ? 'gate_failed' : 'artifact_written',
    state.status === 'FAILED' ? 'error' : 'info',
  );

  return {
    ok: state.status === 'COMPLETED',
    runDir,
    state,
    validation,
    _exit: state.status === 'COMPLETED' ? 0 : 1,
  };
}

function initBoard(options = {}) {
  return runGraph({ ...options, initOnly: true });
}

function locateRunState(projectRoot, runId) {
  if (!runId) return null;
  const latest = paths(projectRoot).latest();
  const statePath = path.join(latest, 'task-graph', runId, 'state.json');
  return fs.existsSync(statePath) ? statePath : null;
}

function listRuns(projectRoot) {
  const latest = paths(projectRoot).latest();
  const dir = path.join(latest, 'task-graph');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const statePath = path.join(dir, entry.name, 'state.json');
      let state = null;
      try {
        state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      } catch {
        state = null;
      }
      return {
        runId: entry.name,
        status: state?.status || 'UNKNOWN',
        title: state?.title || null,
        updatedAt: state?.updatedAt || null,
        boardPath: state?.boardPath || path.join(dir, entry.name, 'run-board.html'),
      };
    })
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
}

function cancelRun(options = {}) {
  const projectRoot = path.resolve(options.cwd || process.cwd());
  const statePath = options.statePath || locateRunState(projectRoot, options.runId);
  if (!statePath) throw new Error('Run state not found. Pass --run-id or --state.');
  const runDir = path.dirname(statePath);
  atomicWrite(path.join(runDir, 'cancel.requested'), `${new Date().toISOString()}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  const state = readJson(statePath);
  if (!['COMPLETED', 'FAILED', 'CANCELED'].includes(state.status)) {
    state.status = 'CANCEL_REQUESTED';
    saveState(runDir, state);
  }
  return { ok: true, runDir, state };
}

function renderTextSummary(result) {
  const validation = result.validation;
  const lines = [];
  lines.push(`task-graph: ${result.graph?.title || result.state?.title || 'CoBolt Task Graph'}`);
  if (validation) {
    lines.push(
      `tasks: ${validation.taskCount}, ranks: ${validation.rankCount}, parallel ranks: ${validation.parallelRankCount}`,
    );
    lines.push(`critical path: ${validation.criticalPath.taskIds.join(' -> ') || 'n/a'}`);
    if (validation.warnings.length > 0) {
      for (const warning of validation.warnings) lines.push(`warning: ${warning}`);
    }
    if (validation.errors.length > 0) {
      for (const error of validation.errors) lines.push(`error: ${error}`);
    }
  }
  if (result.state) {
    lines.push(`run: ${result.state.runId}`);
    lines.push(`status: ${result.state.status}`);
    lines.push(`board: ${result.state.boardPath}`);
  }
  return `${lines.join('\n')}\n`;
}

function escapeHtml(value) {
  return String(value || '').replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char],
  );
}

function statusClass(status) {
  return String(status || 'PENDING')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-');
}

function renderBoardHtml(state) {
  const cardsByRank = new Map();
  for (const task of state.tasks) {
    const rank = Number(task.rank || 0);
    if (!cardsByRank.has(rank)) cardsByRank.set(rank, []);
    cardsByRank.get(rank).push(task);
  }
  const rankHtml = [...cardsByRank.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rank, tasks]) => {
      const cards = tasks
        .map((task) => {
          const deps = task.dependsOn.length > 0 ? task.dependsOn.join(', ') : 'none';
          const writes = task.writeScope.length > 0 ? task.writeScope.join(', ') : 'read-only/unspecified';
          const output = task.outputTail ? `<pre>${escapeHtml(task.outputTail)}</pre>` : '';
          return `<article class="card ${statusClass(task.status)}">
  <div class="card-head"><strong>${escapeHtml(task.id)}</strong><span>${escapeHtml(task.status)}</span></div>
  <h3>${escapeHtml(task.title)}</h3>
  <p>${escapeHtml(task.description)}</p>
  <dl>
    <dt>Type</dt><dd>${escapeHtml(task.type)}</dd>
    <dt>Depends</dt><dd>${escapeHtml(deps)}</dd>
    <dt>Model</dt><dd>${escapeHtml(task.modelProfile)}</dd>
    <dt>Writes</dt><dd>${escapeHtml(writes)}</dd>
    ${task.reason ? `<dt>Reason</dt><dd>${escapeHtml(task.reason)}</dd>` : ''}
  </dl>
  ${output}
</article>`;
        })
        .join('\n');
      return `<section class="rank"><h2>Rank ${rank}</h2>${cards}</section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="3">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(state.title)} - CoBolt Task Graph</title>
<style>
body{margin:0;font:14px/1.45 system-ui,Segoe UI,Arial,sans-serif;background:#f6f7f8;color:#172026}
header{padding:20px 28px;background:#172026;color:white}
h1{margin:0 0 6px;font-size:24px;letter-spacing:0}
.summary{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}
.pill{background:#273845;border:1px solid #425563;border-radius:4px;padding:4px 8px}
main{display:flex;gap:16px;align-items:flex-start;overflow:auto;padding:18px 24px}
.rank{min-width:280px;max-width:360px;background:#ffffff;border:1px solid #d7dde2;border-radius:6px;padding:12px}
h2{font-size:15px;margin:0 0 10px;color:#425563}
.card{border:1px solid #d7dde2;border-left-width:5px;border-radius:6px;margin:0 0 10px;padding:10px;background:white}
.card-head{display:flex;justify-content:space-between;gap:8px;font-size:12px;text-transform:uppercase;color:#425563}
.card h3{font-size:15px;margin:8px 0 6px}
.card p{margin:0 0 8px;color:#344955}
dl{display:grid;grid-template-columns:70px 1fr;gap:4px 8px;margin:0;font-size:12px}
dt{color:#5d6f7b}dd{margin:0;overflow-wrap:anywhere}
pre{max-height:180px;overflow:auto;background:#111820;color:#d9f0ff;padding:8px;border-radius:4px;font-size:12px}
.pending{border-left-color:#9aa7b2}.running{border-left-color:#2f80ed}.passed{border-left-color:#188a42}
.failed{border-left-color:#c7372f}.skipped{border-left-color:#9a6b00}.canceled,.cancel_requested{border-left-color:#5d6f7b}
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(state.title)}</h1>
  <div>${escapeHtml(state.status)} - ${escapeHtml(state.runId)} - updated ${escapeHtml(state.updatedAt)}</div>
  <div class="summary">
    <span class="pill">Tasks ${state.summary.taskCount}</span>
    <span class="pill">Passed ${state.summary.passed}</span>
    <span class="pill">Failed ${state.summary.failed}</span>
    <span class="pill">Skipped ${state.summary.skipped}</span>
    <span class="pill">Running ${state.summary.running}</span>
    <span class="pill">Pending ${state.summary.pending}</span>
  </div>
</header>
<main>
${rankHtml}
</main>
</body>
</html>
`;
}

function printHelp() {
  process.stdout.write(`CoBolt task graph orchestrator

Usage:
  node tools/cobolt-task-graph.js validate --graph graph.json [--json]
  node tools/cobolt-task-graph.js plan --graph graph.json [--json]
  node tools/cobolt-task-graph.js init-board --graph graph.json [--run-id id]
  node tools/cobolt-task-graph.js run --graph graph.json [--run-id id] [--task-timeout-ms n]
  node tools/cobolt-task-graph.js show --run-id id [--json]
  node tools/cobolt-task-graph.js list [--json]
  node tools/cobolt-task-graph.js cancel --run-id id

Graph task types:
  command  Executes exec.command with exec.args using spawn, no shell.
  tool     Executes node tools/index.js <tool.name> <tool.args...>.
  manual   Records a skipped manual task without executing anything.

Outputs:
  _cobolt-output/latest/task-graph/<run-id>/state.json
  _cobolt-output/latest/task-graph/<run-id>/run-board.html
  _cobolt-output/latest/task-graph/<run-id>/events.jsonl
`);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === 'help') {
    printHelp();
    return 0;
  }

  if (options.command === 'validate' || options.command === 'plan') {
    const graph = loadGraph(options.graphPath);
    const validation = validateGraph(graph);
    const result = { ok: validation.ok, graph, validation };
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(renderTextSummary(result));
    return validation.ok ? 0 : 1;
  }

  if (options.command === 'init-board') {
    const result = await initBoard(options);
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(renderTextSummary(result));
    return result._exit;
  }

  if (options.command === 'run') {
    const result = await runGraph(options);
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(renderTextSummary(result));
    return result._exit;
  }

  if (options.command === 'show') {
    const projectRoot = path.resolve(options.cwd || process.cwd());
    const statePath = options.statePath || locateRunState(projectRoot, options.runId);
    if (!statePath) throw new Error('Run state not found. Pass --run-id or --state.');
    const state = readJson(statePath);
    if (options.json) process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    else process.stdout.write(renderTextSummary({ state }));
    return 0;
  }

  if (options.command === 'list') {
    const runs = listRuns(path.resolve(options.cwd || process.cwd()));
    if (options.json) process.stdout.write(`${JSON.stringify({ runs }, null, 2)}\n`);
    else process.stdout.write(`${runs.map((run) => `${run.runId} ${run.status} ${run.title || ''}`).join('\n')}\n`);
    return 0;
  }

  if (options.command === 'cancel') {
    const result = cancelRun(options);
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`cancel requested: ${result.state.runId}\n`);
    return 0;
  }

  throw new Error(`Unknown command: ${options.command}`);
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`cobolt-task-graph: ${err.message}\n`);
      process.exit(1);
    });
}

module.exports = {
  DEFAULT_MODEL_PROFILE,
  buildRunState,
  cancelRun,
  computeRanks,
  detectCycles,
  initBoard,
  listRuns,
  loadGraph,
  longestPath,
  normalizeGraph,
  parseArgs,
  renderBoardHtml,
  runGraph,
  validateGraph,
  writeScopeConflict,
};
