#!/usr/bin/env node

// CoBolt Build Packet Relevance Ranker (P1.2 / v0.61+).
//
// Scores and trims the build packet so each milestone's frontend/backend/test
// agents receive only the sections most relevant to their FR scope, instead of
// the full ~1,200-line kitchen sink the legacy renderer produced. Honours
// Inv-9 ("inject context, don't instruct") by ALWAYS keeping load-bearing
// sections (security invariants, capability contracts) inline; ranks
// remaining sections by FR overlap + TF-IDF + capability-edge boost; trims
// long-tail sections to a one-paragraph summary when the token budget is
// reached.
//
// Deterministic — same inputs always produce the same packet. No LLM judge,
// no randomness. The ranker is the producer; the orchestrator (cobolt-build-
// setup-step) is the only consumer.
//
// Public API:
//   rankPacketSections({ sections, milestoneFRs, capabilityEdges, tokenBudget })
//     -> { selected, summarised, dropped, decisions }
//   applySectionBudget(sections, options)
//     -> { sections, totalEstimatedTokens, budget }
//
// CLI:
//   node tools/cobolt-build-packet-rank.js explain <manifest.json>
//   node tools/cobolt-build-packet-rank.js rank --in manifest.json --out ranked.json
//
// Exit codes (per tools/CLAUDE.md):
//   0 — success
//   1 — hard error (bad input, parse failure)

const fs = require('node:fs');
const path = require('node:path');

// ── Section-class weights (deterministic, configurable per-deployment) ──
// Higher weight = more likely to make the cut when budget is tight.
// Always-include sections override scoring; never dropped.
const ALWAYS_INCLUDE = new Set(['security-invariants', 'capability-contracts', 'milestone-execution-obligations']);

const SECTION_CLASS_WEIGHTS = {
  'security-invariants': 1.0,
  'capability-contracts': 1.0,
  'milestone-execution-obligations': 1.0,
  'wireframe-surfaces': 0.95, // post-v0.59 per-surface bodies
  'wireframe-cues': 0.55,
  'required-test-evidence': 0.85,
  'capability-edges': 0.85,
  'acceptance-examples': 0.8,
  'observability-budgets': 0.75,
  'compliance-grounding': 0.7,
  'performance-budget': 0.65,
  'plan-ingestion': 0.5,
  'domain-vocabulary': 0.4,
  'source-snapshot': 0.3,
  'planning-guidance': 0.45,
};

const DEFAULT_TOKEN_BUDGET = 8000;
const APPROX_TOKENS_PER_CHAR = 0.27; // conservative ≈ 4 chars/token average for English+code

function estimateTokens(text) {
  if (typeof text !== 'string') return 0;
  return Math.ceil(text.length * APPROX_TOKENS_PER_CHAR);
}

function frRefsIn(text) {
  if (typeof text !== 'string') return new Set();
  const matches = text.match(/\bFR-[A-Z0-9-]{1,12}\b/g) || [];
  return new Set(matches);
}

function classWeight(sectionId) {
  return SECTION_CLASS_WEIGHTS[sectionId] || 0.5;
}

// Lightweight TF-IDF over the section body vs the milestone-FR description
// corpus. Bag-of-words; lowercased; alphanumerics only. The corpus is
// typically 5-50 short FR descriptions, so a basic TF-IDF runs in <1ms.
function tfidf(sectionText, frDescriptions) {
  if (!sectionText || !Array.isArray(frDescriptions) || frDescriptions.length === 0) return 0;
  const tokens =
    String(sectionText)
      .toLowerCase()
      .match(/[a-z0-9]+/g) || [];
  if (tokens.length === 0) return 0;
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  const docs = frDescriptions.map(
    (d) =>
      new Set(
        String(d || '')
          .toLowerCase()
          .match(/[a-z0-9]+/g) || [],
      ),
  );
  let score = 0;
  for (const [term, count] of tf) {
    let dfCount = 0;
    for (const doc of docs) if (doc.has(term)) dfCount += 1;
    if (dfCount === 0) continue;
    const idf = Math.log(1 + (docs.length + 1) / (dfCount + 1));
    score += (count / tokens.length) * idf;
  }
  return score;
}

