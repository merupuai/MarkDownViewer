#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { CoboltPaths } = require('../lib/cobolt-paths');

const FAILURE_RE = /\b(fail(?:ed|ure)?|error|blocked|blocker|exception|timeout|plateau|degraded)\b/i;
const FAILURE_STATUSES = new Set([
  'fail',
  'failed',
  'failure',
  'failures-detected',
  'error',
  'errored',
  'blocked',
  'blocker',
  'timeout',
  'timed-out',
]);
const CLEAR_STATUSES = new Set([
  'pass',
  'passed',
  'ok',
  'clear',
  'aligned',
  'verified',
  'resolved',
  'success',
  'succeeded',
  'clean',
  'generated',
]);

const USAGE = `Usage: node ${path.basename(__filename)} [--cwd <path>] [--json] [--limit <n>]

Discovers agent failures from runtime logs and emits agent-failure-review.json.

Flags:
  --cwd <path>   Project root (default: cwd)
  --json         Emit machine-readable JSON
  --limit <n>    Max failures to collect (default: 500)
  --help, -h     Show this help and exit

Exit codes:
  0  Discovery completed successfully (failureCount > 0 is data, not error)
  1  Hard error
`;

function parseArgs(argv = process.argv.slice(2)) {
  const flags = {
    cwd: process.cwd(),
    json: false,
    limit: 500,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--cwd') flags.cwd = path.resolve(argv[++i] || flags.cwd);
    else if (arg === '--json') flags.json = true;
    else if (arg === '--limit') flags.limit = Number(argv[++i] || flags.limit);
  }
  return flags;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonLines(filePath) {
  try {
    return fs
      .readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
  } catch {
    return [];
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, value, { encoding: 'utf8', mode: 0o600 });
}

function rel(cwd, filePath) {
  return path.relative(cwd, filePath).replace(/\\/g, '/');
}

function reviewAgentFailures(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const paths = new CoboltPaths(cwd);
  const latest = paths.latest();
  const sourceAgents = listSourceAgents(cwd);
  const advisorAgent = resolveAdvisorAgent(cwd, sourceAgents);
  const logFiles = knownRuntimeLogs(cwd, paths);
  const failures = [];

  for (const logFile of logFiles) {
    for (const event of readEvents(logFile)) {
      if (!isFailureEvent(event, logFile)) continue;
      failures.push(normalizeFailure(cwd, logFile, event));
      if (failures.length >= Number(options.limit || 500)) break;
    }
    if (failures.length >= Number(options.limit || 500)) break;
  }

  const byAgent = {};
  for (const failure of failures) {
    const agent = failure.agent || 'unknown-agent';
    byAgent[agent] ||= [];
    byAgent[agent].push(failure.id);
  }

  // v0.40.13 PROD-13: freshness metadata.
  // The tool's output is a snapshot-in-time — callers that invoke at planning
  // and don't re-invoke at build/milestone-close see stale "clear" verdicts
  // even when build-phase logs accumulate failures. Add:
  //   - scanWindowStart/End: timestamp range the scan covered
  //   - latestLogMtime: newest mtime across scannedLogs at invocation
  //   - staleAfter: ISO timestamp indicating when consumers should re-scan
  //     (30 min after generation; mirrors v0.19 reliability-guard freshness)
  let latestLogMtime = 0;
  for (const logFile of logFiles) {
    try {
      const m = fs.statSync(logFile).mtimeMs;
      if (m > latestLogMtime) latestLogMtime = m;
    } catch {
      /* best effort */
    }
  }
  const generatedAt = new Date();
  const staleAfter = new Date(generatedAt.getTime() + 30 * 60 * 1000);

  const result = {
    version: 1,
    generatedAt: generatedAt.toISOString(),
    staleAfter: staleAfter.toISOString(),
    latestLogMtime: latestLogMtime ? new Date(latestLogMtime).toISOString() : null,
    status: failures.length ? 'failures-detected' : 'clear',
    sourceAgentCount: sourceAgents.length,
    sourceAgents,
    scannedLogs: logFiles.map((filePath) => rel(cwd, filePath)),
    failureCount: failures.length,
    failures,
    byAgent,
    escalation: {
      leadAgent: 'review-lead',
      advisorAgent,
      advisorRequired: failures.length > 0,
      contextPolicy:
        'Pass full event payload, source log path, agent identity, blocker text, and latest readiness gate outputs to the lead before attempting another fix loop.',
    },
  };

  const outDir = path.join(latest, 'production-readiness');
  const reviewPath = path.join(outDir, 'agent-failure-review.json');
  const packetPath = path.join(outDir, 'review-lead-escalation-packet.json');
  writeJson(reviewPath, result);
  writeJson(packetPath, escalationPacket(result));
  writeText(path.join(outDir, 'agent-failure-review.md'), renderMarkdown(result));
  return result;
}

// v0.40.13 PROD-13: public helper for consumers to check if a given
// agent-failure-review.json payload is stale relative to current filesystem.
// Returns { stale: boolean, reason: string | null }.
function isAgentFailureReviewStale(result, cwd = process.cwd()) {
  if (!result || typeof result !== 'object') return { stale: true, reason: 'missing-or-malformed' };
  if (!result.generatedAt) return { stale: true, reason: 'no-generatedAt' };
  const generatedAtMs = Date.parse(result.generatedAt);
  if (!Number.isFinite(generatedAtMs)) return { stale: true, reason: 'bad-generatedAt' };
  // Staleness check 1: the tool said it expires.
  const staleAfterMs = Date.parse(result.staleAfter || '');
  if (Number.isFinite(staleAfterMs) && Date.now() > staleAfterMs) {
    return { stale: true, reason: 'past-staleAfter' };
  }
  // Staleness check 2: logs were written after the scan.
  const paths = new CoboltPaths(cwd);
  const logs = knownRuntimeLogs(cwd, paths);
  for (const logFile of logs) {
    try {
      if (fs.statSync(logFile).mtimeMs > generatedAtMs) {
        return { stale: true, reason: `log-newer-than-scan:${path.basename(logFile)}` };
      }
    } catch {
      /* ignore */
    }
  }
  return { stale: false, reason: null };
}

function resolveAdvisorAgent(cwd, sourceAgents = listSourceAgents(cwd)) {
  const candidates = ['advisor', 'enhancement-advisor', 'recovery-advisor', 'milestone-transition-advisor'];
  return candidates.find((candidate) => sourceAgents.includes(candidate)) || 'review-lead';
}

function listSourceAgents(cwd) {
  const dir = path.join(cwd, 'source', 'agents');
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name.replace(/\.md$/, ''))
      .sort();
  } catch {
    return [];
  }
}

