#!/usr/bin/env node

// CoBolt Git Workflow Manager - milestone branch lifecycle for the CoBolt pipeline
//
// Higher-level orchestrator encoding commit/push POLICY for the pipeline.
// All pipeline skills call this instead of raw git operations.
//
// Usage:
//   node tools/cobolt-git-workflow.js create-branch <milestone>                    # Create cobolt-build/M{n} branch
//   node tools/cobolt-git-workflow.js commit-milestone <milestone> <summary>       # Commit milestone completion
//   node tools/cobolt-git-workflow.js commit-story <milestone> <storyId> <title>   # Commit story implementation
//   node tools/cobolt-git-workflow.js commit-fix <milestone> <findingId> <desc>    # Commit fix
//   node tools/cobolt-git-workflow.js push-milestone <milestone> [--remote origin] # Push milestone branch
//   node tools/cobolt-git-workflow.js push-checkpoint <milestone> [--remote origin]# Push checkpoint for crash recovery
//   node tools/cobolt-git-workflow.js merge-to-main <milestone> [--remote origin]  # Merge milestone to main
//   node tools/cobolt-git-workflow.js status                                       # Show branch status

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BRANCH_PREFIX = 'cobolt-build/';

// -- Security: files that must NEVER be staged or committed ------
const SENSITIVE_PATTERNS = [
  '.env',
  '.env.*',
  '.env.local',
  '.env.production',
  '.env.cobolt',
  '.env.mcp',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  'credentials.json',
  'service-account*.json',
  'gcloud-*.json',
  '*secret*',
  '*credential*',
  '.npmrc',
  '.pypirc',
  'id_rsa',
  'id_ed25519',
  'id_dsa',
  '*.sqlite',
  '*.db',
];

/**
 * Check if a file path matches any sensitive pattern.
 * Never hardcodes values - patterns are declarative above.
 * @param {string} filePath - relative file path from git status
 * @returns {boolean}
 */
function isSensitiveFile(filePath) {
  const basename = path.basename(filePath).toLowerCase();
  const lower = filePath.toLowerCase();
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.startsWith('*') && pattern.endsWith('*')) {
      // *keyword* - substring match
      const keyword = pattern.slice(1, -1);
      if (basename.includes(keyword)) return true;
    } else if (pattern.startsWith('*.')) {
      // *.ext - extension match
      const ext = pattern.slice(1);
      if (basename.endsWith(ext)) return true;
    } else if (pattern.endsWith('*')) {
      // prefix* - prefix match
      const prefix = pattern.slice(0, -1).toLowerCase();
      if (basename.startsWith(prefix)) return true;
    } else if (pattern.includes('*')) {
      // glob-like: e.g. .env.* - prefix + any suffix
      const parts = pattern.split('*');
      if (
        parts.length === 2 &&
        basename.startsWith(parts[0].toLowerCase()) &&
        basename.endsWith(parts[1].toLowerCase())
      )
        return true;
    } else {
      // Exact match
      if (basename === pattern.toLowerCase()) return true;
    }
  }
  // Also block anything in a directory named "secrets" or "credentials"
  if (
    lower.includes('/secrets/') ||
    lower.includes('\\secrets\\') ||
    lower.startsWith('secrets/') ||
    lower.startsWith('secrets\\') ||
    lower.includes('/credentials/') ||
    lower.includes('\\credentials\\') ||
    lower.startsWith('credentials/') ||
    lower.startsWith('credentials\\')
  ) {
    return true;
  }
  return false;
}

class GitWorkflowManager {
  constructor(projectDir) {
    this.projectDir = projectDir || process.cwd();
    this.auditDir = path.join(this.projectDir, '_cobolt-output/audit');
  }

  // -- Milestone lifecycle methods --------------------------------

