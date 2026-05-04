#!/usr/bin/env node

// CoBolt Evolve — canary auto-revert CLI (Phase 5).
//
// Usage:
//   node tools/cobolt-evolve-canary.js check <candidateId> <canary-scorecard.json> [--auto-revert] [--dry-run]
//
// Reads:
//   * harness-lab/candidates/<id>/manifest.json — to confirm the candidate was promoted
//   * harness-lab/candidates/<id>/shadow-scorecard.json — used as baseline
//   * <canary-scorecard.json> argv path — the fresh scorecard to compare
//
// Behavior:
//   * Tier-1 regression in canary score → always revert (or report if --dry-run / --auto-revert absent)
//   * Per-axis tolerance breach → revert when --auto-revert; otherwise emit verdict
//   * Within tolerance → emit "ok" verdict, exit 0
//
// In all cases writes a verdict to harness-lab/canary/<candidateId>-<ts>.json
// for audit + lineage continuity. --auto-revert calls cobolt-evolve revert
// internally (execFileSync) so all lineage rules apply.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const paths = require('../lib/cobolt-evolve/paths');
const canary = require('../lib/cobolt-evolve/canary');

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv) {
  const out = { _: [], autoRevert: false, dryRun: false, reason: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--auto-revert') out.autoRevert = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--reason') out.reason = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else out._.push(a);
  }
  return out;
}

function help() {
  process.stdout.write(
    [
      'cobolt-evolve-canary — post-promotion canary auto-revert',
      '',
      'Usage:',
      '  node tools/cobolt-evolve-canary.js check <candidateId> <canary-scorecard.json> [--auto-revert] [--dry-run]',
      '',
    ].join('\n'),
  );
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help || args._.length === 0) {
    help();
    return 0;
  }
  const cmd = args._[0];
  if (cmd !== 'check') {
    process.stderr.write(`unknown command: ${cmd}\n`);
    help();
    return 2;
  }
  const candidateId = args._[1];
  const scPath = args._[2];
  if (!/^c-[0-9a-f]{12}$/.test(candidateId || '') || !scPath) {
    process.stderr.write('usage: cobolt-evolve-canary check <candidateId> <canary-scorecard.json>\n');
    return 2;
  }
  const cwd = process.cwd();
  const cdir = paths.candidateDir(candidateId, cwd);
  const manifestPath = path.join(cdir, 'manifest.json');
  const baselinePath = path.join(cdir, 'shadow-scorecard.json');
  if (!fs.existsSync(manifestPath) || !fs.existsSync(baselinePath)) {
    process.stderr.write('candidate manifest or baseline scorecard missing\n');
    return 2;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.status !== 'promoted') {
    process.stderr.write(`candidate status is "${manifest.status}", not "promoted" — nothing to canary\n`);
    return 2;
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const canarySc = JSON.parse(fs.readFileSync(path.resolve(scPath), 'utf8'));

  const tier1 = canary.isTier1Kill(canarySc);
  const verdict = canary.detectRegression(baseline.axes, canarySc.axes);
  const shouldRevert = tier1 || verdict.regressed;
  const result = {
    candidateId,
    checkedAt: nowIso(),
    tier1Kill: tier1,
    ...verdict,
    shouldRevert,
    autoRevert: !!args.autoRevert,
    dryRun: !!args.dryRun,
  };

  // Persist verdict
  const verdictDir = path.join(paths.root(cwd), 'canary');
  paths.ensureDir(verdictDir);
  const verdictPath = path.join(verdictDir, `${candidateId}-${Date.now()}.json`);
  fs.writeFileSync(verdictPath, JSON.stringify(result, null, 2), { mode: 0o600 });
  result.verdictPath = verdictPath;

  if (shouldRevert && args.autoRevert && !args.dryRun) {
    const reason = args.reason || (tier1 ? 'tier-1 regression in canary' : verdict.reason);
    try {
      const evolveCli = path.join(__dirname, 'cobolt-evolve.js');
      execFileSync('node', [evolveCli, 'revert', candidateId, '--reason', reason], { stdio: 'pipe', cwd });
      result.reverted = true;
    } catch (e) {
      result.reverted = false;
      result.revertError = (e.stderr || e.message || '').toString().slice(0, 500);
    }
  } else {
    result.reverted = false;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return shouldRevert && !args.autoRevert ? 1 : 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, parseArgs };
