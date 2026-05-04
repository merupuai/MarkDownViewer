#!/usr/bin/env node

// CoBolt Milestone Cost Report - actionable token/cost summary per milestone.

const fs = require('node:fs');
const path = require('node:path');

function readJsonl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
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

function collectCostEntries(projectRoot = process.cwd()) {
  const candidates = [
    path.join(projectRoot, '_cobolt-output', 'latest', 'costs', 'cost-ledger.jsonl'),
    path.join(projectRoot, '_cobolt-output', 'audit', 'cost-ledger.jsonl'),
    path.join(projectRoot, '_cobolt-output', 'project-costs.jsonl'),
  ];
  return candidates.flatMap((candidate) => readJsonl(candidate));
}

function tokenTotal(entry) {
  return (
    Number(entry.tokens || 0) +
    Number(entry.input_tokens || 0) +
    Number(entry.output_tokens || 0) +
    Number(entry.cache_read_tokens || 0) +
    Number(entry.cache_write_tokens || 0)
  );
}

function addBucket(map, key, entry) {
  const bucket = map[key] || { invocations: 0, tokens: 0, input: 0, output: 0, cost: 0 };
  bucket.invocations += 1;
  bucket.tokens += tokenTotal(entry);
  bucket.input += Number(entry.input_tokens || entry.input || 0);
  bucket.output += Number(entry.output_tokens || entry.output || 0);
  bucket.cost += Number(entry.cost_usd || entry.cost || 0);
  map[key] = bucket;
}

function analyzeWaste(entries) {
  const recommendations = [];
  const totalTokens = entries.reduce((sum, entry) => sum + tokenTotal(entry), 0);
  const byStage = {};
  const byAgent = {};
  for (const entry of entries) {
    addBucket(byStage, String(entry.stage || 'unknown').toLowerCase(), entry);
    addBucket(byAgent, String(entry.agent || entry.tool || 'unknown').toLowerCase(), entry);
  }

  const planningTokens = byStage.planning?.tokens || 0;
  if (planningTokens > 150000 || planningTokens / Math.max(totalTokens, 1) > 0.35) {
    recommendations.push('Planning consumed a large token share; use context packets and avoid full PRD fan-out.');
  }

  for (const [agent, bucket] of Object.entries(byAgent)) {
    if (bucket.invocations >= 4 && bucket.tokens > 50000) {
      recommendations.push(
        `${agent} ran ${bucket.invocations} times; check for repeated dispatch or stalled fix loops.`,
      );
    }
  }

  const largeInvocations = entries.filter((entry) => Number(entry.input_tokens || 0) > 40000);
  if (largeInvocations.length > 0) {
    recommendations.push(
      `${largeInvocations.length} invocation(s) had >40K input tokens; route through compact context packets.`,
    );
  }

  return recommendations.length > 0 ? recommendations : ['No obvious token waste pattern detected from the ledger.'];
}

function buildMilestoneCostReport(projectRoot = process.cwd(), milestone = null) {
  const entries = collectCostEntries(projectRoot).filter((entry) => !milestone || entry.milestone === milestone);
  const byStage = {};
  const byAgent = {};
  let totalCost = 0;
  let totalTokens = 0;
  for (const entry of entries) {
    addBucket(byStage, String(entry.stage || 'unknown').toLowerCase(), entry);
    addBucket(byAgent, String(entry.agent || entry.tool || 'unknown').toLowerCase(), entry);
    totalCost += Number(entry.cost_usd || entry.cost || 0);
    totalTokens += tokenTotal(entry);
  }

  return {
    milestone,
    generatedAt: new Date().toISOString(),
    passed: true,
    summary: {
      invocations: entries.length,
      totalTokens,
      totalCostUsd: Math.round(totalCost * 10000) / 10000,
    },
    byStage,
    byAgent,
    recommendations: analyzeWaste(entries),
  };
}

function formatMarkdown(report) {
  const lines = [`# Milestone Cost Report${report.milestone ? ` - ${report.milestone}` : ''}`, ''];
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push('## Summary');
  lines.push(`- Invocations: ${report.summary.invocations}`);
  lines.push(`- Total tokens: ${report.summary.totalTokens}`);
  lines.push(`- Estimated cost USD: ${report.summary.totalCostUsd}`);
  lines.push('');
  lines.push('## By Stage');
  lines.push('| Stage | Invocations | Tokens | Cost USD |');
  lines.push('|---|---:|---:|---:|');
  for (const [stage, bucket] of Object.entries(report.byStage)) {
    lines.push(`| ${stage} | ${bucket.invocations} | ${bucket.tokens} | ${bucket.cost.toFixed(4)} |`);
  }
  lines.push('');
  lines.push('## Recommendations');
  for (const recommendation of report.recommendations) {
    lines.push(`- ${recommendation}`);
  }
  lines.push('');
  return lines.join('\n');
}

function writeMilestoneCostReport(projectRoot = process.cwd(), milestone = 'M1') {
  const report = buildMilestoneCostReport(projectRoot, milestone);
  const reportDir = path.join(projectRoot, '_cobolt-output', 'reports', milestone);
  fs.mkdirSync(reportDir, { recursive: true });
  const jsonPath = path.join(reportDir, 'milestone-cost-report.json');
  const mdPath = path.join(reportDir, 'milestone-cost-report.md');
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, formatMarkdown(report), 'utf8');
  return { ...report, jsonPath, mdPath };
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'report';
  const json = argv.includes('--json');
  const milestoneIndex = argv.indexOf('--milestone');
  const milestone = milestoneIndex !== -1 ? argv[milestoneIndex + 1] : argv[1] || 'M1';

  if (command !== 'report') {
    console.error('Usage: node tools/cobolt-milestone-cost-report.js report --milestone M1 [--json]');
    process.exit(2);
  }

  const report = writeMilestoneCostReport(process.cwd(), milestone);
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(`[cobolt-milestone-cost-report] Wrote ${report.mdPath}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  analyzeWaste,
  buildMilestoneCostReport,
  collectCostEntries,
  formatMarkdown,
  writeMilestoneCostReport,
};
