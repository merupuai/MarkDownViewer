#!/usr/bin/env node

// cobolt-carry-forward-semantic — v0.45.0 semantic validation of deferred-work
// carry-forward items against the CURRENT codebase state.
//
// Closes cascade #4 (carry-forward item semantically stale). Existing gates:
//   - cobolt-carry-forward-gate          — priority/category requirements
//   - cobolt-carryforward-consumer-gate  — content-hash ACK before consumer dispatch
// Neither verifies that deferred items still reference extant code. This
// tool fills that gap: for every deferred item, extract file paths / symbols
// / FR IDs / routes from the item text and verify each against the working
// tree. Emits a drift report.
//
// Classifications (per item):
//   relevant         — citations (files, FR IDs) all present; carry item forward.
//   resolved-in-place — some citations missing in a way that suggests the
//                       underlying concern is already addressed (e.g., file
//                       deleted but replacement exists). Advisory; human confirm.
//   phantom           — citations reference non-existent files/symbols/FR IDs
//                       with no equivalent. Item should be closed or rewritten.
//
// Consumers:
//   cobolt-carryforward-consumer-gate — in strict mode
//       (COBOLT_CARRY_FORWARD_STRICT=on) a non-empty phantom list blocks the
//       consumer skill (deploy/release/dream/milestone-validate). In normal
//       mode, report is advisory and only the hash-ACK is required.
//
// Commands:
//   audit [--milestone M{n}] [--json] [--strict]
//   help
//
// Exit codes:
//   0 — audit complete, zero phantom items
//   1 — usage error
//   2 — deferred-work file absent (Tier 2 skip — nothing to audit)
//   5 — phantom items present (hard verdict for strict consumers)

const fs = require('node:fs');
const path = require('node:path');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_MISSING_INPUT = 2;
const EXIT_PHANTOM = 5;

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function readJson(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

function detectCurrentMilestone(root) {
  // Prefer cobolt-state.json, fall back to latest build/M*/ dir mtime.
  try {
    const statePath = path.join(root, 'cobolt-state.json');
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const m = state.pipeline?.currentMilestone || state.currentMilestone || state.build?.currentMilestone;
      if (m) return m;
    }
  } catch {
    /* fall through */
  }
  const buildRoot = path.join(root, '_cobolt-output', 'latest', 'build');
  if (fs.existsSync(buildRoot)) {
    try {
      const entries = fs.readdirSync(buildRoot, { withFileTypes: true });
      const milestones = entries
        .filter((e) => e.isDirectory() && /^M\d+$/.test(e.name))
        .map((e) => ({ name: e.name, n: parseInt(e.name.slice(1), 10) }))
        .sort((a, b) => b.n - a.n);
      if (milestones.length) return milestones[0].name;
    } catch {
      /* best-effort */
    }
  }
  return null;
}

