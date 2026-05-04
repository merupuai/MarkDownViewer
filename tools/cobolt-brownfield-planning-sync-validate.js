#!/usr/bin/env node

// CoBolt Brownfield Planning-Sync Validator — deterministic pre-sync gate
//
// Closes brownfield issue 13 (artifact path mismatch in planning-sync).
//
// The `cobolt-brownfield-planning-sync.js` tool iterates a `COPY_MAP` of
// expected brownfield → planning artifact paths. If the producer agent wrote
// to a different path than COPY_MAP declares (typo, stale filename, wrong
// directory), sync silently skips the entry and then writes a degraded-stub
// replacement downstream. That class of failure put "word word word..." filler
// into production planning artifacts more than once.
//
// This validator runs BEFORE `planning-sync sync …` and:
//   1. Imports the actual COPY_MAP from the planning-sync tool (single source
//      of truth — no drift-vulnerable duplication).
//   2. For every mapping, verifies at least one of the declared source paths
//      exists on disk, or that the mapping is known-optional.
//   3. Emits a JSON verdict listing matched / unmatched / optional-missing
//      entries. Non-zero exit on any unmatched-required entry.
//
// Usage:
//   node tools/cobolt-brownfield-planning-sync-validate.js check \
//     --dir _cobolt-output/latest/brownfield [--json]
//
// Exit codes:
//   0 — every required COPY_MAP entry has at least one source on disk
//   1 — one or more required entries have NO source file; sync would silently
//       stub that artifact
//   2 — usage error
//   3 — brownfield directory missing (infrastructure gap)

const fs = require('node:fs');
const path = require('node:path');

let COPY_MAP;
try {
  ({ COPY_MAP } = require('./cobolt-brownfield-planning-sync'));
} catch {
  COPY_MAP = null;
}

// The planning-sync tool exports COPY_MAP only when we add an export — the
// current module exports {assessPlanningContract, …}. To avoid editing the
// production path on every refactor, we extract COPY_MAP by reading the tool
// source and evaluating the declaration when the programmatic export is absent.
// This is deterministic — same source bytes → same COPY_MAP.
function loadCopyMapFromSource() {
  if (Array.isArray(COPY_MAP)) return COPY_MAP;
  const src = fs.readFileSync(path.join(__dirname, 'cobolt-brownfield-planning-sync.js'), 'utf8');
  const match = src.match(/const COPY_MAP = (\[[\s\S]*?^\]);/m);
  if (!match) {
    throw new Error('COPY_MAP not found in cobolt-brownfield-planning-sync.js — source layout changed');
  }
  // eslint-disable-next-line no-new-func
  return new Function(`return ${match[1]}`)();
}

// Entries whose absence is allowed (e.g. UX artifacts on a non-UI project, or
// validator-only sidecars). Keep this list short and justified.
const OPTIONAL_DESTINATIONS = new Set([
  'ux-design-specification.md',
  'wireframes-and-user-flows.md',
  'design-token-audit.json',
  'ui-design-audit.json',
  'ux-tracker.json',
  'standards-validation.json',
  'compliance-architecture.md',
  'compliance-validation.json',
  'architect-review.json',
  'deterministic-quality-gates.json',
  'agent-grounding-and-anti-hallucination.md',
  'validation-report.md',
]);

// v0.40.13 PROD-05: a brownfield run is distinguished by the presence of
// at least one canonical brownfield-scope indicator. If NONE of these exist
// in the brownfield dir, the project is greenfield (or brownfield P0 was
// never run), and this validator must skip-pass rather than emit 22+ "fail"
// records against artifacts that were never meant to be produced.
const BROWNFIELD_RUN_INDICATORS = [
  '00-run-context.json',
  '01-intake-and-classification.md',
  '16-issues-registry.json',
  '16a-forensic-findings.json',
  '23-master-assessment.md',
];

function isBrownfieldRun(bfDir) {
  if (!fs.existsSync(bfDir)) return false;
  for (const indicator of BROWNFIELD_RUN_INDICATORS) {
    try {
      const p = path.join(bfDir, indicator);
      if (fs.existsSync(p) && fs.statSync(p).size > 0) return true;
    } catch {
      /* best effort */
    }
  }
  return false;
}

