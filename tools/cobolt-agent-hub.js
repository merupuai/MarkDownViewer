#!/usr/bin/env node

// CoBolt Agent Hub - shared notes, attempts, delegation artifacts, and compact
// rules for parallel and background-safe coordination.
//
// Inspired by the useful coordination patterns in CORAL, but adapted to CoBolt's
// existing worktree + pipeline model.
//
// Usage:
//   node tools/cobolt-agent-hub.js attempt add --agent agent-1 --score 0.82 --summary "Improved parser"
//   node tools/cobolt-agent-hub.js attempt top [-n 5] [--agent agent-1] [--json]
//   node tools/cobolt-agent-hub.js note add --agent agent-1 --kind insight --title "Observation" --body "..."
//   node tools/cobolt-agent-hub.js note list [--kind warning] [--json]
//   node tools/cobolt-agent-hub.js delegation start --id dlg-1 --agent security-reviewer --mode async --prompt "..."
//   node tools/cobolt-agent-hub.js delegation complete --id dlg-1 --result-file .\\result.txt --json
//   node tools/cobolt-agent-hub.js delegation get --id dlg-1 --json
//   node tools/cobolt-agent-hub.js compact-rules render --ids delegation-id,result-envelope
//   node tools/cobolt-agent-hub.js heartbeat show [--json]
//   node tools/cobolt-agent-hub.js heartbeat check --agent agent-1 [--json]

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { atomicWrite: sharedAtomicWrite } = require('../lib/cobolt-atomic-write');

const { paths: getPaths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();

const DEFAULT_SHARED_LINK_NAME = '.cobolt-shared';
const DEFAULT_COMPACT_RULES = {
  version: 1,
  rules: [
    {
      id: 'delegation-id',
      summary: 'Every delegated task carries a stable delegation id.',
      text: 'Include a stable delegation_id in the dispatch metadata and return envelope so the orchestrator can persist, resume, and recover results after compaction.',
    },
    {
      id: 'async-readonly',
      summary: 'Async delegation is for background, read-only work.',
      text: 'Use async mode only for read-only or text-returning work. Do not create or modify files. Persist the normalized result envelope and let the orchestrator decide follow-up action.',
    },
    {
      id: 'sync-critical',
      summary: 'Sync delegation is for blocking or dependency-critical work.',
      text: 'Use sync mode when the next step depends immediately on the delegated result. Keep the task bounded and return the normalized result envelope before the orchestrator continues.',
    },
    {
      id: 'result-envelope',
      summary: 'Return the standard CoBolt worker result envelope.',
      text: 'Return status, summary, artifacts, risks, follow_ups, and details in the worker-result envelope. Free-form text is allowed only inside details.',
    },
    {
      id: 'compact-skill-context',
      summary: 'Inject only compact rules instead of full skill files.',
      text: 'Do not restate full skill instructions in delegated prompts. Inject only the relevant compact rule ids and the minimum task-specific context the worker needs.',
    },
    {
      id: 'escalate-file-writes',
      summary: 'Escalate file-writing work back to the orchestrator.',
      text: 'If the delegated task discovers that file changes are required, stop and return a plan. The orchestrator or an agent team with explicit ownership must perform the writes.',
    },
  ],
};

function pathHelper(projectDir) {
  return typeof getPaths === 'function' ? getPaths(projectDir || process.cwd()) : null;
}

function hubDir(projectDir) {
  const helper = pathHelper(projectDir);
  if (helper?.agentHubDir) return helper.agentHubDir();
  return path.join(projectDir || process.cwd(), '_cobolt-output', 'public', 'agent-hub');
}

function delegationsDir(projectDir) {
  const helper = pathHelper(projectDir);
  if (helper?.agentHubDelegationsDir) return helper.agentHubDelegationsDir();
  return path.join(hubDir(projectDir), 'delegations');
}

function attemptsFile(projectDir) {
  const helper = pathHelper(projectDir);
  if (helper?.agentHubAttempts) return helper.agentHubAttempts();
  return path.join(hubDir(projectDir), 'attempts.jsonl');
}

function notesFile(projectDir) {
  const helper = pathHelper(projectDir);
  if (helper?.agentHubNotes) return helper.agentHubNotes();
  return path.join(hubDir(projectDir), 'notes.jsonl');
}

function heartbeatFile(projectDir) {
  const helper = pathHelper(projectDir);
  if (helper?.agentHubHeartbeat) return helper.agentHubHeartbeat();
  return path.join(hubDir(projectDir), 'heartbeat.json');
}

function compactRulesFile(projectDir) {
  const helper = pathHelper(projectDir);
  if (helper?.agentHubCompactRules) return helper.agentHubCompactRules();
  return path.join(hubDir(projectDir), 'compact-rules.json');
}

function safeFileToken(value, fallback = 'item') {
  const sanitized = String(value || '')
    .trim()
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return sanitized || fallback;
}

function delegationFile(id, projectDir) {
  return path.join(delegationsDir(projectDir), `${safeFileToken(id, 'delegation')}.json`);
}

function delegationPromptFile(id, projectDir) {
  return path.join(delegationsDir(projectDir), `${safeFileToken(id, 'delegation')}.prompt.txt`);
}

function delegationResultFile(id, projectDir) {
  return path.join(delegationsDir(projectDir), `${safeFileToken(id, 'delegation')}.result.txt`);
}

function ensureHub(projectDir) {
  const dir = hubDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(delegationsDir(projectDir), { recursive: true });
  seedHeartbeat(projectDir);
  seedCompactRules(projectDir);
  return dir;
}

function defaultHeartbeatConfig() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    rules: [
      {
        id: 'stall-reflect',
        metric: 'no_improvement',
        window: 3,
        action: 'reflect',
        prompt:
          'Recent attempts did not improve the score. Pause, explain what you learned, and try a smaller verified change next.',
      },
      {
        id: 'repeat-failure',
        metric: 'consecutive_failures',
        window: 2,
        action: 'stabilize',
        prompt:
          'Recent attempts failed. Restore a green baseline, narrow the change, and re-run the smallest proving test before continuing.',
      },
    ],
  };
}

