#!/usr/bin/env node

// CoBolt Trace-Tag Coverage — verifies every FR-*/NFR-*/TR-*/IR-*/FEAT-* in rtm.json
// is cited by at least one downstream planning artifact (architecture, api-contracts,
// ux-design-specification, data-model-spec, feature-dossiers, stories, epics).
//
// Also detects the "ID range shorthand" anti-pattern ("FEAT-001, 002, 003...") that
// breaks machine parsers — only the first ID resolves; subsequent bare numbers are lost.
//
// Commands:
//   check [--json] [--fail-on-shorthand]
//
// Exit codes:
//   0 = all requirements traced (or deliberate SKIP)
//   1 = usage error
//   2 = rtm.json missing (Tier 2 skip)
//   6 = trace-tag coverage gap (one or more requirements uncited downstream)
//   7 = range-shorthand found (when --fail-on-shorthand)

const fs = require('node:fs');
const path = require('node:path');
const { getPlanningDir, safeReadJson } = require('../lib/cobolt-planning-artifacts');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_MISSING = 2;
const EXIT_COVERAGE = 6;
const EXIT_SHORTHAND = 7;

const DOWNSTREAM_FILES = [
  'system-architecture.md',
  'architecture.md',
  'api-contracts.md',
  'ux-design-specification.md',
  'data-model-spec.md',
  'data-model.md',
  'security-requirements.md',
  'delivery-plan.md',
  'feature-service-blueprints.md',
  'epics.md',
];

const DOSSIER_DIRS = ['feature-dossiers', 'features', 'dossiers'];
const STORY_DIRS = ['stories', 'spec-kits'];

// v0.28: extended grammar to match ADR-* plus composite (FR-AUTH-001) and suffix-qualified (ADR-001-IMPL) forms.
const ID_REGEX = /\b(FR|NFR|TR|IR|TRD|ADR|FEAT)(?:-[A-Z0-9]{1,8})?-(\d{1,4})(?:-[A-Z]{2,8})?\b/g;
const RANGE_SHORTHAND = /\b(FR|NFR|TR|IR|TRD|ADR|FEAT)-\d{1,4}(\s*,\s*\d{1,4}){1,}/g;

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function extractIds(text) {
  if (!text) return new Set();
  const ids = new Set();
  for (const m of text.matchAll(ID_REGEX)) {
    const num = parseInt(m[2], 10);
    ids.add(`${m[1]}-${String(num).padStart(3, '0')}`);
  }
  return ids;
}

function detectShorthand(text, filePath) {
  if (!text) return [];
  const out = [];
  for (const m of text.matchAll(RANGE_SHORTHAND)) {
    out.push({
      class: 'id-range-shorthand',
      severity: 'medium',
      file: filePath,
      match: m[0].slice(0, 60),
      message: `Shorthand ID list "${m[0].slice(0, 40)}..." — only the first ID is machine-readable. Rewrite as explicit IDs separated by commas.`,
    });
  }
  return out;
}

function collectArtifactIds(pd) {
  const perFile = {};
  const shorthands = [];

  for (const name of DOWNSTREAM_FILES) {
    const fp = path.join(pd, name);
    if (!fs.existsSync(fp)) continue;
    const text = readIfExists(fp);
    perFile[name] = extractIds(text);
    shorthands.push(...detectShorthand(text, name));
  }

  for (const dir of DOSSIER_DIRS) {
    const dp = path.join(pd, dir);
    if (!fs.existsSync(dp)) continue;
    walk(dp, (file) => {
      if (!/\.md$/i.test(file)) return;
      const text = readIfExists(file);
      const rel = path.relative(pd, file);
      perFile[rel] = extractIds(text);
      shorthands.push(...detectShorthand(text, rel));
    });
  }

  for (const dir of STORY_DIRS) {
    const dp = path.join(pd, dir);
    if (!fs.existsSync(dp)) continue;
    walk(dp, (file) => {
      if (!/\.md$/i.test(file)) return;
      const text = readIfExists(file);
      const rel = path.relative(pd, file);
      perFile[rel] = extractIds(text);
      shorthands.push(...detectShorthand(text, rel));
    });
  }

  return { perFile, shorthands };
}

