#!/usr/bin/env node

// CoBolt Acceptance Criteria Executability — census check that every AC string
// on a mapped/coded/tested/covered requirement contains at least one of:
//   - BDD keyword  : Given / When / Then / And / But
//   - Binding modal: MUST / MAY / SHOULD / SHALL / MUST NOT / SHALL NOT
//   - Test verb    : verify / assert / check / expect / ensure
//
// AND is >= 20 characters AND does not match stub markers (TBD, TODO, N/A,
// <placeholder>, pending, lorem ipsum, single-word responses).
//
// Why: v0.26 enforced non-empty acceptance_criteria via minItems:1 + minLength:8.
// Real-world post-v0.26 planning output showed "mapped" requirements with AC
// like "The feature works", "Users can log in", or truncated "Given..." that
// passed schema but were untestable.
//
// Commands:
//   check [--json] [--min-length N] [--threshold 1.0]
//   show-failures [--json]       (inspection mode — exits 0)
//
// Exit codes:
//   0 = all advanced-status requirements have executable AC
//   1 = usage error
//   2 = rtm.json missing (Tier 2 skip)
//   5 = one or more non-executable AC entries

const fs = require('node:fs');
const path = require('node:path');
const { getPlanningDir, safeReadJson } = require('../lib/cobolt-planning-artifacts');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_MISSING = 2;
const EXIT_DEFECTS = 5;

const ADVANCED_STATUSES = new Set(['mapped', 'coded', 'tested', 'covered']);

// v0.28: "and"/"but" removed from BDD keywords — they are common prose conjunctions
// ("username and password", "complete but slow") and caused false positives.
// They only have BDD meaning as continuations of Given/When/Then, and if any of
// those is present the criterion already passes.
const EXECUTABILITY_MARKERS = [
  /\b(given|when|then)\b/i,
  /\b(must|may|should|shall)(?:\s+not)?\b/i,
  /\b(verify|assert|check|expect|ensure|validate|require)s?\b/i,
  // Measurable constraint patterns (response time, count, rate)
  /\b\d+\s*(?:ms|s|min|%|rps|req\/s|mb|gb|kb|req)\b/i,
];

const STUB_PATTERNS = [
  /^tbd$/i,
  /^todo$/i,
  /^n\/a$/i,
  /^pending$/i,
  /^<placeholder>$/i,
  /^\[fill[- ]me[- ]in\]$/i,
  /\blorem ipsum\b/i,
  /^(the\s+)?feature\s+works$/i,
];

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function argValue(argv, flag, fallback) {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  return argv[i + 1];
}

function assessAcString(raw, opts) {
  const s = String(raw || '').trim();
  const minLength = opts.minLength;
  const issues = [];
  if (s.length === 0) {
    issues.push({ class: 'ac-empty' });
    return { ok: false, issues };
  }
  if (STUB_PATTERNS.some((re) => re.test(s))) {
    issues.push({ class: 'ac-stub-marker', value: s.slice(0, 60) });
    return { ok: false, issues };
  }
  if (s.length < minLength) {
    issues.push({ class: 'ac-too-short', length: s.length, minLength });
    return { ok: false, issues };
  }
  if (!/\s/.test(s)) {
    issues.push({ class: 'ac-single-word', value: s.slice(0, 40) });
    return { ok: false, issues };
  }
  const executable = EXECUTABILITY_MARKERS.some((re) => re.test(s));
  if (!executable) {
    issues.push({
      class: 'ac-non-executable',
      value: s.slice(0, 80),
      message: 'no BDD keyword (Given/When/Then), modal (MUST/SHALL/SHOULD), or test verb (verify/assert) detected',
    });
    return { ok: false, issues };
  }
  return { ok: true, issues: [] };
}

function check(pd, opts) {
  const rtmPath = path.join(pd, 'rtm.json');
  const rtm = safeReadJson(rtmPath);
  if (!rtm) return { verdict: 'SKIP', reason: 'rtm.json not found', exitCode: EXIT_MISSING };
  const requirements = rtm.requirements || {};

  const defects = [];
  let totalChecked = 0;
  let totalAc = 0;
  let totalNonExec = 0;

  for (const reqId of Object.keys(requirements)) {
    const req = requirements[reqId];
    if (!ADVANCED_STATUSES.has(req.status)) continue;
    totalChecked++;
    const acs = Array.isArray(req.acceptance_criteria) ? req.acceptance_criteria : [];
    if (acs.length === 0) continue; // C19 handles empty — this tool focuses on quality.

    acs.forEach((ac, idx) => {
      totalAc++;
      const r = assessAcString(ac, opts);
      if (!r.ok) {
        totalNonExec++;
        for (const issue of r.issues) {
          defects.push({
            id: reqId,
            acIndex: idx,
            severity: 'high',
            class: issue.class,
            value: issue.value || (typeof ac === 'string' ? ac.slice(0, 80) : ''),
            message: issue.message,
          });
        }
      }
    });
  }

  const passed = defects.length === 0;
  return {
    verdict: passed ? 'PASS' : 'FAIL',
    requirementsChecked: totalChecked,
    acStringsChecked: totalAc,
    nonExecutableAc: totalNonExec,
    defects,
    exitCode: passed ? EXIT_OK : EXIT_DEFECTS,
  };
}

function main(argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'check';
  const json = hasFlag(args, '--json');
  const minLength = parseInt(argValue(args, '--min-length', '20'), 10);

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('Usage: cobolt-ac-executability.js <check|show-failures> [--json] [--min-length N]');
    process.exit(EXIT_OK);
  }

  if (cmd !== 'check' && cmd !== 'show-failures') {
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

  const result = check(pd, { minLength });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('== AC Executability ==');
    console.log(`requirements checked : ${result.requirementsChecked ?? 0}`);
    console.log(`AC strings checked   : ${result.acStringsChecked ?? 0}`);
    console.log(`non-executable       : ${result.nonExecutableAc ?? 0}`);
    for (const d of (result.defects || []).slice(0, 20)) {
      console.log(`  [${d.severity}] ${d.id} AC[${d.acIndex}] ${d.class}: ${d.message || d.value || ''}`);
    }
    if ((result.defects || []).length > 20) {
      console.log(`  ... and ${result.defects.length - 20} more`);
    }
    console.log(`verdict: ${result.verdict}`);
  }

  process.exit(cmd === 'show-failures' ? EXIT_OK : result.exitCode);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { check, assessAcString };
