#!/usr/bin/env node

// CoBolt Context Manager - pipeline context handoff between stages.
//
// Manages context state so that when a pipeline stage ends and the next begins,
// critical information survives the transition (carry-forward items, unresolved
// findings, in-progress work).
//
// Usage:
//   node tools/cobolt-context.js save <stage>         # Save current stage context
//   node tools/cobolt-context.js load <stage>         # Load context from a stage
//   node tools/cobolt-context.js handoff <from> <to>  # Transfer context between stages
//   node tools/cobolt-context.js checkpoint <stage>   # Write task-aware checkpoint for current stage
//   node tools/cobolt-context.js resume <stage>       # Show resume bundle for a stage
//   node tools/cobolt-context.js next <stage>         # Show the next atomic work item
//   node tools/cobolt-context.js heartbeat <stage>    # Record durable workflow heartbeat metadata
//   node tools/cobolt-context.js workflow <stage>     # Show durable workflow metadata for a stage
//   node tools/cobolt-context.js packet <stage>       # Build/write a compact stage context packet
//   node tools/cobolt-context.js carry-forward        # Show carry-forward items
//   node tools/cobolt-context.js add-carry <msg>      # Add carry-forward item
//   node tools/cobolt-context.js show                 # Show full context state

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite, atomicWriteJSON } = require('../lib/cobolt-atomic-write');

