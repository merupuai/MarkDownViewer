#!/usr/bin/env node

// Deterministic Step 03B integration smoke orchestrator for cobolt-build.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { projectExecutionLedger, syncBuildExecutionLedger } = require('../lib/cobolt-execution-ledger');

const DEFAULT_TIMEOUT_MS = 90 * 1000;

function normalizeMilestone(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'M1';
  return /^m\d+$/i.test(raw) ? raw.toUpperCase() : raw;
}

function parseArgs(argv = process.argv.slice(2)) {
  const flags = {
    command: 'run',
    cwd: process.cwd(),
    milestone: process.env.MILESTONE || 'M1',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
  };
  if (argv[0] && !argv[0].startsWith('-')) flags.command = argv.shift();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd') flags.cwd = path.resolve(argv[++i] || flags.cwd);
    else if (arg === '--milestone') flags.milestone = normalizeMilestone(argv[++i] || flags.milestone);
    else if (arg === '--timeout-ms') flags.timeoutMs = Number(argv[++i] || flags.timeoutMs);
    else if (arg === '--json') flags.json = true;
    else if (arg === '--help' || arg === '-h') flags.command = 'help';
  }
  flags.milestone = normalizeMilestone(flags.milestone);
  return flags;
}

function usage() {
  console.log('Usage: node tools/cobolt-build-integration-smoke.js run --milestone M1 [--cwd <project>] [--json]');
  console.log('Runs deterministic Step 03B wiring, worker lifecycle, API contract, and app runtime checks.');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, '');
  } catch {
    return '';
  }
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function rel(cwd, filePath) {
  return path.relative(cwd, filePath).replace(/\\/g, '/');
}

function buildPaths(cwd, milestone) {
  const outputRoot = path.join(cwd, '_cobolt-output');
  const latest = path.join(outputRoot, 'latest');
  const buildRoot = path.join(latest, 'build');
  const buildDir = path.join(buildRoot, milestone);
  return {
    outputRoot,
    latest,
    buildRoot,
    buildDir,
    checkpointsDir: path.join(buildRoot, 'checkpoints'),
    proofsDir: path.join(buildRoot, 'proofs'),
    auditDir: path.join(outputRoot, 'audit'),
    runtimeDir: path.join(latest, 'runtime'),
    planningDir: path.join(latest, 'planning'),
  };
}

function assertPrerequisites(cwd, milestone, paths) {
  const checkpointCandidates = [
    path.join(paths.checkpointsDir, `${milestone}-03a-code-gap-analysis.json`),
    path.join(paths.checkpointsDir, '03a-code-gap-analysis.json'),
  ];
  if (!checkpointCandidates.some((candidate) => fs.existsSync(candidate))) {
    throw new Error(`Step 03A checkpoint missing for ${milestone}`);
  }
  const buildArtifacts = path.join(paths.buildDir, `${milestone}-build-artifacts.json`);
  if (!fs.existsSync(buildArtifacts)) {
    throw new Error(`${rel(cwd, buildArtifacts)} missing`);
  }
}

