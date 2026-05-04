#!/usr/bin/env node

// CoBolt Uninstall — system-wide CoBolt removal in one command.
//
// Composes two layers of CoBolt removal:
//
//   1. PROJECT layer  → buildCatalog('full') + executeDeletions
//                       (delegates to cobolt-reset.js for the project work)
//
//   2. SYSTEM layer   → executeGlobalUninstall
//                       (removes ~/.claude/hooks/cobolt-*.js, ~/.claude/cobolt/,
//                        ~/.claude/.cobolt-backups/, plugin dirs, strips cobolt
//                        entries from ~/.claude/settings.json with backup,
//                        best-effort npm uninstall -g @mftlabs/cobolt)
//
// SCOPE BOUNDARY (HARD):
//
//   This tool removes ONLY CoBolt-owned files. Application source code,
//   user-authored content, and non-cobolt entries in shared config files
//   are NEVER touched. Specifically:
//
//     - PROTECTED_ROOTS allowlist from cobolt-reset.js applies (src/, app/,
//       tests/, lib/, package.json, README.md, .git/, references/, etc.)
//     - Non-cobolt mcpServers/hooks/plugins in ~/.claude/settings.json
//       survive the strip
//     - Only files matching cobolt-*.js are removed from ~/.claude/hooks/
//     - npm uninstall is best-effort and only targets @mftlabs/cobolt
//
// USAGE
//
//   node tools/cobolt-uninstall.js                  # dry-run preview
//   node tools/cobolt-uninstall.js --confirm        # execute
//   node tools/cobolt-uninstall.js --confirm --force  # bypass git-dirty
//   node tools/cobolt-uninstall.js --json           # machine output
//   node tools/cobolt-uninstall.js --help
//
// SAFETY MODEL
//
//   1. Dry-run by default — --confirm required for any deletion or mutation.
//   2. Project layer uses cobolt-reset's hardcoded PROTECTED_ROOTS.
//   3. .env.cobolt is auto-backed up before removal.
//   4. ~/.claude/settings.json is auto-backed up before mutation.
//   5. Git-safety: refuses dirty cobolt-state.json without --force.
//   6. Idempotent: running twice is safe.
//   7. Non-cobolt entries in shared config files NEVER touched.

const path = require('node:path');

const RESET = require('./cobolt-reset.js');

// ── Arg parsing ──────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    confirm: false,
    force: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--confirm') opts.confirm = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--dry-run')
      opts.confirm = false; // explicit form
    else throw new Error(`unknown flag: ${arg}`);
  }
  return opts;
}

function printHelp() {
  console.log(`cobolt-uninstall — total CoBolt removal (project + system) in one command

USAGE
  node tools/cobolt-uninstall.js [options]

OPTIONS
  --confirm    Actually execute. Without this, runs as dry-run preview.
  --force      Override git-safety check for uncommitted cobolt-state.json.
  --json       Machine-readable output.
  --help, -h   Show this help.

WHAT GETS REMOVED

  PROJECT layer (under ${process.cwd()}):
    * _cobolt-output/, cobolt-state.json, .cobolt-backups/, .claude-backups/
    * All planning docs CoBolt generated (prd.md, architecture.md, epics.md,
      milestones.md, master-plan.md, rtm.json, sprint-status.yaml,
      infra-manifest.json, implicit-requirements.md, engineering-standards.md,
      docs/stories/, docs/planning/, docs/architecture-decisions/)
    * design-tokens.json, component-registry.json, .stitch/, .cobolt/
    * cobolt-rejected-findings.json, cobolt-accepted-findings.json
    * .env.cobolt (backed up to .env.cobolt.bak.<timestamp> first)

  SYSTEM layer (under ~/.claude, ~/.codex, ~/):
    * ~/.claude/hooks/cobolt-*.js (preserves all non-cobolt hooks)
    * ~/.claude/cobolt/ (lib, assets, state)
    * ~/.claude/.cobolt-backups/
    * ~/.claude/plugins/cobolt/, ~/.claude/plugins/@mftlabs/cobolt/
    * ~/.codex/plugins/cobolt/, ~/.codex/plugins/@mftlabs/cobolt/
    * ~/.cobolt/
    * Cobolt entries in ~/.claude/settings.json (hooks, statusLine,
      mcpServers, enabledPlugins) — backed up first
    * Best-effort: npm uninstall -g @mftlabs/cobolt

WHAT IS NEVER TOUCHED (HARDCODED ALLOWLIST)

  * references/, src/, app/, lib/, tests/, test/, spec/, node_modules/
  * package.json, package-lock.json, yarn.lock, pnpm-lock.yaml
  * README.md, LICENSE, CONTRIBUTING.md, CODE_OF_CONDUCT.md
  * .git/, .gitignore, .github/, .vscode/, .idea/
  * Anything outside CoBolt-owned paths in ~/.claude/ and ~/.codex/
  * Non-cobolt mcpServers/hooks/plugins/voice settings in ~/.claude/settings.json

EXAMPLES
  node tools/cobolt-uninstall.js                # preview, no changes
  node tools/cobolt-uninstall.js --confirm      # execute total removal
  node tools/cobolt-uninstall.js --confirm --force  # bypass git-dirty refusal
`);
}

