#!/usr/bin/env node

// CoBolt TR -> epic coverage tool (Ship 3, v0.54+).
//
// Mirror of cobolt-fr-epic-coverage.js, scoped to TR-NNN (Technical
// Requirement) IDs from the TRD instead of FR-NNN.
//
// What this tool checks (census, not sampling):
//   1. Read rtm.json. Collect every requirement id whose prefix === 'TR'
//      (and TRD-NNN treated as canonical TR-NNN per cobolt-requirements.js).
//   2. Read epics.md and every stories/*.md (recursively). Collect TR refs.
//   3. Compute coverage = |covered TR set| / |canonical TR set| * 100.
//   4. Pass when coverage >= --threshold (default 100).
//
// CLI:
//   node tools/cobolt-trd-epic-coverage.js check [--threshold N] [--json]
//   node tools/cobolt-trd-epic-coverage.js status
//
// Exit codes (per tools/CLAUDE.md contract):
//   0 = real success (coverage >= threshold)
//   1 = real failure (coverage < threshold) OR misuse
//   3 = missing infrastructure (planning dir or rtm.json not found)
//
// Bypass: COBOLT_TRD_EPIC_COVERAGE_GATE=off (Tier 1 — bypass logged to
// _cobolt-output/audit/gate-skip-log.jsonl + master kill COBOLT_V12_GATES=bypass).

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
      'cobolt-trd-epic-coverage — verify every TR in rtm.json appears in epics.md (or stories/*.md)',
      '',
      'Usage:',
      '  node tools/cobolt-trd-epic-coverage.js check [--threshold N] [--json]',
      '  node tools/cobolt-trd-epic-coverage.js status',
      '',
      'Exit codes:',
      '  0  coverage >= threshold (default 100)',
      '  1  coverage < threshold (real failure)',
      '  3  planning dir or rtm.json not found (missing infrastructure)',
      '',
      'Mirror of cobolt-fr-epic-coverage scoped to TR-NNN (Technical Requirements).',
      'Closes the gap that lets a TRD ship without any epic/story actually consuming',
      'the technical requirements declared in it.',
      '',
      'Bypass: COBOLT_TRD_EPIC_COVERAGE_GATE=off (Tier 1 — logged).',
      '',
    ].join('\n'),
  );
}

function readRtmTrSet(planningDir) {
  const rtmPath = path.join(planningDir, 'rtm.json');
  if (!fs.existsSync(rtmPath)) {
    return { ok: false, reason: 'rtm.json not found', trSet: new Set() };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(rtmPath, 'utf8'));
  } catch (err) {
    return { ok: false, reason: `rtm.json malformed: ${err.message}`, trSet: new Set() };
  }
  const set = new Set();
  const reqs = parsed?.requirements;
  if (reqs && typeof reqs === 'object') {
    for (const id of Object.keys(reqs)) {
      const prefix = requirementPrefix(id);
      if (prefix !== 'TR' && prefix !== 'TRD') continue;
      const canonical = canonicalizeRequirementId(id) || id;
      set.add(canonical);
    }
  } else if (Array.isArray(parsed?.entries)) {
    for (const entry of parsed.entries) {
      const id = entry?.id || entry?.requirementId;
      if (!id) continue;
      const prefix = requirementPrefix(id);
      if (prefix !== 'TR' && prefix !== 'TRD') continue;
      const canonical = canonicalizeRequirementId(id) || id;
      set.add(canonical);
    }
  }
  return { ok: true, trSet: set, total: set.size };
}

function readEpicAndStoryRefs(planningDir) {
  const refs = new Set();
  const sources = [];
  const epicsPath = path.join(planningDir, 'epics.md');
  if (fs.existsSync(epicsPath)) {
    sources.push({ kind: 'epics.md', path: epicsPath });
    for (const id of extractRequirementReferences(fs.readFileSync(epicsPath, 'utf8'))) {
      const prefix = requirementPrefix(id);
      if (prefix !== 'TR' && prefix !== 'TRD') continue;
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
        if (prefix !== 'TR' && prefix !== 'TRD') continue;
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

  const rtm = readRtmTrSet(planningDir);
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
  if (rtm.trSet.size === 0) {
    return {
      passed: true,
      coverage: 100,
      threshold: options.threshold ?? 100,
      total: 0,
      covered: 0,
      missing: [],
      skipped: false,
      reason: 'rtm.json contains no TR requirements; coverage is vacuously 100%',
      sources: [],
    };
  }

  const { refs, sources } = readEpicAndStoryRefs(planningDir);
  const missing = [];
  let covered = 0;
  for (const id of rtm.trSet) {
    if (refs.has(id)) covered += 1;
    else missing.push(id);
  }
  const total = rtm.trSet.size;
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
        `TR -> epic coverage: ${result.covered}/${result.total} (${result.coverage}%) — threshold ${result.threshold}% — ${result.passed ? 'PASS' : 'FAIL'}\n`,
      );
      if (!result.passed && result.missing.length > 0) {
        process.stdout.write(`Missing TRs (first 20): ${result.missing.slice(0, 20).join(', ')}\n`);
      }
    }
  } else {
    if (result.skipped) {
      process.stdout.write(`TR -> epic coverage SKIPPED: ${result.reason}\n`);
    } else if (result.passed) {
      process.stdout.write(`TR -> epic coverage PASS: ${result.covered}/${result.total} (${result.coverage}%)\n`);
    } else {
      process.stdout.write(
        `TR -> epic coverage FAIL: ${result.covered}/${result.total} (${result.coverage}% < ${result.threshold}%)\n`,
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

module.exports = { evaluate, readRtmTrSet, readEpicAndStoryRefs, parseArgs };
