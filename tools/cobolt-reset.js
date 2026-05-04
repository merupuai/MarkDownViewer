#!/usr/bin/env node

// CoBolt Reset — safely remove CoBolt artifacts from a project.
//
// Four modes for four lifecycle scenarios:
//
//   --list       Inventory only. Prints every CoBolt-owned path with size.
//                Never mutates the filesystem.
//
//   --complete   Project is shipped. Keep deliverables (planning docs,
//                design tokens, references, source code, .env.cobolt).
//                Only delete pipeline scaffolding (_cobolt-output/,
//                cobolt-state.json, .cobolt-backups/).
//
//   --abandon    Walking away mid-pipeline. Same as --complete — keep
//                whatever artifacts CoBolt generated, delete scaffolding.
//                Print a prominent reminder about .env.cobolt secrets.
//
//   --fresh      Start over in the same project. Delete scaffolding AND
//                generated planning docs (prd.md, architecture.md, etc.)
//                so the next /cobolt-plan run starts clean. Keep infra
//                config, design tokens, references.
//
// //   --full       Total project-level removal. Delete everything CoBolt
//                owns in this project including .env.cobolt (backed up
//                first), design tokens, component registry. Does NOT
//                touch references/ (user-authored), application source,
//                package.json, or anything outside process.cwd().
//
// SCOPE BOUNDARY (HARD):
//
//   cobolt-reset is PROJECT-ONLY. It never touches anything outside the
//   current working directory. Specifically, it NEVER reads or writes:
//     - ~/.claude/, ~/.codex/, ~/.cobolt/ (or any home-directory CoBolt path)
//     - ~/.claude/settings.json (global hooks/MCP/statusLine entries)
//     - ~/.claude/hooks/cobolt-*.js (global hook scripts)
//     - npm global packages (npm uninstall -g)
//
//   For system-wide CoBolt removal use /cobolt-uninstall (which composes
//   this tool for the project layer with executeGlobalUninstall for the
//   system layer). The --global flag is rejected at parse time — passing
//   it produces a hard error directing users to cobolt-uninstall.
//
// Safety model (invariants in precedence order):
//
//   1. DRY-RUN BY DEFAULT. No --confirm = prints the manifest and exits
//      without touching the filesystem. This is the single most important
//      safety rule.
//
//   2. PROTECTED PATHS NEVER TOUCHED. references/, src/, app/, tests/,
//      lib/ (if user-owned), docs/ (except CoBolt-generated subtrees),
//      .git/, node_modules/, package.json, README.md. Hardcoded allowlist.
//
//   3. NO ESCAPING CWD. Every resolved path is containment-checked
//      against process.cwd() using the same helper pattern as the
//      brownfield scope gate.
//
//   4. GIT-SAFETY. If any scheduled deletion has uncommitted changes,
//      refuse unless --force is passed.
//
//   5. AUTO-BACKUP .env.cobolt to .env.cobolt.bak.<iso-timestamp> before
//      --full deletes it. Always. No flag to disable.
//
//   6. IDEMPOTENT. Running twice is safe. All rm operations use
//      { force: true }.
//
//   7. NEVER TOUCHES ANYTHING OUTSIDE process.cwd(). The helper functions
//      executeGlobalUninstall, stripCobaltFromSettings, removeCobaltHookFiles,
//      and isCobaltHookCommand are exported as utilities for tools/cobolt-uninstall.js
//      but are NEVER called from this tool's CLI path.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { atomicWrite } = require('../lib/cobolt-atomic-write');

// ── Constants ───────────────────────────────────────────────

const PROJECT_ROOT = process.cwd();

const TIER_A_SCAFFOLDING = [
  '_cobolt-output',
  'cobolt-state.json',
  'cobolt-state.json.lock',
  '.cobolt-backups',
  '.claude-backups',
];

// Planning docs CoBolt generates. Removed in --fresh and --full only.
// Each entry is a repo-relative path (file or directory).
const TIER_B_PLANNING_DOCS = [
  'prd.md',
  'trd.md',
  'architecture.md',
  'ux-design-specification.md',
  'epics.md',
  'milestones.md',
  'master-plan.md',
  'rtm.json',
  'sprint-status.yaml',
  'infra-manifest.json',
  'implicit-requirements.md',
  'engineering-standards.md',
  'docs/stories',
  'docs/planning',
  'docs/architecture-decisions',
];

