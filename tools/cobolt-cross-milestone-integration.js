#!/usr/bin/env node

// CoBolt Cross-Milestone Integration Suite Tool
//
// Verifies that the integration test suite GROWS cumulatively: for milestone
// M_n (n>1), every prior milestone M1..M_{n-1} must still have passing
// integration coverage for its cross-milestone / scope:integration FRs.
//
// CLI:
//   node tools/cobolt-cross-milestone-integration.js run --milestone M3 [--json]
//   node tools/cobolt-cross-milestone-integration.js check --milestone M3 [--json]
//
// Programmatic: require(...).checkCrossMilestoneIntegration({ cwd, milestone })

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const FRESH_MS = 48 * 3600 * 1000;

function parseMilestoneNum(m) {
  const match = String(m || '').match(/^M(\d+)$/);
  return match ? Number(match[1]) : NaN;
}

function readJson(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

function gitHead(cwd) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function defaultSuiteDir(cwd, configured) {
  if (configured) return path.isAbsolute(configured) ? configured : path.join(cwd, configured);
  return path.join(cwd, 'tests', 'integration', 'cross-milestone');
}

function readConfiguredSuiteDir(cwd) {
  const cfg = readJson(path.join(cwd, 'cobolt-state.json')) || {};
  return cfg.integration?.crossMilestoneSuiteDir || cfg.pipeline?.crossMilestoneIntegrationDir || null;
}

function listPriorMilestones(cwd, currentNum) {
  const root = path.join(cwd, '_cobolt-output', 'latest', 'planning', 'milestones');
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root)) {
    const n = parseMilestoneNum(entry);
    if (Number.isFinite(n) && n < currentNum) out.push(`M${n}`);
  }
  return out.sort((a, b) => parseMilestoneNum(a) - parseMilestoneNum(b));
}

function readRtmFrs(cwd, milestone) {
  // Try per-milestone rtm.json first, then global rtm.json filtered by milestone.
  const perMilestone = path.join(cwd, '_cobolt-output', 'latest', 'planning', 'milestones', milestone, 'rtm.json');
  const global = path.join(cwd, '_cobolt-output', 'latest', 'planning', 'rtm.json');
  const docs = [];
  const per = readJson(perMilestone);
  if (per) docs.push(per);
  const glob = readJson(global);
  if (glob) docs.push(glob);

  const frs = [];
  for (const doc of docs) {
    const items = Array.isArray(doc) ? doc : doc.requirements || doc.frs || doc.items || [];
    for (const fr of items) {
      if (!fr || typeof fr !== 'object') continue;
      const frMilestone = fr.milestone || fr.targetMilestone;
      if (frMilestone && frMilestone !== milestone) continue;
      const scope = String(fr.scope || '').toLowerCase();
      const crossMs = fr['cross-milestone'] === true || fr.crossMilestone === true;
      if (scope === 'integration' || crossMs) {
        const id = fr.id || fr.frId || fr.code;
        if (id) frs.push(String(id));
      }
    }
    if (frs.length) break;
  }
  return Array.from(new Set(frs));
}

function checkCrossMilestoneIntegration({ cwd = process.cwd(), milestone } = {}) {
  const gaps = [];
  const failures = [];
  const num = parseMilestoneNum(milestone);

  if (!Number.isFinite(num)) {
    return { ok: false, gaps: ['invalid-milestone'], failures: [`Invalid milestone: ${milestone}`] };
  }
  if (num <= 1) {
    return { ok: true, gaps: [], failures: [], reason: 'M1 has no prior milestones' };
  }

  const suiteDir = defaultSuiteDir(cwd, readConfiguredSuiteDir(cwd));
  if (!fs.existsSync(suiteDir)) {
    gaps.push(`integration-suite-missing:${suiteDir}`);
  }

  const verdictPath = path.join(
    cwd,
    '_cobolt-output',
    'latest',
    'integration',
    `${milestone}-cross-milestone-verdict.json`,
  );

  const verdict = readJson(verdictPath);
  if (!verdict) {
    gaps.push(`verdict-missing:${verdictPath}`);
    return { ok: false, gaps, failures, suiteDir, verdictPath };
  }

  // Freshness
  const measuredAt = Date.parse(verdict.measuredAt || '') || 0;
  if (!measuredAt || Date.now() - measuredAt > FRESH_MS) {
    failures.push(`verdict-stale:measuredAt=${verdict.measuredAt || 'unknown'}`);
  }

  // gitSha
  const head = gitHead(cwd);
  if (head && verdict.gitSha && verdict.gitSha !== head) {
    failures.push(`verdict-git-drift:verdict=${verdict.gitSha} head=${head}`);
  }

  // Totals / failed
  const totalTests = Number(verdict.totalTests || 0);
  const _passed = Number(verdict.passed || 0);
  const failed = Number(verdict.failed || 0);
  if (failed > 0) failures.push(`failing-tests:${failed}`);
  if (totalTests === 0) failures.push('no-tests');

  // Cumulative coverage
  const priors = listPriorMilestones(cwd, num);
  const perMilestone = verdict.perMilestone || {};
  for (const prior of priors) {
    const entry = perMilestone[prior];
    if (!entry) {
      gaps.push(`missing-prior-coverage:${prior}`);
      continue;
    }
    const tests = Number(entry.tests || 0);
    const pPassed = Number(entry.passed || 0);
    if (tests === 0) gaps.push(`prior-has-no-tests:${prior}`);
    if (pPassed < tests) failures.push(`prior-regressed:${prior}:${pPassed}/${tests}`);

    // Per-FR integration coverage for that prior
    const requiredFrs = readRtmFrs(cwd, prior);
    const coveredFrs = Array.isArray(entry.coveredFrs) ? entry.coveredFrs.map(String) : [];
    for (const fr of requiredFrs) {
      if (!coveredFrs.includes(fr)) gaps.push(`fr-not-covered:${prior}:${fr}`);
    }
  }

  const ok = gaps.length === 0 && failures.length === 0;
  return { ok, gaps, failures, suiteDir, verdictPath, priorsChecked: priors };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--milestone' || a === '-m') out.milestone = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--cwd') out.cwd = argv[++i];
    else if (!a.startsWith('--')) out._.push(a);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'check';
  const cwd = args.cwd || process.cwd();
  if (!args.milestone) {
    process.stderr.write('Usage: cobolt-cross-milestone-integration <run|check> --milestone M<n> [--json]\n');
    process.exit(2);
  }

  if (cmd !== 'run' && cmd !== 'check') {
    process.stderr.write(`Unknown command: ${cmd}\n`);
    process.exit(2);
  }

  const result = checkCrossMilestoneIntegration({ cwd, milestone: args.milestone });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const status = result.ok ? 'PASS' : 'FAIL';
    process.stdout.write(`cross-milestone-integration ${args.milestone}: ${status}\n`);
    if (result.gaps.length) process.stdout.write(`  gaps:\n${result.gaps.map((g) => `    - ${g}`).join('\n')}\n`);
    if (result.failures.length)
      process.stdout.write(`  failures:\n${result.failures.map((f) => `    - ${f}`).join('\n')}\n`);
  }

  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { checkCrossMilestoneIntegration };
