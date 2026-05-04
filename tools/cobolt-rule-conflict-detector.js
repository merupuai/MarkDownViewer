#!/usr/bin/env node

// CoBolt Rule Conflict Detector (v0.65+, Tier 2 advisory).
//
// Reverse-engineering Wave 2.2 census tool — analogue of build's
// retroactive-contract gate but for extracted rules. When a later phase
// (or later milestone) emits a rule whose antecedent overlaps an
// earlier-extracted rule with a different consequent, record drift to
// `_cobolt-output/audit/rule-conflict-drift.json`.
//
// Pairs with the Wave 3 `cobolt-retroactive-rule-gate.js` Tier-2 hook (which
// fires at write time). This tool runs the cross-rule conflict scan
// deterministically and is callable from CI / pipeline checkpoints. Hard-fails
// only when drift is recorded AND a parity test then fails (the gate enforces
// that coupling; this tool only surfaces the drift).
//
// Conflict detection (heuristic, structured-English level):
//   1. Two rules share `sbvrForm.subject` and `sbvrForm.verb` but their
//      `objectOrValue` differs.
//   2. Two rules share `sourceLocation.file` and `sourceLocation.lines`
//      overlap, but their structured English diverges.
//   3. Two rules with `sbvrForm.modality: prohibition` and modality:
//      `obligation` on the same subject+verb (a hard logical contradiction).
//
// Usage:
//   node tools/cobolt-rule-conflict-detector.js scan [--brownfield <dir>] [--json] [--out <file>]
//
// Exit codes:
//   0 = no conflicts
//   1 = usage
//   2 = no rules to scan
//   3 = conflicts found (advisory)

const fs = require('node:fs');
const path = require('node:path');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_SKIPPED = 2;
const EXIT_FINDINGS = 3;

const AUDIT_DIR = path.join('_cobolt-output', 'audit');
const DRIFT_LOG = 'rule-conflict-drift.json';

function parseArgs(argv) {
  const args = { brownfield: null, json: false, out: null };
  let positional;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--brownfield') {
      args.brownfield = argv[++i];
      continue;
    }
    if (a === '--json') {
      args.json = true;
      continue;
    }
    if (a === '--out') {
      args.out = argv[++i];
      continue;
    }
    if (!a.startsWith('--')) {
      positional = positional || a;
    }
  }
  args.command = positional || 'scan';
  return args;
}

