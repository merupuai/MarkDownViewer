#!/usr/bin/env node

// CoBolt Version Census — detects drift across ALL version-carrying files
// in the repo. Complements scripts/sync-version.js which mirrors one source;
// this tool is the read-only audit that ANY consumer can run to prove no drift.
//
// Version-carrying files:
//   1. package.json                                   (canonical)
//   2. package-lock.json                              (lockfile)
//   3. cobolt-state.json                              (project state)
//   4. source/templates/cobolt-state.json             (template)
//   5. source/templates/config.json                   (template)
//   6. marketplace.json                               (marketplace listing)
//   7. .claude-plugin/plugin.json                     (plugin manifest)
//   8. README.md                                      (badge / header)
//   9. .cobolt/project-version.json                   (greenfield tracker, if present)
//  10. source/skills/cobolt-update/SKILL.md           (known version)
//
// Commands:
//   check [--json]              exit 0 if all match, 4 on drift
//   show [--json]               print each file and its detected version
//
// Exit codes:
//   0 = all versions match canonical
//   1 = usage error
//   2 = canonical (package.json) missing
//   4 = drift detected

const fs = require('node:fs');
const path = require('node:path');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_MISSING = 2;
const EXIT_DRIFT = 4;

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function extractVersionFromBadge(text) {
  if (!text) return null;
  // Targeted match: only shields.io-style badges or explicit "CoBolt vX.Y.Z"
  // header / cover mentions — NOT arbitrary historical version references in body prose.
  const m =
    text.match(/img\.shields\.io\/[^)]*version-(\d+\.\d+\.\d+)/i) ||
    text.match(/badge\/version-(\d+\.\d+\.\d+)/i) ||
    text.match(/CoBolt\s+v(\d+\.\d+\.\d+)\b/i) ||
    text.match(/@mftlabs\/cobolt@(\d+\.\d+\.\d+)/i);
  return m ? m[1] : null;
}

function collectFiles(root) {
  const files = [];
  const push = (rel, extractor) => {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) return;
    files.push({ rel, full, extractor });
  };

  push('package.json', (p) => readJson(p)?.version);
  push('package-lock.json', (p) => readJson(p)?.version);
  push('cobolt-state.json', (p) => readJson(p)?.meta?.cobolt_version ?? readJson(p)?.version);
  push('source/templates/cobolt-state.json', (p) => readJson(p)?.meta?.cobolt_version ?? readJson(p)?.version);
  push('source/templates/config.json', (p) => readJson(p)?.version);
  push('marketplace.json', (p) => {
    const d = readJson(p);
    if (!d) return null;
    if (typeof d.version === 'string') return d.version;
    if (Array.isArray(d.plugins) && d.plugins[0]?.version) return d.plugins[0].version;
    return null;
  });
  push('.claude-plugin/plugin.json', (p) => readJson(p)?.version);
  push('README.md', (p) => extractVersionFromBadge(readText(p)));
  push('.cobolt/project-version.json', (p) => readJson(p)?.version);
  push('source/skills/cobolt-update/SKILL.md', (p) => {
    const t = readText(p);
    if (!t) return null;
    // Only match the canonical "@mftlabs/cobolt@X.Y.Z" form — avoid picking up
    // example/illustrative version numbers in body prose.
    const m = t.match(/@mftlabs\/cobolt@(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  });

  return files;
}

function check(root) {
  const files = collectFiles(root);
  const canonicalEntry = files.find((f) => f.rel === 'package.json');
  if (!canonicalEntry) {
    return { verdict: 'MISSING', reason: 'package.json not found', exitCode: EXIT_MISSING };
  }
  const canonical = canonicalEntry.extractor(canonicalEntry.full);
  if (!canonical) {
    return { verdict: 'MISSING', reason: 'package.json has no version', exitCode: EXIT_MISSING };
  }

  const rows = files.map((f) => {
    const v = f.extractor(f.full);
    return {
      file: f.rel,
      version: v || null,
      matches: v === canonical,
      missing: !v,
    };
  });

  const drifted = rows.filter((r) => !r.missing && !r.matches);
  const missing = rows.filter((r) => r.missing);
  const verdict = drifted.length === 0 ? 'OK' : 'DRIFT';
  const exitCode = verdict === 'DRIFT' ? EXIT_DRIFT : EXIT_OK;

  return {
    verdict,
    canonical,
    rows,
    driftedFiles: drifted.map((r) => r.file),
    missingFiles: missing.map((r) => r.file),
    exitCode,
  };
}

function printHuman(result) {
  console.log('== CoBolt Version Census ==');
  console.log(`canonical: ${result.canonical ?? '(missing)'}`);
  console.log('');
  for (const r of result.rows || []) {
    let marker = 'OK  ';
    if (r.missing) marker = 'N/A ';
    else if (!r.matches) marker = 'DRIFT';
    console.log(`  [${marker}] ${r.file.padEnd(50)} -> ${r.version ?? '(none)'}`);
  }
  console.log('');
  console.log(`verdict: ${result.verdict}`);
  if (result.driftedFiles?.length) {
    console.log(`drift in: ${result.driftedFiles.join(', ')}`);
    console.log('remediation: npm run sync:version');
  }
}

function main(argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'check';
  const json = hasFlag(args, '--json');

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('Usage: cobolt-version-census.js <check|show> [--json]');
    process.exit(EXIT_OK);
  }

  if (cmd !== 'check' && cmd !== 'show') {
    console.error(`Unknown command: ${cmd}`);
    process.exit(EXIT_USAGE);
  }

  const result = check(process.cwd());
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }
  process.exit(cmd === 'show' ? EXIT_OK : result.exitCode);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { check };
