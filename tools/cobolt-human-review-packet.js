#!/usr/bin/env node
// S1 — Build human review packet for a milestone boundary (--rigorous).
// Usage: node tools/cobolt-human-review-packet.js M3
//
// Exit-code contract (per tools/CLAUDE.md):
//   0 = success
//   1 = hard error (write failure, unhandled exception)

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function printHelp() {
  console.log(`Usage: node ${path.basename(__filename)} <milestone>

Build a human review packet for a milestone boundary (--rigorous mode).
Writes to _cobolt-output/reports/<milestone>/human-review-packet.md.

Args:
  <milestone>   Milestone id (e.g. M1, M2). Defaults to M1.

Flags:
  --help, -h    Show this help and exit

Exit codes:
  0  Success
  1  Hard error (write failure, unhandled exception)
`);
}

function parseArgs(argv = process.argv.slice(2)) {
  const positional = argv.filter((a) => !a.startsWith('-'));
  return {
    milestone: positional[0] || 'M1',
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

const readJSON = (p, d) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return d;
  }
};
const readLines = (p) => {
  try {
    return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
const git = (args, cwd) => {
  try {
    return execFileSync('git', ['--no-pager', ...args], { cwd, timeout: 10000 })
      .toString()
      .trim();
  } catch {
    return '';
  }
};

function build(milestone = 'M1') {
  const CWD = process.cwd();
  const M = milestone || 'M1';
  const REPORT_DIR = path.join(CWD, '_cobolt-output', 'reports', M);
  const OUT = path.join(REPORT_DIR, 'human-review-packet.md');

  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const report = readJSON(path.join(REPORT_DIR, 'milestone-report.json'), {});
  const contracts = readJSON(path.join(CWD, '_cobolt-output', 'latest', 'planning', 'interface-contracts.json'), {
    contracts: [],
  });
  const decay = readLines(path.join(CWD, '_cobolt-output', 'audit', 'fix-decay.jsonl'))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((x) => x.milestone === M);
  const illusions = readLines(path.join(CWD, '_cobolt-output', 'audit', 'illusion-log.jsonl'))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((x) => x.milestone === M);

  const since = git(['log', '--format=%H', '-n', '1', '--grep', `${M}-start`], CWD) || 'HEAD~50';
  const diffStat = git(['diff', '--stat', `${since}..HEAD`], CWD);
  const filesChanged = git(['diff', '--name-only', `${since}..HEAD`], CWD)
    .split('\n')
    .filter(Boolean);

  const drift = [];
  const invPath = path.join(CWD, '_cobolt-output', 'latest', 'invariants', `${M}-violations.json`);
  const inv = readJSON(invPath, { violations: [] });
  for (const v of inv.violations || []) drift.push(`- **${v.adr}**: ${v.summary}`);

  const openContracts = (contracts.contracts || []).filter((c) => c.milestone === M && c.status !== 'satisfied');

  const edges = [
    ...decay
      .filter((d) => ['plateau', 'decay'].includes(d.verdict))
      .slice(0, 3)
      .map((d) => `- Fix-loop **${d.verdict}** at iter ${d.iteration}: ${d.summary || d.category || 'n/a'}`),
    ...illusions
      .filter((i) => ['critical', 'high'].includes(i.severity))
      .slice(0, 3)
      .map((i) => `- Illusion (**${i.severity}**): ${i.file}:${i.line} — ${i.summary}`),
  ];

  const questions = [
    `1. Are the ${drift.length} architectural drift items acceptable, or do any need rework?`,
    `2. Should any of the ${openContracts.length} open contracts block ${M} advance?`,
    `3. Any low-confidence edge flagged below you want re-tested before deploy?`,
    `4. Load/chaos verdict reviewed and acceptable?`,
    `5. Ready to proceed to next milestone?`,
  ];

  const md = `# Human Review Packet — ${M}

_Generated_: ${new Date().toISOString()}
_Grade_: ${report.grade || 'n/a'}  _Score_: ${report.score || 'n/a'}

## Diff summary
\`\`\`
${diffStat || '(no diff data available)'}
\`\`\`
Files changed: **${filesChanged.length}**

## Architectural drift vs architecture.md
${drift.length ? drift.join('\n') : '_No declared invariant violations detected._'}

## Open contract questions
${openContracts.length ? openContracts.map((c) => `- ${c.id}: ${c.name} (${c.status})`).join('\n') : '_All milestone contracts satisfied._'}

## Low-confidence edges
${edges.length ? edges.join('\n') : '_None flagged by pipeline._'}

## Targeted questions
${questions.join('\n')}

---
**Approve**: \`node bin/cobolt-approve.js ${M} --approve --signer <name>\`
**Reject**:  \`node bin/cobolt-approve.js ${M} --reject --signer <name> --note "<reason>"\`
`;

  fs.writeFileSync(OUT, md);
  process.stdout.write(`wrote ${path.relative(CWD, OUT)}\n`);
  return { outputPath: OUT, milestone: M };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  try {
    build(args.milestone);
    process.exit(0);
  } catch (err) {
    console.error(`[cobolt-human-review-packet] ${err.message || err}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { build, parseArgs };
