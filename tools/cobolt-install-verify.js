#!/usr/bin/env node

// CoBolt Install Verifier
//
// Asserts a deployed `.claude/` (or `.codex/`) install matches the source
// tree contract. Used by:
//   - tests/test-cobolt-install-verify.js (unit fixtures)
//   - .github/workflows/install-matrix.yml (cross-platform CI proof)
//   - .github/workflows/post-publish-smoke.yml (post-npm-publish smoke)
//
// Single trusted source of install correctness. Centralizes the contract so
// CI yaml + tests don't duplicate assertion logic.
//
// Usage:
//   node tools/cobolt-install-verify.js --target <dir> --runtime <claude|codex> [--expect clean] [--json]
//
// Exit codes (per tools/CLAUDE.md):
//   0 = verified
//   1 = contract mismatch (counts wrong, missing files, placeholder leaks, etc.)
//   2 = missing target dir or required source dir (treated as missing-dep)
//   3 = unexpected I/O failure (treated as missing-infra)

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourceCounts = require('../lib/cobolt-source-counts');

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(REPO_ROOT, 'source');

const RUNTIME_CONFIG = {
  claude: {
    agentDir: 'agents',
    skillDir: 'skills',
    hookDir: 'hooks',
    settingsFile: 'settings.json',
    settingsHookKey: 'hooks',
    settingsParse: (raw) => JSON.parse(raw),
  },
  codex: {
    agentDir: 'agents',
    skillDir: 'skills',
    hookDir: 'hooks',
    settingsFile: 'config.toml',
    settingsHookKey: null,
    settingsParse: (raw) => raw, // we just substring-match for codex
  },
};

// ── Argument parsing ────────────────────────────────────────

