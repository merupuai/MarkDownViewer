#!/usr/bin/env node

// CoBolt Source Semantic Coverage — detects "citation-only" downstream coverage
// of source documents. An epic or story may cite SRC-001 but contain none of the
// source's substantive terms; the existing cobolt-source-coverage tool treats
// that as "covered" because it does keyword-based overlap with a loose threshold.
//
// This tool adds a stricter check: for every SRC-* with a >=20-char intent,
// compute the unique non-stopword term overlap between the source and every
// downstream artifact that cites it. If < N unique overlapping terms, flag as
// citation-only.
//
// Commands:
//   check [--threshold 3] [--json]
//
// Exit codes:
//   0 = all SRC-* entries have substantive semantic overlap
//   1 = usage error
//   2 = source-document-consolidation.md missing (Tier 2 skip)
//   6 = one or more SRC-* citation-only entries detected

const fs = require('node:fs');
const path = require('node:path');
const { getPlanningDir } = require('../lib/cobolt-planning-artifacts');
const { parseSourceRegistry } = require('./cobolt-source-coverage');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_MISSING = 2;
const EXIT_CITATION_ONLY = 6;

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'for',
  'in',
  'on',
  'at',
  'by',
  'to',
  'from',
  'with',
  'and',
  'or',
  'but',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'has',
  'have',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'shall',
  'can',
  'must',
  'this',
  'that',
  'these',
  'those',
  'as',
  'if',
  'then',
  'else',
  'when',
  'where',
  'which',
  'who',
  'whom',
  'what',
  'why',
  'how',
  'all',
  'any',
  'some',
  'each',
  'every',
  'both',
  'either',
  'neither',
  'not',
  'no',
  'yes',
  'it',
  'its',
  'their',
  'they',
  'them',
  'we',
  'us',
  'our',
  'you',
  'your',
  // Domain-generic words that don't prove intent alignment
  'feature',
  'requirement',
  'system',
  'app',
  'application',
  'user',
  'users',
  'screen',
  'page',
  'flow',
  'data',
  'info',
  'information',
  'item',
  'entry',
  'record',
  'value',
  'field',
  'module',
  'component',
  'function',
  'method',
  'api',
  'service',
  'work',
  'working',
  'works',
  'build',
  'create',
  'update',
  'delete',
  'remove',
  'add',
  'use',
  'used',
  'using',
  'make',
  'made',
  'need',
  'needed',
  'want',
  'show',
  'shows',
  'display',
  'provide',
  'support',
]);

const DOWNSTREAM_FILES = [
  'epics.md',
  'milestones.md',
  'prd.md',
  'trd.md',
  'system-architecture.md',
  'architecture.md',
  'api-contracts.md',
  'capability-contracts.md',
  'capability-contracts-index.md',
  'security-requirements.md',
  'secure-coding-standard.md',
  'ux-design-specification.md',
  'data-model-spec.md',
  'data-model.md',
  'feature-service-blueprints.md',
  'feature-registry.json',
  'rtm.json',
  'traceability-matrix.md',
  'test-strategy.md',
  'readiness-report.md',
];

const DOSSIER_DIRS = ['feature-dossiers', 'features', 'dossiers', 'capabilities'];
const STORY_DIRS = ['stories', 'spec-kits'];

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function argValue(argv, flag, fallback) {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  return argv[i + 1];
}

function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function tokenize(text) {
  if (!text) return new Set();
  const t = text.toLowerCase();
  const words = t.match(/[a-z][a-z0-9-]{2,}/g) || [];
  return new Set(words.filter((w) => !STOPWORDS.has(w)));
}

function walk(dir, cb) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, cb);
    else if (entry.isFile()) cb(full);
  }
}