function knownRuntimeLogs(cwd, paths) {
  const candidates = [
    path.join(cwd, '_cobolt-output', 'agent-messages.json'),
    path.join(cwd, '_cobolt-output', 'watchdog-log.json'),
    path.join(cwd, '_cobolt-output', 'public', 'agent-hub', 'attempts.jsonl'),
    path.join(cwd, '_cobolt-output', 'public', 'agent-hub', 'notes.jsonl'),
    paths.productionReadinessLog(),
  ];
  const latest = paths.latest();
  collectFiles(latest, (filePath) => {
    const name = path.basename(filePath).toLowerCase();
    if (
      name.startsWith('agent-failure-review') ||
      name === 'review-lead-escalation-packet.json' ||
      name === 'check-report.md'
    ) {
      return;
    }
    if (
      name.includes('finding') ||
      name.includes('failure') ||
      name.includes('verdict') ||
      name.includes('gate') ||
      name.includes('report')
    ) {
      candidates.push(filePath);
    }
  });
  return [...new Set(candidates.filter((filePath) => fs.existsSync(filePath)))];
}

function collectFiles(root, onFile) {
  if (!root || !fs.existsSync(root)) return;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(filePath);
      else if (entry.isFile() && /\.(json|jsonl|md|txt|log)$/i.test(entry.name)) onFile(filePath);
    }
  }
}

function readEvents(filePath) {
  if (filePath.endsWith('.jsonl')) return readJsonLines(filePath);
  const data = readJson(filePath);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.events)) return data.events;
  if (Array.isArray(data?.messages)) return data.messages;
  if (Array.isArray(data?.findings)) return data.findings;
  if (Array.isArray(data?.blockers)) return data.blockers;
  if (data && typeof data === 'object') return [data];
  try {
    return fs
      .readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => FAILURE_RE.test(line))
      .map((line) => ({ raw: line }));
  } catch {
    return [];
  }
}

function isFailureEvent(event, logFile) {
  if (!event || typeof event !== 'object') return false;
  if (event.kind === 'plateau-resolved') return false;

  const status = normalizeStatus(event.status || event.verdict || event.result || event.outcome);
  if (CLEAR_STATUSES.has(status)) return false;
  if (event.passed === true && !hasNonzeroArray(event.blockers) && !hasNonzeroArray(event.failures)) return false;
  if (event.ok === true && !hasNonzeroArray(event.gaps) && !hasNonzeroArray(event.failures)) return false;
  if (isZeroFailureAggregate(event)) return false;

  const agent =
    event.agent || event.agentName || event.role || event.owner || event.leadAgent || inferAgentFromText(event);
  const agentLog = isAgentRuntimeLog(logFile);

  if (status && FAILURE_STATUSES.has(status) && (agent || agentLog)) return true;
  if ((event.error || event.exception || event.timeout) && (agent || agentLog)) return true;
  if (hasNonzeroArray(event.failures) && (agent || agentLog)) return true;
  if (hasNonzeroArray(event.blockers) && agent) return true;

  if (typeof event.raw === 'string') {
    return agentLog && FAILURE_RE.test(event.raw) && !/\b(pass|passed|clear|resolved)\b/i.test(event.raw);
  }
  return false;
}

