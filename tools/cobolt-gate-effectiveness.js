#!/usr/bin/env node

// CoBolt Gate Effectiveness CLI (GT-03 / v0.58+).
//
// Promotes the gate-firerate sibling to a first-class observability surface.
// gate-firerate answers "is this gate dormant?"; this tool answers "is this
// gate accurate when it fires?" — the GT-03 success criterion that every
// Tier 1 gate has 90-day effectiveness data and Tier 1 gates with > 30%
// false-positive rate trigger an automatic demotion proposal.
//
// Subcommands:
//   report                   Write _cobolt-output/audit/gate-effectiveness.json
//                            and stdout summary. Default invocation.
//   review --quarter Q2-2026 Generate a quarterly markdown gate-health review
//                            at _cobolt-output/audit/gate-health-review-Q2-2026.md.
//   propose-demotions        Append demotion-proposal entries to
//                            _cobolt-output/audit/gate-demotion-proposals.jsonl
//                            for every gate flagged DEMOTE_PROPOSED in the
//                            current report. Idempotent — the same gateId is
//                            only proposed once unless its prior proposal has
//                            been applied or dismissed.
//
// Exit codes (per tools/CLAUDE.md):
//   0 — report generated / proposals appended / clean help
//   1 — usage error or unhandled exception
//   2 — no audit input (gate-skip-log.jsonl + gate-bypass-ledger.jsonl both
//       empty/missing). Tier 2 skip-and-report-friendly.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const engine = require(path.resolve(__dirname, '..', 'lib', 'cobolt-gate-effectiveness.js'));

const argv = process.argv.slice(2);

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
    case 'review':
      cmdReview(rest);
      break;
    case 'propose-demotions':
      cmdProposeDemotions(rest);
      break;
    default:
      // Bare invocation with no subcommand defaults to "report" — matches the
      // npm script tools:gate-effectiveness pattern from package.json.
      if (sub.startsWith('--')) {
        cmdReport(argv);
      } else {
        process.stderr.write(`unknown subcommand: ${sub}\n`);
        printUsage();
        process.exit(1);
      }
  }
} catch (err) {
  process.stderr.write(`cobolt-gate-effectiveness: ${err.message}\n`);
  process.exit(1);
}

function printUsage() {
  process.stdout.write(`Usage: cobolt-gate-effectiveness <subcommand> [flags]

Subcommands:
  report                                Write gate-effectiveness.json + stdout summary
  review --quarter Q2-2026              Write gate-health-review-Q2-2026.md
  propose-demotions                     Append demotion proposals to gate-demotion-proposals.jsonl

Common flags:
  --window-days <n>                     Lookback window (default 90)
  --fp-window-hours <n>                 FP correlation window (default 24)
  --fp-rate-threshold <n>               Demotion threshold (default 0.3)
  --min-fires <n>                       Minimum fires for demotion (default 20)
  --json                                Print full report JSON to stdout
  --quiet                               Suppress stdout summary (still writes file)
  --no-write                            Compute only; skip file writes (dry-run)

Outputs (under _cobolt-output/audit/):
  gate-effectiveness.json               Latest report
  gate-health-review-{quarter}.md       Quarterly markdown review
  gate-demotion-proposals.jsonl         Append-only demotion proposals
`);
}

