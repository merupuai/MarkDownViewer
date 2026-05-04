#!/usr/bin/env node

// CoBolt Anti-Patterns — Failure knowledge store
//
// Records failed approaches with evidence, enabling agents to check
// "what has been tried and failed" before attempting similar approaches.
// Failed patterns stored with HIGH confidence (failures are valuable).
//
// Key insight: Knowing what NOT to do is as valuable as knowing what to do.
// Anti-patterns decay slower than lessons (60-day half-life) because
// failure knowledge remains relevant longer.
//
// Usage:
//   node tools/cobolt-anti-patterns.js record --category <cat> --description <desc> [--evidence <text>] [--stage <s>] [--agent <a>]
//   node tools/cobolt-anti-patterns.js query <text> [--category <cat>] [--top 5]
//   node tools/cobolt-anti-patterns.js list [--category <cat>] [--limit 20]
//   node tools/cobolt-anti-patterns.js check <approach-description>      # Quick check: has this been tried?
//   node tools/cobolt-anti-patterns.js prune [--max-age 180]
//   node tools/cobolt-anti-patterns.js stats
//   node tools/cobolt-anti-patterns.js export [--format md|json]
//
// Exit codes: 0 = success, 1 = no data/no match, 2 = usage error

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { atomicWrite } = require('../lib/cobolt-atomic-write');

// ── Configuration ──────────────────────────────────────────

const HALF_LIFE_DAYS = 60; // Slower decay than evolution lessons
const MAX_AGE_DAYS = 180; // Keep failures longer
const MAX_ENTRIES = 500;

const CATEGORIES = [
  'architecture', // Structural approaches that failed
  'dependency', // Package/version choices that caused issues
  'configuration', // Config patterns that broke things
  'testing', // Test strategies that gave false confidence
  'deployment', // Deploy approaches that failed
  'security', // Security patterns that were insufficient
  'performance', // Optimization approaches that backfired
  'agent-strategy', // Agent dispatch strategies that failed
  'fix-approach', // Fix strategies that didn't resolve the issue
  'general', // Other
];

// ── Path Resolution ────────────────────────────────────────

function storeDir() {
  return path.join(process.cwd(), '_cobolt-output/evolution');
}

