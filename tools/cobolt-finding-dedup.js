#!/usr/bin/env node

// CoBolt Finding Dedup — Deterministic first-pass deduplication
//
// Performs exact-match and near-match deduplication on review findings
// before LLM triage. Catches ~60-70% of duplicates deterministically.
//
// Dedup rules:
//   Exact: same file + same line + same prefix → duplicate
//   Near:  same file + overlapping line range (±5) + same category → duplicate
//   Cross: same file + same line + different prefix → related (linked, not removed)
//
// Usage:
//   node tools/cobolt-finding-dedup.js dedup --input <findings.json>     # Dedup findings
//   node tools/cobolt-finding-dedup.js dedup --input <path> --json       # Machine-readable
//   node tools/cobolt-finding-dedup.js stats --input <findings.json>     # Show dedup stats only
//
// Exit codes:
//   0 = success
//   1 = no findings
//   2 = usage error

const fs = require('node:fs');

// ── Category Grouping ───────────────────────────────────────
// Prefixes that share a logical category (duplicates across these are likely related)

const CATEGORY_GROUPS = {
  security: ['SEC', 'SIL', 'COMP'],
  quality: ['CODE', 'DEBT', 'SCAN'],
  api: ['API', 'INT'],
  ui: ['A11Y', 'UI', 'DT', 'UX', 'I18N'],
  data: ['DB'],
  infra: ['CONF', 'OPS', 'DEP'],
  test: ['TEST'],
  perf: ['PERF'],
  feature: ['FEAT', 'ENH'],
  arch: ['ARCH'],
};

function getCategory(prefix) {
  for (const [cat, prefixes] of Object.entries(CATEGORY_GROUPS)) {
    if (prefixes.includes(prefix)) return cat;
  }
  return 'other';
}

function extractPrefix(id) {
  const match = (id || '').match(/^([A-Z]+)-?\d/);
  return match ? match[1] : 'CODE';
}

// Schema-tolerant location accessors.
// Canonical shape (review-findings.schema.json): { location: { file, line } }
// Legacy/flat shapes from older reviewers or brownfield tools: { file, line, lineNumber, path }
// Returns normalized string/number — never throws on missing or unexpected types.
function extractFile(finding) {
  const loc = finding && typeof finding.location === 'object' ? finding.location : null;
  const raw =
    (loc && (loc.file || loc.path)) ||
    finding.file ||
    finding.path ||
    // Some legacy emitters put the full path straight in `location` as a string.
    (typeof finding.location === 'string' ? finding.location : '') ||
    '';
  return String(raw).replace(/\\/g, '/');
}