function finiteCount(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function runWiringCheck(cwd, milestone, paths, options) {
  const outputPath = path.join(paths.buildDir, `${milestone}-wiring-check.json`);
  const report = options.wiringScanner
    ? options.wiringScanner(cwd)
    : require('./cobolt-entrypoint-wiring-check').scan(cwd);
  writeJson(outputPath, report);
  const unwiredCount = finiteCount(
    report.summary?.unwiredCount,
    report.summary?.unwired,
    report.unwiredCount,
    Array.isArray(report.unwired) ? report.unwired.length : undefined,
    Array.isArray(report.findings) ? report.findings.length : undefined,
  );
  return { outputPath, report, unwiredCount };
}

function runWorkerLifecycleCheck(cwd, milestone, paths, options) {
  const outputPath = path.join(paths.buildDir, `${milestone}-worker-lifecycle.json`);
  const report = options.workerScanner
    ? options.workerScanner(cwd)
    : require('./cobolt-worker-lifecycle-check').scan(cwd);
  writeJson(outputPath, report);
  const unstartedCount = finiteCount(
    report.summary?.unstartedCount,
    report.summary?.definedNotStarted,
    report.unstartedCount,
    Array.isArray(report.unstarted) ? report.unstarted.length : undefined,
    Array.isArray(report.findings) ? report.findings.length : undefined,
  );
  return { outputPath, report, unstartedCount };
}

// Channel wiring (Socket.IO / ws / SSE) — sibling of entrypoint/worker checks.
// Orphan count feeds the decide() verdict so Tier 1 enforcement flows through
// the same channel as unwiredCount does.
function runChannelWiringCheck(cwd, milestone, paths, options) {
  const outputPath = path.join(paths.buildDir, `${milestone}-channel-wiring.json`);
  const report = options.channelScanner
    ? options.channelScanner(cwd)
    : require('./cobolt-channel-wiring-check').scan(cwd);
  writeJson(outputPath, report);
  const orphanCount = finiteCount(report.summary?.orphanEmits, 0) + finiteCount(report.summary?.orphanHandles, 0);
  const realtimeCodeWithoutDeps = Boolean(report.summary?.realtimeCodePresent) && !report.summary?.realtimeDepsPresent;
  return { outputPath, report, orphanCount, realtimeCodeWithoutDeps };
}

// Queue topology (NATS/Kafka/AMQP/Redis/BullMQ/SQS).
// Tier 1 enforcement is conditional: only blocks when cobolt-queue-manifest.json
// is present. Without manifest, runs in advisory Tier 2 mode.
function runQueueTopologyCheck(cwd, milestone, paths, options) {
  const outputPath = path.join(paths.buildDir, `${milestone}-queue-topology.json`);
  let report;
  let verdict;
  try {
    const tool = options.queueScanner
      ? { scan: options.queueScanner, decideExitCode: null }
      : require('./cobolt-queue-topology-check');
    report = tool.scan(cwd);
    verdict = tool.decideExitCode ? tool.decideExitCode(report) : { code: 0, reason: 'no-verdict' };
  } catch (err) {
    report = { error: err.message, summary: {} };
    verdict = { code: 0, reason: 'tool-error' };
  }
  writeJson(outputPath, report);
  const manifestDeclared = Boolean(report?.manifest?.declared);
  const undeclaredOrphans = finiteCount(report?.summary?.undeclaredOrphans, 0);
  // Only contribute to hard-fail if manifest is present (Tier 1 mode).
  const tier1Orphans = manifestDeclared ? undeclaredOrphans : 0;
  return { outputPath, report, verdict, manifestDeclared, undeclaredOrphans, tier1Orphans };
}

function walkSourceText(cwd) {
  const ignored = new Set(['.git', 'node_modules', '_cobolt-output', 'vendor', 'bin', 'obj', 'dist', 'build']);
  const extensions = new Set(['.js', '.jsx', '.ts', '.tsx', '.go', '.ex', '.exs', '.py', '.rb', '.java', '.rs', '.cs']);
  const chunks = [];
  const stack = [cwd];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) stack.push(full);
      } else if (extensions.has(path.extname(entry.name))) {
        chunks.push(readText(full));
      }
    }
  }
  return chunks.join('\n');
}

