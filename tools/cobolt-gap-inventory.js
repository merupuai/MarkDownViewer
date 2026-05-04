#!/usr/bin/env node

// CoBolt Gap Inventory (v0.20+)
//
// Closes the v0.19.1 audit finding: cobolt-gap wrote prose-only deferred.md;
// next build milestone had no machine-readable blocker list and silently
// dropped features. This tool:
//   - Consumes existing gap-related artifacts:
//       _cobolt-output/latest/planning/phase-{1..5}-gap-report.json
//       _cobolt-output/latest/planning/gap-registry.json  (if present)
//       _cobolt-output/latest/fix/carry-forward.json      (if present)
//       _cobolt-output/latest/brownfield/18-modernization-roadmap.md (if present)
//   - Produces a structured gap-inventory.json consumable by cobolt-plan /
//     cobolt-build for deterministic next-milestone authoring.
//
// Emitted schema:
//   {
//     tool: "cobolt-gap-inventory",
//     version: "1.0.0",
//     generatedAt: ISO,
//     missingFeatures:  [{ id, title, parentMilestone, priority, evidence }],
//     blockingTasks:    [{ id, title, blockedBy, milestone, severity }],
//     carryForwardEvidence: [{ milestone, findingId, severity, status }],
//     summary: { total, byPriority, byMilestone }
//   }
//
// Usage:
//   node tools/cobolt-gap-inventory.js build [--dir <root>] [--json] [--save] [--output <path>]
//   node tools/cobolt-gap-inventory.js validate [--input <path>]
//
// Exit codes:
//   0 = ok
//   1 = usage error
//   2 = inputs missing (no phase-gap-reports AND no carry-forward — nothing to inventory)
//   3 = schema validation failed

const fs = require('node:fs');
const path = require('node:path');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_NO_INPUTS = 2;
const EXIT_SCHEMA_FAIL = 3;

const DEFAULT_OUTPUT = path.join('_cobolt-output', 'latest', 'gap', 'gap-inventory.json');

function readJsonIfExists(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function walkPhaseGapReports(planningDir) {
  const reports = [];
  if (!fs.existsSync(planningDir)) return reports;
  for (const entry of fs.readdirSync(planningDir)) {
    if (!/^phase-\d+-gap-report\.json$/.test(entry)) continue;
    const full = path.join(planningDir, entry);
    const content = readJsonIfExists(full);
    if (content) reports.push({ path: full, phase: entry.match(/phase-(\d+)/)[1], content });
  }
  return reports.sort((a, b) => Number(a.phase) - Number(b.phase));
}

function normalizeGapEntry(entry, fallback) {
  return {
    id: entry.id || entry.findingId || entry.gap || fallback.id,
    title: entry.title || entry.description || entry.summary || fallback.title,
    parentMilestone: entry.milestone || entry.targetMilestone || entry.carryForwardTo || null,
    priority: (entry.priority || entry.severity || 'medium').toLowerCase(),
    evidence: entry.evidence || entry.citation || entry.source || null,
  };
}

// v0.50 — phase-gap-report producers emit two distinct shapes that this tool
// must accept:
//   shape A (phase 1-2):  gaps as an array of gap entries
//   shape B (phase 1-2):  gaps as a severity counter object {critical, high, medium, low}
//                          (no entries — counts only)
//   shape C (phase 3-5):  findings.{blockers, warnings, carryForward} arrays
// Returns [] for counter-only objects so spread-of-non-array never crashes.
function asEntryArray(maybe) {
  if (Array.isArray(maybe)) return maybe;
  return [];
}

function extractMissingFeatures(sources) {
  const out = [];
  let counter = 1;
  for (const { content, phase } of sources.phaseReports) {
    const list = [
      ...asEntryArray(content.missingFeatures),
      ...asEntryArray(content.criticalGaps),
      ...asEntryArray(content.gaps),
      // Phase 3-5 shape: findings.warnings carries soft gaps that should still
      // appear in the inventory so downstream /cobolt-gap can surface them.
      ...asEntryArray(content.findings?.warnings),
    ];
    for (const entry of list) {
      out.push(
        normalizeGapEntry(entry, {
          id: `GAP-PHASE${phase}-${counter++}`,
          title: `Phase ${phase} gap (unlabeled)`,
        }),
      );
    }
  }
  if (sources.gapRegistry) {
    const list = asEntryArray(sources.gapRegistry.gaps).length
      ? asEntryArray(sources.gapRegistry.gaps)
      : asEntryArray(sources.gapRegistry.features);
    for (const entry of list) {
      out.push(normalizeGapEntry(entry, { id: `GAP-REG-${counter++}`, title: 'Gap registry entry' }));
    }
  }
  return out;
}

function extractBlockingTasks(sources) {
  const out = [];
  let counter = 1;
  const seen = new Set();
  // From phase gap reports — accept legacy `blockingTasks`/`blockers` and
  // newer `findings.blockers` (phase 3-5 shape).
  for (const { content, phase } of sources.phaseReports) {
    const list = [
      ...asEntryArray(content.blockingTasks),
      ...asEntryArray(content.blockers),
      ...asEntryArray(content.findings?.blockers),
    ];
    for (const entry of list) {
      const id = entry.id || `BLOCK-PHASE${phase}-${counter++}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        title: entry.title || entry.description || entry.summary || `Phase ${phase} blocker`,
        blockedBy: entry.blockedBy || entry.depends_on || [],
        milestone: entry.milestone || entry.owner || null,
        severity: (entry.severity || 'high').toLowerCase(),
      });
    }
  }
  // From carry-forward
  if (sources.carryForward?.unresolvedFindings) {
    for (const f of sources.carryForward.unresolvedFindings) {
      const id = f.id || `CF-${counter++}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        title: f.title || f.message || `Carry-forward ${f.id}`,
        blockedBy: f.blockedBy || [],
        milestone: sources.carryForward.milestone || null,
        severity: (f.severity || 'high').toLowerCase(),
      });
    }
  }
  return out;
}