// ── Pretty printing ─────────────────────────────────────────

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function printPreview(catalog, projectRoot) {
  const os = require('node:os');
  const home = os.homedir();
  console.log('=== DRY-RUN — no files will be deleted (pass --confirm to execute) ===');
  console.log('');
  console.log(`Project root: ${projectRoot}`);
  console.log('');

  console.log('PROJECT layer would remove:');
  if (catalog.scheduled.length === 0) {
    console.log('  (nothing — already clean)');
  } else {
    for (const p of catalog.scheduled) {
      const rel = path.relative(projectRoot, p) || '.';
      console.log(`  ✗ ${rel}`);
    }
  }
  if (catalog.envBackup) {
    console.log('  ⚠️  .env.cobolt will be backed up to .env.cobolt.bak.<timestamp> before removal');
  }
  console.log('');

  console.log('SYSTEM layer would remove:');
  console.log(`  ✗ ${path.join(home, '.claude', 'hooks', 'cobolt-*.js')}  (CoBolt hook scripts)`);
  console.log(`  ✗ ${path.join(home, '.claude', 'cobolt')}  (lib/, assets/, state)`);
  console.log(`  ✗ ${path.join(home, '.claude', '.cobolt-backups')}`);
  console.log(`  ✗ ${path.join(home, '.claude', 'plugins', 'cobolt')}  (if present)`);
  console.log(`  ✗ ${path.join(home, '.claude', 'plugins', '@mftlabs', 'cobolt')}  (if present)`);
  console.log(`  ✗ ${path.join(home, '.codex', 'plugins', 'cobolt')}  (if present)`);
  console.log(`  ✗ ${path.join(home, '.codex', 'plugins', '@mftlabs', 'cobolt')}  (if present)`);
  console.log(`  ✗ ${path.join(home, '.cobolt')}  (if present)`);
  console.log('');
  console.log('SYSTEM layer would mutate (with backup):');
  console.log(`  ~ ${path.join(home, '.claude', 'settings.json')}`);
  console.log('     - strip cobolt-* entries from hooks (SessionStart/PreToolUse/PostToolUse/Stop)');
  console.log('     - remove statusLine if it points at a cobolt hook');
  console.log('     - strip mcpServers and enabledPlugins keys containing "cobolt"');
  console.log('     - backup → settings.json.cobolt-backup.<timestamp>');
  console.log('');
  console.log('SYSTEM layer would attempt:');
  console.log('  npm uninstall -g @mftlabs/cobolt    (best effort, ignored if absent)');
  console.log('');
  console.log('NEVER TOUCHED:');
  console.log('  ✓ src/, app/, lib/, tests/, package.json, README.md, .git/, references/');
  console.log('  ✓ Non-cobolt mcpServers/hooks/plugins in ~/.claude/settings.json');
  console.log('  ✓ Anything outside the paths listed above');
  console.log('');
  console.log('To execute: node tools/cobolt-uninstall.js --confirm');
}

function printResult(projectResult, globalResult, projectRoot) {
  console.log('=== CoBolt removed. ===');
  console.log('');
  console.log('PROJECT layer:');
  if (projectResult.deleted.length === 0) {
    console.log('  (nothing to remove — already clean)');
  } else {
    console.log(`  ✓ deleted ${projectResult.deleted.length} path(s) (${formatBytes(projectResult.totalBytes)})`);
  }
  if (projectResult.envBackup) {
    console.log(`  ✓ .env.cobolt backed up → ${path.relative(projectRoot, projectResult.envBackup)}`);
  }
  if (projectResult.errors.length > 0) {
    console.log(`  ! ${projectResult.errors.length} project error(s):`);
    for (const e of projectResult.errors) console.log(`      - ${e.path}: ${e.error}`);
  }
  console.log('');
  console.log('SYSTEM layer:');
  if (globalResult.settingsBackup) {
    console.log(`  ✓ ~/.claude/settings.json — stripped ${globalResult.settingsEntriesRemoved} cobolt entries`);
    console.log(`    backup: ${globalResult.settingsBackup}`);
  } else {
    console.log('  ✓ ~/.claude/settings.json — no cobolt entries found');
  }
  if (globalResult.hookFilesDeleted.length > 0) {
    console.log(`  ✓ deleted ${globalResult.hookFilesDeleted.length} hook file(s) under ~/.claude/hooks/cobolt-*`);
  } else {
    console.log('  ✓ ~/.claude/hooks/cobolt-* — none present');
  }
  if (globalResult.dirsDeleted.length > 0) {
    console.log(`  ✓ deleted ${globalResult.dirsDeleted.length} global director(ies):`);
    for (const d of globalResult.dirsDeleted) console.log(`      - ${d}`);
  }
  if (globalResult.dirsNotFound.length > 0) {
    console.log(`  · ${globalResult.dirsNotFound.length} global director(ies) not present (already clean)`);
  }
  if (globalResult.npm) {
    if (globalResult.npm.ok) {
      console.log('  ✓ npm uninstall -g @mftlabs/cobolt — succeeded');
    } else {
      console.log('  · npm uninstall -g @mftlabs/cobolt — not installed or skipped');
    }
  }
  if (globalResult.errors.length > 0) {
    console.log(`  ! ${globalResult.errors.length} system error(s):`);
    for (const e of globalResult.errors) console.log(`      - ${e.path}: ${e.error}`);
  }
  console.log('');
  console.log('To re-install: npx --yes --package github:merupuai/cobolt cobolt --all --global');
}