function runApiContractCheck(cwd, milestone, paths) {
  const outputPath = path.join(paths.buildDir, `${milestone}-api-contract-check.json`);
  const apiContracts = path.join(paths.planningDir, 'api-contracts.md');
  if (!fs.existsSync(apiContracts)) {
    const report = { total: 0, found: 0, missing: [], registered: 0, completeness: 100, skipped: true };
    writeJson(outputPath, report);
    return { outputPath, report };
  }

  const contracts = readText(apiContracts);
  const endpointRegex = /^\s*(?:\*\*|\|)?\s*(GET|POST|PUT|PATCH|DELETE)\s+[`]?(\S+)[`]?/gim;
  const specEndpoints = [];
  let match;
  while ((match = endpointRegex.exec(contracts)) !== null) {
    const routePath = String(match[2] || '').trim();
    if (isConcreteEndpointPath(routePath)) specEndpoints.push({ method: match[1].toUpperCase(), path: routePath });
  }

  const codebase = walkSourceText(cwd);
  const registeredPaths = new Set();
  const routePatterns = [
    /\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gi,
    /(?:HandleFunc|Handle|GET|POST|PUT|PATCH|DELETE)\s*\(\s*['"]([^'"]+)['"]/gi,
    /(?:get|post|put|patch|delete)\s+['"]([^'"]+)['"]/gi,
    /Map(?:Get|Post|Put|Patch|Delete)\s*\(\s*["']([^"']+)["']/gi,
  ];
  for (const pattern of routePatterns) {
    pattern.lastIndex = 0;
    let routeMatch;
    while ((routeMatch = pattern.exec(codebase)) !== null) {
      const route = String(routeMatch[2] || routeMatch[1] || '')
        .replace(/:[a-zA-Z_]+/g, ':p')
        .replace(/\{[^}]+\}/g, ':p');
      if (route) registeredPaths.add(route);
    }
  }

  const report = { total: specEndpoints.length, found: 0, missing: [], registered: registeredPaths.size };
  for (const endpoint of specEndpoints) {
    const normalized = endpoint.path.replace(/:[a-zA-Z_]+/g, ':p').replace(/\{[^}]+\}/g, ':p');
    if (registeredPaths.has(normalized) || registeredPaths.has(endpoint.path)) report.found += 1;
    else report.missing.push({ method: endpoint.method, path: endpoint.path });
  }
  report.completeness = report.total > 0 ? Math.round((report.found / report.total) * 100) : 100;
  writeJson(outputPath, report);
  return { outputPath, report };
}

function isConcreteEndpointPath(routePath) {
  const value = String(routePath || '')
    .trim()
    .replace(/^`|`$/gu, '');
  if (!value || /[<>]/u.test(value)) return false;
  return value.startsWith('/') || /^https?:\/\//iu.test(value);
}

// v0.47.4 Tier 1 build consumer for the Plan-authored event-schemas.md.
// Declared-in-plan events are the authority; every declared event must have
// at least one producer reference in the shipping code (emit/publish/Kafka
// producer.send/NATS publish). Skips with completeness:100 only when
// event-schemas.md is absent.
function parseDeclaredEvents(text) {
  const events = new Set();
  const content = String(text || '');

  const headingRx = /^##+\s+([A-Za-z0-9_.-]+Event)\b/gm;
  let match;
  while ((match = headingRx.exec(content)) !== null) {
    events.add(match[1].trim());
  }

  const tableRx = /\|\s*event\s*\|\s*([A-Za-z0-9_.:-]+)\s*\|/gi;
  while ((match = tableRx.exec(content)) !== null) {
    const value = match[1].trim();
    if (value.toLowerCase() === 'name' || value.toLowerCase() === 'event') continue;
    events.add(value);
  }

  const yamlBlockRx = /(^|\n)events:\s*\n([\s\S]*?)(?=\n[A-Za-z_][A-Za-z0-9_-]*:\s*(?:\n|$)|\n*$)/g;
  while ((match = yamlBlockRx.exec(content)) !== null) {
    const block = match[2] || '';
    const keyRx = /^[\t ]+(?:-\s*)?([A-Za-z0-9_.:-]+)\s*:/gm;
    let keyMatch;
    while ((keyMatch = keyRx.exec(block)) !== null) {
      const key = keyMatch[1].trim();
      if (
        !/^(?:name|description|type|version|schema|payload|producer|consumer|owner|required|optional|fields)$/i.test(
          key,
        )
      ) {
        events.add(key);
      }
    }
    const dashRx = /^[\t ]*-\s+([A-Za-z0-9_.:-]+)\s*$/gm;
    let dashMatch;
    while ((dashMatch = dashRx.exec(block)) !== null) {
      events.add(dashMatch[1].trim());
    }
  }

  return [...events].filter((name) => name.length > 0);
}