// Design-system and configuration artifacts. Removed in --full only.
const TIER_C_CONFIG = [
  'design-tokens.json',
  'component-registry.json',
  '.stitch',
  '.cobolt',
  'cobolt-rejected-findings.json',
  'cobolt-accepted-findings.json',
];

// .env.cobolt is handled specially — backed up before deletion.
const ENV_FILE = '.env.cobolt';

// Paths that are NEVER touched by any mode. Any scheduled deletion whose
// path resolves under one of these is filtered out before execution.
// This is the last line of defense; the mode catalogs already exclude
// these, but an explicit allowlist guards against future edits that
// accidentally add a protected path to a catalog.
const PROTECTED_ROOTS = [
  'references', // USER-AUTHORED domain docs
  'src',
  'app',
  'lib',
  'tests',
  'test',
  'spec',
  'node_modules',
  '.git',
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'README.md',
  'LICENSE',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  '.gitignore',
  '.github',
  '.vscode',
  '.idea',
];

// ── Path helpers ─────────────────────────────────────────────

function normalizePath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase();
}

function isSameOrDescendant(candidate, base) {
  const c = normalizePath(candidate);
  const b = normalizePath(base);
  if (!c || !b) return c === b;
  return c === b || c.startsWith(`${b}/`);
}

// Containment check: resolved path MUST be inside PROJECT_ROOT.
function isInsideProjectRoot(candidate) {
  const resolved = path.resolve(candidate);
  return isSameOrDescendant(resolved, PROJECT_ROOT);
}

// Is the resolved path protected by the allowlist?
function isProtected(candidate) {
  const resolved = path.resolve(candidate);
  for (const root of PROTECTED_ROOTS) {
    const protectedAbs = path.resolve(PROJECT_ROOT, root);
    if (isSameOrDescendant(resolved, protectedAbs)) return true;
  }
  return false;
}

// ── Filesystem helpers ───────────────────────────────────────

function existsLstat(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function getSizeBytes(p) {
  const stat = existsLstat(p);
  if (!stat) return 0;
  if (stat.isFile()) return stat.size;
  if (stat.isDirectory()) {
    let total = 0;
    try {
      for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
        const child = path.join(p, entry.name);
        total += getSizeBytes(child);
      }
    } catch {
      /* best effort */
    }
    return total;
  }
  return 0;
}

function countFiles(p) {
  const stat = existsLstat(p);
  if (!stat) return 0;
  if (stat.isFile()) return 1;
  if (stat.isDirectory()) {
    let total = 0;
    try {
      for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
        total += countFiles(path.join(p, entry.name));
      }
    } catch {
      /* best effort */
    }
    return total;
  }
  return 0;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ── Git safety ───────────────────────────────────────────────

function getDirtyFiles() {
  try {
    const output = execFileSync('git', ['status', '--porcelain', '-z'], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 5000,
    });
    return output
      .split('\0')
      .filter(Boolean)
      .map((entry) => entry.slice(3)) // strip "XY " status prefix
      .map((rel) => path.resolve(PROJECT_ROOT, rel));
  } catch {
    return []; // not a git repo or git unavailable — treat as clean
  }
}

function scheduledPathContainsDirty(scheduledPath, dirtyFiles) {
  const resolved = path.resolve(scheduledPath);
  for (const dirty of dirtyFiles) {
    if (isSameOrDescendant(dirty, resolved)) return dirty;
  }
  return null;
}

// ── Catalog ──────────────────────────────────────────────────

