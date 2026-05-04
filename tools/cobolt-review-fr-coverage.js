#!/usr/bin/env node

// CoBolt review-FR-coverage tool (Phase 3 of v0.62 review-pipeline alignment).
//
// Closes the missing review-side analog of cobolt-fr-epic-coverage. The plan
// tool asserts every FR in rtm.json is referenced by epics/stories. This tool
// asserts every FR in rtm.json is cited by at least one review finding —
// either via findings[].requirementRefs[] (canonical) or as a substring in
// findings[].evidence / findings[].description (best-effort fallback).
//
// Why the substring fallback: many existing reviewers emit FR refs in the
// evidence narrative rather than a structured field. The verifier should not
// be defeated by reviewer-format drift.
//
// CLI:
//   node tools/cobolt-review-fr-coverage.js check [--threshold N] [--json]
//   node tools/cobolt-review-fr-coverage.js status
//
// Exit codes (per tools/CLAUDE.md):
//   0 — coverage >= threshold (default 100)
//   1 — coverage < threshold OR misuse OR malformed inputs
//   3 — missing infrastructure (planning dir / rtm.json / review-findings.json)
//
// Artifact: writes _cobolt-output/latest/review/review-fr-coverage.json with
//   { schemaVersion, generatedAt, threshold, totalFrs, coveredFrs[], gaps[],
//     coveragePercent, sources: { rtm, reviewFindings } }
//
// Programmatic API: module.exports = { computeCoverage, runCheck, parseArgs }

const fs = require('node:fs');
const path = require('node:path');

const { canonicalizeRequirementId, requirementPrefix } = require('../lib/cobolt-requirements.js');

const SCHEMA_VERSION = '1.0';
const ARTIFACT_REL_PATH = path.join('_cobolt-output', 'latest', 'review', 'review-fr-coverage.json');
const RTM_REL_PATH = path.join('_cobolt-output', 'latest', 'planning', 'rtm.json');
const FINDINGS_REL_PATH = path.join('_cobolt-output', 'latest', 'review', 'review-findings.json');

// FR-NNN or FR-NNNN canonical literal pattern. Distinct from the broader
// REQUIREMENT_REF_PATTERN — this is intentionally narrow for the substring
// fallback (we want canonical hits only; non-canonical IDs are filtered out
// by the producer-side review-finding-numbering-gate).
const FR_LITERAL = /\bFR-\d{3,4}\b/g;

function parseArgs(argv) {
  const out = { command: null, threshold: 100, json: false };
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
    } else if (arg === '--help' || arg === '-h') {
      out.command = 'help';
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(
    [
      'cobolt-review-fr-coverage — verify every FR in rtm.json is cited by at least one review finding.',
      '',
      'Usage:',
      '  node tools/cobolt-review-fr-coverage.js check [--threshold N] [--json]',
      '  node tools/cobolt-review-fr-coverage.js status',
      '',
      'Exit codes:',
      '  0  coverage >= threshold (default 100)',
      '  1  coverage < threshold OR misuse OR malformed inputs',
      '  3  missing planning dir, rtm.json, or review-findings.json',
      '',
      'Artifact: _cobolt-output/latest/review/review-fr-coverage.json',
      '',
    ].join('\n'),
  );
}

function readRtmFrSet(projectRoot) {
  const rtmPath = path.join(projectRoot, RTM_REL_PATH);
  if (!fs.existsSync(rtmPath)) {
    return { ok: false, missing: true, reason: 'rtm.json not found', frSet: new Set() };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(rtmPath, 'utf8'));
  } catch (err) {
    return { ok: false, malformed: true, reason: `rtm.json malformed: ${err.message}`, frSet: new Set() };
  }
  const set = new Set();
  const reqs = parsed?.requirements;
  if (reqs && typeof reqs === 'object') {
    for (const id of Object.keys(reqs)) {
      if (requirementPrefix(id) !== 'FR') continue;
      set.add(canonicalizeRequirementId(id) || id);
    }
  } else if (Array.isArray(parsed?.entries)) {
    for (const entry of parsed.entries) {
      const id = entry?.id || entry?.requirementId;
      if (!id || requirementPrefix(id) !== 'FR') continue;
      set.add(canonicalizeRequirementId(id) || id);
    }
  }
  return { ok: true, frSet: set };
}

