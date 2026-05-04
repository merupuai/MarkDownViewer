#!/usr/bin/env node

// CoBolt Agent Sandbox CLI (P4.1 / v0.66+).
//
// Wraps lib/cobolt-agent-sandbox.js with a CLI for inspecting and reporting
// on agent capability posture. Reports critical-risk agents that hold
// execute + network + agent-dispatch simultaneously (textbook OWASP LLM-06
// "Excessive Agency" pattern).
//
// CLI:
//   node tools/cobolt-agent-sandbox.js audit [--json]
//   node tools/cobolt-agent-sandbox.js classify <agent-name>
//   node tools/cobolt-agent-sandbox.js report [--out <path>]
//
// Exit codes per tools/CLAUDE.md:
//   0 — audit completed (advisory; recommendations in output)
//   1 — hard error
//   No exit 2 — pure-Node, no optional deps.

const fs = require('node:fs');
const path = require('node:path');
const sandbox = require('../lib/cobolt-agent-sandbox');

function _evLedger() {
  try {
    return require('../lib/cobolt-evidence-ledger');
  } catch {
    return null;
  }
}

function _appendEvidence({ cwd, summary }) {
  const evLedger = _evLedger();
  if (!evLedger) return null;
  try {
    return evLedger.append(
      {
        kind: evLedger.KINDS.CHECK_RESULT,
        producer: 'cobolt-agent-sandbox/v0.66.0',
        controlIds: ['NIST.SSDF.PO.5.2', 'OWASP.LLM.06', 'ISO.27001.A.8.2'],
        payload: { summary, ts: new Date().toISOString() },
      },
      { projectRoot: cwd || process.cwd() },
    );
  } catch {
    return null;
  }
}

function report({ cwd } = {}) {
  const root = cwd || process.cwd();
  const a = sandbox.audit({ cwd: root });
  const lines = [
    '# Agent Sandbox Audit',
    '',
    `Generated: ${a.generatedAt}`,
    `Agents: ${a.summary.total}`,
    '',
    '## By risk',
    '',
    `- Critical: **${a.summary.byRisk.critical}**`,
    `- High:     **${a.summary.byRisk.high}**`,
    `- Medium:   **${a.summary.byRisk.medium}**`,
    `- Low:      **${a.summary.byRisk.low}**`,
    '',
    '## Recommendations',
    '',
  ];
  if (a.recommendations.length === 0) {
    lines.push('_No recommendations — capability posture is within bounds._');
  } else {
    for (const r of a.recommendations.slice(0, 30)) {
      lines.push(`- **${r.agent}** (score ${r.score}): ${r.rec}`);
    }
    if (a.recommendations.length > 30) {
      lines.push(`- _… ${a.recommendations.length - 30} more recommendations …_`);
    }
  }
  lines.push('');
  lines.push('## Critical agents');
  lines.push('');
  const critical = a.agents.filter((g) => g.risk === 'critical').slice(0, 20);
  if (critical.length === 0) lines.push('_No critical-risk agents._');
  else {
    lines.push('| Agent | Mode | Score | Tools | Caps |');
    lines.push('|-------|------|-------|-------|------|');
    for (const g of critical) {
      const caps = Object.entries(g.capabilities)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(', ');
      lines.push(`| \`${g.name}\` | ${g.mode} | ${g.score} | ${g.tools.length} | ${caps} |`);
    }
  }
  lines.push('');
  lines.push(
    'Standards: NIST SP 800-204D §3.7; *Building Secure & Reliable Systems* §6; ISO 27001 A.8.2; OWASP LLM-06.',
  );
  lines.push('');
  lines.push('*Made by CoBolt — Autonomous Development Platform*');
  return lines.join('\n');
}

function writeReport({ cwd, outPath } = {}) {
  const root = cwd || process.cwd();
  const a = sandbox.audit({ cwd: root });
  const auditDir = path.join(root, '_cobolt-output', 'audit');
  fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  const json = path.join(auditDir, 'agent-sandbox.json');
  const md = outPath ? path.resolve(outPath) : path.join(auditDir, 'agent-sandbox.md');
  fs.writeFileSync(json, `${JSON.stringify(a, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(md, `${report({ cwd: root })}\n`, { encoding: 'utf8', mode: 0o600 });
  const ledgerEntryId = _appendEvidence({ cwd: root, summary: a.summary })?.entryId || null;
  return { json, md, audit: a, ledgerEntryId };
}

module.exports = {
  audit: sandbox.audit,
  classifyTool: sandbox.classifyTool,
  classifyAgent: sandbox.classifyAgent,
  _internal: sandbox._internal,
  report,
  writeReport,
};

// ── CLI ──────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log('Usage: node tools/cobolt-agent-sandbox.js <command> [args]');
    console.log('Commands:');
    console.log('  audit [--json]              Print audit summary');
    console.log('  classify <agent-name>       Classify a single agent by name');
    console.log('  report [--out <path>]       Write Markdown + JSON report to audit dir');
    process.exit(0);
  }
  try {
    if (cmd === 'audit') {
      const a = sandbox.audit({});
      if (argv.includes('--json')) {
        console.log(JSON.stringify(a, null, 2));
      } else {
        console.log(`[cobolt-agent-sandbox] Total agents: ${a.summary.total}`);
        console.log(`  critical: ${a.summary.byRisk.critical}`);
        console.log(`  high:     ${a.summary.byRisk.high}`);
        console.log(`  medium:   ${a.summary.byRisk.medium}`);
        console.log(`  low:      ${a.summary.byRisk.low}`);
        console.log(`  recommendations: ${a.recommendations.length}`);
      }
      process.exit(0);
    }
    if (cmd === 'classify') {
      const name = argv[1];
      if (!name) {
        console.error('Usage: classify <agent-name>');
        process.exit(1);
      }
      const a = sandbox.audit({});
      const found = a.agents.find((g) => g.name === name);
      if (!found) {
        console.error(`Agent not found: ${name}`);
        process.exit(1);
      }
      console.log(JSON.stringify(found, null, 2));
      process.exit(0);
    }
    if (cmd === 'report') {
      let outPath = null;
      for (let i = 1; i < argv.length; i += 1) {
        if (argv[i] === '--out') outPath = argv[++i];
      }
      const r = writeReport({ outPath });
      console.log(`[cobolt-agent-sandbox] JSON: ${r.json}`);
      console.log(`[cobolt-agent-sandbox] MD:   ${r.md}`);
      if (r.ledgerEntryId) console.log(`[cobolt-agent-sandbox] Ledger: ${r.ledgerEntryId}`);
      process.exit(0);
    }
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
  } catch (err) {
    console.error(`[cobolt-agent-sandbox] ${err.message}`);
    process.exit(1);
  }
}
