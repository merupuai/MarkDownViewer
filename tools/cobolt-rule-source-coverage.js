#!/usr/bin/env node

// CoBolt Rule Source Coverage Census (v0.65+, Tier 2 advisory).
//
// Reverse-engineering Wave 2.2 census tool. For every source file in
// `_cobolt-output/latest/brownfield/00-source-file-manifest.json`, emits a
// per-file `(file, rules-extracted-count, loc, isCovered)` record. Flags
// files above a configurable LOC floor that have ZERO extracted rules — a
// strong signal that the rule-extractor agent missed that file.
//
// Tier 2: skip-and-report. Does NOT block by itself. Pairs with the Tier 1
// `cobolt-rule-extraction-completeness-gate.js` (Wave 2.1) which enforces
// the *aggregate* density floor; this tool reports *per-file* zero-rule
// outliers so the operator can spot patterns (e.g. "all *.legacy.cob files
// have zero rules").
//
// Usage:
//   node tools/cobolt-rule-source-coverage.js scan [--brownfield <dir>] [--floor-loc <N>] [--json] [--out <file>]
//
// Exit codes:
//   0 = no zero-rule files above floor (or skipped)
//   1 = usage
//   2 = no manifest found / nothing to scan
//   3 = zero-rule outliers found (advisory only — Tier 2 callers do not block)

const fs = require('node:fs');
const path = require('node:path');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_SKIPPED = 2;
const EXIT_FINDINGS = 3;

const _RULE_ID_PATTERN = /\bRULE-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g;
const DEFAULT_FLOOR_LOC = 200;

function parseArgs(argv) {
  const args = { brownfield: null, floorLoc: DEFAULT_FLOOR_LOC, json: false, out: null };
  let positional;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--brownfield') {
      args.brownfield = argv[++i];
      continue;
    }
    if (a === '--floor-loc') {
      args.floorLoc = Number(argv[++i]) || DEFAULT_FLOOR_LOC;
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

function loadManifest(brownfieldDir) {
  const p = path.join(brownfieldDir, '00-source-file-manifest.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function loadAllRulesIndex(brownfieldDir) {
  // Read 14-business-rules-and-validation.md and 14-business-rules/*.md and
  // build a mapping `sourceFile -> Set<RULE-ID>`. Rule entries typically have
  // a `source: <repo-relative-path>` field or a header citing the file.
  const ruleIndex = new Map(); // sourceFilePath -> Set<RULE-ID>
  const scanFile = (mdPath) => {
    let body;
    try {
      body = fs.readFileSync(mdPath, 'utf8');
    } catch {
      return;
    }
    // Heuristic: split into rule blocks by `## RULE-XXX-NNN` headings, then
    // within each block look for `Source:` / `File:` / `source_location.file`
    // citations. If none, attribute the rule to "unknown".
    const blocks = body.split(/^##\s+(RULE-[A-Z0-9-]+)/m);
    for (let i = 1; i < blocks.length; i += 2) {
      const ruleId = blocks[i];
      const block = blocks[i + 1] || '';
      const sourceMatch = block.match(/(?:source|file|source_location\.file)\s*[:=]\s*[`"']?([^\s`"',]+)/i);
      const sourceFile = sourceMatch ? sourceMatch[1] : '_unknown_';
      if (!ruleIndex.has(sourceFile)) ruleIndex.set(sourceFile, new Set());
      ruleIndex.get(sourceFile).add(ruleId);
    }
  };

  const main = path.join(brownfieldDir, '14-business-rules-and-validation.md');
  if (fs.existsSync(main)) scanFile(main);
  const splitDir = path.join(brownfieldDir, '14-business-rules');
  if (fs.existsSync(splitDir)) {
    for (const entry of fs.readdirSync(splitDir, { withFileTypes: true })) {
      if (entry.isFile() && /\.md$/i.test(entry.name)) {
        scanFile(path.join(splitDir, entry.name));
      }
    }
  }
  return ruleIndex;
}

function scan({ brownfield, floorLoc }) {
  const dir = findBrownfieldDir(brownfield);
  if (!dir) return { ok: false, reason: 'no-brownfield-dir', exitCode: EXIT_SKIPPED };
  const manifest = loadManifest(dir);
  if (!manifest || (!Array.isArray(manifest.files) && !Array.isArray(manifest.entries))) {
    return { ok: false, reason: 'no-manifest', exitCode: EXIT_SKIPPED };
  }
  const sources = Array.isArray(manifest.files) ? manifest.files : manifest.entries;
  const ruleIndex = loadAllRulesIndex(dir);

  const records = [];
  const outliers = [];
  for (const source of sources) {
    const file = source.path || source.file || source.relativePath || null;
    const loc = typeof source.loc === 'number' ? source.loc : 0;
    if (!file) continue;
    // Match rule-index entries by file basename or by suffix (handles
    // repo-relative vs absolute path variation).
    let ruleCount = 0;
    for (const [indexedFile, rules] of ruleIndex.entries()) {
      if (indexedFile === file || indexedFile.endsWith(file) || file.endsWith(indexedFile)) {
        ruleCount += rules.size;
      }
    }
    const isOutlier = ruleCount === 0 && loc >= floorLoc;
    records.push({ file, loc, ruleCount, isOutlier });
    if (isOutlier) outliers.push({ file, loc });
  }

  return {
    ok: true,
    exitCode: outliers.length > 0 ? EXIT_FINDINGS : EXIT_OK,
    totalFiles: records.length,
    coveredFiles: records.filter((r) => r.ruleCount > 0).length,
    outlierCount: outliers.length,
    outliers,
    records,
    floorLoc,
  };
}

function printHelp() {
  process.stdout.write(
    [
      'CoBolt Rule Source Coverage Census (Tier 2 advisory).',
      '',
      'Usage:',
      '  node tools/cobolt-rule-source-coverage.js scan [--brownfield <dir>] [--floor-loc <N>] [--json] [--out <file>]',
      '',
      'For every source file in 00-source-file-manifest.json, reports per-file',
      'extracted-rule count and flags zero-rule files above a configurable LOC floor.',
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
        `rule-source-coverage: ${result.ok ? 'COMPLETED' : `SKIPPED (${result.reason})`}`,
        result.ok ? `  Files scanned: ${result.totalFiles}` : '',
        result.ok ? `  Files with ≥1 extracted rule: ${result.coveredFiles}` : '',
        result.ok ? `  Zero-rule files above ${result.floorLoc} LOC floor: ${result.outlierCount}` : '',
        result.ok && result.outlierCount > 0 ? '' : null,
        result.ok && result.outlierCount > 0 ? '  First 10 outliers:' : null,
        ...(result.ok && result.outlierCount > 0
          ? result.outliers.slice(0, 10).map((o) => `    - ${o.file} (${o.loc} LOC, 0 rules)`)
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

module.exports = { scan, parseArgs, loadManifest, loadAllRulesIndex, EXIT_OK, EXIT_USAGE, EXIT_SKIPPED, EXIT_FINDINGS };
