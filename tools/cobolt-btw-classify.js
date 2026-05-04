#!/usr/bin/env node

// cobolt-btw-classify — deterministic intent classifier for /cobolt-btw.
//
// Takes a free-form utterance plus optional flags and returns a structured
// request object conforming to source/schemas/btw-request.schema.json.
//
// Usage:
//   node tools/cobolt-btw-classify.js classify "what's the state of M1?"
//   node tools/cobolt-btw-classify.js classify --mode note --about auth "remember X"
//   node tools/cobolt-btw-classify.js classify --json "what next?"
//
// Design notes:
//   - Deterministic keyword + regex scoring. No LLM calls.
//   - Flags win over heuristics. `--mode <m>` forces mode; `--about <t>` forces target.
//   - Below 0.5 confidence the mode is reported as "ambiguous" so the skill
//     asks exactly one clarifying question before proceeding (invariant 9:
//     inject context, don't instruct).

const crypto = require('node:crypto');

const MODES = Object.freeze(['hint', 'query', 'suggest', 'note']);

const KEYWORDS = Object.freeze({
  hint: [
    /\bwhat should i know\b/i,
    /\bany gotchas?\b/i,
    /\bhint\b/i,
    /\bheads?\s*up\b/i,
    /\bremind me\b/i,
    /\btell me about\b/i,
    /\bexplain\b/i,
    /\bcontext (for|about)\b/i,
  ],
  query: [
    /\bwhat(?:'s| is) the (?:state|status)\b/i,
    /\bwhere are we\b/i,
    /\bwhere do we stand\b/i,
    /\bis\s+\S+\s+(?:done|ready|complete|finished|blocked|failing)\b/i,
    /\bhas\s+\S+\s+(?:shipped|deployed|merged)\b/i,
    /\bdid\s+\S+\s+(?:pass|fail|run)\b/i,
    /\bhow many\b/i,
    /\bhow far (?:along|are we)\b/i,
    /\bstatus of\b/i,
    /\bprogress on\b/i,
    /\bshow me\b/i,
    /\blist\b/i,
  ],
  suggest: [
    /\bwhat (?:should|do|could) (?:i|we) do\b/i,
    /\bwhat(?:'s| is) next\b/i,
    /\bwhat next\b/i,
    /\bsuggest\b/i,
    /\brecommend\b/i,
    /\bbest (?:move|option|path)\b/i,
    /\bshould i\b/i,
    /\bpropose\b/i,
    /\bwhich (?:one|option|path)\b/i,
    /\bnext (?:step|move|action)\b/i,
  ],
  note: [
    /^btw[,\s]/i,
    /^fyi[,\s]/i,
    /\bremember (?:that|this|to)\b/i,
    /\btake note\b/i,
    /\bnote that\b/i,
    /\bjot (?:this|that) down\b/i,
    /\bfor the record\b/i,
    /\bmake a note\b/i,
    /\bsave (?:this|that) (?:to|in) memory\b/i,
  ],
});

// Short utterance patterns that strongly bias to `suggest` when the phrase is
// tiny (e.g. "what now?", "next?"). These fire only when the utterance length
// is below 6 words to avoid false positives on long sentences.
const SHORT_SUGGEST = [/^what now\??$/i, /^next\??$/i, /^now what\??$/i, /^help\??$/i];

// Target-extraction regexes applied in order. First match wins.
const TARGET_PATTERNS = Object.freeze([
  { kind: 'milestone', re: /\b[Mm](\d{1,3})\b/, transform: (m) => `M${m[1]}` },
  { kind: 'feature', re: /\b(FEAT-\d{3,})\b/i, transform: (m) => m[1].toUpperCase() },
  { kind: 'feature', re: /\b(FR-\d{3,})\b/i, transform: (m) => m[1].toUpperCase() },
  { kind: 'feature', re: /\b(NFR-\d{3,})\b/i, transform: (m) => m[1].toUpperCase() },
  { kind: 'file', re: /(\S+\.(?:js|mjs|ts|tsx|jsx|ex|exs|md|json|yaml|yml))/, transform: (m) => m[1] },
  { kind: 'pipeline', re: /\b(build|review|fix|plan|deploy|release|audit)\b/i, transform: (m) => m[1].toLowerCase() },
]);

function parseFlags(argv) {
  const flags = { modeOverride: null, forceTarget: null, json: false };
  const positional = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--mode') {
      const val = argv[i + 1];
      if (MODES.includes(val)) flags.modeOverride = val;
      else throw new Error(`--mode must be one of ${MODES.join('|')}`);
      i += 2;
      continue;
    }
    if (arg === '--about') {
      const val = argv[i + 1];
      if (!val) throw new Error('--about requires a value');
      flags.forceTarget = String(val).slice(0, 256);
      i += 2;
      continue;
    }
    if (arg === '--json') {
      flags.json = true;
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    positional.push(arg);
    i += 1;
  }
  return { flags, positional };
}

function wordCount(s) {
  return String(s || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function scoreMode(utterance) {
  const scores = { hint: 0, query: 0, suggest: 0, note: 0 };
  const matches = { hint: [], query: [], suggest: [], note: [] };
  for (const mode of MODES) {
    for (const pattern of KEYWORDS[mode]) {
      if (pattern.test(utterance)) {
        scores[mode] += 1;
        matches[mode].push(pattern.source);
      }
    }
  }
  if (wordCount(utterance) < 6) {
    for (const pattern of SHORT_SUGGEST) {
      if (pattern.test(utterance)) {
        scores.suggest += 2;
        matches.suggest.push(`short:${pattern.source}`);
      }
    }
  }
  return { scores, matches };
}

function extractTarget(utterance) {
  for (const { kind, re, transform } of TARGET_PATTERNS) {
    const m = utterance.match(re);
    if (m) {
      return { kind, value: transform(m), resolvedFrom: 'utterance' };
    }
  }
  return null;
}

function classifyUtterance(rawUtterance, flags = {}) {
  const utterance = String(rawUtterance || '').trim();
  if (!utterance) {
    throw new Error('cobolt-btw-classify: utterance is required');
  }
  if (utterance.length > 2000) {
    throw new Error('cobolt-btw-classify: utterance exceeds 2000 chars');
  }

  const { scores, matches } = scoreMode(utterance);
  const totalMatches = scores.hint + scores.query + scores.suggest + scores.note;

  let mode;
  let confidence;

  if (flags.modeOverride) {
    mode = flags.modeOverride;
    confidence = 1;
  } else if (totalMatches === 0) {
    mode = 'hint';
    confidence = 0.3;
  } else {
    const sorted = MODES.slice().sort((a, b) => scores[b] - scores[a]);
    const top = sorted[0];
    const runnerUp = sorted[1];
    const margin = scores[top] - scores[runnerUp];
    confidence = Math.min(1, 0.5 + 0.15 * scores[top] + 0.1 * margin);
    mode = top;
  }

  if (confidence < 0.5 && !flags.modeOverride) {
    mode = 'ambiguous';
  }

  let target = null;
  if (flags.forceTarget) {
    target = { kind: 'topic', value: flags.forceTarget, resolvedFrom: 'flag' };
  } else {
    target = extractTarget(utterance);
  }

  const requestId = `btw-${crypto.randomBytes(6).toString('hex')}`;

  return {
    version: '1.0.0',
    requestId,
    utterance,
    mode,
    target,
    confidence: Number(confidence.toFixed(3)),
    flags: {
      modeOverride: flags.modeOverride || null,
      forceTarget: flags.forceTarget || null,
      json: Boolean(flags.json),
    },
    signals: {
      scores,
      matches,
      wordCount: wordCount(utterance),
    },
    timestamp: new Date().toISOString(),
  };
}

function printHelp() {
  console.log('cobolt-btw-classify — classify a /cobolt-btw utterance');
  console.log('');
  console.log('Usage:');
  console.log('  node tools/cobolt-btw-classify.js classify [--mode <m>] [--about <t>] [--json] "<utterance>"');
  console.log('');
  console.log('Modes: hint | query | suggest | note');
}

function runCli(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
    return 0;
  }

  const [subcommand, ...rest] = argv;
  if (subcommand !== 'classify') {
    console.error(`Unknown subcommand: ${subcommand}`);
    printHelp();
    return 1;
  }

  let parsed;
  try {
    parsed = parseFlags(rest);
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  if (parsed.flags.help) {
    printHelp();
    return 0;
  }

  const utterance = parsed.positional.join(' ').trim();
  if (!utterance) {
    console.error('utterance is required');
    return 1;
  }

  let result;
  try {
    result = classifyUtterance(utterance, parsed.flags);
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  if (parsed.flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const tgt = result.target ? `${result.target.kind}:${result.target.value}` : 'none';
    console.log(`mode=${result.mode} confidence=${result.confidence} target=${tgt}`);
  }
  return 0;
}

module.exports = {
  MODES,
  classifyUtterance,
  parseFlags,
  runCli,
};

if (require.main === module) {
  const code = runCli(process.argv.slice(2));
  process.exit(code || 0);
}
