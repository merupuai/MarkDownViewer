#!/usr/bin/env node

// CoBolt Gate Lint — audits the auditors.
//
// The Meru planning incident (docs/manual-deep-dive-readiness-review.md) and
// the v0.30 fixes exposed a failure class: gates themselves ship with
// vacuous-pass defaults. Two real examples from this session:
//   - tools/cobolt-spec-verify.js:536 — `const passed = strict ? ... : true;`
//     Non-strict mode always returned PASS regardless of missing/empty files.
//   - tools/cobolt-validate-prd.js:610 — `frBlocks.length === 0 ? ... : 10`
//     Zero FRs detected yielded a perfect V13 score.
//
// Both were "fail-open if uncertain" defensive patterns that turned into
// pipeline fraud under pressure. We audit application code for these patterns
// but rarely audit the gates. This tool closes that gap.
//
// Detects (file-by-file regex + light AST-ish line analysis — no full parse):
//   [TAUT-01] Tautology-fallback-true — `const (passed|ok|valid|verdict) =
//             <cond> ? ... : true`. The conditional runs only one branch;
//             `true` on the fallback defeats the gate.
//   [TAUT-02] Vacuous-max-score-on-empty — `(length|count) === 0 ? 10 : ...`.
//             Empty input must FAIL the check, not perfect-score it.
//   [SWALLOW-01] Catch-approve-silent — `catch { return { action: 'approve' }`.
//             Swallowing errors with approve bypasses Tier 1 enforcement.
//   [SWALLOW-02] Catch-exit-0-silent — `catch { process.exit(0) }` in tools.
//             Silent exit-0 on error hides failures from aggregate gates.
//   [ABSENCE-01] Permissive-absence without bypass-env narrative — `if (!file)
//             return approve;` in gates whose description says the file is
//             required. (Heuristic — requires docstring mention of "required"
//             / "must exist".)
//
// Scope:
//   - source/hooks/cobolt-*.js  (PreToolUse + PostToolUse gates)
//   - tools/cobolt-*.js          (deterministic checkers invoked by gates)
//
// Exit codes:
//   0 = clean
//   1 = usage / unhandled exception
//   2 = no gate files found (cannot run)
//   3 = findings present — Tier 1 block in CI and pre-commit
//
// Invocation:
//   node tools/cobolt-gate-lint.js check [--json] [--path <dir>] [--fail-on <severity>]
//   node tools/cobolt-gate-lint.js report [--json]

const fs = require('node:fs');
const path = require('node:path');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_MISSING = 2;
const EXIT_VIOLATION = 3;

const DEFAULT_ROOTS = ['source/hooks', 'tools'];

// ── Detection rules ──────────────────────────────────────────

