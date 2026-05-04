#!/usr/bin/env node

// CoBolt Referenced Artifacts — scans planning markdown for references to
// concrete artifact files (authz-matrix.json, compliance-architecture.md,
// openapi/*.yaml, adr/*.md, etc.) and blocks when any referenced file is
// missing on disk.
//
// Closes Blocker #9 from the Meru readiness review: api-contracts.md and
// security-requirements.md both pointed to authz-matrix.json and
// compliance-architecture.md as source-of-truth, but neither file existed.
//
// Strategy:
//   - Walk every .md under _cobolt-output/latest/planning/
//   - Match markdown code-span patterns for file paths ending in .json/.md/
//     .yaml/.yml/.sql/.openapi.yaml
//   - For each reference, resolve it relative to common roots (planning
//     directory, project root, openapi/, adr/, docs/, references/)
//   - If not found under any root AND not on the synonym-allowlist, flag
//
// Allowlist: a small known set of future-state artifacts that a planning doc
// may legitimately reference even before they exist (e.g., migration artifact
// names that are emitted at build time).
//
// Exit codes:
//   0 = all references resolvable or on allowlist
//   1 = usage
//   2 = no planning dir
//   3 = one or more referenced artifacts missing
//
// Invocation:
//   node tools/cobolt-referenced-artifacts.js check [--json] [--allow <glob>]

const fs = require('node:fs');
const path = require('node:path');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_MISSING = 2;
const EXIT_BROKEN = 3;

// Allowlist: filenames or suffixes that are legitimately produced later by
// build/deploy stages. Missing references to these don't block plan close.
const DEFAULT_ALLOWLIST = [
  // Build-time artifacts
  'build-artifact.json',
  'dist/',
  'coverage/',
  '.cache/',
  'node_modules/',
  // Release-time artifacts
  'sbom.json',
  'vuln-report.json',
  // Per-milestone artifacts referenced by pattern only
  'M{n}-',
  '{milestone}-',
  // Generic examples in prose
  'example.',
  'placeholder.',
];

// Match `backtick-code` spans that look like file references.
// The pattern is conservative — we want to avoid matching prose.
const REF_PATTERN = /`([\w./\-@_]+\.(?:json|md|yaml|yml|sql|ts|js|mjs|cjs|env|toml|openapi\.yaml))`/g;

// Also match reference-style lines: `See: foo/bar.json`, `path: foo/bar.md`.
const LINE_PATTERN =
  /(?:^|\s)(?:see|path|file|spec|contract|source|produces|emits|at)\s*[:=]\s*`?([\w./\-@_]+\.(?:json|md|yaml|yml|sql))`?/gim;

function planningDir(cwd = process.cwd()) {
  const p = path.join(cwd, '_cobolt-output', 'latest', 'planning');
  return fs.existsSync(p) ? p : null;
}

function walkMarkdown(dir, out = []) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '_versions' || e.name === 'snapshots' || e.name.startsWith('.')) continue;
        walkMarkdown(full, out);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        out.push(full);
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

function isAllowed(ref, allowList) {
  const normalized = ref.replace(/^\.\//, '');
  for (const pattern of allowList) {
    if (pattern.endsWith('/')) {
      if (normalized.startsWith(pattern)) return true;
    } else if (pattern.includes('{n}') || pattern.includes('{milestone}')) {
      const re = new RegExp(pattern.replace(/\{n\}/g, '\\d+').replace(/\{milestone\}/g, '[A-Z]?\\d+'));
      if (re.test(normalized)) return true;
    } else if (normalized.includes(pattern) || normalized.endsWith(pattern)) {
      return true;
    }
  }
  return false;
}

function resolveCandidates(ref, cwd, pd) {
  // Try multiple roots in order of most likely to least.
  const roots = [
    pd,
    cwd,
    path.join(cwd, 'openapi'),
    path.join(cwd, 'adr'),
    path.join(cwd, 'docs'),
    path.join(cwd, 'references'),
    path.join(cwd, '_cobolt-output'),
    path.dirname(pd || cwd),
  ];
  const refs = [];
  const cleaned = ref.replace(/^\.\//, '').replace(/^\/+/, '');
  for (const root of roots) {
    if (!root) continue;
    refs.push(path.join(root, cleaned));
  }
  // Also try dir-relative within planning/
  if (pd) {
    refs.push(path.join(pd, cleaned));
  }
  return refs;
}

function check({ dir, allowList, additionalAllow = [] }) {
  const pd = dir || planningDir();
  if (!pd) return { exitCode: EXIT_MISSING, error: 'no planning directory' };
  const cwd = process.cwd();
  const allow = [...(allowList || DEFAULT_ALLOWLIST), ...additionalAllow];

  const files = walkMarkdown(pd);
  const refsByFile = {};
  const unresolved = [];

  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const seen = new Set();
    const collect = (re) => {
      for (const m of content.matchAll(re)) {
        const ref = m[1];
        if (!ref) continue;
        if (seen.has(ref)) continue;
        seen.add(ref);
        if (isAllowed(ref, allow)) continue;
        // Resolve against all candidate roots
        const candidates = resolveCandidates(ref, cwd, pd);
        const found = candidates.some((c) => {
          try {
            return fs.existsSync(c);
          } catch {
            return false;
          }
        });
        if (!found) {
          unresolved.push({ sourceFile: path.relative(cwd, file), reference: ref });
          if (!refsByFile[file]) refsByFile[file] = [];
          refsByFile[file].push(ref);
        }
      }
    };
    collect(REF_PATTERN);
    collect(LINE_PATTERN);
  }

  return {
    exitCode: unresolved.length > 0 ? EXIT_BROKEN : EXIT_OK,
    planningDir: pd,
    scannedFiles: files.length,
    unresolvedCount: unresolved.length,
    unresolved,
  };
}

function formatText(r) {
  const lines = ['== Referenced Artifacts =='];
  lines.push(`  planningDir: ${r.planningDir || '(missing)'}`);
  lines.push(`  scannedFiles: ${r.scannedFiles || 0}`);
  lines.push(`  unresolvedCount: ${r.unresolvedCount || 0}`);
  if (r.unresolved?.length) {
    lines.push('  unresolved:');
    for (const u of r.unresolved.slice(0, 50)) {
      lines.push(`    - ${u.sourceFile} -> ${u.reference}`);
    }
  }
  lines.push(`verdict: ${r.exitCode === EXIT_OK ? 'PASS' : r.exitCode === EXIT_BROKEN ? 'BROKEN' : 'MISSING'}`);
  return lines.join('\n');
}

function main(argv = process.argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'check';
  const json = args.includes('--json');

  const additionalAllow = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--allow' && args[i + 1]) {
      additionalAllow.push(args[i + 1]);
      i++;
    }
  }

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('Usage: cobolt-referenced-artifacts.js check [--json] [--allow <pattern>]...');
    process.exit(EXIT_OK);
  }
  if (cmd !== 'check' && cmd !== 'report') {
    console.error('Usage: cobolt-referenced-artifacts.js check [--json] [--allow <pattern>]');
    process.exit(EXIT_USAGE);
  }
  const r = check({ additionalAllow });
  if (json) console.log(JSON.stringify(r, null, 2));
  else console.log(formatText(r));
  process.exit(cmd === 'report' ? EXIT_OK : r.exitCode);
}

if (require.main === module) main();

module.exports = { check, walkMarkdown, isAllowed, DEFAULT_ALLOWLIST, EXIT_OK, EXIT_BROKEN, EXIT_MISSING };
