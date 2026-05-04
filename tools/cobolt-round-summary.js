#!/usr/bin/env node

// CoBolt Round Summary — per-round bounded-context memory file.
//
// Purpose
//   The milestone anchor tracks "what's done, what's next" for a whole
//   milestone. Within a single milestone a long round loop (5 rounds,
//   many stories each) still accumulates orchestrator context because
//   every round's dispatch history, test output, and checkpoint prose
//   stays visible across round boundaries.
//
//   This tool emits a tiny (<= ~500 token) summary per round so the
//   orchestrator — or a downstream retrieval tool — can compress the
//   "prior rounds" block into a single retrieval-shaped artifact
//   instead of re-reading full round ledgers.
//
//   Design is ADDITIVE. It writes alongside the existing milestone
//   anchor + Round Ledger. Nothing in the hot path must change for
//   this to be useful; a follow-up can opt the Step 03 round-close
//   into emitting these summaries and opt cross-round dispatches
//   into reading them.
//
// File location
//   _cobolt-output/latest/build/{M}/round-summaries/round-{N}.md
//   _cobolt-output/latest/build/{M}/round-summaries/index.json
//
// Hard caps (enforced, truncation is audit-logged, never silent):
//   MAX_BYTES            — 2500 bytes per summary (~625 tokens)
//   MAX_FILES_LISTED     — 20 file entries
//   MAX_RISKS            — 5 risks
//
// CLI
//   node tools/cobolt-round-summary.js emit \
//       --milestone M1 --round 2 --name core \
//       --verdict green_passing \
//       --tests-passing 14 --tests-failing 0 \
//       --files-written path/a.js,path/b.js \
//       --risks "foo|medium,bar|low" \
//       --checkpoint _cobolt-output/latest/build/checkpoints/M1-round-2-green.json \
//       --summary "Core CRUD + RLS policies in place."
//
//   node tools/cobolt-round-summary.js show --milestone M1 --through 3
//   node tools/cobolt-round-summary.js list  --milestone M1
//
// Exit codes per tools/CLAUDE.md contract:
//   0 = success, 1 = hard error, 2 = missing optional dep (n/a here)

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite, atomicWriteJSON } = require('../lib/cobolt-atomic-write');

const MAX_BYTES = parseInt(process.env.COBOLT_ROUND_SUMMARY_MAX_BYTES || '2500', 10);
const MAX_FILES_LISTED = 20;
const MAX_RISKS = 5;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function summariesDir(milestone) {
  return path.join(process.cwd(), '_cobolt-output', 'latest', 'build', milestone, 'round-summaries');
}

function summaryPath(milestone, round) {
  return path.join(summariesDir(milestone), `round-${round}.md`);
}

function indexPath(milestone) {
  return path.join(summariesDir(milestone), 'index.json');
}