  /**
   * Create a milestone branch (cobolt-build/M{n}) from HEAD.
   * If the branch already exists (resume scenario), switches to it.
   * @param {string} milestone - e.g. 'M1', 'M2'
   * @returns {{ success: boolean, branch: string, base?: string, alreadyExists?: boolean, error?: string }}
   */
  createMilestoneBranch(milestone) {
    const branch = this.getMilestoneBranch(milestone);

    // Check if branch already exists
    const exists = this._branchExists(branch);

    if (exists) {
      // Resume scenario - switch to the existing branch
      try {
        execFileSync('git', ['checkout', branch], {
          cwd: this.projectDir,
          timeout: 30000,
          stdio: 'pipe',
        });
        this._logEvent('create-milestone-branch', { milestone, branch, resumed: true });
        return { success: true, branch, alreadyExists: true };
      } catch (err) {
        return {
          success: false,
          branch,
          error: `Failed to checkout existing branch: ${(err.stderr || err.message || '').toString().trim()}`,
        };
      }
    }

    // Get current branch as the base
    const base = this.getCurrentBranch() || 'HEAD';

    try {
      execFileSync('git', ['checkout', '-b', branch], {
        cwd: this.projectDir,
        timeout: 30000,
        stdio: 'pipe',
      });
      this._logEvent('create-milestone-branch', { milestone, branch, base });
      return { success: true, branch, base };
    } catch (err) {
      return {
        success: false,
        branch,
        error: `Failed to create branch: ${(err.stderr || err.message || '').toString().trim()}`,
      };
    }
  }

  /**
   * Create or switch to an arbitrary work branch.
   * Uses the current branch as the default base when creating a new branch.
   * @param {string} branch - branch name
   * @param {{ base?: string }} options
   * @returns {{ success: boolean, branch: string, base?: string, alreadyExists?: boolean, error?: string }}
   */
  createOrSwitchBranch(branch, options = {}) {
    const normalizedBranch = String(branch || '').trim();
    if (!normalizedBranch) {
      return { success: false, branch: normalizedBranch, error: 'Branch name is required' };
    }

    const exists = this._branchExists(normalizedBranch);
    if (exists) {
      try {
        execFileSync('git', ['checkout', normalizedBranch], {
          cwd: this.projectDir,
          timeout: 30000,
          stdio: 'pipe',
        });
        this._logEvent('create-work-branch', { branch: normalizedBranch, resumed: true });
        return { success: true, branch: normalizedBranch, alreadyExists: true };
      } catch (err) {
        return {
          success: false,
          branch: normalizedBranch,
          error: `Failed to checkout existing branch: ${(err.stderr || err.message || '').toString().trim()}`,
        };
      }
    }

    const base = options.base || this.getCurrentBranch() || 'HEAD';
    try {
      execFileSync('git', ['checkout', '-b', normalizedBranch, base], {
        cwd: this.projectDir,
        timeout: 30000,
        stdio: 'pipe',
      });
      this._logEvent('create-work-branch', { branch: normalizedBranch, base });
      return { success: true, branch: normalizedBranch, base };
    } catch (err) {
      return {
        success: false,
        branch: normalizedBranch,
        error: `Failed to create branch: ${(err.stderr || err.message || '').toString().trim()}`,
      };
    }
  }

  /**
   * Commit milestone completion.
   * @param {string} milestone - e.g. 'M1'
   * @param {string} summary - human-readable summary
   * @returns {{ success: boolean, sha?: string, noop?: boolean, error?: string }}
   */
  commitMilestone(milestone, summary, options = {}) {
    const message = `build(${milestone}): milestone complete \u2014 ${summary}`;
    // Milestone commits auto-stage all safe files (security-filtered)
    return this._commitAll(
      message,
      { operation: 'commit-milestone', milestone, summary },
      { autoStage: true, ...options },
    );
  }

  /**
   * Commit a story implementation.
   * @param {string} milestone - e.g. 'M1'
   * @param {string} storyId - e.g. 'S1.1'
   * @param {string} storyTitle - human-readable title
   * @returns {{ success: boolean, sha?: string, noop?: boolean, error?: string }}
   */
  commitStory(milestone, storyId, storyTitle, options = {}) {
    const message = `feat(${milestone}): implement ${storyId} \u2014 ${storyTitle}`;
    return this._commitAll(message, { operation: 'commit-story', milestone, storyId, storyTitle }, options);
  }

  /**
   * Commit a fix.
   * @param {string} milestone - e.g. 'M1'
   * @param {string} findingId - e.g. 'SEC-001'
   * @param {string} description - human-readable description
   * @returns {{ success: boolean, sha?: string, noop?: boolean, error?: string }}
   */
  commitFix(milestone, findingId, description, options = {}) {
    const message = `fix(${milestone}): resolve ${findingId} \u2014 ${description}`;
    return this._commitAll(message, { operation: 'commit-fix', milestone, findingId, description }, options);
  }