function buildCatalog(mode) {
  // Returns: { scheduled: string[], kept: string[], envBackup: boolean }
  const scheduled = [];
  const kept = [];
  let envBackup = false;

  const addIfExists = (rel, list) => {
    const abs = path.resolve(PROJECT_ROOT, rel);
    if (existsLstat(abs)) list.push(abs);
  };

  switch (mode) {
    case 'list':
      // List-only mode: nothing is scheduled for deletion.
      for (const rel of TIER_A_SCAFFOLDING) addIfExists(rel, kept);
      for (const rel of TIER_B_PLANNING_DOCS) addIfExists(rel, kept);
      for (const rel of TIER_C_CONFIG) addIfExists(rel, kept);
      addIfExists(ENV_FILE, kept);
      break;

    case 'complete':
    case 'abandon':
      for (const rel of TIER_A_SCAFFOLDING) addIfExists(rel, scheduled);
      for (const rel of TIER_B_PLANNING_DOCS) addIfExists(rel, kept);
      for (const rel of TIER_C_CONFIG) addIfExists(rel, kept);
      addIfExists(ENV_FILE, kept);
      break;

    case 'fresh':
      for (const rel of TIER_A_SCAFFOLDING) addIfExists(rel, scheduled);
      for (const rel of TIER_B_PLANNING_DOCS) addIfExists(rel, scheduled);
      for (const rel of TIER_C_CONFIG) addIfExists(rel, kept);
      addIfExists(ENV_FILE, kept);
      break;

    case 'full':
      for (const rel of TIER_A_SCAFFOLDING) addIfExists(rel, scheduled);
      for (const rel of TIER_B_PLANNING_DOCS) addIfExists(rel, scheduled);
      for (const rel of TIER_C_CONFIG) addIfExists(rel, scheduled);
      {
        const envAbs = path.resolve(PROJECT_ROOT, ENV_FILE);
        if (existsLstat(envAbs)) {
          scheduled.push(envAbs);
          envBackup = true;
        }
      }
      break;

    default:
      throw new Error(`unknown mode: ${mode}`);
  }

  // Defense in depth: filter out anything that accidentally lands on a
  // protected path or escapes CWD. Should be a no-op because the tiers
  // exclude them by design, but an explicit sieve catches mistakes.
  const filtered = [];
  const refused = [];
  for (const p of scheduled) {
    if (!isInsideProjectRoot(p)) {
      refused.push({ path: p, reason: 'escapes project root' });
      continue;
    }
    if (isProtected(p)) {
      refused.push({ path: p, reason: 'protected path' });
      continue;
    }
    filtered.push(p);
  }

  return { scheduled: filtered, kept, envBackup, refused };
}

// ── Actions ──────────────────────────────────────────────────

function backupEnvFile() {
  const envAbs = path.resolve(PROJECT_ROOT, ENV_FILE);
  if (!existsLstat(envAbs)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupAbs = path.resolve(PROJECT_ROOT, `${ENV_FILE}.bak.${stamp}`);
  fs.copyFileSync(envAbs, backupAbs);
  return backupAbs;
}

function createArchive(targetPath, paths) {
  // We avoid spawning tar / zip — writing a plain directory copy is more
  // portable on Windows and gives the user something they can inspect.
  fs.mkdirSync(targetPath, { recursive: true });
  const manifest = { createdAt: new Date().toISOString(), entries: [] };
  for (const src of paths) {
    const rel = path.relative(PROJECT_ROOT, src);
    const dest = path.resolve(targetPath, rel);
    const stat = existsLstat(src);
    if (!stat) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (stat.isDirectory()) {
      fs.cpSync(src, dest, { recursive: true, force: true });
    } else {
      fs.copyFileSync(src, dest);
    }
    manifest.entries.push(rel);
  }
  fs.writeFileSync(path.join(targetPath, 'BACKUP-MANIFEST.json'), JSON.stringify(manifest, null, 2));
  return targetPath;
}

function executeDeletions(paths) {
  const deleted = [];
  const errors = [];
  for (const p of paths) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
      deleted.push(p);
    } catch (err) {
      errors.push({ path: p, error: err.message });
    }
  }
  return { deleted, errors };
}

// ── Global uninstall ─────────────────────────────────────────
//
// Removes CoBolt traces from the user's machine outside the project root:
// global hooks, lib copy, backups, plugin directories, and strips cobolt
// entries from ~/.claude/settings.json. Best-effort npm global uninstall.
//
// Safety: only touches paths under ~/.claude/, ~/.codex/, ~/.cobolt/, and
// attempts `npm uninstall -g @mftlabs/cobolt`. Always backs up settings.json
// before mutating it. Idempotent — running twice is safe.

function isCobaltHookCommand(cmd) {
  if (typeof cmd !== 'string') return false;
  const lc = cmd.toLowerCase().replace(/\\/g, '/');
  return /(?:^|[\s"'`])(?:[^"'\s`]*\/)?\.claude\/hooks\/cobolt-[^/"'\s`]+(?:$|[\s"'`])/.test(lc);
}