function defaultCompactRulesConfig() {
  return {
    version: DEFAULT_COMPACT_RULES.version,
    updatedAt: new Date().toISOString(),
    rules: DEFAULT_COMPACT_RULES.rules.map((rule) => ({ ...rule })),
  };
}

function atomicWrite(filePath, content) {
  sharedAtomicWrite(filePath, content, { encoding: 'utf8' });
}

function seedHeartbeat(projectDir, options = {}) {
  const filePath = heartbeatFile(projectDir);
  if (fs.existsSync(filePath) && options.force !== true) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      /* overwrite corrupt heartbeat config */
    }
  }
  const config = defaultHeartbeatConfig();
  atomicWrite(filePath, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

function readHeartbeatConfig(projectDir) {
  const filePath = heartbeatFile(projectDir);
  if (!fs.existsSync(filePath)) return seedHeartbeat(projectDir);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return seedHeartbeat(projectDir, { force: true });
  }
}

function writeHeartbeatConfig(config, projectDir) {
  const next = {
    version: 1,
    updatedAt: new Date().toISOString(),
    rules: Array.isArray(config?.rules) ? config.rules : defaultHeartbeatConfig().rules,
  };
  atomicWrite(heartbeatFile(projectDir), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function resolveCompactRulesTemplate(projectDir) {
  const root = projectDir || process.cwd();
  const candidates = [
    path.join(root, 'source', 'templates', 'delegation-compact-rules.json'),
    path.join(root, 'cobolt', 'templates', 'delegation-compact-rules.json'),
    path.join(__dirname, '..', 'source', 'templates', 'delegation-compact-rules.json'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return JSON.parse(fs.readFileSync(candidate, 'utf8'));
      }
    } catch {
      /* try next */
    }
  }

  return defaultCompactRulesConfig();
}

function normalizeCompactRulesRegistry(config = {}) {
  return {
    version: Number(config.version || DEFAULT_COMPACT_RULES.version) || DEFAULT_COMPACT_RULES.version,
    updatedAt: new Date().toISOString(),
    rules: (Array.isArray(config.rules) ? config.rules : DEFAULT_COMPACT_RULES.rules)
      .map((rule) => ({
        id: safeFileToken(rule.id || rule.name || '', 'rule'),
        summary: normalizeText(rule.summary || rule.title || ''),
        text: normalizeText(rule.text || rule.body || ''),
      }))
      .filter((rule) => rule.id && rule.text),
  };
}

function seedCompactRules(projectDir, options = {}) {
  const filePath = compactRulesFile(projectDir);
  if (fs.existsSync(filePath) && options.force !== true) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      /* overwrite corrupt compact rules */
    }
  }

  const config = normalizeCompactRulesRegistry(resolveCompactRulesTemplate(projectDir));
  atomicWrite(filePath, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

function readCompactRules(projectDir) {
  const filePath = compactRulesFile(projectDir);
  if (!fs.existsSync(filePath)) return seedCompactRules(projectDir);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return seedCompactRules(projectDir, { force: true });
  }
}

