#!/usr/bin/env node

// CoBolt App-Boot Check — v0.39.0.
//
// Executes a language-appropriate boot smoke and writes:
//   _cobolt-output/latest/build/{M}/{M}-app-boot-proof.json
//
// Paired with source/hooks/cobolt-app-boot-gate.js which consumes the proof.
//
// Language detection order (first match wins):
//   elixir : mix compile --warnings-as-errors
//   node   : npx tsc --noEmit (if TS) OR node --check on a discovered entry
//   rust   : cargo check
//   go     : go build ./...
//   java   : mvn -q compile  OR  gradle compileJava
//   python : python -m compileall -q src
//
// Non-interactive. 5-minute timeout. Writes a crash-dump-scan result too —
// even if compile passes, if a recent erl_crash.dump / core dump exists, the
// proof is downgraded to failing.
//
// Usage:
//   node tools/cobolt-app-boot-check.js run --milestone M1
//   node tools/cobolt-app-boot-check.js verify --milestone M1   # read-only check of existing proof
//
// Exit codes:
//   0  boot proof produced (exitCode=0, no crash dump)
//   1  internal error
//   2  no runtime detected (project not runnable)
//   4  boot failed (compile error, crash dump, or timeout)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const BOOT_TIMEOUT_MS = 5 * 60 * 1000;

const CRASH_PATTERNS = [/^erl_crash\.dump$/, /^core(?:\.\d+)?$/, /^hs_err_pid\d+\.log$/];
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '_build',
  'deps',
  'target',
  'dist',
  '.cobolt-backups',
  '_cobolt-output',
]);

function hashBuf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

function detectRuntime(root) {
  if (fs.existsSync(path.join(root, 'mix.exs'))) return 'elixir';
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) return 'rust';
  if (fs.existsSync(path.join(root, 'go.mod'))) return 'go';
  if (fs.existsSync(path.join(root, 'pom.xml'))) return 'java-maven';
  if (fs.existsSync(path.join(root, 'build.gradle')) || fs.existsSync(path.join(root, 'build.gradle.kts')))
    return 'java-gradle';
  if (fs.existsSync(path.join(root, 'package.json'))) return 'node';
  if (fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'requirements.txt')))
    return 'python';
  return null;
}

function bootCommand(runtime) {
  switch (runtime) {
    case 'elixir':
      return { cmd: 'mix', args: ['compile', '--warnings-as-errors'] };
    case 'rust':
      return { cmd: 'cargo', args: ['check', '--quiet'] };
    case 'go':
      return { cmd: 'go', args: ['build', './...'] };
    case 'java-maven':
      return { cmd: 'mvn', args: ['-q', 'compile', '-DskipTests'] };
    case 'java-gradle':
      return { cmd: 'gradle', args: ['-q', 'compileJava'] };
    case 'node':
      return { cmd: 'npx', args: ['--yes', '--no-install', 'tsc', '--noEmit'] }; // gracefully no-ops if not TS
    case 'python':
      return { cmd: 'python', args: ['-m', 'compileall', '-q', '.'] };
    default:
      return null;
  }
}

function findRecentCrash(root, maxDepth = 4, maxAgeDays = 7) {
  const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;
  function walk(dir, depth) {
    if (depth > maxDepth) return null;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const ent of entries) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        const r = walk(full, depth + 1);
        if (r) return r;
        continue;
      }
      if (CRASH_PATTERNS.some((re) => re.test(ent.name))) {
        try {
          const s = fs.statSync(full);
          if (s.mtimeMs >= cutoff) return full;
        } catch {
          /* ignore */
        }
      }
    }
    return null;
  }
  return walk(root, 0);
}

function runBoot(runtime) {
  const spec = bootCommand(runtime);
  if (!spec) return { exitCode: 2, stdout: '', stderr: `no boot command for runtime=${runtime}` };
  const started = Date.now();
  try {
    const out = execFileSync(spec.cmd, spec.args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: BOOT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 50 * 1024 * 1024,
    });
    return { exitCode: 0, stdout: String(out || ''), stderr: '', bootDurationMs: Date.now() - started };
  } catch (e) {
    return {
      exitCode: typeof e.status === 'number' ? e.status : 1,
      stdout: String(e.stdout || ''),
      stderr: String(e.stderr || e.message || ''),
      bootDurationMs: Date.now() - started,
      timedOut: e.signal === 'SIGTERM' || /etimedout/i.test(String(e.message || '')),
    };
  }
}