function extractCarryForwardEvidence(sources) {
  const out = [];
  if (!sources.carryForward) return out;
  const cf = sources.carryForward;
  const findings = [
    ...(cf.unresolvedFindings || []),
    ...(cf.verifiedResolved || []).map((id) => ({ id, status: 'resolved' })),
  ];
  for (const f of findings) {
    out.push({
      milestone: cf.milestone || null,
      findingId: f.id || f,
      severity: (f.severity || 'unknown').toLowerCase(),
      status: f.status || (f.severity ? 'unresolved' : 'resolved'),
    });
  }
  return out;
}

function summarize(missingFeatures, blockingTasks) {
  const byPriority = { critical: 0, high: 0, medium: 0, low: 0 };
  const byMilestone = {};
  for (const f of missingFeatures) {
    byPriority[f.priority] = (byPriority[f.priority] || 0) + 1;
    const m = f.parentMilestone || 'unassigned';
    byMilestone[m] = (byMilestone[m] || 0) + 1;
  }
  for (const b of blockingTasks) {
    byPriority[b.severity] = (byPriority[b.severity] || 0) + 1;
  }
  return {
    total: missingFeatures.length + blockingTasks.length,
    missingFeatureCount: missingFeatures.length,
    blockingTaskCount: blockingTasks.length,
    byPriority,
    byMilestone,
  };
}

function buildInventory(root) {
  const planningDir = path.join(root, '_cobolt-output', 'latest', 'planning');
  const fixDir = path.join(root, '_cobolt-output', 'latest', 'fix');
  const sources = {
    phaseReports: walkPhaseGapReports(planningDir),
    gapRegistry: readJsonIfExists(path.join(planningDir, 'gap-registry.json')),
    carryForward: readJsonIfExists(path.join(fixDir, 'carry-forward.json')),
  };
  if (sources.phaseReports.length === 0 && !sources.gapRegistry && !sources.carryForward) {
    return { ok: false, reason: 'no-inputs', sources };
  }
  const missingFeatures = extractMissingFeatures(sources);
  const blockingTasks = extractBlockingTasks(sources);
  const carryForwardEvidence = extractCarryForwardEvidence(sources);
  return {
    ok: true,
    tool: 'cobolt-gap-inventory',
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    sources: {
      phaseGapReports: sources.phaseReports.map((s) => s.path),
      gapRegistry: sources.gapRegistry ? 'gap-registry.json' : null,
      carryForward: sources.carryForward ? 'carry-forward.json' : null,
    },
    missingFeatures,
    blockingTasks,
    carryForwardEvidence,
    summary: summarize(missingFeatures, blockingTasks),
  };
}