function writeCompactRules(config, projectDir) {
  const next = normalizeCompactRulesRegistry(config);
  atomicWrite(compactRulesFile(projectDir), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .trim();
}

function normalizeTags(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return [...new Set(value.map((tag) => String(tag).trim()).filter(Boolean))];
  }
  return [
    ...new Set(
      String(value)
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

function mergeUniqueArrays(...values) {
  const merged = [];
  for (const value of values) {
    for (const item of value || []) {
      const normalized = String(item || '').trim();
      if (normalized && !merged.includes(normalized)) merged.push(normalized);
    }
  }
  return merged;
}

function normalizeNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeStatus(value, fallback = 'logged') {
  const normalized = String(value || fallback)
    .trim()
    .toLowerCase();
  return normalized || fallback;
}

function normalizeDelegationMode(value, fallback = 'sync') {
  const normalized = String(value || fallback)
    .trim()
    .toLowerCase();
  if (['async', 'background', 'bg'].includes(normalized)) return 'async';
  if (['sync', 'foreground', 'fg', 'blocking'].includes(normalized)) return 'sync';
  return fallback;
}

function normalizeEnvelopeStatus(value, fallback = 'unknown') {
  const normalized = String(value || fallback)
    .trim()
    .toLowerCase();
  if (['success', 'completed', 'complete', 'done', 'ok', 'pass', 'passed'].includes(normalized)) return 'success';
  if (['failure', 'failed', 'error', 'errored', 'fail'].includes(normalized)) return 'failure';
  if (['partial', 'blocked', 'incomplete', 'mixed'].includes(normalized)) return 'partial';
  if (['queued', 'pending'].includes(normalized)) return 'queued';
  if (['running', 'in_progress', 'in-progress', 'started'].includes(normalized)) return 'running';
  return fallback;
}

function normalizeDelegationStatus(value, fallback = 'running') {
  const normalized = String(value || fallback)
    .trim()
    .toLowerCase();
  if (['queued', 'pending'].includes(normalized)) return 'queued';
  if (['running', 'in_progress', 'in-progress', 'started'].includes(normalized)) return 'running';
  if (['success', 'completed', 'complete', 'done', 'ok', 'pass', 'passed'].includes(normalized)) return 'completed';
  if (['failure', 'failed', 'error', 'errored', 'fail'].includes(normalized)) return 'failed';
  if (['partial', 'blocked', 'incomplete', 'mixed'].includes(normalized)) return 'partial';
  if (['cancelled', 'canceled', 'aborted'].includes(normalized)) return 'canceled';
  return fallback;
}

function makeId(prefix) {
  const suffix = crypto.randomUUID().slice(0, 8);
  return `${prefix}-${Date.now()}-${suffix}`;
}

function makeDeterministicId(parts, prefix = 'delegation') {
  const source = parts.filter(Boolean).join('|') || crypto.randomUUID();
  const hash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 12);
  return `${prefix}-${hash}`;
}

function normalizeStringArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap((item) => normalizeStringArray(item)))];
  }

  const text = normalizeText(value);
  if (!text) return [];

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const hasBullets = lines.some((line) => /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line));
  const items = hasBullets
    ? lines.map((line) =>
        line
          .replace(/^[-*]\s+/, '')
          .replace(/^\d+\.\s+/, '')
          .trim(),
      )
    : lines.length > 1
      ? lines
      : text.includes(',')
        ? text.split(',').map((item) => item.trim())
        : [text];

  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function firstMeaningfulLine(text) {
  return (
    normalizeText(text)
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) || ''
  );
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripXmlTags(text) {
  return normalizeText(text)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLikelyArtifacts(text) {
  const matches =
    normalizeText(text).match(
      /\b(?:_cobolt-output|docs|src|lib|app|tests?|spec|config|public|assets|tools|source|scripts)\/[^\s"'`,)<>\]]+/g,
    ) || [];
  return [...new Set(matches.map((item) => item.replace(/[.,;:]+$/, '')))];
}

function parseSection(text, headings) {
  const body = normalizeText(text);
  if (!body) return '';

  for (const heading of headings) {
    const headingPattern = new RegExp(
      `(?:^|\\n)#{1,6}\\s*${escapeRegex(heading)}\\s*\\n([\\s\\S]*?)(?=\\n#{1,6}\\s+|\\n(?:Artifacts|Files|Outputs|Risks|Risk|Watchouts|Follow Ups|Follow-up|Follow-ups|Next Steps|Summary|Status|Details)\\s*:|$)`,
      'i',
    );
    const headingMatch = body.match(headingPattern);
    if (headingMatch?.[1]) return normalizeText(headingMatch[1]);

    const labelPattern = new RegExp(`(?:^|\\n)${escapeRegex(heading)}\\s*:\\s*([^\\n]+)`, 'i');
    const labelMatch = body.match(labelPattern);
    if (labelMatch?.[1]) return normalizeText(labelMatch[1]);
  }

  return '';
}

function parseSectionList(text, headings) {
  return normalizeStringArray(parseSection(text, headings));
}

function parseCompactRuleIdsFromText(text) {
  const body = normalizeText(text);
  if (!body) return [];

  const ids = [];
  const xmlMatch = body.match(/<compact-rules[^>]*ids="([^"]+)"/i);
  if (xmlMatch?.[1]) ids.push(...normalizeTags(xmlMatch[1]));

  const labelMatch = body.match(/compact[_ -]?rules?\s*:\s*([^\n]+)/i);
  if (labelMatch?.[1]) ids.push(...normalizeTags(labelMatch[1]));

  return [...new Set(ids)];
}

function parseDelegationIdFromText(text) {
  const body = normalizeText(text);
  if (!body) return '';
  const match = body.match(/delegation[_ -]?id\s*[:=]\s*([a-z0-9._:-]+)/i);
  return normalizeText(match?.[1]);
}

function parseModeFromText(text) {
  const body = normalizeText(text);
  if (!body) return '';
  const match = body.match(/delegation[_ -]?mode\s*[:=]\s*(async|sync|background|foreground)/i);
  return normalizeDelegationMode(match?.[1], '');
}

function parseTaggedBlock(text, tagName) {
  const body = normalizeText(text);
  if (!body) return null;

  const blockPattern = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const blockMatch = body.match(blockPattern);
  if (!blockMatch?.[1]) return null;

  const inner = blockMatch[1];
  const fields = {};
  const tagPattern = /<([a-z0-9_-]+)>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = tagPattern.exec(inner)) !== null) {
    fields[match[1].toLowerCase()] = normalizeText(match[2]);
  }

  return { inner: normalizeText(inner), fields };
}