function storeFile() {
  return path.join(storeDir(), 'anti-patterns.jsonl');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readJsonl(fp) {
  if (!fs.existsSync(fp)) return [];
  return fs
    .readFileSync(fp, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function writeJsonl(fp, entries) {
  atomicWrite(fp, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`, { mode: 0o600 });
}

// ── Time Decay ─────────────────────────────────────────────

function timeDecayWeight(createdAt) {
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays < 0) return 1.0;
  if (ageDays > MAX_AGE_DAYS) return 0.0;
  return Math.exp((-ageDays * Math.LN2) / HALF_LIFE_DAYS);
}

// ── Token-Based Similarity ─────────────────────────────────
// Simple but effective: tokenize → compute Jaccard similarity

function tokenize(text) {
  return new Set(
    (text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3),
  );
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// ── Record Anti-Pattern ────────────────────────────────────

function recordAntiPattern(opts) {
  const { category, description, evidence, stage, agent, milestone, findingIds } = opts;

  if (!description || description.length < 10) {
    throw new Error('Description must be at least 10 characters');
  }

  const validCategory = CATEGORIES.includes(category) ? category : 'general';

  const entry = {
    id: `AP-${crypto.createHash('sha256').update(description).digest('hex').slice(0, 10)}`,
    category: validCategory,
    description,
    evidence: evidence || '',
    stage: stage || 'unknown',
    agent: agent || 'unknown',
    milestone: milestone || 'unknown',
    findingIds: findingIds || [],
    confidence: 0.7, // Failures start with high confidence
    accessCount: 0,
    createdAt: new Date().toISOString(),
    lastAccessed: null,
  };

  // Check for duplicates
  const existing = readJsonl(storeFile());
  const isDuplicate = existing.some((e) => e.id === entry.id);
  if (isDuplicate) {
    // Boost confidence of existing entry
    const idx = existing.findIndex((e) => e.id === entry.id);
    existing[idx].confidence = Math.min(1.0, existing[idx].confidence + 0.1);
    existing[idx].accessCount++;
    existing[idx].lastAccessed = new Date().toISOString();
    if (evidence) existing[idx].evidence += `\n---\n${evidence}`;
    writeJsonl(storeFile(), existing);
    return { action: 'updated', entry: existing[idx] };
  }

  // Append new entry
  ensureDir(path.dirname(storeFile()));
  fs.appendFileSync(storeFile(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });

  // Enforce capacity
  enforceCapacity();

  return { action: 'created', entry };
}

function enforceCapacity() {
  const entries = readJsonl(storeFile());
  if (entries.length <= MAX_ENTRIES) return;

  // Sort by confidence (weighted by decay), keep top MAX_ENTRIES
  const scored = entries.map((e) => ({
    ...e,
    score: e.confidence * timeDecayWeight(e.createdAt),
  }));
  scored.sort((a, b) => b.score - a.score);

  writeJsonl(storeFile(), scored.slice(0, MAX_ENTRIES));
}

// ── Query Anti-Patterns ────────────────────────────────────

function queryAntiPatterns(queryText, category, topK) {
  const entries = readJsonl(storeFile());
  const queryTokens = tokenize(queryText);
  const k = topK || 5;

  const scored = entries
    .filter((e) => !category || e.category === category)
    .filter((e) => timeDecayWeight(e.createdAt) > 0.05) // Skip expired
    .map((entry) => {
      const descTokens = tokenize(entry.description);
      const evidenceTokens = tokenize(entry.evidence);

      // Combine description + evidence tokens
      const allTokens = new Set([...descTokens, ...evidenceTokens]);
      const similarity = jaccardSimilarity(queryTokens, allTokens);
      const decay = timeDecayWeight(entry.createdAt);
      const confidenceBoost = entry.confidence * 0.2;

      return {
        ...entry,
        relevanceScore: Math.round((similarity * 0.6 + decay * 0.2 + confidenceBoost) * 1000) / 1000,
        similarity: Math.round(similarity * 100) / 100,
      };
    })
    .filter((e) => e.relevanceScore > 0.05) // Filter noise
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, k);

  // Mark as accessed
  if (scored.length > 0) {
    const all = readJsonl(storeFile());
    const accessedIds = new Set(scored.map((s) => s.id));
    for (const entry of all) {
      if (accessedIds.has(entry.id)) {
        entry.accessCount = (entry.accessCount || 0) + 1;
        entry.lastAccessed = new Date().toISOString();
      }
    }
    writeJsonl(storeFile(), all);
  }

  return scored;
}

// ── Quick Check ────────────────────────────────────────────

function checkApproach(approachText) {
  const matches = queryAntiPatterns(approachText, null, 3);
  const highRelevance = matches.filter((m) => m.relevanceScore >= 0.2);

  return {
    hasWarnings: highRelevance.length > 0,
    warnings: highRelevance.map((m) => ({
      id: m.id,
      category: m.category,
      description: m.description,
      relevance: m.relevanceScore,
      confidence: m.confidence,
    })),
    message:
      highRelevance.length > 0
        ? `WARNING: ${highRelevance.length} similar approach(es) have failed before`
        : 'No matching anti-patterns found — approach appears novel',
  };
}

// ── Prune ──────────────────────────────────────────────────

function pruneEntries(maxAge) {
  const entries = readJsonl(storeFile());
  const cutoff = maxAge || MAX_AGE_DAYS;
  const now = Date.now();

  const kept = entries.filter((e) => {
    const ageDays = (now - new Date(e.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    return ageDays <= cutoff;
  });

  const pruned = entries.length - kept.length;
  if (pruned > 0) writeJsonl(storeFile(), kept);
  return { total: entries.length, kept: kept.length, pruned };
}

// ── Stats ──────────────────────────────────────────────────

function getStats() {
  const entries = readJsonl(storeFile());
  const active = entries.filter((e) => timeDecayWeight(e.createdAt) > 0.05);

  const byCategory = {};
  for (const e of active) {
    byCategory[e.category] = (byCategory[e.category] || 0) + 1;
  }

  const byStage = {};
  for (const e of active) {
    byStage[e.stage] = (byStage[e.stage] || 0) + 1;
  }

  const avgConfidence =
    active.length > 0 ? Math.round((active.reduce((sum, e) => sum + e.confidence, 0) / active.length) * 100) / 100 : 0;

  const mostAccessed = [...active].sort((a, b) => (b.accessCount || 0) - (a.accessCount || 0)).slice(0, 5);

  return {
    total: entries.length,
    active: active.length,
    expired: entries.length - active.length,
    byCategory,
    byStage,
    avgConfidence,
    mostAccessed: mostAccessed.map((e) => ({
      id: e.id,
      description: e.description.slice(0, 80),
      accessCount: e.accessCount,
    })),
    halfLifeDays: HALF_LIFE_DAYS,
    maxAgeDays: MAX_AGE_DAYS,
  };
}

// ── Export ──────────────────────────────────────────────────

function exportPatterns(format) {
  const entries = readJsonl(storeFile()).filter((e) => timeDecayWeight(e.createdAt) > 0.05);

  if (format === 'json') return JSON.stringify(entries, null, 2);

  // Markdown format
  const lines = ['# CoBolt Anti-Patterns', '', `> ${entries.length} active anti-patterns`, ''];

  const byCategory = {};
  for (const e of entries) {
    if (!byCategory[e.category]) byCategory[e.category] = [];
    byCategory[e.category].push(e);
  }

  for (const [cat, patterns] of Object.entries(byCategory)) {
    lines.push(`## ${cat}`, '');
    for (const p of patterns) {
      lines.push(`### ${p.id}: ${p.description.slice(0, 80)}`);
      lines.push(`- **Stage**: ${p.stage}`);
      lines.push(`- **Confidence**: ${(p.confidence * 100).toFixed(0)}%`);
      lines.push(`- **Recorded**: ${p.createdAt}`);
      if (p.evidence) lines.push(`- **Evidence**: ${p.evidence.slice(0, 200)}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ── CLI Commands ───────────────────────────────────────────

function cmdRecord(args) {
  const catIdx = args.indexOf('--category');
  const descIdx = args.indexOf('--description');
  const evIdx = args.indexOf('--evidence');
  const stIdx = args.indexOf('--stage');
  const agIdx = args.indexOf('--agent');
  const msIdx = args.indexOf('--milestone');

  const category = catIdx !== -1 && args[catIdx + 1] ? args[catIdx + 1] : 'general';
  const description = descIdx !== -1 && args[descIdx + 1] ? args[descIdx + 1] : null;
  const evidence = evIdx !== -1 && args[evIdx + 1] ? args[evIdx + 1] : '';
  const stage = stIdx !== -1 && args[stIdx + 1] ? args[stIdx + 1] : 'unknown';
  const agent = agIdx !== -1 && args[agIdx + 1] ? args[agIdx + 1] : 'unknown';
  const milestone = msIdx !== -1 && args[msIdx + 1] ? args[msIdx + 1] : 'unknown';

  if (!description) {
    console.error('Usage: node tools/cobolt-anti-patterns.js record --category <cat> --description "<text>"');
    process.exit(2);
  }

  const result = recordAntiPattern({ category, description, evidence, stage, agent, milestone });
  console.log(`[cobolt-anti-patterns] ${result.action}: ${result.entry.id} (${result.entry.category})`);
  console.log(`  ${result.entry.description.slice(0, 120)}`);
  process.exit(0);
}

function cmdQuery(args) {
  const queryText = args.filter((a) => !a.startsWith('--'))[0];
  if (!queryText) {
    console.error('Usage: node tools/cobolt-anti-patterns.js query "<text>" [--category <cat>] [--top 5]');
    process.exit(2);
  }

  const catIdx = args.indexOf('--category');
  const category = catIdx !== -1 && args[catIdx + 1] ? args[catIdx + 1] : null;
  const topIdx = args.indexOf('--top');
  const topK = topIdx !== -1 ? parseInt(args[topIdx + 1], 10) || 5 : 5;

  const results = queryAntiPatterns(queryText, category, topK);

  if (args.includes('--json')) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(`[cobolt-anti-patterns] ${results.length} match(es) for: "${queryText}"`);
    for (const r of results) {
      console.log(
        `  [${r.id}] ${r.category} (${(r.relevanceScore * 100).toFixed(0)}% relevant, ${(r.confidence * 100).toFixed(0)}% confident)`,
      );
      console.log(`    ${r.description.slice(0, 120)}`);
    }
  }
  process.exit(results.length > 0 ? 0 : 1);
}

function cmdCheck(args) {
  const approach = args.filter((a) => !a.startsWith('--')).join(' ');
  if (!approach) {
    console.error('Usage: node tools/cobolt-anti-patterns.js check "<approach description>"');
    process.exit(2);
  }

  const result = checkApproach(approach);

  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[cobolt-anti-patterns] ${result.message}`);
    for (const w of result.warnings) {
      console.log(
        `  [${w.id}] ${w.category}: ${w.description.slice(0, 100)} (${(w.relevance * 100).toFixed(0)}% match)`,
      );
    }
  }
  process.exit(result.hasWarnings ? 0 : 1);
}

function cmdList(args) {
  const catIdx = args.indexOf('--category');
  const category = catIdx !== -1 && args[catIdx + 1] ? args[catIdx + 1] : null;
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) || 20 : 20;

  const entries = readJsonl(storeFile())
    .filter((e) => timeDecayWeight(e.createdAt) > 0.05)
    .filter((e) => !category || e.category === category)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);

  if (args.includes('--json')) {
    console.log(JSON.stringify(entries, null, 2));
  } else {
    console.log(`[cobolt-anti-patterns] ${entries.length} active pattern(s)`);
    for (const e of entries) {
      console.log(`  [${e.id}] ${e.category} (${(e.confidence * 100).toFixed(0)}%): ${e.description.slice(0, 100)}`);
    }
  }
  process.exit(entries.length > 0 ? 0 : 1);
}

function cmdPrune(args) {
  const ageIdx = args.indexOf('--max-age');
  const maxAge = ageIdx !== -1 ? parseInt(args[ageIdx + 1], 10) : MAX_AGE_DAYS;
  const result = pruneEntries(maxAge);
  console.log(`[cobolt-anti-patterns] Pruned ${result.pruned} expired (kept ${result.kept}/${result.total})`);
  process.exit(0);
}

function cmdStats(args) {
  const stats = getStats();
  if (args.includes('--json')) {
    console.log(JSON.stringify(stats, null, 2));
  } else {
    console.log(`[cobolt-anti-patterns] ${stats.total} total, ${stats.active} active, ${stats.expired} expired`);
    console.log(`  Avg confidence: ${(stats.avgConfidence * 100).toFixed(0)}%`);
    console.log(
      `  Categories: ${Object.entries(stats.byCategory)
        .map(([k, v]) => `${k}(${v})`)
        .join(', ')}`,
    );
    if (stats.mostAccessed.length > 0) {
      console.log('  Most accessed:');
      for (const m of stats.mostAccessed) {
        console.log(`    ${m.id} (${m.accessCount}x): ${m.description}`);
      }
    }
  }
  process.exit(0);
}

function cmdExport(args) {
  const fmtIdx = args.indexOf('--format');
  const format = fmtIdx !== -1 && args[fmtIdx + 1] ? args[fmtIdx + 1] : 'md';
  console.log(exportPatterns(format));
  process.exit(0);
}

// ── Main ───────────────────────────────────────────────────

if (require.main === module) {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case 'record':
      cmdRecord(args);
      break;
    case 'query':
      cmdQuery(args);
      break;
    case 'check':
      cmdCheck(args);
      break;
    case 'list':
      cmdList(args);
      break;
    case 'prune':
      cmdPrune(args);
      break;
    case 'stats':
      cmdStats(args);
      break;
    case 'export':
      cmdExport(args);
      break;
    default:
      console.log('CoBolt Anti-Patterns — Failure knowledge store');
      console.log('');
      console.log('Usage:');
      console.log(
        '  node tools/cobolt-anti-patterns.js record --category <cat> --description "<text>" [--evidence "<text>"]',
      );
      console.log('  node tools/cobolt-anti-patterns.js query "<text>" [--category <cat>] [--top 5] [--json]');
      console.log('  node tools/cobolt-anti-patterns.js check "<approach>" [--json]');
      console.log('  node tools/cobolt-anti-patterns.js list [--category <cat>] [--limit 20] [--json]');
      console.log('  node tools/cobolt-anti-patterns.js prune [--max-age 180]');
      console.log('  node tools/cobolt-anti-patterns.js stats [--json]');
      console.log('  node tools/cobolt-anti-patterns.js export [--format md|json]');
      console.log('');
      console.log(`Categories: ${CATEGORIES.join(', ')}`);
      process.exit(command ? 2 : 0);
  }
}

module.exports = {
  recordAntiPattern,
  queryAntiPatterns,
  checkApproach,
  pruneEntries,
  getStats,
  exportPatterns,
  timeDecayWeight,
  jaccardSimilarity,
  tokenize,
  CATEGORIES,
};
