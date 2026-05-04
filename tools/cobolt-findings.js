#!/usr/bin/env node

// CoBolt Finding Tracker — lifecycle management for review/pentest/fix findings
//
// Usage:
//   node tools/cobolt-findings.js init                    # Initialize finding-tracker.json
//   node tools/cobolt-findings.js add <severity> <msg>    # Add a finding (critical|high|medium|low)
//   node tools/cobolt-findings.js list [--status open]    # List findings
//   node tools/cobolt-findings.js update <id> <status>    # Update finding status
//   node tools/cobolt-findings.js stats                   # Show finding statistics
//   node tools/cobolt-findings.js export                  # Export as markdown

const fs = require('node:fs');
const path = require('node:path');

const { atomicWriteJSON } = require('../lib/cobolt-atomic-write');

const { paths: _paths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();

function trackerPath() {
  const _p = typeof _paths === 'function' ? _paths() : null;
  if (_p) return _p.report('review', 'finding-tracker.json');
  return path.join(process.cwd(), '_cobolt-output/latest/review/finding-tracker.json');
}

function readTracker() {
  const fp = trackerPath();
  if (!fs.existsSync(fp)) return { findings: [], metadata: { created: new Date().toISOString(), lastUpdated: null } };
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function writeTracker(tracker) {
  const fp = trackerPath();
  tracker.metadata.lastUpdated = new Date().toISOString();
  try {
    atomicWriteJSON(fp, tracker);
  } catch (err) {
    console.error(`[cobolt-findings] Error writing tracker: ${err.message}`);
    throw err;
  }
}

function generateId(tracker) {
  const max = tracker.findings.reduce((m, f) => Math.max(m, parseInt(f.id.replace('F-', ''), 10) || 0), 0);
  return `F-${String(max + 1).padStart(4, '0')}`;
}

// ── Commands ─────────────────────────────────────────────────

function init() {
  const tracker = {
    findings: [],
    metadata: {
      created: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      totalAdded: 0,
      totalResolved: 0,
    },
  };
  writeTracker(tracker);
  console.log(`  Finding tracker initialized: ${trackerPath()}`);
}

function add(severity, message, source) {
  const validSeverities = ['critical', 'high', 'medium', 'low', 'info'];
  if (!validSeverities.includes(severity)) {
    console.error(`  Invalid severity: ${severity}. Use: ${validSeverities.join(', ')}`);
    process.exit(1);
  }
  const tracker = readTracker();
  const finding = {
    id: generateId(tracker),
    severity,
    message,
    source: source || 'manual',
    status: 'open',
    createdAt: new Date().toISOString(),
    updatedAt: null,
    fixedBy: null,
    verifiedAt: null,
  };
  tracker.findings.push(finding);
  tracker.metadata.totalAdded = (tracker.metadata.totalAdded || 0) + 1;
  writeTracker(tracker);
  console.log(`  Added finding ${finding.id}: [${severity}] ${message}`);
  return finding;
}

function list(filters = {}) {
  const tracker = readTracker();
  let results = tracker.findings;
  if (filters.status) results = results.filter((f) => f.status === filters.status);
  if (filters.severity) results = results.filter((f) => f.severity === filters.severity);
  if (filters.source) results = results.filter((f) => f.source === filters.source);
  return results;
}

function update(id, status, extra = {}) {
  const validStatuses = ['open', 'in-progress', 'fixed', 'verified', 'wont-fix', 'false-positive'];
  if (!validStatuses.includes(status)) {
    console.error(`  Invalid status: ${status}. Use: ${validStatuses.join(', ')}`);
    process.exit(1);
  }
  const tracker = readTracker();
  const finding = tracker.findings.find((f) => f.id === id);
  if (!finding) {
    console.error(`  Finding not found: ${id}`);
    process.exit(1);
  }
  finding.status = status;
  finding.updatedAt = new Date().toISOString();
  if (extra.fixedBy) finding.fixedBy = extra.fixedBy;
  if (status === 'verified') finding.verifiedAt = new Date().toISOString();
  if (status === 'fixed' || status === 'verified') {
    tracker.metadata.totalResolved = (tracker.metadata.totalResolved || 0) + 1;
  }
  writeTracker(tracker);
  console.log(`  Updated ${id}: status → ${status}`);
  return finding;
}

function stats() {
  const tracker = readTracker();
  const findings = tracker.findings;
  const byStatus = {};
  const bySeverity = {};
  for (const f of findings) {
    byStatus[f.status] = (byStatus[f.status] || 0) + 1;
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  }
  return {
    total: findings.length,
    byStatus,
    bySeverity,
    open: findings.filter((f) => f.status === 'open').length,
    resolved: findings.filter((f) => ['fixed', 'verified', 'wont-fix', 'false-positive'].includes(f.status)).length,
  };
}

function exportMarkdown() {
  const tracker = readTracker();
  const s = stats();
  const lines = [
    '# Finding Tracker Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Summary',
    '',
    `- **Total:** ${s.total}`,
    `- **Open:** ${s.open}`,
    `- **Resolved:** ${s.resolved}`,
    '',
    '## By Severity',
    '',
    ...Object.entries(s.bySeverity).map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## Findings',
    '',
    '| ID | Severity | Status | Message | Source |',
    '|---|---|---|---|---|',
  ];
  for (const f of tracker.findings) {
    lines.push(`| ${f.id} | ${f.severity} | ${f.status} | ${f.message} | ${f.source} |`);
  }
  lines.push('', '---', '', '*Made by CoBolt — Autonomous Development Platform*');
  return lines.join('\n');
}

// ── Module exports ───────────────────────────────────────────

module.exports = { init, add, list, update, stats, exportMarkdown, readTracker, writeTracker, trackerPath };

// ── CLI ──────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log('  Usage: node tools/cobolt-findings.js <command> [args]');
    console.log('  Commands: init, add, list, update, stats, export');
    process.exit(0);
  }

  switch (cmd) {
    case 'init':
      init();
      break;
    case 'add': {
      if (!args[1] || !args[2]) {
        console.error('  Usage: add <severity> <message> [source]');
        process.exit(1);
      }
      add(
        args[1],
        args.slice(2, -1).join(' ') || args[2],
        args[args.length - 1] !== args[2] ? args[args.length - 1] : undefined,
      );
      break;
    }
    case 'list': {
      const filters = {};
      for (let i = 1; i < args.length; i += 2) {
        if (args[i] === '--status') filters.status = args[i + 1];
        if (args[i] === '--severity') filters.severity = args[i + 1];
      }
      const results = list(filters);
      if (results.length === 0) {
        console.log('  No findings found.');
      }
      for (const f of results) {
        const icon = f.status === 'open' ? '\u2717' : f.status === 'verified' ? '\u2713' : '\u26A0';
        console.log(`  ${icon} ${f.id} [${f.severity}] ${f.status} — ${f.message}`);
      }
      break;
    }
    case 'update': {
      if (!args[1] || !args[2]) {
        console.error('  Usage: update <id> <status>');
        process.exit(1);
      }
      update(args[1], args[2]);
      break;
    }
    case 'stats': {
      const s = stats();
      console.log(JSON.stringify(s, null, 2));
      break;
    }
    case 'export': {
      console.log(exportMarkdown());
      break;
    }
    default:
      console.error(`  Unknown command: ${cmd}`);
      process.exit(1);
  }
}
