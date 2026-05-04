#!/usr/bin/env node
// cobolt-build-debt — record DEGRADED build-stage layer outcomes in auto mode.
//
// Mirror of tools/cobolt-planning-debt.js for the build pipeline. When
// recovery-advisor returns skip-with-debt at Step 07 (validation cascade) or
// Step 08 (milestone-close evidence rejection) — or when --auto encounters an
// unrecoverable layer failure — the orchestrator records the debt here
// instead of halting. The pipeline continues to milestone-complete with a
// populated carryForwardRegister; cobolt-release blocks on unresolved debt
// unless COBOLT_ACCEPT_BUILD_DEBT=1 is explicitly set.
//
// Writes:
//   _cobolt-output/audit/build-debt.jsonl                           (ledger)
//   _cobolt-output/latest/build/{M}/DEGRADED-BUILD-ARTIFACTS.md     (per-milestone summary)
//   cobolt-state.json     (state.build.M{n}.hasDebt = true; debtLedger path)
//
// Commands:
//   record <milestone> --layer <layer> --class <cls> [--evidence <path>]
//                       [--retryCount <n>] [--advisor <path>]
//                       [--ticket <id>] [--owner <name>] [--dueMilestone <Mn>]
//                       [--riskNote "..."]                          (≥20 chars)
//     Append a debt entry. Required fields enforce the milestone-close-evidence
//     carryForwardRegister contract (ticket / owner / dueMilestone / riskNote).
//
//   list [--milestone <Mn>] [--json]
//     Summarize unresolved debt for a milestone or globally.
//
//   convert-halt <milestone>
//     Read the build halt sentinel
//     (_cobolt-output/latest/build/{M}/HUMAN-REVIEW-REQUIRED.md OR
//      M{n}-07-validate-escalation.json with verdict=skip-with-debt), record a
//     debt entry from its contents, then advance state.build.currentStep past
//     the failed layer. The orchestrator calls this when recovery-advisor
//     verdict=skip-with-debt under --auto so the milestone reaches
//     milestone-complete with explicit debt accounting.
//
// Exit codes (per tools/CLAUDE.md exit contract):
//   0 = success
//   1 = usage / unhandled error
//   2 = no halt sentinel found (caller should treat as no-op)

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('../lib/cobolt-atomic-write');

const ROOT = process.cwd();
const AUDIT_DIR = path.join(ROOT, '_cobolt-output/audit');
const LEDGER = path.join(AUDIT_DIR, 'build-debt.jsonl');
const STATE_FILE = path.join(ROOT, 'cobolt-state.json');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_NO_HALT = 2;

const MIN_RISK_NOTE_CHARS = 20;

function buildDir(milestone) {
  return path.join(ROOT, '_cobolt-output/latest/build', milestone);
}

function degradedDocPath(milestone) {
  return path.join(buildDir(milestone), 'DEGRADED-BUILD-ARTIFACTS.md');
}

function buildHaltPath(milestone) {
  return path.join(buildDir(milestone), 'HUMAN-REVIEW-REQUIRED.md');
}

function escalationEvidencePath(milestone) {
  return path.join(buildDir(milestone), `${milestone}-07-validate-escalation.json`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    const k = v.startsWith('--') ? v.slice(2) : null;
    if (!k) {
      args._.push(v);
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[k] = true;
    } else {
      args[k] = next;
      i++;
    }
  }
  return args;
}

function readJSONSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function ensureDegradedDoc(milestone) {
  const target = degradedDocPath(milestone);
  if (fs.existsSync(target)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  atomicWrite(
    target,
    `# Degraded Build Artifacts — ${milestone}\n\n` +
      'This file lists Step 07/08 layer outcomes accepted in DEGRADED state under autonomous execution. ' +
      'Each row represents a verification layer the build pipeline could not close within the retry budget. ' +
      'The milestone proceeds to milestone-complete with explicit carry-forward; ' +
      '`cobolt-release` blocks on unresolved entries unless `COBOLT_ACCEPT_BUILD_DEBT=1`.\n\n' +
      '| Layer | Failure class | Ticket | Owner | Due milestone | Risk note | Recorded |\n' +
      '|---|---|---|---|---|---|---|\n',
  );
}

function appendRow(milestone, entry) {
  ensureDegradedDoc(milestone);
  const target = degradedDocPath(milestone);
  const sanitize = (s) =>
    String(s || '—')
      .replace(/\|/g, '\\|')
      .replace(/\n/g, ' ');
  const row =
    `| \`${sanitize(entry.layer)}\` | ${sanitize(entry.failureClass)} | ${sanitize(entry.ticket)} | ` +
    `${sanitize(entry.owner)} | ${sanitize(entry.dueMilestone)} | ${sanitize(entry.riskNote)} | ${entry.recordedAt} |\n`;
  fs.appendFileSync(target, row);
}

function appendLedger(entry) {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  fs.appendFileSync(LEDGER, `${JSON.stringify(entry)}\n`);
}

function markStateDebt(milestone, ledgerPath) {
  const state = readJSONSafe(STATE_FILE) || {};
  if (!state.build) state.build = {};
  if (!state.build[milestone]) state.build[milestone] = {};
  state.build[milestone].hasDebt = true;
  state.build[milestone].debtLedger = path.relative(ROOT, ledgerPath).replaceAll('\\', '/');
  state.build.hasDebt = true;
  try {
    atomicWrite(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    /* non-fatal */
  }
}

function validateRiskNote(riskNote) {
  if (typeof riskNote !== 'string' || riskNote.trim().length < MIN_RISK_NOTE_CHARS) {
    console.error(
      `[build-debt] riskNote must be ≥${MIN_RISK_NOTE_CHARS} characters; got ${riskNote ? riskNote.trim().length : 0}.`,
    );
    return false;
  }
  return true;
}

function cmdRecord(args) {
  const milestone = args.milestone || args._[0];
  if (!milestone) {
    console.error(
      'Usage: cobolt-build-debt record <milestone> --layer <layer> --class <cls> ' +
        '--ticket <id> --owner <name> --dueMilestone <Mn> --riskNote "..." [≥20 chars] ' +
        '[--evidence <path>] [--retryCount <n>] [--advisor <path>]',
    );
    process.exit(EXIT_USAGE);
  }

  const ticket = args.ticket || '—';
  const owner = args.owner || '—';
  const dueMilestone = args.dueMilestone || '—';
  const riskNote = args.riskNote || '';

  if (!validateRiskNote(riskNote)) process.exit(EXIT_USAGE);

  const entry = {
    recordedAt: new Date().toISOString(),
    milestone,
    layer: args.layer || 'unknown',
    failureClass: args.class || 'build-layer-degraded',
    ticket,
    owner,
    dueMilestone,
    riskNote: String(riskNote).trim(),
    evidenceRef: args.evidence || null,
    retryCount: Number.parseInt(args.retryCount, 10) || 0,
    advisor: args.advisor || null,
    resolved: false,
  };

  appendLedger(entry);
  appendRow(milestone, entry);
  markStateDebt(milestone, LEDGER);

  const jsonOut = process.argv.includes('--json');
  if (jsonOut) {
    console.log(JSON.stringify({ recorded: true, entry, ledger: LEDGER, doc: degradedDocPath(milestone) }));
  } else {
    console.log(`[build-debt] recorded ${milestone} layer=${entry.layer} (${entry.failureClass}); ledger=${LEDGER}`);
  }
  process.exit(EXIT_OK);
}

function cmdList(args) {
  const milestoneFilter = args.milestone || null;
  if (!fs.existsSync(LEDGER)) {
    console.log(JSON.stringify({ total: 0, unresolved: 0, entries: [] }));
    process.exit(EXIT_OK);
  }
  const entries = fs
    .readFileSync(LEDGER, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((e) => !milestoneFilter || e.milestone === milestoneFilter);
  const unresolved = entries.filter((e) => !e.resolved);
  console.log(JSON.stringify({ total: entries.length, unresolved: unresolved.length, entries }, null, 2));
  process.exit(EXIT_OK);
}

function cmdConvertHalt(args) {
  const milestone = args.milestone || args._[0];
  if (!milestone) {
    console.error('Usage: cobolt-build-debt convert-halt <milestone>');
    process.exit(EXIT_USAGE);
  }

  // Prefer the structured Step 07 escalation evidence if present.
  const escalationPath = escalationEvidencePath(milestone);
  const haltPath = buildHaltPath(milestone);
  let source = null;
  let payload = null;

  if (fs.existsSync(escalationPath)) {
    payload = readJSONSafe(escalationPath);
    source = escalationPath;
  } else if (fs.existsSync(haltPath)) {
    const text = fs.readFileSync(haltPath, 'utf8');
    payload = parseHaltMarkdown(text);
    source = haltPath;
  } else {
    console.log(JSON.stringify({ converted: false, reason: 'no-halt-or-escalation-evidence', milestone }));
    process.exit(EXIT_NO_HALT);
  }

  if (!payload) {
    console.error(`[build-debt] failed to parse halt source: ${source}`);
    process.exit(EXIT_USAGE);
  }

  const failedLayers = Array.isArray(payload.failedLayers) ? payload.failedLayers : [];
  const retryCount = Number.parseInt(payload.retryCount, 10) || 0;

  // Generate one debt entry per failed layer so the carry-forward register is
  // layer-granular (matches milestone-close-evidence.schema.json carryForward
  // shape).
  const entries = [];
  const layers = failedLayers.length > 0 ? failedLayers : [payload.layer || 'unknown'];
  for (const layer of layers) {
    const entry = {
      recordedAt: new Date().toISOString(),
      milestone,
      layer,
      failureClass: payload.failureClass || 'build-layer-degraded',
      ticket: payload.ticket || `BUILD-DEBT-${milestone}-${layer}`,
      owner: payload.owner || 'cobolt-build-lead',
      dueMilestone: payload.dueMilestone || `${milestone}+1`,
      riskNote:
        payload.riskNote ||
        `Layer ${layer} failed Step 07 validation under --auto; converted from halt by recovery-advisor verdict skip-with-debt. Re-evaluate at next milestone.`,
      evidenceRef: source,
      retryCount,
      advisor: payload.advisor || null,
      convertedFromHalt: true,
      resolved: false,
    };
    if (!validateRiskNote(entry.riskNote)) {
      console.error(`[build-debt] auto-generated riskNote for ${layer} too short — fix payload`);
      process.exit(EXIT_USAGE);
    }
    appendLedger(entry);
    appendRow(milestone, entry);
    entries.push(entry);
  }

  markStateDebt(milestone, LEDGER);

  // Remove the halt sentinel — pipeline continues
  if (fs.existsSync(haltPath)) {
    try {
      fs.unlinkSync(haltPath);
    } catch {
      /* non-fatal */
    }
  }

  // Advance state past escalation-pending if it was set
  const state = readJSONSafe(STATE_FILE) || {};
  if (state.build?.status === 'escalation-pending') {
    state.build.status = 'debt-recorded';
    try {
      atomicWrite(STATE_FILE, JSON.stringify(state, null, 2));
    } catch {
      /* non-fatal */
    }
  }

  console.log(
    JSON.stringify({
      converted: true,
      milestone,
      source,
      entriesCount: entries.length,
      entries,
      halt_removed: fs.existsSync(haltPath) === false,
    }),
  );
  process.exit(EXIT_OK);
}

function parseHaltMarkdown(text) {
  const layerMatch = text.match(/\*\*Layer:\*\*\s+(\S+)/);
  const classMatch = text.match(/\*\*Failure class:\*\*\s+(\S+)/);
  const retryMatch = text.match(/\*\*Retry count:\*\*\s+(\d+)/);
  const failedLayersBlock = text.match(/\*\*Failed layers:\*\*\s+([^\n]+)/);
  const failedLayers = failedLayersBlock
    ? failedLayersBlock[1]
        .split(/[, ]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  return {
    layer: layerMatch ? layerMatch[1] : null,
    failureClass: classMatch ? classMatch[1] : 'build-layer-degraded',
    retryCount: retryMatch ? parseInt(retryMatch[1], 10) : 0,
    failedLayers,
  };
}

function showHelp() {
  process.stdout.write(
    'Usage: cobolt-build-debt {record <milestone> ... | list [--milestone <Mn>] | convert-halt <milestone>} [--json]\n',
  );
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    showHelp();
    process.exit(EXIT_OK);
  }
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);

  if (cmd === 'record') return cmdRecord(args);
  if (cmd === 'list') return cmdList(args);
  if (cmd === 'convert-halt') return cmdConvertHalt(args);

  console.error(`[build-debt] unknown command: ${cmd}`);
  showHelp();
  process.exit(EXIT_USAGE);
}

if (require.main === module) main();

module.exports = { cmdRecord, cmdList, cmdConvertHalt, parseHaltMarkdown };