const { paths: _paths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();
const { buildResumeBundle } = require('../source/hooks/_context-resume');

function contextDir() {
  const _p = typeof _paths === 'function' ? _paths(process.cwd()) : null;
  return _p ? path.dirname(_p.contextState()) : path.join(process.cwd(), '_cobolt-output');
}

function contextFile() {
  const _p = typeof _paths === 'function' ? _paths(process.cwd()) : null;
  return _p ? _p.contextState() : path.join(process.cwd(), '_cobolt-output/context-state.json');
}

function carryForwardFile() {
  return path.join(contextDir(), 'carry-forward.json');
}

function normalizeStage(stage) {
  return String(stage || '')
    .trim()
    .toLowerCase();
}

function parseNumber(value, fallback = null) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function computeWorkflowState(entry, options = {}) {
  if (!entry) return null;

  const now = options.now ? new Date(options.now) : new Date();
  const heartbeatAt = entry.heartbeatAt ? new Date(entry.heartbeatAt) : null;
  const timeoutSeconds = parseNumber(entry.timeoutSeconds, null);
  const timeoutAt =
    heartbeatAt && timeoutSeconds
      ? new Date(heartbeatAt.getTime() + timeoutSeconds * 1000).toISOString()
      : entry.timeoutAt || null;
  const stale = Boolean(timeoutAt && new Date(timeoutAt).getTime() <= now.getTime());

  return {
    stage: entry.stage || null,
    status: entry.status || 'unknown',
    heartbeatAt: entry.heartbeatAt || null,
    timeoutSeconds,
    timeoutAt,
    stale,
    jobId: entry.jobId || null,
    owner: entry.owner || null,
    attempt: parseNumber(entry.attempt, 1) || 1,
    failureClass: entry.failureClass || null,
    sideEffecting: parseBoolean(entry.sideEffecting, false),
    note: entry.note || null,
    updatedAt: entry.updatedAt || null,
    retryPolicy: {
      mode: entry.retryPolicy?.mode || 'bounded',
      limit: parseNumber(entry.retryPolicy?.limit, 3) || 3,
      backoff: entry.retryPolicy?.backoff || 'linear',
    },
    compensation: entry.compensation
      ? {
          action: entry.compensation.action || entry.compensation || null,
          required: parseBoolean(entry.compensation.required, Boolean(entry.sideEffecting)),
          status: entry.compensation.status || 'pending',
        }
      : null,
  };
}

function readWorkflowMetadata(stage, options = {}) {
  const ctx = readContext();
  const key = normalizeStage(stage);
  return computeWorkflowState(ctx.workflowDurability?.[key], options);
}

function trimItem(item) {
  if (!item) return null;
  return {
    id: item.id || null,
    description: item.description || item.title || item.name || null,
    status: item.status || null,
  };
}

function buildResumeEvidenceQuery(stage, resumeBundle) {
  const parts = [
    stage,
    resumeBundle?.currentItem?.id,
    resumeBundle?.currentItem?.description,
    resumeBundle?.nextItem?.id !== resumeBundle?.currentItem?.id ? resumeBundle?.nextItem?.id : null,
    resumeBundle?.nextItem?.description !== resumeBundle?.currentItem?.description
      ? resumeBundle?.nextItem?.description
      : null,
  ];
  return parts.filter(Boolean).join(' ').trim();
}

function buildResumeEvidencePack(stage, resumeBundle) {
  const query = buildResumeEvidenceQuery(stage, resumeBundle);
  if (!query) return null;

  try {
    const { retrieveEvidenceContext } = require('./cobolt-knowledge-graph');
    const contextPack = retrieveEvidenceContext(process.cwd(), query, {
      limit: 8,
      directLimit: 4,
      force: false,
    });
    return {
      status: 'ready',
      query,
      strategy: contextPack.strategy,
      counts: contextPack.counts,
      directMatches: contextPack.directMatches.slice(0, 4),
      contextItems: contextPack.contextItems.slice(0, 8),
      guidance: contextPack.guidance,
    };
  } catch (err) {
    return {
      status: 'unavailable',
      query,
      reason: err?.message || 'evidence navigation unavailable',
    };
  }
}

const STAGE_DIR_ALIASES = {
  building: 'build',
  build: 'build',
  reviewing: 'review',
  review: 'review',
  fixing: 'fix',
  fix: 'fix',
  planning: 'planning',
  plan: 'planning',
  deploying: 'deploy',
  deploy: 'deploy',
  dreaming: 'dream',
  dream: 'dream',
};

function normalizeStageDir(stage) {
  const key = normalizeStage(stage);
  return STAGE_DIR_ALIASES[key] || key;
}

function relPath(projectRoot, filePath) {
  return filePath ? path.relative(projectRoot, filePath).replaceAll('\\', '/') : null;
}

function safeReadJson(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function latestRunDir(projectRoot) {
  const _p = typeof _paths === 'function' ? _paths(projectRoot) : null;
  if (_p) {
    try {
      return _p.latest();
    } catch {
      /* fall through */
    }
  }

  const latestPath = path.join(projectRoot, '_cobolt-output', 'latest');
  try {
    const pointerTarget = fs.readFileSync(`${latestPath}.ptr`, 'utf8').trim();
    if (pointerTarget && fs.existsSync(pointerTarget)) return pointerTarget;
  } catch {
    /* no pointer */
  }
  return latestPath;
}

function stageDirectory(projectRoot, stage) {
  return path.join(latestRunDir(projectRoot), normalizeStageDir(stage));
}

function listStageArtifacts(projectRoot, dir, options = {}) {
  const maxFiles = options.maxFiles || 40;
  const maxDepth = options.maxDepth || 2;
  const artifacts = [];

  function walk(currentDir, depth) {
    if (artifacts.length >= maxFiles || depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (artifacts.length >= maxFiles) break;
      if (entry.name === 'context-packets' || entry.name === '_versions') continue;
      const filePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(filePath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = fs.statSync(filePath);
        artifacts.push({
          path: relPath(projectRoot, filePath),
          size: stat.size,
          updatedAt: stat.mtime.toISOString(),
        });
      } catch {
        /* ignore unreadable file */
      }
    }
  }

  walk(dir, 0);
  return artifacts;
}

function latestCompactExtracts(projectRoot, options = {}) {
  const limit = options.limit || 4;
  const dir = path.join(projectRoot, '_cobolt-output', 'memory', 'compression-extracts');
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => {
        const filePath = path.join(dir, entry);
        const stat = fs.statSync(filePath);
        const parsed = safeReadJson(filePath) || {};
        return {
          path: relPath(projectRoot, filePath),
          type: parsed.type || null,
          trigger: parsed.trigger || null,
          compactEventId: parsed.compactEventId || parsed.snapshot?.compactEvent?.compactEventId || null,
          previousPrecompactExtract: parsed.previousPrecompactExtract || null,
          updatedAt: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, limit);
  } catch {
    return [];
  }
}

function fallbackProgressItem(progress) {
  const items = Array.isArray(progress?.items) ? progress.items : Array.isArray(progress?.tasks) ? progress.tasks : [];
  const item =
    items.find((entry) => entry.status === 'in_progress') ||
    items.find((entry) => entry.status === 'pending') ||
    items.find((entry) => entry.status === 'failed') ||
    null;
  return trimItem(item);
}

function stagePacketRules(stage) {
  const key = normalizeStageDir(stage);
  if (key === 'build') {
    return [
      'Pass the packet path, sprint contract, target files, and test commands; do not paste full source files into the prompt.',
      'The receiving agent should read only target files and nearby tests needed for the current item.',
      'Return changed files, test evidence, and any carry-forward item as structured data.',
    ];
  }
  if (key === 'review') {
    return [
      'Pass scoped files, diff paths, reviewer category, schema path, and finding output contract.',
      'Reviewers should return findings with tight file/line references and avoid restating large code excerpts.',
      'The orchestrator owns deduplication and progress updates after reviewer results return.',
    ];
  }
  if (key === 'fix') {
    return [
      'Pass finding IDs, finding tracker path, accountability log path, patch boundaries, and verification commands.',
      'Fix agents should update only files needed for assigned findings and return verification evidence.',
      'The fix lead owns iteration accounting and escalation decisions.',
    ];
  }
  return [
    'Pass this packet path plus bounded task details instead of dumping stage artifacts into prompts.',
    'The receiving agent should read referenced files on demand and return structured results.',
  ];
}

function routerEnabled(options, stage) {
  if (options.contextRoute === false) return false;
  if (options.contextRoute === true) return true;
  if (String(process.env.COBOLT_CONTEXT_ROUTER || '').trim() === '1') return true;
  // Per-stage opt-in (Phase 6 infrastructure; defaults stay off).
  const stageName = String(stage || options.stage || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');
  if (stageName) {
    const stageKey = `COBOLT_CONTEXT_ROUTER_${stageName}`;
    if (String(process.env[stageKey] || '').trim() === '1') return true;
  }
  return false;
}

function attachContextRoute(packet, options) {
  if (!routerEnabled(options, packet.stage)) return packet;
  let router;
  try {
    router = require('./cobolt-context-router');
  } catch (err) {
    // Fail-open: routing is additive; packet must remain valid.
    if (process.env.COBOLT_CONTEXT_ROUTER_DEBUG === '1') {
      console.error(`  [context-router] load failed: ${err.message}`);
    }
    return packet;
  }
  try {
    const route = router.buildContextRoute(packet.projectRoot, {
      stage: packet.stage,
      milestone: packet.milestone,
      skill: packet.skill,
      agent: packet.agent,
      item: packet.context?.currentItem?.id || packet.context?.nextItem?.id || null,
      requirementIds: options.requirementIds,
      findingIds: options.findingIds,
      storyIds: options.storyIds,
      changedFiles: options.changedFiles,
      failingTests: options.failingTests,
      query: options.query,
      mode: options.mode,
      maxSelected: options.maxSelected,
      maxExcerptChars: options.maxExcerptChars || packet.contextBudget?.maxExcerptChars,
      impact: options.impact,
    });
    packet.contextRoute = route;
    appendRoutingGuidance(packet);
  } catch (err) {
    if (process.env.COBOLT_CONTEXT_ROUTER_DEBUG === '1') {
      console.error(`  [context-router] build failed: ${err.message}`);
    }
  }
  return packet;
}

function appendRoutingGuidance(packet) {
  if (!packet.contextRoute) return;
  const r = packet.contextRoute;
  const routingRules = [
    `Read contextRoute.selected[] first (${r.selected.length} cells). Each cell cites a local artifact path.`,
    `If selected[] is insufficient, expand contextRoute.parked[] (${r.parked.length} cells) and record which ones you read in the return summary.`,
    'Cite the selected paths you used in the structured return so downstream telemetry can measure hit/miss.',
    'contextRoute.omitted[] is ranked as low-value by deterministic signals. Expand only if selected+parked were insufficient, and record the reason.',
  ];
  if (!Array.isArray(packet.dispatchRules)) packet.dispatchRules = [];
  packet.dispatchRules = [...packet.dispatchRules, ...routingRules];
}

function buildContextPacket(stage, options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const normalizedStage = normalizeStage(stage);
  if (!normalizedStage) throw new Error('context packet requires a stage name');

  const stageDir = stageDirectory(projectRoot, normalizedStage);
  const progressPath = path.join(stageDir, 'progress.json');
  const progress = safeReadJson(progressPath);
  const trackerPath = path.join(stageDir, 'finding-tracker.json');
  const accountabilityPath = path.join(stageDir, 'fix-accountability-log.json');
  const resumeBundle = getResumeBundle(normalizedStage);
  const fallbackItem = fallbackProgressItem(progress);
  const carryForward = getCarryForward();

  const packet = {
    generatedAt: nowIso(),
    projectRoot,
    stage: normalizedStage,
    stageDir: relPath(projectRoot, stageDir),
    milestone: options.milestone || progress?.milestone || resumeBundle?.progress?.milestone || null,
    skill: options.skill || null,
    agent: options.agent || null,
    goal: options.goal || `Complete the bounded ${normalizedStage} task described by currentItem or nextItem.`,
    context: {
      progressFile: fs.existsSync(progressPath) ? relPath(projectRoot, progressPath) : null,
      findingTracker: fs.existsSync(trackerPath) ? relPath(projectRoot, trackerPath) : null,
      accountabilityLog: fs.existsSync(accountabilityPath) ? relPath(projectRoot, accountabilityPath) : null,
      currentItem: resumeBundle?.currentItem || resumeBundle?.nextItem || fallbackItem || null,
      nextItem: resumeBundle?.nextItem || fallbackItem || null,
      progress: resumeBundle?.progress || null,
      workflow: resumeBundle?.workflow || null,
      reset: resumeBundle?.reset || null,
      carryForwardCount: carryForward.length,
      artifacts: listStageArtifacts(projectRoot, stageDir),
      compactExtracts: latestCompactExtracts(projectRoot),
    },
    constraints: [
      'Use artifact paths and targeted file reads; do not paste large logs, diffs, transcripts, or PRDs into prompts.',
      'Respect existing worktree changes and only modify files required for the assigned task.',
      'Write durable progress, findings, or handoff state back to CoBolt artifacts before ending the unit of work.',
    ],
    doneCriteria: [
      'Assigned item is completed or explicitly carried forward with reason.',
      'Required tests or verification commands are recorded.',
      'Returned result follows the requested schema, patch summary, or report contract.',
    ],
    contextBudget: {
      maxExcerptChars: Number(options.maxExcerptChars || 2400),
      guidance: 'Pass this packet path to agents and let them read referenced files on demand.',
    },
    dispatchRules: stagePacketRules(normalizedStage),
  };

  return attachContextRoute(packet, options);
}

function defaultContextPacketPath(projectRoot, packet) {
  const stageDir = stageDirectory(projectRoot, packet.stage);
  const outDir = path.join(stageDir, 'context-packets');
  const milestone = packet.milestone || 'all';
  const agent = packet.agent ? `-${String(packet.agent).replace(/[^a-z0-9_-]+/gi, '-')}` : '';
  return path.join(outDir, `${packet.stage}-${milestone}${agent}.json`);
}

function writeContextPacket(packet, outputPath) {
  const target = outputPath || defaultContextPacketPath(packet.projectRoot, packet);
  atomicWriteJSON(target, packet, { mode: 0o600 });
  return target;
}

function getResumeBundle(stage) {
  const bundle = buildResumeBundle(process.cwd(), stage);
  const progress = bundle?.progress;
  const workflow = readWorkflowMetadata(stage);

  const resumeBundle = {
    stage: bundle?.stage || stage || null,
    progressFile: progress?.progressFile || null,
    format: progress?.format || null,
    currentItem: trimItem(bundle?.currentItem),
    nextItem: trimItem(bundle?.nextItem),
    progress: progress?.summary
      ? {
          totalItems: progress.summary.totalItems,
          completedCount: progress.summary.completedCount,
          inProgressCount: progress.summary.inProgressCount,
          pendingCount: progress.summary.pendingCount,
          failedCount: progress.summary.failedCount,
          remainingItems: (progress.summary.remainingItems || []).map(trimItem),
          recentlyCompleted: (progress.summary.recentlyCompleted || []).map(trimItem),
          artifacts: (progress.summary.artifacts || []).slice(0, 6),
        }
      : null,
    reset: {
      needsFreshAgent: bundle?.resets?.needsFreshAgent || false,
      markerPath: bundle?.resets?.markerPath || null,
      latestHandoffPath: bundle?.resets?.latestHandoffPath || null,
      latestCheckpointPath: bundle?.resets?.latestCheckpointPath || null,
      contextUsage:
        bundle?.resets?.marker?.contextUsage ||
        bundle?.resets?.latestHandoff?.contextUsage ||
        bundle?.resets?.latestCheckpoint?.contextUsage ||
        null,
      reason:
        bundle?.resets?.latestHandoff?.reason ||
        bundle?.resets?.marker?.instruction ||
        bundle?.resets?.compactionHint?.recommendations?.[0] ||
        null,
    },
    carryForwardCount: bundle?.carryForwardCount || 0,
    workflow,
  };

  resumeBundle.evidence = buildResumeEvidencePack(stage, resumeBundle);
  return resumeBundle;
}

function readContext() {
  const fp = contextFile();
  if (!fs.existsSync(fp)) {
    return {
      currentStage: null,
      stages: {},
      carryForward: [],
      lastHandoff: null,
      workflowDurability: {},
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return {
      currentStage: parsed.currentStage || null,
      stages: parsed.stages || {},
      carryForward: parsed.carryForward || [],
      lastHandoff: parsed.lastHandoff || null,
      lastUpdated: parsed.lastUpdated || null,
      workflowDurability: parsed.workflowDurability || {},
    };
  } catch {
    process.stderr.write('[cobolt-context] Warning: corrupt context-state.json, returning fresh state\n');
    return {
      currentStage: null,
      stages: {},
      carryForward: [],
      lastHandoff: null,
      workflowDurability: {},
    };
  }
}

function writeContext(ctx) {
  ctx.lastUpdated = new Date().toISOString();
  const cf = contextFile();
  atomicWrite(cf, JSON.stringify(ctx, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function readCarryForward() {
  const fp = carryForwardFile();
  if (!fs.existsSync(fp)) return { items: [], lastUpdated: null };
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function writeCarryForward(cf) {
  cf.lastUpdated = new Date().toISOString();
  const cfp = carryForwardFile();
  atomicWrite(cfp, JSON.stringify(cf, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function heartbeat(stage, options = {}) {
  const ctx = readContext();
  const key = normalizeStage(stage);
  if (!key) {
    throw new Error('heartbeat requires a stage name');
  }

  const existing = ctx.workflowDurability?.[key] || {};
  const heartbeatAt = options.heartbeatAt || nowIso();
  const timeoutSeconds = parseNumber(options.timeoutSeconds ?? existing.timeoutSeconds, null);
  const entry = {
    ...existing,
    stage: key,
    status: options.status || existing.status || 'running',
    heartbeatAt,
    timeoutSeconds,
    timeoutAt:
      timeoutSeconds && heartbeatAt
        ? new Date(new Date(heartbeatAt).getTime() + timeoutSeconds * 1000).toISOString()
        : existing.timeoutAt || null,
    jobId: options.jobId ?? existing.jobId ?? null,
    owner: options.owner ?? existing.owner ?? null,
    attempt: parseNumber(options.attempt ?? existing.attempt, 1) || 1,
    failureClass: options.failureClass ?? existing.failureClass ?? null,
    sideEffecting: parseBoolean(options.sideEffecting, existing.sideEffecting),
    note: options.note ?? existing.note ?? null,
    retryPolicy: {
      mode: options.retryMode || existing.retryPolicy?.mode || 'bounded',
      limit: parseNumber(options.retryLimit ?? existing.retryPolicy?.limit, 3) || 3,
      backoff: options.retryBackoff || existing.retryPolicy?.backoff || 'linear',
    },
    compensation:
      options.compensation || existing.compensation
        ? {
            action: options.compensation || existing.compensation?.action || existing.compensation || null,
            required:
              parseBoolean(
                options.compensationRequired ?? existing.compensation?.required,
                parseBoolean(options.sideEffecting, existing.sideEffecting),
              ) || parseBoolean(options.sideEffecting, existing.sideEffecting),
            status: options.compensationStatus || existing.compensation?.status || 'pending',
          }
        : null,
    updatedAt: nowIso(),
  };

  ctx.workflowDurability = ctx.workflowDurability || {};
  ctx.workflowDurability[key] = entry;
  writeContext(ctx);
  return computeWorkflowState(entry);
}

function workflow(stage, options = {}) {
  return readWorkflowMetadata(stage, options);
}

function save(stage, data = {}) {
  const ctx = readContext();
  const resume = getResumeBundle(stage);
  ctx.currentStage = stage;
  ctx.stages[stage] = {
    savedAt: new Date().toISOString(),
    data,
    artifacts: findStageArtifacts(stage),
    resume,
    workflow: workflow(stage),
  };
  writeContext(ctx);
  console.log(`  Context saved for stage: ${stage}`);
  return ctx.stages[stage];
}

function load(stage) {
  const ctx = readContext();
  const stageCtx = ctx.stages[stage];
  if (!stageCtx) {
    console.error(`  No context saved for stage: ${stage}`);
    return null;
  }
  return stageCtx;
}

function handoff(fromStage, toStage, options = {}) {
  const ctx = readContext();
  const fromCtx = ctx.stages[fromStage];
  if (!fromCtx) {
    console.error(`  No context for stage: ${fromStage}`);
    process.exit(1);
  }

  const handoffRecord = {
    from: fromStage,
    to: toStage,
    timestamp: new Date().toISOString(),
    carryForward: ctx.carryForward.filter((item) => item.status === 'open'),
    fromData: fromCtx.data || {},
    note: options.note || null,
    checkpoint: options.checkpoint === true,
    resume: getResumeBundle(fromStage),
    workflow: workflow(fromStage),
  };

  ctx.currentStage = toStage;
  ctx.lastHandoff = handoffRecord;

  if (!ctx.stages[toStage]) {
    ctx.stages[toStage] = { savedAt: new Date().toISOString(), data: {}, artifacts: [] };
  }
  ctx.stages[toStage].receivedFrom = fromStage;
  ctx.stages[toStage].handoffData = handoffRecord;
  ctx.stages[toStage].workflow = workflow(toStage);

  writeContext(ctx);

  const _p = typeof _paths === 'function' ? _paths(process.cwd()) : null;
  const resetsDir = _p ? _p.contextResets() : path.join(process.cwd(), '_cobolt-output/context-resets');
  const handoffFile = path.join(resetsDir, `handoff-${fromStage}-to-${toStage}-${Date.now()}.json`);
  atomicWrite(handoffFile, JSON.stringify(handoffRecord, null, 2), { encoding: 'utf8', mode: 0o600 });

  console.log(
    `  Context handoff: ${fromStage} -> ${toStage} (${handoffRecord.carryForward.length} carry-forward items)`,
  );
  return handoffRecord;
}

function checkpoint(stage, note) {
  const _p = typeof _paths === 'function' ? _paths(process.cwd()) : null;
  const resetsDir = _p ? _p.contextResets() : path.join(process.cwd(), '_cobolt-output/context-resets');

  const record = {
    timestamp: new Date().toISOString(),
    stage,
    note: note || null,
    resume: getResumeBundle(stage),
    workflow: workflow(stage),
  };

  const filePath = path.join(resetsDir, `checkpoint-${stage}-${Date.now()}.json`);
  atomicWrite(filePath, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });

  console.log(`  Context checkpoint written: ${path.basename(filePath)}`);
  return record;
}

function resume(stage) {
  return getResumeBundle(stage);
}

function next(stage) {
  const bundle = getResumeBundle(stage);
  return bundle.nextItem || bundle.currentItem || null;
}

function addCarryForward(message, priority, stage) {
  const cf = readCarryForward();
  const item = {
    id: `CF-${String(cf.items.length + 1).padStart(4, '0')}`,
    message,
    priority: priority || 'medium',
    stage: stage || 'unknown',
    status: 'open',
    createdAt: new Date().toISOString(),
  };
  cf.items.push(item);
  writeCarryForward(cf);

  const ctx = readContext();
  ctx.carryForward.push(item);
  writeContext(ctx);

  console.log(`  Carry-forward added: ${item.id} - ${message}`);
  return item;
}

function getCarryForward() {
  const cf = readCarryForward();
  return cf.items.filter((item) => item.status === 'open');
}

function show() {
  return readContext();
}

function findStageArtifacts(stage) {
  const _p = typeof _paths === 'function' ? _paths(process.cwd()) : null;
  if (!_p) return [];
  try {
    const stageDir = _p[stage] ? _p[stage]() : null;
    if (!stageDir || !fs.existsSync(stageDir)) return [];
    return fs.readdirSync(stageDir).map((file) => path.join(stageDir, file));
  } catch {
    return [];
  }
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return null;
  return args[index + 1];
}

function positionalOrFlag(args, positionalIndex, flag) {
  return flagValue(args, flag) || args[positionalIndex] || null;
}

module.exports = {
  save,
  load,
  handoff,
  checkpoint,
  resume,
  next,
  heartbeat,
  workflow,
  addCarryForward,
  getCarryForward,
  show,
  computeWorkflowState,
  readWorkflowMetadata,
  buildResumeEvidencePack,
  readContext,
  writeContext,
  getResumeBundle,
  buildContextPacket,
  latestCompactExtracts,
  writeContextPacket,
  defaultContextPacketPath,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '--help') {
    console.log('  Usage: node tools/cobolt-context.js <command> [args]');
    console.log(
      '  Commands: save, load, handoff, checkpoint, resume, next, heartbeat, workflow, packet, carry-forward, add-carry, show',
    );
    process.exit(0);
  }

  switch (cmd) {
    case 'save': {
      const stage = positionalOrFlag(args, 1, '--stage');
      if (!stage) {
        console.error('  Usage: save <stage> [--key key --value json]');
        process.exit(1);
      }
      const key = flagValue(args, '--key');
      const value = flagValue(args, '--value');
      const data = {};
      if (key) {
        data[key] = value || '';
      }
      save(stage, data);
      break;
    }
    case 'load': {
      const stage = positionalOrFlag(args, 1, '--stage');
      if (!stage) {
        console.error('  Usage: load <stage>');
        process.exit(1);
      }
      const ctx = load(stage);
      if (ctx) console.log(JSON.stringify(ctx, null, 2));
      break;
    }
    case 'handoff': {
      if (!args[1] || !args[2]) {
        console.error('  Usage: handoff <from> <to>');
        process.exit(1);
      }
      handoff(args[1], args[2]);
      break;
    }
    case 'checkpoint': {
      if (!args[1]) {
        console.error('  Usage: checkpoint <stage> [note]');
        process.exit(1);
      }
      checkpoint(args[1], args[2]);
      break;
    }
    case 'resume': {
      if (!args[1]) {
        console.error('  Usage: resume <stage>');
        process.exit(1);
      }
      console.log(JSON.stringify(resume(args[1]), null, 2));
      break;
    }
    case 'next': {
      if (!args[1]) {
        console.error('  Usage: next <stage>');
        process.exit(1);
      }
      console.log(JSON.stringify(next(args[1]), null, 2));
      break;
    }
    case 'heartbeat': {
      if (!args[1]) {
        console.error(
          '  Usage: heartbeat <stage> [--status running] [--job-id id] [--attempt N] [--timeout-sec N] [--owner name] [--failure-class class] [--retry-limit N] [--retry-backoff mode] [--compensation action] [--side-effecting] [--note text]',
        );
        process.exit(1);
      }
      const record = heartbeat(args[1], {
        status: flagValue(args, '--status'),
        jobId: flagValue(args, '--job-id'),
        attempt: flagValue(args, '--attempt'),
        timeoutSeconds: flagValue(args, '--timeout-sec'),
        owner: flagValue(args, '--owner'),
        failureClass: flagValue(args, '--failure-class'),
        retryLimit: flagValue(args, '--retry-limit'),
        retryBackoff: flagValue(args, '--retry-backoff'),
        retryMode: flagValue(args, '--retry-mode'),
        compensation: flagValue(args, '--compensation'),
        compensationStatus: flagValue(args, '--compensation-status'),
        compensationRequired: parseBoolean(flagValue(args, '--compensation-required'), undefined),
        sideEffecting: args.includes('--side-effecting') || flagValue(args, '--side-effecting'),
        note: flagValue(args, '--note'),
      });
      console.log(JSON.stringify(record, null, 2));
      break;
    }
    case 'workflow': {
      if (!args[1]) {
        console.error('  Usage: workflow <stage>');
        process.exit(1);
      }
      console.log(JSON.stringify(workflow(args[1]), null, 2));
      break;
    }
    case 'packet': {
      if (!args[1]) {
        console.error(
          '  Usage: packet <stage> [--milestone M1] [--skill name] [--agent name] [--goal text] [--output file] [--write] [--json] [--context-route] [--no-context-route]',
        );
        process.exit(1);
      }
      const wantRoute = args.includes('--context-route')
        ? true
        : args.includes('--no-context-route')
          ? false
          : undefined;
      const packet = buildContextPacket(args[1], {
        milestone: flagValue(args, '--milestone'),
        skill: flagValue(args, '--skill'),
        agent: flagValue(args, '--agent'),
        goal: flagValue(args, '--goal'),
        maxExcerptChars: flagValue(args, '--max-excerpt-chars'),
        contextRoute: wantRoute,
        requirementIds: flagValue(args, '--requirement'),
        findingIds: flagValue(args, '--finding'),
        storyIds: flagValue(args, '--story'),
        changedFiles: flagValue(args, '--changed'),
        failingTests: flagValue(args, '--failing-test'),
        query: flagValue(args, '--query'),
        mode: flagValue(args, '--mode'),
        impact: args.includes('--impact') ? true : args.includes('--no-impact') ? false : undefined,
      });
      if (args.includes('--write')) {
        const outputPath = writeContextPacket(packet, flagValue(args, '--output'));
        packet.packetPath = relPath(packet.projectRoot, outputPath);
        if (packet.contextRoute) {
          try {
            const router = require('./cobolt-context-router');
            const routePath = router.writeContextRoute(packet.projectRoot, packet.contextRoute);
            packet.contextRoutePath = relPath(packet.projectRoot, routePath);
            // C: Auto-baseline telemetry. Record minimal usage entry so operators
            // see data even without hand-calling cobolt-context-route-usage. This
            // only fires after a route was actually written — never touches the
            // default-off path.
            try {
              const usage = require('./cobolt-context-route-usage');
              usage.recordUsage(packet.projectRoot, {
                stage: packet.stage,
                milestone: packet.milestone,
                skill: packet.skill,
                agent: packet.agent,
                routePath: packet.contextRoutePath,
                mode: packet.contextRoute.mode,
                selectedCount: packet.contextRoute.selected.length,
                parkedCount: packet.contextRoute.parked.length,
                omittedCount: packet.contextRoute.omitted.length,
                outcome: 'baseline',
                note: 'auto-baseline-on-write',
              });
            } catch (err) {
              // fail-open: telemetry must never break writes.
              if (process.env.COBOLT_CONTEXT_ROUTER_DEBUG === '1') {
                console.error(`  [context-router] auto-baseline telemetry failed: ${err.message}`);
              }
            }
          } catch (err) {
            if (process.env.COBOLT_CONTEXT_ROUTER_DEBUG === '1') {
              console.error(`  [context-router] write failed: ${err.message}`);
            }
          }
        }
      }
      if (args.includes('--json')) {
        console.log(JSON.stringify(packet, null, 2));
      } else {
        console.log(`  Context packet for ${packet.stage}${packet.milestone ? ` ${packet.milestone}` : ''}`);
        console.log(`  Stage dir: ${packet.stageDir || '(missing)'}`);
        if (packet.packetPath) console.log(`  Packet written: ${packet.packetPath}`);
        if (packet.contextRoutePath) console.log(`  Route written: ${packet.contextRoutePath}`);
        console.log(`  Artifacts: ${packet.context.artifacts.length}`);
        if (packet.contextRoute) {
          const r = packet.contextRoute;
          console.log(`  Route: selected=${r.selected.length} parked=${r.parked.length} omitted=${r.omitted.length}`);
        }
      }
      break;
    }
    case 'carry-forward': {
      const items = getCarryForward();
      if (items.length === 0) {
        console.log('  No open carry-forward items.');
        break;
      }
      for (const item of items) console.log(`  ${item.id} [${item.priority}] ${item.message} (from: ${item.stage})`);
      break;
    }
    case 'add-carry': {
      if (!args[1]) {
        console.error('  Usage: add-carry <message> [priority] [stage]');
        process.exit(1);
      }
      addCarryForward(args[1], args[2], args[3]);
      break;
    }
    case 'show': {
      const ctx = show();
      console.log(JSON.stringify(ctx, null, 2));
      break;
    }
    default:
      console.error(`  Unknown command: ${cmd}`);
      process.exit(1);
  }
}
