#!/usr/bin/env node
// cobolt-dora — DORA Four Key Metrics computed from git history.
// Appends to _cobolt-output/audit/dora-metrics.jsonl for trend tracking.
//
// Usage:
//   node tools/cobolt-dora.js report [--window 90]

const fs = require('node:fs');
const path = require('node:path');
const { computeAll } = require('../lib/standards/dora-compute.js');

// GT-01: bypass routes through signed ledger; env-var auto-promotes during window.
function KILL() {
  const { isGateBypassed } = require('../lib/cobolt-bypass-resolver');
  return isGateBypassed('standards', { projectRoot: process.cwd() });
}

function overallRating(data) {
  const ratings = [
    data.deploymentFrequency.rating,
    data.leadTimeForChanges.rating,
    data.changeFailureRate.rating,
    data.meanTimeToRestore.rating,
  ];
  const order = ['low', 'medium', 'high', 'elite'];
  let min = 3;
  for (const r of ratings) {
    const idx = order.indexOf(r);
    if (idx >= 0 && idx < min) min = idx;
  }
  return order[min];
}

function render(data) {
  const lines = [];
  lines.push(`# DORA Four Key Metrics`);
  lines.push(`Window: ${data.windowDays} days  Computed: ${data.computedAt}`);
  lines.push('');
  lines.push(`| Metric | Value | Rating |`);
  lines.push(`|----|----|----|`);
  lines.push(
    `| Deployment Frequency | ${data.deploymentFrequency.value} ${data.deploymentFrequency.unit} (${data.deploymentFrequency.count || 0} total) | **${data.deploymentFrequency.rating}** |`,
  );
  lines.push(
    `| Lead Time for Changes | ${data.leadTimeForChanges.median_hours ?? 'n/a'} h median | **${data.leadTimeForChanges.rating}** |`,
  );
  lines.push(
    `| Change Failure Rate | ${(data.changeFailureRate.rate * 100).toFixed(1)}% (${data.changeFailureRate.failures}/${data.changeFailureRate.deployments}) | **${data.changeFailureRate.rating}** |`,
  );
  lines.push(
    `| Mean Time to Restore | ${data.meanTimeToRestore.hours ?? 'n/a'} h | **${data.meanTimeToRestore.rating}** |`,
  );
  lines.push('');
  lines.push(`**Overall: ${data.overallRating}**`);
  return lines.join('\n');
}

function printUsage() {
  console.log(
    [
      'cobolt-dora - DORA four-key-metrics report (deployment freq, lead time, CFR, MTTR).',
      '',
      'Usage:',
      '  node tools/cobolt-dora.js [report] [--window <days>]',
      '',
      'Default window is 90 days. Use `--help` or `-h` to print this usage without side effects.',
    ].join('\n'),
  );
}

// Phase 3.3 (v0.63+) — append DORA metrics to the unified evidence ledger
// so compliance evidence packs can prove engineering-performance signals
// were captured. Tier 3 advisory — never blocks DORA computation on ledger
// failure. Maps to *Accelerate* (Forsgren, Humble, Kim) DORA framework +
// ISO/IEC 27001 A.8.16 (monitoring) + SOC 2 CC7.2 (anomaly monitoring).
function _appendToEvidenceLedger(projectRoot, data) {
  try {
    const evLedger = require('../lib/cobolt-evidence-ledger');
    return evLedger.append(
      {
        kind: evLedger.KINDS.CHECK_RESULT,
        producer: 'cobolt-dora/v0.63.0',
        controlIds: ['ISO.27001.A.8.16', 'SOC2.CC7.2', 'NIST.SSDF.PO.4.1'],
        payload: {
          windowDays: data.windowDays,
          deploymentFrequency: {
            rating: data.deploymentFrequency.rating,
            value: data.deploymentFrequency.value,
            unit: data.deploymentFrequency.unit,
            count: data.deploymentFrequency.count || 0,
          },
          leadTimeForChanges: {
            rating: data.leadTimeForChanges.rating,
            medianHours: data.leadTimeForChanges.median_hours ?? null,
          },
          changeFailureRate: {
            rating: data.changeFailureRate.rating,
            rate: data.changeFailureRate.rate,
            failures: data.changeFailureRate.failures,
            deployments: data.changeFailureRate.deployments,
          },
          meanTimeToRestore: {
            rating: data.meanTimeToRestore.rating,
            hours: data.meanTimeToRestore.hours ?? null,
          },
          overallRating: data.overallRating,
        },
      },
      { projectRoot },
    );
  } catch {
    return null;
  }
}

function main() {
  if (KILL()) {
    console.log('COBOLT_STANDARDS=off — skipping');
    process.exit(0);
  }
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }
  const getOpt = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : null;
  };
  const projectRoot = process.cwd();
  const window = Number(getOpt('--window')) || 90;
  const data = computeAll(projectRoot, window);
  data.overallRating = overallRating(data);
  const outDir = path.join(projectRoot, '_cobolt-output', 'standards');
  fs.mkdirSync(outDir, { recursive: true });
  const outJson = path.join(outDir, 'dora-metrics.json');
  fs.writeFileSync(outJson, JSON.stringify(data, null, 2));
  const outMd = path.join(outDir, 'dora-metrics.md');
  fs.writeFileSync(outMd, render(data));
  // Append to trend log.
  const auditDir = path.join(projectRoot, '_cobolt-output', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.appendFileSync(path.join(auditDir, 'dora-metrics.jsonl'), `${JSON.stringify(data)}\n`);
  // Phase 3.3 — additionally append to the unified evidence ledger so
  // compliance reports can correlate DORA metrics with milestone close.
  const ledgerEntry = _appendToEvidenceLedger(projectRoot, data);
  console.log(
    `dora: df=${data.deploymentFrequency.rating} lt=${data.leadTimeForChanges.rating} cfr=${data.changeFailureRate.rating} mttr=${data.meanTimeToRestore.rating}  overall=${data.overallRating}`,
  );
  console.log(`  written: ${outJson}`);
  if (ledgerEntry) console.log(`  ledger: ${ledgerEntry.entryId}`);
}

if (require.main === module) main();
module.exports = { computeAll, main, overallRating, render, _appendToEvidenceLedger };
