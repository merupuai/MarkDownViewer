#!/usr/bin/env node

// CoBolt Brownfield Roadmap Validator — cross-validate modernization-roadmap
// component IDs against feature-and-module-inventory.
//
// Closes brownfield issue 15 (modernization roadmap orphan components).
//
// 18-modernization-roadmap.md cites component / module names from
// 04-feature-and-module-inventory.md. Nothing currently verifies the roadmap
// is not pointing at modules that were renamed, removed, or never existed.
// A roadmap entry that says "refactor payment-gateway module" when no such
// module appears in the inventory is free to slip into planning.
//
// This tool:
//   1. Parses `04-feature-and-module-inventory.md` into the set of declared
//      component / module / feature names (markdown headings + `\`backtick\``
//      identifiers).
//   2. Parses `18-modernization-roadmap.md` into the set of component names
//      it references (same identifier rules).
//   3. Produces the DIFF:
//        - roadmap-only  → orphan roadmap components (block)
//        - inventory-only → modules with no roadmap treatment (warn)
//        - intersection   → validated
//   4. Exits non-zero when any roadmap-only component exists (roadmap cites
//      a component not in the inventory).
//
// Usage:
//   node tools/cobolt-brownfield-roadmap-validate.js check --dir <bf-dir> [--json]
//
// Exit codes:
//   0 — every roadmap component exists in the inventory
//   1 — at least one roadmap component is an orphan
//   2 — usage error
//   3 — inputs missing (infrastructure gap)

const fs = require('node:fs');
const path = require('node:path');

const BACKTICK_IDENT = /`([A-Za-z_][A-Za-z0-9_\-./]{1,60})`/g;
const HEADING_IDENT = /^#{1,6}\s+([A-Za-z_][A-Za-z0-9_\-./\s]{1,80})\s*$/gm;

// Identifiers too short or too generic to be meaningful (e.g. `it`, `db`, `x`).
// Also bland plain-English words that would false-positive every heading.
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'the',
  'of',
  'for',
  'in',
  'on',
  'with',
  'without',
  'at',
  'to',
  'from',
  'as',
  'all',
  'any',
  'this',
  'that',
  'these',
  'those',
  'see',
  'note',
  'overview',
  'summary',
  'details',
  'status',
  'p0',
  'p1',
  'p2',
  'p3',
  'p4',
  'phase',
  'low',
  'medium',
  'high',
  'critical',
]);

function isIdentifier(raw) {
  const s = String(raw || '').trim();
  if (s.length < 3) return false;
  if (STOPWORDS.has(s.toLowerCase())) return false;
  if (!/[A-Za-z_]/.test(s)) return false;
  // Require either a separator or mixed case to avoid picking up plain prose.
  const hasSeparator = /[-_./]/.test(s);
  const isPascal = /^[A-Z][a-z]+(?:[A-Z][a-z]+)+$/.test(s);
  const isCamel = /^[a-z]+(?:[A-Z][a-z]+)+$/.test(s);
  return hasSeparator || isPascal || isCamel;
}

function extractIdentifiers(text) {
  if (!text) return new Set();
  const out = new Set();

  // Backtick-delimited identifiers are the highest-signal source.
  let m;
  BACKTICK_IDENT.lastIndex = 0;
  while ((m = BACKTICK_IDENT.exec(text)) !== null) {
    const candidate = m[1].trim();
    if (isIdentifier(candidate)) out.add(candidate);
  }

  // Markdown heading identifiers (secondary — only if they look like module names).
  HEADING_IDENT.lastIndex = 0;
  while ((m = HEADING_IDENT.exec(text)) !== null) {
    const candidate = m[1].trim();
    // Only accept heading tokens that look like module names.
    if (isIdentifier(candidate)) out.add(candidate);
  }

  return out;
}

function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function validate(bfDir) {
  const inventoryPath = path.join(bfDir, '04-feature-and-module-inventory.md');
  const roadmapPath = path.join(bfDir, '18-modernization-roadmap.md');

  const inventoryText = readIfExists(inventoryPath);
  const roadmapText = readIfExists(roadmapPath);

  if (!inventoryText) {
    return { ok: false, reason: 'inventory-missing', path: inventoryPath };
  }
  if (!roadmapText) {
    return { ok: false, reason: 'roadmap-missing', path: roadmapPath };
  }

  const inventoryIds = extractIdentifiers(inventoryText);
  const roadmapIds = extractIdentifiers(roadmapText);

  const orphans = [];
  const validated = [];
  for (const id of roadmapIds) {
    if (inventoryIds.has(id)) validated.push(id);
    else orphans.push(id);
  }

  const unused = [];
  for (const id of inventoryIds) {
    if (!roadmapIds.has(id)) unused.push(id);
  }

  const ok = orphans.length === 0;
  return {
    ok,
    inventoryIdCount: inventoryIds.size,
    roadmapIdCount: roadmapIds.size,
    validatedCount: validated.length,
    orphanCount: orphans.length,
    unusedInventoryCount: unused.length,
    orphans,
    validated,
    unusedInventory: unused,
  };
}

function audit(cwd, entry) {
  try {
    const dir = path.join(cwd, '_cobolt-output', 'audit');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      path.join(dir, 'brownfield-roadmap-validate.jsonl'),
      `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
      { mode: 0o600 },
    );
  } catch {
    /* best effort */
  }
}

function printHelp() {
  process.stdout.write(
    `cobolt-brownfield-roadmap-validate — cross-validate roadmap against inventory\n\n` +
      `USAGE\n` +
      `  node tools/cobolt-brownfield-roadmap-validate.js check --dir <bf-dir> [--json]\n` +
      `  node tools/cobolt-brownfield-roadmap-validate.js --help\n\n` +
      `EXIT CODES\n` +
      `  0 — every roadmap component exists in the inventory\n` +
      `  1 — at least one orphan component cited in roadmap\n` +
      `  2 — usage error\n` +
      `  3 — required input missing\n`,
  );
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }
  if (args[0] !== 'check') {
    process.stderr.write(`Unknown command: ${args[0]}\n`);
    printHelp();
    return 2;
  }
  const dirIdx = args.indexOf('--dir');
  const bfDir =
    dirIdx !== -1 && args[dirIdx + 1]
      ? path.resolve(args[dirIdx + 1])
      : path.join(process.cwd(), '_cobolt-output', 'latest', 'brownfield');
  const wantJson = args.includes('--json');

  const result = validate(bfDir);
  audit(process.cwd(), { bfDir, ...result });

  if (wantJson) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    if (result.reason) process.stderr.write(`FAIL: ${result.reason}: ${result.path}\n`);
    else {
      process.stdout.write(
        `Roadmap validation: roadmap-ids=${result.roadmapIdCount} inventory-ids=${result.inventoryIdCount} ` +
          `validated=${result.validatedCount} orphans=${result.orphanCount} unused-in-roadmap=${result.unusedInventoryCount}\n`,
      );
      for (const o of result.orphans.slice(0, 10)) {
        process.stderr.write(`  ORPHAN: "${o}" — referenced in roadmap but not in inventory\n`);
      }
      if (result.orphans.length > 10) process.stderr.write(`  …and ${result.orphans.length - 10} more\n`);
    }
  }

  if (result.reason === 'inventory-missing' || result.reason === 'roadmap-missing') return 3;
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = {
  validate,
  extractIdentifiers,
  isIdentifier,
  _testOnly: { STOPWORDS },
};
