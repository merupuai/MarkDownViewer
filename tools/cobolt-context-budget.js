#!/usr/bin/env node

// CoBolt Context Budget - deterministic prompt/context fan-out guard.

const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const OPENAI_TOKEN_COUNT_ENDPOINT = 'https://api.openai.com/v1/responses/input_tokens';

const DEFAULT_MANIFEST = {
  version: '1.0.0',
  defaults: {
    maxPromptChars: 40000,
    maxPromptTokens: 10000,
    tokenCountingBackend: 'local',
    requiresContextPacketAboveChars: 50000,
    allowedLargeContextMode: 'path-reference-only',
    forbiddenFanoutDocuments: ['prd.md', 'feature-prd.md', 'source-document-consolidation.md', 'codebase-research.md'],
    acceptedPacketPatterns: [
      'context-packets/',
      'planning-context.json',
      'cobolt-planning-context.js',
      'cobolt-context.js packet',
    ],
  },
  skills: {},
  agents: {},
};

function readJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function loadContextBudgetManifest(projectRoot = process.cwd(), explicitPath = null) {
  const candidates = [
    explicitPath,
    path.join(projectRoot, 'cobolt.context-budget.json'),
    path.join(projectRoot, 'source', 'templates', 'context-budget-manifest.json'),
    path.join(__dirname, '..', 'source', 'templates', 'context-budget-manifest.json'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const parsed = readJson(candidate);
    if (parsed?.defaults) {
      return {
        path: candidate,
        manifest: parsed,
      };
    }
  }

  return { path: null, manifest: DEFAULT_MANIFEST };
}

function mergeRule(defaults, override) {
  return {
    ...(defaults || {}),
    ...(override || {}),
    forbiddenFanoutDocuments: [
      ...new Set([...(defaults?.forbiddenFanoutDocuments || []), ...(override?.forbiddenFanoutDocuments || [])]),
    ],
    acceptedPacketPatterns: [
      ...new Set([...(defaults?.acceptedPacketPatterns || []), ...(override?.acceptedPacketPatterns || [])]),
    ],
  };
}

function resolveBudgetRule(manifest, { skill, agent } = {}) {
  const defaults = manifest?.defaults || DEFAULT_MANIFEST.defaults;
  const skillRule = skill ? manifest?.skills?.[skill] : null;
  const agentRule = agent ? manifest?.agents?.[agent] : null;
  return mergeRule(mergeRule(defaults, skillRule), agentRule);
}

function hasCompactContextReference(text, rule) {
  const haystack = String(text || '')
    .replaceAll('\\', '/')
    .toLowerCase();
  return (rule.acceptedPacketPatterns || DEFAULT_MANIFEST.defaults.acceptedPacketPatterns).some((pattern) =>
    haystack.includes(String(pattern).replaceAll('\\', '/').toLowerCase()),
  );
}

function estimateLocalTokens(text) {
  const bytes = Buffer.byteLength(String(text || ''), 'utf8');
  return Math.max(0, Math.ceil(bytes / 4));
}

function localTokenCount(input = {}) {
  return {
    backend: 'local',
    status: 'estimated',
    inputTokens: estimateLocalTokens(input.prompt || ''),
    model: input.model || null,
    source: 'bytes_div_4',
  };
}

function openAiTokenPayload(input = {}, options = {}) {
  return {
    model: input.model || options.model || process.env.COBOLT_OPENAI_TOKEN_COUNT_MODEL || 'gpt-5.3-codex',
    input: input.prompt || '',
  };
}

function postJson(urlString, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        method: 'POST',
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        port: url.port || 443,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            /* keep parsed null */
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const message = parsed?.error?.message || `HTTP ${res.statusCode}`;
            reject(new Error(message));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function parseOpenAiTokenCountResponse(response, model = null) {
  const inputTokens = Number(response?.input_tokens ?? response?.usage?.input_tokens ?? response?.tokens);
  if (!Number.isFinite(inputTokens)) {
    throw new Error('OpenAI token count response did not include input_tokens');
  }
  return {
    backend: 'openai',
    status: 'exact',
    inputTokens,
    model,
    object: response?.object || null,
  };
}

async function openAiTokenCount(input = {}, options = {}) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  const payload = openAiTokenPayload(input, options);
  const endpoint =
    options.openaiTokenCountEndpoint || process.env.COBOLT_OPENAI_TOKEN_COUNT_ENDPOINT || OPENAI_TOKEN_COUNT_ENDPOINT;
  const response = await postJson(endpoint, payload, {
    Authorization: `Bearer ${apiKey}`,
  });
  return parseOpenAiTokenCountResponse(response, payload.model);
}

function documentNameRegex(documentName) {
  const escaped = String(documentName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s"'\\(\\[/\\\\])${escaped}(?:$|[\\s"'\\)\\]\\\\])`, 'i');
}

function evaluatePromptBudget(input = {}, options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const { manifest, path: manifestPath } = loadContextBudgetManifest(projectRoot, options.manifestPath);
  const rule = resolveBudgetRule(manifest, input);
  const prompt = String(input.prompt || '');
  const promptChars = prompt.length;
  const tokenCount = localTokenCount(input);
  const hasPacket = hasCompactContextReference(prompt, rule);
  const issues = [];
  const warnings = [];

  if (promptChars > Number(rule.maxPromptChars || DEFAULT_MANIFEST.defaults.maxPromptChars) && !hasPacket) {
    issues.push(
      `Prompt has ${promptChars} characters, above maxPromptChars=${rule.maxPromptChars}; use a compact planning context packet.`,
    );
  }

  for (const documentName of rule.forbiddenFanoutDocuments || []) {
    if (documentNameRegex(documentName).test(prompt) && !hasPacket) {
      issues.push(`Prompt references fan-out document ${documentName} without a compact context packet.`);
    }
  }

  const documents = Array.isArray(input.documents) ? input.documents : [];
  for (const doc of documents) {
    const size = Number(doc.size || doc.chars || 0);
    const name = String(doc.name || doc.path || 'document');
    if (
      size > Number(rule.requiresContextPacketAboveChars || DEFAULT_MANIFEST.defaults.requiresContextPacketAboveChars)
    ) {
      if (!hasPacket) {
        issues.push(
          `${name} is ${size} characters, above requiresContextPacketAboveChars=${rule.requiresContextPacketAboveChars}; dispatch by path/slice packet.`,
        );
      } else {
        warnings.push(`${name} is large (${size} chars) but compact packet reference is present.`);
      }
    }
  }

  return {
    passed: issues.length === 0,
    issues,
    warnings,
    manifestPath,
    rule,
    summary: {
      skill: input.skill || null,
      agent: input.agent || null,
      promptChars,
      tokenCount,
      hasCompactContextReference: hasPacket,
    },
  };
}

function tokenBackend(input, options, rule) {
  return String(
    options.tokenBackend ||
      input.tokenBackend ||
      rule.tokenCountingBackend ||
      process.env.COBOLT_TOKEN_COUNT_BACKEND ||
      'local',
  ).toLowerCase();
}

function applyTokenCount(report, tokenCount, rule) {
  report.summary.tokenCount = tokenCount;
  const maxPromptTokens = Number(rule.maxPromptTokens || 0);
  if (maxPromptTokens > 0 && tokenCount.inputTokens > maxPromptTokens) {
    report.issues.push(
      `Prompt has ${tokenCount.inputTokens} input tokens, above maxPromptTokens=${maxPromptTokens}; use a compact context packet or path references.`,
    );
    report.passed = false;
  }
  return report;
}

async function evaluatePromptBudgetAsync(input = {}, options = {}) {
  const report = evaluatePromptBudget(input, options);
  const rule =
    report.rule ||
    resolveBudgetRule(
      loadContextBudgetManifest(options.projectRoot || process.cwd(), options.manifestPath).manifest,
      input,
    );
  const backend = tokenBackend(input, options, rule);

  if (backend === 'local') {
    return applyTokenCount(report, report.summary.tokenCount, rule);
  }

  if (backend === 'auto' && !process.env.OPENAI_API_KEY && !options.apiKey) {
    report.warnings.push('OpenAI token counting skipped because OPENAI_API_KEY is not set; using local estimate.');
    return applyTokenCount(report, report.summary.tokenCount, rule);
  }

  try {
    const tokenCount = await openAiTokenCount(input, options);
    return applyTokenCount(report, tokenCount, rule);
  } catch (err) {
    report.warnings.push(`OpenAI token counting unavailable (${err.message}); using local estimate.`);
    return applyTokenCount(report, report.summary.tokenCount, rule);
  }
}

function readPromptFromArgs(args) {
  const fileIndex = args.indexOf('--prompt-file');
  if (fileIndex !== -1) {
    const filePath = args[fileIndex + 1];
    return fs.readFileSync(filePath, 'utf8');
  }
  const promptIndex = args.indexOf('--prompt');
  if (promptIndex !== -1) return args[promptIndex + 1] || '';
  return '';
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'check';
  const json = argv.includes('--json');
  const skillIndex = argv.indexOf('--skill');
  const agentIndex = argv.indexOf('--agent');
  const manifestIndex = argv.indexOf('--manifest');
  const tokenBackendIndex = argv.indexOf('--token-backend');
  const modelIndex = argv.indexOf('--model');

  if (command !== 'check') {
    console.error(
      'Usage: node tools/cobolt-context-budget.js check --skill <skill> --prompt-file <file> [--token-backend local|openai|auto] [--model gpt-5.3-codex] [--json]',
    );
    process.exit(2);
  }

  return evaluatePromptBudgetAsync(
    {
      skill: skillIndex !== -1 ? argv[skillIndex + 1] : null,
      agent: agentIndex !== -1 ? argv[agentIndex + 1] : null,
      model: modelIndex !== -1 ? argv[modelIndex + 1] : null,
      prompt: readPromptFromArgs(argv),
    },
    {
      manifestPath: manifestIndex !== -1 ? argv[manifestIndex + 1] : null,
      tokenBackend: tokenBackendIndex !== -1 ? argv[tokenBackendIndex + 1] : null,
      model: modelIndex !== -1 ? argv[modelIndex + 1] : null,
    },
  ).then((report) => {
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else if (report.passed) {
      console.log('[cobolt-context-budget] Context budget passed.');
    } else {
      for (const issue of report.issues) console.error(`[cobolt-context-budget] ${issue}`);
    }

    process.exit(report.passed ? 0 : 1);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[cobolt-context-budget] ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_MANIFEST,
  OPENAI_TOKEN_COUNT_ENDPOINT,
  evaluatePromptBudget,
  evaluatePromptBudgetAsync,
  hasCompactContextReference,
  estimateLocalTokens,
  loadContextBudgetManifest,
  localTokenCount,
  parseOpenAiTokenCountResponse,
  resolveBudgetRule,
};
