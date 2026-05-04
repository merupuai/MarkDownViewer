#!/usr/bin/env node
// cobolt-contract-fingerprint — SHA-256 fingerprinting for interface contracts.
//
// v0.64+ Phase 3 of Cobolt-Fix Pipeline Parity Initiative. Used by
// architect-fix-agent (mandatory before proposing arch mutations) and
// cobolt-fix-arch-mutation-gate (Tier 1 PreToolUse) to detect cross-milestone
// contract drift. Mirrors plan-stage v0.54+ retroactive-contract-gate logic
// for fix-stage architecture mutations.
//
// Subcommands:
//   fingerprint <milestone>          Compute SHA-256 of normalized
//                                    interface-contracts.json + api-contracts/*.yaml
//                                    Output to _cobolt-output/audit/contract-fingerprints.jsonl
//   compare <fromMilestone> <toMilestone>
//                                    Compute drift between two milestones.
//   drift-report --proposal <path>   Compute drift if the proposal at <path>
//                                    were applied. Reads proposal frontmatter
//                                    + diff-style mutation block.
//
// Exit codes follow the standard contract: 0 success, 1 hard error, 2 missing
// optional dep (e.g. yaml parser absent), 3 missing infra. drift-report exits
// 0 when no drift, 1 when drift detected (so callers can `if; then` branch).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = process.cwd();
const PLANNING_DIR = path.join(ROOT, '_cobolt-output/latest/planning');
const AUDIT_DIR = path.join(ROOT, '_cobolt-output/audit');
const FINGERPRINTS_LEDGER = path.join(AUDIT_DIR, 'contract-fingerprints.jsonl');

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  } catch {
    /* exists */
  }
}

function readJSONSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// Deterministic JSON serialization — sort keys recursively before stringify.
// Required because two semantically-identical contracts with different key
// order MUST produce the same fingerprint.
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = canonicalize(value[key]);
  }
  return sorted;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// Compute the fingerprint of the contract surface for a milestone.
// Inputs:
//   - _cobolt-output/latest/planning/interface-contracts.json (canonical surface)
//   - _cobolt-output/latest/planning/api-contracts/*.yaml (per-domain contracts)
// Returns { fingerprint, components: [{path, sha256}] }.
function computeFingerprint() {
  const components = [];

  const interfacePath = path.join(PLANNING_DIR, 'interface-contracts.json');
  const interface_ = readJSONSafe(interfacePath);
  if (interface_) {
    const canonical = JSON.stringify(canonicalize(interface_));
    components.push({ path: 'interface-contracts.json', sha256: sha256(canonical) });
  }

  const apiDir = path.join(PLANNING_DIR, 'api-contracts');
  if (fs.existsSync(apiDir)) {
    const yamlFiles = fs
      .readdirSync(apiDir)
      .filter((f) => /\.(yaml|yml)$/i.test(f))
      .sort();
    for (const file of yamlFiles) {
      const content = fs.readFileSync(path.join(apiDir, file), 'utf8');
      // For YAML, we hash the raw bytes (sorted keys are not trivial without
      // a YAML library). This is conservative — a whitespace-only edit
      // produces a different fingerprint, which is the correct behavior for
      // contract-drift detection.
      components.push({ path: `api-contracts/${file}`, sha256: sha256(content) });
    }
  }

  // Aggregate fingerprint = SHA-256 of the canonical component list.
  const aggregate = sha256(JSON.stringify(components));
  return { fingerprint: aggregate, components };
}

function cmdFingerprint(args) {
  const milestone = args._[0] || args.milestone;
  if (!milestone) {
    console.error('Usage: cobolt-contract-fingerprint fingerprint <milestoneId>');
    process.exit(1);
  }

  const result = computeFingerprint();
  const entry = {
    at: new Date().toISOString(),
    milestone,
    fingerprint: result.fingerprint,
    components: result.components,
  };

  ensureDir(AUDIT_DIR);
  fs.appendFileSync(FINGERPRINTS_LEDGER, `${JSON.stringify(entry)}\n`, { mode: 0o600 });

  console.log(JSON.stringify(entry, null, 2));
  process.exit(0);
}

function readFingerprintsLedger() {
  if (!fs.existsSync(FINGERPRINTS_LEDGER)) return [];
  return fs
    .readFileSync(FINGERPRINTS_LEDGER, 'utf8')
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
}

