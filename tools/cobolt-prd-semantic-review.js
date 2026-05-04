#!/usr/bin/env node
// Actual LLM semantic pass on PRD. Companion to tools/cobolt-prd-execute.js
// (which does lexical n-gram detection). Wire via:
//   node tools/cobolt-prd-execute.js --llm-hook tools/cobolt-prd-semantic-review.js
//
// Contract (matches Team H's --llm-hook spec):
//   argv[2] = prdPath, argv[3] = outputPath
//   Must write JSON to outputPath: { contradictions: [...], confidence: "high"|"low", skipped?: "..." }
//
// Exit-code contract (per tools/CLAUDE.md):
//   0 = success (model run completed and wrote a parseable result)
//   1 = hard error (missing/empty PRD, unparseable model output, API failure, misuse)
//   2 = missing optional dependency (no LLM SDK installed or no API key)
//   3 = missing infrastructure (network unreachable)
//
// Uses @anthropic-ai/sdk when available. Falls back to OpenAI SDK. When the
// optional dep is absent, exits 2 so Tier 2 gates degrade the milestone grade
// instead of recording a false green.
//
// Prompt-caching enabled: PRD is placed in a cached user content block so
// re-runs during iterative development hit the cache (5-minute TTL) and cost
// a fraction of the first call.

const fs = require('node:fs');
const path = require('node:path');

const { resolveApiModel } = require('../lib/cobolt-api-model');

function printHelp() {
  console.log(`Usage: node ${path.basename(__filename)} <prdPath> <outputPath>

Runs a semantic LLM pass over a PRD and writes contradictions to outputPath.

Args:
  <prdPath>     Path to PRD markdown
  <outputPath>  Path for JSON result (will be created)

Flags:
  --help, -h    Show this help and exit

Exit codes:
  0  Success (result written)
  1  Hard error (missing/empty PRD, unparseable output, API failure)
  2  Missing optional dependency (no SDK installed, no API key)
  3  Missing infrastructure (network unreachable)
`);
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  printHelp();
  process.exit(0);
}

const prdPath = argv[0];
const outPath = argv[1];

if (!prdPath || !outPath) {
  console.error('Usage: cobolt-prd-semantic-review <prdPath> <outputPath>');
  process.exit(1);
}

function writeJson(payload) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
}

function writeSkipped(reason, exitCode) {
  writeJson({
    contradictions: [],
    confidence: 'low',
    skipped: reason,
    ts: new Date().toISOString(),
  });
  process.exit(exitCode);
}

function writeResult(contradictions, confidence, meta = {}) {
  writeJson({
    contradictions,
    confidence,
    ts: new Date().toISOString(),
    ...meta,
  });
  process.exit(0);
}

if (!fs.existsSync(prdPath)) {
  console.error(`PRD not found at ${prdPath}`);
  writeSkipped(`PRD not found at ${prdPath}`, 1);
}
const prd = fs.readFileSync(prdPath, 'utf8');
if (!prd.trim()) {
  console.error('PRD is empty');
  writeSkipped('PRD is empty', 1);
}

const SYSTEM = `You are a senior product/engineering reviewer performing semantic consistency analysis of a Product Requirements Document.

Your job: find REAL contradictions — cases where two requirements cannot both be satisfied under the same conditions. Ignore stylistic inconsistency, vague wording, or missing details. Only flag logical contradictions.

Return ONLY a JSON object matching this schema, no prose:
{
  "contradictions": [
    { "a": "FR-NNN", "b": "FR-MMM", "overlap": "short description of the conflicting condition",
      "verbs": ["must", "must not"], "explanation": "one sentence on why they clash" }
  ],
  "confidence": "high" | "medium" | "low"
}

Rules:
- Only cite FR-NNN IDs that literally appear in the PRD.
- If the PRD is well-formed with no real contradictions, return an empty array with confidence "high".
- If the PRD is too vague to judge, return empty array with confidence "low".
- Do not invent contradictions to fill the array.`;

function tryAnthropic() {
  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch {
    return null;
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { skip: 'ANTHROPIC_API_KEY not set' };
  const model = resolveApiModel(process.env.COBOLT_PRD_REVIEW_MODEL || 'opus');
  const client = new Anthropic.Anthropic({ apiKey: key });
  return { client, model, provider: 'anthropic' };
}

function tryOpenAI() {
  let OpenAI;
  try {
    OpenAI = require('openai');
  } catch {
    return null;
  }
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { skip: 'OPENAI_API_KEY not set' };
  const model = process.env.COBOLT_PRD_REVIEW_MODEL || 'gpt-5';
  const client = new OpenAI.OpenAI({ apiKey: key });
  return { client, model, provider: 'openai' };
}

async function callAnthropic({ client, model }) {
  // Prompt caching on the system + PRD block. The `cache_control` marker tells
  // the API to cache everything up to and including that block.
  const resp = await client.messages.create({
    model,
    max_tokens: 2000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `PRD follows. Analyze for semantic contradictions.\n\n---\n${prd}\n---`,
            cache_control: { type: 'ephemeral' },
          },
          { type: 'text', text: 'Return the JSON now.' },
        ],
      },
    ],
  });
  const text = (resp.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return { text, usage: resp.usage };
}

async function callOpenAI({ client, model }) {
  const resp = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `PRD follows.\n\n---\n${prd}\n---\n\nReturn the JSON now.` },
    ],
    response_format: { type: 'json_object' },
  });
  const text = resp.choices?.[0]?.message?.content || '';
  return { text, usage: resp.usage };
}

function parseJSONLoose(text) {
  if (!text) return null;
  // Some models wrap in ```json ... ```
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  // Trim to first { ... last }
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try {
    return JSON.parse(candidate.slice(first, last + 1));
  } catch {
    return null;
  }
}

function isNetworkError(err) {
  const code = err?.code || err?.cause?.code;
  if (!code) return false;
  return ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'ECONNRESET'].includes(code);
}

(async () => {
  const anth = tryAnthropic();
  const oai = tryOpenAI();
  const picked = anth?.client ? anth : oai?.client ? oai : null;
  if (!picked) {
    const reasons = [];
    if (!anth) reasons.push('no @anthropic-ai/sdk');
    else if (anth.skip) reasons.push(anth.skip);
    if (!oai) reasons.push('no openai sdk');
    else if (oai.skip) reasons.push(oai.skip);
    const reason = `No LLM provider available: ${reasons.join('; ')}`;
    console.error(reason);
    writeSkipped(reason, 2);
  }

  try {
    const { text, usage } = picked.provider === 'anthropic' ? await callAnthropic(picked) : await callOpenAI(picked);

    const parsed = parseJSONLoose(text);
    if (!parsed || !Array.isArray(parsed.contradictions)) {
      const reason = `model returned unparseable output (provider=${picked.provider})`;
      console.error(reason);
      writeSkipped(reason, 1);
    }
    const valid = (id) => typeof id === 'string' && /^FR-\d+/i.test(id);
    const contradictions = parsed.contradictions.filter((c) => valid(c.a) && valid(c.b));

    writeResult(contradictions, parsed.confidence || 'medium', {
      provider: picked.provider,
      model: picked.model,
      usage: usage || null,
      raw_length: (text || '').length,
    });
  } catch (e) {
    const reason = `LLM call failed (${picked.provider}): ${e.message || e}`;
    console.error(reason);
    writeSkipped(reason, isNetworkError(e) ? 3 : 1);
  }
})();
