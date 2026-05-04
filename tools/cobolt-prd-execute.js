#!/usr/bin/env node
// S8 - PRD consistency executor. Parses FRs into a state-machine DSL, runs N
// synthetic sessions, and flags contradictions (e.g. FR-A requires
// X.verified=true while FR-B permits X unverified for the same action).
//
// LIMITATION: This is a lexical heuristic. N-gram overlap between verb phrases
// produces frequent false positives - unrelated FRs that share common nouns
// ("user must be authenticated", "user must be notified") will be flagged.
// The output is advisory. Final PRD consistency requires human review or an
// LLM-aided semantic pass. Without --strict this tool always exits 0 and marks
// results with confidence: "low". With --strict it exits non-zero on any
// contradiction (useful for CI gating once a project has tuned the rules).
//
// --llm-hook <script> (OPTIONAL): after lexical contradiction detection, invoke
// `node <script> <prdPath> <outputPath>` as a pluggable LLM reviewer. The
// script must write JSON of the form `{contradictions: [...], confidence:
// "high"}` to <outputPath>. The result is merged into the final report;
// confidence upgrades from `low` to `high` when the LLM confirms.
//
// This is a hook point, not an implementation - projects wire their own LLM
// reviewer (e.g. a 20-line user script calling the Anthropic or OpenAI SDK).
// When the flag is absent, current behavior is unchanged.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function arg(argv, key, fallback) {
  const i = argv.indexOf(key);
  return i >= 0 ? argv[i + 1] : fallback;
}

function normalizeVerb(verb) {
  const lower = String(verb || '').toLowerCase();
  if (lower === 'shall') return 'must';
  if (lower === 'shall not') return 'must not';
  return lower;
}

function extractFrs(prd) {
  const frs = [];
  const seen = new Set();

  // Also accepts markdown heading format "### FR-N <sep> <title>\n<body...>".
  // v0.47 root-cause fix:
  // - inlineRe accepts optional bullet-list prefixes.
  // - verb regex accepts "shall" / "shall not".
  const inlineRe = /^(?:[-*+]\s+)?FR-(\d+):?\s*(.+)$/gm;
  const verbReInline = /\b(must not|must|shall not|shall|requires|forbids)\b\s+(.+?)(?:\s+when\s+(.+?))?\.?$/i;

  let match;
  while ((match = inlineRe.exec(prd)) !== null) {
    const id = `FR-${match[1]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const body = match[2].trim();
    const conds = [];
    const mustMatch = body.match(verbReInline);
    if (mustMatch) {
      conds.push({
        verb: normalizeVerb(mustMatch[1]),
        condition: mustMatch[2].trim(),
        trigger: (mustMatch[3] || '').trim(),
      });
    }
    frs.push({ id, body, conds });
  }

  const headingRe = /^#{1,6}\s+FR-(\d+)\b[^\n]*\n([\s\S]*?)(?=^\s*$|^#{1,6}\s|$(?![\s\S]))/gm;
  const verbReHeading = /\b(must not|must|shall not|shall|requires|forbids)\b\s+(.+?)(?:\s+when\s+(.+?))?\.?(\s|$)/i;
  while ((match = headingRe.exec(prd)) !== null) {
    const id = `FR-${match[1]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const body = match[2].replace(/\s+/g, ' ').trim();
    const conds = [];
    const mustMatch = body.match(verbReHeading);
    if (mustMatch) {
      conds.push({
        verb: normalizeVerb(mustMatch[1]),
        condition: mustMatch[2].trim(),
        trigger: (mustMatch[3] || '').trim(),
      });
    }
    frs.push({ id, body, conds });
  }

  return frs;
}

function detectContradictions(frs) {
  const opposites = { must: 'must not', 'must not': 'must', requires: 'forbids', forbids: 'requires' };
  const contradictions = [];

  for (let i = 0; i < frs.length; i++) {
    for (let j = i + 1; j < frs.length; j++) {
      const [a, b] = [frs[i], frs[j]];
      for (const ca of a.conds) {
        for (const cb of b.conds) {
          if (opposites[ca.verb] === cb.verb) {
            const overlap = firstNGramOverlap(ca.condition, cb.condition);
            if (overlap) contradictions.push({ a: a.id, b: b.id, overlap, verbs: [ca.verb, cb.verb] });
          }
        }
      }
    }
  }

  return contradictions;
}

function maybeRunLlmHook({ cwd, prdPath, llmHook, contradictions, confidence }) {
  let nextConfidence = confidence;
  let llmResult = null;
  let llmError = null;

  if (!llmHook) {
    return { contradictions, confidence: nextConfidence, llmResult, llmError };
  }

  try {
    const hookScript = path.isAbsolute(llmHook) ? llmHook : path.join(cwd, llmHook);
    if (!fs.existsSync(hookScript)) {
      llmError = `llm-hook script not found: ${hookScript}`;
    } else {
      const hookOut = path.join(cwd, '_cobolt-output', 'latest', 'planning', 'prd-llm-review.json');
      fs.mkdirSync(path.dirname(hookOut), { recursive: true });
      execFileSync(process.execPath, [hookScript, path.join(cwd, prdPath), hookOut], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120000,
      });
      if (fs.existsSync(hookOut)) {
        try {
          llmResult = JSON.parse(fs.readFileSync(hookOut, 'utf8'));
        } catch (error) {
          llmError = `llm-hook output unparseable: ${error.message}`;
        }
      } else {
        llmError = 'llm-hook produced no output file';
      }
    }
  } catch (error) {
    llmError = `llm-hook execution failed: ${error.message}`;
  }

  if (llmResult) {
    if (Array.isArray(llmResult.contradictions)) {
      for (const contradiction of llmResult.contradictions) {
        if (contradiction && typeof contradiction === 'object') {
          contradictions.push({ ...contradiction, source: 'llm' });
        }
      }
    }
    if (llmResult.confidence === 'high') nextConfidence = 'high';
    else if (llmResult.confidence === 'medium' && nextConfidence === 'low') nextConfidence = 'medium';
  }

  return { contradictions, confidence: nextConfidence, llmResult, llmError };
}