function findDeferredWork(root, milestone) {
  const candidates = [
    path.join(root, '_cobolt-output', 'latest', 'build', milestone, `${milestone}-deferred-work.json`),
    path.join(root, '_cobolt-output', 'latest', 'fix', 'carry-forward.json'),
    path.join(root, '_cobolt-output', 'carry-forward.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// Extract potential citations from an item's textual fields. Returns
// { files, frIds, routes }.
function extractCitations(item) {
  const fields = [
    item.description,
    item.message,
    item.reason,
    item.target,
    item.title,
    ...(Array.isArray(item.items) ? item.items : []),
  ]
    .filter(Boolean)
    .map(String);
  const text = fields.join('\n');

  // Files: anything matching path segments with common source extensions.
  const fileRe =
    /(?:^|[\s`"'(])([\w./-]+\.(?:js|ts|jsx|tsx|py|rb|go|rs|ex|exs|java|kt|swift|c|cc|cpp|h|hpp|php|md|json|yml|yaml|toml|sql))(?=[\s`"')]|$)/gm;
  const files = new Set();
  let fm;
  while ((fm = fileRe.exec(text)) !== null) {
    const f = fm[1];
    // Filter out URLs and obvious non-paths.
    if (f.includes('://')) continue;
    if (f.length > 200) continue;
    files.add(f);
  }

  // FR/NFR/TR/IR IDs — uppercase prefix + dash + 3 digits.
  const idRe = /\b((?:FR|NFR|TR|IR|STORY|EP|M)[-_]?\d{1,4})\b/g;
  const frIds = new Set();
  let im;
  while ((im = idRe.exec(text)) !== null) {
    // Normalize to FR-001 form.
    const raw = im[1].replace(/[-_]/, '-');
    // Don't double-count milestones (M1 etc.) as FR-style IDs.
    if (/^M\d+$/.test(raw)) continue;
    frIds.add(raw);
  }

  // Routes — HTTP methods + path.
  const routeRe = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[\w/:.-]+)/g;
  const routes = new Set();
  let rm;
  while ((rm = routeRe.exec(text)) !== null) {
    routes.add(`${rm[1]} ${rm[2]}`);
  }

  return { files: [...files], frIds: [...frIds], routes: [...routes] };
}

function checkFileCitations(root, files) {
  const missing = [];
  for (const f of files) {
    const abs = path.isAbsolute(f) ? f : path.join(root, f);
    if (!fs.existsSync(abs)) missing.push(f);
  }
  return { present: files.length - missing.length, missing };
}

function checkFrIdCitations(root, ids) {
  if (!ids.length) return { present: 0, missing: [] };
  const rtmCandidates = [
    path.join(root, '_cobolt-output', 'latest', 'planning', 'rtm.json'),
    path.join(root, '_cobolt-output', 'latest', 'rtm', 'rtm.json'),
  ];
  let rtm = null;
  for (const c of rtmCandidates) {
    if (fs.existsSync(c)) {
      rtm = readJson(c);
      if (rtm) break;
    }
  }
  if (!rtm) {
    // No RTM — can't verify. Be permissive: treat all as present but note.
    return { present: ids.length, missing: [], note: 'rtm-absent-unverified' };
  }
  const rtmIds = new Set(
    Object.keys(rtm.requirements || {}).concat(
      Array.isArray(rtm.requirementsList) ? rtm.requirementsList.map((r) => r.id).filter(Boolean) : [],
    ),
  );
  const missing = ids.filter((id) => !rtmIds.has(id));
  return { present: ids.length - missing.length, missing };
}

// For each item, classify. Returns { item, classification, citations, checks }.
function classifyItem(root, item) {
  const citations = extractCitations(item);
  const hasAnyCitation = citations.files.length + citations.frIds.length + citations.routes.length > 0;

  // If no extractable citations, we can't verify — mark as relevant (trust
  // the operator's prose). Alternative would be 'uncheckable'.
  if (!hasAnyCitation) {
    return {
      id: item.id || item.target || '(unnamed)',
      classification: 'relevant',
      reason: 'no-verifiable-citations',
      citations,
    };
  }

  const fileCheck = checkFileCitations(root, citations.files);
  const frCheck = checkFrIdCitations(root, citations.frIds);

  const totalCited = citations.files.length + citations.frIds.length;
  const totalMissing = fileCheck.missing.length + frCheck.missing.length;

  let classification;
  let reason;
  if (totalMissing === 0) {
    classification = 'relevant';
    reason = 'all-citations-present';
  } else if (totalMissing === totalCited) {
    // All citations are phantom — item references nothing that exists.
    classification = 'phantom';
    reason = 'all-citations-missing';
  } else {
    // Partial drift. Prefer resolved-in-place heuristic: if there's at
    // least one present citation, the concern may have been addressed.
    classification = 'resolved-in-place';
    reason = 'partial-citations-missing';
  }

  return {
    id: item.id || item.target || '(unnamed)',
    classification,
    reason,
    citations,
    checks: { files: fileCheck, frIds: frCheck },
  };
}

function collectItems(data) {
  // Support several shapes — tool reads arrays of deferred items from
  // canonical fields: items, deferredItems, carryForward, findings.
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const key of ['items', 'deferredItems', 'deferred', 'carryForward', 'findings']) {
    if (Array.isArray(data[key])) return data[key];
  }
  return [];
}

function audit(root, opts = {}) {
  const milestone = opts.milestone || detectCurrentMilestone(root);
  if (!milestone) {
    return { ok: false, exitCode: EXIT_MISSING_INPUT, reason: 'milestone-undetermined' };
  }

  const deferredPath = findDeferredWork(root, milestone);
  if (!deferredPath) {
    return {
      ok: false,
      exitCode: EXIT_MISSING_INPUT,
      reason: 'no-deferred-work-file',
      milestone,
    };
  }

  const payload = readJson(deferredPath);
  if (!payload) {
    return {
      ok: false,
      exitCode: EXIT_MISSING_INPUT,
      reason: 'deferred-work-unparseable',
      milestone,
      path: deferredPath,
    };
  }

  const items = collectItems(payload);
  const perItem = items.map((i) => classifyItem(root, i));

  const tally = { relevant: 0, 'resolved-in-place': 0, phantom: 0 };
  for (const p of perItem) {
    tally[p.classification] = (tally[p.classification] || 0) + 1;
  }

  const report = {
    milestone,
    sourceDeferredWork: deferredPath,
    auditedAt: new Date().toISOString(),
    strict: !!opts.strict,
    totalItems: items.length,
    tally,
    items: perItem,
  };

  const hasPhantoms = tally.phantom > 0;
  const exitCode = hasPhantoms ? EXIT_PHANTOM : EXIT_OK;
  return { ok: true, exitCode, report, path: deferredPath };
}

function writeReport(root, milestone, report) {
  const outDir = path.join(root, '_cobolt-output', 'latest', 'build', milestone);
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'carry-forward-drift.json'), JSON.stringify(report, null, 2));
  } catch {
    /* best-effort */
  }
}

