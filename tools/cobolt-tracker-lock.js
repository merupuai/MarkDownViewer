#!/usr/bin/env node
//
// CoBolt tracker-lock CLI — exclusive lock for finding-tracker.json mutations.
//
// Issue 2 (v0.40.5): parallel fix agents were corrupting finding-tracker.json
// via last-writer-wins. This CLI wraps any mutation with the shared lock
// primitive in lib/cobolt-tracker-lock.js.
//
// Commands:
//   node tools/cobolt-tracker-lock.js with <tracker-path> -- <cmd...>
//       Acquire lock, run <cmd>, release lock on exit (success or failure).
//       Exit code propagates from <cmd>.
//
//   node tools/cobolt-tracker-lock.js status <tracker-path>
//       Print lock state as JSON ({ held, holder?, ageMs? }).
//
//   node tools/cobolt-tracker-lock.js sweep-stale <tracker-path> [--stale-ms N]
//       Reclaim the lock if stale (default 30s). Useful for release preflight.
//
// Env:
//   COBOLT_TRACKER_LOCK=off    Bypass locking entirely (not recommended).
//
// Exit codes (per tools/CLAUDE.md):
//   0 success, 1 hard error, 2 missing dep (never), 3 missing infra (never).

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const {
  acquireLock,
  lockPathFor,
  _internal: { isStale, reclaimStale },
} = require('../lib/cobolt-tracker-lock');

function printUsage() {
  process.stdout.write(
    [
      'Usage: cobolt-tracker-lock <command> [options]',
      '',
      'Commands:',
      '  with <tracker-path> -- <cmd...>   Run <cmd> while holding the lock',
      '  status <tracker-path>             Print lock state as JSON',
      '  sweep-stale <tracker-path>        Reclaim a stale lock',
      '',
      'Env:',
      '  COBOLT_TRACKER_LOCK=off           Bypass locking (not recommended)',
      '',
    ].join('\n'),
  );
}

function cmdWith(args) {
  const sepIdx = args.indexOf('--');
  if (sepIdx < 1) {
    process.stderr.write('tracker-lock: "with" requires <tracker> -- <cmd...>\n');
    process.exit(1);
  }
  const trackerPath = args[0];
  const cmdArgs = args.slice(sepIdx + 1);
  if (cmdArgs.length === 0) {
    process.stderr.write('tracker-lock: "with" requires a command after --\n');
    process.exit(1);
  }
  const staleFlag = args.find((a) => a.startsWith('--stale-ms='));
  const timeoutFlag = args.find((a) => a.startsWith('--timeout-ms='));
  const opts = {};
  if (staleFlag) opts.staleMs = Number.parseInt(staleFlag.split('=')[1], 10);
  if (timeoutFlag) opts.timeoutMs = Number.parseInt(timeoutFlag.split('=')[1], 10);

  const lock = acquireLock(trackerPath, opts);
  let exitCode = 0;
  try {
    const [bin, ...rest] = cmdArgs;
    const result = spawnSync(bin, rest, {
      stdio: 'inherit',
      env: { ...process.env, COBOLT_TRACKER_LOCK_HELD: lock.bypassed ? '0' : '1' },
    });
    if (result.error) {
      process.stderr.write(`tracker-lock: child failed: ${result.error.message}\n`);
      exitCode = 1;
    } else if (typeof result.status === 'number') {
      exitCode = result.status;
    } else if (result.signal) {
      process.stderr.write(`tracker-lock: child terminated by signal ${result.signal}\n`);
      exitCode = 1;
    }
  } finally {
    lock.release();
  }
  process.exit(exitCode);
}

function cmdStatus(args) {
  const trackerPath = args[0];
  if (!trackerPath) {
    process.stderr.write('tracker-lock: "status" requires <tracker-path>\n');
    process.exit(1);
  }
  const lockPath = lockPathFor(trackerPath);
  if (!fs.existsSync(lockPath)) {
    process.stdout.write(`${JSON.stringify({ held: false, lockPath })}\n`);
    process.exit(0);
  }
  const st = fs.statSync(lockPath);
  let holder = null;
  try {
    holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    /* ignore — malformed holder, still reports held=true */
  }
  process.stdout.write(
    `${JSON.stringify({
      held: true,
      lockPath,
      ageMs: Date.now() - st.mtimeMs,
      holder,
    })}\n`,
  );
  process.exit(0);
}

function cmdSweepStale(args) {
  const trackerPath = args[0];
  if (!trackerPath) {
    process.stderr.write('tracker-lock: "sweep-stale" requires <tracker-path>\n');
    process.exit(1);
  }
  const staleFlag = args.find((a) => a.startsWith('--stale-ms='));
  const staleMs = staleFlag ? Number.parseInt(staleFlag.split('=')[1], 10) : 30_000;
  const lockPath = lockPathFor(trackerPath);
  if (!fs.existsSync(lockPath)) {
    process.stdout.write(`${JSON.stringify({ swept: false, reason: 'absent', lockPath })}\n`);
    process.exit(0);
  }
  if (isStale(lockPath, staleMs)) {
    const ok = reclaimStale(lockPath);
    process.stdout.write(`${JSON.stringify({ swept: ok, lockPath, staleMs })}\n`);
    process.exit(ok ? 0 : 1);
  }
  process.stdout.write(`${JSON.stringify({ swept: false, reason: 'active', lockPath })}\n`);
  process.exit(0);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printUsage();
    process.exit(0);
  }
  const cmd = argv[0];
  const rest = argv.slice(1);
  if (cmd === 'with') return cmdWith(rest);
  if (cmd === 'status') return cmdStatus(rest);
  if (cmd === 'sweep-stale') return cmdSweepStale(rest);
  process.stderr.write(`tracker-lock: unknown command "${cmd}"\n`);
  printUsage();
  process.exit(1);
}

if (require.main === module) main();

module.exports = { _internal: { cmdWith, cmdStatus, cmdSweepStale } };