function normalizeStatus(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function hasNonzeroArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function isZeroFailureAggregate(event) {
  const fields = ['failed', 'errored', 'errors', 'totalErrors', 'failureCount', 'blockerCount'];
  return (
    fields.some((field) => Object.hasOwn(event, field)) && fields.every((field) => Number(event[field] || 0) === 0)
  );
}

function isAgentRuntimeLog(logFile) {
  const normalized = logFile.replace(/\\/g, '/').toLowerCase();
  return (
    normalized.endsWith('/agent-messages.json') ||
    normalized.endsWith('/watchdog-log.json') ||
    normalized.includes('/agent-hub/attempts.jsonl') ||
    normalized.includes('/agent-hub/notes.jsonl') ||
    normalized.includes('/builder-return-log.jsonl')
  );
}

function normalizeFailure(cwd, logFile, event) {
  const agent =
    event.agent || event.agentName || event.role || event.owner || event.leadAgent || inferAgentFromText(event);
  const id = event.id || event.findingId || event.metric || `${path.basename(logFile)}:${hash(JSON.stringify(event))}`;
  return {
    id: String(id),
    agent: agent || 'unknown-agent',
    source: rel(cwd, logFile),
    severity: event.severity || event.priority || event.status || 'unknown',
    message: event.message || event.error || event.label || event.title || event.raw || summarize(event),
    leadAgent: 'review-lead',
    advisorRequired: true,
    errorContext: {
      typedError: event.error_class || event.errorClass || event.errorType || event.kind || event.status || 'unknown',
      command: event.command || event.cmd || event.toolCall || null,
      exitCode: event.exit_code ?? event.exitCode ?? null,
      stdout: event.stdout || '',
      stderr: event.stderr || '',
      stack: event.stack || event.exception || '',
      stateSnapshot: event.state_snapshot || event.stateSnapshot || event.state || {},
      inputPacket: event.input_packet || event.inputPacket || event.packet || {},
      upstreamArtifacts: event.upstream_artifacts || event.upstreamArtifacts || event.artifact_refs || [],
      attemptedFixes: event.attempted_fixes || event.attemptedFixes || event.recovery_attempts || [],
      nextAction:
        event.next_action ||
        event.nextAction ||
        event.remediation ||
        'Review root cause and return a concrete fix path.',
    },
    raw: event,
  };
}

function inferAgentFromText(event) {
  const text = JSON.stringify(event);
  const match = text.match(/\b([a-z0-9-]+-(?:agent|lead|reviewer|fix|auditor))\b/i);
  return match ? match[1] : null;
}

function summarize(value) {
  return JSON.stringify(value).slice(0, 500);
}

function hash(value) {
  let total = 0;
  for (let i = 0; i < value.length; i++) total = (total * 31 + value.charCodeAt(i)) >>> 0;
  return total.toString(16);
}

function escalationPacket(result) {
  return {
    version: 1,
    generatedAt: result.generatedAt,
    to: result.escalation.leadAgent,
    advisor: result.escalation.advisorAgent,
    advisorRequired: result.escalation.advisorRequired,
    failureCount: result.failureCount,
    failures: result.failures,
    contextTransferPolicy:
      'Forward each failure.raw plus failure.errorContext to review-lead. If review-lead cannot resolve, forward the same packet unchanged to the advisor and append advisor resolution state before continuing.',
    doneCriteria: [
      'Each failure has a root cause, owner, fix path, and verification command.',
      'Repeated plateau events are split into narrower blockers before another autonomous fix loop.',
      'Lead/advisor responses preserve typed error, command, stack, stdout/stderr, state snapshot, input packet, upstream artifact refs, attempted fixes, and next action.',
      'No lead closes a failure without a durable evidence artifact path.',
    ],
  };
}

function renderMarkdown(result) {
  const lines = [
    '# Agent Failure Review',
    '',
    `- Status: ${result.status}`,
    `- Source agents checked: ${result.sourceAgentCount}`,
    `- Runtime failures found: ${result.failureCount}`,
    `- Escalation lead: ${result.escalation.leadAgent}`,
    `- Advisor required: ${result.escalation.advisorRequired ? 'yes' : 'no'}`,
    '',
  ];
  if (result.failures.length) {
    lines.push('## Failures', '');
    for (const failure of result.failures.slice(0, 25)) {
      lines.push(`- ${failure.agent} ${failure.id}: ${failure.message}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const flags = parseArgs();
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }
  const result = reviewAgentFailures(flags);
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Agent failure review - ${result.status}`);
    console.log(`Failures: ${result.failureCount}`);
    if (result.failureCount) console.log(`Escalate to ${result.escalation.leadAgent}`);
  }
  // Discovery is a successful run — non-zero finding count is data, not a tool
  // error. Caller can read the JSON output for the count and escalation target.
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { reviewAgentFailures, parseArgs, resolveAdvisorAgent, isAgentFailureReviewStale };
