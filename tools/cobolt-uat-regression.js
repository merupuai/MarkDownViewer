#!/usr/bin/env node

// CoBolt UAT Regression Replay
//
// UAT cases generated for M(k) are saved to _cobolt-output/uat-suite/ and
// re-run automatically at the end of every later M(n>k) against the live
// deployed app. Regressions block dream/release/deploy via
// cobolt-uat-regression-gate.js.
//
// Storage model: append-only cases per milestone, each case is a json file
// with the Playwright steps/assertions needed to re-execute.
//
//   _cobolt-output/uat-suite/
//     M1/
//       case-001.json
//       case-002.json
//     M2/
//       case-001.json
//
// A case has:
//   {id, milestone, title, steps: [{action, selector, value?}], assertions: [...]}
//
// Usage:
//   cobolt-uat-regression.js save --milestone M1 --cases-file <path>
//   cobolt-uat-regression.js replay --milestone M3   # replays M1+M2
//   cobolt-uat-regression.js list [--milestone M3]
//
// Tier 6.2 — v0.11.0.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function suiteDir() {
  return path.join(process.cwd(), '_cobolt-output', 'uat-suite');
}

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
}

function save(opts) {
  if (!opts.milestone) throw new Error('--milestone required');
  if (!opts.casesFile) throw new Error('--cases-file required');
  if (!fs.existsSync(opts.casesFile)) throw new Error(`cases file not found: ${opts.casesFile}`);

  const cases = JSON.parse(fs.readFileSync(opts.casesFile, 'utf8'));
  if (!Array.isArray(cases)) throw new Error('cases file must contain a JSON array');

  const dir = path.join(suiteDir(), opts.milestone);
  ensureDir(dir);

  let written = 0;
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const id = c.id || `case-${String(i + 1).padStart(3, '0')}`;
    const fp = path.join(dir, `${id}.json`);
    fs.writeFileSync(fp, JSON.stringify({ milestone: opts.milestone, id, ...c }, null, 2));
    written++;
  }
  return { ok: true, milestone: opts.milestone, cases: written, dir };
}

function listCases(currentMilestoneId) {
  const root = suiteDir();
  if (!fs.existsSync(root)) return [];
  const out = [];
  const curNum = Number(String(currentMilestoneId || '').replace(/^M/, '')) || Infinity;
  for (const m of fs.readdirSync(root)) {
    const mNum = Number(String(m).replace(/^M/, ''));
    if (!Number.isFinite(mNum)) continue;
    // Only include PRIOR milestones
    if (currentMilestoneId && mNum >= curNum) continue;
    const dir = path.join(root, m);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        out.push({ milestone: m, id: path.basename(f, '.json'), path: path.join(dir, f) });
      } catch {}
    }
  }
  return out;
}

function runCase(c) {
  // Delegate to an explicit runner command provided by env:
  //   COBOLT_UAT_REPLAY_CMD="node scripts/replay-uat.js --case {CASE}"
  // The {CASE} token is replaced with the absolute path to the case json.
  // If no runner declared, mark as 'skipped' — tests become a regression
  // trip-wire only once the project wires a runner (typical shape: a
  // Playwright script that reads case.steps[] and executes them).
  const template = process.env.COBOLT_UAT_REPLAY_CMD;
  if (!template) {
    return { id: c.id, milestone: c.milestone, status: 'skipped', reason: 'COBOLT_UAT_REPLAY_CMD not set' };
  }
  const cmd = template.replace('{CASE}', c.path);
  const parts = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  const program = parts[0];
  const args = parts.slice(1).map((s) => s.replace(/^["']|["']$/g, ''));
  try {
    execFileSync(program, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    return { id: c.id, milestone: c.milestone, status: 'pass' };
  } catch (err) {
    return { id: c.id, milestone: c.milestone, status: 'fail', error: err.message };
  }
}

function replay(opts) {
  const milestone = opts.milestone;
  if (!milestone) throw new Error('--milestone required');

  const cases = listCases(milestone);
  if (cases.length === 0) return { ok: true, milestone, replayed: 0, failures: [] };

  const results = cases.map((c) => {
    let caseData = null;
    try {
      caseData = JSON.parse(fs.readFileSync(c.path, 'utf8'));
    } catch {
      return { id: c.id, milestone: c.milestone, status: 'fail', error: 'unreadable case' };
    }
    return runCase({ ...c, data: caseData });
  });

  const failures = results.filter((r) => r.status === 'fail');

  // Write verdict
  const dir = path.join(process.cwd(), '_cobolt-output', 'latest', 'uat-regression');
  ensureDir(dir);
  const verdictPath = path.join(dir, `${milestone}-replay-verdict.json`);
  const verdict = {
    milestone,
    verdict: failures.length === 0 ? 'pass' : 'fail',
    replayed: results.length,
    failures: failures.length,
    results,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(verdictPath, JSON.stringify(verdict, null, 2));

  return { ok: failures.length === 0, milestone, replayed: results.length, failures, verdictPath };
}

function list(milestone) {
  const cases = listCases(milestone || null);
  console.log(JSON.stringify({ count: cases.length, cases }, null, 2));
  return 0;
}

function parseFlags(args) {
  const out = { _: [], milestone: null, casesFile: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--milestone') out.milestone = args[++i];
    else if (args[i] === '--cases-file') out.casesFile = args[++i];
    else out._.push(args[i]);
  }
  return out;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  try {
    switch (cmd) {
      case 'save': {
        console.log(JSON.stringify(save(flags), null, 2));
        return 0;
      }
      case 'replay': {
        const r = replay(flags);
        console.log(JSON.stringify(r, null, 2));
        return r.ok ? 0 : 1;
      }
      case 'list':
        return list(flags.milestone);
      default:
        console.error(
          'Usage: cobolt-uat-regression.js {save --milestone M1 --cases-file F | replay --milestone M3 | list}',
        );
        return 1;
    }
  } catch (err) {
    console.error(`[cobolt-uat-regression] ${err.message}`);
    return 1;
  }
}

if (require.main === module) process.exit(main());

module.exports = { save, replay, listCases };
