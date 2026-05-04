#!/usr/bin/env node

// CoBolt Worktree Manager — git worktree lifecycle for parallel builds
//
// Manages git worktrees used by the build skill for parallel TDD.
// Each worktree is an isolated working copy on a separate branch.
//
// Usage:
//   node tools/cobolt-worktree.js create <name> [--base main]       # Create worktree
//   node tools/cobolt-worktree.js list                              # List active worktrees
//   node tools/cobolt-worktree.js remove <name> [--force]           # Remove worktree (safe by default)
//   node tools/cobolt-worktree.js clean [--force]                   # Remove all safe cobolt worktrees
//   node tools/cobolt-worktree.js status <name>                     # Show worktree status
//   node tools/cobolt-worktree.js merge <name> [--strategy recursive]  # Merge worktree branch
//   node tools/cobolt-worktree.js commit <path> -m "message"       # Commit all changes in worktree
//   node tools/cobolt-worktree.js push <name> [--remote origin]    # Push worktree branch
// Environment:
//   MAX_PARALLEL / COBOLT_MAX_PARALLEL                              # Cap active CoBolt worktrees (default: 4)

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DEFAULT_SHARED_LINK_NAME } = require('./cobolt-agent-hub');
const { paths: getPaths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();

const WORKTREE_PREFIX = 'cobolt-wt-';
const DEFAULT_MAX_PARALLEL = 4;
const DEFAULT_SHARED_OUTPUT_LINK_NAME = '_cobolt-output';

function resolveMaxParallel(value = process.env.COBOLT_MAX_PARALLEL || process.env.MAX_PARALLEL) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_PARALLEL;
}

class WorktreeManager {
  constructor(projectDir) {
    this.projectDir = projectDir || process.cwd();
    this.worktreeRoot = path.join(this.projectDir, '.worktrees');
  }

  getMaxParallel() {
    return resolveMaxParallel();
  }

