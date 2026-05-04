#!/usr/bin/env node

// CoBolt Auto State - explicit autonomous loop transition ledger.

const fs = require('node:fs');
const path = require('node:path');

const STATES = [
  'idle',
  'preflight',
  'build-gates',
  'branch-ready',
  'build-steps',
  'post-milestone-git',
  'milestone-complete',
  'final-review',
  'final-pentest',
  'final-fix',
  'final-audit',
  'final-validate',
  'complete',
  'paused',
  'failed',
];

const ALLOWED_TRANSITIONS = {
  idle: ['preflight', 'build-gates', 'paused', 'failed'],
  preflight: ['build-gates', 'paused', 'failed'],
  'build-gates': ['branch-ready', 'build-steps', 'paused', 'failed'],
  'branch-ready': ['build-steps', 'paused', 'failed'],
  'build-steps': ['post-milestone-git', 'paused', 'failed'],
  'post-milestone-git': ['milestone-complete', 'paused', 'failed'],
  'milestone-complete': ['build-gates', 'final-review', 'complete', 'paused', 'failed'],
  'final-review': ['final-pentest', 'final-fix', 'paused', 'failed'],
  'final-pentest': ['final-fix', 'paused', 'failed'],
  'final-fix': ['final-audit', 'final-validate', 'paused', 'failed'],
  'final-audit': ['final-validate', 'paused', 'failed'],
  'final-validate': ['complete', 'paused', 'failed'],
  complete: [],
  paused: ['preflight', 'build-gates', 'build-steps', 'failed'],
  failed: ['preflight', 'build-gates', 'build-steps'],
};

function stateDir(projectRoot = process.cwd()) {
  return path.join(projectRoot, '_cobolt-output', 'latest', 'build');
}

function stateFile(projectRoot = process.cwd()) {
  return path.join(stateDir(projectRoot), 'auto-state.json');
}

function ledgerFile(projectRoot = process.cwd()) {
  return path.join(stateDir(projectRoot), 'auto-state.jsonl');
}

function readAutoState(projectRoot = process.cwd()) {
  const filePath = stateFile(projectRoot);
  if (!fs.existsSync(filePath)) {
    return { current: 'idle', transitions: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { current: 'idle', transitions: [], corrupted: true };
  }
}

function validateTransition(from, to) {
  return STATES.includes(to) && (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

function recordTransition(projectRoot = process.cwd(), transition = {}) {
  const current = readAutoState(projectRoot);
  const from = transition.from || current.current || 'idle';
  const to = transition.to;
  if (!to || !STATES.includes(to)) throw new Error(`Unknown auto state: ${to}`);
  if (!validateTransition(from, to) && !transition.force) {
    throw new Error(`Invalid auto-state transition: ${from} -> ${to}`);
  }

  const entry = {
    at: new Date().toISOString(),
    from,
    to,
    event: transition.event || 'transition',
    milestone: transition.milestone || null,
    metadata: transition.metadata || {},
  };
  const next = {
    current: to,
    updatedAt: entry.at,
    milestone: entry.milestone,
    transitions: [...(current.transitions || []), entry].slice(-100),
  };

  fs.mkdirSync(stateDir(projectRoot), { recursive: true });
  fs.writeFileSync(stateFile(projectRoot), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.appendFileSync(ledgerFile(projectRoot), `${JSON.stringify(entry)}\n`, 'utf8');
  return next;
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'status';
  const json = argv.includes('--json');
  if (command === 'status') {
    const state = readAutoState(process.cwd());
    if (json) console.log(JSON.stringify(state, null, 2));
    else console.log(`[cobolt-auto-state] ${state.current}`);
    return;
  }
  if (command === 'transition') {
    const toIndex = argv.indexOf('--to');
    const milestoneIndex = argv.indexOf('--milestone');
    const eventIndex = argv.indexOf('--event');
    const state = recordTransition(process.cwd(), {
      to: toIndex !== -1 ? argv[toIndex + 1] : null,
      milestone: milestoneIndex !== -1 ? argv[milestoneIndex + 1] : null,
      event: eventIndex !== -1 ? argv[eventIndex + 1] : 'cli',
      force: argv.includes('--force'),
    });
    if (json) console.log(JSON.stringify(state, null, 2));
    else console.log(`[cobolt-auto-state] ${state.current}`);
    return;
  }
  console.error('Usage: node tools/cobolt-auto-state.js status|transition --to <state> [--milestone M1] [--json]');
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  ALLOWED_TRANSITIONS,
  STATES,
  readAutoState,
  recordTransition,
  validateTransition,
};