function proofPathFor(milestone) {
  return path.join(process.cwd(), '_cobolt-output', 'latest', 'build', milestone, `${milestone}-app-boot-proof.json`);
}

function writeProof(milestone, runtime, cmdSpec, result, crashDump) {
  const proof = {
    milestone,
    capturedAt: new Date().toISOString(),
    runtime,
    command: `${cmdSpec.cmd} ${cmdSpec.args.join(' ')}`,
    exitCode: result.exitCode,
    stdoutHash: hashBuf(result.stdout || ''),
    stderrHash: hashBuf(result.stderr || ''),
    stdoutBytes: Buffer.byteLength(result.stdout || ''),
    stderrBytes: Buffer.byteLength(result.stderr || ''),
    bootDurationMs: result.bootDurationMs || null,
    timedOut: result.timedOut === true,
    crashDumpFound: Boolean(crashDump),
    crashDumpPath: crashDump || null,
    tool: 'cobolt-app-boot-check',
    version: '0.39.0',
  };
  const p = proofPathFor(milestone);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(proof, null, 2));
  return { proof, proofPath: p };
}

function runCmd(opts) {
  if (!opts.milestone) {
    console.error('--milestone is required');
    return 1;
  }
  const root = process.cwd();
  const runtime = detectRuntime(root);
  if (!runtime) {
    console.log('no runtime detected (no mix.exs/package.json/Cargo.toml/go.mod/pom.xml/pyproject.toml)');
    return 2;
  }
  const cmdSpec = bootCommand(runtime);
  const crashBefore = findRecentCrash(root);
  const result = runBoot(runtime);
  const crashAfter = findRecentCrash(root);
  const crashDump = crashAfter || crashBefore;
  const { proof, proofPath } = writeProof(opts.milestone, runtime, cmdSpec, result, crashDump);

  if (opts.json) process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
  else {
    console.log(
      `app-boot-check: runtime=${runtime} exit=${proof.exitCode} crash=${proof.crashDumpFound ? 'yes' : 'no'}`,
    );
    console.log(`proof: ${proofPath}`);
    if (proof.exitCode !== 0 && result.stderr) {
      const tail = result.stderr.trim().split('\n').slice(-12).join('\n');
      console.log('--- stderr tail ---');
      console.log(tail);
    }
  }
  if (proof.exitCode !== 0 || proof.crashDumpFound) return 4;
  return 0;
}

function verifyCmd(opts) {
  if (!opts.milestone) {
    console.error('--milestone is required');
    return 1;
  }
  const p = proofPathFor(opts.milestone);
  if (!fs.existsSync(p)) {
    console.log(`no proof at ${p}`);
    return 4;
  }
  let proof;
  try {
    proof = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`cannot read proof: ${e.message}`);
    return 1;
  }
  if (opts.json) process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
  else {
    console.log(`proof found: ${p}`);
    console.log(
      `  runtime=${proof.runtime} exit=${proof.exitCode} crashDump=${proof.crashDumpFound} at=${proof.capturedAt}`,
    );
  }
  return proof.exitCode === 0 && !proof.crashDumpFound ? 0 : 4;
}

function main(argv) {
  const cmd = argv[2] || 'run';
  const opts = {};
  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === '--milestone') opts.milestone = argv[++i];
    else if (argv[i] === '--json') opts.json = true;
  }
  if (cmd === 'run') return runCmd(opts);
  if (cmd === 'verify') return verifyCmd(opts);
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log('usage: cobolt-app-boot-check <run|verify> --milestone M{n} [--json]');
    return 0;
  }
  console.error(`unknown command: ${cmd}`);
  return 1;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = {
  detectRuntime,
  bootCommand,
  findRecentCrash,
  runBoot,
  writeProof,
  proofPathFor,
};