function parseWorkerResultBlock(text) {
  const parsed = parseTaggedBlock(text, 'worker-result');
  if (!parsed) return null;

  const fields = parsed.fields;
  return {
    format: 'worker-result',
    delegationId: normalizeText(fields.delegation_id || fields['delegation-id']),
    mode: normalizeDelegationMode(fields.mode || fields.delegation_mode || fields['delegation-mode'], ''),
    status: normalizeEnvelopeStatus(fields.status || fields.result, 'unknown'),
    summary: normalizeText(fields.summary),
    details: normalizeText(fields.details || fields.output || stripXmlTags(parsed.inner)),
    artifacts: normalizeStringArray(fields.artifacts),
    risks: normalizeStringArray(fields.risks || fields.watchouts),
    followUps: normalizeStringArray(
      fields.follow_ups || fields['follow-ups'] || fields.followups || fields.next_steps || fields['next-steps'],
    ),
    evidence: normalizeStringArray(fields.evidence),
    compactRules: normalizeTags(fields.compact_rules || fields['compact-rules']),
  };
}

function normalizeResultEnvelope(input = {}) {
  const rawResult = normalizeText(input.rawResult || input.text || input.result || '');
  const workerBlock = parseWorkerResultBlock(rawResult);
  const inferredStatus = normalizeEnvelopeStatus(
    input.status || workerBlock?.status || parseSection(rawResult, ['Status']) || (rawResult ? 'success' : 'unknown'),
    rawResult ? 'success' : 'unknown',
  );

  const details =
    normalizeText(input.details) ||
    workerBlock?.details ||
    parseSection(rawResult, ['Details', 'Result', 'Observations']) ||
    rawResult;
  const summary =
    normalizeText(input.summary) ||
    workerBlock?.summary ||
    parseSection(rawResult, ['Summary']) ||
    firstMeaningfulLine(stripXmlTags(rawResult)) ||
    'No summary provided';

  const artifacts = mergeUniqueArrays(
    normalizeStringArray(input.artifacts),
    workerBlock?.artifacts || [],
    parseSectionList(rawResult, ['Artifacts', 'Files', 'Outputs']),
    extractLikelyArtifacts(rawResult),
  );
  const risks = mergeUniqueArrays(
    normalizeStringArray(input.risks),
    workerBlock?.risks || [],
    parseSectionList(rawResult, ['Risks', 'Risk', 'Watchouts']),
  );
  const followUps = mergeUniqueArrays(
    normalizeStringArray(input.followUps || input.follow_ups),
    workerBlock?.followUps || [],
    parseSectionList(rawResult, ['Follow Ups', 'Follow-up', 'Follow-ups', 'Next Steps']),
  );
  const evidence = mergeUniqueArrays(
    normalizeStringArray(input.evidence),
    workerBlock?.evidence || [],
    parseSectionList(rawResult, ['Evidence']),
  );
  const compactRules = mergeUniqueArrays(
    normalizeTags(input.compactRules || input.compact_rules),
    workerBlock?.compactRules || [],
    parseCompactRuleIdsFromText(rawResult),
  );

  return {
    status: inferredStatus,
    summary,
    details,
    artifacts,
    risks,
    followUps,
    evidence,
    compactRules,
    rawFormat: workerBlock ? workerBlock.format : rawResult ? 'plain-text' : 'none',
  };
}

function normalizeAttempt(input = {}) {
  const score = normalizeNumber(input.score);
  return {
    id: input.id || makeId('attempt'),
    agent: String(input.agent || 'unknown'),
    score,
    status: normalizeStatus(input.status, score === null ? 'logged' : 'scored'),
    summary: String(input.summary || input.message || '').trim(),
    milestone: input.milestone || null,
    worktree: input.worktree || null,
    branch: input.branch || null,
    commit: input.commit || null,
    tags: normalizeTags(input.tags),
    createdAt: input.createdAt || new Date().toISOString(),
    meta: input.meta && typeof input.meta === 'object' ? input.meta : {},
  };
}

function addAttempt(input = {}, projectDir) {
  ensureHub(projectDir);
  const record = normalizeAttempt(input);
  appendJsonLine(attemptsFile(projectDir), record);
  return record;
}

function listAttempts(filters = {}, projectDir) {
  const rows = readJsonLines(attemptsFile(projectDir))
    .filter((row) => !filters.agent || row.agent === filters.agent)
    .filter((row) => !filters.milestone || row.milestone === filters.milestone)
    .filter((row) => !filters.status || normalizeStatus(row.status) === normalizeStatus(filters.status))
    .filter((row) => {
      if (!filters.tag) return true;
      return Array.isArray(row.tags) && row.tags.includes(filters.tag);
    })
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  if (filters.limit) {
    return rows.slice(-Number(filters.limit));
  }
  return rows;
}

