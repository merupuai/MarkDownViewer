#!/usr/bin/env node
// cobolt-debt-banner — emit a one-line banner when the project is carrying planning debt.
//
// Called at pipeline-entry by build/review/fix/deploy skills so operators see
// the debt load without running a separate tool. Silent when there is no debt.
//
// Usage:
//   node tools/cobolt-debt-banner.js              # print banner (or nothing) and exit 0
//   node tools/cobolt-debt-banner.js --json       # machine-readable envelope
//   node tools/cobolt-debt-banner.js --exit-on-debt  # exit 4 when debt > 0 (for gate wiring)
//
// Exit codes:
//   0 — no debt or plain-mode call (always 0 in plain-mode)
//   4 — debt present AND --exit-on-debt was passed

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const DEBT_LEDGER = path.join(ROOT, '_cobolt-output', 'audit', 'planning-debt.jsonl');
const HALT_FILE = path.join(ROOT, '_cobolt-output', 'latest', 'planning', 'HUMAN-REVIEW-REQUIRED.md');
// v0.61 (D13): banner emissions are now persisted to a separate JSONL so
// pipeline runs can be reconstructed after the fact. Pre-fix, the banner
// was console-only — operators who missed the log line had no recoverable
// record that pipeline entry detected debt at all.
const BANNER_AUDIT_LOG = path.join(ROOT, '_cobolt-output', 'audit', 'debt-banner.jsonl');

function readJsonLines(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function collect() {
  const entries = readJsonLines(DEBT_LEDGER);
  const unresolved = entries.filter((e) => !e.resolved);
  const haltPresent = fileExists(HALT_FILE);
  const oldestUnresolved = unresolved.length > 0 ? unresolved[0] : null;
  return {
    debtTotal: entries.length,
    debtUnresolved: unresolved.length,
    haltPresent,
    oldestUnresolvedArtifact: oldestUnresolved?.artifact || null,
    oldestUnresolvedRecordedAt: oldestUnresolved?.recordedAt || null,
  };
}

function renderBanner(info) {
  if (info.haltPresent) {
    return `[cobolt] HUMAN-REVIEW-REQUIRED.md is present — run /cobolt-unblock or see docs/PLANNING-RECOVERY.md before continuing.`;
  }
  if (info.debtUnresolved === 0) return null;
  const oldest = info.oldestUnresolvedArtifact ? ` (oldest: ${info.oldestUnresolvedArtifact})` : '';
  return `[cobolt] carrying ${info.debtUnresolved} planning debt ${info.debtUnresolved === 1 ? 'entry' : 'entries'}${oldest}. cobolt-release will block. Run 'npm run status:show' (or legacy 'npm run tools:status') for details.`;
}

// v0.61 (D13): record every banner emission to a JSONL audit log so pipeline
// runs can be reconstructed after the fact even when the operator missed
// the console output. Best-effort write — never fail the pipeline over
// audit IO. Silent when there is no banner (no debt, no halt file).
function writeBannerAudit(info, banner, callerSkill) {
  if (!banner) return;
  try {
    fs.mkdirSync(path.dirname(BANNER_AUDIT_LOG), { recursive: true, mode: 0o700 });
    const entry = {
      timestamp: new Date().toISOString(),
      tool: 'cobolt-debt-banner',
      callerSkill: callerSkill || null,
      bannerClass: info.haltPresent ? 'human-review-required' : 'planning-debt',
      debtTotal: info.debtTotal,
      debtUnresolved: info.debtUnresolved,
      haltPresent: info.haltPresent,
      oldestUnresolvedArtifact: info.oldestUnresolvedArtifact,
      oldestUnresolvedRecordedAt: info.oldestUnresolvedRecordedAt,
      banner,
    };
    fs.appendFileSync(BANNER_AUDIT_LOG, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    /* best-effort — banner audit IO failure must not break pipeline entry */
  }
}

function main() {
  const argv = process.argv.slice(2);
  const jsonOut = argv.includes('--json');
  const exitOnDebt = argv.includes('--exit-on-debt');
  // v0.61 (D13): callers can identify themselves so the audit log shows
  // which skill triggered the banner. Optional — falls back to null.
  const callerIdx = argv.indexOf('--caller');
  const callerSkill = callerIdx >= 0 ? argv[callerIdx + 1] || null : null;

  const info = collect();
  const banner = renderBanner(info);

  if (jsonOut) {
    console.log(
      JSON.stringify(
        {
          ...info,
          banner,
        },
        null,
        2,
      ),
    );
  } else if (banner) {
    console.log(banner);
  }

  // Persist the banner emission for forensic recovery.
  writeBannerAudit(info, banner, callerSkill);

  if (exitOnDebt && (info.debtUnresolved > 0 || info.haltPresent)) {
    process.exit(4);
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = { collect, renderBanner, writeBannerAudit, BANNER_AUDIT_LOG };
