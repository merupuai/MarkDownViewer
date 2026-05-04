#!/usr/bin/env node

// CoBolt pipeline ETA + cost estimate — standalone CLI.
//
// Usage:
//   node tools/cobolt-estimate.js            # human-readable
//   node tools/cobolt-estimate.js --json     # JSON for piping
//   node tools/cobolt-estimate.js --tier opus
//
// Safe by design: no writes, no state changes, no network.

const fs = require('node:fs');
const path = require('node:path');

const { buildEstimates, formatDuration, formatUsd } = require('../lib/cobolt-estimates');

function readProgress(cwd) {
  try {
    const f = path.join(cwd, '_cobolt-output', 'audit', 'progress.json');
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const out = { json: false, tier: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--tier') out.tier = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function render(est) {
  if (!est) {
    console.log('No pipeline estimate available (no progress data).');
    return;
  }
  console.log();
  console.log('  CoBolt Pipeline Estimate');
  console.log('  '.concat('═'.repeat(56)));
  console.log(`  Current:         ${est.currentStage}${est.currentMilestone ? ` (${est.currentMilestone})` : ''}`);
  console.log(`  Model tier:      ${est.modelTier}`);
  console.log(`  Confidence:      ${est.confidence}  (${est.basis})`);
  console.log();
  console.log(`  This milestone:  ETA ~${est.thisMilestone.etaLabel}   Cost ~${est.thisMilestone.costLabel}`);
  if (est.milestonesAhead > 0) {
    console.log(`  Remaining (${est.milestonesAhead} more milestones):`);
    console.log(`  Full pipeline:   ETA ~${est.pipeline.etaLabel}   Cost ~${est.pipeline.costLabel}`);
  }
  console.log();
  console.log('  Per-remaining-stage breakdown:');
  for (const s of est.remainingStages) {
    const src = s.samples >= 3 ? `n=${s.samples}` : 'baseline';
    console.log(
      `    ${s.stage.padEnd(4)} ~${formatDuration(s.minutes).padEnd(6)} ~${formatUsd(s.usd).padEnd(8)} (${src})`,
    );
  }
  console.log();
  console.log('  Note: estimates are rough — accuracy improves after ~5 completed runs.');
  console.log();
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node tools/cobolt-estimate.js [--json] [--tier sonnet|opus]');
    process.exit(0);
  }
  const cwd = process.cwd();
  const est = buildEstimates(cwd, readProgress(cwd), { modelTier: args.tier });
  if (args.json) console.log(JSON.stringify(est, null, 2));
  else render(est);
}

module.exports = { render, parseArgs };