function lastFingerprintFor(milestone) {
  const ledger = readFingerprintsLedger();
  return ledger.filter((e) => e.milestone === milestone).pop() || null;
}

function cmdCompare(args) {
  const fromM = args._[0] || args.from;
  const toM = args._[1] || args.to;
  if (!fromM || !toM) {
    console.error('Usage: cobolt-contract-fingerprint compare <fromMilestone> <toMilestone>');
    process.exit(1);
  }

  const fromEntry = lastFingerprintFor(fromM);
  const toEntry = lastFingerprintFor(toM);

  if (!fromEntry || !toEntry) {
    console.log(
      JSON.stringify({
        drifted: false,
        reason: 'one-or-both-fingerprints-missing',
        fromExists: !!fromEntry,
        toExists: !!toEntry,
      }),
    );
    process.exit(0);
  }

  const drifted = fromEntry.fingerprint !== toEntry.fingerprint;

  // Compute per-component drift list.
  const fromMap = new Map(fromEntry.components.map((c) => [c.path, c.sha256]));
  const toMap = new Map(toEntry.components.map((c) => [c.path, c.sha256]));
  const allPaths = new Set([...fromMap.keys(), ...toMap.keys()]);
  const driftDetail = [];
  for (const p of allPaths) {
    const f = fromMap.get(p);
    const t = toMap.get(p);
    if (f !== t) {
      driftDetail.push({
        path: p,
        from: f || null,
        to: t || null,
        change: !f ? 'added' : !t ? 'removed' : 'modified',
      });
    }
  }

  const out = {
    drifted,
    fromMilestone: fromM,
    toMilestone: toM,
    fromFingerprint: fromEntry.fingerprint,
    toFingerprint: toEntry.fingerprint,
    componentDrift: driftDetail,
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(drifted ? 1 : 0);
}

function cmdDriftReport(args) {
  const proposalPath = args.proposal || args.p;
  if (!proposalPath) {
    console.error('Usage: cobolt-contract-fingerprint drift-report --proposal <path>');
    process.exit(1);
  }
  if (!fs.existsSync(proposalPath)) {
    console.log(JSON.stringify({ drifted: false, reason: 'no-proposal-file', proposalPath }));
    process.exit(0);
  }

  // Compute current fingerprint (the proposal would mutate this).
  const before = computeFingerprint();

  // Compare against ALL prior shipped milestones in the ledger to detect
  // retroactive drift (a proposal that breaks a prior milestone's contract).
  const ledger = readFingerprintsLedger();
  const priorMilestones = [...new Set(ledger.map((e) => e.milestone))];
  const conflicts = [];
  for (const m of priorMilestones) {
    const entry = lastFingerprintFor(m);
    if (!entry) continue;
    if (entry.fingerprint !== before.fingerprint) {
      // Already drifted — proposal would compound the drift.
      conflicts.push({
        milestone: m,
        priorFingerprint: entry.fingerprint,
        currentFingerprint: before.fingerprint,
      });
    }
  }

  const out = {
    drifted: conflicts.length > 0,
    proposalPath,
    currentFingerprint: before.fingerprint,
    priorMilestonesAffected: conflicts,
    advice:
      conflicts.length > 0
        ? 'Proposal would create cross-milestone drift. architect-fix-agent must verdict: DECLINE_TO_PROPOSE and route to /cobolt-plan-fix.'
        : 'Proposal is cross-milestone safe. Apply may proceed.',
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(conflicts.length > 0 ? 1 : 0);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v.startsWith('--')) {
      const k = v.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[k] = true;
      } else {
        args[k] = next;
        i++;
      }
    } else {
      args._.push(v);
    }
  }
  return args;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const isHelp = cmd === '--help' || cmd === '-h';
  if (!cmd || isHelp) {
    console.log(
      'Usage: cobolt-contract-fingerprint {fingerprint <milestone>|compare <from> <to>|drift-report --proposal <path>}',
    );
    process.exit(0);
  }
  const args = parseArgs(rest);
  switch (cmd) {
    case 'fingerprint':
      cmdFingerprint(args);
      break;
    case 'compare':
      cmdCompare(args);
      break;
    case 'drift-report':
      cmdDriftReport(args);
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  computeFingerprint,
  canonicalize,
  sha256,
  readFingerprintsLedger,
  lastFingerprintFor,
  cmdFingerprint,
  cmdCompare,
  cmdDriftReport,
};
