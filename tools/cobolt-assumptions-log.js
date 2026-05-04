#!/usr/bin/env node

// CoBolt Assumptions Log Producer
//
// Problem this closes:
//   Multiple planning paths reference `_cobolt-output/latest/planning/assumptions-log.md`:
//     - `cobolt-planning-provenance-gate.js` enforces authorship provenance for it
//     - `cobolt-plan-agent.md` prompt instructs the agent to "write every
//       autonomous decision to assumptions-log.md"
//     - `cobolt-analyze-features/workflow.md` expects `planning-bootstrap` to seed it
//   …but no deterministic producer guarantees it exists. Projects ship without
//   an assumptions-log.md and the provenance/readiness gates skip it silently.
//
// What this tool does:
//   Deterministically ensures assumptions-log.md exists with:
//     1. Assumptions extracted from the PRD (explicit "Assumption:" lines +
//        a 4-heading bootstrap scaffold if nothing is found).
//     2. Flags pulled from source-document-consolidation.md (ASSUMPTION:, DRAFT_ONLY:).
//     3. Any autonomous decisions logged to _cobolt-output/audit/*.jsonl that tag themselves
//        `decisionType=assumption`.
//
//   Each append is idempotent — existing entries are detected by hash.
//
// Usage:
//   node tools/cobolt-assumptions-log.js ensure      [--project <dir>] [--json] [--force]
//   node tools/cobolt-assumptions-log.js append <md> [--project <dir>]
//   node tools/cobolt-assumptions-log.js check       [--project <dir>] [--json]
//
// Exit codes:
//   0 = success
//   1 = hard error
//   2 = missing required inputs (no PRD)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SCAFFOLD_HEADING = '# Assumptions Log';
const DEFAULT_SECTIONS = ['## Scope & Domain', '## Technical', '## Operational', '## Autonomous Planning Decisions'];

function parseArgs(argv) {
  const out = {
    command: 'ensure',
    project: process.cwd(),
    json: false,
    force: false,
    help: false,
    append: null,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--json') out.json = true;
    else if (a === '--force') out.force = true;
    else if (a === '--project' || a === '--dir' || a === '--root') {
      out.project = argv[i + 1] || out.project;
      i += 1;
    } else if (a.startsWith('--project=')) out.project = a.slice('--project='.length);
    else if (a.startsWith('--')) out.unknown = a;
    else positional.push(a);
  }
  if (positional.length > 0) {
    out.command = positional[0];
    if (out.command === 'append' && positional[1]) {
      out.append = positional.slice(1).join(' ');
    }
  }
  return out;
}

function printUsage() {
  console.log('Usage: node tools/cobolt-assumptions-log.js [ensure|append|check] [--project <dir>] [--json]');
  console.log();
  console.log('Ensures _cobolt-output/latest/planning/assumptions-log.md exists with extracted PRD assumptions');
  console.log('and autonomous-decision entries. Use `append "- assumption text"` to record a new decision.');
}

function readOrNull(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function resolvePlanningDir(projectRoot) {
  const candidates = [
    path.join(projectRoot, '_cobolt-output', 'latest', 'planning'),
    path.join(projectRoot, '_cobolt-output', 'planning'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function extractAssumptionLines(prdText) {
  if (!prdText) return [];
  const lines = prdText.split(/\r?\n/);
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const explicit = line.match(/^\s*[-*]?\s*\*{0,2}Assumption\*{0,2}\s*[:—-]\s*(.+)/i);
    if (explicit && explicit[1].length > 5) {
      out.push(explicit[1].trim());
      continue;
    }
    const parenthetical = line.match(/\bassume[s|d]?\b.*?[.!?]$/i);
    if (parenthetical && line.length < 220) {
      out.push(line.replace(/^[-*]\s*/, '').trim());
    }
  }
  return [...new Set(out)];
}

function extractFromSourceConsolidation(planningDir) {
  const text = readOrNull(path.join(planningDir, 'source-document-consolidation.md'));
  if (!text) return [];
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/\b(ASSUMPTION|DRAFT_ONLY)\b\s*[:—-]?\s*(.+)/i);
    if (m?.[2]) out.push(`${m[1].toUpperCase()}: ${m[2].trim()}`);
  }
  return [...new Set(out)];
}

function extractAutonomousDecisions(projectRoot) {
  const auditDir = path.join(projectRoot, '_cobolt-output', 'audit');
  if (!fs.existsSync(auditDir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(auditDir)) {
    if (!entry.endsWith('.jsonl')) continue;
    const text = readOrNull(path.join(auditDir, entry));
    if (!text) continue;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row?.decisionType === 'assumption' && typeof row.message === 'string') {
          out.push(`${row.timestamp || ''} — ${row.message}`.trim());
        }
      } catch {
        /* ignore */
      }
    }
  }
  return [...new Set(out)];
}

function buildScaffold() {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    `${SCAFFOLD_HEADING}`,
    '',
    `> Seeded by \`cobolt-assumptions-log\` on ${today}. Subsequent autonomous decisions append here idempotently.`,
    '',
  ];
  for (const section of DEFAULT_SECTIONS) {
    lines.push(section);
    lines.push('');
    lines.push('_None recorded yet._');
    lines.push('');
  }
  return lines.join('\n');
}

function normalizeLine(line) {
  return line.replace(/\s+/g, ' ').trim().toLowerCase();
}

function ensureScaffolded(content) {
  if (!content?.includes(SCAFFOLD_HEADING)) {
    return buildScaffold();
  }
  return content;
}

