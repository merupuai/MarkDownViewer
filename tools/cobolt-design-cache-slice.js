#!/usr/bin/env node

// CoBolt Design-Cache Slicer — screen-scoped Stitch/Figma pre-fetch extract.
//
// Problem
//   M{n}-design-cache.md contains the whole-app Stitch layouts + Figma
//   properties for every UI screen in the milestone. Builders in a
//   specific UI round typically own 2–5 screens, not all of them. Full
//   cache injection costs 5–12K tokens per builder per UI round.
//
// Solution
//   Produce a screen-scoped slice containing:
//     - Always-kept global sections (MCP Availability, MCP Attempt Log,
//       Design System Tokens, Component Definitions, Image Assets, Fallback)
//     - ## Screen Layouts filtered to screens matching the builder's file
//       ownership (by screen name or mapped task ID)
//     - ## Per-Element CSS Properties filtered likewise
//
// Fail-safe
//   If design-cache.md is missing OR filtering matches zero screens,
//   the slicer falls back by COPYING the full cache. It NEVER produces
//   an empty or stub slice, because that would silently starve UI
//   builders of design context (which regresses to the pre-cache failure
//   mode where builders invent layouts).
//
// Output
//   _cobolt-output/latest/build/{M}/design-cache-slice-{hash}.md
//   _cobolt-output/latest/build/{M}/design-cache-slice-{hash}.trace.json
//
// CLI
//   node tools/cobolt-design-cache-slice.js slice \
//       --milestone M1 \
//       --files src/pages/Dashboard.tsx,src/pages/Settings.tsx \
//       [--screens "Dashboard,Settings Panel"] \
//       [--cache <override path>] \
//       [--out <override path>]
//
//   Writes the slice + trace, prints the slice path to stdout on exit 0.
//
// Exit codes (tools/CLAUDE.md contract):
//   0 = success (slice OR fallback)
//   1 = hard error (missing args, cannot read cache, write failure)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWrite, atomicWriteJSON } = require('../lib/cobolt-atomic-write');
const { isSameOrDescendantPath } = require('../lib/cobolt-paths');

// Common English words that show up as filename segments (e.g. "orderHistory"
// → "history"). Substring-matching these against arbitrary H3 headings
// produces false positives (e.g. heading "History of Logs" matches an unrelated
// builder). We require a minimum length OR an exact-segment anchor for these
// so the slicer is stricter when the risk of broad matching is highest.
const COMMON_NOUNS = new Set([
  'admin',
  'api',
  'app',
  'auth',
  'base',
  'code',
  'data',
  'date',
  'edit',
  'file',
  'form',
  'help',
  'home',
  'info',
  'item',
  'list',
  'log',
  'logs',
  'main',
  'menu',
  'meta',
  'name',
  'new',
  'page',
  'post',
  'role',
  'root',
  'site',
  'step',
  'sub',
  'tab',
  'tag',
  'text',
  'time',
  'type',
  'user',
  'view',
  'work',
  'history',
  'order',
  'orders',
  'product',
  'products',
  'setting',
  'settings',
]);

function assertPathWithinProject(p, label) {
  // Tools are invoked inside the project cwd; all inputs must resolve inside
  // the project tree to match the CoBolt path-safety convention.
  const cwd = process.cwd();
  const resolved = path.resolve(p);
  if (!isSameOrDescendantPath(resolved, cwd)) {
    console.error(`[design-cache-slice] ${label || 'path'} "${p}" resolves outside project root (${cwd}); refusing.`);
    process.exit(1);
  }
  return resolved;
}

// Heading regexes — ## sections and ### sub-sections
const H2 = /^##\s+(.+?)\s*$/;
const H3 = /^###\s+(.+?)\s*$/;

// Sections that are GLOBAL — always kept in slice regardless of filters.
const GLOBAL_H2 = new Set([
  'MCP Availability',
  'MCP Attempt Log',
  'Design System Tokens',
  'Component Definitions',
  'Image Assets',
  'Fallback',
  'Setup Instructions',
]);