function validate(bfDir, _options = {}) {
  if (!fs.existsSync(bfDir)) {
    return {
      ok: false,
      reason: 'brownfield-dir-missing',
      path: bfDir,
      matched: [],
      unmatched: [],
      optionalMissing: [],
    };
  }

  // v0.40.13 PROD-05 greenfield guard: if brownfield dir exists but contains
  // no brownfield-run indicators (00-run-context.json, 16a, 23-master, etc.),
  // this is a greenfield project that happens to have a brownfield/ directory
  // (e.g., scaffolded by a different skill or left by a prior cleanup). The
  // validator must not emit fail records against non-brownfield projects.
  if (!isBrownfieldRun(bfDir)) {
    return {
      ok: true,
      reason: 'not-brownfield-project',
      path: bfDir,
      matched: [],
      unmatched: [],
      optionalMissing: [],
      totalMappings: 0,
      skipped: true,
      skippedReason: `None of the brownfield run indicators present: ${BROWNFIELD_RUN_INDICATORS.join(', ')}`,
    };
  }

  const copyMap = loadCopyMapFromSource();
  const matched = [];
  const unmatched = [];
  const optionalMissing = [];

  for (const mapping of copyMap) {
    const sources = Array.isArray(mapping.source) ? mapping.source : [mapping.source].filter(Boolean);
    const dest = mapping.dest;
    const hit = sources.find((s) => {
      try {
        const full = path.join(bfDir, s);
        return fs.existsSync(full) && fs.statSync(full).size > 0;
      } catch {
        return false;
      }
    });

    if (hit) {
      matched.push({ dest, matchedSource: hit, candidates: sources });
      continue;
    }
    if (OPTIONAL_DESTINATIONS.has(dest)) {
      optionalMissing.push({ dest, candidates: sources });
      continue;
    }
    unmatched.push({ dest, candidates: sources });
  }

  const ok = unmatched.length === 0;
  return { ok, matched, unmatched, optionalMissing, totalMappings: copyMap.length };
}

function audit(cwd, entry) {
  try {
    const dir = path.join(cwd, '_cobolt-output', 'audit');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      path.join(dir, 'brownfield-planning-sync-validate.jsonl'),
      `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
      { mode: 0o600 },
    );
  } catch {
    /* best effort */
  }
}

function printHelp() {
  process.stdout.write(
    `cobolt-brownfield-planning-sync-validate — pre-sync COPY_MAP validator\n\n` +
      `USAGE\n` +
      `  node tools/cobolt-brownfield-planning-sync-validate.js check --dir <bf-dir> [--json]\n` +
      `  node tools/cobolt-brownfield-planning-sync-validate.js --help\n\n` +
      `EXIT CODES\n` +
      `  0 — all required COPY_MAP mappings have source files on disk\n` +
      `  1 — at least one required mapping has zero sources (sync would stub)\n` +
      `  2 — usage error\n` +
      `  3 — brownfield directory missing\n`,
  );
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }
  const command = args[0];
  if (command !== 'check') {
    process.stderr.write(`Unknown command: ${command}\n`);
    printHelp();
    return 2;
  }

  const dirIdx = args.indexOf('--dir');
  const bfDir =
    dirIdx !== -1 && args[dirIdx + 1]
      ? path.resolve(args[dirIdx + 1])
      : path.join(process.cwd(), '_cobolt-output', 'latest', 'brownfield');
  const wantJson = args.includes('--json');

  let result;
  try {
    result = validate(bfDir);
  } catch (e) {
    const err = { ok: false, reason: 'exception', message: String(e?.message || e) };
    audit(process.cwd(), err);
    if (wantJson) process.stdout.write(`${JSON.stringify(err, null, 2)}\n`);
    else process.stderr.write(`FAIL: ${err.message}\n`);
    return 1;
  }

  audit(process.cwd(), { outcome: result.ok ? 'ok' : 'fail', bfDir, ...result });

  if (wantJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `Planning-sync validation: matched=${result.matched.length} ` +
        `unmatched=${result.unmatched.length} optional-missing=${result.optionalMissing.length}\n`,
    );
    for (const u of result.unmatched) {
      process.stderr.write(`  MISSING: dest=${u.dest} (expected any of: ${u.candidates.join(', ')})\n`);
    }
  }

  if (result.reason === 'brownfield-dir-missing') return 3;
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = {
  validate,
  loadCopyMapFromSource,
  OPTIONAL_DESTINATIONS,
};
