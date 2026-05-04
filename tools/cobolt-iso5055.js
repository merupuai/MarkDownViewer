#!/usr/bin/env node
// cobolt-iso5055 — ISO/IEC 5055:2021 / CISQ automated source code measures.
// Scans source tree against CWE-mapped rulepacks. Advisory only.
//
// Usage:
//   node tools/cobolt-iso5055.js measure [--root src] [--glob "**/*.js"]

const fs = require('node:fs');
const path = require('node:path');
const { MEASURES } = require('../lib/standards/iso5055-rules.js');

// GT-01: bypass routes through signed ledger; env-var auto-promotes during window.
function KILL() {
  const { isGateBypassed } = require('../lib/cobolt-bypass-resolver');
  return isGateBypassed('standards', { projectRoot: process.cwd() });
}
const DEFAULT_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.java', '.rb', '.cs', '.ex', '.exs'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '_cobolt-output', '.claude', 'coverage', 'out']);

function walk(root, exts, acc = [], depth = 0) {
  if (depth > 15) return acc;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const ent of entries) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) walk(full, exts, acc, depth + 1);
    else if (ent.isFile() && exts.includes(path.extname(ent.name))) acc.push(full);
  }
  return acc;
}

function emptyMeasure(label) {
  return { label, violations: 0, critical: 0, high: 0, medium: 0, low: 0, cwesCovered: new Set() };
}

function scan(projectRoot, opts = {}) {
  const root = opts.root ? path.resolve(projectRoot, opts.root) : projectRoot;
  const files = walk(root, DEFAULT_EXTS);
  const measures = {};
  for (const k of Object.keys(MEASURES)) measures[k] = emptyMeasure(MEASURES[k].label);
  const violations = [];
  for (const file of files) {
    let content = '';
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (const [mKey, mDef] of Object.entries(MEASURES)) {
      for (const rule of mDef.patterns) {
        const flags = rule.regex.flags.includes('g') ? rule.regex.flags : `${rule.regex.flags}g`;
        const re = new RegExp(rule.regex.source, flags);
        let m;
        // Cap per-file matches to avoid regex DoS on pathological inputs.
        let count = 0;
        while ((m = re.exec(content)) !== null && count < 50) {
          const idx = m.index;
          const line = content.slice(0, idx).split('\n').length;
          violations.push({
            ruleId: rule.id,
            cwe: rule.cwe,
            severity: rule.severity,
            file: path.relative(projectRoot, file).replace(/\\/g, '/'),
            line,
            measure: mKey,
            description: rule.desc,
            snippet: (lines[line - 1] || '').slice(0, 200),
          });
          measures[mKey].violations++;
          measures[mKey][rule.severity]++;
          measures[mKey].cwesCovered.add(rule.cwe);
          count++;
          if (!re.global) break;
        }
      }
    }
  }
  for (const k of Object.keys(measures)) measures[k].cwesCovered = Array.from(measures[k].cwesCovered);
  return {
    standard: 'ISO/IEC 5055:2021',
    generatedAt: new Date().toISOString(),
    filesScanned: files.length,
    measures,
    violations,
  };
}

function printUsage() {
  console.log(
    [
      'cobolt-iso5055 - ISO/IEC 5055:2021 automated source-code weakness scan.',
      '',
      'Usage:',
      '  node tools/cobolt-iso5055.js [measure] [--root <path>] [--out <path>]',
      '',
      'No argument runs the default measure pass. Use `--help` or `-h` to print this usage without side effects.',
    ].join('\n'),
  );
}

function main() {
  if (KILL()) {
    console.log('COBOLT_STANDARDS=off — skipping');
    process.exit(0);
  }
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }
  const getOpt = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : null;
  };
  const projectRoot = process.cwd();
  const data = scan(projectRoot, { root: getOpt('--root') });
  const outDir = path.join(projectRoot, '_cobolt-output', 'standards');
  fs.mkdirSync(outDir, { recursive: true });
  const out = getOpt('--out') || path.join(outDir, 'iso5055-measures.json');
  fs.writeFileSync(out, JSON.stringify(data, null, 2));
  const totals = Object.values(data.measures).reduce(
    (a, m) => ({ c: a.c + m.critical, h: a.h + m.high, m: a.m + m.medium, l: a.l + m.low }),
    { c: 0, h: 0, m: 0, l: 0 },
  );
  console.log(
    `iso5055: files=${data.filesScanned}  violations=${data.violations.length}  crit=${totals.c} high=${totals.h} med=${totals.m} low=${totals.l}`,
  );
  console.log(`  written: ${out}`);
}

if (require.main === module) main();
module.exports = { scan, MEASURES };
