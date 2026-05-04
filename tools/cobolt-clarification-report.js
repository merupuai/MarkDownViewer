#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { resolveReadablePlanningDir } = require('../lib/cobolt-planning-artifacts');

function usage() {
  return [
    'CoBolt Clarification Report',
    '',
    'Usage:',
    '  node tools/cobolt-clarification-report.js generate [--json] [--planning-dir <path>] [--cwd <path>]',
    '  node tools/cobolt-clarification-report.js --help',
    '',
    'Generates clarification-report.md and clarification-report.json from',
    'planning-time ambiguity and conflict artifacts.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = Array.from(argv);
  const options = {
    command: 'generate',
    json: false,
    cwd: process.cwd(),
    planningDir: null,
    help: false,
  };

  if (args[0] && !args[0].startsWith('-')) {
    options.command = args.shift();
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--cwd') {
      options.cwd = args[++i];
    } else if (arg === '--planning-dir') {
      options.planningDir = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/');
}

function relPath(planningDir, filePath) {
  return toPosix(path.relative(planningDir, filePath));
}

function truncate(value, limit = 220) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value == null) return [];
  return [value].filter(Boolean);
}

function resolvePlanningDir(options) {
  if (options.planningDir) return path.resolve(options.cwd, options.planningDir);
  return resolveReadablePlanningDir(path.resolve(options.cwd), { allowLatestFallback: true });
}

function normalizeSeverity(value, fallback = 'info') {
  const severity = String(value || fallback)
    .trim()
    .toLowerCase();
  if (!severity) return fallback;
  return severity;
}

function parseSourceConflicts(planningDir) {
  const filePath = path.join(planningDir, 'source-conflicts.json');
  const payload = safeReadJson(filePath);
  const rawItems = payload
    ? Array.isArray(payload.conflicts)
      ? payload.conflicts
      : Array.isArray(payload.items)
        ? payload.items
        : Array.isArray(payload.findings)
          ? payload.findings
          : []
    : [];

  const items = rawItems.map((item, index) => {
    const severity = normalizeSeverity(
      item?.severity || item?.level || item?.priority || (item?.blocking === true ? 'block' : 'warn'),
    );
    const status = String(item?.status || item?.resolution || '').trim() || null;
    const blocking =
      item?.blocking === true ||
      /block|critical|high|fatal/.test(severity) ||
      /block|open|unresolved/i.test(String(status || ''));

    return {
      id: String(item?.id || item?.conflictId || `SRC-CONFLICT-${String(index + 1).padStart(3, '0')}`),
      severity,
      status,
      blocking,
      summary: truncate(
        item?.summary ||
          item?.message ||
          item?.description ||
          item?.title ||
          item?.reason ||
          (typeof item === 'string' ? item : JSON.stringify(item || {})),
      ),
      sourceIds: asArray(item?.sourceIds || item?.srcIds || item?.sources).map(String),
      featureIds: asArray(item?.featureIds || item?.features).map(String),
    };
  });

  const blockingCount =
    typeof payload?.blockingCount === 'number' ? payload.blockingCount : items.filter((item) => item.blocking).length;

  return {
    path: filePath,
    exists: fs.existsSync(filePath),
    items,
    blockingCount,
  };
}

function parseFrAmbiguity(planningDir) {
  const filePath = path.join(planningDir, 'fr-ambiguity.json');
  const payload = safeReadJson(filePath);
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const ambiguous = results
    .filter((item) => item && item.ambiguous === true)
    .map((item, index) => ({
      id: String(item.fr || item.frRef || item.id || `FR-AMB-${index + 1}`),
      divergence: Number(item.divergence || 0),
      drafts: Number(item.drafts || 0),
      summary: truncate(
        item.message ||
          `${item.fr || item.frRef || item.id || 'FR'} exceeded divergence threshold ${payload?.threshold ?? 'unknown'}`,
      ),
    }));

  return {
    path: filePath,
    exists: fs.existsSync(filePath),
    threshold: typeof payload?.threshold === 'number' ? payload.threshold : null,
    items: ambiguous,
  };
}

function parseJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const parsed = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // Ignore malformed lines. The report is advisory and should not crash on one bad entry.
    }
  }
  return parsed;
}

function parseAmbiguityLedger(planningDir) {
  const filePath = path.join(planningDir, 'ambiguity-ledger.jsonl');
  const entries = parseJsonLines(filePath).map((entry, index) => {
    const decision = String(entry?.decision || '').trim();
    const status = String(entry?.status || 'open').trim() || 'open';
    const implicitReqUpdated = entry?.implicit_req_updated === true;
    const resolved =
      decision.length > 0 && implicitReqUpdated && (status === 'resolved' || status === 'backpropagated');

    return {
      id: String(entry?.finding_id || `AMB-${index + 1}`),
      milestone: String(entry?.milestone || '').trim() || null,
      refs: asArray(entry?.fr_refs).map(String),
      decision,
      status,
      implicitReqUpdated,
      affectedSiblings: asArray(entry?.affected_siblings).map(String),
      excerpt: truncate(entry?.evidence?.rca_excerpt || ''),
      resolved,
    };
  });

  return {
    path: filePath,
    exists: fs.existsSync(filePath),
    open: entries.filter((entry) => !entry.resolved),
    resolved: entries.filter((entry) => entry.resolved),
    affectedSiblings: Array.from(
      new Set(entries.flatMap((entry) => entry.affectedSiblings).filter((value) => /^M\d+$/i.test(value))),
    ).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
  };
}

function parseAssumptions(planningDir) {
  const filePath = path.join(planningDir, 'assumptions-log.md');
  const text = readText(filePath);
  if (!text) {
    return {
      path: filePath,
      exists: fs.existsSync(filePath),
      items: [],
    };
  }

  const items = [];
  let inAssumptionsSection = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^#{1,6}\s+.*assumption/i.test(line)) {
      inAssumptionsSection = true;
      continue;
    }
    if (inAssumptionsSection && /^#{1,6}\s+/.test(line)) {
      inAssumptionsSection = false;
    }

    const bulletMatch = line.match(/^[-*+]\s+(.+)/);
    const numberedMatch = line.match(/^\d+\.\s+(.+)/);
    const assumptionMatch = line.match(/^assumption[:\s-]+(.+)/i);
    const value = bulletMatch?.[1] || numberedMatch?.[1] || assumptionMatch?.[1] || null;
    if (!value) continue;
    if (inAssumptionsSection || /assum/i.test(line)) {
      items.push(truncate(value));
    }
  }

  return {
    path: filePath,
    exists: fs.existsSync(filePath),
    items: Array.from(new Set(items)).slice(0, 25),
  };
}

function nextAction(summary) {
  if (summary.status === 'BLOCKED') {
    return 'Resolve blocking source conflicts, ambiguous FRs, or open ambiguity-ledger entries before treating the spec packet as implementation-ready.';
  }
  if (summary.assumptionCount > 0) {
    return 'Review assumptions-log.md and decide which assumptions should become explicit requirements, constraints, or accepted risk.';
  }
  return 'No blocking clarifications detected.';
}

function classifyStatus(components) {
  if (components.sourceConflicts.blockingCount > 0) return 'BLOCKED';
  if (components.frAmbiguity.items.length > 0) return 'BLOCKED';
  if (components.ambiguityLedger.open.length > 0) return 'BLOCKED';
  if (components.assumptions.items.length > 0) return 'ATTENTION';
  if (components.sourceConflicts.items.length > 0) return 'ATTENTION';
  return 'CLEAR';
}