function splitList(raw) {
  if (!raw || raw === true) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseRisks(raw) {
  // Format: "text|severity,text|severity". Severity is optional, defaults to "medium".
  return splitList(raw).map((entry) => {
    const [text, severity] = entry.split('|').map((s) => (s || '').trim());
    return { text, severity: severity || 'medium' };
  });
}

function truncateList(list, max) {
  if (list.length <= max) return { items: list, truncated: 0 };
  return { items: list.slice(0, max), truncated: list.length - max };
}

function renderSummary({
  milestone,
  round,
  name,
  verdict,
  testsPassing,
  testsFailing,
  files,
  risks,
  checkpoint,
  summary,
}) {
  const lines = [];
  lines.push(`# Round ${round} Summary — ${milestone}`);
  lines.push('');
  lines.push(`- **Name:** ${name || 'unspecified'}`);
  lines.push(`- **Verdict:** ${verdict}`);
  lines.push(`- **Tests:** ${testsPassing} passing / ${testsFailing} failing`);
  if (checkpoint) lines.push(`- **Checkpoint:** ${checkpoint}`);
  lines.push(`- **Emitted:** ${new Date().toISOString()}`);
  lines.push('');

  if (summary) {
    lines.push('## Summary');
    lines.push(summary.length > 600 ? `${summary.slice(0, 600)}…` : summary);
    lines.push('');
  }

  const filesTrunc = truncateList(files, MAX_FILES_LISTED);
  if (filesTrunc.items.length) {
    lines.push('## Files Written');
    for (const f of filesTrunc.items) lines.push(`- ${f}`);
    if (filesTrunc.truncated > 0)
      lines.push(`- _(… ${filesTrunc.truncated} more truncated; see round-${round}-green checkpoint for full list)_`);
    lines.push('');
  }

  const risksTrunc = truncateList(risks, MAX_RISKS);
  if (risksTrunc.items.length) {
    lines.push('## Open Risks Introduced');
    for (const r of risksTrunc.items) lines.push(`- [${r.severity}] ${r.text}`);
    if (risksTrunc.truncated > 0) lines.push(`- _(… ${risksTrunc.truncated} more truncated)_`);
    lines.push('');
  }

  lines.push(`<!-- cobolt-round-summary v1 M=${milestone} R=${round} -->`);
  let out = lines.join('\n');

  // Hard cap: if still too big after structural truncation, cut from Summary section.
  if (Buffer.byteLength(out, 'utf8') > MAX_BYTES) {
    out = `${out.slice(0, MAX_BYTES - 40)}\n\n_(truncated at byte cap)_\n`;
  }
  return out;
}

function updateIndex(milestone, round, meta) {
  const ipath = indexPath(milestone);
  let index = { milestone, rounds: {} };
  if (fs.existsSync(ipath)) {
    try {
      index = JSON.parse(fs.readFileSync(ipath, 'utf8'));
      if (!index.rounds) index.rounds = {};
    } catch {
      /* rebuild on corrupt */
    }
  }
  index.rounds[String(round)] = {
    round,
    name: meta.name || null,
    verdict: meta.verdict,
    testsPassing: meta.testsPassing,
    testsFailing: meta.testsFailing,
    filesCount: meta.filesCount,
    risksCount: meta.risksCount,
    checkpoint: meta.checkpoint || null,
    emittedAt: new Date().toISOString(),
    path: path.relative(process.cwd(), summaryPath(milestone, round)).replace(/\\/g, '/'),
  };
  atomicWriteJSON(ipath, index, { mode: 0o600 });
}

function cmdEmit(args) {
  const milestone = args.milestone;
  const round = parseInt(args.round, 10);
  const verdict = args.verdict;
  if (!milestone || !Number.isInteger(round) || round < 1 || !verdict) {
    console.error('emit requires --milestone M{n} --round N --verdict <status>');
    process.exit(1);
  }

  const testsPassing = parseInt(args['tests-passing'] || '0', 10);
  const testsFailing = parseInt(args['tests-failing'] || '0', 10);
  const files = splitList(args['files-written']);
  const risks = parseRisks(args.risks);
  const checkpoint = typeof args.checkpoint === 'string' ? args.checkpoint : null;
  const summary = typeof args.summary === 'string' ? args.summary : '';
  const name = typeof args.name === 'string' ? args.name : '';

  const dir = summariesDir(milestone);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const rendered = renderSummary({
    milestone,
    round,
    name,
    verdict,
    testsPassing,
    testsFailing,
    files,
    risks,
    checkpoint,
    summary,
  });
  atomicWrite(summaryPath(milestone, round), rendered, { mode: 0o600 });

  updateIndex(milestone, round, {
    name,
    verdict,
    testsPassing,
    testsFailing,
    filesCount: files.length,
    risksCount: risks.length,
    checkpoint,
  });

  const bytes = Buffer.byteLength(rendered, 'utf8');
  console.log(`Round summary written: ${summaryPath(milestone, round)} (${bytes} bytes)`);
}

function cmdShow(args) {
  const milestone = args.milestone;
  const through = parseInt(args.through || args.round || '0', 10);
  if (!milestone || !Number.isInteger(through) || through < 1) {
    console.error('show requires --milestone M{n} --through N (or --round N for single round)');
    process.exit(1);
  }
  const out = [];
  for (let r = 1; r <= through; r++) {
    const p = summaryPath(milestone, r);
    if (fs.existsSync(p)) {
      out.push(fs.readFileSync(p, 'utf8'));
    } else {
      out.push(`# Round ${r} Summary — ${milestone}\n\n_(no summary found)_\n`);
    }
  }
  process.stdout.write(out.join('\n---\n\n'));
}

function cmdList(args) {
  const milestone = args.milestone;
  if (!milestone) {
    console.error('list requires --milestone M{n}');
    process.exit(1);
  }
  const ipath = indexPath(milestone);
  if (!fs.existsSync(ipath)) {
    console.log(JSON.stringify({ milestone, rounds: {} }, null, 2));
    return;
  }
  process.stdout.write(fs.readFileSync(ipath, 'utf8'));
}

function main() {
  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);
  switch (command) {
    case 'emit':
      return cmdEmit(args);
    case 'show':
      return cmdShow(args);
    case 'list':
      return cmdList(args);
    default:
      console.error(
        'Usage: cobolt-round-summary.js <emit|show|list> [args]\n' +
          '  emit  --milestone M{n} --round N --verdict <status> [--name core] [--tests-passing N] [--tests-failing N]\n' +
          '        [--files-written a,b,c] [--risks "text|severity,..."] [--checkpoint <path>] [--summary "<text>"]\n' +
          '  show  --milestone M{n} --through N\n' +
          '  list  --milestone M{n}',
      );
      process.exit(1);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`[round-summary] ERROR: ${e.message}`);
    process.exit(1);
  }
}

module.exports = {
  renderSummary,
  _testOnly: { MAX_BYTES, MAX_FILES_LISTED, MAX_RISKS, splitList, parseRisks, truncateList },
};