  /**
   * Commit arbitrary work using the shared security-filtered staging policy.
   * @param {string} message - commit message
   * @param {object} options - autoStage / paths options forwarded to _commitAll
   * @returns {{ success: boolean, sha?: string, noop?: boolean, error?: string }}
   */
  commitWork(message, options = {}) {
    return this._commitAll(message, { operation: 'commit-work', message }, options);
  }

  /**
   * Push milestone branch to remote. Failure blocks CLI completion.
   * @param {string} milestone - e.g. 'M1'
   * @param {string} remote - remote name (default: 'origin')
   * @returns {{ success: boolean, remote?: string, branch?: string, error?: string }}
   */
  pushMilestone(milestone, remote = 'origin') {
    const branch = this.getMilestoneBranch(milestone);
    return this._push(branch, remote, { operation: 'push-milestone', milestone });
  }

  /**
   * Push checkpoint for crash recovery. Same as pushMilestone.
   * @param {string} milestone - e.g. 'M1'
   * @param {string} remote - remote name (default: 'origin')
   * @returns {{ success: boolean, remote?: string, branch?: string, error?: string }}
   */
  pushCheckpoint(milestone, remote = 'origin') {
    const branch = this.getMilestoneBranch(milestone);
    return this._push(branch, remote, { operation: 'push-checkpoint', milestone });
  }

  /**
   * Push the currently checked out branch to a remote.
   * @param {string} remote - remote name (default: 'origin')
   * @returns {{ success: boolean, remote?: string, branch?: string, error?: string }}
   */
  pushCurrentBranch(remote = 'origin') {
    const branch = this.getCurrentBranch();
    if (!branch || branch === 'HEAD') {
      return { success: false, error: 'Cannot push detached HEAD' };
    }
    return this._push(branch, remote, { operation: 'push-current-branch', branch });
  }