  /**
   * Create a new worktree with an isolated branch.
   */
  create(name, options = {}) {
    const baseBranch = options.base || this.getDefaultBranch();
    const branchName = `${WORKTREE_PREFIX}${name}`;
    const worktreePath = path.join(this.worktreeRoot, name);
    const maxParallel = this.getMaxParallel();
    const activeWorktrees = this.listCobolt();

    if (fs.existsSync(worktreePath)) {
      return { success: false, error: `Worktree already exists: ${name}`, path: worktreePath };
    }

    if (activeWorktrees.length >= maxParallel) {
      return {
        success: false,
        error:
          `Worktree limit reached (${activeWorktrees.length}/${maxParallel}). ` +
          'Set MAX_PARALLEL or COBOLT_MAX_PARALLEL to raise the cap.',
        active: activeWorktrees.length,
        limit: maxParallel,
      };
    }

    if (!fs.existsSync(this.worktreeRoot)) {
      fs.mkdirSync(this.worktreeRoot, { recursive: true });
    }

    try {
      execFileSync('git', ['worktree', 'add', '-b', branchName, worktreePath, baseBranch], {
        cwd: this.projectDir,
        encoding: 'utf8',
        timeout: 30000,
        stdio: 'pipe',
      });

      const sharedHub = this.ensureSharedHubLink(worktreePath);
      const sharedOutput = this.ensureSharedOutputLink(worktreePath);

      return {
        success: true,
        name,
        branch: branchName,
        path: worktreePath,
        base: baseBranch,
        sharedHub,
        sharedOutput,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  sharedHubDir() {
    const helper = typeof getPaths === 'function' ? getPaths(this.projectDir) : null;
    if (helper?.agentHubDir) return helper.agentHubDir();
    return path.join(this.projectDir, '_cobolt-output', 'public', 'agent-hub');
  }

  ensureSharedHubLink(worktreePath) {
    return this.ensureSharedDirectoryLink(worktreePath, DEFAULT_SHARED_LINK_NAME, this.sharedHubDir(), {
      createTarget: true,
    });
  }

  sharedOutputDir() {
    return path.join(this.projectDir, DEFAULT_SHARED_OUTPUT_LINK_NAME);
  }

  ensureSharedOutputLink(worktreePath) {
    return this.ensureSharedDirectoryLink(worktreePath, DEFAULT_SHARED_OUTPUT_LINK_NAME, this.sharedOutputDir(), {
      createTarget: true,
    });
  }

  ensureSharedDirectoryLink(worktreePath, linkName, targetPath, options = {}) {
    if (options.createTarget) {
      fs.mkdirSync(targetPath, { recursive: true });
    }

    const linkPath = path.join(worktreePath, linkName);
    try {
      if (fs.existsSync(linkPath)) {
        fs.rmSync(linkPath, { recursive: true, force: true });
      }
      fs.symlinkSync(targetPath, linkPath, 'junction');
      this.ensureGitExclude(worktreePath, linkName);
      return {
        linked: true,
        path: targetPath,
        linkPath,
      };
    } catch (err) {
      return {
        linked: false,
        path: targetPath,
        linkPath,
        error: err.message,
      };
    }
  }

  ensureGitExclude(worktreePath, pattern) {
    let excludePath = execFileSync('git', ['-C', worktreePath, 'rev-parse', '--git-path', 'info/exclude'], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: 'pipe',
    }).trim();

    if (!path.isAbsolute(excludePath)) {
      excludePath = path.join(worktreePath, excludePath);
    }

    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const content = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
    const lines = content.split(/\r?\n/).map((line) => line.trim());
    if (!lines.includes(pattern)) {
      const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
      fs.appendFileSync(excludePath, `${prefix}${pattern}\n`, 'utf8');
    }
  }

  /**
   * List all active worktrees.
   */
  list() {
    try {
      const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: this.projectDir,
        encoding: 'utf8',
        timeout: 10000,
      });

      const worktrees = [];
      let current = {};

      for (const line of output.split('\n')) {
        if (line.startsWith('worktree ')) {
          if (current.path) worktrees.push(current);
          current = { path: line.replace('worktree ', '') };
        } else if (line.startsWith('HEAD ')) {
          current.head = line.replace('HEAD ', '');
        } else if (line.startsWith('branch ')) {
          current.branch = line.replace('branch refs/heads/', '');
        } else if (line === 'bare') {
          current.bare = true;
        } else if (line === '') {
          if (current.path) worktrees.push(current);
          current = {};
        }
      }

      return worktrees;
    } catch (_err) {
      return [];
    }
  }

  /**
   * List only CoBolt-managed worktrees.
   */
  listCobolt() {
    return this.list().filter((wt) => wt.branch?.startsWith(WORKTREE_PREFIX));
  }

