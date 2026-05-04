#!/usr/bin/env node

// CoBolt Agent Teams — CLI wrapper for lib/cobolt-teams.js
//
// Provides team dispatch detection and helpers to skill steps via $COBOLT_TOOLS.
// Skills invoke this tool instead of require('./lib/cobolt-teams') because
// lib/ is in the CoBolt installation directory, not the user's project.
//
// Usage:
//   node tools/cobolt-agent-teams.js check <stage>   — print dispatch mode ('team' or 'subagent')
//   node tools/cobolt-agent-teams.js available        — print 'true' or 'false'
//   node tools/cobolt-agent-teams.js format-ownership — read ownership JSON from stdin, print markdown table
//
// Exit codes: 0 always (errors fall back to 'subagent' / 'false')

const path = require('node:path');

// Resolve lib/ relative to this tool's location (tools/ is sibling to lib/)
const libDir = path.join(__dirname, '..', 'lib');
const {
  isTeamsAvailable,
  getTeamDispatchMode,
  formatFileOwnership,
  formatTeammateAssignment,
  FILE_WRITING_STAGES,
} = require(path.join(libDir, 'cobolt-teams'));

// ── Commands ────────────────────────────────────────────────

function cmdCheck(stage) {
  if (!stage) {
    console.error('Usage: cobolt-agent-teams.js check <stage>');
    console.error('Canonical stages: tdd-green, tdd-red-write, fix, refactor, review, validate');
    console.error('Team aliases (v0.21+): architect-team, design-team, planning-quality-team,');
    console.error('  implement-team, fix-team, hotfix-team, audit-team, review-team,');
    console.error('  gap-team, pr-team, resolve-team, uat-team, pentest-team,');
    console.error('  brownfield-team, reverse-eng-team (all resolve to team when enabled).');
    process.exit(1);
  }
  console.log(getTeamDispatchMode(stage));
}

function cmdAvailable() {
  console.log(isTeamsAvailable() ? 'true' : 'false');
}

function cmdFormatOwnership() {
  let data = '';
  process.stdin.on('data', (chunk) => {
    data += chunk;
  });
  process.stdin.on('end', () => {
    try {
      const ownership = JSON.parse(data);
      const table = formatFileOwnership(ownership);
      console.log(table);
    } catch (e) {
      console.error(`Error parsing ownership JSON: ${e.message}`);
      process.exit(1);
    }
  });
}

function cmdFormatAssignment() {
  let data = '';
  process.stdin.on('data', (chunk) => {
    data += chunk;
  });
  process.stdin.on('end', () => {
    try {
      const opts = JSON.parse(data);
      console.log(formatTeammateAssignment(opts));
    } catch (e) {
      console.error(`Error parsing assignment JSON: ${e.message}`);
      process.exit(1);
    }
  });
}

function cmdHelp() {
  console.log('CoBolt Agent Teams — dispatch mode detection and formatting');
  console.log('');
  console.log('Usage:');
  console.log('  cobolt-agent-teams.js check <stage>        Print dispatch mode (team|subagent)');
  console.log('  cobolt-agent-teams.js available             Print team availability (true|false)');
  console.log('  cobolt-agent-teams.js format-ownership      Read ownership JSON from stdin, print table');
  console.log('  cobolt-agent-teams.js format-assignment      Read assignment JSON from stdin, print block');
  console.log('');
  console.log('File-writing stages (team-eligible):');
  console.log(`  ${[...FILE_WRITING_STAGES].join(', ')}`);
  console.log('');
  console.log('Environment:');
  console.log('  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1  Enable agent team dispatch');
}

// ── Programmatic API ────────────────────────────────────────

module.exports = {
  isTeamsAvailable,
  getTeamDispatchMode,
  formatFileOwnership,
  formatTeammateAssignment,
  FILE_WRITING_STAGES,
};

// ── CLI ─────────────────────────────────────────────────────

if (require.main === module) {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case 'check':
      cmdCheck(args[0]);
      break;
    case 'available':
      cmdAvailable();
      break;
    case 'format-ownership':
      cmdFormatOwnership();
      break;
    case 'format-assignment':
      cmdFormatAssignment();
      break;
    case '--help':
    case 'help':
      cmdHelp();
      break;
    default:
      cmdHelp();
      process.exit(cmd ? 1 : 0);
  }
}