function stripCobaltFromSettings(settings) {
  // Mutates a copy and returns { next, removedCount }.
  const next = JSON.parse(JSON.stringify(settings || {}));
  let removed = 0;

  if (next.hooks && typeof next.hooks === 'object') {
    for (const event of Object.keys(next.hooks)) {
      const entries = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
      const filtered = [];
      for (const entry of entries) {
        const innerHooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
        const cleanedInner = innerHooks.filter((h) => !isCobaltHookCommand(h?.command));
        const removedInThisEntry = innerHooks.length - cleanedInner.length;
        removed += removedInThisEntry;
        if (cleanedInner.length > 0) {
          filtered.push({ ...entry, hooks: cleanedInner });
        }
      }
      if (filtered.length > 0) {
        next.hooks[event] = filtered;
      } else {
        delete next.hooks[event];
      }
    }
    if (Object.keys(next.hooks).length === 0) delete next.hooks;
  }

  if (next.statusLine && isCobaltHookCommand(next.statusLine.command)) {
    delete next.statusLine;
    removed += 1;
  }

  if (next.mcpServers && typeof next.mcpServers === 'object') {
    for (const name of Object.keys(next.mcpServers)) {
      if (name.toLowerCase().includes('cobolt')) {
        delete next.mcpServers[name];
        removed += 1;
      }
    }
  }

  if (next.enabledPlugins && typeof next.enabledPlugins === 'object') {
    for (const name of Object.keys(next.enabledPlugins)) {
      if (name.toLowerCase().includes('cobolt')) {
        delete next.enabledPlugins[name];
        removed += 1;
      }
    }
  }

  return { next, removed };
}

function removeCobaltHookFiles(hooksDir) {
  // Removes ~/.claude/hooks/cobolt-*.js files only. Never touches non-cobolt hooks.
  const deleted = [];
  const errors = [];
  let entries = [];
  try {
    entries = fs.readdirSync(hooksDir, { withFileTypes: true });
  } catch {
    return { deleted, errors };
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name.toLowerCase();
    if (!name.startsWith('cobolt-')) continue;
    const abs = path.join(hooksDir, entry.name);
    try {
      fs.rmSync(abs, { force: true });
      deleted.push(abs);
    } catch (err) {
      errors.push({ path: abs, error: err.message });
    }
  }
  return { deleted, errors };
}

// Sweep orphan atomic-write tmp files left over from prior interrupted
// uninstalls. atomicWrite uses the pattern `.<basename>.tmp.<pid>.<ts>.<rand>`
// in the same directory as the target. Anything older than ORPHAN_TMP_AGE_MS
// is safe to remove without racing a concurrent uninstall.
const ORPHAN_TMP_AGE_MS = 5 * 60 * 1000;

// rmDirSafe: retry-with-backoff wrapper around fs.rmSync for the global
// uninstall path. On Windows, file handles held by a running Claude Code /
// Codex IDE process surface as EBUSY/EPERM/EACCES/ENOTEMPTY. We retry up to
// 3 times with exponential backoff (100/200/400ms = 700ms worst-case) so a
// briefly-held handle resolves before we report failure. force:false so real
// failures actually surface — the previous force:true silently swallowed
// permission errors and left ghost dirs the user couldn't diagnose.
const RMDIR_RETRY_DELAYS_MS = [100, 200, 400];
const WINDOWS_RETRYABLE_ERR_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

function rmDirSafe(dir, report) {
  let lastErr;
  for (let attempt = 0; attempt <= RMDIR_RETRY_DELAYS_MS.length; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: false, maxRetries: 0 });
      report.dirsDeleted.push(dir);
      return;
    } catch (err) {
      lastErr = err;
      if (err.code === 'ENOENT') {
        report.dirsNotFound.push(dir);
        return;
      }
      const retryable = process.platform === 'win32' && WINDOWS_RETRYABLE_ERR_CODES.has(err.code);
      if (!retryable || attempt === RMDIR_RETRY_DELAYS_MS.length) break;
      // Synchronous spin — executeGlobalUninstall is sync-by-design (called
      // from CLI, no async surface). Worst case 700ms total across 3 retries.
      const wait = RMDIR_RETRY_DELAYS_MS[attempt];
      const until = Date.now() + wait;
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
  const hint =
    process.platform === 'win32' && lastErr && WINDOWS_RETRYABLE_ERR_CODES.has(lastErr.code)
      ? ' (Windows: another process may hold a handle — close Claude Code / Codex IDE and retry)'
      : '';
  report.errors.push({ path: dir, error: `${lastErr ? lastErr.message : 'unknown error'}${hint}` });
}

