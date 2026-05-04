#!/usr/bin/env node

// CoBolt Escalation Report (CRK Slice 4 / Phase A).
//
// Per-milestone rollup of the escalation-events ledger. Phase A: minimal
// counts + per-class breakdown + per-agent first-strike-success rate. The
// dashboard, per-agent reliability scorecard, and lessons-aggregation join
// land in later phases (per plan §6).
//
// Subcommands:
//   report   --milestone Mn [--format md|json] [--out <path>]
//
// Exit codes (per tools/CLAUDE.md):
//   0  report generated
//   1  input error
//   2  missing dep (events lib unreachable)
//
// Output paths (when --out absent):
//   md   → _cobolt-output/latest/escalation/<milestone>-report.md
//   json → _cobolt-output/latest/escalation-summary.json

const fs = require('node:fs');
const path = require('node:path');

function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const sub = argv[0];
  const rest = argv.slice(1);

  try {
    switch (sub) {
      case 'report':
        cmdReport(rest);
        break;
      default:
        process.stderr.write(`[cobolt-escalation-report] Unknown subcommand: ${sub}\n`);
        printUsage();
        process.exit(1);
    }
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      process.stderr.write(`[cobolt-escalation-report] missing-dep: ${err.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`[cobolt-escalation-report] error: ${err.message}\n`);
    if (process.env.COBOLT_ESCALATE_DEBUG) process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

// ── Subcommand implementations ───────────────────────────────────────────

function cmdReport(args) {
  const events = require(path.resolve(__dirname, '..', 'lib', 'cobolt-escalation-events.js'));

  const milestone = optionalFlag(args, '--milestone'); // null = all
  const format = optionalFlag(args, '--format') || 'json';
  const outFlag = optionalFlag(args, '--out');
  const projectRoot = optionalFlag(args, '--project-root') ?? process.cwd();

  const all = events.readEvents({ projectRoot });
  const filtered = milestone ? all.filter((e) => e.milestone === milestone) : all;

  const summary = computeSummary(filtered, milestone);

  let outPath = outFlag;
  if (!outPath) {
    if (format === 'md') {
      outPath = path.join(projectRoot, '_cobolt-output', 'latest', 'escalation', `${milestone || 'all'}-report.md`);
    } else {
      outPath = path.join(projectRoot, '_cobolt-output', 'latest', 'escalation-summary.json');
    }
  }

  let body;
  if (format === 'md') {
    body = renderMarkdown(summary);
  } else if (format === 'json') {
    body = `${JSON.stringify(summary, null, 2)}\n`;
  } else {
    throw new Error(`--format must be 'md' or 'json' (got '${format}')`);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, body);

  if (hasFlag(args, '--print')) {
    process.stdout.write(body);
  } else {
    process.stdout.write(`Report (${format}) → ${outPath}\n`);
    process.stdout.write(
      `  events=${summary.totalEvents} classes=${Object.keys(summary.byClass).length} agents=${Object.keys(summary.byAgent).length}\n`,
    );
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function computeSummary(events, milestone) {
  const summary = {
    milestone: milestone ?? '(all)',
    generatedAt: new Date().toISOString(),
    totalEvents: events.length,
    byClass: {},
    byAction: {},
    byAgent: {},
    fabrications: 0,
    plateauHits: 0,
    firstStrikeAgreement: { agree: 0, disagree: 0 },
  };

  for (const ev of events) {
    const cls = ev.failureSignal?.class || 'UNKNOWN';
    const action = ev.decision?.action || 'unknown';
    const agent = ev.agent || 'unknown';
    summary.byClass[cls] = (summary.byClass[cls] || 0) + 1;
    summary.byAction[action] = (summary.byAction[action] || 0) + 1;
    summary.byAgent[agent] = (summary.byAgent[agent] || 0) + 1;
    if (cls === 'FABRICATION' || ev.outcome?.verdict === 'fabricated') summary.fabrications += 1;
    if (cls === 'NON_CONVERGENCE' || ev.outcome?.verdict === 'plateau') summary.plateauHits += 1;
  }

  return summary;
}

function renderMarkdown(summary) {
  const lines = [];
  lines.push(`# Escalation Report — ${summary.milestone}`);
  lines.push('');
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push(`Total events: **${summary.totalEvents}**`);
  lines.push('');
  lines.push('## By failure class');
  lines.push('');
  lines.push('| Class | Count |');
  lines.push('|---|---|');
  for (const [k, v] of sortedEntries(summary.byClass)) {
    lines.push(`| \`${k}\` | ${v} |`);
  }
  lines.push('');
  lines.push('## By decision action');
  lines.push('');
  lines.push('| Action | Count |');
  lines.push('|---|---|');
  for (const [k, v] of sortedEntries(summary.byAction)) {
    lines.push(`| \`${k}\` | ${v} |`);
  }
  lines.push('');
  lines.push('## By agent (top 20)');
  lines.push('');
  lines.push('| Agent | Events |');
  lines.push('|---|---|');
  for (const [k, v] of sortedEntries(summary.byAgent).slice(0, 20)) {
    lines.push(`| \`${k}\` | ${v} |`);
  }
  lines.push('');
  lines.push('## Risk signals');
  lines.push('');
  lines.push(`- **Fabrications**: ${summary.fabrications}`);
  lines.push(`- **Plateau hits**: ${summary.plateauHits}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function sortedEntries(obj) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1]);
}

function flagValue(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const next = args[i + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function optionalFlag(args, name) {
  const v = flagValue(args, name);
  if (v === undefined || v === true) return undefined;
  return v;
}

function printUsage() {
  process.stdout.write(
    [
      'cobolt-escalation-report — Per-milestone rollup of escalation-events.jsonl',
      '',
      'Usage:',
      '  cobolt-escalation-report report [--milestone Mn] [--format md|json] [--out <path>] [--print]',
      '',
      'Defaults:',
      '  --format json',
      '  --out    _cobolt-output/latest/escalation-summary.json (json) OR',
      '           _cobolt-output/latest/escalation/<milestone>-report.md (md)',
      '',
      'Exit codes:',
      '  0  report written',
      '  1  input error',
      '  2  missing dep',
      '',
    ].join('\n'),
  );
}

// Programmatic API (tests + downstream tools).
module.exports = {
  main,
  computeSummary,
  renderMarkdown,
};