function writeOutputs({
  cwd,
  frs,
  contradictions,
  sessions,
  sessionFailures,
  confidence,
  strict,
  llmHook,
  llmResult,
  llmError,
}) {
  const out = path.join(cwd, '_cobolt-output', 'latest', 'planning', 'prd-consistency.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        ts: new Date().toISOString(),
        frs: frs.length,
        contradictions,
        syntheticSessions: sessions,
        sessionFailures,
        confidence,
        strict,
        llmHook: llmHook || null,
        llmResult: llmResult
          ? {
              contradictionCount: Array.isArray(llmResult.contradictions) ? llmResult.contradictions.length : 0,
              confidence: llmResult.confidence || null,
            }
          : null,
        llmError,
        note: 'Lexical heuristic - false positives expected. Human/LLM review required for final sign-off.',
      },
      null,
      2,
    ),
  );

  // Also emit the canonical FR registry artifact (`executable-prd.json`) in the
  // shape expected by cobolt-plan-complete-gate.checkFrCensus(),
  // cobolt-artifact-parity.js, and cobolt-self-audit-stub-pack.js.
  const executablePrdPath = path.join(cwd, '_cobolt-output', 'latest', 'planning', 'executable-prd.json');
  if (!fs.existsSync(executablePrdPath)) {
    fs.writeFileSync(
      executablePrdPath,
      JSON.stringify(
        {
          version: 1,
          generatedAt: new Date().toISOString(),
          source: 'cobolt-prd-execute',
          requirements: frs.map((fr) => ({
            id: fr.id,
            body: fr.body,
            conditions: fr.conds,
          })),
        },
        null,
        2,
      ),
    );
  }
}

function runConsistency(options = {}) {
  const cwd = options.cwd || process.cwd();
  const prdPath = options.prdPath || '_cobolt-output/latest/planning/prd.md';
  const sessions = Number(options.sessions || 100);
  const strict = options.strict === true;
  const llmHook = options.llmHook || null;

  let prd = '';
  try {
    prd = fs.readFileSync(path.join(cwd, prdPath), 'utf8');
  } catch {
    prd = '';
  }

  if (!prd) {
    return { ok: false, error: 'prd.md missing', exitCode: 1 };
  }

  const frs = extractFrs(prd);
  const contradictions = detectContradictions(frs);

  let sessionFailures = 0;
  for (let session = 0; session < sessions; session++) {
    const sample = shuffle(frs).slice(0, Math.min(5, frs.length));
    for (let i = 0; i < sample.length; i++) {
      for (let j = i + 1; j < sample.length; j++) {
        if (
          contradictions.some(
            (c) => (c.a === sample[i].id && c.b === sample[j].id) || (c.a === sample[j].id && c.b === sample[i].id),
          )
        ) {
          sessionFailures++;
        }
      }
    }
  }

  const llmState = maybeRunLlmHook({
    cwd,
    prdPath,
    llmHook,
    contradictions,
    confidence: strict ? 'medium' : 'low',
  });

  writeOutputs({
    cwd,
    frs,
    contradictions: llmState.contradictions,
    sessions,
    sessionFailures,
    confidence: llmState.confidence,
    strict,
    llmHook,
    llmResult: llmState.llmResult,
    llmError: llmState.llmError,
  });

  return {
    ok: true,
    strict,
    frsCount: frs.length,
    contradictionsCount: llmState.contradictions.length,
    sessionFailures,
    confidence: llmState.confidence,
    exitCode: strict && llmState.contradictions.length > 0 ? 1 : 0,
  };
}

function main(argv = process.argv) {
  const args = argv.slice(2);
  const result = runConsistency({
    cwd: process.cwd(),
    prdPath: arg(args, '--prd', '_cobolt-output/latest/planning/prd.md'),
    sessions: arg(args, '--sessions', '100'),
    strict: args.includes('--strict'),
    llmHook: arg(args, '--llm-hook', null),
  });

  if (!result.ok) {
    console.error(result.error);
    process.exit(result.exitCode);
  }

  console.log(
    `PRD consistency: ${result.contradictionsCount} contradictions across ${result.frsCount} FRs (${result.sessionFailures} session hits) [confidence=${result.confidence}${result.strict ? ', strict' : ', advisory'}]`,
  );
  process.exit(result.exitCode);
}

function firstNGramOverlap(x, y, n = 3) {
  const toks = (s) => s.toLowerCase().match(/[a-z0-9]+/g) || [];
  const a = toks(x);
  const b = toks(y);
  for (let i = 0; i <= a.length - n; i++) {
    const g = a.slice(i, i + n).join(' ');
    if (b.join(' ').includes(g)) return g;
  }
  return null;
}

function shuffle(a) {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

if (require.main === module) {
  main();
}

module.exports = {
  arg,
  normalizeVerb,
  extractFrs,
  detectContradictions,
  maybeRunLlmHook,
  writeOutputs,
  runConsistency,
  firstNGramOverlap,
  shuffle,
  main,
};