// Classify the result of `npm uninstall -g @mftlabs/cobolt`. Distinguishes
// legitimate non-error cases (not installed, npm unavailable) from real
// failures (permission denied, network error, uninstall failed) so callers
// can map to correct CLI exit codes per tools/CLAUDE.md.
function classifyNpmUninstallResult({ ok, output, exitCode }) {
  const text = (output || '').trim();
  if (ok) {
    const wasInstalled = /removed\s+\d+\s+package/i.test(text);
    return {
      ok: true,
      status: wasInstalled ? 'uninstalled' : 'not-installed',
      output: text.slice(0, 500),
    };
  }
  let status;
  // npm-unavailable: the npm binary itself is missing (not on PATH).
  // Patterns: "spawn npm ENOENT" (Node child_process), "'npm' is not recognized"
  // (Windows cmd), "npm: command not found" (POSIX shells).
  // Must NOT match npm's own "ENOTFOUND" output (network errors from npm).
  const npmMissing =
    /spawn\s+npm\s+ENOENT/i.test(text) ||
    /['"]?npm['"]?\s+is not recognized/i.test(text) ||
    /(?:^|[^a-z])npm:\s*command not found/i.test(text);
  if (npmMissing) {
    status = 'npm-unavailable';
  } else if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|registry|network/i.test(text)) {
    status = 'network-error';
  } else if (/EACCES|EPERM|permission/i.test(text)) {
    status = 'permission-denied';
  } else {
    status = 'uninstall-failed';
  }
  return {
    // npm-unavailable is the only non-error case (treated as: nothing to do).
    ok: status === 'npm-unavailable',
    status,
    exitCode: typeof exitCode === 'number' ? exitCode : null,
    output: text.slice(0, 500),
  };
}

function sweepOrphanTmpFiles(home) {
  const swept = [];
  const dirs = [path.join(home, '.claude'), path.join(home, '.claude', 'hooks')];
  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      // atomicWrite tmp pattern: .<base>.tmp.<digits>.<digits>.<6chars>
      if (!/^\..+\.tmp\.\d+\.\d+\.[a-z0-9]+$/i.test(name)) continue;
      const abs = path.join(dir, name);
      try {
        const stat = fs.statSync(abs);
        if (Date.now() - stat.mtimeMs < ORPHAN_TMP_AGE_MS) continue;
        fs.unlinkSync(abs);
        swept.push(abs);
      } catch {
        /* best effort */
      }
    }
  }
  return swept;
}

function executeGlobalUninstall() {
  const os = require('node:os');
  const home = os.homedir();
  const report = {
    settingsBackup: null,
    settingsEntriesRemoved: 0,
    hookFilesDeleted: [],
    dirsDeleted: [],
    dirsNotFound: [],
    errors: [],
    npm: null,
    orphanTmpSwept: [],
  };

  // 0. Sweep orphan atomic-write tmp files from prior interrupted uninstalls
  //    (older than 5 minutes — won't race a concurrent uninstall).
  report.orphanTmpSwept = sweepOrphanTmpFiles(home);

  // 1. Strip cobolt entries from ~/.claude/settings.json (backup first, then
  //    atomic-write so a Ctrl+C mid-write can never leave settings.json
  //    half-written and brick Claude Code on next start).
  const settingsPath = path.join(home, '.claude', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const raw = fs.readFileSync(settingsPath, 'utf8');
      const parsed = JSON.parse(raw);
      const { next, removed } = stripCobaltFromSettings(parsed);
      if (removed > 0) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = `${settingsPath}.cobolt-backup.${stamp}`;
        fs.copyFileSync(settingsPath, backupPath);
        const serialized = `${JSON.stringify(next, null, 2)}\n`;
        atomicWrite(settingsPath, serialized, { encoding: 'utf8', mode: 0o600 });
        report.settingsBackup = backupPath;
        report.settingsEntriesRemoved = removed;
      }
    } catch (err) {
      report.errors.push({ path: settingsPath, error: `settings.json: ${err.message}` });
    }
  }

  // 2. Delete ~/.claude/hooks/cobolt-*.js files (preserve non-cobolt hooks).
  const claudeHooksDir = path.join(home, '.claude', 'hooks');
  const hookResult = removeCobaltHookFiles(claudeHooksDir);
  report.hookFilesDeleted = hookResult.deleted;
  for (const e of hookResult.errors) report.errors.push(e);

  // 3. Delete CoBolt-owned directories (best effort, idempotent).
  //    lstat first: if entry is a symlink (--link mode), unlink the link only
  //    so we never recurse into and delete the source repo.
  const globalDirs = [
    path.join(home, '.claude', 'cobolt'),
    path.join(home, '.claude', '.cobolt-backups'),
    path.join(home, '.claude', 'plugins', 'cobolt'),
    path.join(home, '.claude', 'plugins', '@mftlabs', 'cobolt'),
    path.join(home, '.codex', 'plugins', 'cobolt'),
    path.join(home, '.codex', 'plugins', '@mftlabs', 'cobolt'),
    path.join(home, '.cobolt'),
  ];
  for (const dir of globalDirs) {
    let lst;
    try {
      lst = fs.lstatSync(dir);
    } catch {
      report.dirsNotFound.push(dir);
      continue;
    }
    try {
      if (lst.isSymbolicLink()) {
        // --link mode safety: unlink the symlink itself; do NOT follow into
        // the target (which is the user's source repo).
        fs.unlinkSync(dir);
        report.dirsDeleted.push(`${dir} (symlink)`);
      } else {
        // Real dir: retry-with-backoff on Windows handle holds; surface real
        // permission/IO errors instead of silently swallowing them.
        rmDirSafe(dir, report);
      }
    } catch (err) {
      report.errors.push({ path: dir, error: err.message });
    }
  }

  // 4. npm global uninstall — classify the result so callers can map to the
  //    correct exit code (per tools/CLAUDE.md): npm-unavailable -> exit 2,
  //    permission-denied / uninstall-failed -> exit 1.
  let npmOk = false;
  let npmOutput = '';
  let npmExitCode = null;
  try {
    npmOutput = execFileSync('npm', ['uninstall', '-g', '@mftlabs/cobolt'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 30000,
      shell: process.platform === 'win32', // npm is a .cmd on Windows
    });
    npmOk = true;
  } catch (err) {
    npmOutput = (err.stderr || err.stdout || err.message || '').toString();
    npmExitCode = typeof err.status === 'number' ? err.status : null;
  }
  report.npm = classifyNpmUninstallResult({ ok: npmOk, output: npmOutput, exitCode: npmExitCode });

  return report;
}