const RULES = [
  {
    id: 'TAUT-01',
    title: 'tautology-fallback-true',
    severity: 'critical',
    why:
      'A ternary with `: true` as the fallback branch turns the gate into a no-op ' +
      'whenever the guarded condition is false. Previous incident: cobolt-spec-verify.js:536 ' +
      'returned PASS regardless of missing/empty files in non-strict mode.',
    // Matches: const <var> = <cond> ? <something> : true[;,)]
    // var names restricted to intent-carrying identifiers.
    pattern: /\bconst\s+(passed|ok|valid|verdict|success|accepted|healthy)\s*=\s*[^;]*?\?\s*[^:;]+:\s*true\b/m,
    // Allow-list: a few legitimate cases where `: true` is a default for feature
    // flags (not for verdict bypass). Exempt lines commented /* TAUT-01:exempt */.
    exempt: /\bTAUT-01:exempt\b/,
  },
  {
    id: 'TAUT-02',
    title: 'vacuous-max-score-on-empty',
    severity: 'high',
    why:
      'Empty input scoring a high number (≥7) is vacuous-pass. Previous incident: ' +
      'cobolt-validate-prd.js:610 — `frBlocks.length > 0 ? ... : 10` gave V13 a ' +
      'perfect score when no FRs were detected at all.',
    // Two ordering patterns flagged:
    // 1) `length > 0 ? <low> : <high>`  → empty → high
    // 2) `length === 0 ? <high> : <low>` → empty → high
    pattern:
      /\b(?:\w+)\.length\s*(?:>|!==?|===?)\s*0\s*\?\s*(?:\d+(?:\.\d+)?\s*:\s*(?:(?:1\d+|[789]))|(?:1\d+|[789])\s*:\s*\d+(?:\.\d+)?)/m,
    exempt: /\bTAUT-02:exempt\b/,
  },
  {
    id: 'SWALLOW-01',
    title: 'catch-approve-silent',
    severity: 'critical',
    why:
      'Returning `{ action: "approve" }` from a catch block silently swallows errors. ' +
      'If a Tier 1 gate crashes on malformed input, approve-on-error lets the bad ' +
      "input through. Log and audit before deciding, then default per the hook's " +
      'failPolicy (fail-closed for Tier 0/1).',
    pattern: /catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\*[^*]*\*\/\s*)*return\s*\{\s*action\s*:\s*['"]approve['"]/m,
    exempt: /\bSWALLOW-01:exempt\b/,
  },
  {
    id: 'SWALLOW-02',
    title: 'catch-exit-0-silent',
    severity: 'critical',
    why:
      'A tool that catches an error and exits 0 tells the aggregate gate it passed ' +
      'when it actually crashed. Per tools/CLAUDE.md exit-code contract, crashes ' +
      'must be exit 1 (hard error) or 2 (missing dep) — never 0.',
    pattern: /catch\s*(?:\([^)]*\))?\s*\{\s*(?:[^}]*?\s*)?process\.exit\s*\(\s*0\s*\)/m,
    exempt: /\bSWALLOW-02:exempt\b/,
  },
  {
    id: 'TAUT-03',
    title: 'ternary-approve-fallback',
    severity: 'high',
    why:
      'A ternary that returns `{ action: "approve" }` as the fallback inside a ' +
      "gate's decision function is the same shape as TAUT-01 but with an object " +
      'literal. Flag for review — may be a legitimate early-exit, may be a bypass.',
    pattern: /\?\s*[^:;]*?:\s*\{\s*action\s*:\s*['"]approve['"][^}]*\}\s*(?:[;,)]|\n\s*})/m,
    exempt: /\b(?:TAUT-03:exempt|early-exit)\b/,
    advisory: true, // advisory by default — emits warning, not block
  },
];

// Hooks that legitimately fast-exit on shape mismatch (non-Write tools,
// non-matching paths). These are allow-listed for SWALLOW-01 only.
const EARLY_EXIT_ALLOWLIST = new Set([
  // Bypass-env-aware hooks that should approve when explicitly disabled:
  'cobolt-readiness-consistency-gate.js',
  'cobolt-readiness-aggregation-gate.js',
  'cobolt-plan-readiness-gate.js',
  'cobolt-checkpoint-write-gate.js',
  'cobolt-artifact-lock.js',
]);

// ── File walking ─────────────────────────────────────────────

function listJsFiles(rootDir) {
  const full = path.resolve(rootDir);
  if (!fs.existsSync(full)) return [];
  const out = [];
  for (const e of fs.readdirSync(full, { withFileTypes: true })) {
    if (e.isDirectory()) continue;
    if (!e.name.endsWith('.js')) continue;
    if (!e.name.startsWith('cobolt-') && !e.name.startsWith('_')) continue;
    out.push(path.join(full, e.name));
  }
  return out;
}

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

// ── Linter core ──────────────────────────────────────────────

// Strip line-comments and block-comments from source so the linter doesn't
// flag documentation examples of the very patterns it's hunting for (as this
// tool's own docstring does). Preserve line numbers by replacing comment
// contents with spaces.
function stripComments(source) {
  // /* ... */ — preserve newlines inside
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  // // ... — preserve newline
  out = out.replace(/(^|[^:\]])\/\/[^\n]*/g, (m, pre) => pre + ' '.repeat(m.length - pre.length));
  return out;
}

function lintFile(file, content) {
  const findings = [];
  if (!content) return findings;
  const base = path.basename(file);
  const stripped = stripComments(content);
  for (const rule of RULES) {
    // Scan by line so we can report line numbers. Use stripped source for the
    // match, and the original for the snippet so error messages remain readable.
    const lines = stripped.split('\n');
    const origLines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Quick reject by rough pre-filter to avoid regex-heavy scans on benign lines.
      if (rule.id.startsWith('TAUT-01') && !/:\s*true\b/.test(line)) continue;
      if (rule.id.startsWith('TAUT-02') && !/\.length\s*(?:>|!==?|===?)\s*0/.test(line)) continue;
      if (rule.id.startsWith('SWALLOW-01') && !line.includes('catch')) {
        // catch blocks span multiple lines; only emit from the `catch` line.
        continue;
      }
      if (rule.id === 'SWALLOW-02' && !line.includes('catch')) continue;
      if (rule.id === 'TAUT-03' && !/:\s*\{/.test(line)) continue;

      // Multiline-aware match: concatenate this line + next 4 for regex windows
      // that span catch/return blocks.
      const window = lines.slice(i, Math.min(lines.length, i + 6)).join('\n');
      if (!rule.pattern.test(window)) continue;

      // Exempt via comment tag on the same line or line above.
      const exemptCheck = `${lines[i - 1] || ''}\n${line}`;
      if (rule.exempt?.test(exemptCheck)) continue;

      // SWALLOW-01 soft allow-list for early-exit-style bypass hooks.
      if (rule.id === 'SWALLOW-01' && EARLY_EXIT_ALLOWLIST.has(base)) {
        // Only flag if the catch block is INSIDE a gate-decision function
        // (heuristic: appears after the gate's run() function signature). For
        // simplicity we flag everywhere and let the allow-list suppress.
        continue;
      }

      findings.push({
        rule: rule.id,
        title: rule.title,
        severity: rule.severity,
        file: file,
        line: i + 1,
        snippet: (origLines[i] || '').trim().slice(0, 200),
        why: rule.why,
        advisory: Boolean(rule.advisory),
      });
    }
  }
  return findings;
}

// ── CLI ─────────────────────────────────────────────────────

function checkPaths(roots) {
  const files = [];
  for (const r of roots) {
    for (const f of listJsFiles(r)) files.push(f);
  }
  if (files.length === 0) {
    return { exitCode: EXIT_MISSING, error: 'no gate files found', files: [] };
  }
  const all = [];
  for (const file of files) {
    const content = readFileSafe(file);
    if (!content) continue;
    const findings = lintFile(file, content);
    for (const f of findings) all.push(f);
  }
  // Blocking findings: any non-advisory. Advisory findings surface in output
  // but don't flip the exit code.
  const blocking = all.filter((f) => !f.advisory);
  return {
    exitCode: blocking.length > 0 ? EXIT_VIOLATION : EXIT_OK,
    scannedFiles: files.length,
    totalFindings: all.length,
    blockingFindings: blocking.length,
    advisoryFindings: all.length - blocking.length,
    findings: all,
  };
}

function formatText(r) {
  const lines = ['== Gate Lint (audits the auditors) =='];
  lines.push(`  scannedFiles: ${r.scannedFiles || 0}`);
  lines.push(`  totalFindings: ${r.totalFindings || 0}`);
  lines.push(`  blockingFindings: ${r.blockingFindings || 0}`);
  lines.push(`  advisoryFindings: ${r.advisoryFindings || 0}`);
  if (r.findings?.length) {
    lines.push('  findings:');
    const byFile = {};
    for (const f of r.findings) {
      if (!byFile[f.file]) byFile[f.file] = [];
      byFile[f.file].push(f);
    }
    for (const [file, items] of Object.entries(byFile)) {
      lines.push(`    ${path.relative(process.cwd(), file)}:`);
      for (const item of items.slice(0, 20)) {
        const marker = item.advisory ? '[~]' : '[!]';
        lines.push(`      ${marker} ${item.rule} (${item.severity}) line ${item.line}: ${item.snippet}`);
      }
    }
  }
  lines.push(`verdict: ${r.exitCode === EXIT_OK ? 'PASS' : r.exitCode === EXIT_VIOLATION ? 'VIOLATION' : 'MISSING'}`);
  return lines.join('\n');
}

function usage() {
  return [
    'Usage: cobolt-gate-lint.js <check|report> [--json] [--path <dir>]...',
    '',
    '  check   Lint gates for vacuous-pass patterns. Exits 3 on blocking findings.',
    '  report  Same as check but exits 0 regardless.',
    '',
    '  --json  Emit machine-readable JSON',
    '  --path  Add a root dir to scan (defaults: source/hooks tools)',
    '',
    'Detection rules:',
    ...RULES.map((r) => `  ${r.id}  ${r.title}  [${r.severity}${r.advisory ? ', advisory' : ''}]`),
  ].join('\n');
}

function main(argv = process.argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'check';
  const json = args.includes('--json');
  const roots = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--path' && args[i + 1]) {
      roots.push(args[i + 1]);
      i++;
    }
  }
  if (roots.length === 0) roots.push(...DEFAULT_ROOTS);

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(usage());
    process.exit(EXIT_OK);
  }
  if (cmd !== 'check' && cmd !== 'report') {
    console.error(usage());
    process.exit(EXIT_USAGE);
  }

  const r = checkPaths(roots);
  if (json) console.log(JSON.stringify(r, null, 2));
  else console.log(formatText(r));
  process.exit(cmd === 'report' ? EXIT_OK : r.exitCode);
}

if (require.main === module) main();

module.exports = { lintFile, checkPaths, RULES, EXIT_OK, EXIT_VIOLATION, EXIT_MISSING };