function ensureSectionPresent(content, sectionHeading) {
  if (content.includes(sectionHeading)) return content;
  const trimmed = content.trimEnd();
  return `${trimmed}\n\n${sectionHeading}\n\n_None recorded yet._\n`;
}

function appendAssumptions(content, heading, entries) {
  if (!entries.length) return content;
  const updated = ensureSectionPresent(content, heading);
  const existingNormalized = new Set(updated.split(/\r?\n/).map(normalizeLine));
  const toAppend = entries.filter((e) => !existingNormalized.has(normalizeLine(`- ${e}`)));
  if (toAppend.length === 0) return updated;
  const lines = updated.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.trim() === heading);
  if (idx === -1) return updated;
  // Find the end-of-section index (next `##` or EOF).
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i]) || /^#\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  // Strip the "_None recorded yet._" placeholder if present.
  const bodyLines = lines.slice(idx + 1, end).filter((l) => l.trim() !== '_None recorded yet._');
  const withAppended = [
    ...lines.slice(0, idx + 1),
    '',
    ...bodyLines.filter((l) => l.trim().length > 0),
    ...(bodyLines.some((l) => l.trim().length > 0) ? [''] : []),
    ...toAppend.map((e) => `- ${e}`),
    '',
    ...lines.slice(end),
  ];
  return withAppended.join('\n');
}

function ensure(projectRoot, { force = false } = {}) {
  const root = path.resolve(projectRoot);
  const planningDir = resolvePlanningDir(root);
  if (!planningDir) {
    return { ok: false, code: 2, error: 'No planning dir under _cobolt-output/' };
  }
  const outPath = path.join(planningDir, 'assumptions-log.md');
  const existing = readOrNull(outPath);
  const prdText = readOrNull(path.join(planningDir, 'prd.md')) || '';
  const prdAssumptions = extractAssumptionLines(prdText);
  const sourceAssumptions = extractFromSourceConsolidation(planningDir);
  const autonomousAssumptions = extractAutonomousDecisions(root);

  let content = ensureScaffolded(force ? '' : existing || '');
  content = appendAssumptions(content, '## Scope & Domain', prdAssumptions);
  content = appendAssumptions(content, '## Technical', sourceAssumptions);
  content = appendAssumptions(content, '## Autonomous Planning Decisions', autonomousAssumptions);

  if (existing && existing === content && !force) {
    return {
      ok: true,
      skipped: true,
      outPath,
      reason: 'no new assumptions to append',
    };
  }

  fs.writeFileSync(outPath, content, 'utf8');
  return {
    ok: true,
    outPath,
    skipped: false,
    added: {
      prd: prdAssumptions.length,
      source: sourceAssumptions.length,
      autonomous: autonomousAssumptions.length,
    },
    hash: crypto.createHash('sha256').update(content).digest('hex'),
  };
}

function appendOne(projectRoot, markdownLine) {
  const root = path.resolve(projectRoot);
  const planningDir = resolvePlanningDir(root);
  if (!planningDir) return { ok: false, code: 2, error: 'No planning dir' };
  const outPath = path.join(planningDir, 'assumptions-log.md');
  let content = ensureScaffolded(readOrNull(outPath) || '');
  content = appendAssumptions(content, '## Autonomous Planning Decisions', [markdownLine]);
  fs.writeFileSync(outPath, content, 'utf8');
  return { ok: true, outPath };
}

function check(projectRoot) {
  const planningDir = resolvePlanningDir(projectRoot);
  const report = { ok: false, planningDir };
  if (!planningDir) {
    report.error = 'No planning dir under _cobolt-output/';
    return report;
  }
  const text = readOrNull(path.join(planningDir, 'assumptions-log.md'));
  if (!text) {
    report.error = 'assumptions-log.md missing';
    return report;
  }
  report.ok = text.includes(SCAFFOLD_HEADING);
  report.bytes = Buffer.byteLength(text, 'utf8');
  report.sections = DEFAULT_SECTIONS.filter((s) => text.includes(s));
  return report;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printUsage();
    return 0;
  }
  if (args.unknown) {
    console.error(`Unknown option: ${args.unknown}`);
    printUsage();
    return 1;
  }
  let report;
  if (args.command === 'ensure') {
    report = ensure(args.project, { force: args.force });
  } else if (args.command === 'append') {
    if (!args.append) {
      console.error('append requires a message');
      return 1;
    }
    report = appendOne(args.project, args.append);
  } else if (args.command === 'check') {
    report = check(args.project);
  } else {
    console.error(`Unknown command: ${args.command}`);
    printUsage();
    return 1;
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.ok) {
    if (report.skipped) console.log(`assumptions-log.md fresh: ${report.outPath}`);
    else if (args.command === 'ensure')
      console.log(
        `assumptions-log.md written: ${report.outPath} (added prd=${report.added.prd}, source=${report.added.source}, autonomous=${report.added.autonomous})`,
      );
    else console.log(`assumptions-log.md: ok (${report.bytes}B, sections=${(report.sections || []).length})`);
  } else {
    console.error(`cobolt-assumptions-log ${args.command} failed: ${report.error}`);
  }

  if (!report.ok) {
    if (report.code === 2) return 2;
    return 1;
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  SCAFFOLD_HEADING,
  DEFAULT_SECTIONS,
  ensure,
  appendOne,
  check,
  extractAssumptionLines,
  extractFromSourceConsolidation,
  extractAutonomousDecisions,
  buildScaffold,
  resolvePlanningDir,
  main,
};
