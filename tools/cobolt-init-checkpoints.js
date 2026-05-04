#!/usr/bin/env node

// CoBolt Init Checkpoints — CLI wrapper for lib/cobolt-init-checkpoints.js
//
// Usage:
//   node tools/cobolt-init-checkpoints.js has-partial              # exit 0 if partial init
//   node tools/cobolt-init-checkpoints.js resume-message           # print resume message
//   node tools/cobolt-init-checkpoints.js is-completed <stepId>    # exit 0 if done
//   node tools/cobolt-init-checkpoints.js mark-completed <stepId>
//   node tools/cobolt-init-checkpoints.js mark-skipped <stepId>
//   node tools/cobolt-init-checkpoints.js status [--json]
//   node tools/cobolt-init-checkpoints.js reset
// Optional:
//   --root <path>       Target project root instead of process.cwd()
//   --reason <text>     Reason recorded by mark-skipped
//
// Exists so skills never do `require('./lib/cobolt-init-checkpoints')` (CLAUDE.md invariant #14).

const {
  hasPartialInit,
  formatResumeMessage,
  isCompleted,
  markCompleted,
  markSkipped,
  getStatus,
  resetCheckpoints,
} = require('../lib/cobolt-init-checkpoints');

function parseCliArgs(argv) {
  const positional = [];
  const options = {
    root: process.cwd(),
    reason: undefined,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        console.error('--root requires a path');
        process.exit(2);
      }
      options.root = require('node:path').resolve(value);
      index += 1;
    } else if (arg === '--reason') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        console.error('--reason requires text');
        process.exit(2);
      }
      options.reason = value;
      index += 1;
    } else if (arg === '--json') {
      options.json = true;
    } else {
      positional.push(arg);
    }
  }

  return {
    cmd: positional[0],
    stepId: positional[1],
    options,
  };
}

const { cmd, stepId, options } = parseCliArgs(process.argv.slice(2));
const root = options.root;

try {
  switch (cmd) {
    case 'has-partial':
      process.exit(hasPartialInit(root) ? 0 : 1);
      break;
    case 'resume-message': {
      const msg = formatResumeMessage(root);
      if (msg) console.log(msg);
      break;
    }
    case 'is-completed':
      if (!stepId) {
        console.error('step id required');
        process.exit(2);
      }
      process.exit(isCompleted(stepId, root) ? 0 : 1);
      break;
    case 'mark-completed':
      if (!stepId) {
        console.error('step id required');
        process.exit(2);
      }
      markCompleted(stepId, root);
      break;
    case 'mark-skipped':
      if (!stepId) {
        console.error('step id required');
        process.exit(2);
      }
      markSkipped(stepId, options.reason, root);
      break;
    case 'status': {
      const s = getStatus(root);
      if (options.json) console.log(JSON.stringify(s, null, 2));
      else console.log(s);
      break;
    }
    case 'reset':
      resetCheckpoints(root);
      console.log('init checkpoints reset');
      break;
    default:
      console.error(
        'usage: cobolt-init-checkpoints.js <has-partial|resume-message|is-completed|mark-completed|mark-skipped|status|reset> [stepId] [--root <path>] [--reason <text>] [--json]',
      );
      process.exit(2);
  }
} catch (err) {
  console.error(`cobolt-init-checkpoints: ${err.message}`);
  process.exit(1);
}
