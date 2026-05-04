#!/usr/bin/env node

// CoBolt Anchor Retrieval Index — TF-IDF index + query over per-BC anchors.
//
// Problem: cross-BC reasoning currently loads whole anchors + contracts + RTM on
// every dispatch. By M6 that's 40K+ context on large projects even with the 3K
// per-anchor target. The budget per anchor is fine — the scaling issue is
// loading ALL of them on every dispatch.
//
// Design: index anchor sections (not whole files). At dispatch time, retrieve
// only the top-K sections relevant to the current task query, ranked by cosine
// similarity on TF-IDF vectors, truncating at a token budget.
//
// No heavy deps — pure JS. Pure hash-lookup fallback when TF-IDF has too few
// matches. Token count = Math.ceil(chars / 4).
//
// Commands:
//   node tools/cobolt-anchor-index.js build [--root .]
//   node tools/cobolt-anchor-index.js query --q "<text>" [--budget 8000] [--k 12] [--json]
//   node tools/cobolt-anchor-index.js compact --anchor <path> [--target 3000] [--archive]
//   node tools/cobolt-anchor-index.js stats

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const CHARS_PER_TOKEN = 4;
const DEFAULT_BUDGET = 8000;
const DEFAULT_TOPK = 12;
const DEFAULT_COMPACT_TARGET = 3000;
const ANCHOR_SECTION_HEADERS = [
  '## Goal',
  '## Architecture Decisions',
  '## Open Risks',
  '## Completed Rounds',
  '## Current Round',
  '## Round Ledger',
];

function toTokens(chars) {
  return Math.ceil((chars || 0) / CHARS_PER_TOKEN);
}

// ── Tokenization ─────────────────────────────────────────────────
// Conservative: alphanumeric+underscore/dash tokens of length >=3, lowercased.
// No stemming — anchors already contain domain vocabulary that benefits from
// exact matching (e.g. "FR-042", "shared_kernel").
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'have',
  'are',
  'was',
  'will',
  'not',
  'but',
  'can',
  'has',
  'had',
  'our',
  'its',
  'use',
  'all',
  'any',
  'new',
  'one',
  'two',
  'per',
  'been',
  'also',
  'into',
  'than',
  'then',
  'when',
  'what',
  'which',
  'where',
  'while',
  'they',
  'them',
  'their',
  'over',
  'only',
  'some',
  'such',
  'very',
  'via',
  'each',
  'here',
  'there',
]);

function tokenize(text) {
  if (!text) return [];
  const out = [];
  const matches =
    String(text)
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_-]{2,}/g) || [];
  for (const m of matches) {
    if (STOPWORDS.has(m)) continue;
    out.push(m);
  }
  return out;
}

// ── Section extraction ───────────────────────────────────────────
function extractSections(content) {
  const lines = content.split('\n');
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (current) sections.push(current);
      current = { heading: line.trim(), bodyLines: [] };
    } else if (current) {
      current.bodyLines.push(line);
    }
  }
  if (current) sections.push(current);
  return sections
    .filter((s) => ANCHOR_SECTION_HEADERS.includes(s.heading))
    .map((s) => ({
      heading: s.heading,
      body: s.bodyLines.join('\n').replace(/^\s+|\s+$/g, ''),
    }));
}

// Infer BC id from the parent directory name: .../build/M3/M3-anchor.md → M3
function bcFromPath(anchorPath) {
  const parent = path.basename(path.dirname(anchorPath));
  return parent || 'unknown';
}

// ── Discover anchors ─────────────────────────────────────────────
function discoverAnchors(root) {
  const base = path.join(root, '_cobolt-output', 'latest', 'build');
  if (!fs.existsSync(base)) return [];
  const out = [];
  for (const entry of fs.readdirSync(base)) {
    const dir = path.join(base, entry);
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const candidate = path.join(dir, `${entry}-anchor.md`);
    if (fs.existsSync(candidate)) out.push(candidate);
  }
  return out;
}