// ── Reporting ────────────────────────────────────────────────

function buildReport(mode, catalog, opts) {
  const { scheduled, kept, envBackup, refused } = catalog;
  const totalSize = scheduled.reduce((sum, p) => sum + getSizeBytes(p), 0);
  const totalFiles = scheduled.reduce((sum, p) => sum + countFiles(p), 0);
  const keptSize = kept.reduce((sum, p) => sum + getSizeBytes(p), 0);

  return {
    mode,
    dryRun: !opts.confirm,
    projectRoot: PROJECT_ROOT,
    scheduledForDeletion: scheduled.map((p) => ({
      path: path.relative(PROJECT_ROOT, p) || '.',
      size: getSizeBytes(p),
      files: countFiles(p),
    })),
    keptInPlace: kept.map((p) => ({
      path: path.relative(PROJECT_ROOT, p) || '.',
      size: getSizeBytes(p),
    })),
    refused,
    envBackup,
    totals: {
      scheduledFiles: totalFiles,
      scheduledBytes: totalSize,
      keptBytes: keptSize,
    },
  };
}

function printHumanReport(report, _opts) {
  const banner = report.dryRun
    ? '=== DRY-RUN — no files will be deleted (pass --confirm to execute) ==='
    : '=== EXECUTING — deleting files now ===';
  console.log(banner);
  console.log(`Mode:         ${report.mode}`);
  console.log(`Project root: ${report.projectRoot}`);
  console.log('');

  if (report.scheduledForDeletion.length > 0) {
    console.log(
      `To delete (${report.scheduledForDeletion.length} paths, ${formatBytes(report.totals.scheduledBytes)}, ${report.totals.scheduledFiles} files):`,
    );
    for (const entry of report.scheduledForDeletion) {
      console.log(`  ✗ ${entry.path}  (${formatBytes(entry.size)}, ${entry.files} files)`);
    }
  } else {
    console.log('To delete: (nothing — already clean)');
  }

  if (report.envBackup) {
    console.log('');
    console.log('⚠️  .env.cobolt will be backed up to .env.cobolt.bak.<timestamp> before deletion');
  }

  if (report.keptInPlace.length > 0) {
    console.log('');
    console.log(`Kept in place (${report.keptInPlace.length} paths):`);
    for (const entry of report.keptInPlace) {
      console.log(`  ✓ ${entry.path}  (${formatBytes(entry.size)})`);
    }
  }

  if (report.refused.length > 0) {
    console.log('');
    console.log('Refused (protected or escapes CWD):');
    for (const entry of report.refused) {
      console.log(`  ! ${entry.path}  — ${entry.reason}`);
    }
  }

  console.log('');
  if (report.dryRun && report.scheduledForDeletion.length > 0) {
    console.log('To actually delete these files, re-run with --confirm:');
    console.log(`  node tools/cobolt-reset.js --${report.mode} --confirm`);
  }

  // cobolt-reset is project-only — no global preview or report block.
  // Global cleanup lives in tools/cobolt-uninstall.js.
}