function scoreSection({ section, milestoneFRs, frDescriptions, capabilityEdgeSurfaces }) {
  const cls = classWeight(section.id);
  const text = String(section.content || '');

  const sectionFRs = frRefsIn(text);
  const milestoneFRsSet = new Set(milestoneFRs || []);
  let frOverlap = 0;
  for (const fr of sectionFRs) if (milestoneFRsSet.has(fr)) frOverlap += 1;
  const frScore = milestoneFRsSet.size > 0 ? frOverlap / milestoneFRsSet.size : 0;

  const tfidfScore = tfidf(text, frDescriptions || []);

  let edgeBoost = 0;
  if (capabilityEdgeSurfaces && capabilityEdgeSurfaces.size > 0) {
    for (const surfaceId of capabilityEdgeSurfaces) {
      if (text.includes(surfaceId)) {
        edgeBoost += 0.5;
        if (edgeBoost >= 2) break; // cap
      }
    }
  }

  // Composite — class is multiplicative (downweights low-priority classes
  // even when FR overlap is high); FR overlap dominates above class baseline.
  const raw = cls * (0.45 * frScore + 0.35 * tfidfScore + 0.2 * Math.min(edgeBoost, 2));
  return {
    raw,
    breakdown: {
      classWeight: cls,
      frOverlap,
      frScore,
      tfidfScore,
      edgeBoost,
    },
  };
}

function summariseSection(section, maxChars = 400) {
  const text = String(section.content || '');
  if (text.length <= maxChars) return text;
  // Take leading paragraph(s) up to maxChars, then ellipsis with path hint.
  const firstParaEnd = text.indexOf('\n\n');
  const head = firstParaEnd > 0 && firstParaEnd < maxChars ? text.slice(0, firstParaEnd) : text.slice(0, maxChars);
  return `${head.trim()}\n\n…[content trimmed; see ${section.sourcePath || section.id} for full text]`;
}

function rankPacketSections({
  sections,
  milestoneFRs = [],
  frDescriptions = [],
  capabilityEdges = [],
  tokenBudget = DEFAULT_TOKEN_BUDGET,
} = {}) {
  if (!Array.isArray(sections)) {
    throw new Error('rankPacketSections: sections must be an array');
  }
  // Prepare derived inputs.
  const capabilityEdgeSurfaces = new Set();
  for (const edge of capabilityEdges || []) {
    if (typeof edge === 'string') capabilityEdgeSurfaces.add(edge);
    else if (edge?.surface) capabilityEdgeSurfaces.add(edge.surface);
  }

  // Score each section (deterministic).
  const scored = sections.map((section) => {
    const score = scoreSection({
      section,
      milestoneFRs,
      frDescriptions,
      capabilityEdgeSurfaces,
    });
    return {
      section,
      score: score.raw,
      breakdown: score.breakdown,
      tokens: estimateTokens(section.content || ''),
      alwaysInclude: ALWAYS_INCLUDE.has(section.id),
    };
  });

  // Always-include first (in original order, then by score within group).
  const always = scored
    .filter((x) => x.alwaysInclude)
    .sort((a, b) => sections.indexOf(a.section) - sections.indexOf(b.section));
  const optional = scored.filter((x) => !x.alwaysInclude).sort((a, b) => b.score - a.score);

  let used = 0;
  const decisions = [];
  const selected = [];
  const summarised = [];
  const dropped = [];

  for (const item of always) {
    selected.push(item.section);
    used += item.tokens;
    decisions.push({ id: item.section.id, decision: 'always-include', tokens: item.tokens, score: item.score });
  }

  // Score floor: a section with no FR overlap, no TF-IDF signal, and no
  // edge-boost is dropped regardless of leftover budget. The ranker is a
  // relevance filter, not just a budget knapsack — irrelevant sections
  // should never be inlined just because slack is available.
  const SCORE_FLOOR = 0.05;
  for (const item of optional) {
    if (item.score <= SCORE_FLOOR) {
      dropped.push(item.section);
      decisions.push({
        id: item.section.id,
        decision: 'drop',
        reason: 'below-score-floor',
        tokens: item.tokens,
        score: item.score,
      });
      continue;
    }
    if (used + item.tokens <= tokenBudget) {
      selected.push(item.section);
      used += item.tokens;
      decisions.push({ id: item.section.id, decision: 'inline', tokens: item.tokens, score: item.score });
    } else if (used < tokenBudget * 1.2) {
      // Fits the soft (1.2×) budget — summarise instead of dropping.
      const summary = summariseSection(item.section);
      const summaryTokens = estimateTokens(summary);
      summarised.push({ ...item.section, content: summary });
      used += summaryTokens;
      decisions.push({
        id: item.section.id,
        decision: 'summarise',
        tokens: summaryTokens,
        originalTokens: item.tokens,
        score: item.score,
      });
    } else {
      dropped.push(item.section);
      decisions.push({
        id: item.section.id,
        decision: 'drop',
        reason: 'budget-exceeded',
        tokens: item.tokens,
        score: item.score,
      });
    }
  }

  return {
    selected,
    summarised,
    dropped,
    decisions,
    totalTokens: used,
    budget: tokenBudget,
  };
}

