#!/usr/bin/env node
// cobolt-iso25010 — ISO/IEC 25010:2023 quality scorecard.
// Buckets existing CoBolt findings/metrics into the 8 product-quality
// characteristics. Advisory only — never blocks pipeline.
//
// Usage:
//   node tools/cobolt-iso25010.js check [--milestone M1] [--out path.json]
//   node tools/cobolt-iso25010.js report

const fs = require('node:fs');
const path = require('node:path');
const {
  CHARACTERISTICS,
  classifySource,
  emptyScorecard,
  computeScore,
} = require('../lib/standards/iso25010-taxonomy.js');

// GT-01: bypass routes through signed ledger; env-var auto-promotes during window.
function KILL() {
  const { isGateBypassed } = require('../lib/cobolt-bypass-resolver');
  return isGateBypassed('standards', { projectRoot: process.cwd() });
}

function safeReadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function collectFindings(projectRoot) {
  const out = [];
  const candidates = [
    path.join(projectRoot, '_cobolt-output', 'latest', 'review', 'finding-tracker.json'),
    path.join(projectRoot, '_cobolt-output', 'latest', 'security', 'findings.json'),
  ];
  for (const p of candidates) {
    const data = safeReadJson(p);
    if (!data) continue;
    const arr = Array.isArray(data) ? data : data.findings || data.items || [];
    for (const f of arr) out.push(f);
  }
  return out;
}

function bucketSeverity(row, sev) {
  const s = String(sev || '').toLowerCase();
  if (s === 'critical') row.critical++;
  else if (s === 'high') row.high++;
  else if (s === 'medium' || s === 'moderate') row.medium++;
  else row.low++;
  row.findings++;
}

function grade(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function build(projectRoot, opts = {}) {
  const scorecard = emptyScorecard();
  const findings = collectFindings(projectRoot);
  for (const f of findings) {
    const charKey = classifySource(f.category || f.source || f.id || '');
    if (!charKey) continue;
    bucketSeverity(scorecard[charKey], f.severity);
  }
  let total = 0;
  let count = 0;
  for (const key of Object.keys(scorecard)) {
    scorecard[key].score = computeScore(scorecard[key]);
    total += scorecard[key].score;
    count++;
  }
  const overall = Math.round((total / Math.max(1, count)) * 10) / 10;
  return {
    version: '1.0',
    standard: 'ISO/IEC 25010:2023',
    generatedAt: new Date().toISOString(),
    project: path.basename(projectRoot),
    milestone: opts.milestone || null,
    characteristics: scorecard,
    overall: {
      score: overall,
      grade: grade(overall),
      totalFindings: findings.length,
    },
  };
}

function renderReport(data) {
  const lines = [];
  lines.push(`# ISO/IEC 25010:2023 Quality Scorecard`);
  lines.push('');
  lines.push(`Generated: ${data.generatedAt}`);
  lines.push(`Overall: **${data.overall.score}** (${data.overall.grade}) — ${data.overall.totalFindings} findings`);
  lines.push('');
  lines.push('| Characteristic | Score | Findings | Crit | High | Med | Low |');
  lines.push('|----|----|----|----|----|----|----|');
  for (const [_key, val] of Object.entries(data.characteristics)) {
    lines.push(
      `| ${val.label} | ${val.score} | ${val.findings} | ${val.critical} | ${val.high} | ${val.medium} | ${val.low} |`,
    );
  }
  return lines.join('\n');
}

function printUsage() {
  console.log(
    [
      'cobolt-iso25010 - ISO/IEC 25010:2023 quality-model scorecard.',
      '',
      'Usage:',
      '  node tools/cobolt-iso25010.js [check|report] [--milestone <id>] [--out <path>]',
      '',
      'No argument defaults to `check`. Use `--help` or `-h` to print this usage without side effects.',
    ].join('\n'),
  );
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
  const cmd = args[0] || 'check';
  const getOpt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const projectRoot = process.cwd();
  const data = build(projectRoot, { milestone: getOpt('--milestone') });
  const outDir = path.join(projectRoot, '_cobolt-output', 'standards');
  fs.mkdirSync(outDir, { recursive: true });
  const outJson = getOpt('--out') || path.join(outDir, 'iso25010-scorecard.json');
  fs.writeFileSync(outJson, JSON.stringify(data, null, 2));
  if (cmd === 'report') {
    const md = renderReport(data);
    const mdPath = outJson.replace(/\.json$/, '.md');
    fs.writeFileSync(mdPath, md);
    console.log(md);
  } else {
    console.log(
      `iso25010: overall=${data.overall.score} (${data.overall.grade})  findings=${data.overall.totalFindings}`,
    );
    console.log(`  written: ${outJson}`);
  }
}

if (require.main === module) main();
module.exports = { build, renderReport, CHARACTERISTICS };
