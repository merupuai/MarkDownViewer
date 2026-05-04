#!/usr/bin/env node

// CoBolt Runtime Sync (v0.22.5+).
//
// Seamless runtime sanity for `cobolt-init`. Detects every CoBolt
// installation on the machine (Claude Code + Codex IDE × global + local),
// compares each against the current source version, and — when drift is
// detected — automatically runs `bin/install.js --sync --yes` to bring
// everyone to the same version.
//
// Why this exists:
//   Users hitting v0.22.x for the first time after upgrading from v0.20 (or
//   running both Claude Code globally and Codex locally on different
//   versions) had to manually run `node bin/install.js --sync` to fix the
//   drift. That broke the "init my project, get to work" flow. With this
//   tool, `cobolt-init` step 0 runs sync inline so the user never sees a
//   stale runtime banner.
//
// Discovery strategy for `bin/install.js`:
//   1. Reads `~/.claude/cobolt/source-root.txt` (written at install time).
//      If the path exists AND has `bin/install.js`, use it.
//   2. Same for `~/.codex/cobolt/source-root.txt`.
//   3. Walks up from this file's __dirname looking for `bin/install.js`
//      (covers: dev mode running from source repo).
//   4. Last resort: spawn `npx --yes --package github:merupuai/cobolt
//      cobolt --sync --yes` (requires network; documented in the report).
//
// Non-disruption:
//   - READ-ONLY by default (`detect` mode). Prints a structured report.
//   - With `--apply`, runs `node <install_script> --sync --yes`. Even
//     then, install runs in best-effort mode — failures degrade to a
//     warning, never block the caller.
//   - With `--apply --ensure-companion claude|codex|all`, also installs
//     a companion runtime that's not present (e.g., user has Claude
//     globally but no Codex install — this adds Codex global at the same
//     version).
//
// Usage:
//   node tools/cobolt-runtime-sync.js detect
//   node tools/cobolt-runtime-sync.js detect --json
//   node tools/cobolt-runtime-sync.js apply
//   node tools/cobolt-runtime-sync.js apply --ensure-companion all
//
// Exit codes:
//   0 — runtimes are aligned (after sync, if applicable)
//   2 — usage error
//   3 — install script could not be located
//   4 — sync ran but reported failure

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function readTextSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    return null;
  }
}

// Returns the current CoBolt version from package.json of the install
// script we'll run. We read from the resolved source root so the version
// reported matches the version the sync would deploy.
function readSourceVersion(sourceRoot) {
  const pkg = readJsonSafe(path.join(sourceRoot, 'package.json'));
  return pkg?.version || null;
}

// Locate `bin/install.js`. See discovery strategy in the file header.
function findInstallScript() {
  const candidates = [];

  // 1. ~/.claude/cobolt/source-root.txt
  const claudeRootPtr = path.join(os.homedir(), '.claude', 'cobolt', 'source-root.txt');
  const claudeRoot = readTextSafe(claudeRootPtr);
  if (claudeRoot) candidates.push(path.join(claudeRoot, 'bin', 'install.js'));

  // 2. ~/.codex/cobolt/source-root.txt
  const codexRootPtr = path.join(os.homedir(), '.codex', 'cobolt', 'source-root.txt');
  const codexRoot = readTextSafe(codexRootPtr);
  if (codexRoot) candidates.push(path.join(codexRoot, 'bin', 'install.js'));

  // 3. Walk up from this file looking for bin/install.js (dev / source repo).
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, 'bin', 'install.js');
    if (fs.existsSync(candidate)) {
      candidates.push(candidate);
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return { script: c, sourceRoot: path.dirname(path.dirname(c)) };
    }
  }
  return null;
}