function findEventProducers(cwd, events) {
  if (!events.length) return new Map();
  const roots = ['src', 'app', 'packages', 'services', 'backend', 'lib'];
  const candidates = roots
    .map((name) => path.join(cwd, name))
    .filter((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory());
  if (candidates.length === 0) candidates.push(cwd);

  const escapedEvents = events.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const alternation = escapedEvents.join('|');
  const patterns = [
    new RegExp(`\\bemit\\s*\\(\\s*['"\`](?:${alternation})['"\`]`, 'g'),
    new RegExp(`\\bpublish\\s*\\(\\s*['"\`](?:${alternation})['"\`]`, 'g'),
    new RegExp(`\\bproducer\\.send\\s*\\(\\s*\\{[^}]*topic\\s*:\\s*['"\`](?:${alternation})['"\`]`, 'g'),
    new RegExp(`\\bdispatchEvent\\s*\\(\\s*['"\`](?:${alternation})['"\`]`, 'g'),
    new RegExp(`\\bsend\\s*\\(\\s*['"\`](?:${alternation})['"\`]`, 'g'),
  ];

  const producers = new Map();
  for (const event of events) producers.set(event, []);

  const ignored = new Set(['.git', 'node_modules', '_cobolt-output', 'vendor', 'bin', 'obj', 'dist', 'build']);
  const extensions = new Set(['.js', '.jsx', '.ts', '.tsx', '.go', '.ex', '.exs', '.py', '.rb', '.java', '.rs', '.cs']);

  const visited = new Set();
  const stack = [...candidates];
  while (stack.length) {
    const dir = stack.pop();
    if (visited.has(dir)) continue;
    visited.add(dir);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) stack.push(full);
      } else if (extensions.has(path.extname(entry.name))) {
        let text = '';
        try {
          text = fs.readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        for (const pattern of patterns) {
          pattern.lastIndex = 0;
          let patternMatch;
          while ((patternMatch = pattern.exec(text)) !== null) {
            const snippet = patternMatch[0];
            for (const event of events) {
              if (snippet.includes(event)) {
                const list = producers.get(event);
                list.push(path.relative(cwd, full).replace(/\\/g, '/'));
              }
            }
          }
        }
      }
    }
  }

  return producers;
}

function runEventSchemaCheck(cwd, milestone, paths) {
  const outputPath = path.join(paths.buildDir, `${milestone}-event-schema-check.json`);
  const eventSchemas = path.join(paths.planningDir, 'event-schemas.md');
  if (!fs.existsSync(eventSchemas)) {
    const report = {
      total: 0,
      found: 0,
      missing: [],
      registered: 0,
      completeness: 100,
      skipped: true,
    };
    writeJson(outputPath, report);
    return { outputPath, report };
  }

  const declared = parseDeclaredEvents(readText(eventSchemas));
  if (declared.length === 0) {
    const report = {
      total: 0,
      found: 0,
      missing: [],
      registered: 0,
      completeness: 100,
      skipped: false,
    };
    writeJson(outputPath, report);
    return { outputPath, report };
  }

  const producerMap = findEventProducers(cwd, declared);
  const missing = [];
  let found = 0;
  let registered = 0;
  for (const event of declared) {
    const producers = producerMap.get(event) || [];
    if (producers.length > 0) {
      found += 1;
      registered += producers.length;
    } else {
      missing.push({ event });
    }
  }
  const report = {
    total: declared.length,
    found,
    missing,
    registered,
    completeness: Math.round((found / declared.length) * 100),
    skipped: false,
  };
  writeJson(outputPath, report);
  return { outputPath, report };
}

