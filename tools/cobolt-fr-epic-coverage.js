#!/usr/bin/env node

// CoBolt FR -> epic coverage tool (F4 — v0.53+).
//
// Closes the deeper half of the C3 (story/milestone count mismatch) class
// observed in RawDrive042026: the packet shipped with 73/177 FRs (41%)
// referenced from epics. The existing cobolt-source-coverage tool checks the
// SRC-doc -> FR axis; cobolt-feature-coverage checks the feature-registry
// surface. Neither checks "every FR in rtm.json appears in epics.md (or its
// stories)" — and that gap let the partial-coverage planning packet through
// the plan-close gate.
//
// What this tool checks (census, not sampling):
//   1. Read rtm.json. Collect every requirement id whose prefix === 'FR'.
//      That is the canonical FR set. (Other prefixes are ignored here; their
//      coverage is enforced by other tools — implicit-requirements gate, etc.)
//   2. Read epics.md and every stories/*.md (recursively). Collect FR refs
//      via lib/cobolt-requirements.js::extractRequirementReferences.
//   3. Compute coverage = |covered FR set| / |canonical FR set| * 100.
//   4. Pass when coverage >= --threshold (default 100).
//
// CLI:
//   node tools/cobolt-fr-epic-coverage.js check [--threshold N] [--json]
//   node tools/cobolt-fr-epic-coverage.js status
//
// Exit codes (per tools/CLAUDE.md contract):
//   0 = real success (coverage >= threshold)
//   1 = real failure (coverage < threshold) OR misuse
//   3 = missing infrastructure (planning dir or rtm.json not found — gate
//       interpretation: skip-and-report at Tier 2, fail at Tier 1).

const fs = require('node:fs');
const path = require('node:path');

const { getPlanningDir } = require('../lib/cobolt-planning-artifacts');
const {
  extractRequirementReferences,
  canonicalizeRequirementId,
  requirementPrefix,
} = require('../lib/cobolt-requirements.js');

function parseArgs(argv) {
  const out = { command: null, threshold: 100, json: false, target: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === 'check' || arg === 'status') {
      out.command = arg;
    } else if (arg === '--threshold') {
      const next = argv[++i];
      const n = Number(next);
      if (Number.isFinite(n) && n >= 0 && n <= 100) out.threshold = n;
    } else if (arg === '--json') {
      out.json = true;
    } else if (arg === '--target') {
      out.target = argv[++i] || null;
    } else if (arg === '--help' || arg === '-h') {
      out.command = 'help';
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(
    [
      'cobolt-fr-epic-coverage — verify every FR in rtm.json appears in epics.md (or stories/*.md)',
      '',
      'Usage:',
      '  node tools/cobolt-fr-epic-coverage.js check [--threshold N] [--json]',
      '  node tools/cobolt-fr-epic-coverage.js status',
      '',
      'Exit codes:',
      '  0  coverage >= threshold (default 100)',
      '  1  coverage < threshold (real failure)',
      '  3  planning dir or rtm.json not found (missing infrastructure)',
      '',
      'Closes the deeper half of the C3 (story/milestone count mismatch) class',
      'observed in RawDrive042026 (73/177 FRs referenced from epics).',
      '',
    ].join('\n'),
  );
}

function readRtmFrSet(planningDir) {
  const rtmPath = path.join(planningDir, 'rtm.json');
  if (!fs.existsSync(rtmPath)) {
    return { ok: false, reason: 'rtm.json not found', frSet: new Set() };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(rtmPath, 'utf8'));
  } catch (err) {
    return { ok: false, reason: `rtm.json malformed: ${err.message}`, frSet: new Set() };
  }
  const set = new Set();
  const reqs = parsed?.requirements;
  if (reqs && typeof reqs === 'object') {
    for (const id of Object.keys(reqs)) {
      const prefix = requirementPrefix(id);
      if (prefix !== 'FR') continue;
      const canonical = canonicalizeRequirementId(id) || id;
      set.add(canonical);
    }
  } else if (Array.isArray(parsed?.entries)) {
    for (const entry of parsed.entries) {
      const id = entry?.id || entry?.requirementId;
      if (!id) continue;
      const prefix = requirementPrefix(id);
      if (prefix !== 'FR') continue;
      const canonical = canonicalizeRequirementId(id) || id;
      set.add(canonical);
    }
  }
  return { ok: true, frSet: set, total: set.size };
}