function buildReport(planningDir) {
  const sourceConflicts = parseSourceConflicts(planningDir);
  const frAmbiguity = parseFrAmbiguity(planningDir);
  const ambiguityLedger = parseAmbiguityLedger(planningDir);
  const assumptions = parseAssumptions(planningDir);

  const status = classifyStatus({ sourceConflicts, frAmbiguity, ambiguityLedger, assumptions });

  const summary = {
    status,
    sourceConflictCount: sourceConflicts.items.length,
    blockingSourceConflictCount: sourceConflicts.blockingCount,
    ambiguousFrCount: frAmbiguity.items.length,
    openLedgerCount: ambiguityLedger.open.length,
    resolvedLedgerCount: ambiguityLedger.resolved.length,
    assumptionCount: assumptions.items.length,
    affectedSiblingMilestones: ambiguityLedger.affectedSiblings,
    nextAction: nextAction({
      status,
      assumptionCount: assumptions.items.length,
    }),
  };

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    planningDir: toPosix(planningDir),
    status,
    summary,
    inputs: {
      sourceConflicts: {
        path: relPath(planningDir, sourceConflicts.path),
        exists: sourceConflicts.exists,
      },
      frAmbiguity: {
        path: relPath(planningDir, frAmbiguity.path),
        exists: frAmbiguity.exists,
        threshold: frAmbiguity.threshold,
      },
      ambiguityLedger: {
        path: relPath(planningDir, ambiguityLedger.path),
        exists: ambiguityLedger.exists,
      },
      assumptions: {
        path: relPath(planningDir, assumptions.path),
        exists: assumptions.exists,
      },
    },
    sourceConflicts: sourceConflicts.items,
    frAmbiguity: frAmbiguity.items,
    ambiguityLedger: {
      open: ambiguityLedger.open,
      resolved: ambiguityLedger.resolved,
      affectedSiblingMilestones: ambiguityLedger.affectedSiblings,
    },
    assumptions: assumptions.items,
  };
}