function parseSourceEntries(text) {
  const registryEntries = parseSourceRegistry(text)
    .filter((entry) => String(entry.status || '').toLowerCase() === 'included')
    .map((entry) => ({
      id: entry.id.toUpperCase(),
      intent: entry.summary,
      sourceFile: entry.sourceFile,
      category: entry.category,
      status: entry.status,
    }));
  if (registryEntries.length > 0) return registryEntries;

  // Fallback for older packets that used SRC-NNN headings or bullet entries:
  // "SRC-001: intent ...".
  if (!text) return [];
  const entries = [];
  const sectionRe = /^(?:#{1,4}\s+|\s*[-*+]\s+|\|\s*)?\**\s*(SRC-[A-Z0-9-]+)\s*\**\s*[:\u2013\u2014|-]\s*(.+?)\s*$/gim;
  for (const m of text.matchAll(sectionRe)) {
    const id = m[1].toUpperCase();
    const intent = (m[2] || '').trim();
    if (!entries.find((e) => e.id === id)) {
      entries.push({ id, intent });
    }
  }
  return entries;
}

function collectDownstreamCitations(pd, srcId) {
  const citations = []; // { file, content }
  const push = (file, content) => {
    if (content?.includes(srcId)) citations.push({ file, content });
  };

  for (const name of DOWNSTREAM_FILES) {
    const fp = path.join(pd, name);
    push(path.relative(pd, fp), readText(fp));
  }
  for (const dir of DOSSIER_DIRS) {
    const dp = path.join(pd, dir);
    if (!fs.existsSync(dp)) continue;
    walk(dp, (file) => {
      if (!/\.md$/i.test(file)) return;
      push(path.relative(pd, file), readText(file));
    });
  }
  for (const dir of STORY_DIRS) {
    const dp = path.join(pd, dir);
    if (!fs.existsSync(dp)) continue;
    walk(dp, (file) => {
      if (!/\.md$/i.test(file)) return;
      push(path.relative(pd, file), readText(file));
    });
  }
  return citations;
}

function computeOverlap(srcIntent, downstreamText) {
  const srcTerms = tokenize(srcIntent);
  const dstTerms = tokenize(downstreamText);
  const overlap = new Set();
  for (const t of srcTerms) if (dstTerms.has(t)) overlap.add(t);
  return { overlap, srcTerms };
}

function check(pd, opts) {
  const srcFile = path.join(pd, 'source-document-consolidation.md');
  if (!fs.existsSync(srcFile)) {
    return { verdict: 'SKIP', reason: 'source-document-consolidation.md not found', exitCode: EXIT_MISSING };
  }
  const srcText = readText(srcFile);
  const entries = parseSourceEntries(srcText);

  const results = [];
  const citationOnly = [];

  for (const entry of entries) {
    if (!entry.intent || entry.intent.length < 20) {
      results.push({ id: entry.id, status: 'skipped', reason: 'intent too short' });
      continue;
    }
    const citations = collectDownstreamCitations(pd, entry.id);
    if (citations.length === 0) {
      results.push({ id: entry.id, status: 'uncited' });
      continue;
    }

    // Aggregate overlap across all downstream citations (union of covering text).
    const bag = citations.map((c) => c.content).join('\n');
    const { overlap, srcTerms } = computeOverlap(entry.intent, bag);

    const entryResult = {
      id: entry.id,
      citations: citations.length,
      srcTermCount: srcTerms.size,
      overlapCount: overlap.size,
      overlapTerms: [...overlap].slice(0, 10),
    };

    if (overlap.size < opts.threshold) {
      entryResult.status = 'citation-only';
      citationOnly.push(entryResult);
    } else {
      entryResult.status = 'covered';
    }
    results.push(entryResult);
  }

  const verdict = citationOnly.length === 0 ? 'PASS' : 'CITATION_ONLY';
  return {
    verdict,
    threshold: opts.threshold,
    total: entries.length,
    citationOnlyCount: citationOnly.length,
    citationOnly: citationOnly.slice(0, 50),
    results,
    exitCode: verdict === 'PASS' ? EXIT_OK : EXIT_CITATION_ONLY,
  };
}

function main(argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'check';
  const json = hasFlag(args, '--json');
  const threshold = parseInt(argValue(args, '--threshold', '3'), 10);

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('Usage: cobolt-source-semantic-coverage.js check [--threshold 3] [--json]');
    process.exit(EXIT_OK);
  }

  if (cmd !== 'check') {
    console.error(`Unknown command: ${cmd}`);
    process.exit(EXIT_USAGE);
  }

  const pd = getPlanningDir(process.cwd(), { create: false, fallbackToLatest: true });
  if (!pd || !fs.existsSync(pd)) {
    const out = { verdict: 'SKIP', reason: 'no planning directory' };
    if (json) console.log(JSON.stringify(out, null, 2));
    else console.log('no planning directory');
    process.exit(EXIT_MISSING);
  }

  const result = check(pd, { threshold });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('== Source Semantic Coverage ==');
    console.log(`threshold: ${result.threshold}`);
    console.log(`total SRC entries: ${result.total ?? 0}`);
    console.log(`citation-only:     ${result.citationOnlyCount ?? 0}`);
    for (const co of (result.citationOnly || []).slice(0, 20)) {
      console.log(
        `  - ${co.id} overlap=${co.overlapCount}/${co.srcTermCount} terms: [${(co.overlapTerms || []).join(', ')}]`,
      );
    }
    console.log(`verdict: ${result.verdict}`);
  }

  process.exit(result.exitCode);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { check, parseSourceEntries, tokenize };