function walk(dir, cb) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, cb);
    else if (entry.isFile()) cb(full);
  }
}

function check(pd) {
  const rtmPath = path.join(pd, 'rtm.json');
  const rtm = safeReadJson(rtmPath);
  if (!rtm) {
    return { verdict: 'SKIP', reason: 'rtm.json not found', exitCode: EXIT_MISSING };
  }

  const { perFile, shorthands } = collectArtifactIds(pd);

  // Union across all downstream artifacts
  const seenIds = new Set();
  for (const ids of Object.values(perFile)) {
    for (const id of ids) seenIds.add(id);
  }

  const requirements = rtm.requirements || {};
  const gaps = [];
  for (const reqId of Object.keys(requirements)) {
    const req = requirements[reqId];
    if (req.status === 'gap' || req.status === 'pending') continue;
    if (!seenIds.has(reqId)) {
      gaps.push({
        class: 'trace-tag-uncited',
        severity: 'high',
        id: reqId,
        status: req.status,
        message: `${reqId} (status=${req.status}) is not cited by any downstream planning artifact`,
      });
    }
  }

  const findings = [...gaps, ...shorthands];
  const verdict = gaps.length > 0 ? 'COVERAGE_GAP' : shorthands.length > 0 ? 'SHORTHAND_ONLY' : 'PASS';

  // v0.28: per-type coverage census so TR-* underrepresentation surfaces.
  const advanced = new Set(['mapped', 'coded', 'tested', 'covered']);
  const byType = {
    FR: { total: 0, cited: 0 },
    NFR: { total: 0, cited: 0 },
    TR: { total: 0, cited: 0 },
    IR: { total: 0, cited: 0 },
    TRD: { total: 0, cited: 0 },
    ADR: { total: 0, cited: 0 },
  };
  for (const reqId of Object.keys(requirements)) {
    const req = requirements[reqId];
    if (!advanced.has(req.status)) continue;
    const prefix = reqId.split('-')[0];
    if (!byType[prefix]) continue;
    byType[prefix].total++;
    if (seenIds.has(reqId)) byType[prefix].cited++;
  }
  const coverageByType = {};
  for (const [k, v] of Object.entries(byType)) {
    coverageByType[k] = {
      total: v.total,
      cited: v.cited,
      percent: v.total === 0 ? null : Math.round((v.cited / v.total) * 1000) / 10,
    };
  }

  return {
    verdict,
    findings,
    totalRequirements: Object.keys(requirements).length,
    tracedIds: seenIds.size,
    coverageGaps: gaps.length,
    shorthandCount: shorthands.length,
    coverageByType,
    artifacts: Object.keys(perFile),
  };
}

function main(argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'check';
  const json = hasFlag(args, '--json');
  const failOnShorthand = hasFlag(args, '--fail-on-shorthand');

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('Usage: cobolt-trace-tag-coverage.js check [--json] [--fail-on-shorthand]');
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

  const result = check(pd);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('== Trace-Tag Coverage ==');
    console.log(`requirements: ${result.totalRequirements ?? 0}`);
    console.log(`traced IDs  : ${result.tracedIds ?? 0}`);
    console.log(`gaps        : ${result.coverageGaps ?? 0}`);
    console.log(`shorthand   : ${result.shorthandCount ?? 0}`);
    for (const f of result.findings || []) {
      console.log(`  [${f.severity}] ${f.class}: ${f.message}`);
    }
    console.log(`verdict: ${result.verdict}`);
  }

  if (result.verdict === 'SKIP') process.exit(result.exitCode || EXIT_MISSING);
  if (result.verdict === 'COVERAGE_GAP') process.exit(EXIT_COVERAGE);
  if (result.verdict === 'SHORTHAND_ONLY' && failOnShorthand) process.exit(EXIT_SHORTHAND);
  process.exit(EXIT_OK);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { check };