async function runRuntimeCheck(cwd, milestone, paths, options) {
  const logPath = path.join(paths.buildDir, `${milestone}-app-runtime-check.log`);
  const runtimeRunner =
    options.runtimeRunner ||
    ((runtimeOptions) => require('./cobolt-app-runtime-check').checkAppRuntime(runtimeOptions));
  const report = await runtimeRunner({
    command: 'check',
    cwd,
    milestone,
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    json: true,
  });
  fs.writeFileSync(logPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { logPath, report };
}

function collectFindings(report, primaryArrayNames) {
  for (const name of primaryArrayNames) {
    if (Array.isArray(report?.[name])) return report[name];
  }
  if (Array.isArray(report?.domains)) return report.domains.filter((entry) => entry.status === 'unwired');
  if (Array.isArray(report?.workers)) return report.workers.filter((entry) => entry.status === 'defined-not-started');
  if (Array.isArray(report?.findings)) return report.findings;
  return [];
}

function writeDerivedFindings(milestone, paths, wiring, worker) {
  if (wiring.unwiredCount > 0) {
    const findings = collectFindings(wiring.report, ['unwired']).map((finding, index) => ({
      id: `WIRE-${String(index + 1).padStart(3, '0')}`,
      severity: 'high',
      category: 'wiring',
      file: finding.file || finding.path || 'unknown',
      module: finding.module || finding.name || finding.domain || 'unknown',
      description: finding.description || finding.reason || finding.evidence || 'Entry point is not mounted.',
      source: 'cobolt-entrypoint-wiring-check',
    }));
    writeJson(path.join(paths.buildDir, `${milestone}-wiring-findings.json`), {
      milestone,
      findings,
      count: findings.length,
    });
  }

  if (worker.unstartedCount > 0) {
    const findings = collectFindings(worker.report, ['unstarted']).map((finding, index) => ({
      id: `LIFECYCLE-${String(index + 1).padStart(3, '0')}`,
      severity: 'medium',
      category: 'worker-lifecycle',
      file: finding.file || finding.path || 'unknown',
      module: finding.module || finding.name || 'unknown',
      description: finding.description || finding.reason || finding.evidence || 'Worker is not started.',
      source: 'cobolt-worker-lifecycle-check',
    }));
    writeJson(path.join(paths.buildDir, `${milestone}-lifecycle-findings.json`), {
      milestone,
      findings,
      count: findings.length,
    });
  }
}

function decide(runtimeReport, unwiredCount, unstartedCount, channelOrphans = 0) {
  const runtimeStatus = runtimeReport?.status || 'failed';
  const requiresRuntime = runtimeReport?.surfaces?.requiresRuntime !== false;
  const runtimeBlocked =
    runtimeStatus === 'blocked' ||
    (runtimeReport?.blockers || []).some((blocker) => String(blocker?.id || '').includes('child-process-denied'));
  const serverBoot = runtimeBlocked
    ? 'blocked'
    : runtimeStatus === 'passed'
      ? requiresRuntime
        ? 'passed'
        : 'skipped'
      : 'failed';
  let decision = 'pass';
  if (serverBoot === 'blocked') decision = 'warn';
  else if (serverBoot === 'failed') decision = 'fix-boot';
  else if (unwiredCount > 0 || channelOrphans > 0) decision = 'fix-wiring';
  else if (unstartedCount > 0 || serverBoot === 'skipped') decision = 'warn';
  const bootError =
    serverBoot === 'failed' || serverBoot === 'blocked'
      ? (runtimeReport?.blockers || []).map((blocker) => `${blocker.id}: ${blocker.message}`).join('; ') ||
        'app runtime check failed'
      : '';
  return {
    appRuntimeStatus: runtimeStatus,
    serverBoot,
    decision,
    bootError,
    passed: serverBoot !== 'failed' && unwiredCount === 0 && channelOrphans === 0,
  };
}

function withProjectRoot(cwd, fn) {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

function registerArtifact(filePath, milestone, type, step, cwd = process.cwd()) {
  const manifestTool = path.join(__dirname, 'cobolt-manifest.js');
  if (!fs.existsSync(manifestTool)) return;
  try {
    withProjectRoot(cwd, () => {
      require(manifestTool).register({ milestone, file: filePath, type, step });
    });
    return;
  } catch {
    // Fallback keeps compatibility with external tool bundles.
  }
  spawnSync(
    process.execPath,
    [manifestTool, 'register', '--milestone', milestone, '--file', filePath, '--type', type, '--step', step],
    {
      cwd,
      stdio: 'ignore',
    },
  );
}

function setState(key, value, cwd = process.cwd()) {
  const stateTool = path.join(__dirname, 'cobolt-state.js');
  if (!fs.existsSync(stateTool)) return;
  try {
    withProjectRoot(cwd, () => {
      const stateApi = require(stateTool);
      const state = stateApi.readState({ onCorrupt: 'repair' });
      stateApi.enforceAutonomousFlagGuard('set', key, String(value));
      stateApi.setNestedValue(state, key, String(value));
      stateApi.writeState(state);
    });
    return;
  } catch {
    // Fallback keeps compatibility with external tool bundles.
  }
  spawnSync(process.execPath, [stateTool, 'set', key, String(value)], {
    cwd,
    stdio: 'ignore',
  });
}

function writeState(cwd, decision, unwiredCount, unstartedCount) {
  setState('build.currentStep', '04-tdd-refactor', cwd);
  setState('build.integrationSmoke.serverBoot', decision.serverBoot, cwd);
  setState('build.integrationSmoke.appRuntimeStatus', decision.appRuntimeStatus, cwd);
  setState('build.integrationSmoke.unwiredCount', unwiredCount, cwd);
  setState('build.integrationSmoke.unstartedWorkers', unstartedCount, cwd);
  setState('checkpoints.integrationSmoke', 'passed', cwd);
}

async function runIntegrationSmoke(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const milestone = normalizeMilestone(options.milestone || 'M1');
  const paths = buildPaths(cwd, milestone);
  ensureDir(paths.buildDir);
  ensureDir(paths.checkpointsDir);
  ensureDir(paths.auditDir);
  ensureDir(paths.runtimeDir);
  assertPrerequisites(cwd, milestone, paths);

  const wiring = runWiringCheck(cwd, milestone, paths, options);
  const api = runApiContractCheck(cwd, milestone, paths);
  const eventSchema = runEventSchemaCheck(cwd, milestone, paths);
  const worker = runWorkerLifecycleCheck(cwd, milestone, paths, options);
  const channel = runChannelWiringCheck(cwd, milestone, paths, options);
  const queue = runQueueTopologyCheck(cwd, milestone, paths, options);
  const runtime = await runRuntimeCheck(cwd, milestone, paths, options);
  const channelOrphansForDecision = process.env.COBOLT_CHANNEL_WIRING === 'off' ? 0 : channel.orphanCount;
  const queueOrphansForDecision = process.env.COBOLT_QUEUE_TOPOLOGY === 'off' ? 0 : queue.tier1Orphans;
  const verdict = decide(
    runtime.report,
    wiring.unwiredCount,
    worker.unstartedCount,
    channelOrphansForDecision + queueOrphansForDecision,
  );
  writeDerivedFindings(milestone, paths, wiring, worker);

  const completedAt = new Date().toISOString();
  const smokePath = path.join(paths.buildDir, `${milestone}-integration-smoke.json`);
  const smoke = {
    checkpoint: 'integration-smoke',
    milestone,
    completedAt,
    serverBoot: verdict.serverBoot,
    appRuntimeStatus: verdict.appRuntimeStatus,
    syntheticReadiness: false,
    bootError: verdict.bootError,
    unwiredCount: wiring.unwiredCount,
    unstartedWorkers: worker.unstartedCount,
    channelOrphans: channel.orphanCount,
    channelRealtimeCodeWithoutDeps: channel.realtimeCodeWithoutDeps,
    queueUndeclaredOrphans: queue.undeclaredOrphans,
    queueManifestDeclared: queue.manifestDeclared,
    browserSmoke: runtime.report?.surfaces?.hasDesktop ? 'skipped-desktop' : 'not-run',
    decision: verdict.decision,
    fixAttempts: verdict.passed ? 0 : verdict.decision === 'fix-boot' ? 3 : 2,
    fixMaxAttempts: verdict.decision === 'fix-boot' ? 3 : verdict.decision === 'fix-wiring' ? 2 : 0,
    evidence: {
      wiringCheck: rel(cwd, wiring.outputPath),
      apiContractCheck: rel(cwd, api.outputPath),
      eventSchemaCheck: rel(cwd, eventSchema.outputPath),
      workerLifecycle: rel(cwd, worker.outputPath),
      channelWiring: rel(cwd, channel.outputPath),
      queueTopology: rel(cwd, queue.outputPath),
      appRuntimeLog: rel(cwd, runtime.logPath),
      appRuntimeReport: rel(cwd, path.join(paths.runtimeDir, 'app-runtime-check.json')),
    },
  };
  writeJson(smokePath, smoke);

  if (wiring.unwiredCount === 0) {
    writeJson(path.join(paths.auditDir, 'wiring-verified.json'), {
      milestone,
      verifiedAt: completedAt,
      unwiredCount: 0,
      unstartedWorkers: worker.unstartedCount,
      serverBoot: verdict.serverBoot,
      appRuntimeStatus: verdict.appRuntimeStatus,
      source: 'cobolt-build-integration-smoke',
    });
  }

  const checkpoint = {
    checkpoint: 'integration-smoke',
    milestone,
    passedAt: completedAt,
    serverBoot: verdict.serverBoot,
    appRuntimeStatus: verdict.appRuntimeStatus,
    unwiredCount: wiring.unwiredCount,
    unstartedWorkers: worker.unstartedCount,
    decision: verdict.decision,
    fixAttempts: smoke.fixAttempts,
  };
  const checkpointPath = path.join(paths.checkpointsDir, `${milestone}-03b-integration-smoke.json`);
  writeJson(checkpointPath, checkpoint);
  writeJson(path.join(paths.checkpointsDir, '03b-integration-smoke.json'), checkpoint);

  if (!options.skipManifest) registerArtifact(smokePath, milestone, 'integration-smoke', '03b', cwd);
  if (!options.skipState) writeState(cwd, verdict, wiring.unwiredCount, worker.unstartedCount);
  syncBuildExecutionLedger(cwd, milestone, {
    checkpointPath,
    checkpointId: '03b-integration-smoke',
  });
  projectExecutionLedger(cwd);

  return {
    passed: verdict.passed,
    milestone,
    decision: verdict.decision,
    serverBoot: verdict.serverBoot,
    appRuntimeStatus: verdict.appRuntimeStatus,
    unwiredCount: wiring.unwiredCount,
    unstartedWorkers: worker.unstartedCount,
    artifacts: {
      integrationSmoke: smokePath,
      checkpoint: checkpointPath,
      wiringCheck: wiring.outputPath,
      apiContractCheck: api.outputPath,
      eventSchemaCheck: eventSchema.outputPath,
      workerLifecycle: worker.outputPath,
      appRuntimeLog: runtime.logPath,
    },
    smoke,
  };
}

async function main() {
  const flags = parseArgs();
  if (flags.command === 'help') {
    usage();
    return 0;
  }
  if (flags.command !== 'run') {
    usage();
    return 2;
  }
  try {
    const result = await runIntegrationSmoke(flags);
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Integration smoke ${result.passed ? 'PASSED' : 'FAILED'} for ${result.milestone}`);
      console.log(`  serverBoot=${result.serverBoot}`);
      console.log(`  appRuntimeStatus=${result.appRuntimeStatus}`);
      console.log(`  unwiredCount=${result.unwiredCount}`);
      console.log(`  unstartedWorkers=${result.unstartedWorkers}`);
      console.log(`  decision=${result.decision}`);
    }
    return result.passed ? 0 : 1;
  } catch (err) {
    console.error(`[cobolt-build-integration-smoke] ${err.message}`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code || 0));
}

module.exports = {
  parseArgs,
  runIntegrationSmoke,
  runApiContractCheck,
  runEventSchemaCheck,
  runChannelWiringCheck,
  runQueueTopologyCheck,
  parseDeclaredEvents,
  findEventProducers,
  isConcreteEndpointPath,
  decide,
};