function readFindingsRefs(projectRoot) {
  const findingsPath = path.join(projectRoot, FINDINGS_REL_PATH);
  if (!fs.existsSync(findingsPath)) {
    return { ok: false, missing: true, reason: 'review-findings.json not found', covered: new Set() };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
  } catch (err) {
    return { ok: false, malformed: true, reason: `review-findings.json malformed: ${err.message}`, covered: new Set() };
  }
  const covered = new Set();
  const findings = Array.isArray(parsed?.findings) ? parsed.findings : [];
  for (const finding of findings) {
    if (!finding || typeof finding !== 'object') continue;
    if (Array.isArray(finding.requirementRefs)) {
      for (const ref of finding.requirementRefs) {
        if (typeof ref !== 'string') continue;
        if (requirementPrefix(ref) !== 'FR') continue;
        covered.add(canonicalizeRequirementId(ref) || ref);
      }
    }
    // Best-effort substring scan in evidence + description.
    for (const field of ['evidence', 'description', 'recommendation', 'message']) {
      const text = finding[field];
      if (typeof text !== 'string') continue;
      const matches = text.match(FR_LITERAL);
      if (matches) {
        for (const m of matches) {
          covered.add(m);
        }
      }
    }
  }
  return { ok: true, covered };
}

function computeCoverage({ frSet, covered }) {
  const total = frSet.size;
  const coveredFrs = [];
  const gaps = [];
  for (const fr of frSet) {
    if (covered.has(fr)) coveredFrs.push(fr);
    else gaps.push(fr);
  }
  const coveragePercent = total === 0 ? 100 : Math.round((coveredFrs.length / total) * 100);
  return { totalFrs: total, coveredFrs: coveredFrs.sort(), gaps: gaps.sort(), coveragePercent };
}

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function writeArtifact(projectRoot, body) {
  const out = path.join(projectRoot, ARTIFACT_REL_PATH);
  ensureDir(out);
  fs.writeFileSync(out, JSON.stringify(body, null, 2));
}

function runCheck({ projectRoot, threshold = 100, json = false } = {}) {
  const root = projectRoot || process.cwd();
  const rtm = readRtmFrSet(root);
  if (!rtm.ok && rtm.missing) {
    return { exitCode: 3, message: rtm.reason, body: null };
  }
  if (!rtm.ok && rtm.malformed) {
    return { exitCode: 1, message: rtm.reason, body: null };
  }
  const refs = readFindingsRefs(root);
  if (!refs.ok && refs.missing) {
    return { exitCode: 3, message: refs.reason, body: null };
  }
  if (!refs.ok && refs.malformed) {
    return { exitCode: 1, message: refs.reason, body: null };
  }

  const cov = computeCoverage({ frSet: rtm.frSet, covered: refs.covered });
  const body = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    threshold,
    ...cov,
    sources: { rtm: RTM_REL_PATH, reviewFindings: FINDINGS_REL_PATH },
  };
  writeArtifact(root, body);

  if (cov.coveragePercent >= threshold) {
    if (json) process.stdout.write(JSON.stringify(body));
    return { exitCode: 0, body };
  }
  if (json) process.stdout.write(JSON.stringify(body));
  // Threshold-fail = quality-gate fail = exit 1 (per tools/CLAUDE.md). Reserve
  // exit 3 for genuine missing-infra paths (e.g. missing rtm/findings sources).
  return { exitCode: 1, body, message: `coverage ${cov.coveragePercent}% < ${threshold}%` };
}

function runStatus({ projectRoot, json = false } = {}) {
  const root = projectRoot || process.cwd();
  const out = path.join(root, ARTIFACT_REL_PATH);
  if (!fs.existsSync(out)) {
    if (json) process.stdout.write(JSON.stringify({ exists: false }));
    return { exitCode: 3 };
  }
  const body = JSON.parse(fs.readFileSync(out, 'utf8'));
  if (json) process.stdout.write(JSON.stringify(body));
  return { exitCode: 0, body };
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.command === 'help' || args.command === null) {
    printHelp();
    return 0;
  }
  if (args.command === 'check') {
    const result = runCheck({ threshold: args.threshold, json: args.json });
    if (result.message && !args.json) process.stderr.write(`${result.message}\n`);
    return result.exitCode;
  }
  if (args.command === 'status') {
    const result = runStatus({ json: args.json });
    return result.exitCode;
  }
  printHelp();
  return 1;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  parseArgs,
  computeCoverage,
  readRtmFrSet,
  readFindingsRefs,
  runCheck,
  runStatus,
  FR_LITERAL,
  SCHEMA_VERSION,
  ARTIFACT_REL_PATH,
};