  /**
   * Merge milestone branch to main.
   * Checkout main, try --ff-only first, fallback to --no-ff. Push main.
   * Delete milestone branch locally + remotely.
   * If merge fails: go back to milestone branch, return fallback advice.
   * @param {string} milestone - e.g. 'M1'
   * @param {string} remote - remote name (default: 'origin')
   * @returns {{ success: boolean, sha?: string, error?: string, fallback?: string }}
   */
  mergeMilestoneToMain(milestone, remote = 'origin') {
    const branch = this.getMilestoneBranch(milestone);
    const targetBranch = this.getDefaultBranch();

    // Verify milestone branch exists
    if (!this._branchExists(branch)) {
      return { success: false, error: `Branch not found: ${branch}` };
    }

    // Get the SHA before merge for logging
    let milestoneSha;
    try {
      milestoneSha = execFileSync('git', ['rev-parse', '--short', branch], {
        cwd: this.projectDir,
        encoding: 'utf8',
        timeout: 10000,
        stdio: 'pipe',
      }).trim();
    } catch {
      milestoneSha = 'unknown';
    }

    if (this.hasUncommittedChanges()) {
      return {
        success: false,
        error: `Cannot merge ${branch} while the working tree has pending changes. Commit or stash them first.`,
      };
    }

    // Checkout the repository default branch
    try {
      execFileSync('git', ['checkout', targetBranch], {
        cwd: this.projectDir,
        timeout: 30000,
        stdio: 'pipe',
      });
    } catch (err) {
      return {
        success: false,
        error: `Cannot switch to ${targetBranch}: ${(err.stderr || err.message || '').toString().trim()}`,
      };
    }

    // Try --ff-only first
    try {
      execFileSync('git', ['merge', '--ff-only', branch], {
        cwd: this.projectDir,
        timeout: 60000,
        stdio: 'pipe',
      });
    } catch {
      // ff-only failed, try --no-ff
      try {
        execFileSync('git', ['merge', '--no-ff', '-m', `Merge ${branch} into ${targetBranch}`, branch], {
          cwd: this.projectDir,
          timeout: 60000,
          stdio: 'pipe',
        });
      } catch (err) {
        // Merge failed entirely - abort and go back
        try {
          execFileSync('git', ['merge', '--abort'], {
            cwd: this.projectDir,
            timeout: 10000,
            stdio: 'pipe',
          });
        } catch {
          /* abort may fail if no merge in progress */
        }
        try {
          execFileSync('git', ['checkout', branch], {
            cwd: this.projectDir,
            timeout: 30000,
            stdio: 'pipe',
          });
        } catch {
          /* best-effort return to milestone branch */
        }
        this._logEvent('merge-to-main', { milestone, branch, success: false, error: 'merge conflict' });
        return {
          success: false,
          fallback: 'create-pr',
          error: `Merge conflict: ${(err.stderr || err.message || '').toString().trim()}`,
        };
      }
    }

    // Get merged SHA
    let sha;
    try {
      sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: this.projectDir,
        encoding: 'utf8',
        timeout: 10000,
        stdio: 'pipe',
      }).trim();
    } catch {
      sha = milestoneSha;
    }

    // Push default branch to remote. Failure blocks milestone completion.
    try {
      execFileSync('git', ['push', remote, targetBranch], {
        cwd: this.projectDir,
        timeout: 60000,
        stdio: 'pipe',
      });
    } catch (err) {
      this._logEvent('merge-to-main', {
        milestone,
        branch,
        targetBranch,
        success: false,
        error: 'push failed after local merge',
      });
      return {
        success: false,
        fallback: 'manual-push',
        sha,
        error: `Merged locally but failed to push ${targetBranch}: ${(err.stderr || err.message || '').toString().trim()}`,
      };
    }

    // Delete milestone branch locally
    try {
      execFileSync('git', ['branch', '-d', branch], {
        cwd: this.projectDir,
        timeout: 10000,
        stdio: 'pipe',
      });
    } catch {
      /* branch deletion is best-effort */
    }

    // Delete milestone branch remotely (best effort after default branch push succeeds)
    try {
      execFileSync('git', ['push', remote, '--delete', branch], {
        cwd: this.projectDir,
        timeout: 30000,
        stdio: 'pipe',
      });
    } catch {
      /* remote deletion is advisory */
    }

    this._logEvent('merge-to-main', { milestone, branch, sha, success: true });
    return { success: true, sha };
  }

  // -- Version management -----------------------------------------

  /**
   * Initialize version for greenfield projects. Reads the current version
   * from package.json; if missing or "0.0.0", sets it to the provided
   * startVersion (default "0.0.1") and commits. Does nothing if a valid
   * version already exists.
   *
   * @param {string} startVersion - version to set (default "0.0.1")
   * @returns {{ success: boolean, version?: string, initialized?: boolean, error?: string }}
   */
  initGreenfieldVersion(startVersion = '0.0.1') {
    const pkgPath = path.join(this.projectDir, 'package.json');

    // If no package.json, create a minimal one
    if (!fs.existsSync(pkgPath)) {
      try {
        const dirName = path
          .basename(this.projectDir)
          .replace(/[^a-z0-9-]/gi, '-')
          .toLowerCase();
        const pkg = {
          name: dirName || 'cobolt-project',
          version: startVersion,
          private: true,
          description: '',
        };
        fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
        this._logEvent('init-greenfield-version', { version: startVersion, created: true });
        return { success: true, version: startVersion, initialized: true };
      } catch (err) {
        return { success: false, error: `Failed to create package.json: ${err.message}` };
      }
    }

    // package.json exists - check current version
    try {
      const pkgRaw = fs.readFileSync(pkgPath, 'utf8');
      const pkg = JSON.parse(pkgRaw);
      const current = pkg.version || '';

      // Already has a valid version > 0.0.0
      if (/^\d+\.\d+\.\d+$/.test(current) && current !== '0.0.0') {
        return { success: true, version: current, initialized: false };
      }

      // Set the start version
      pkg.version = startVersion;
      fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
      this._logEvent('init-greenfield-version', { from: current || 'none', to: startVersion });
      return { success: true, version: startVersion, initialized: true };
    } catch (err) {
      return { success: false, error: `Failed to update package.json version: ${err.message}` };
    }
  }

  /**
   * Read current version from package.json.
   * @returns {string|null}
   */
  getCurrentVersion() {
    try {
      const pkgPath = path.join(this.projectDir, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      return pkg.version || null;
    } catch {
      return null;
    }
  }

  // -- Query methods ----------------------------------------------

  /**
   * Get the current branch name.
   * @returns {string|null}
   */
  getCurrentBranch() {
    try {
      return (
        execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: this.projectDir,
          encoding: 'utf8',
          timeout: 10000,
          stdio: 'pipe',
        }).trim() || null
      );
    } catch {
      return null;
    }
  }

  /**
   * Resolve the repository's default branch.
   * Prefers origin/HEAD when available, then falls back to the current branch.
   * @returns {string}
   */
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

    const current = this.getCurrentBranch();
    if (current && current !== 'HEAD') {
      return current;
    }

    return 'main';
  }

  /**
   * Get the branch name for a milestone.
   * @param {string} milestone - e.g. 'M1'
   * @returns {string}
   */
  getMilestoneBranch(milestone) {
    return `${BRANCH_PREFIX}${milestone}`;
  }

  /**
   * Check if there are uncommitted changes.
   * @returns {boolean}
   */
  hasUncommittedChanges() {
    try {
      const output = execFileSync('git', ['status', '--porcelain'], {
        cwd: this.projectDir,
        encoding: 'utf8',
        timeout: 10000,
        stdio: 'pipe',
      });
      return output.trim().length > 0;
    } catch {
      return false;
    }
  }

  _getStatusEntries() {
    try {
      const output = execFileSync('git', ['status', '--porcelain'], {
        cwd: this.projectDir,
        encoding: 'utf8',
        timeout: 10000,
        stdio: 'pipe',
      });
      return output
        .split('\n')
        .filter(Boolean)
        .map((line) => ({
          indexStatus: line[0],
          worktreeStatus: line[1],
          path: line.slice(3).trim(),
        }));
    } catch {
      return [];
    }
  }

  // -- Internal methods -------------------------------------------

  /**
   * Shared commit logic: stage all, check staged, commit, get SHA.
   * @param {string} message - commit message
   * @param {object} eventData - data for audit log
   * @returns {{ success: boolean, sha?: string, noop?: boolean, error?: string }}
   */
  _commitAll(message, eventData, options = {}) {
    try {
      const statusEntries = this._getStatusEntries();
      if (statusEntries.length === 0) {
        // Nothing to commit - noop
        return { success: true, noop: true };
      }

      // Write audit log BEFORE staging so it gets included in the commit
      this._logEvent(eventData.operation, { ...eventData, message });

      const auditLogPath = path
        .relative(this.projectDir, path.join(this.auditDir, 'git-workflow-events.jsonl'))
        .replace(/\\/g, '/');
      const explicitPaths = Array.isArray(options.paths)
        ? options.paths.map((item) => item.replace(/\\/g, '/')).filter(Boolean)
        : [];
      const hasPreStagedChanges = statusEntries.some((entry) => entry.indexStatus !== ' ' && entry.indexStatus !== '?');

      if (explicitPaths.length > 0) {
        // Filter sensitive files from explicit paths
        const safePaths = explicitPaths.filter((p) => !isSensitiveFile(p));
        const blocked = explicitPaths.filter((p) => isSensitiveFile(p));
        if (blocked.length > 0) {
          this._logEvent('security-block', { blocked, reason: 'Sensitive file pattern match' });
        }
        execFileSync('git', ['add', '--', ...safePaths, auditLogPath], {
          cwd: this.projectDir,
          timeout: 30000,
          stdio: 'pipe',
        });
      } else if (options.autoStage) {
        // Auto-stage mode (used by milestone commits): stage ALL files except sensitive ones.
        // Security: never stages .env, credentials, API keys, secrets, or private keys.
        const safeFiles = statusEntries
          .map((entry) => entry.path)
          .filter(Boolean)
          .filter((p) => !isSensitiveFile(p));
        const blocked = statusEntries
          .map((entry) => entry.path)
          .filter(Boolean)
          .filter((p) => isSensitiveFile(p));
        if (blocked.length > 0) {
          this._logEvent('security-block', {
            operation: eventData.operation,
            blocked,
            reason: 'Sensitive file excluded from auto-stage',
          });
        }
        if (safeFiles.length === 0) {
          return { success: true, noop: true };
        }
        // Stage in batches to avoid arg-length limits on Windows
        const BATCH_SIZE = 50;
        for (let i = 0; i < safeFiles.length; i += BATCH_SIZE) {
          const batch = safeFiles.slice(i, i + BATCH_SIZE);
          execFileSync('git', ['add', '--', ...batch], {
            cwd: this.projectDir,
            timeout: 30000,
            stdio: 'pipe',
          });
        }
        // Also add audit log
        execFileSync('git', ['add', '--', auditLogPath], {
          cwd: this.projectDir,
          timeout: 30000,
          stdio: 'pipe',
        });
      } else if (hasPreStagedChanges) {
        execFileSync('git', ['add', '--', auditLogPath], {
          cwd: this.projectDir,
          timeout: 30000,
          stdio: 'pipe',
        });
      } else {
        const changedPaths = statusEntries
          .map((entry) => entry.path)
          .filter(Boolean)
          .join(', ');
        return {
          success: false,
          error: `Refusing to auto-stage all changes. Stage the intended files first or pass explicit paths. Pending changes: ${changedPaths}`,
        };
      }

      // Commit
      execFileSync('git', ['commit', '-m', message], {
        cwd: this.projectDir,
        timeout: 30000,
        stdio: 'pipe',
      });

      // Get short SHA
      const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: this.projectDir,
        encoding: 'utf8',
        timeout: 10000,
        stdio: 'pipe',
      }).trim();

      return { success: true, sha };
    } catch (err) {
      const error = (err.stderr || err.message || '').toString().trim();
      return { success: false, error };
    }
  }

  /**
   * Shared push logic: verify remote, push.
   * @param {string} branch - branch to push
   * @param {string} remote - remote name
   * @param {object} eventData - data for audit log
   * @returns {{ success: boolean, remote?: string, branch?: string, error?: string }}
   */
  _push(branch, remote, eventData) {
    // Verify remote exists
    try {
      execFileSync('git', ['remote', 'get-url', remote], {
        cwd: this.projectDir,
        encoding: 'utf8',
        timeout: 10000,
        stdio: 'pipe',
      });
    } catch {
      const error = `Remote not found: ${remote}`;
      this._logEvent(eventData.operation, { ...eventData, error });
      return { success: false, error };
    }

    // Push
    try {
      execFileSync('git', ['push', '-u', remote, branch], {
        cwd: this.projectDir,
        timeout: 60000,
        stdio: 'pipe',
      });
      this._logEvent(eventData.operation, { ...eventData, remote, branch });
      return { success: true, remote, branch };
    } catch (err) {
      const error = (err.stderr || err.message || '').toString().trim();
      this._logEvent(eventData.operation, { ...eventData, error });
      return { success: false, error };
    }
  }

  /**
   * Check if a local branch exists.
   * @param {string} branch - branch name
   * @returns {boolean}
   */
  _branchExists(branch) {
    try {
      execFileSync('git', ['rev-parse', '--verify', branch], {
        cwd: this.projectDir,
        timeout: 10000,
        stdio: 'pipe',
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Append an event to the git workflow audit log.
   * @param {string} operation - operation name
   * @param {object} data - event data
   */
  _logEvent(operation, data) {
    try {
      if (!fs.existsSync(this.auditDir)) {
        fs.mkdirSync(this.auditDir, { recursive: true });
      }
      const logPath = path.join(this.auditDir, 'git-workflow-events.jsonl');
      const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        operation,
        ...data,
      });
      fs.appendFileSync(logPath, `${entry}\n`);
    } catch {
      /* audit logging is best-effort */
    }
  }
}

// -- Module exports -------------------------------------------

module.exports = { GitWorkflowManager, BRANCH_PREFIX, isSensitiveFile, SENSITIVE_PATTERNS };

// -- CLI ------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '--help') {
    console.log('  CoBolt Git Workflow Manager - milestone branch lifecycle');
    console.log('');
    console.log('  Usage: node tools/cobolt-git-workflow.js <command> [args]');
    console.log('');
    console.log('  Commands:');
    console.log('    create-branch <milestone>                    Create cobolt-build/M{n} branch');
    console.log('    create-work-branch <branch> [--base main]   Create or resume an arbitrary work branch');
    console.log('    commit-milestone <milestone> <summary> [--files a,b] Commit milestone completion');
    console.log('    commit-story <milestone> <storyId> <title> [--files a,b] Commit story implementation');
    console.log('    commit-fix <milestone> <findingId> <desc> [--files a,b] Commit fix');
    console.log('    commit-work <message> [--auto-stage] [--files a,b] Commit arbitrary work');
    console.log('    push-milestone <milestone> [--remote origin] Push milestone branch');
    console.log('    push-current [--remote origin]               Push the current branch');
    console.log('    push-checkpoint <milestone> [--remote origin]Push checkpoint for crash recovery');
    console.log('    merge-to-main <milestone> [--remote origin]  Merge milestone to main');
    console.log('    init-version [version]                       Init greenfield version (default 0.0.1)');
    console.log('    current-version                              Show current package.json version');
    console.log('    status                                       Show current branch status');
    console.log('    --help                                       Show this help');
    process.exit(0);
  }

  const mgr = new GitWorkflowManager();

  /**
   * Parse --remote flag from args, default to 'origin'.
   */
  const parseRemote = (argSlice) => {
    const idx = argSlice.indexOf('--remote');
    return idx >= 0 && argSlice[idx + 1] ? argSlice[idx + 1] : 'origin';
  };

  const parseBase = (argSlice) => {
    const idx = argSlice.indexOf('--base');
    return idx >= 0 && argSlice[idx + 1] ? argSlice[idx + 1] : undefined;
  };

  const parseFiles = (argSlice) => {
    const idx = argSlice.indexOf('--files');
    if (idx < 0 || !argSlice[idx + 1]) return [];
    return argSlice[idx + 1]
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  };

  switch (cmd) {
    case 'create-branch': {
      if (!args[1]) {
        console.error('  Usage: create-branch <milestone>');
        process.exit(1);
      }
      const r = mgr.createMilestoneBranch(args[1]);
      if (r.success) {
        if (r.alreadyExists) {
          console.log(`  \u2713 Resumed milestone branch: ${r.branch}`);
        } else {
          console.log(`  \u2713 Created milestone branch: ${r.branch} (from ${r.base})`);
        }
      } else {
        console.error(`  \u2717 ${r.error}`);
        process.exit(1);
      }
      break;
    }
    case 'create-work-branch': {
      if (!args[1]) {
        console.error('  Usage: create-work-branch <branch> [--base main]');
        process.exit(1);
      }
      const r = mgr.createOrSwitchBranch(args[1], { base: parseBase(args.slice(2)) });
      if (r.success) {
        if (r.alreadyExists) {
          console.log(`  \u2713 Resumed work branch: ${r.branch}`);
        } else {
          console.log(`  \u2713 Created work branch: ${r.branch} (from ${r.base})`);
        }
      } else {
        console.error(`  \u2717 ${r.error}`);
        process.exit(1);
      }
      break;
    }
    case 'commit-milestone': {
      if (!args[1] || !args[2]) {
        console.error('  Usage: commit-milestone <milestone> <summary>');
        process.exit(1);
      }
      const summary = args
        .slice(2)
        .filter((arg, index, all) => !(arg === '--files' || all[index - 1] === '--files'))
        .join(' ');
      const r = mgr.commitMilestone(args[1], summary, { paths: parseFiles(args.slice(2)) });
      if (r.success) {
        if (r.noop) {
          console.log('  - Nothing to commit (working tree clean)');
        } else {
          console.log(`  \u2713 Milestone committed: ${r.sha}`);
        }
      } else {
        console.error(`  \u2717 ${r.error}`);
        process.exit(1);
      }
      break;
    }
    case 'commit-story': {
      if (!args[1] || !args[2] || !args[3]) {
        console.error('  Usage: commit-story <milestone> <storyId> <title>');
        process.exit(1);
      }
      const title = args
        .slice(3)
        .filter((arg, index, all) => !(arg === '--files' || all[index - 1] === '--files'))
        .join(' ');
      const r = mgr.commitStory(args[1], args[2], title, { paths: parseFiles(args.slice(3)) });
      if (r.success) {
        if (r.noop) {
          console.log('  - Nothing to commit (working tree clean)');
        } else {
          console.log(`  \u2713 Story committed: ${args[2]} [${r.sha}]`);
        }
      } else {
        console.error(`  \u2717 ${r.error}`);
        process.exit(1);
      }
      break;
    }
    case 'commit-work': {
      if (!args[1]) {
        console.error('  Usage: commit-work <message> [--auto-stage] [--files a,b]');
        process.exit(1);
      }
      const message = args
        .slice(1)
        .filter((arg, index, all) => !(arg === '--files' || all[index - 1] === '--files') && arg !== '--auto-stage')
        .join(' ');
      const opts = { paths: parseFiles(args.slice(1)) };
      if (args.includes('--auto-stage')) opts.autoStage = true;
      const r = mgr.commitWork(message, opts);
      if (r.success) {
        if (r.noop) {
          console.log('  - Nothing to commit (working tree clean)');
        } else {
          console.log(`  \u2713 Work committed: ${r.sha}`);
        }
      } else {
        console.error(`  \u2717 ${r.error}`);
        process.exit(1);
      }
      break;
    }
    case 'commit-fix': {
      if (!args[1] || !args[2] || !args[3]) {
        console.error('  Usage: commit-fix <milestone> <findingId> <description> [--auto-stage] [--files a,b]');
        process.exit(1);
      }
      const desc = args
        .slice(3)
        .filter((arg, index, all) => !(arg === '--files' || all[index - 1] === '--files') && arg !== '--auto-stage')
        .join(' ');
      const opts = { paths: parseFiles(args.slice(3)) };
      if (args.includes('--auto-stage')) opts.autoStage = true;
      const r = mgr.commitFix(args[1], args[2], desc, opts);
      if (r.success) {
        if (r.noop) {
          console.log('  - Nothing to commit (working tree clean)');
        } else {
          console.log(`  \u2713 Fix committed: ${args[2]} [${r.sha}]`);
        }
      } else {
        console.error(`  \u2717 ${r.error}`);
        process.exit(1);
      }
      break;
    }
    case 'push-current': {
      const remote = parseRemote(args.slice(1));
      const r = mgr.pushCurrentBranch(remote);
      if (r.success) {
        console.log(`  \u2713 Pushed ${r.branch} to ${r.remote}`);
      } else {
        console.error(`  \u2717 Push failed: ${r.error}`);
        process.exit(1);
      }
      break;
    }
    case 'push-milestone': {
      if (!args[1]) {
        console.error('  Usage: push-milestone <milestone> [--remote origin]');
        process.exit(1);
      }
      const remote = parseRemote(args.slice(2));
      const r = mgr.pushMilestone(args[1], remote);
      if (r.success) {
        console.log(`  \u2713 Pushed ${r.branch} to ${r.remote}`);
      } else {
        console.error(`  \u2717 Push failed: ${r.error}`);
        process.exit(1);
      }
      break;
    }
    case 'push-checkpoint': {
      if (!args[1]) {
        console.error('  Usage: push-checkpoint <milestone> [--remote origin]');
        process.exit(1);
      }
      const remote = parseRemote(args.slice(2));
      const r = mgr.pushCheckpoint(args[1], remote);
      if (r.success) {
        console.log(`  \u2713 Checkpoint pushed: ${r.branch} to ${r.remote}`);
      } else {
        console.error(`  \u2717 Checkpoint push failed: ${r.error}`);
        process.exit(1);
      }
      break;
    }
    case 'merge-to-main': {
      if (!args[1]) {
        console.error('  Usage: merge-to-main <milestone> [--remote origin]');
        process.exit(1);
      }
      const remote = parseRemote(args.slice(2));
      const r = mgr.mergeMilestoneToMain(args[1], remote);
      if (r.success) {
        console.log(`  \u2713 Merged ${BRANCH_PREFIX}${args[1]} into main [${r.sha}]`);
      } else {
        console.error(`  \u2717 Merge failed: ${r.error}`);
        if (r.fallback) {
          console.error(`  \u2192 Fallback: ${r.fallback}`);
        }
        process.exit(1);
      }
      break;
    }
    case 'init-version': {
      const version = args[1] || '0.0.1';
      const r = mgr.initGreenfieldVersion(version);
      if (r.success) {
        if (r.initialized) {
          console.log(`  \u2713 Version initialized to ${r.version}`);
        } else {
          console.log(`  - Version already set: ${r.version} (no change)`);
        }
      } else {
        console.error(`  \u2717 ${r.error}`);
        process.exit(1);
      }
      break;
    }
    case 'current-version': {
      const v = mgr.getCurrentVersion();
      console.log(v ? `  v${v}` : '  (no version found)');
      break;
    }
    case 'status': {
      const branch = mgr.getCurrentBranch();
      const dirty = mgr.hasUncommittedChanges();
      console.log(`  Branch: ${branch || '(detached)'}`);
      console.log(`  Uncommitted changes: ${dirty ? 'yes' : 'no'}`);
      if (branch?.startsWith(BRANCH_PREFIX)) {
        const milestone = branch.replace(BRANCH_PREFIX, '');
        console.log(`  Milestone: ${milestone}`);
      }
      const v = mgr.getCurrentVersion();
      if (v) console.log(`  Version: v${v}`);
      break;
    }
    default: {
      console.error(`  Unknown command: ${cmd}`);
      console.error('  Run --help for usage.');
      process.exit(1);
    }
  }
}