function renderMarkdown(report) {
  const lines = [];
  const summary = report.summary;
  lines.push('# Clarification Report');
  lines.push('');
  lines.push(`> Auto-generated by \`node tools/cobolt-clarification-report.js generate\` - ${report.generatedAt}`);
  lines.push('');
  lines.push(`Status: **${report.status}**`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Blocking source conflicts: ${summary.blockingSourceConflictCount}`);
  lines.push(`- Total source conflicts: ${summary.sourceConflictCount}`);
  lines.push(`- Ambiguous FRs: ${summary.ambiguousFrCount}`);
  lines.push(`- Open ambiguity ledger entries: ${summary.openLedgerCount}`);
  lines.push(`- Resolved ambiguity ledger entries: ${summary.resolvedLedgerCount}`);
  lines.push(`- Assumptions captured: ${summary.assumptionCount}`);
  lines.push(
    `- Affected sibling milestones: ${summary.affectedSiblingMilestones.length ? summary.affectedSiblingMilestones.join(', ') : 'none'}`,
  );
  lines.push('');
  lines.push('## Blocking Clarifications');
  lines.push('');

  if (
    report.sourceConflicts.filter((item) => item.blocking).length === 0 &&
    report.frAmbiguity.length === 0 &&
    report.ambiguityLedger.open.length === 0
  ) {
    lines.push('- No blocking clarifications detected.');
    lines.push('');
  } else {
    if (report.sourceConflicts.filter((item) => item.blocking).length > 0) {
      lines.push('### Source Conflicts');
      lines.push('');
      for (const item of report.sourceConflicts.filter((entry) => entry.blocking)) {
        const ids = item.sourceIds.length ? ` [${item.sourceIds.join(', ')}]` : '';
        lines.push(`- ${item.id}${ids}: ${item.summary}`);
      }
      lines.push('');
    }

    if (report.frAmbiguity.length > 0) {
      lines.push('### FR Ambiguity');
      lines.push('');
      for (const item of report.frAmbiguity) {
        lines.push(`- ${item.id}: divergence ${item.divergence.toFixed(3)} across ${item.drafts || 0} draft(s)`);
      }
      lines.push('');
    }

    if (report.ambiguityLedger.open.length > 0) {
      lines.push('### Open Ambiguity Ledger Entries');
      lines.push('');
      for (const item of report.ambiguityLedger.open) {
        const refs = item.refs.length ? ` [${item.refs.join(', ')}]` : '';
        const milestone = item.milestone ? ` (${item.milestone})` : '';
        const detail = item.decision || item.excerpt || 'No concrete decision recorded yet.';
        lines.push(`- ${item.id}${milestone}${refs}: ${truncate(detail)}`);
      }
      lines.push('');
    }
  }

  lines.push('## Resolved Clarifications');
  lines.push('');
  if (report.ambiguityLedger.resolved.length === 0) {
    lines.push('- No resolved ambiguity ledger entries recorded yet.');
    lines.push('');
  } else {
    for (const item of report.ambiguityLedger.resolved) {
      const refs = item.refs.length ? ` [${item.refs.join(', ')}]` : '';
      const milestone = item.milestone ? ` (${item.milestone})` : '';
      lines.push(`- ${item.id}${milestone}${refs}: ${truncate(item.decision || item.excerpt)}`);
    }
    lines.push('');
  }

  lines.push('## Assumptions');
  lines.push('');
  if (report.assumptions.length === 0) {
    lines.push('- No assumptions captured in assumptions-log.md.');
    lines.push('');
  } else {
    for (const item of report.assumptions) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  lines.push('## Recommended Next Action');
  lines.push('');
  lines.push(`- ${summary.nextAction}`);
  lines.push('');
  lines.push('## Input Artifacts');
  lines.push('');
  lines.push(`- ${report.inputs.sourceConflicts.path} (${report.inputs.sourceConflicts.exists ? 'found' : 'missing'})`);
  lines.push(`- ${report.inputs.frAmbiguity.path} (${report.inputs.frAmbiguity.exists ? 'found' : 'missing'})`);
  lines.push(`- ${report.inputs.ambiguityLedger.path} (${report.inputs.ambiguityLedger.exists ? 'found' : 'missing'})`);
  lines.push(`- ${report.inputs.assumptions.path} (${report.inputs.assumptions.exists ? 'found' : 'missing'})`);
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function writeOutputs(planningDir, report, markdown) {
  const jsonPath = path.join(planningDir, 'clarification-report.json');
  const mdPath = path.join(planningDir, 'clarification-report.md');
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, markdown, 'utf8');
  return { jsonPath, mdPath };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${usage()}\n`);
    process.exit(1);
  }

  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  if (options.command !== 'generate') {
    process.stderr.write(`Unknown command: ${options.command}\n\n${usage()}\n`);
    process.exit(1);
  }

  const planningDir = resolvePlanningDir(options);
  if (!planningDir || !fs.existsSync(planningDir)) {
    process.stderr.write('Planning directory not found.\n');
    process.exit(1);
  }

  const report = buildReport(planningDir);
  const markdown = renderMarkdown(report);
  const outputs = writeOutputs(planningDir, report, markdown);
  const payload = {
    ...report,
    outputs: {
      json: relPath(planningDir, outputs.jsonPath),
      markdown: relPath(planningDir, outputs.mdPath),
    },
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    [
      `[cobolt-clarification-report] ${payload.status}`,
      `  json: ${payload.outputs.json}`,
      `  markdown: ${payload.outputs.markdown}`,
      `  blocking conflicts: ${payload.summary.blockingSourceConflictCount}`,
      `  ambiguous FRs: ${payload.summary.ambiguousFrCount}`,
      `  open ledger entries: ${payload.summary.openLedgerCount}`,
      `  assumptions: ${payload.summary.assumptionCount}`,
    ].join('\n'),
  );
  process.stdout.write('\n');
}

if (require.main === module) {
  main();
}

module.exports = {
  buildReport,
  parseSourceConflicts,
  parseFrAmbiguity,
  parseAmbiguityLedger,
  parseAssumptions,
  renderMarkdown,
};
