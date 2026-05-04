#!/usr/bin/env node
// cobolt-planning-debt — record DEGRADED planning artifacts in auto mode.
//
// When recovery-advisor returns skip-with-debt (or auto mode encounters an
// unrecoverable gap), the orchestrator records the debt here instead of halting.
// The pipeline continues; cobolt-release blocks on unresolved debt unless
// COBOLT_ACCEPT_PLANNING_DEBT=1 is explicitly set.
//
// Commands:
//   record <artifact> --class <cls> --sections "<s1,s2>" --sourceIds "<id1,id2>" --trigger "<text>" [--advisor <path>]
//     Append a debt entry to _cobolt-output/audit/planning-debt.jsonl and add a
//     row to _cobolt-output/latest/planning/DEGRADED-ARTIFACTS.md.
//   list                    Summarize unresolved debt as JSON.
//   convert-halt            If HUMAN-REVIEW-REQUIRED.md exists, read it, record
//                           a debt entry derived from its contents, then delete it.
//                           This is what the orchestrator calls in auto mode when
//                           advisor returns skip-with-debt or is unreachable.

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
const ROOT = process.cwd();
const PLANNING_DIR = path.join(ROOT, '_cobolt-output/latest/planning');
const FIX_DIR = path.join(ROOT, '_cobolt-output/latest/fix');
const AUDIT_DIR = path.join(ROOT, '_cobolt-output/audit');
const LEDGER = path.join(AUDIT_DIR, 'planning-debt.jsonl');
const DEGRADED_DOC = path.join(PLANNING_DIR, 'DEGRADED-ARTIFACTS.md');
const HALT_FILE = path.join(PLANNING_DIR, 'HUMAN-REVIEW-REQUIRED.md');
// v0.58 — fix-stage halt file (mirrors planning halt for /cobolt-unblock).
const HALT_FILE_FIX = path.join(FIX_DIR, 'HUMAN-REVIEW-REQUIRED.md');
const STATE_FILE = path.join(ROOT, 'cobolt-state.json');

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

function ensureDegradedDoc() {
  if (fs.existsSync(DEGRADED_DOC)) return;
  atomicWrite(
    DEGRADED_DOC,
    `# Degraded Planning Artifacts\n\nThis file lists planning artifacts accepted in DEGRADED state under autonomous execution. Each row represents content the pipeline could not author at full quality within the retry budget. Build and review stages can proceed; \`cobolt-release\` will block on unresolved entries unless \`COBOLT_ACCEPT_PLANNING_DEBT=1\`.\n\n| Artifact | Failure class | Degraded sections | Uncovered source IDs | Dropped FR IDs | Repayment trigger | Recorded |\n|---|---|---|---|---|---|---|\n`,
  );
}

function appendRow(entry) {
  ensureDegradedDoc();
  const row = `| \`${entry.artifact}\` | ${entry.failureClass} | ${(entry.sections || []).join(', ') || '—'} | ${(entry.uncoveredSourceIds || []).join(', ') || '—'} | ${(entry.frIds || []).join(', ') || '—'} | ${entry.repaymentTrigger || '—'} | ${entry.recordedAt} |\n`;
  fs.appendFileSync(DEGRADED_DOC, row);
}

function appendLedger(entry) {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  fs.appendFileSync(LEDGER, `${JSON.stringify(entry)}\n`);
}

function markStateDebt() {
  const state = readJSONSafe(STATE_FILE) || {};
  if (!state.planning) state.planning = {};
  state.planning.hasDebt = true;
  state.planning.debtLedger = path.relative(ROOT, LEDGER).replaceAll('\\', '/');
  try {
    atomicWrite(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    /* non-fatal */
  }
}

// v0.52+ — extract canonical FR-IDs from a comma-or-space-separated CLI list.
// Used by both --frIds (explicit) and convert-halt (regex from halt body).
function parseFrIdList(raw) {
  return String(raw || '')
    .split(/[,\s]+/u)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^FR-\d+$/i.test(s));
}