// ── Build index ──────────────────────────────────────────────────
function buildIndex(root) {
  const anchors = discoverAnchors(root);
  const rawDocs = [];
  for (const anchorPath of anchors) {
    let content;
    try {
      content = fs.readFileSync(anchorPath, 'utf8');
    } catch {
      continue;
    }
    const bc = bcFromPath(anchorPath);
    for (const section of extractSections(content)) {
      if (!section.body) continue;
      const tokens = tokenize(section.body);
      if (tokens.length === 0) continue;
      rawDocs.push({
        bc,
        anchorPath: path.relative(root, anchorPath).replace(/\\/g, '/'),
        sectionHeading: section.heading,
        charCount: section.body.length,
        tokenCount: toTokens(section.body.length),
        tokens,
      });
    }
  }

  // Term frequencies and document frequencies
  const df = new Map();
  const docTf = rawDocs.map((d) => {
    const tf = new Map();
    for (const t of d.tokens) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return tf;
  });

  // Vocabulary with IDF
  const N = rawDocs.length || 1;
  const vocabulary = {};
  let termId = 0;
  for (const [term, d] of df.entries()) {
    vocabulary[term] = { id: termId++, idf: Math.log(1 + N / d) };
  }

  // Build L2-normalized sparse TF-IDF vectors
  const documents = rawDocs.map((d, i) => {
    const tf = docTf[i];
    const weights = [];
    let norm = 0;
    for (const [term, count] of tf.entries()) {
      const v = vocabulary[term];
      if (!v) continue;
      const w = (1 + Math.log(count)) * v.idf;
      weights.push([v.id, w]);
      norm += w * w;
    }
    const denom = Math.sqrt(norm) || 1;
    const normalized = weights.map(([id, w]) => [id, +(w / denom).toFixed(6)]);
    normalized.sort((a, b) => a[0] - b[0]);
    return {
      bc: d.bc,
      anchorPath: d.anchorPath,
      sectionHeading: d.sectionHeading,
      tokenCount: d.tokenCount,
      charCount: d.charCount,
      tfidf: normalized,
    };
  });

  const totalTokens = documents.reduce((s, d) => s + d.tokenCount, 0);
  return {
    version: SCHEMA_VERSION,
    builtAt: new Date().toISOString(),
    stats: {
      anchorCount: anchors.length,
      sectionCount: documents.length,
      vocabularySize: termId,
      totalTokensIndexed: totalTokens,
    },
    vocabulary,
    documents,
  };
}

function indexPath(root) {
  return path.join(root, '_cobolt-output', 'latest', 'build', 'anchors', 'index.json');
}

function saveIndex(root, index) {
  const p = indexPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(index, null, 2));
  return p;
}

function loadIndex(root) {
  const p = indexPath(root);
  if (!fs.existsSync(p)) return null;
  try {
    const idx = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (idx.version !== SCHEMA_VERSION) return null;
    return idx;
  } catch {
    return null;
  }
}

// ── Query ────────────────────────────────────────────────────────
function queryVector(queryText, vocabulary) {
  const tokens = tokenize(queryText);
  if (tokens.length === 0) return { sparse: [], tokens: [] };
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  const weights = [];
  let norm = 0;
  for (const [term, count] of tf.entries()) {
    const v = vocabulary[term];
    if (!v) continue;
    const w = (1 + Math.log(count)) * v.idf;
    weights.push([v.id, w]);
    norm += w * w;
  }
  const denom = Math.sqrt(norm) || 1;
  const sparse = weights.map(([id, w]) => [id, w / denom]);
  sparse.sort((a, b) => a[0] - b[0]);
  return { sparse, tokens };
}

// Cosine sim of two sorted sparse vectors
function cosine(a, b) {
  let i = 0;
  let j = 0;
  let s = 0;
  while (i < a.length && j < b.length) {
    if (a[i][0] === b[j][0]) {
      s += a[i][1] * b[j][1];
      i++;
      j++;
    } else if (a[i][0] < b[j][0]) i++;
    else j++;
  }
  return s;
}

// Hash-lookup fallback: plain token overlap count (for queries with no
// vocabulary hits — e.g. brand-new BC-specific terms).
function hashOverlap(queryTokens, docHeading, docBody) {
  const q = new Set(queryTokens);
  const d = new Set(tokenize(`${docHeading} ${docBody}`));
  let s = 0;
  for (const t of q) if (d.has(t)) s++;
  return s;
}