function printSurvivalChecklist(report) {
  if (report.dryRun) return;
  console.log('');
  console.log('=== SURVIVAL CHECKLIST ===');
  if (report.envBackup) {
    console.log('  • .env.cobolt was backed up — look for .env.cobolt.bak.<timestamp>');
    console.log('    If you need your infra secrets back, restore that file.');
  }
  if (report.mode === 'complete' || report.mode === 'abandon') {
    console.log('  • Planning docs (prd.md, architecture.md, etc.) were KEPT.');
    console.log('  • design-tokens.json and references/ were KEPT.');
    console.log('  • Your source code is untouched.');
  }
  if (report.mode === 'fresh') {
    console.log('  • Planning docs were DELETED — rerun /cobolt-plan to regenerate.');
    console.log('  • .env.cobolt and design-tokens.json were KEPT.');
    console.log('  • Run /cobolt-init to re-initialize.');
  }
  if (report.mode === 'full') {
    console.log("  • references/ was KEPT (it was yours, not CoBolt's).");
    console.log('  • Source code is untouched.');
    console.log('  • Review .gitignore for lingering CoBolt entries.');
    console.log('  • Review package.json for CoBolt-specific scripts.');
  }
  console.log('');
}

// ── Arg parsing ──────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    mode: null,
    confirm: false,
    force: false,
    json: false,
    help: false,
    backup: null,
  };
  const modes = ['list', 'complete', 'abandon', 'fresh', 'full'];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--confirm') opts.confirm = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--global') {
      // HARD BOUNDARY: cobolt-reset is project-only and MUST NEVER touch
      // anything outside process.cwd(). Global removal lives in cobolt-uninstall.
      throw new Error(
        '--global is not accepted by cobolt-reset (project-only tool). ' +
          'Use /cobolt-uninstall (or `node tools/cobolt-uninstall.js`) for system-wide removal.',
      );
    } else if (arg === '--backup') opts.backup = args[++i] || null;
    else if (arg === '--dry-run')
      opts.confirm = false; // explicit form
    else if (arg.startsWith('--')) {
      const modeName = arg.slice(2);
      if (modes.includes(modeName)) {
        if (opts.mode && opts.mode !== modeName) {
          throw new Error(`conflicting modes: --${opts.mode} and --${modeName}`);
        }
        opts.mode = modeName;
      } else {
        throw new Error(`unknown flag: ${arg}`);
      }
    } else {
      throw new Error(`unexpected positional argument: ${arg}`);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`cobolt-reset — safely remove CoBolt artifacts from a project

USAGE
  node tools/cobolt-reset.js --<mode> [options]

MODES (exactly one required)
  --list       Inventory CoBolt-owned paths. No deletion.
  --complete   Project shipped — keep deliverables, remove scaffolding.
  --abandon    Abandoning mid-pipeline — keep artifacts, remove scaffolding.
  --fresh      Start over in the same project — remove scaffolding + planning.
  --full       Total removal (project-level). .env.cobolt is backed up first.

OPTIONS
  --confirm       Actually delete. Without this, runs as dry-run.
  --force         Override git-safety check for dirty files.
  --backup <dir>  Copy all scheduled files to <dir> before deleting.
  --json          Machine-readable output.
  --help, -h      Show this help.

SCOPE
  cobolt-reset is PROJECT-ONLY. It never touches anything outside the
  current working directory. For system-wide CoBolt removal (global
  hooks under ~/.claude/hooks/, ~/.claude/cobolt/, ~/.claude/settings.json
  entries, npm global package), use /cobolt-uninstall instead, or run:

      node tools/cobolt-uninstall.js --confirm

  Passing --global to this command is rejected at parse time.

SAFETY
  * Dry-run by default — --confirm is required for any deletion.
  * NEVER touches references/, src/, app/, tests/, .git/, package.json,
    README.md, or any path outside the current working directory.
  * .env.cobolt is auto-backed up before --full removes it.
  * Refuses to delete files with uncommitted git changes unless --force.

EXAMPLES
  node tools/cobolt-reset.js --list
  node tools/cobolt-reset.js --complete                   # dry-run
  node tools/cobolt-reset.js --complete --confirm         # execute
  node tools/cobolt-reset.js --fresh --confirm
  node tools/cobolt-reset.js --full --confirm
  node tools/cobolt-reset.js --full --confirm --backup ./cobolt-archive
`);
}