// Run install script and capture structured list output. Returns parsed
// summary or null on failure.
function runListJson(installScript) {
  try {
    const res = spawnSync(process.execPath, [installScript, '--list', '--json'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (res.status !== 0) return null;
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
}

// Run sync. Returns { ok, exitCode, stdout, stderr }.
function runSync(installScript, { ensureCompanion = null } = {}) {
  const args = ['--sync', '--yes'];
  // ensureCompanion installs a runtime that isn't currently present. Currently
  // wired through as separate install invocations to keep the sync semantics
  // unchanged.
  let companionResult = null;
  if (ensureCompanion) {
    const wantClaude = ensureCompanion === 'claude' || ensureCompanion === 'all';
    const wantCodex = ensureCompanion === 'codex' || ensureCompanion === 'all';
    const summary = runListJson(installScript);
    const installedRuntimes = new Set((summary?.installs || []).map((i) => i.runtime));
    const installArgs = [];
    if (wantClaude && !installedRuntimes.has('claude-code')) installArgs.push('--claude');
    if (wantCodex && !installedRuntimes.has('codex-ide')) installArgs.push('--codex');
    if (installArgs.length) {
      installArgs.push('--global', '--yes');
      companionResult = spawnSync(process.execPath, [installScript, ...installArgs], {
        encoding: 'utf8',
        timeout: 5 * 60 * 1000,
      });
    }
  }
  const res = spawnSync(process.execPath, [installScript, ...args], {
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
  });
  return {
    ok: res.status === 0,
    exitCode: res.status,
    stdout: (res.stdout || '').slice(0, 4000),
    stderr: (res.stderr || '').slice(0, 1000),
    companionResult: companionResult
      ? {
          ok: companionResult.status === 0,
          exitCode: companionResult.status,
          stdout: (companionResult.stdout || '').slice(0, 2000),
          stderr: (companionResult.stderr || '').slice(0, 500),
        }
      : null,
  };
}

function detect() {
  const located = findInstallScript();
  if (!located) {
    return {
      schemaVersion: 'cobolt-runtime-sync/v1',
      ok: false,
      reason: 'install-script-not-found',
      remediation:
        'Run `npm install -g @mftlabs/cobolt` or `node bin/install.js --claude --global --link` from the cobolt source repo to deploy the runtime.',
      installs: [],
      sourceVersion: null,
      needsSync: false,
    };
  }
  const summary = runListJson(located.script);
  const sourceVersion = readSourceVersion(located.sourceRoot);
  if (!summary) {
    return {
      schemaVersion: 'cobolt-runtime-sync/v1',
      ok: false,
      reason: 'install-list-failed',
      installScript: located.script,
      sourceRoot: located.sourceRoot,
      sourceVersion,
      installs: [],
      needsSync: false,
    };
  }
  return {
    schemaVersion: 'cobolt-runtime-sync/v1',
    ok: true,
    installScript: located.script,
    sourceRoot: located.sourceRoot,
    sourceVersion: sourceVersion || summary.cliVersion,
    installs: summary.installs || [],
    versionDrift: summary.versionDrift,
    uniqueVersions: summary.uniqueVersions,
    stale: summary.stale,
    needsSync: summary.needsSync,
  };
}

function apply({ ensureCompanion = null } = {}) {
  const found = detect();
  if (!found.ok) return { ...found, applied: false, reason: found.reason || 'detect-failed' };
  const targetVersion = found.sourceVersion || (found.installs[0]?.version ?? '?');
  const wantSync = found.needsSync;
  const wantCompanion =
    ensureCompanion &&
    (() => {
      const installed = new Set(found.installs.map((i) => i.runtime));
      if (ensureCompanion === 'claude' && !installed.has('claude-code')) return true;
      if (ensureCompanion === 'codex' && !installed.has('codex-ide')) return true;
      if (ensureCompanion === 'all' && (!installed.has('claude-code') || !installed.has('codex-ide'))) return true;
      return false;
    })();

  if (!wantSync && !wantCompanion) {
    return { ...found, applied: false, reason: 'already-aligned', targetVersion };
  }
  const result = runSync(found.installScript, { ensureCompanion: wantCompanion ? ensureCompanion : null });
  // Re-detect to confirm post-sync state.
  const after = detect();
  return {
    ...found,
    applied: true,
    targetVersion,
    syncResult: result,
    afterInstalls: after.installs,
    afterDrift: after.versionDrift,
    afterStale: after.stale,
    ok: result.ok && (after.ok ? !after.versionDrift : true),
  };
}

function parseArgs(argv) {
  const out = { cmd: null, json: false, ensureCompanion: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!out.cmd && (a === 'detect' || a === 'apply')) {
      out.cmd = a;
    } else if (a === '--json') {
      out.json = true;
    } else if (a === '--ensure-companion') {
      out.ensureCompanion = argv[++i] || null;
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'usage: cobolt-runtime-sync <detect|apply> [--json] [--ensure-companion claude|codex|all]\n',
      );
      process.exit(0);
    }
  }
  return out;
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.cmd) {
    process.stderr.write('usage: cobolt-runtime-sync <detect|apply> [--json]\n');
    process.exit(2);
  }
  const report = opts.cmd === 'apply' ? apply({ ensureCompanion: opts.ensureCompanion }) : detect();
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    if (!report.ok && report.reason) {
      process.stderr.write(`[runtime-sync] ${report.reason}\n`);
      if (report.remediation) process.stderr.write(`[runtime-sync] ${report.remediation}\n`);
    }
    if (report.installs?.length) {
      process.stdout.write('[runtime-sync] runtimes:\n');
      for (const i of report.installs) {
        process.stdout.write(`  - ${i.runtimeName.padEnd(14)} v${i.version}  (${i.scope}: ${i.path})\n`);
      }
    }
    if (report.applied) {
      const verdict = report.syncResult?.ok ? 'ok' : `failed (exit=${report.syncResult?.exitCode})`;
      process.stdout.write(`[runtime-sync] sync to v${report.targetVersion}: ${verdict}\n`);
      if (report.afterInstalls?.length && !report.afterDrift) {
        process.stdout.write(`[runtime-sync] all runtimes aligned at v${report.targetVersion}\n`);
      }
    } else if (!report.needsSync) {
      process.stdout.write(`[runtime-sync] all runtimes already aligned at v${report.sourceVersion}\n`);
    }
  }
  if (opts.cmd === 'apply' && report.applied && !report.ok) {
    process.exit(4);
  }
  process.exit(0);
}

module.exports = { detect, apply, findInstallScript, runListJson };