function extractLine(finding) {
  const loc = finding && typeof finding.location === 'object' ? finding.location : null;
  const raw = (loc && (loc.line ?? loc.lineNumber)) ?? finding.line ?? finding.lineNumber ?? 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

// F-17 fix: word-overlap similarity to prevent collapsing semantically distinct findings
function titlesAreSimilar(a, b) {
  const wordsA = new Set(a.split(/\W+/).filter((w) => w.length > 3));
  const wordsB = new Set(b.split(/\W+/).filter((w) => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return true; // empty titles → assume similar
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  const smaller = Math.min(wordsA.size, wordsB.size);
  return overlap / smaller >= 0.5; // at least 50% word overlap
}

// ── Dedup Engine ────────────────────────────────────────────

const LINE_PROXIMITY = 5; // Lines within this range are "near"

function dedupFindings(findings) {
  const result = {
    unique: [],
    duplicates: [],
    related: [], // Cross-prefix matches (linked, not removed)
  };

  // Index for fast lookup
  const seen = new Map(); // key: "file:line:prefix" → finding
  const fileLineMap = new Map(); // key: "file:line" → [findings]

  for (const finding of findings) {
    const file = extractFile(finding);
    const line = extractLine(finding);
    const prefix = extractPrefix(finding.id);
    const category = getCategory(prefix);

    // Exact match: same file + line + prefix
    const exactKey = `${file}:${line}:${prefix}`;
    if (seen.has(exactKey)) {
      result.duplicates.push({
        finding: finding.id,
        duplicateOf: seen.get(exactKey).id,
        reason: 'exact-match (same file:line:prefix)',
      });
      continue;
    }

    // Near match: same file + overlapping line range + same category + similar title
    // F-17 fix: require title similarity to prevent collapsing distinct defects
    let isNearDup = false;
    for (const [key, existing] of seen) {
      const [eFile, eLine, ePrefix] = key.split(':');
      if (eFile !== file) continue;
      if (Math.abs(parseInt(eLine, 10) - line) > LINE_PROXIMITY) continue;
      if (getCategory(ePrefix) !== category) continue;

      // Semantic check: titles must be similar to merge (prevents SQL injection + missing auth collapse)
      const titleA = (finding.title || finding.description || '').toLowerCase();
      const titleB = (existing.title || existing.description || '').toLowerCase();
      if (titleA && titleB && !titlesAreSimilar(titleA, titleB)) continue;

      // Same category, same file, nearby lines, similar title → near duplicate
      result.duplicates.push({
        finding: finding.id,
        duplicateOf: existing.id,
        reason: `near-match (${category} category, lines ${eLine} vs ${line})`,
      });
      isNearDup = true;
      break;
    }
    if (isNearDup) continue;

    // Cross-prefix match: same file + same line + different prefix → related
    const fileLineKey = `${file}:${line}`;
    if (fileLineMap.has(fileLineKey)) {
      const existingFindings = fileLineMap.get(fileLineKey);
      for (const ef of existingFindings) {
        result.related.push({
          finding1: ef.id,
          finding2: finding.id,
          reason: `cross-prefix at ${file}:${line} (${extractPrefix(ef.id)} + ${prefix})`,
        });
      }
    }

    // Register
    seen.set(exactKey, finding);
    if (!fileLineMap.has(fileLineKey)) fileLineMap.set(fileLineKey, []);
    fileLineMap.get(fileLineKey).push(finding);
    result.unique.push(finding);
  }

  return result;
}

// ── CLI ─────────────────────────────────────────────────────

function cmdDedup(args) {
  const inputIdx = args.indexOf('--input');
  const inputPath = inputIdx !== -1 && args[inputIdx + 1] ? args[inputIdx + 1] : null;
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx !== -1 && args[outputIdx + 1] ? args[outputIdx + 1] : null;
  const jsonMode = args.includes('--json');

  if (!inputPath) {
    console.error('Usage: node tools/cobolt-finding-dedup.js dedup --input <findings.json>');
    process.exit(2);
  }

  if (!fs.existsSync(inputPath)) {
    console.error(`[cobolt-finding-dedup] File not found: ${inputPath}`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const findings = data.findings || data || [];

  if (!Array.isArray(findings) || findings.length === 0) {
    console.log('[cobolt-finding-dedup] No findings to dedup.');
    process.exit(1);
  }

  const result = dedupFindings(findings);
  const stats = {
    input: findings.length,
    unique: result.unique.length,
    duplicates: result.duplicates.length,
    related: result.related.length,
    reductionPct: findings.length > 0 ? Math.round((result.duplicates.length / findings.length) * 100) : 0,
  };

  const output = {
    ...stats,
    timestamp: new Date().toISOString(),
    generatedBy: 'cobolt-finding-dedup',
    findings: result.unique,
    duplicateLog: result.duplicates,
    relatedFindings: result.related,
  };

  if (jsonMode) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`[cobolt-finding-dedup] Deduplication Results`);
    console.log(`  Input: ${stats.input} findings`);
    console.log(`  Unique: ${stats.unique} (${100 - stats.reductionPct}%)`);
    console.log(`  Duplicates removed: ${stats.duplicates} (${stats.reductionPct}%)`);
    console.log(`  Cross-prefix related: ${stats.related}`);
    if (result.duplicates.length > 0) {
      console.log('');
      console.log('  Duplicates:');
      for (const d of result.duplicates.slice(0, 10)) {
        console.log(`    ${d.finding} → dup of ${d.duplicateOf} (${d.reason})`);
      }
      if (result.duplicates.length > 10) {
        console.log(`    ... and ${result.duplicates.length - 10} more`);
      }
    }
  }

  // Write deduped output alongside input
  const outPath = outputPath || inputPath.replace('.json', '-deduped.json');
  fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  if (!jsonMode) console.log(`\n  Written: ${outPath}`);

  process.exit(0);
}

function cmdStats(args) {
  const inputIdx = args.indexOf('--input');
  const inputPath = inputIdx !== -1 && args[inputIdx + 1] ? args[inputIdx + 1] : null;

  if (!inputPath || !fs.existsSync(inputPath)) {
    console.error('Usage: node tools/cobolt-finding-dedup.js stats --input <findings.json>');
    process.exit(2);
  }

  const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const findings = data.findings || data || [];
  const result = dedupFindings(findings);

  console.log(`${findings.length} → ${result.unique.length} (${result.duplicates.length} dupes removed)`);
  process.exit(0);
}

if (require.main === module) {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case 'dedup':
    case 'deduplicate':
      cmdDedup(args);
      break;
    case 'stats':
      cmdStats(args);
      break;
    default:
      console.log('CoBolt Finding Dedup — Deterministic first-pass deduplication');
      console.log('');
      console.log('Usage:');
      console.log('  node tools/cobolt-finding-dedup.js dedup --input <findings.json> [--output <path>] [--json]');
      console.log(
        '  node tools/cobolt-finding-dedup.js deduplicate --input <findings.json> [--output <path>] [--json]',
      );
      console.log('  node tools/cobolt-finding-dedup.js stats --input <findings.json>');
      console.log('');
      console.log('Rules: exact (file:line:prefix), near (±5 lines, same category),');
      console.log('       cross-prefix (same file:line, different prefix → linked).');
      process.exit(command ? 2 : 0);
  }
}

module.exports = { dedupFindings, extractPrefix, getCategory };