function retrieve(root, queryText, { budget = DEFAULT_BUDGET, k = DEFAULT_TOPK } = {}) {
  const index = loadIndex(root);
  if (!index) return { hits: [], reason: 'no-index', totalTokens: 0 };

  const { sparse, tokens } = queryVector(queryText, index.vocabulary);
  let scored = index.documents.map((d) => ({ doc: d, score: cosine(sparse, d.tfidf) }));

  // Fallback to hash overlap when TF-IDF returns all zeros
  const anyScore = scored.some((s) => s.score > 0);
  if (!anyScore) {
    scored = index.documents.map((d) => {
      let body = '';
      try {
        const full = fs.readFileSync(path.join(root, d.anchorPath), 'utf8');
        body = extractSections(full).find((s) => s.heading === d.sectionHeading)?.body || '';
      } catch {
        /* ignore */
      }
      return { doc: d, score: hashOverlap(tokens, d.sectionHeading, body) };
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const hits = [];
  let totalTokens = 0;
  for (const { doc, score } of scored) {
    if (hits.length >= k) break;
    if (score <= 0) break;
    if (totalTokens + doc.tokenCount > budget && hits.length > 0) break;
    hits.push({
      bc: doc.bc,
      anchorPath: doc.anchorPath,
      sectionHeading: doc.sectionHeading,
      tokenCount: doc.tokenCount,
      score: +score.toFixed(4),
    });
    totalTokens += doc.tokenCount;
  }
  return { hits, reason: hits.length ? 'ok' : 'no-hits', totalTokens };
}

// ── Compactor ────────────────────────────────────────────────────
// Summarizes a v2 anchor down to <= targetTokens by:
//   1. Keeping frozen sections (Goal, Architecture Decisions) verbatim
//   2. Retaining only the last N Round Ledger entries
//   3. Collapsing Completed Rounds into a count + terminal-round summary
//   4. Truncating Open Risks to the top 3 by severity heuristic
//   5. Dropping Current Round (round is complete by compaction time)
//
// The uncompacted anchor is archived to anchors/history/{bc}/ so nothing is
// lost. Future retrieval can point back to archived versions if needed.
function loadAnchor(anchorPath) {
  const content = fs.readFileSync(anchorPath, 'utf8');
  const sections = {};
  for (const s of extractSections(content)) sections[s.heading] = s.body;
  return { content, sections };
}

function compactAnchor(anchorPath, { target = DEFAULT_COMPACT_TARGET, archive = true } = {}) {
  const { sections } = loadAnchor(anchorPath);
  const bc = bcFromPath(anchorPath);

  const keptGoal = sections['## Goal'] || '';
  const keptArch = sections['## Architecture Decisions'] || '';

  const ledger = (sections['## Round Ledger'] || '').split('\n').filter((l) => l.trim());
  const ledgerTail = ledger.slice(-10);

  const completed = (sections['## Completed Rounds'] || '').split('\n').filter((l) => l.trim());
  const completedSummary =
    completed.length > 0
      ? `- ${completed.length} rounds completed. Terminal: ${completed[completed.length - 1]}`
      : '- no completed rounds';

  const risks = (sections['## Open Risks'] || '').split('\n').filter((l) => l.trim());
  const risksTop = risks
    .filter((l) => /high|critical|severity/i.test(l))
    .slice(0, 3)
    .concat(risks.filter((l) => !/high|critical|severity/i.test(l)).slice(0, 2))
    .slice(0, 3);

  const body = [
    `# ${bc} Anchor (compacted)`,
    '',
    '## Goal',
    '',
    keptGoal,
    '',
    '## Architecture Decisions',
    '',
    keptArch,
    '',
    '## Open Risks',
    '',
    risksTop.length ? risksTop.join('\n') : '- none',
    '',
    '## Completed Rounds',
    '',
    completedSummary,
    '',
    '## Round Ledger',
    '',
    ledgerTail.length ? ledgerTail.join('\n') : '- compacted; history archived',
    '',
    `<!-- COBOLT-ANCHOR-VERSION: 2 -->`,
    `<!-- COBOLT-ANCHOR-COMPACTED: ${new Date().toISOString()} target=${target} -->`,
    '',
  ].join('\n');

  const currentTokens = toTokens(body.length);
  let finalBody = body;
  if (currentTokens > target) {
    const cutChars = target * CHARS_PER_TOKEN;
    finalBody = `${body.slice(0, cutChars)}\n<!-- truncated to fit ${target} tokens -->\n`;
  }

  if (archive) {
    const historyDir = path.join(path.dirname(anchorPath), '..', 'anchors', 'history', bc);
    fs.mkdirSync(historyDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archPath = path.join(historyDir, `${bc}-anchor.${stamp}.md`);
    fs.copyFileSync(anchorPath, archPath);
  }

  fs.writeFileSync(anchorPath, finalBody);
  return { anchorPath, tokensBefore: toTokens(fs.statSync(anchorPath).size), tokensAfter: toTokens(finalBody.length) };
}

// ── Budget helper (used by hook) ─────────────────────────────────
// Estimate tokens for an Agent dispatch prompt. Recognizes anchor sections by
// the literal '## ' H2 convention so we only count injected anchor content,
// not the whole prompt. If no anchor markers are present, estimate the whole
// prompt size.
const ANCHOR_DELIMITER = /<<<ANCHOR:[^>]+>>>/g;

function estimatePromptTokens(promptText) {
  if (!promptText) return 0;
  return toTokens(promptText.length);
}

function estimateAnchorTokens(promptText) {
  if (!promptText) return 0;
  const matches = promptText.match(ANCHOR_DELIMITER) || [];
  if (matches.length === 0) return 0;
  // Sum chars between delimiters conservatively
  const parts = promptText.split(ANCHOR_DELIMITER);
  let chars = 0;
  for (let i = 1; i < parts.length; i += 2) chars += parts[i].length;
  if (chars === 0) chars = promptText.length;
  return toTokens(chars);
}

// ── CLI ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const root = path.resolve(args.root || process.cwd());

  if (cmd === 'build') {
    const idx = buildIndex(root);
    const p = saveIndex(root, idx);
    process.stdout.write(`${JSON.stringify({ ok: true, path: path.relative(root, p), stats: idx.stats }, null, 2)}\n`);
    return;
  }
  if (cmd === 'query') {
    if (!args.q) {
      process.stderr.write('Usage: cobolt-anchor-index.js query --q "<text>" [--budget N] [--k N] [--json]\n');
      process.exit(2);
    }
    const result = retrieve(root, args.q, {
      budget: parseInt(args.budget || DEFAULT_BUDGET, 10),
      k: parseInt(args.k || DEFAULT_TOPK, 10),
    });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`# Retrieved ${result.hits.length} sections (${result.totalTokens} tokens)\n\n`);
      for (const h of result.hits) {
        process.stdout.write(`- ${h.bc} :: ${h.sectionHeading}  (${h.tokenCount}t, score=${h.score})\n`);
        process.stdout.write(`  ${h.anchorPath}\n`);
      }
    }
    return;
  }
  if (cmd === 'compact') {
    if (!args.anchor) {
      process.stderr.write('Usage: cobolt-anchor-index.js compact --anchor <path> [--target N] [--archive]\n');
      process.exit(2);
    }
    const r = compactAnchor(args.anchor, {
      target: parseInt(args.target || DEFAULT_COMPACT_TARGET, 10),
      archive: args.archive !== false,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...r }, null, 2)}\n`);
    return;
  }
  if (cmd === 'stats') {
    const idx = loadIndex(root);
    if (!idx) {
      process.stdout.write('no index present; run: cobolt-anchor-index.js build\n');
      return;
    }
    process.stdout.write(`${JSON.stringify(idx.stats, null, 2)}\n`);
    return;
  }
  process.stderr.write(
    'Usage: cobolt-anchor-index.js <build|query|compact|stats> [args]\n' +
      '  build                                       Build TF-IDF index from all anchors\n' +
      '  query  --q "<text>" [--budget N] [--k N]    Retrieve top-K sections within token budget\n' +
      '  compact --anchor <path> [--target N]        Summarize anchor to <=target tokens; archive raw\n' +
      '  stats                                       Print index stats\n',
  );
  process.exit(cmd ? 2 : 0);
}

if (require.main === module) main();

module.exports = {
  buildIndex,
  saveIndex,
  loadIndex,
  retrieve,
  compactAnchor,
  tokenize,
  estimatePromptTokens,
  estimateAnchorTokens,
  extractSections,
  SCHEMA_VERSION,
  DEFAULT_BUDGET,
  _testOnly: { queryVector, cosine, hashOverlap, bcFromPath, toTokens },
};