  branchExists(branchName) {
    try {
      execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], {
        cwd: this.projectDir,
        timeout: 10000,
        stdio: 'pipe',
      });
      return true;
    } catch {
      return false;
    }
  }

  countBranchAhead(branchName, base) {
    if (!branchName || !this.branchExists(branchName)) return { count: 0, available: false };

    const baseRef = base || 'HEAD';
    try {
      const output = execFileSync('git', ['rev-list', '--count', `${baseRef}..${branchName}`], {
        cwd: this.projectDir,
        encoding: 'utf8',
        timeout: 10000,
        stdio: 'pipe',
      });
      return { count: Number.parseInt(output.trim(), 10) || 0, available: true, base: baseRef };
    } catch (err) {
      return {
        count: null,
        available: false,
        base: baseRef,
        error: err.message,
      };
    }
  }

  /**
   * Inspect whether a worktree can be removed without losing local work.
   */
  inspectPersistence(name, options = {}) {
    const worktreePath = path.join(this.worktreeRoot, name);
    const branchName = `${WORKTREE_PREFIX}${name}`;
    const branchExists = this.branchExists(branchName);
    const ahead = this.countBranchAhead(branchName, options.base);
    const result = {
      exists: fs.existsSync(worktreePath),
      name,
      path: worktreePath,
      branch: branchName,
      branchExists,
      base: ahead.base || options.base || 'HEAD',
      changes: 0,
      dirty: false,
      ahead: ahead.count,
      aheadKnown: ahead.available,
      safeToRemove: true,
      blockers: [],
    };

    if (ahead.count === null) {
      result.safeToRemove = false;
      result.blockers.push(`cannot verify commits ahead of ${result.base}: ${ahead.error}`);
    } else if (ahead.count > 0) {
      result.safeToRemove = false;
      result.blockers.push(`${ahead.count} commit(s) have not been merged into ${result.base}`);
    }

    if (!result.exists) {
      return result;
    }

    try {
      const statusOutput = execFileSync('git', ['status', '--porcelain'], {
        cwd: worktreePath,
        encoding: 'utf8',
        timeout: 10000,
        stdio: 'pipe',
      });
      const changes = statusOutput.trim().split('\n').filter(Boolean);
      result.changes = changes.length;
      result.dirty = changes.length > 0;
      if (result.dirty) {
        result.safeToRemove = false;
        result.blockers.push(`${changes.length} uncommitted change(s) remain in the worktree`);
      }
    } catch (err) {
      result.safeToRemove = false;
      result.blockers.push(`cannot read worktree status: ${err.message}`);
    }

    return result;
  }

  /**
   * Remove a worktree.
   */
  remove(name, options = {}) {
    const worktreePath = path.join(this.worktreeRoot, name);
    const branchName = `${WORKTREE_PREFIX}${name}`;
    const safety = this.inspectPersistence(name, { base: options.base });

    if (!options.force && !safety.safeToRemove) {
      return {
        success: false,
        blocked: true,
        name,
        path: worktreePath,
        branch: branchName,
        safety,
        error:
          `Refusing to remove worktree ${name}: ${safety.blockers.join('; ')}. ` +
          'Commit and merge the worktree, or rerun with --force after archiving the work.',
      };
    }

    try {
      const removeArgs = ['worktree', 'remove', worktreePath];
      if (options.force) removeArgs.push('--force');
      execFileSync('git', removeArgs, {
        cwd: this.projectDir,
        timeout: 30000,
        stdio: 'pipe',
      });
    } catch (err) {
      if (!options.force) {
        return {
          success: false,
          blocked: true,
          name,
          path: worktreePath,
          branch: branchName,
          safety,
          error: `git worktree remove refused ${name}: ${err.message}`,
        };
      }

      // Manual cleanup is only allowed when the caller explicitly forced removal.
      try {
        if (fs.existsSync(worktreePath)) {
          fs.rmSync(worktreePath, { recursive: true, force: true });
        }
        execFileSync('git', ['worktree', 'prune'], {
          cwd: this.projectDir,
          timeout: 10000,
          stdio: 'pipe',
        });
      } catch {
        /* manual cleanup is best-effort */
      }
    }

    // Delete the branch
    try {
      execFileSync('git', ['branch', options.force ? '-D' : '-d', branchName], {
        cwd: this.projectDir,
        timeout: 10000,
        stdio: 'pipe',
      });
    } catch (err) {
      if (!options.force && this.branchExists(branchName)) {
        return {
          success: false,
          blocked: true,
          name,
          path: worktreePath,
          branch: branchName,
          safety,
          error: `Worktree removed, but branch ${branchName} was not deleted safely: ${err.message}`,
        };
      }
    }

    return { success: true, name, path: worktreePath, branch: branchName, safety };
  }

  /**
   * Remove all CoBolt-managed worktrees.
   */
  clean(options = {}) {
    const coboltWorktrees = this.listCobolt();
    const results = [];

    for (const wt of coboltWorktrees) {
      const name = wt.branch.replace(WORKTREE_PREFIX, '');
      const result = this.remove(name, options);
      results.push(result);
    }

    // Clean up worktree root if empty
    if (fs.existsSync(this.worktreeRoot)) {
      try {
        const remaining = fs.readdirSync(this.worktreeRoot);
        if (remaining.length === 0) fs.rmdirSync(this.worktreeRoot);
      } catch {
        /* dir cleanup is best-effort */
      }
    }

    return results;
  }

  /**
   * Get status of a specific worktree.
   */
  status(name) {
    const worktreePath = path.join(this.worktreeRoot, name);
    if (!fs.existsSync(worktreePath)) {
      return { exists: false, name };
    }

    try {
      const statusOutput = execFileSync('git', ['status', '--porcelain'], {
        cwd: worktreePath,
        encoding: 'utf8',
        timeout: 10000,
      });

      const logOutput = execFileSync('git', ['log', '--oneline', '-5'], {
        cwd: worktreePath,
        encoding: 'utf8',
        timeout: 10000,
      });

      return {
        exists: true,
        name,
        path: worktreePath,
        branch: `${WORKTREE_PREFIX}${name}`,
        changes: statusOutput.trim().split('\n').filter(Boolean).length,
        recentCommits: logOutput.trim().split('\n').filter(Boolean),
        persistence: this.inspectPersistence(name),
      };
    } catch (err) {
      return { exists: true, name, path: worktreePath, error: err.message };
    }
  }

  /**
   * Merge a worktree branch back into the current branch (no-ff).
   * @param {string} name - Worktree name (without prefix)
   * @param {object} options - { strategy: 'ours'|'theirs'|'recursive', message: string }
   * @returns {{ success: boolean, mergedCommits?: number, branch?: string, noop?: boolean, error?: string }}
   */
  merge(name, options = {}) {
    const branch = `${WORKTREE_PREFIX}${name}`;
    const strategy = options.strategy || 'recursive';

    // Verify branch exists
    try {
      execFileSync('git', ['rev-parse', '--verify', branch], {
        cwd: this.projectDir,
        encoding: 'utf8',
        timeout: 10000,
        stdio: 'pipe',
      });
    } catch {
      return { success: false, error: `Branch not found: ${branch}` };
    }

    // Check commits ahead
    let ahead = 0;
    try {
      const countOutput = execFileSync('git', ['rev-list', '--count', `HEAD..${branch}`], {
        cwd: this.projectDir,
        encoding: 'utf8',
        timeout: 10000,
        stdio: 'pipe',
      });
      ahead = parseInt(countOutput.trim(), 10) || 0;
    } catch (err) {
      return { success: false, error: `Failed to count commits: ${err.message}` };
    }

    if (ahead === 0) {
      return { success: true, noop: true, mergedCommits: 0 };
    }

    // Perform merge
    const message = options.message || `Merge ${branch} into current branch`;
    const mergeArgs = ['merge', '--no-ff', '-m', message];
    if (strategy && strategy !== 'recursive') {
      mergeArgs.push('-s', strategy);
    }
    mergeArgs.push(branch);

    try {
      execFileSync('git', mergeArgs, {
        cwd: this.projectDir,
        encoding: 'utf8',
        timeout: 60000,
        stdio: 'pipe',
      });
      return { success: true, mergedCommits: ahead, branch };
    } catch (err) {
      // Abort the conflicted merge
      try {
        execFileSync('git', ['merge', '--abort'], {
          cwd: this.projectDir,
          timeout: 10000,
          stdio: 'pipe',
        });
      } catch {
        /* abort may fail if no merge in progress */
      }
      return { success: false, error: `Merge conflict: ${err.message}` };
    }
  }

  /**
   * Stage all changes and commit in a worktree directory.
   * @param {string} worktreePath - Absolute path to the worktree
   * @param {string} message - Commit message
   * @returns {{ success: boolean, sha?: string, noop?: boolean, error?: string }}
   */
  commitAll(worktreePath, message) {
    if (!fs.existsSync(worktreePath)) {
      return { success: false, error: `Path does not exist: ${worktreePath}` };
    }

    try {
      // Stage everything
      execFileSync('git', ['-C', worktreePath, 'add', '-A'], {
        timeout: 30000,
        stdio: 'pipe',
      });

      // Check if there are staged changes
      try {
        execFileSync('git', ['-C', worktreePath, 'diff', '--cached', '--quiet'], {
          timeout: 10000,
          stdio: 'pipe',
        });
        // Exit 0 means nothing staged
        return { success: true, noop: true };
      } catch {
        // Exit non-zero means there ARE staged changes — proceed to commit
      }

      // Commit
      execFileSync('git', ['-C', worktreePath, 'commit', '-m', message], {
        timeout: 30000,
        stdio: 'pipe',
      });

      // Get short SHA
      const sha = execFileSync('git', ['-C', worktreePath, 'rev-parse', '--short', 'HEAD'], {
        encoding: 'utf8',
        timeout: 10000,
        stdio: 'pipe',
      }).trim();

      return { success: true, sha };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Push a worktree branch to a remote.
   * @param {string} name - Worktree name (without prefix)
   * @param {string} remote - Remote name (default: 'origin')
   * @returns {{ success: boolean, remote?: string, branch?: string, error?: string }}
   */
  pushBranch(name, remote = 'origin') {
    const branch = `${WORKTREE_PREFIX}${name}`;

    // Verify remote exists
    try {
      execFileSync('git', ['remote', 'get-url', remote], {
        cwd: this.projectDir,
        encoding: 'utf8',
        timeout: 10000,
        stdio: 'pipe',
      });
    } catch {
      return { success: false, error: `Remote not found: ${remote}` };
    }

    // Push
    try {
      execFileSync('git', ['push', remote, branch], {
        cwd: this.projectDir,
        timeout: 60000,
        stdio: 'pipe',
      });
      return { success: true, remote, branch };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  getDefaultBranch() {
    try {
      const remoteHead = execFileSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
        cwd: this.projectDir,
        encoding: 'utf8',
        timeout: 10000,
        stdio: 'pipe',
      }).trim();
      if (remoteHead.startsWith('origin/')) {
        return remoteHead.slice('origin/'.length);
      }
    } catch {
      /* fall through */
    }

    for (const candidate of ['main', 'master']) {
      try {
        execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`], {
          cwd: this.projectDir,
          encoding: 'utf8',
          timeout: 10000,
          stdio: 'pipe',
        });
        return candidate;
      } catch {
        /* try next candidate */
      }
    }

    try {
      const current = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: this.projectDir,
        encoding: 'utf8',
        timeout: 10000,
        stdio: 'pipe',
      }).trim();
      if (current && current !== 'HEAD') {
        return current;
      }
    } catch {
      /* fall through */
    }

    return 'main';
  }
}

// ── Module exports ───────────────────────────────────────────

module.exports = {
  WorktreeManager,
  WORKTREE_PREFIX,
  DEFAULT_MAX_PARALLEL,
  DEFAULT_SHARED_LINK_NAME,
  DEFAULT_SHARED_OUTPUT_LINK_NAME,
  resolveMaxParallel,
};

// ── CLI ──────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '--help') {
    console.log('  Usage: node tools/cobolt-worktree.js <command> [args]');
    console.log('  Commands: create, list, remove, clean, status, merge, commit, push');
    console.log('  Safety: remove/clean refuse dirty or unmerged worktrees unless --force is supplied.');
    process.exit(0);
  }

  const mgr = new WorktreeManager();

  switch (cmd) {
    case 'create': {
      if (!args[1]) {
        console.error('  Usage: create <name> [--base main]');
        process.exit(1);
      }
      const options = {};
      if (args[2] === '--base' && args[3]) options.base = args[3];
      const r = mgr.create(args[1], options);
      if (r.success) {
        console.log(`  \u2713 Created worktree: ${r.name}`);
        console.log(`    Branch: ${r.branch}`);
        console.log(`    Path: ${r.path}`);
        if (r.sharedHub?.linked) {
          console.log(`    Shared Hub: ${r.sharedHub.linkPath}`);
        }
      } else {
        console.error(`  \u2717 ${r.error}`);
        process.exit(1);
      }
      break;
    }
    case 'list': {
      const worktrees = mgr.listCobolt();
      if (worktrees.length === 0) {
        console.log('  No CoBolt worktrees active.');
        break;
      }
      for (const wt of worktrees) {
        console.log(`  ${wt.branch.padEnd(30)} ${wt.path}`);
      }
      break;
    }
    case 'remove': {
      if (!args[1]) {
        console.error('  Usage: remove <name> [--base <branch>] [--force]');
        process.exit(1);
      }
      const options = {
        force: args.includes('--force'),
      };
      const baseIndex = args.indexOf('--base');
      if (baseIndex !== -1 && args[baseIndex + 1]) options.base = args[baseIndex + 1];
      const result = mgr.remove(args[1], options);
      if (!result.success) {
        console.error(`  \u2717 ${result.error}`);
        process.exit(1);
      }
      console.log(`  \u2713 Removed worktree: ${args[1]}`);
      break;
    }
    case 'clean': {
      const options = {
        force: args.includes('--force'),
      };
      const baseIndex = args.indexOf('--base');
      if (baseIndex !== -1 && args[baseIndex + 1]) options.base = args[baseIndex + 1];
      const results = mgr.clean(options);
      const blocked = results.filter((result) => !result.success);
      if (blocked.length > 0) {
        for (const result of blocked) {
          console.error(`  \u2717 ${result.error}`);
        }
        console.error(`  Refused to clean ${blocked.length} worktree(s). Re-run with --force only after archiving.`);
        process.exit(1);
      }
      console.log(`  Cleaned ${results.length} worktrees.`);
      break;
    }
    case 'status': {
      if (!args[1]) {
        console.error('  Usage: status <name>');
        process.exit(1);
      }
      const s = mgr.status(args[1]);
      console.log(JSON.stringify(s, null, 2));
      break;
    }
    case 'merge': {
      if (!args[1]) {
        console.error('  Usage: merge <name> [--strategy recursive]');
        process.exit(1);
      }
      const options = {};
      if (args[2] === '--strategy' && args[3]) options.strategy = args[3];
      const r = mgr.merge(args[1], options);
      if (r.success) {
        if (r.noop) {
          console.log(`  - No new commits to merge from ${WORKTREE_PREFIX}${args[1]}`);
        } else {
          console.log(`  \u2713 Merged ${r.mergedCommits} commit(s) from ${r.branch}`);
        }
      } else {
        console.error(`  \u2717 ${r.error}`);
        process.exit(1);
      }
      break;
    }
    case 'commit': {
      if (!args[1]) {
        console.error('  Usage: commit <path> -m "message"');
        process.exit(1);
      }
      let message = 'CoBolt worktree commit';
      if (args[2] === '-m' && args[3]) message = args[3];
      const r = mgr.commitAll(args[1], message);
      if (r.success) {
        if (r.noop) {
          console.log('  - Nothing to commit (working tree clean)');
        } else {
          console.log(`  \u2713 Committed: ${r.sha}`);
        }
      } else {
        console.error(`  \u2717 ${r.error}`);
        process.exit(1);
      }
      break;
    }
    case 'push': {
      if (!args[1]) {
        console.error('  Usage: push <name> [--remote origin]');
        process.exit(1);
      }
      let remote = 'origin';
      if (args[2] === '--remote' && args[3]) remote = args[3];
      const r = mgr.pushBranch(args[1], remote);
      if (r.success) {
        console.log(`  \u2713 Pushed ${r.branch} to ${r.remote}`);
      } else {
        console.error(`  \u2717 ${r.error}`);
        process.exit(1);
      }
      break;
    }
    default:
      console.error(`  Unknown command: ${cmd}`);
      process.exit(1);
  }
}