function validateInventory(inv) {
  const errors = [];
  if (!inv || typeof inv !== 'object') errors.push('root must be object');
  if (!inv.tool || inv.tool !== 'cobolt-gap-inventory') errors.push('tool field must equal "cobolt-gap-inventory"');
  if (!Array.isArray(inv.missingFeatures)) errors.push('missingFeatures must be array');
  if (!Array.isArray(inv.blockingTasks)) errors.push('blockingTasks must be array');
  if (!Array.isArray(inv.carryForwardEvidence)) errors.push('carryForwardEvidence must be array');
  if (!inv.summary) errors.push('summary missing');
  for (const [i, f] of (inv.missingFeatures || []).entries()) {
    if (!f.id) errors.push(`missingFeatures[${i}].id missing`);
    if (!f.title) errors.push(`missingFeatures[${i}].title missing`);
    if (!['critical', 'high', 'medium', 'low'].includes(f.priority))
      errors.push(`missingFeatures[${i}].priority invalid: ${f.priority}`);
  }
  for (const [i, b] of (inv.blockingTasks || []).entries()) {
    if (!b.id) errors.push(`blockingTasks[${i}].id missing`);
    if (!Array.isArray(b.blockedBy)) errors.push(`blockingTasks[${i}].blockedBy must be array`);
  }
  return errors;
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  // v0.46 — explicit --help → exit 0; missing command → exit 1 per tools/CLAUDE.md contract
  if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
    process.stdout.write(
      'Usage:\n  cobolt-gap-inventory build [--dir <root>] [--save] [--output <path>] [--json]\n  cobolt-gap-inventory validate [--input <path>]\n',
    );
    process.exit(EXIT_OK);
  }
  if (!cmd) {
    process.stderr.write(
      'Usage:\n  cobolt-gap-inventory build [--dir <root>] [--save] [--output <path>] [--json]\n  cobolt-gap-inventory validate [--input <path>]\n',
    );
    process.exit(EXIT_USAGE);
  }
  const dirIdx = args.indexOf('--dir');
  const dir = dirIdx !== -1 && args[dirIdx + 1] ? path.resolve(args[dirIdx + 1]) : process.cwd();
  const outputIdx = args.indexOf('--output');
  const output = outputIdx !== -1 && args[outputIdx + 1] ? args[outputIdx + 1] : null;
  const save = args.includes('--save');
  const jsonMode = args.includes('--json');
  const inputIdx = args.indexOf('--input');
  const input = inputIdx !== -1 && args[inputIdx + 1] ? args[inputIdx + 1] : path.join(dir, DEFAULT_OUTPUT);

  if (cmd === 'validate') {
    const inv = readJsonIfExists(input);
    if (!inv) {
      process.stderr.write(`[cobolt-gap-inventory] validate: cannot read ${input}\n`);
      process.exit(EXIT_UNREADABLE || 2);
    }
    const errors = validateInventory(inv);
    if (errors.length > 0) {
      if (jsonMode) process.stdout.write(`${JSON.stringify({ ok: false, errors }, null, 2)}\n`);
      else for (const e of errors) process.stderr.write(`  - ${e}\n`);
      process.exit(EXIT_SCHEMA_FAIL);
    }
    process.stdout.write(
      jsonMode
        ? `${JSON.stringify({ ok: true, counts: inv.summary }, null, 2)}\n`
        : `[cobolt-gap-inventory] ${input} OK\n`,
    );
    process.exit(EXIT_OK);
  }

  if (cmd !== 'build') {
    process.stderr.write(`Unknown command: ${cmd}\n`);
    process.exit(EXIT_USAGE);
  }

  const inv = buildInventory(dir);
  if (!inv.ok) {
    process.stderr.write(
      `[cobolt-gap-inventory] no inputs found — checked phase-gap-reports, gap-registry.json, carry-forward.json\n`,
    );
    if (jsonMode) process.stdout.write(`${JSON.stringify(inv, null, 2)}\n`);
    process.exit(EXIT_NO_INPUTS);
  }

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(inv, null, 2)}\n`);
  } else {
    process.stdout.write(
      `[cobolt-gap-inventory] ${inv.summary.total} entries — missingFeatures=${inv.summary.missingFeatureCount}, blockingTasks=${inv.summary.blockingTaskCount}, carryForward=${inv.carryForwardEvidence.length}\n`,
    );
  }

  if (save || output) {
    const outPath = output || path.join(dir, DEFAULT_OUTPUT);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(inv, null, 2), 'utf8');
    process.stderr.write(`[cobolt-gap-inventory] wrote ${outPath}\n`);
  }
  process.exit(EXIT_OK);
}

if (require.main === module) main();

module.exports = { buildInventory, validateInventory };