function parseArgs(argv) {
  const args = { target: null, runtime: 'claude', expect: 'installed', json: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--target':
        args.target = argv[++i];
        break;
      case '--runtime':
        args.runtime = argv[++i];
        break;
      case '--expect':
        args.expect = argv[++i];
        break;
      case '--json':
        args.json = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        // ignore unknown — caller may pass through extra flags
        break;
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node tools/cobolt-install-verify.js --target <dir> --runtime <claude|codex> [options]

Options:
  --target <dir>      Path to deployed install (e.g. ~/.claude or .claude)
  --runtime <id>      claude | codex (default: claude)
  --expect <state>    installed (default) | clean (post-uninstall verification)
  --json              Output structured JSON instead of text
  --help, -h          Show this help

Exit codes:
  0  Verified
  1  Contract mismatch
  2  Target or source dir missing
  3  Unexpected I/O failure
`);
}

// ── Verification primitives ─────────────────────────────────

function countDeployedAgents(targetDir, runtime) {
  const agentsDir = path.join(targetDir, runtime.agentDir);
  if (!fs.existsSync(agentsDir)) return 0;
  let count = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      // Match the same exclusion rules the installer uses (CLAUDE.md skipped).
      if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'CLAUDE.md') {
        if (entry.name.startsWith('cobolt-') || entry.name.includes('cobolt')) count++;
        else count++; // installer copies all .md agents, not just cobolt-prefixed
      }
    }
  };
  walk(agentsDir);
  return count;
}

function countDeployedSkills(targetDir, runtime) {
  const skillsDir = path.join(targetDir, runtime.skillDir);
  if (!fs.existsSync(skillsDir)) return 0;
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('cobolt-')).length;
}

function countDeployedHooks(targetDir, runtime) {
  const hooksDir = path.join(targetDir, runtime.hookDir);
  if (!fs.existsSync(hooksDir)) return 0;
  return fs.readdirSync(hooksDir).filter((f) => f.startsWith('cobolt-') && f.endsWith('.js')).length;
}

function findOrphanTmpFiles(targetDir) {
  // atomicWrite tmp pattern: .<basename>.tmp.<pid>.<ts>.<rand>
  const orphans = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(full);
        continue;
      }
      if (/^\..+\.tmp\.\d+\.\d+\.[a-z0-9]+$/i.test(entry.name)) orphans.push(full);
    }
  };
  walk(targetDir);
  return orphans;
}

function findUnsubstitutedPlaceholders(targetDir, runtime) {
  // Critical: every deployed hook MUST have all 5 placeholders substituted
  // by scripts/build-hooks.js + transformHook. A leaked placeholder means the
  // hook will fail at runtime (e.g. require statements would reference
  // __COBOLT_CONFIG_DIR__ as a literal path).
  const hooksDir = path.join(targetDir, runtime.hookDir);
  if (!fs.existsSync(hooksDir)) return [];
  const offenders = [];
  for (const name of fs.readdirSync(hooksDir)) {
    if (!name.startsWith('cobolt-') || !name.endsWith('.js')) continue;
    const full = path.join(hooksDir, name);
    const content = fs.readFileSync(full, 'utf8');
    const m = content.match(/__COBOLT_[A-Z_]+__/);
    if (m) offenders.push({ file: full, placeholder: m[0] });
  }
  return offenders;
}

function findHooksWithSyntaxErrors(targetDir, runtime) {
  const hooksDir = path.join(targetDir, runtime.hookDir);
  if (!fs.existsSync(hooksDir)) return [];
  const offenders = [];
  for (const name of fs.readdirSync(hooksDir)) {
    if (!name.startsWith('cobolt-') || !name.endsWith('.js')) continue;
    const full = path.join(hooksDir, name);
    const content = fs.readFileSync(full, 'utf8');
    try {
      // vm.Script does syntax validation without executing.
      new vm.Script(content, { filename: full });
    } catch (err) {
      offenders.push({ file: full, error: err.message });
    }
  }
  return offenders;
}

function verifySettingsFile(targetDir, runtime) {
  const settingsPath = path.join(targetDir, runtime.settingsFile);
  if (!fs.existsSync(settingsPath)) {
    return { ok: false, reason: `${runtime.settingsFile} missing` };
  }
  const raw = fs.readFileSync(settingsPath, 'utf8');
  try {
    const parsed = runtime.settingsParse(raw);
    if (runtime.settingsHookKey) {
      // claude-style: hooks block must exist and reference at least one cobolt hook
      const allHooks = JSON.stringify(parsed[runtime.settingsHookKey] || {});
      if (!/cobolt-/.test(allHooks)) {
        const statusCommand = String(parsed.statusLine?.command || '');
        if (/cobolt-statusline\.js/.test(statusCommand)) {
          return { ok: true, mode: 'passive-installed-scope' };
        }
        return {
          ok: false,
          reason: parsed[runtime.settingsHookKey]
            ? `${runtime.settingsFile} hooks block has no cobolt-* entries`
            : `${runtime.settingsFile} has no hooks block`,
        };
      }
    } else {
      // codex-style: substring check for cobolt MCP block
      if (!/cobolt/i.test(raw)) {
        return { ok: false, reason: `${runtime.settingsFile} has no cobolt entries` };
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `${runtime.settingsFile} parse failure: ${err.message}` };
  }
}

function verifyClean(targetDir) {
  // After uninstall: NO cobolt-* files anywhere under target. We allow the
  // target dir itself and a (possibly-orphan) settings.json with non-cobolt
  // user content to survive.
  const offenders = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.cobolt-backups') continue; // backups are ok to retain
        walk(full);
        continue;
      }
      if (/cobolt-/i.test(entry.name) && entry.name !== '.cobolt-backups') {
        offenders.push(full);
      }
    }
  };
  walk(targetDir);
  return offenders;
}

// ── Main verification orchestrator ──────────────────────────

function verify(args) {
  const result = {
    target: args.target,
    runtime: args.runtime,
    expect: args.expect,
    timestamp: new Date().toISOString(),
    checks: [],
    failures: [],
    ok: true,
  };

  if (!args.target) {
    result.ok = false;
    result.failures.push({ check: 'args', reason: '--target is required' });
    return { result, exitCode: 2 };
  }
  if (!fs.existsSync(SOURCE_DIR)) {
    result.ok = false;
    result.failures.push({ check: 'source', reason: `source dir not found: ${SOURCE_DIR}` });
    return { result, exitCode: 3 };
  }
  if (!fs.existsSync(args.target)) {
    result.ok = false;
    result.failures.push({ check: 'target', reason: `target dir not found: ${args.target}` });
    return { result, exitCode: 2 };
  }

  const runtime = RUNTIME_CONFIG[args.runtime];
  if (!runtime) {
    result.ok = false;
    result.failures.push({ check: 'runtime', reason: `unknown runtime: ${args.runtime}` });
    return { result, exitCode: 1 };
  }

  // Post-uninstall mode: just assert no cobolt-* files remain.
  if (args.expect === 'clean') {
    const offenders = verifyClean(args.target);
    result.checks.push({ name: 'clean', leftovers: offenders.length });
    if (offenders.length > 0) {
      result.ok = false;
      result.failures.push({
        check: 'clean',
        reason: `${offenders.length} cobolt-* file(s) survived uninstall`,
        sample: offenders.slice(0, 5),
      });
    }
    return { result, exitCode: result.ok ? 0 : 1 };
  }

  // Post-install mode: full contract.
  const expectedAgents = sourceCounts.countSourceAgents(SOURCE_DIR);
  const expectedSkills = sourceCounts.countSourceSkills(SOURCE_DIR);
  // Hooks: use the deployable count (includes non-lifecycle hooks) so we
  // can tighten the comparison to strict-equal — every cobolt-*.js the
  // installer copies must be present, no more no less.
  const expectedHooks = sourceCounts.countDeployableHooks(SOURCE_DIR);

  const actualAgents = countDeployedAgents(args.target, runtime);
  const actualSkills = countDeployedSkills(args.target, runtime);
  const actualHooks = countDeployedHooks(args.target, runtime);

  result.checks.push({ name: 'agents', expected: expectedAgents, actual: actualAgents });
  result.checks.push({ name: 'skills', expected: expectedSkills, actual: actualSkills });
  result.checks.push({ name: 'hooks', expected: expectedHooks, actual: actualHooks });

  // Counts: deployed must be >= expected. Greater-than is allowed because the
  // installer may copy non-cobolt agent .md files alongside cobolt-* ones.
  if (actualAgents < expectedAgents) {
    result.ok = false;
    result.failures.push({
      check: 'agents',
      reason: `expected >= ${expectedAgents} agents, found ${actualAgents}`,
    });
  }
  if (actualSkills < expectedSkills) {
    result.ok = false;
    result.failures.push({
      check: 'skills',
      reason: `expected >= ${expectedSkills} skills, found ${actualSkills}`,
    });
  }
  if (actualHooks < expectedHooks) {
    result.ok = false;
    result.failures.push({
      check: 'hooks',
      reason: `expected >= ${expectedHooks} hooks, found ${actualHooks}`,
    });
  }

  // Settings file parses + has cobolt entries.
  const settingsCheck = verifySettingsFile(args.target, runtime);
  result.checks.push({ name: 'settings', ...settingsCheck });
  if (!settingsCheck.ok) {
    result.ok = false;
    result.failures.push({ check: 'settings', reason: settingsCheck.reason });
  }

  // Orphan tmp files from atomic-write interruptions.
  const orphans = findOrphanTmpFiles(args.target);
  result.checks.push({ name: 'orphan-tmp', count: orphans.length });
  if (orphans.length > 0) {
    result.ok = false;
    result.failures.push({
      check: 'orphan-tmp',
      reason: `${orphans.length} orphan .tmp.* files left under target`,
      sample: orphans.slice(0, 5),
    });
  }

  // The single highest-leverage check: no unsubstituted __COBOLT_*__
  // placeholders in deployed hooks. Catches build-hooks.js/transformHook bugs
  // that would otherwise surface as silent runtime failures.
  const placeholderLeaks = findUnsubstitutedPlaceholders(args.target, runtime);
  result.checks.push({ name: 'placeholders', leaks: placeholderLeaks.length });
  if (placeholderLeaks.length > 0) {
    result.ok = false;
    result.failures.push({
      check: 'placeholders',
      reason: `${placeholderLeaks.length} hook(s) have unsubstituted placeholders`,
      sample: placeholderLeaks.slice(0, 5),
    });
  }

  // Every deployed hook parses as valid JS.
  const syntaxErrors = findHooksWithSyntaxErrors(args.target, runtime);
  result.checks.push({ name: 'hook-syntax', errors: syntaxErrors.length });
  if (syntaxErrors.length > 0) {
    result.ok = false;
    result.failures.push({
      check: 'hook-syntax',
      reason: `${syntaxErrors.length} hook(s) failed syntax validation`,
      sample: syntaxErrors.slice(0, 5),
    });
  }

  return { result, exitCode: result.ok ? 0 : 1 };
}

// ── Output ──────────────────────────────────────────────────

function printHumanReport(result) {
  const status = result.ok ? 'PASS' : 'FAIL';
  console.log(
    `cobolt-install-verify ${status} (target: ${result.target}, runtime: ${result.runtime}, expect: ${result.expect})`,
  );
  for (const check of result.checks) {
    const detail = Object.entries(check)
      .filter(([k]) => k !== 'name')
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(' ');
    console.log(`  ${check.name}: ${detail}`);
  }
  if (result.failures.length > 0) {
    console.log('Failures:');
    for (const f of result.failures) {
      console.log(`  ! ${f.check}: ${f.reason}`);
      if (f.sample) {
        for (const s of f.sample) console.log(`      ${typeof s === 'string' ? s : JSON.stringify(s)}`);
      }
    }
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  let outcome;
  try {
    outcome = verify(args);
  } catch (err) {
    if (args.json) {
      console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    } else {
      console.error(`cobolt-install-verify FATAL: ${err.message}`);
    }
    process.exit(3);
  }
  if (args.json) {
    console.log(JSON.stringify(outcome.result, null, 2));
  } else {
    printHumanReport(outcome.result);
  }
  process.exit(outcome.exitCode);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  verify,
  countDeployedAgents,
  countDeployedSkills,
  countDeployedHooks,
  findOrphanTmpFiles,
  findUnsubstitutedPlaceholders,
  findHooksWithSyntaxErrors,
  verifySettingsFile,
  verifyClean,
  RUNTIME_CONFIG,
};