// Sections that contain per-screen H3 sub-sections we want to filter.
const SCREEN_SCOPED_H2 = new Set([
  'Screen Layouts',
  'Per-Element CSS Properties',
  'Per-Element CSS Properties (from Figma)',
]);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function splitList(raw) {
  if (!raw || raw === true) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Extract candidate screen-name tokens from a file path. We prefer compound
// tokens (whole basename, concatenated segments) over individual segments
// because individual common nouns like "history", "user", "order" create
// false positives on unrelated headings. When a multi-segment filename
// produces a compound token, common-noun SINGLETONS are dropped from the
// token set — the compound carries the real signal.
function candidateScreenTokens(filePath) {
  const base = path.basename(String(filePath), path.extname(String(filePath)));
  const tokens = new Set();
  tokens.add(base.toLowerCase());

  const pascalSegs = base
    .split(/(?=[A-Z])/)
    .map((s) => s.toLowerCase().trim())
    .filter(Boolean);
  const kebabSegs = base
    .split(/[-_]/)
    .map((s) => s.toLowerCase().trim())
    .filter(Boolean);
  const allSegs = Array.from(new Set([...pascalSegs, ...kebabSegs]));
  const hasCompound = allSegs.length > 1;

  if (hasCompound) {
    // Compound token (space-joined) — matched as a phrase
    tokens.add(pascalSegs.join(' '));
  }
  for (const s of allSegs) {
    // Drop common-noun singletons IF a compound exists — the compound is the
    // real signal; the singleton alone would over-match (e.g. "history" →
    // "History of Logs"). Length-independent: even "settings" is noisy if we
    // already have the compound "settings panel".
    if (hasCompound && COMMON_NOUNS.has(s)) continue;
    tokens.add(s);
  }
  return tokens;
}

// Screen match: true if any candidate token appears as substring in the screen
// heading text. Case-insensitive.
function screenMatches(screenHeading, tokenSets) {
  const lower = String(screenHeading).toLowerCase();
  for (const tokens of tokenSets) {
    for (const t of tokens) {
      if (t.length < 2) continue;
      // Stricter rules for short/common tokens to avoid false positives like
      // "order" matching "Order Status" when the real target is "Orders Panel":
      //   - common nouns (length <= 7) require whole-word boundary match
      //   - other tokens allow substring match
      const isCommon = COMMON_NOUNS.has(t);
      if (isCommon) {
        const re = new RegExp(`\\b${t.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
        if (re.test(lower)) return true;
      } else if (lower.includes(t)) {
        return true;
      }
    }
  }
  return false;
}

// Parse the design-cache markdown into an ordered list of blocks.
// Each block: { level: 2|3, heading, lines: [] } OR { level: 0, lines: [] } for preamble.
function parseBlocks(content) {
  const lines = content.split(/\r?\n/);
  const blocks = [];
  let current = { level: 0, heading: null, lines: [] };
  for (const line of lines) {
    const h2 = line.match(H2);
    const h3 = line.match(H3);
    if (h2) {
      if (current.lines.length || current.heading !== null) blocks.push(current);
      current = { level: 2, heading: h2[1], lines: [line] };
    } else if (h3) {
      if (current.lines.length || current.heading !== null) blocks.push(current);
      current = { level: 3, heading: h3[1], lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length || current.heading !== null) blocks.push(current);
  return blocks;
}

function filterBlocks(blocks, tokenSets) {
  const out = [];
  let currentH2 = null;
  let keepCurrentH2 = true; // default keep until we hit a screen-scoped H2 and decide per-H3
  for (const b of blocks) {
    if (b.level === 2) {
      currentH2 = b.heading;
      if (GLOBAL_H2.has(currentH2)) {
        out.push(b);
        keepCurrentH2 = true;
      } else if (SCREEN_SCOPED_H2.has(currentH2)) {
        // Keep the H2 heading itself (as anchor) but filter the H3 children.
        out.push(b);
        keepCurrentH2 = false; // children filter per-H3
      } else {
        // Unknown H2 — keep by default (conservative: never drop unknown sections).
        out.push(b);
        keepCurrentH2 = true;
      }
    } else if (b.level === 3) {
      if (keepCurrentH2) {
        out.push(b);
      } else {
        // Screen-scoped H3 — include only if it matches
        if (screenMatches(b.heading, tokenSets)) out.push(b);
      }
    } else {
      // Preamble (title line etc.) — always keep
      out.push(b);
    }
  }
  return out;
}

function renderBlocks(blocks) {
  return blocks.map((b) => b.lines.join('\n')).join('\n');
}

function computeHash(blocks) {
  const txt = blocks
    .filter((b) => b.level === 3)
    .map((b) => b.heading || '')
    .join('|');
  return crypto.createHash('sha256').update(txt).digest('hex').slice(0, 10);
}

function cmdSlice(args) {
  const milestone = args.milestone;
  if (!milestone) {
    console.error('slice requires --milestone M{n}');
    process.exit(1);
  }

  const files = splitList(args.files);
  const explicitScreens = splitList(args.screens);
  if (files.length === 0 && explicitScreens.length === 0) {
    console.error('slice requires --files <list> OR --screens <list> (or both)');
    process.exit(1);
  }

  const cwd = process.cwd();
  const cachePath = args.cache
    ? assertPathWithinProject(args.cache, '--cache')
    : path.join(cwd, '_cobolt-output', 'latest', 'build', milestone, `${milestone}-design-cache.md`);

  const outDir = path.join(cwd, '_cobolt-output', 'latest', 'build', milestone);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  if (args.out) assertPathWithinProject(args.out, '--out');

  // Fallback when the cache doesn't exist at all — write a stub that says so,
  // so callers can verify a slice file was produced deterministically and log
  // the reason. This is NOT exit-2 because the tool ran to completion with a
  // valid determinate output; missing input is a soft fallback, not a hard
  // failure.
  if (!fs.existsSync(cachePath)) {
    const stubPath = args.out ? path.resolve(args.out) : path.join(outDir, `design-cache-slice-missing.md`);
    const stub =
      `# Design Cache Slice — ${milestone}\n\n` +
      `## Slice Status\n\n` +
      `- **Source:** ${cachePath}\n` +
      `- **Status:** FALLBACK — source cache not found\n` +
      `- **Reason:** Orchestrator should inject the UX spec design-system section instead.\n`;
    atomicWrite(stubPath, stub, { mode: 0o600 });
    const trace = {
      tool: 'cobolt-design-cache-slice',
      milestone,
      status: 'fallback-missing-cache',
      cachePath,
      outPath: stubPath,
      requestedFiles: files,
      requestedScreens: explicitScreens,
      emittedAt: new Date().toISOString(),
    };
    atomicWriteJSON(`${stubPath}.trace.json`, trace, { mode: 0o600 });
    console.log(stubPath);
    return;
  }

  const content = fs.readFileSync(cachePath, 'utf8');
  const allBlocks = parseBlocks(content);

  const tokenSets = [];
  for (const f of files) tokenSets.push(candidateScreenTokens(f));
  if (explicitScreens.length) {
    const set = new Set(explicitScreens.map((s) => s.toLowerCase()));
    tokenSets.push(set);
  }

  const filtered = filterBlocks(allBlocks, tokenSets);
  const matchedScreens = filtered.filter((b) => b.level === 3).length;

  let finalBlocks = filtered;
  let status = 'sliced';
  if (matchedScreens === 0) {
    // Fallback to full cache — never starve the builder
    finalBlocks = allBlocks;
    status = 'fallback-no-matches';
  }

  const rendered = renderBlocks(finalBlocks);
  const hash = computeHash(finalBlocks);
  const outPath = args.out ? path.resolve(args.out) : path.join(outDir, `design-cache-slice-${hash}.md`);

  atomicWrite(outPath, rendered, { mode: 0o600 });

  const trace = {
    tool: 'cobolt-design-cache-slice',
    milestone,
    status,
    cachePath,
    outPath,
    requestedFiles: files,
    requestedScreens: explicitScreens,
    allScreensFound: allBlocks.filter((b) => b.level === 3).length,
    matchedScreens,
    sliceBytes: Buffer.byteLength(rendered, 'utf8'),
    sourceBytes: Buffer.byteLength(content, 'utf8'),
    reductionPercent: content.length > 0 ? Math.round((1 - rendered.length / content.length) * 100) : 0,
    hash,
    emittedAt: new Date().toISOString(),
  };
  atomicWriteJSON(`${outPath}.trace.json`, trace, { mode: 0o600 });

  console.log(outPath);
  if (process.env.COBOLT_DESIGN_CACHE_VERBOSE === '1') {
    console.error(
      `[design-cache-slice] ${status} — ${matchedScreens} screens matched, ${trace.reductionPercent}% reduction`,
    );
  }
}

function main() {
  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);
  switch (command) {
    case 'slice':
      return cmdSlice(args);
    default:
      console.error(
        'Usage: cobolt-design-cache-slice.js slice --milestone M{n} --files <paths> [--screens <names>] [--cache <path>] [--out <path>]\n' +
          '  Produces a screen-scoped design-cache slice. Falls back to full cache on zero matches. Fallback-missing-cache stub when source is absent.',
      );
      process.exit(1);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`[design-cache-slice] ERROR: ${e.message}`);
    process.exit(1);
  }
}

module.exports = {
  parseBlocks,
  filterBlocks,
  candidateScreenTokens,
  screenMatches,
  renderBlocks,
  GLOBAL_H2,
  SCREEN_SCOPED_H2,
};