function topAttempts(filters = {}, projectDir) {
  const limit = Number(filters.limit || 5);
  return listAttempts(filters, projectDir)
    .filter((row) => Number.isFinite(row.score))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    })
    .slice(0, limit);
}

function normalizeNote(input = {}) {
  const title = String(input.title || '').trim();
  const body = String(input.body || input.text || '').trim();
  return {
    id: input.id || makeId('note'),
    agent: String(input.agent || 'unknown'),
    kind: normalizeStatus(input.kind, 'insight'),
    title: title || body.slice(0, 72) || 'Untitled note',
    body,
    milestone: input.milestone || null,
    worktree: input.worktree || null,
    tags: normalizeTags(input.tags),
    createdAt: input.createdAt || new Date().toISOString(),
  };
}

function addNote(input = {}, projectDir) {
  ensureHub(projectDir);
  const record = normalizeNote(input);
  appendJsonLine(notesFile(projectDir), record);
  return record;
}

function listNotes(filters = {}, projectDir) {
  const rows = readJsonLines(notesFile(projectDir))
    .filter((row) => !filters.agent || row.agent === filters.agent)
    .filter((row) => !filters.kind || normalizeStatus(row.kind) === normalizeStatus(filters.kind))
    .filter((row) => !filters.milestone || row.milestone === filters.milestone)
    .filter((row) => {
      if (!filters.tag) return true;
      return Array.isArray(row.tags) && row.tags.includes(filters.tag);
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  if (filters.limit) {
    return rows.slice(0, Number(filters.limit));
  }
  return rows;
}

function recentScoredAttempts(attempts, window) {
  return attempts.filter((attempt) => Number.isFinite(attempt.score)).slice(-window);
}

function hasImprovement(attempts) {
  let best = Number.NEGATIVE_INFINITY;
  let improved = false;
  for (const attempt of attempts) {
    if (!Number.isFinite(attempt.score)) continue;
    if (attempt.score > best) {
      if (best !== Number.NEGATIVE_INFINITY) improved = true;
      best = attempt.score;
    }
  }
  return improved;
}

function heartbeatCheck(filters = {}, projectDir) {
  const config = readHeartbeatConfig(projectDir);
  const attempts = listAttempts({ agent: filters.agent }, projectDir);
  const triggered = [];

  for (const rule of config.rules || []) {
    if (rule.metric === 'no_improvement') {
      const recent = recentScoredAttempts(attempts, Number(rule.window || filters.window || 3));
      if (recent.length >= Number(rule.window || 3) && !hasImprovement(recent)) {
        triggered.push({
          id: rule.id,
          action: rule.action,
          prompt: rule.prompt,
          reason: `No score improvement across the last ${recent.length} scored attempts.`,
          attempts: recent.map((attempt) => attempt.id),
        });
      }
      continue;
    }

    if (rule.metric === 'consecutive_failures') {
      const window = Number(rule.window || 2);
      const recent = attempts.slice(-window);
      if (recent.length >= window && recent.every((attempt) => normalizeStatus(attempt.status) === 'failed')) {
        triggered.push({
          id: rule.id,
          action: rule.action,
          prompt: rule.prompt,
          reason: `The last ${recent.length} attempts were marked failed.`,
          attempts: recent.map((attempt) => attempt.id),
        });
      }
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    agent: filters.agent || null,
    totalAttempts: attempts.length,
    triggered,
  };
}

function limitEvents(events = []) {
  return events.slice(-20);
}

function readDelegation(id, projectDir) {
  if (!id) return null;
  const filePath = delegationFile(id, projectDir);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeDelegation(record, projectDir) {
  ensureHub(projectDir);
  atomicWrite(delegationFile(record.id, projectDir), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

function resolveDelegationId(input = {}) {
  const explicit = normalizeText(input.id || input.delegationId || input.delegation_id);
  if (explicit) return explicit;

  const prompt = normalizeText(input.prompt);
  const rawResult = normalizeText(input.rawResult || input.result || input.text);
  const embedded = parseDelegationIdFromText(prompt) || parseDelegationIdFromText(rawResult);
  if (embedded) return embedded;

  return makeDeterministicId(
    [
      input.agent || input.subagent_type || input.description || 'agent',
      input.mode || input.delegationMode || input.delegation_mode || '',
      input.run_in_background ? 'background' : 'foreground',
      prompt,
      rawResult,
    ],
    'delegation',
  );
}

function resolveDelegationMode(input = {}, existing = null) {
  return normalizeDelegationMode(
    input.mode ||
      input.delegationMode ||
      input.delegation_mode ||
      parseModeFromText(input.prompt || '') ||
      parseModeFromText(input.rawResult || input.result || '') ||
      (input.run_in_background ? 'async' : '') ||
      existing?.mode ||
      'sync',
    'sync',
  );
}

function startDelegation(input = {}, projectDir) {
  ensureHub(projectDir);
  const now = new Date().toISOString();
  const id = resolveDelegationId(input);
  const existing = readDelegation(id, projectDir);
  const prompt = normalizeText(input.prompt);
  const mode = resolveDelegationMode(input, existing);
  const status = normalizeDelegationStatus(
    input.status || existing?.status || (mode === 'async' ? 'running' : 'queued'),
  );
  const compactRules = mergeUniqueArrays(
    existing?.compactRules || [],
    normalizeTags(input.compactRules || input.compact_rules),
    parseCompactRuleIdsFromText(prompt),
  );
  const skillRefs = mergeUniqueArrays(existing?.skillRefs || [], normalizeTags(input.skillRefs || input.skill_refs));

  const record = {
    id,
    agent: normalizeText(input.agent || input.subagent_type || existing?.agent || 'unknown') || 'unknown',
    mode,
    status,
    description: normalizeText(input.description || existing?.description),
    summary: normalizeText(existing?.summary || input.summary || input.description),
    artifacts: Array.isArray(existing?.artifacts) ? existing.artifacts : [],
    compactRules,
    skillRefs,
    promptPreview: prompt ? prompt.slice(0, 500) : existing?.promptPreview || '',
    promptPath: prompt ? delegationPromptFile(id, projectDir) : existing?.promptPath || null,
    rawResultPath: existing?.rawResultPath || null,
    resultEnvelope: existing?.resultEnvelope || null,
    metadata: {
      ...(existing?.metadata && typeof existing.metadata === 'object' ? existing.metadata : {}),
      ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
    },
    createdAt: existing?.createdAt || now,
    startedAt: existing?.startedAt || now,
    completedAt: existing?.completedAt || null,
    updatedAt: now,
    events: limitEvents([
      ...(Array.isArray(existing?.events) ? existing.events : []),
      { type: 'started', at: now, status, mode },
    ]),
  };

  if (prompt) {
    atomicWrite(record.promptPath, `${prompt}\n`);
  }

  return writeDelegation(record, projectDir);
}

function completeDelegation(input = {}, projectDir) {
  ensureHub(projectDir);
  const now = new Date().toISOString();
  const id = resolveDelegationId(input);
  const existing = readDelegation(id, projectDir);
  const prompt = normalizeText(input.prompt);
  const rawResult = normalizeText(input.rawResult || input.result || input.text);
  const mode = resolveDelegationMode(input, existing);
  const envelope = normalizeResultEnvelope({
    rawResult,
    status: input.status || input.resultStatus,
    summary: input.summary,
    details: input.details,
    artifacts: input.artifacts,
    risks: input.risks,
    followUps: input.followUps || input.follow_ups,
    evidence: input.evidence,
    compactRules: mergeUniqueArrays(
      normalizeTags(input.compactRules || input.compact_rules),
      parseCompactRuleIdsFromText(prompt),
    ),
  });
  const status = normalizeDelegationStatus(
    input.status || envelope.status || existing?.status || 'completed',
    'completed',
  );
  const compactRules = mergeUniqueArrays(
    existing?.compactRules || [],
    envelope.compactRules || [],
    normalizeTags(input.compactRules || input.compact_rules),
    parseCompactRuleIdsFromText(prompt),
  );
  const skillRefs = mergeUniqueArrays(existing?.skillRefs || [], normalizeTags(input.skillRefs || input.skill_refs));

  const record = {
    id,
    agent: normalizeText(input.agent || input.subagent_type || existing?.agent || 'unknown') || 'unknown',
    mode,
    status,
    description: normalizeText(input.description || existing?.description),
    summary: envelope.summary || normalizeText(existing?.summary || input.description),
    artifacts: envelope.artifacts,
    compactRules,
    skillRefs,
    promptPreview: prompt ? prompt.slice(0, 500) : existing?.promptPreview || '',
    promptPath: prompt ? delegationPromptFile(id, projectDir) : existing?.promptPath || null,
    rawResultPath: rawResult ? delegationResultFile(id, projectDir) : existing?.rawResultPath || null,
    resultEnvelope: envelope,
    metadata: {
      ...(existing?.metadata && typeof existing.metadata === 'object' ? existing.metadata : {}),
      ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
    },
    createdAt: existing?.createdAt || now,
    startedAt: existing?.startedAt || now,
    completedAt: ['completed', 'failed', 'partial', 'canceled'].includes(status) ? now : existing?.completedAt || null,
    updatedAt: now,
    events: limitEvents([
      ...(Array.isArray(existing?.events) ? existing.events : []),
      { type: 'completed', at: now, status, rawFormat: envelope.rawFormat },
    ]),
  };

  if (prompt) {
    atomicWrite(record.promptPath, `${prompt}\n`);
  }
  if (rawResult) {
    atomicWrite(record.rawResultPath, `${rawResult}\n`);
  }

  return writeDelegation(record, projectDir);
}

function listDelegations(filters = {}, projectDir) {
  ensureHub(projectDir);
  return fs
    .readdirSync(delegationsDir(projectDir), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(delegationsDir(projectDir), entry.name), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((row) => !filters.agent || row.agent === filters.agent)
    .filter((row) => !filters.mode || row.mode === normalizeDelegationMode(filters.mode, filters.mode))
    .filter((row) => !filters.status || row.status === normalizeDelegationStatus(filters.status, filters.status))
    .filter((row) => {
      if (!filters.compactRule) return true;
      return Array.isArray(row.compactRules) && row.compactRules.includes(filters.compactRule);
    })
    .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())
    .slice(0, filters.limit ? Number(filters.limit) : undefined);
}

function resolveCompactRuleEntries(ids, projectDir) {
  const registry = readCompactRules(projectDir);
  const wanted = normalizeTags(ids);
  if (wanted.length === 0) return registry.rules || [];
  const byId = new Map((registry.rules || []).map((rule) => [rule.id, rule]));
  return wanted.map((id) => byId.get(id)).filter(Boolean);
}

function renderCompactRules(ids, projectDir) {
  const rules = resolveCompactRuleEntries(ids, projectDir);
  if (rules.length === 0) return '';

  return [
    `<compact-rules ids="${rules.map((rule) => rule.id).join(',')}">`,
    ...rules.map((rule) => `[${rule.id}] ${rule.text}`),
    '</compact-rules>',
  ].join('\n');
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        index++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function parseJsonOption(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err.message}`);
  }
}

function readTextOption(text, filePath) {
  if (filePath) {
    return fs.readFileSync(path.resolve(filePath), 'utf8');
  }
  return text || '';
}

function printUsage() {
  console.log(`
  CoBolt Agent Hub

  Usage:
    node tools/cobolt-agent-hub.js attempt add --agent <id> [--score <n>] --summary <text>
    node tools/cobolt-agent-hub.js attempt top [--agent <id>] [--n <count>] [--json]
    node tools/cobolt-agent-hub.js note add --agent <id> --kind <kind> --title <text> --body <text>
    node tools/cobolt-agent-hub.js note list [--kind <kind>] [--n <count>] [--json]
    node tools/cobolt-agent-hub.js delegation start --id <delegation-id> --agent <agent> [--mode async|sync] [--prompt <text>]
    node tools/cobolt-agent-hub.js delegation complete --id <delegation-id> [--result <text> | --result-file <path>] [--json]
    node tools/cobolt-agent-hub.js delegation get --id <delegation-id> [--json]
    node tools/cobolt-agent-hub.js delegation list [--agent <id>] [--mode async|sync] [--status completed] [--json]
    node tools/cobolt-agent-hub.js compact-rules show [--json]
    node tools/cobolt-agent-hub.js compact-rules render --ids delegation-id,result-envelope
    node tools/cobolt-agent-hub.js heartbeat show [--json]
    node tools/cobolt-agent-hub.js heartbeat check --agent <id> [--json]
`);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printAttemptRows(rows) {
  if (rows.length === 0) {
    console.log('No attempts recorded.');
    return;
  }
  for (const row of rows) {
    const score = Number.isFinite(row.score) ? row.score : 'n/a';
    console.log(`${row.agent}  score=${score}  status=${row.status}  ${row.summary || row.id}`);
  }
}

function printNoteRows(rows) {
  if (rows.length === 0) {
    console.log('No notes recorded.');
    return;
  }
  for (const row of rows) {
    console.log(`${row.kind}  ${row.agent}  ${row.title}`);
    if (row.body) console.log(`  ${row.body}`);
  }
}

function printDelegationRows(rows) {
  if (rows.length === 0) {
    console.log('No delegations recorded.');
    return;
  }

  for (const row of rows) {
    console.log(
      `${row.id}  agent=${row.agent}  mode=${row.mode}  status=${row.status}  ${row.summary || row.description || ''}`.trim(),
    );
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const [section, action] = args._;

  if (!section || section === 'help' || section === '--help' || section === '-h') {
    printUsage();
    process.exit(0);
  }

  try {
    if (section === 'attempt' && action === 'add') {
      const record = addAttempt(
        {
          agent: args.agent,
          score: args.score,
          status: args.status,
          summary: args.summary || args.message,
          milestone: args.milestone,
          worktree: args.worktree,
          branch: args.branch,
          commit: args.commit,
          tags: args.tags,
          meta: parseJsonOption(args.meta),
        },
        process.cwd(),
      );
      if (args.json) return printJson(record);
      console.log(`Recorded attempt ${record.id} for ${record.agent}.`);
      return;
    }

    if (section === 'attempt' && (action === 'top' || action === 'list')) {
      const filters = {
        agent: args.agent,
        milestone: args.milestone,
        status: args.status,
        tag: args.tag,
        limit: args.n || args.limit,
      };
      const rows = action === 'top' ? topAttempts(filters, process.cwd()) : listAttempts(filters, process.cwd());
      if (args.json) return printJson(rows);
      printAttemptRows(rows);
      return;
    }

    if (section === 'note' && action === 'add') {
      const record = addNote(
        {
          agent: args.agent,
          kind: args.kind,
          title: args.title,
          body: args.body || args.text,
          milestone: args.milestone,
          worktree: args.worktree,
          tags: args.tags,
        },
        process.cwd(),
      );
      if (args.json) return printJson(record);
      console.log(`Recorded note ${record.id} for ${record.agent}.`);
      return;
    }

    if (section === 'note' && action === 'list') {
      const rows = listNotes(
        {
          agent: args.agent,
          kind: args.kind,
          milestone: args.milestone,
          tag: args.tag,
          limit: args.n || args.limit,
        },
        process.cwd(),
      );
      if (args.json) return printJson(rows);
      printNoteRows(rows);
      return;
    }

    if (section === 'delegation' && action === 'start') {
      const record = startDelegation(
        {
          id: args.id,
          agent: args.agent,
          subagent_type: args.agent,
          mode: args.mode,
          delegation_mode: args.mode,
          status: args.status,
          description: args.description,
          prompt: readTextOption(args.prompt, args['prompt-file']),
          compactRules: args.ids || args['compact-rules'],
          metadata: parseJsonOption(args.meta),
        },
        process.cwd(),
      );
      if (args.json) return printJson(record);
      console.log(`Recorded delegation ${record.id} (${record.mode}, ${record.status}).`);
      return;
    }

    if (section === 'delegation' && action === 'complete') {
      const record = completeDelegation(
        {
          id: args.id,
          agent: args.agent,
          subagent_type: args.agent,
          mode: args.mode,
          delegation_mode: args.mode,
          status: args.status,
          description: args.description,
          prompt: readTextOption(args.prompt, args['prompt-file']),
          rawResult: readTextOption(args.result, args['result-file']),
          compactRules: args.ids || args['compact-rules'],
          metadata: parseJsonOption(args.meta),
        },
        process.cwd(),
      );
      if (args.json) return printJson(record);
      console.log(`Completed delegation ${record.id} (${record.status}).`);
      return;
    }

    if (section === 'delegation' && (action === 'get' || action === 'show')) {
      const record = readDelegation(args.id, process.cwd());
      if (!record) {
        console.error(`Unknown delegation id: ${args.id}`);
        process.exit(1);
      }
      if (args.json) return printJson(record);
      printDelegationRows([record]);
      return;
    }

    if (section === 'delegation' && action === 'list') {
      const rows = listDelegations(
        {
          agent: args.agent,
          mode: args.mode,
          status: args.status,
          compactRule: args['compact-rule'],
          limit: args.n || args.limit,
        },
        process.cwd(),
      );
      if (args.json) return printJson(rows);
      printDelegationRows(rows);
      return;
    }

    if (section === 'compact-rules' && (action === 'show' || action === 'list')) {
      const registry = readCompactRules(process.cwd());
      if (args.json) return printJson(registry);
      for (const rule of registry.rules || []) {
        console.log(`${rule.id}: ${rule.summary}`);
      }
      return;
    }

    if (section === 'compact-rules' && action === 'render') {
      const rendered = renderCompactRules(args.ids || args.id || args.rules, process.cwd());
      if (args.json) return printJson({ rendered });
      process.stdout.write(`${rendered}\n`);
      return;
    }

    if (section === 'heartbeat' && action === 'show') {
      const config = readHeartbeatConfig(process.cwd());
      if (args.json) return printJson(config);
      for (const rule of config.rules || []) {
        console.log(`${rule.id}: ${rule.metric} -> ${rule.action} after ${rule.window} attempts`);
      }
      return;
    }

    if (section === 'heartbeat' && action === 'check') {
      const result = heartbeatCheck(
        {
          agent: args.agent,
          window: args.window,
        },
        process.cwd(),
      );
      if (args.json || result.triggered.length === 0) return printJson(result);
      for (const item of result.triggered) {
        console.log(`${item.action}: ${item.reason}`);
        console.log(`  ${item.prompt}`);
      }
      return;
    }

    console.error(`Unknown command: ${[section, action].filter(Boolean).join(' ')}`);
    printUsage();
    process.exit(1);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = {
  DEFAULT_SHARED_LINK_NAME,
  DEFAULT_COMPACT_RULES,
  hubDir,
  delegationsDir,
  attemptsFile,
  notesFile,
  heartbeatFile,
  compactRulesFile,
  delegationFile,
  delegationPromptFile,
  delegationResultFile,
  defaultHeartbeatConfig,
  defaultCompactRulesConfig,
  readHeartbeatConfig,
  writeHeartbeatConfig,
  readCompactRules,
  writeCompactRules,
  resolveCompactRuleEntries,
  renderCompactRules,
  addAttempt,
  listAttempts,
  topAttempts,
  addNote,
  listNotes,
  heartbeatCheck,
  startDelegation,
  completeDelegation,
  readDelegation,
  listDelegations,
  normalizeResultEnvelope,
  parseWorkerResultBlock,
  _testOnly: {
    ensureHub,
    seedHeartbeat,
    seedCompactRules,
    parseArgs,
    hasImprovement,
    parseCompactRuleIdsFromText,
    parseDelegationIdFromText,
    parseModeFromText,
    normalizeDelegationMode,
    normalizeDelegationStatus,
    normalizeEnvelopeStatus,
    extractLikelyArtifacts,
  },
};

if (require.main === module) {
  main();
}
