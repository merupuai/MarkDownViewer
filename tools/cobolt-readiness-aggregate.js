#!/usr/bin/env node

// CoBolt Readiness Aggregate — ensures readiness-report.md / readiness-report.json
// cannot claim READY FOR BUILD when underlying planning gates fail.
//
// Runs five deterministic gates and aggregates their exit codes:
//   1. cobolt-readiness-check check --json
//   2. cobolt-source-coverage.js check --threshold 100 --json
//   3. cobolt-planning-integrity.js check --json --strict
//   4. cobolt-epic-milestone-parity.js check --json --strict-fr-orphans
//   5. cobolt-feature-coverage.js check --stage final --json
//
// Also runs the new v0.26 companions:
//   6. cobolt-planning-counts.js check --json
//   7. cobolt-trace-tag-coverage.js check --json
//   8. cobolt-story-census.js check --json
//   9. cobolt-dossier-depth.js check --json
//
// If readiness-report.json claims PASS/CONDITIONAL but any gate returned non-zero,
// the report verdict is downgraded to FAIL and rewritten (idempotent). An audit
// record is appended to _cobolt-output/audit/readiness-aggregation.jsonl.
//
// Commands:
//   check [--json] [--rewrite]
//   verdict [--json]                (read-only — returns effective verdict)
//
// Exit codes:
//   0 = aggregate verdict PASS (all gates green OR report already correctly FAIL)
//   1 = usage error
//   2 = planning dir missing
//   8 = aggregate verdict FAIL (one or more gates failed)

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { getPlanningDir, safeReadJson } = require('../lib/cobolt-planning-artifacts');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_MISSING = 2;
const EXIT_FAIL = 8;

const GATES = [
  { name: 'readiness-check', tool: 'cobolt-readiness-check.js', args: ['check', '--json'] },
  { name: 'source-coverage', tool: 'cobolt-source-coverage.js', args: ['check', '--threshold', '100', '--json'] },
  { name: 'planning-integrity', tool: 'cobolt-planning-integrity.js', args: ['check', '--json', '--strict'] },
  {
    name: 'epic-milestone-parity',
    tool: 'cobolt-epic-milestone-parity.js',
    args: ['check', '--json', '--strict-fr-orphans'],
  },
  { name: 'feature-coverage', tool: 'cobolt-feature-coverage.js', args: ['check', '--stage', 'final', '--json'] },
  { name: 'planning-counts', tool: 'cobolt-planning-counts.js', args: ['check', '--json'] },
  { name: 'trace-tag-coverage', tool: 'cobolt-trace-tag-coverage.js', args: ['check', '--json'] },
  { name: 'story-census', tool: 'cobolt-story-census.js', args: ['check', '--json'] },
  { name: 'dossier-depth', tool: 'cobolt-dossier-depth.js', args: ['check', '--json'] },
  // v0.29 — Meru planning-incident closers (Blockers #4, #5, #7, #8, #9)
  { name: 'planning-count-parity', tool: 'cobolt-planning-count-parity.js', args: ['check', '--json'] },
  { name: 'fr-split-integrity', tool: 'cobolt-fr-split-integrity.js', args: ['check', '--json'] },
  { name: 'referenced-artifacts', tool: 'cobolt-referenced-artifacts.js', args: ['check', '--json'] },
  { name: 'data-model-completeness', tool: 'cobolt-data-model-completeness.js', args: ['check', '--json'] },
  { name: 'adr-resolution', tool: 'cobolt-adr-resolution.js', args: ['check', '--json'] },
  { name: 'rtm-mapped-integrity', tool: 'cobolt-rtm-mapped-integrity.js', args: ['check', '--json'] },
  { name: 'openapi-presence', tool: 'cobolt-openapi-presence.js', args: ['check', '--json'] },
  // v0.29 — spec-quality wired at plan-close (Blocker #12)
  { name: 'spec-quality', tool: 'cobolt-spec-quality.js', args: ['verify', '--json'] },
];

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function runGate(toolName, toolArgs) {
  const toolPath = path.join(__dirname, toolName);
  if (!fs.existsSync(toolPath)) return { exitCode: 127, stdout: '', stderr: 'tool-not-found' };
  try {
    const stdout = execFileSync(process.execPath, [toolPath, ...toolArgs], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      exitCode: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : String(err.message),
    };
  }
}

