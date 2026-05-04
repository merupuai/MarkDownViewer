#!/usr/bin/env node

// CoBolt Chaos Verdict Emitter
//
// Writes the verdict file that cobolt-chaos-gate checks:
//   _cobolt-output/latest/chaos/{M}-verdict.json
//
// Called by chaos-engineer agent (or manual ops) after running the fault-
// injection scenarios. Without this file, chaos-gate blocks milestones
// that touch network/DB/queue/external API from advancing to
// dream/release/deploy.
//
// Usage:
//   # Emit verdict in one shot
//   node tools/cobolt-chaos-verdict.js emit --milestone M2 --verdict pass \
//     --scenarios '[{"name":"db-kill","result":"pass"},{"name":"net-partition","result":"pass"}]'
//
//   # Record a single scenario result, accumulate
//   node tools/cobolt-chaos-verdict.js scenario --milestone M2 --name db-kill --result pass
//
//   # Finalize (computes overall verdict from accumulated scenarios)
//   node tools/cobolt-chaos-verdict.js finalize --milestone M2
//
//   # Show
//   node tools/cobolt-chaos-verdict.js show --milestone M2
//
// Tier 3.3 I2c — v0.11.0

const fs = require('node:fs');
const path = require('node:path');

function chaosDir() {
  const d = path.join(process.cwd(), '_cobolt-output', 'latest', 'chaos');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

function verdictPath(milestone) {
  return path.join(chaosDir(), `${milestone}-verdict.json`);
}

function readVerdict(m) {
  const fp = verdictPath(m);
  if (!fs.existsSync(fp)) return { milestone: m, scenarios: [], verdict: null };
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return { milestone: m, scenarios: [], verdict: null };
  }
}

function writeVerdict(m, v) {
  fs.writeFileSync(
    verdictPath(m),
    JSON.stringify({ ...v, milestone: m, generatedAt: new Date().toISOString() }, null, 2),
  );
}

function emit(opts) {
  if (!opts.milestone || !opts.verdict) {
    console.error('Usage: emit --milestone Mx --verdict pass|fail [--scenarios <json>]');
    return 1;
  }
  if (!['pass', 'fail'].includes(opts.verdict)) {
    console.error("verdict must be 'pass' or 'fail'");
    return 1;
  }
  let scenarios = [];
  if (opts.scenarios) {
    try {
      scenarios = JSON.parse(opts.scenarios);
    } catch {
      console.error('--scenarios must be a JSON array');
      return 1;
    }
  }
  writeVerdict(opts.milestone, { verdict: opts.verdict, scenarios });
  console.log(
    JSON.stringify(
      {
        ok: true,
        milestone: opts.milestone,
        verdict: opts.verdict,
        scenarios: scenarios.length,
        file: verdictPath(opts.milestone),
      },
      null,
      2,
    ),
  );
  return 0;
}

function scenario(opts) {
  if (!opts.milestone || !opts.name || !opts.result) {
    console.error('Usage: scenario --milestone Mx --name <id> --result pass|fail [--detail <text>]');
    return 1;
  }
  if (!['pass', 'fail'].includes(opts.result)) {
    console.error("result must be 'pass' or 'fail'");
    return 1;
  }
  const v = readVerdict(opts.milestone);
  v.scenarios = v.scenarios.filter((s) => s.name !== opts.name);
  v.scenarios.push({ name: opts.name, result: opts.result, detail: opts.detail || null, ts: new Date().toISOString() });
  // leave overall verdict null until finalize
  writeVerdict(opts.milestone, v);
  console.log(
    JSON.stringify({ ok: true, recorded: opts.name, result: opts.result, total: v.scenarios.length }, null, 2),
  );
  return 0;
}

function finalize(opts) {
  if (!opts.milestone) {
    console.error('--milestone required');
    return 1;
  }
  const v = readVerdict(opts.milestone);
  if (!Array.isArray(v.scenarios) || v.scenarios.length === 0) {
    console.error('no scenarios recorded — run `scenario` first or use `emit` to set directly');
    return 1;
  }
  const anyFail = v.scenarios.some((s) => s.result === 'fail');
  v.verdict = anyFail ? 'fail' : 'pass';
  writeVerdict(opts.milestone, v);
  console.log(
    JSON.stringify(
      {
        ok: true,
        milestone: opts.milestone,
        verdict: v.verdict,
        scenarios: v.scenarios.length,
        file: verdictPath(opts.milestone),
      },
      null,
      2,
    ),
  );
  return anyFail ? 1 : 0;
}

function show(opts) {
  if (!opts.milestone) {
    console.error('--milestone required');
    return 1;
  }
  console.log(JSON.stringify(readVerdict(opts.milestone), null, 2));
  return 0;
}

function parseFlags(args) {
  const out = { _: [], milestone: null, verdict: null, scenarios: null, name: null, result: null, detail: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--milestone') out.milestone = args[++i];
    else if (args[i] === '--verdict') out.verdict = args[++i];
    else if (args[i] === '--scenarios') out.scenarios = args[++i];
    else if (args[i] === '--name') out.name = args[++i];
    else if (args[i] === '--result') out.result = args[++i];
    else if (args[i] === '--detail') out.detail = args[++i];
    else out._.push(args[i]);
  }
  return out;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (cmd) {
    case 'emit':
      return emit(flags);
    case 'scenario':
      return scenario(flags);
    case 'finalize':
      return finalize(flags);
    case 'show':
      return show(flags);
    default:
      console.error(
        'Usage: cobolt-chaos-verdict.js {emit --milestone Mx --verdict pass|fail [--scenarios JSON] | scenario --milestone Mx --name id --result pass|fail [--detail ...] | finalize --milestone Mx | show --milestone Mx}',
      );
      return 1;
  }
}

if (require.main === module) process.exit(main());

module.exports = { emit, scenario, finalize, show };