// ── Composition ─────────────────────────────────────────────

function totalCatalogBytes(catalog) {
  // Reuse cobolt-reset's helper indirectly by walking; simple sum.
  const fs = require('node:fs');
  let total = 0;
  function size(p) {
    let stat;
    try {
      stat = fs.lstatSync(p);
    } catch {
      return 0;
    }
    if (stat.isFile()) return stat.size;
    if (stat.isDirectory()) {
      let s = 0;
      try {
        for (const e of fs.readdirSync(p, { withFileTypes: true })) {
          s += size(path.join(p, e.name));
        }
      } catch {
        /* best effort */
      }
      return s;
    }
    return 0;
  }
  for (const p of catalog) total += size(p);
  return total;
}

function uninstall(opts) {
  const projectRoot = process.cwd();

  // PROJECT layer — build the --full catalog from cobolt-reset.
  const catalog = RESET.buildCatalog('full');

  if (!opts.confirm) {
    return { dryRun: true, catalog, projectRoot };
  }

  // Git-safety check (project layer only — system layer is outside repo).
  if (!opts.force) {
    const dirty = RESET.getDirtyFiles();
    for (const scheduledPath of catalog.scheduled) {
      const hit = RESET.scheduledPathContainsDirty(scheduledPath, dirty);
      if (hit) {
        const err = new Error(
          `refused — scheduled deletion contains uncommitted changes: ${path.relative(projectRoot, hit)}. ` +
            'Commit/stash the changes, or pass --force to override.',
        );
        err.code = 3;
        throw err;
      }
    }
  }

  // PROJECT layer — backup .env.cobolt then delete.
  let envBackup = null;
  if (catalog.envBackup) {
    envBackup = RESET.backupEnvFile();
  }
  const totalBytes = totalCatalogBytes(catalog.scheduled);
  const projectExec = RESET.executeDeletions(catalog.scheduled);

  const projectResult = {
    deleted: projectExec.deleted,
    errors: projectExec.errors,
    envBackup,
    totalBytes,
  };

  // SYSTEM layer — execute global uninstall (settings.json strip + hook
  // file deletion + global dir deletion + best-effort npm uninstall).
  const globalResult = RESET.executeGlobalUninstall();

  return {
    dryRun: false,
    projectRoot,
    project: projectResult,
    global: globalResult,
  };
}

// ── Main ────────────────────────────────────────────────────

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    console.error('Run with --help for usage.');
    process.exit(2);
  }

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  let result;
  try {
    result = uninstall(opts);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(err.code || 1);
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  if (result.dryRun) {
    printPreview(result.catalog, result.projectRoot);
    process.exit(0);
  }

  printResult(result.project, result.global, result.projectRoot);
  const totalErrors = result.project.errors.length + result.global.errors.length;
  // Exit-code mapping per tools/CLAUDE.md:
  //   0 = success (or npm not installed = nothing to uninstall)
  //   1 = hard failure (permission denied, unknown uninstall failure, etc.)
  //   2 = missing optional dep (npm unavailable on PATH)
  //   5 = legacy combined-errors signal (preserved for backward compat)
  const npmStatus = result.global?.npm ? result.global.npm.status : null;
  if (npmStatus === 'npm-unavailable' && totalErrors === 0) {
    // No errors otherwise — surface the missing-dep state via exit 2 so
    // automation can degrade gracefully (skip-and-report) instead of failing.
    process.exit(2);
  }
  if (npmStatus === 'permission-denied' || npmStatus === 'uninstall-failed') {
    process.exit(1);
  }
  if (npmStatus === 'network-error' && totalErrors === 0) {
    // Network error = missing infra per tools/CLAUDE.md (exit 3). Project layer
    // succeeded, only the npm registry was unreachable.
    process.exit(3);
  }
  process.exit(totalErrors > 0 ? 5 : 0);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  uninstall,
  totalCatalogBytes,
};