function findBrownfieldDir(explicitDir) {
  if (explicitDir) return path.resolve(explicitDir);
  const candidates = [
    path.join(process.cwd(), '_cobolt-output', 'latest', 'brownfield'),
    path.join(process.cwd(), '_cobolt-output', 'brownfield'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function loadRules(brownfieldDir) {
  // Two sources: structured per-rule JSON files under `14-rules-json/*.json`
  // (preferred — schema-validated) OR markdown blocks in
  // `14-business-rules-and-validation.md`. Prefer JSON when present.
  const rules = [];
  const jsonDir = path.join(brownfieldDir, '14-rules-json');
  if (fs.existsSync(jsonDir)) {
    for (const entry of fs.readdirSync(jsonDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.json$/i.test(entry.name)) continue;
      try {
        const r = JSON.parse(fs.readFileSync(path.join(jsonDir, entry.name), 'utf8'));
        if (r?.id && r?.sbvrForm) rules.push(r);
      } catch {
        /* skip malformed */
      }
    }
  }
  // Fallback: parse rule blocks from markdown if no JSON rules found.
  if (rules.length === 0) {
    const main = path.join(brownfieldDir, '14-business-rules-and-validation.md');
    if (fs.existsSync(main)) {
      const body = fs.readFileSync(main, 'utf8');
      const blocks = body.split(/^##\s+(RULE-[A-Z0-9-]+)/m);
      for (let i = 1; i < blocks.length; i += 2) {
        const id = blocks[i];
        const block = blocks[i + 1] || '';
        // Heuristic SBVR field extraction.
        const subject = (block.match(/subject\s*[:=]\s*[`"']?([^`"'\n]+)/i) || [])[1];
        const verb = (block.match(/verb\s*[:=]\s*[`"']?([^`"'\n]+)/i) || [])[1];
        const objectOrValue = (block.match(/object(?:_or_value)?\s*[:=]\s*[`"']?([^`"'\n]+)/i) || [])[1];
        const modality = (block.match(/modality\s*[:=]\s*[`"']?([^`"'\n]+)/i) || [])[1];
        if (subject && verb && modality) {
          rules.push({
            id,
            sbvrForm: {
              subject: subject.trim(),
              verb: verb.trim(),
              objectOrValue: objectOrValue?.trim(),
              modality: modality.trim(),
            },
          });
        }
      }
    }
  }
  return rules;
}

function detectConflicts(rules) {
  const conflicts = [];
  const seen = new Set();
  for (let i = 0; i < rules.length; i += 1) {
    for (let j = i + 1; j < rules.length; j += 1) {
      const a = rules[i];
      const b = rules[j];
      if (!a?.sbvrForm || !b?.sbvrForm) continue;
      // Conflict 1: same subject+verb, different objectOrValue.
      if (
        a.sbvrForm.subject === b.sbvrForm.subject &&
        a.sbvrForm.verb === b.sbvrForm.verb &&
        a.sbvrForm.objectOrValue &&
        b.sbvrForm.objectOrValue &&
        a.sbvrForm.objectOrValue !== b.sbvrForm.objectOrValue
      ) {
        const key = `c1:${[a.id, b.id].sort().join('|')}`;
        if (!seen.has(key)) {
          seen.add(key);
          conflicts.push({
            kind: 'subject-verb-object-divergence',
            ruleIds: [a.id, b.id],
            subject: a.sbvrForm.subject,
            verb: a.sbvrForm.verb,
            objectA: a.sbvrForm.objectOrValue,
            objectB: b.sbvrForm.objectOrValue,
          });
        }
      }
      // Conflict 2: hard contradiction — same subject+verb, modality
      // prohibition vs obligation.
      if (
        a.sbvrForm.subject === b.sbvrForm.subject &&
        a.sbvrForm.verb === b.sbvrForm.verb &&
        ((a.sbvrForm.modality === 'prohibition' && b.sbvrForm.modality === 'obligation') ||
          (a.sbvrForm.modality === 'obligation' && b.sbvrForm.modality === 'prohibition'))
      ) {
        const key = `c2:${[a.id, b.id].sort().join('|')}`;
        if (!seen.has(key)) {
          seen.add(key);
          conflicts.push({
            kind: 'modality-contradiction',
            ruleIds: [a.id, b.id],
            subject: a.sbvrForm.subject,
            verb: a.sbvrForm.verb,
            modalities: [a.sbvrForm.modality, b.sbvrForm.modality],
          });
        }
      }
      // Conflict 3: source-location overlap with different structured English.
      const aLoc = a.sourceLocation;
      const bLoc = b.sourceLocation;
      if (aLoc?.file && bLoc?.file && aLoc.file === bLoc.file && aLoc.lines && bLoc.lines) {
        const overlaps =
          (aLoc.lines.start || 0) <= (bLoc.lines.end || aLoc.lines.start || 0) &&
          (bLoc.lines.start || 0) <= (aLoc.lines.end || bLoc.lines.start || 0);
        if (overlaps && JSON.stringify(a.sbvrForm) !== JSON.stringify(b.sbvrForm)) {
          const key = `c3:${[a.id, b.id].sort().join('|')}`;
          if (!seen.has(key)) {
            seen.add(key);
            conflicts.push({
              kind: 'source-location-overlap-with-divergent-form',
              ruleIds: [a.id, b.id],
              file: aLoc.file,
              linesA: aLoc.lines,
              linesB: bLoc.lines,
            });
          }
        }
      }
    }
  }
  return conflicts;
}

function writeDriftLog(conflicts) {
  try {
    const dir = path.join(process.cwd(), AUDIT_DIR);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const payload = {
      generatedAt: new Date().toISOString(),
      generatedBy: 'tools/cobolt-rule-conflict-detector.js',
      conflictCount: conflicts.length,
      conflicts,
    };
    fs.writeFileSync(path.join(dir, DRIFT_LOG), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    return path.join(AUDIT_DIR, DRIFT_LOG);
  } catch (_e) {
    return null;
  }
}

function scan({ brownfield }) {
  const dir = findBrownfieldDir(brownfield);
  if (!dir) return { ok: false, reason: 'no-brownfield-dir', exitCode: EXIT_SKIPPED };
  const rules = loadRules(dir);
  if (rules.length === 0) return { ok: false, reason: 'no-rules', exitCode: EXIT_SKIPPED };
  const conflicts = detectConflicts(rules);
  const driftLogPath = conflicts.length > 0 ? writeDriftLog(conflicts) : null;
  return {
    ok: true,
    exitCode: conflicts.length > 0 ? EXIT_FINDINGS : EXIT_OK,
    totalRules: rules.length,
    conflictCount: conflicts.length,
    conflicts: conflicts.slice(0, 20),
    driftLogPath,
  };
}

function printHelp() {
  process.stdout.write(
    [
      'CoBolt Rule Conflict Detector (Tier 2 advisory).',
      '',
      'Usage:',
      '  node tools/cobolt-rule-conflict-detector.js scan [--brownfield <dir>] [--json] [--out <file>]',
      '',
      'Detects conflicts between extracted rules: same subject+verb with different',
      'objectOrValue; modality contradictions (prohibition vs obligation); source-',
      'location overlap with divergent structured English. Drift logged to',
      '_cobolt-output/audit/rule-conflict-drift.json.',
      'Exit codes: 0=ok, 1=usage, 2=skipped, 3=findings (advisory).',
      '',
    ].join('\n'),
  );
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return EXIT_OK;
  }
  const result = scan(args);
  const text = args.json
    ? JSON.stringify(result, null, 2)
    : [
        `rule-conflict-detector: ${result.ok ? 'COMPLETED' : `SKIPPED (${result.reason})`}`,
        result.ok ? `  Rules scanned: ${result.totalRules}` : '',
        result.ok ? `  Conflicts found: ${result.conflictCount}` : '',
        result.ok && result.driftLogPath ? `  Drift log: ${result.driftLogPath}` : '',
        result.ok && result.conflictCount > 0 ? '' : null,
        result.ok && result.conflictCount > 0 ? '  First 5 conflicts:' : null,
        ...(result.ok && result.conflictCount > 0
          ? result.conflicts.slice(0, 5).map((c) => `    - [${c.kind}] ${c.ruleIds.join(' vs ')}`)
          : []),
      ]
        .filter((v) => v !== null && v !== '')
        .join('\n');
  if (args.out) fs.writeFileSync(args.out, `${text}\n`);
  else process.stdout.write(`${text}\n`);
  return result.exitCode;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  scan,
  parseArgs,
  loadRules,
  detectConflicts,
  writeDriftLog,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_SKIPPED,
  EXIT_FINDINGS,
};