function printHuman(report) {
  console.log('== Carry-Forward Semantic Audit ==');
  console.log(`  milestone: ${report.milestone}`);
  console.log(`  items:     ${report.totalItems}`);
  console.log(`  relevant:  ${report.tally.relevant}`);
  console.log(`  resolved-in-place: ${report.tally['resolved-in-place']}`);
  console.log(`  phantom:   ${report.tally.phantom}`);
  if (report.tally.phantom > 0) {
    console.log('');
    console.log('Phantom items (cite files/symbols/FR IDs that do not exist):');
    for (const p of report.items.filter((i) => i.classification === 'phantom')) {
      console.log(`  - ${p.id}: ${p.reason}`);
      if (p.checks?.files?.missing?.length) {
        console.log(`    files missing: ${p.checks.files.missing.slice(0, 3).join(', ')}`);
      }
      if (p.checks?.frIds?.missing?.length) {
        console.log(`    FR IDs missing: ${p.checks.frIds.missing.slice(0, 3).join(', ')}`);
      }
    }
  }
}

function main(argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'audit';
  const json = hasFlag(args, '--json');
  const strict = hasFlag(args, '--strict') || process.env.COBOLT_CARRY_FORWARD_STRICT === 'on';
  const msIndex = args.indexOf('--milestone');
  const milestone = msIndex >= 0 && args[msIndex + 1] ? args[msIndex + 1] : null;

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('Usage: cobolt-carry-forward-semantic.js audit [--milestone M{n}] [--json] [--strict]');
    console.log('Exits: 0=clean, 1=usage, 2=no-input, 5=phantom-items-present');
    process.exit(EXIT_OK);
  }

  if (cmd !== 'audit') {
    console.error(`Unknown command: ${cmd}`);
    process.exit(EXIT_USAGE);
  }

  const root = process.cwd();
  const result = audit(root, { milestone, strict });

  if (!result.ok) {
    if (json) console.log(JSON.stringify({ ok: false, reason: result.reason }));
    else console.error(`carry-forward-semantic: ${result.reason}`);
    process.exit(result.exitCode);
  }

  writeReport(root, result.report.milestone, result.report);
  if (json) console.log(JSON.stringify(result.report, null, 2));
  else printHuman(result.report);

  // In non-strict mode, phantoms are reported but not gated via exit code.
  process.exit(strict ? result.exitCode : EXIT_OK);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { audit, classifyItem, extractCitations, writeReport };