// v0.58 — extract canonical finding IDs (any PREFIX-NNN form) from a CLI list
// or halt-body. Mirrors parseFrIdList but accepts the broader fix-stage finding
// taxonomy (SEC, CODE, A11Y, DB, COMP, INT, OPS, DEP, UI, DT, UX, I18N, PERF,
// SIL, ARCH, CONF, FEAT, ENH, TEST, WIRE, LIFECYCLE). Prefix may contain
// digits (A11Y, I18N) but must start with a letter.
function parseFindingIdList(raw) {
  return String(raw || '')
    .split(/[,\s]+/u)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z][A-Z0-9]{1,5}-\d+$/i.test(s));
}

function cmdRecord(args) {
  const artifact = args.artifact || args._[0];
  if (!artifact) {
    console.error(
      'Usage: cobolt-planning-debt record <artifact> --class <cls> [--sections s1,s2] [--sourceIds id1,id2] [--frIds FR-1,FR-2] [--findingIds SEC-1,CODE-2] [--justification text] [--trigger text] [--advisor path]',
    );
    process.exit(1);
  }
  const frIds = parseFrIdList(args.frIds);
  const findingIds = parseFindingIdList(args.findingIds);
  // v0.52+ — when frIds is non-empty, justification must be substantive (≥30 chars)
  // so plan-fix's recovery-advisor cannot record FR-loss debt without a paper trail.
  // v0.58+ — same justification floor applies to fix-stage findingIds[] (FX-class debt).
  const justification = String(args.justification || '').trim();
  if (frIds.length > 0 && justification.length < 30) {
    console.error(
      '[planning-debt] FR-loss debt requires --justification with at least 30 characters explaining the deferral.',
    );
    process.exit(1);
  }
  if (findingIds.length > 0 && justification.length < 30) {
    console.error(
      '[planning-debt] Fix-stage finding-loss debt requires --justification with at least 30 characters explaining the deferral.',
    );
    process.exit(1);
  }
  const entry = {
    recordedAt: new Date().toISOString(),
    artifact,
    failureClass: args.class || 'planning-content-quality',
    sections: (args.sections || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    uncoveredSourceIds: (args.sourceIds || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    frIds,
    findingIds,
    justification: justification || null,
    repaymentTrigger: args.trigger || 'Raise at next milestone retrospective',
    advisor: args.advisor || null,
    resolved: false,
  };
  appendLedger(entry);
  appendRow(entry);
  markStateDebt();
  const jsonOut = process.argv.includes('--json');
  if (jsonOut) console.log(JSON.stringify({ recorded: true, entry, ledger: LEDGER, doc: DEGRADED_DOC }));
  else console.log(`[planning-debt] recorded ${artifact} (${entry.failureClass}); ledger=${LEDGER}`);
  process.exit(0);
}

function cmdList() {
  if (!fs.existsSync(LEDGER)) {
    console.log(JSON.stringify({ total: 0, unresolved: 0, entries: [] }));
    process.exit(0);
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
    .filter(Boolean);
  const unresolved = entries.filter((e) => !e.resolved);
  console.log(JSON.stringify({ total: entries.length, unresolved: unresolved.length, entries }, null, 2));
  process.exit(unresolved.length > 0 ? 0 : 0);
}

function cmdConvertHalt(args) {
  // v0.58 — accept --source flag to select between planning halt (default) and
  // fix-stage halt. Mirrors the recovery-advisor handoff for /cobolt-unblock.
  const source = args && (args.source || args.s);
  const isFix = source === 'fix';
  const haltFile = isFix ? HALT_FILE_FIX : HALT_FILE;
  const stateBranch = isFix ? 'fix' : 'planning';

  if (!fs.existsSync(haltFile)) {
    console.log(JSON.stringify({ converted: false, source: source || 'planning', reason: 'no-halt-file', haltFile }));
    process.exit(0);
  }
  const text = fs.readFileSync(haltFile, 'utf8');
  const artifactMatch = text.match(/\*\*Artifact:\*\*\s+`([^`]+)`/);
  const classMatch = text.match(/\*\*Failure class:\*\*\s+(\S+)/);
  const skillMatch = text.match(/\*\*Producing skill:\*\*\s+(\S+)/);
  const artifact = artifactMatch ? artifactMatch[1] : isFix ? 'fix-loop' : 'unknown';
  const failureClass = classMatch ? classMatch[1] : isFix ? 'fix-stage-unresolved' : 'planning-content-quality';
  const producingSkill = skillMatch ? skillMatch[1] : isFix ? 'cobolt-fix' : 'unknown';

  const sections = [];
  const targetRe = /\d+\.\s+\*\*([^*]+)\*\*/g;
  let m;
  while ((m = targetRe.exec(text)) !== null) sections.push(m[1].trim());

  // v0.52+ — capture FR-IDs cited anywhere in the halt body so the conservation
  // gate downstream can verify dropped FRs are tracked. Deduplicate + canonicalize.
  const frIdMatches = text.match(/\bFR-\d+\b/giu) || [];
  const frIds = [...new Set(frIdMatches.map((id) => id.toUpperCase()))].sort();

  // v0.58+ — capture all finding IDs (any PREFIX-NNN form except FR which is
  // captured separately). The prefix allows mixed letter/digit (A11Y, I18N,
  // K8S) but must start with a letter. Read by cobolt-fix-test-deletion-gate
  // and cobolt-fix-finding-traceability-gate as authoritative deferral evidence.
  const findingIdMatches = text.match(/\b[A-Z][A-Z0-9]{1,5}-\d+\b/gu) || [];
  const findingIds = [
    ...new Set(findingIdMatches.map((id) => id.toUpperCase()).filter((id) => !id.startsWith('FR-'))),
  ].sort();

  // v0.58+ — extract justification block (≥30 chars). Look for explicit
  // "Justification:" / "Reason:" / "Risk:" sections. Fallback synthesizes
  // from producing-skill + failure-class + sections.
  let justification = '';
  const justRe = /(?:Justification|Reason|Risk[- ]Note):\s*([\s\S]+?)(?=\n\n|\n\*\*|\n##|$)/i;
  const justMatch = text.match(justRe);
  if (justMatch) {
    justification = justMatch[1].trim().replace(/\s+/g, ' ');
  }
  if (justification.length < 30) {
    justification = `Auto-converted from ${path.basename(haltFile)} under autonomous mode. Producing skill: ${producingSkill}. Failure class: ${failureClass}. Sections: ${sections.slice(0, 3).join(', ') || 'unknown'}. Review at milestone retrospective.`;
  }

  const entry = {
    recordedAt: new Date().toISOString(),
    artifact,
    failureClass,
    producingSkill,
    sections,
    uncoveredSourceIds: [],
    frIds,
    findingIds,
    justification,
    repaymentTrigger: `Converted from ${path.basename(haltFile)} under auto mode; review at milestone retrospective`,
    convertedFromHalt: true,
    haltSource: isFix ? 'fix' : 'planning',
    resolved: false,
  };
  appendLedger(entry);
  appendRow(entry);
  markStateDebt();

  // Remove the halt file — auto mode continues
  try {
    fs.unlinkSync(haltFile);
  } catch {
    /* non-fatal */
  }
  // Clear status HUMAN_REVIEW marker on the appropriate state branch.
  const state = readJSONSafe(STATE_FILE) || {};
  if (!state[stateBranch]) state[stateBranch] = {};
  if (state[stateBranch].status === 'HUMAN_REVIEW') {
    state[stateBranch].status = 'DEGRADED';
    try {
      atomicWrite(STATE_FILE, JSON.stringify(state, null, 2));
    } catch {
      /* non-fatal */
    }
  }
  console.log(
    JSON.stringify({ converted: true, source: isFix ? 'fix' : 'planning', entry, halt_removed: true, haltFile }),
  );
  process.exit(0);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (cmd === 'record') return cmdRecord(args);
  if (cmd === 'list') return cmdList();
  if (cmd === 'convert-halt') return cmdConvertHalt(args);
  console.error(
    'Usage: cobolt-planning-debt {record <artifact> ... | list | convert-halt [--source fix|planning]} [--json]',
  );
  // Tool-exit-contract: --help/-h or no-args -> 0; unknown subcommand -> 1
  const firstArg = process.argv[2];
  const isHelp = firstArg === '--help' || firstArg === '-h';
  process.exit(process.argv.length <= 2 || isHelp ? 0 : 1);
}

if (require.main === module) main();

module.exports = { cmdRecord, cmdList, cmdConvertHalt, parseFrIdList, parseFindingIdList };