function applySectionBudget(sections, options = {}) {
  const ranked = rankPacketSections({
    sections,
    milestoneFRs: options.milestoneFRs,
    frDescriptions: options.frDescriptions,
    capabilityEdges: options.capabilityEdges,
    tokenBudget: options.tokenBudget,
  });
  return {
    sections: [...ranked.selected, ...ranked.summarised],
    totalEstimatedTokens: ranked.totalTokens,
    budget: ranked.budget,
    droppedIds: ranked.dropped.map((s) => s.id),
    decisions: ranked.decisions,
  };
}

module.exports = {
  rankPacketSections,
  applySectionBudget,
  estimateTokens,
  ALWAYS_INCLUDE,
  SECTION_CLASS_WEIGHTS,
  DEFAULT_TOKEN_BUDGET,
};

// ── CLI ──────────────────────────────────────────────────────────────

function readJsonOrExit(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[cobolt-build-packet-rank] Failed to read/parse ${file}: ${err.message}`);
    process.exit(1);
  }
}

function cliExplain(file) {
  const input = readJsonOrExit(file);
  const ranked = rankPacketSections(input);
  console.log(`Total sections: ${input.sections?.length || 0}`);
  console.log(`Token budget: ${ranked.budget}`);
  console.log(`Used: ${ranked.totalTokens}`);
  console.log(`Selected: ${ranked.selected.length}`);
  console.log(`Summarised: ${ranked.summarised.length}`);
  console.log(`Dropped: ${ranked.dropped.length}`);
  console.log('Decisions:');
  for (const d of ranked.decisions) {
    console.log(
      `  [${d.decision.padEnd(15)}] ${d.id.padEnd(35)} tokens=${String(d.tokens).padEnd(6)} score=${d.score.toFixed(4)}`,
    );
  }
}

function cliRank(inFile, outFile) {
  const input = readJsonOrExit(inFile);
  const ranked = rankPacketSections(input);
  fs.writeFileSync(outFile, `${JSON.stringify(ranked, null, 2)}\n`, 'utf8');
  console.log(`[cobolt-build-packet-rank] Wrote ${outFile}`);
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log('Usage: node tools/cobolt-build-packet-rank.js <command> [args]');
    console.log('Commands:');
    console.log('  explain <manifest.json>             Print ranking decisions to stdout');
    console.log('  rank --in <manifest.json> --out <ranked.json>   Persist ranked manifest');
    process.exit(0);
  }
  try {
    if (cmd === 'explain') {
      if (!argv[1]) {
        console.error('Usage: explain <manifest.json>');
        process.exit(1);
      }
      cliExplain(path.resolve(argv[1]));
      process.exit(0);
    }
    if (cmd === 'rank') {
      let inFile = null;
      let outFile = null;
      for (let i = 1; i < argv.length; i += 1) {
        if (argv[i] === '--in') {
          inFile = argv[i + 1];
          i += 1;
        } else if (argv[i] === '--out') {
          outFile = argv[i + 1];
          i += 1;
        }
      }
      if (!inFile || !outFile) {
        console.error('Usage: rank --in <manifest.json> --out <ranked.json>');
        process.exit(1);
      }
      cliRank(path.resolve(inFile), path.resolve(outFile));
      process.exit(0);
    }
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
  } catch (err) {
    console.error(`[cobolt-build-packet-rank] ${err.message}`);
    process.exit(1);
  }
}