// ── Main ─────────────────────────────────────────────────────

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    console.error('Run with --help for usage.');
    process.exit(2);
  }

  if (opts.help || !opts.mode) {
    printHelp();
    process.exit(opts.help ? 0 : 2);
  }

  // Build catalog for the requested mode.
  const catalog = buildCatalog(opts.mode);
  const report = buildReport(opts.mode, catalog, opts);

  // --list mode: never deletes, never checks git, never confirms.
  if (opts.mode === 'list') {
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printHumanReport(report, opts);
    }
    process.exit(0);
  }

  // Git-safety check (skipped in dry-run since we won't delete anyway).
  if (opts.confirm && !opts.force) {
    const dirty = getDirtyFiles();
    for (const scheduledPath of catalog.scheduled) {
      const hit = scheduledPathContainsDirty(scheduledPath, dirty);
      if (hit) {
        console.error('ERROR: refused — scheduled deletion contains uncommitted changes.');
        console.error(`  Scheduled: ${path.relative(PROJECT_ROOT, scheduledPath)}`);
        console.error(`  Dirty:     ${path.relative(PROJECT_ROOT, hit)}`);
        console.error('');
        console.error('Commit or stash these changes first, or pass --force to override.');
        process.exit(3);
      }
    }
  }

  // Dry-run path: print report and exit.
  if (!opts.confirm) {
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printHumanReport(report, opts);
    }
    process.exit(0);
  }

  // Execute path.
  // 1. Backup .env.cobolt if flagged.
  let envBackupPath = null;
  if (catalog.envBackup) {
    envBackupPath = backupEnvFile();
    if (envBackupPath) {
      console.log(`Backed up .env.cobolt → ${path.relative(PROJECT_ROOT, envBackupPath)}`);
    }
  }

  // 2. Optional archive.
  if (opts.backup) {
    const archivePath = path.resolve(PROJECT_ROOT, opts.backup);
    if (!isInsideProjectRoot(archivePath)) {
      console.error('ERROR: --backup path must be inside the project root.');
      process.exit(4);
    }
    createArchive(archivePath, catalog.scheduled);
    console.log(`Archived scheduled files → ${path.relative(PROJECT_ROOT, archivePath)}`);
  }

  // 3. Delete.
  const result = executeDeletions(catalog.scheduled);

  // 4. Report. (Project-only — no global removal happens here. For
  //    system-wide uninstall, see tools/cobolt-uninstall.js.)
  const finalReport = {
    ...report,
    dryRun: false,
    executed: true,
    deleted: result.deleted.map((p) => path.relative(PROJECT_ROOT, p) || '.'),
    errors: result.errors,
    envBackupPath: envBackupPath ? path.relative(PROJECT_ROOT, envBackupPath) : null,
  };

  if (opts.json) {
    console.log(JSON.stringify(finalReport, null, 2));
  } else {
    printHumanReport(finalReport, opts);
    console.log('');
    console.log(`Deleted ${result.deleted.length} paths.`);
    if (result.errors.length > 0) {
      console.log(`Errors: ${result.errors.length}`);
      for (const err of result.errors) {
        console.log(`  ! ${err.path}: ${err.error}`);
      }
    }
    printSurvivalChecklist(finalReport);
  }

  process.exit(result.errors.length > 0 ? 5 : 0);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildCatalog,
  buildReport,
  executeDeletions,
  executeGlobalUninstall,
  stripCobaltFromSettings,
  removeCobaltHookFiles,
  isCobaltHookCommand,
  backupEnvFile,
  createArchive,
  getDirtyFiles,
  parseArgs,
  isInsideProjectRoot,
  isProtected,
  scheduledPathContainsDirty,
  sweepOrphanTmpFiles,
  ORPHAN_TMP_AGE_MS,
  rmDirSafe,
  classifyNpmUninstallResult,
  TIER_A_SCAFFOLDING,
  TIER_B_PLANNING_DOCS,
  TIER_C_CONFIG,
  PROTECTED_ROOTS,
};
