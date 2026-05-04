#!/usr/bin/env node

// CoBolt Pattern Loader (v0.12.0 Phase 4A)
//
// Scans PRD / TRD / architecture.md for trigger keywords and returns the
// relevant pattern library files. Agents inject these into their prompts
// (instead of relying on training data which produces generic wrong answers
// for realtime, distributed, and eventual-consistency domains).
//
// Trigger → pattern mapping:
//   websocket / chat / live / presence     → realtime/websocket-reconnect
//   server-sent events / SSE / token stream → realtime/server-sent-events
//   who's online / typing indicator         → realtime/presence
//   webhook / publish event / event-driven  → distributed/transactional-outbox
//   checkout / multi-step workflow          → distributed/saga
//   retry / idempotent / double-charge      → distributed/idempotency-keys
//   collaborative editing / offline / CRDT  → distributed/eventual-consistency
//
// Usage:
//   node tools/cobolt-pattern-loader.js scan
//   node tools/cobolt-pattern-loader.js show realtime/websocket-reconnect
//   node tools/cobolt-pattern-loader.js list

const fs = require('node:fs');
const path = require('node:path');

const PATTERN_ROOTS = [
  path.join(__dirname, '..', 'source', 'patterns'),
  path.join(__dirname, '..', '.claude', 'cobolt', 'patterns'),
  path.join(process.cwd(), 'source', 'patterns'),
];

const TRIGGERS = [
  {
    pattern: 'realtime/websocket-reconnect',
    keywords: [/\bwebsocket\b/i, /\bchat\b/i, /\blive update/i, /\bcollaborative edit/i, /\btyping indicator/i],
  },
  {
    pattern: 'realtime/server-sent-events',
    keywords: [
      /\bserver[-\s]sent events?\b/i,
      /\bSSE\b/,
      /\btoken stream/i,
      /\bstream(ing)?\s+response/i,
      /\blog tail/i,
    ],
  },
  {
    pattern: 'realtime/presence',
    keywords: [/\bwho'?s? online/i, /\bpresence\b/i, /\btyping indicator/i, /\bactive (?:now|viewers)\b/i],
  },
  {
    pattern: 'distributed/transactional-outbox',
    keywords: [
      /\bpublish (?:an?\s+)?event\b/i,
      /\bwebhook\b/i,
      /\bevent[-\s]driven\b/i,
      /\bnotify on\b/i,
      /\bafter (?:save|commit|insert)\b/i,
    ],
  },
  {
    pattern: 'distributed/saga',
    keywords: [
      /\bmulti[-\s]step (?:workflow|transaction)\b/i,
      /\bcheckout\b/i,
      /\bpartial (?:failure|completion)\b/i,
      /\bcompensat/i,
      /\bsaga\b/i,
    ],
  },
  {
    pattern: 'distributed/idempotency-keys',
    keywords: [
      /\bidempot/i,
      /\bretry\b/i,
      /\bdouble[-\s]?charge\b/i,
      /\bexactly[-\s]once\b/i,
      /\bat[-\s]least[-\s]once\b/i,
    ],
  },
  {
    pattern: 'distributed/eventual-consistency',
    keywords: [
      /\bCRDT\b/,
      /\beventual(?:ly)? consistent\b/i,
      /\boffline edit/i,
      /\bcollaborative edit/i,
      /\bY\.?js\b/i,
      /\bAutomerge\b/,
    ],
  },
];

function findPatternRoot() {
  for (const r of PATTERN_ROOTS) {
    if (fs.existsSync(r)) return r;
  }
  return null;
}

function sourceDocs() {
  const candidates = [
    path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'prd.md'),
    path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'trd.md'),
    path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'architecture.md'),
    path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'implicit-requirements.md'),
  ];
  return candidates.filter((c) => fs.existsSync(c));
}