function flagValue(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  return v;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function projectRoot() {
  return process.cwd();
}

function commonOpts(args) {
  const opts = {};
  const w = flagValue(args, '--window-days');
  if (typeof w === 'string') opts.windowDays = Number(w);
  const f = flagValue(args, '--fp-window-hours');
  if (typeof f === 'string') opts.fpCorrelationWindowHours = Number(f);
  const fpr = flagValue(args, '--fp-rate-threshold');
  const mf = flagValue(args, '--min-fires');
  const od = flagValue(args, '--observation-days');
  if (typeof fpr === 'string' || typeof mf === 'string' || typeof od === 'string') {
    opts.thresholds = {
      ...(typeof fpr === 'string' ? { fpRateDemotion: Number(fpr) } : {}),
      ...(typeof mf === 'string' ? { minFiresForDemotion: Number(mf) } : {}),
      ...(typeof od === 'string' ? { observationDaysForDemotion: Number(od) } : {}),
    };
  }
  return opts;
}

function ensureAuditDir() {
  const dir = path.join(projectRoot(), '_cobolt-output', 'audit');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function cmdReport(args) {
  const result = engine.analyze({ projectRoot: projectRoot(), ...commonOpts(args) });
  if (!result.ok) {
    process.stderr.write(`cobolt-gate-effectiveness: ${result.error}\n`);
    process.exit(result.exitCode);
  }
  const reportPath = path.join(projectRoot(), engine.REPORT_REL);
  if (!hasFlag(args, '--no-write')) {
    ensureAuditDir();
    fs.writeFileSync(reportPath, `${JSON.stringify(result.report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  if (hasFlag(args, '--json')) {
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
    return;
  }
  if (!hasFlag(args, '--quiet')) {
    printSummary(result.report, reportPath, hasFlag(args, '--no-write'));
  }
}

function printSummary(report, reportPath, dryRun) {
  const s = report.summary;
  process.stdout.write('== Gate Effectiveness Report ==\n');
  if (dryRun) process.stdout.write('  (dry-run — no file written)\n');
  else process.stdout.write(`  written: ${reportPath}\n`);
  process.stdout.write(`  generatedAt: ${report.generatedAt}\n`);
  process.stdout.write(`  windowDays: ${report.windowDays}\n`);
  process.stdout.write(`  fpCorrelationWindowHours: ${report.fpCorrelationWindowHours}\n`);
  process.stdout.write(`  totalGatesObserved: ${s.totalGatesObserved} / ${s.totalGatesRegistered}\n`);
  process.stdout.write(`  totalFires: ${s.totalFires}\n`);
  process.stdout.write(`  totalFalsePositives: ${s.totalFalsePositives}\n`);
  process.stdout.write(`  demotionProposalCount: ${s.demotionProposalCount}\n`);
  process.stdout.write(`  retireCandidateCount: ${s.retireCandidateCount}\n`);
  if (s.demotionProposalCount > 0) {
    process.stdout.write('  demote-proposed:\n');
    for (const g of report.gates) {
      if (g.recommendation !== 'DEMOTE_PROPOSED') continue;
      process.stdout.write(
        `    - ${g.gateId} (Tier ${g.tier}, ${g.hook}): fpRate=${g.fpRate} fires=${g.fires} days=${g.daysObserved} confidence=${g.confidence}\n`,
      );
    }
    process.stdout.write('  Run: node tools/cobolt-gate-effectiveness.js propose-demotions   to record proposals.\n');
  }
  if (report.warnings) {
    process.stdout.write('  warnings:\n');
    for (const w of report.warnings) process.stdout.write(`    - ${w}\n`);
  }
}

function cmdReview(args) {
  const quarterLabel = flagValue(args, '--quarter');
  if (typeof quarterLabel !== 'string') {
    throw new Error('review: --quarter Q[1-4]-YYYY required (e.g. --quarter Q2-2026)');
  }
  const { startMs, endMs } = engine.quarterWindow(quarterLabel);
  // For a quarterly review we set windowDays so it covers exactly the quarter
  // ending at endMs (or now, whichever is earlier).
  const now = Date.now();
  const reviewEnd = Math.min(endMs, now);
  const windowDays = Math.max(1, Math.ceil((reviewEnd - startMs) / 86_400_000));
  const result = engine.analyze({ projectRoot: projectRoot(), now: reviewEnd, windowDays, ...commonOpts(args) });
  if (!result.ok) {
    process.stderr.write(`cobolt-gate-effectiveness: ${result.error}\n`);
    process.exit(result.exitCode);
  }
  const md = formatReviewMarkdown(result.report, quarterLabel);
  const out = path.join(projectRoot(), '_cobolt-output', 'audit', `gate-health-review-${quarterLabel}.md`);
  const dryRun = hasFlag(args, '--no-write');
  if (!dryRun) {
    ensureAuditDir();
    fs.writeFileSync(out, md, { encoding: 'utf8', mode: 0o600 });
  }
  if (!hasFlag(args, '--quiet')) {
    process.stdout.write(
      dryRun
        ? `Quarterly gate-health review (dry-run; would write): ${out}\n`
        : `Quarterly gate-health review written: ${out}\n`,
    );
    process.stdout.write(`  totalGatesObserved: ${result.report.summary.totalGatesObserved}\n`);
    process.stdout.write(`  demotionProposals: ${result.report.summary.demotionProposalCount}\n`);
    process.stdout.write(`  retireCandidates: ${result.report.summary.retireCandidateCount}\n`);
  }
}

function formatReviewMarkdown(report, quarterLabel) {
  const lines = [];
  lines.push(`# Gate Health Review — ${quarterLabel}`);
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Window: ${report.windowDays} day(s) | FP correlation: ${report.fpCorrelationWindowHours}h`);
  lines.push('');
  lines.push('## Summary');
  const s = report.summary;
  lines.push(`- Gates registered: **${s.totalGatesRegistered}**`);
  lines.push(`- Gates observed (fired ≥1): **${s.totalGatesObserved}**`);
  lines.push(`- Total fires: **${s.totalFires}**`);
  lines.push(
    `- False positives (correlated bypass within ${report.fpCorrelationWindowHours}h): **${s.totalFalsePositives}**`,
  );
  lines.push(`- Demotion proposals: **${s.demotionProposalCount}**`);
  lines.push(`- Retire candidates (zero fires): **${s.retireCandidateCount}**`);
  lines.push('');

  const proposed = report.gates.filter((g) => g.recommendation === 'DEMOTE_PROPOSED');
  if (proposed.length > 0) {
    lines.push('## Demotion proposals (Tier 1 → Tier 2)');
    lines.push('');
    lines.push('| Gate | Hook | fpRate | fires | days | confidence | reason |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const g of proposed) {
      lines.push(
        `| \`${g.gateId}\` | \`${g.hook}\` | ${g.fpRate} | ${g.fires} | ${g.daysObserved} | ${g.confidence} | ${g.recommendationReason} |`,
      );
    }
    lines.push('');
  }

  const monitor = report.gates.filter((g) => g.recommendation === 'MONITOR');
  if (monitor.length > 0) {
    lines.push('## Monitor (elevated FP, sample below demotion floor)');
    lines.push('');
    lines.push('| Gate | Hook | fpRate | fires | days | confidence |');
    lines.push('|---|---|---|---|---|---|');
    for (const g of monitor) {
      lines.push(
        `| \`${g.gateId}\` | \`${g.hook}\` | ${g.fpRate} | ${g.fires} | ${g.daysObserved} | ${g.confidence} |`,
      );
    }
    lines.push('');
  }

  const retire = report.gates.filter((g) => g.recommendation === 'RETIRE_CANDIDATE');
  if (retire.length > 0) {
    lines.push('## Retire candidates (zero fires in window)');
    lines.push('');
    for (const g of retire) {
      lines.push(`- \`${g.gateId}\` (Tier ${g.tier}, \`${g.hook}\`)`);
    }
    lines.push('');
  }

  const top = report.gates
    .filter((g) => g.recommendation !== 'RETIRE_CANDIDATE')
    .sort((a, b) => b.fires - a.fires)
    .slice(0, 20);
  if (top.length > 0) {
    lines.push('## Top 20 by fire volume');
    lines.push('');
    lines.push('| Gate | Tier | fires | blocks | skips | fpRate | medianTtrMs |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const g of top) {
      lines.push(
        `| \`${g.gateId}\` | ${g.tier} | ${g.fires} | ${g.blocks} | ${g.skips} | ${g.fpRate} | ${g.medianTimeToResolveMs} |`,
      );
    }
    lines.push('');
  }

  if (report.warnings) {
    lines.push('## Warnings');
    for (const w of report.warnings) lines.push(`- ${w}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('Generated by `cobolt-gate-effectiveness review` (GT-03). See `docs/GT-03-GATE-EFFECTIVENESS.md`.');
  return `${lines.join('\n')}\n`;
}

function cmdProposeDemotions(args) {
  const result = engine.analyze({ projectRoot: projectRoot(), ...commonOpts(args) });
  if (!result.ok) {
    process.stderr.write(`cobolt-gate-effectiveness: ${result.error}\n`);
    process.exit(result.exitCode);
  }
  const proposed = result.report.gates.filter((g) => g.recommendation === 'DEMOTE_PROPOSED');
  if (proposed.length === 0) {
    if (!hasFlag(args, '--quiet')) {
      process.stdout.write('No gates currently flagged DEMOTE_PROPOSED. No proposals written.\n');
    }
    return;
  }

  ensureAuditDir();
  const reportPath = path.join(projectRoot(), engine.REPORT_REL);
  fs.writeFileSync(reportPath, `${JSON.stringify(result.report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  const reportSha = sha256File(reportPath);

  const proposalsPath = path.join(projectRoot(), engine.PROPOSALS_REL);
  const existing = readExistingProposals(proposalsPath);
  const openByGateId = new Map();
  for (const p of existing) {
    if (p.status === 'pending') openByGateId.set(p.gateId, p);
  }

  let writtenCount = 0;
  let skippedCount = 0;
  const lines = [];
  for (const g of proposed) {
    if (openByGateId.has(g.gateId)) {
      skippedCount += 1;
      continue;
    }
    const proposal = engine.buildDemotionProposal({
      gate: g,
      effectivenessReportPath: path.relative(projectRoot(), reportPath).replace(/\\/g, '/'),
      effectivenessReportSha256: reportSha,
      thresholds: result.report.thresholds,
    });
    lines.push(JSON.stringify(proposal));
    writtenCount += 1;
  }

  if (lines.length > 0) {
    fs.appendFileSync(proposalsPath, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(proposalsPath, 0o600);
    } catch {
      // best-effort on filesystems without mode support
    }
  }

  if (!hasFlag(args, '--quiet')) {
    process.stdout.write(
      `Demotion proposals: wrote ${writtenCount} new, skipped ${skippedCount} (already-pending), report sha256=${reportSha.slice(0, 16)}…\n`,
    );
    if (writtenCount > 0) {
      process.stdout.write(`  Proposals appended to: ${proposalsPath}\n`);
      process.stdout.write('  Inspect with: less _cobolt-output/audit/gate-demotion-proposals.jsonl\n');
    }
  }
}

function readExistingProposals(proposalsPath) {
  if (!fs.existsSync(proposalsPath)) return [];
  const lines = fs.readFileSync(proposalsPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const out = [];
  for (const l of lines) {
    try {
      out.push(JSON.parse(l));
    } catch {
      // tolerate corrupt line; continue
    }
  }
  return out;
}

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

module.exports = {
  // Exposed for tests so the CLI behavior can be re-driven without spawning
  // node subprocesses for every assertion.
  _internal: {
    formatReviewMarkdown,
    readExistingProposals,
    sha256File,
  },
};