function readEpicAndStoryRefs(planningDir) {
  const refs = new Set();
  const sources = [];
  const epicsPath = path.join(planningDir, 'epics.md');
  if (fs.existsSync(epicsPath)) {
    sources.push({ kind: 'epics.md', path: epicsPath });
    for (const id of extractRequirementReferences(fs.readFileSync(epicsPath, 'utf8'))) {
      const prefix = requirementPrefix(id);
      if (prefix !== 'FR') continue;
      const canonical = canonicalizeRequirementId(id) || id;
      refs.add(canonical);
    }
  }
  const storiesDir = path.join(planningDir, 'stories');
  if (fs.existsSync(storiesDir)) {
    walkMarkdown(storiesDir).forEach((p) => {
      sources.push({ kind: 'story', path: p });
      for (const id of extractRequirementReferences(fs.readFileSync(p, 'utf8'))) {
        const prefix = requirementPrefix(id);
        if (prefix !== 'FR') continue;
        const canonical = canonicalizeRequirementId(id) || id;
        refs.add(canonical);
      }
    });
  }
  return { refs, sources };
}

function walkMarkdown(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkMarkdown(p));
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

function evaluate(options = {}) {
  const projectRoot = options.target || process.cwd();
  const planningDir = getPlanningDir(projectRoot, { create: false, strict: false, fallbackToLatest: true });
  if (!planningDir || !fs.existsSync(planningDir)) {
    return {
      passed: false,
      coverage: 0,
      threshold: options.threshold ?? 100,
      total: 0,
      covered: 0,
      missing: [],
      skipped: true,
      reason: 'planning directory not found',
      sources: [],
    };
  }

  const rtm = readRtmFrSet(planningDir);
  if (!rtm.ok) {
    return {
      passed: false,
      coverage: 0,
      threshold: options.threshold ?? 100,
      total: 0,
      covered: 0,
      missing: [],
      skipped: true,
      reason: rtm.reason,
      sources: [],
    };
  }
  if (rtm.frSet.size === 0) {
    return {
      passed: true,
      coverage: 100,
      threshold: options.threshold ?? 100,
      total: 0,
      covered: 0,
      missing: [],
      skipped: false,
      reason: 'rtm.json contains no FR requirements; coverage is vacuously 100%',
      sources: [],
    };
  }

  const { refs, sources } = readEpicAndStoryRefs(planningDir);
  const missing = [];
  let covered = 0;
  for (const id of rtm.frSet) {
    if (refs.has(id)) covered += 1;
    else missing.push(id);
  }
  const total = rtm.frSet.size;
  const coverage = total === 0 ? 100 : Math.round((covered / total) * 1000) / 10;
  const threshold = options.threshold ?? 100;
  return {
    passed: coverage >= threshold,
    coverage,
    threshold,
    total,
    covered,
    missing: missing.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    skipped: false,
    reason: null,
    sources,
  };
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.command === 'help' || !args.command) {
    printHelp();
    process.exit(args.command === 'help' ? 0 : 1);
  }
  const result = evaluate({ threshold: args.threshold, target: args.target });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (args.command === 'status') {
    if (result.skipped) {
      process.stdout.write(`SKIPPED: ${result.reason}\n`);
    } else {
      process.stdout.write(
        `FR -> epic coverage: ${result.covered}/${result.total} (${result.coverage}%) — threshold ${result.threshold}% — ${result.passed ? 'PASS' : 'FAIL'}\n`,
      );
      if (!result.passed && result.missing.length > 0) {
        process.stdout.write(`Missing FRs (first 20): ${result.missing.slice(0, 20).join(', ')}\n`);
      }
    }
  } else {
    if (result.skipped) {
      process.stdout.write(`FR -> epic coverage SKIPPED: ${result.reason}\n`);
    } else if (result.passed) {
      process.stdout.write(`FR -> epic coverage PASS: ${result.covered}/${result.total} (${result.coverage}%)\n`);
    } else {
      process.stdout.write(
        `FR -> epic coverage FAIL: ${result.covered}/${result.total} (${result.coverage}% < ${result.threshold}%)\n`,
      );
      if (result.missing.length > 0) {
        process.stdout.write(`Missing: ${result.missing.slice(0, 20).join(', ')}`);
        if (result.missing.length > 20) process.stdout.write(` (+${result.missing.length - 20} more)`);
        process.stdout.write('\n');
      }
    }
  }
  if (result.skipped) process.exit(3);
  process.exit(result.passed ? 0 : 1);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { evaluate, readRtmFrSet, readEpicAndStoryRefs, parseArgs };