function classifyExit(code) {
  if (code === 0) return 'PASS';
  // Exit 2 = missing dep / missing planning inputs — Tier 2 skip semantics.
  if (code === 2) return 'SKIP';
  // Everything else (1=hard-error, 3=drift/violation, 4=tier-1-block, etc.)
  // is a FAIL for the aggregate gate. v0.29: previously exit 3 was classified
  // as SKIP which caused census-violation tools (artifact-parity and the new
  // Meru incident closers) to silently pass. Per tools/CLAUDE.md: "Tier 1
  // gate: exit 3 = FAIL".
  return 'FAIL';
}

function writeAudit(root, record) {
  const auditDir = path.join(root, '_cobolt-output', 'audit');
  try {
    fs.mkdirSync(auditDir, { recursive: true });
    fs.appendFileSync(path.join(auditDir, 'readiness-aggregation.jsonl'), `${JSON.stringify(record)}\n`);
  } catch {
    // Best-effort; never fail the gate on audit-log IO.
  }
}

function rewriteReport(pd, aggregate) {
  const jsonPath = path.join(pd, 'readiness-report.json');
  const mdPath = path.join(pd, 'readiness-report.md');

  const current = safeReadJson(jsonPath) || {};
  current.verdict = 'FAIL';
  current.reason = 'readiness-aggregation downgraded verdict — one or more planning gates failed';
  current.aggregate = aggregate;
  current.aggregatedAt = new Date().toISOString();

  try {
    fs.writeFileSync(jsonPath, JSON.stringify(current, null, 2));
  } catch {
    // ignore
  }

  // Append banner to .md
  try {
    if (fs.existsSync(mdPath)) {
      const banner = [
        '',
        '> **⚠ readiness aggregation — DOWNGRADED to FAIL**',
        `> ${current.reason}`,
        '> Failing gates:',
        ...aggregate.gates.filter((g) => g.status === 'FAIL').map((g) => `> - ${g.name} (exit ${g.exitCode})`),
        '',
      ].join('\n');
      const cur = fs.readFileSync(mdPath, 'utf8');
      if (!cur.includes('readiness aggregation — DOWNGRADED')) {
        fs.writeFileSync(mdPath, `${cur}\n${banner}\n`);
      }
    }
  } catch {
    // ignore
  }
}

function aggregate() {
  const pd = getPlanningDir(process.cwd(), { create: false, fallbackToLatest: true });
  if (!pd || !fs.existsSync(pd)) {
    return { verdict: 'SKIP', reason: 'no planning directory', exitCode: EXIT_MISSING };
  }

  const gateResults = [];
  for (const g of GATES) {
    const r = runGate(g.tool, g.args);
    gateResults.push({
      name: g.name,
      tool: g.tool,
      exitCode: r.exitCode,
      status: classifyExit(r.exitCode),
    });
  }

  const failed = gateResults.filter((g) => g.status === 'FAIL');
  const verdict = failed.length === 0 ? 'PASS' : 'FAIL';

  return {
    verdict,
    gates: gateResults,
    failedCount: failed.length,
    planningDir: pd,
    exitCode: verdict === 'PASS' ? EXIT_OK : EXIT_FAIL,
  };
}

function main(argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'check';
  const json = hasFlag(args, '--json');
  const rewrite = hasFlag(args, '--rewrite');

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('Usage: cobolt-readiness-aggregate.js <check|verdict> [--json] [--rewrite]');
    process.exit(EXIT_OK);
  }

  if (cmd !== 'check' && cmd !== 'verdict') {
    console.error(`Unknown command: ${cmd}`);
    process.exit(EXIT_USAGE);
  }

  const result = aggregate();

  if (result.verdict === 'FAIL' && rewrite && result.planningDir) {
    rewriteReport(result.planningDir, result);
  }

  writeAudit(process.cwd(), {
    timestamp: new Date().toISOString(),
    verdict: result.verdict,
    failedCount: result.failedCount || 0,
    gates: result.gates,
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('== Readiness Aggregate ==');
    for (const g of result.gates || []) {
      console.log(`  [${g.status}] ${g.name} (exit ${g.exitCode})`);
    }
    console.log(`verdict: ${result.verdict}`);
  }

  process.exit(result.exitCode);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { aggregate };