// v0.12.1 fix #14: section-scoped match. The previous implementation ran
// trigger regexes over the full concatenated doc body — a 10k-word PRD with
// a stray "the chat room mentioned..." would load realtime patterns even
// when the PRD is about a static blog. This version:
//
//   1. Prefers matches inside MVP/Growth/Core/Scope-in sections.
//   2. Discounts matches in "Out of scope", "Appendix", "Glossary",
//      "Non-goals", "Future" sections.
//   3. Requires at least 2 keyword hits OR a primary functional-section
//      hit to include a pattern, reducing single-token noise.
function isScopeInHeader(line) {
  return /^#+\s*(Functional|Scope|In[\s-]?scope|MVP|Core|Requirements|Features|User Stories|Use Cases)/i.test(line);
}
function isScopeOutHeader(line) {
  return /^#+\s*(Out[\s-]?of[\s-]?scope|Non[\s-]?goals?|Appendix|Glossary|Future|Stretch|Won'?t Do|Deferred)/i.test(
    line,
  );
}

function sectionize(text) {
  // Split into { heading, body, inScope, outOfScope } based on top-level sections.
  const sections = [];
  const lines = text.split('\n');
  let current = { heading: '(preamble)', body: '', inScope: true, outOfScope: false };
  for (const line of lines) {
    if (/^#{1,3}\s/.test(line)) {
      if (current.body.trim() || current.heading !== '(preamble)') sections.push(current);
      current = {
        heading: line.replace(/^#+\s*/, '').trim(),
        body: '',
        inScope: isScopeInHeader(line),
        outOfScope: isScopeOutHeader(line),
      };
    } else {
      current.body += `${line}\n`;
    }
  }
  sections.push(current);
  return sections;
}

function scan() {
  const docs = sourceDocs();
  if (docs.length === 0) return { scanned: 0, matches: [] };
  const matches = [];

  // Aggregate scoring per pattern across all source docs
  const scores = new Map(); // pattern → {inScopeHits, neutralHits, outOfScopeHits, triggers}

  for (const doc of docs) {
    let text = '';
    try {
      text = fs.readFileSync(doc, 'utf8');
    } catch {
      continue;
    }
    const sections = sectionize(text);
    for (const sec of sections) {
      if (sec.outOfScope) continue; // hard-exclude out-of-scope / non-goals
      for (const t of TRIGGERS) {
        for (const k of t.keywords) {
          if (k.test(sec.body)) {
            const entry = scores.get(t.pattern) || { inScopeHits: 0, neutralHits: 0, triggers: new Set() };
            if (sec.inScope) entry.inScopeHits++;
            else entry.neutralHits++;
            entry.triggers.add(k.toString());
            scores.set(t.pattern, entry);
          }
        }
      }
    }
  }

  for (const [pattern, s] of scores.entries()) {
    // Include pattern if: (a) any in-scope hit, or (b) ≥2 neutral hits
    if (s.inScopeHits >= 1 || s.neutralHits >= 2) {
      matches.push({
        pattern,
        inScopeHits: s.inScopeHits,
        neutralHits: s.neutralHits,
        triggers: [...s.triggers],
      });
    }
  }

  return { scanned: docs.length, docs, matches };
}

function show(patternId) {
  const root = findPatternRoot();
  if (!root) return { ok: false, error: 'pattern root not found' };
  const fp = path.join(root, `${patternId}.md`);
  if (!fs.existsSync(fp)) return { ok: false, error: `pattern ${patternId} not found at ${fp}` };
  return { ok: true, patternId, path: fp, content: fs.readFileSync(fp, 'utf8') };
}

function list() {
  const root = findPatternRoot();
  if (!root) return { patterns: [] };
  const out = [];
  function walk(dir, prefix) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const next = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, next);
      else if (e.name.endsWith('.md') && e.name !== 'README.md') {
        out.push(next.replace(/\.md$/, ''));
      }
    }
  }
  walk(root, '');
  return { patterns: out };
}

function parseFlags(args) {
  const out = { _: [], json: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') out.json = true;
    else out._.push(args[i]);
  }
  return out;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (cmd) {
    case 'scan': {
      const r = scan();
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    case 'show': {
      const id = flags._[0];
      if (!id) {
        console.error('Usage: cobolt-pattern-loader.js show <pattern-id>');
        return 1;
      }
      const r = show(id);
      if (!r.ok) {
        console.error(r.error);
        return 1;
      }
      if (flags.json) console.log(JSON.stringify(r, null, 2));
      else console.log(r.content);
      return 0;
    }
    case 'list': {
      const r = list();
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    default:
      console.error('Usage: cobolt-pattern-loader.js {scan|show <id>|list} [--json]');
      return 1;
  }
}

if (require.main === module) process.exit(main());

module.exports = { scan, show, list, TRIGGERS };
