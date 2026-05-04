#!/usr/bin/env node

// CoBolt Git Utilities — branch management, hotfix, PR operations
//
// Usage:
//   node tools/cobolt-git.js branch-create <name> [--base main]  # Create feature branch
//   node tools/cobolt-git.js hotfix-create <name>                 # Create hotfix branch from main
//   node tools/cobolt-git.js hotfix-ship <name>                   # Merge hotfix to main
//   node tools/cobolt-git.js pr-info <number>                     # Get PR info (requires gh)
//   node tools/cobolt-git.js pr-list                              # List open PRs
//   node tools/cobolt-git.js changelog [--from tag] [--to HEAD]   # Generate changelog
//   node tools/cobolt-git.js contributors                         # List contributors
//   node tools/cobolt-git.js stats                                # Repository statistics

const { execFileSync } = require('node:child_process');

class GitUtils {
  constructor(projectDir) {
    this.projectDir = projectDir || process.cwd();
  }

  _git(args, opts = {}) {
    try {
      return {
        success: true,
        output: execFileSync('git', args, {
          cwd: this.projectDir,
          encoding: 'utf8',
          timeout: opts.timeout || 30000,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim(),
      };
    } catch (err) {
      return { success: false, output: (err.stderr || err.stdout || '').trim(), code: err.status };
    }
  }

  _gh(args) {
    try {
      return {
        success: true,
        output: execFileSync('gh', args, {
          cwd: this.projectDir,
          encoding: 'utf8',
          timeout: 30000,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim(),
      };
    } catch (err) {
      return { success: false, output: (err.stderr || '').trim() };
    }
  }

  hasGh() {
    const r = this._gh(['--version']);
    return r.success;
  }

  /**
   * Get current branch name.
   */
  currentBranch() {
    const r = this._git(['rev-parse', '--abbrev-ref', 'HEAD']);
    return r.success ? r.output : null;
  }

  /**
   * Create a feature branch.
   */
  branchCreate(name, options = {}) {
    const base = options.base || 'main';
    const r = this._git(['checkout', '-b', name, base]);
    if (r.success) return { success: true, branch: name, base };
    return { success: false, error: r.output };
  }

  /**
   * Create a hotfix branch from main/master.
   */
  hotfixCreate(name) {
    const branchName = `hotfix/${name}`;
    // Ensure we're up to date
    this._git(['fetch', 'origin', 'main'], { timeout: 60000 });
    const r = this._git(['checkout', '-b', branchName, 'origin/main']);
    if (r.success) return { success: true, branch: branchName };
    return { success: false, error: r.output };
  }

  /**
   * Merge hotfix branch back to main.
   */
  hotfixShip(name) {
    const branchName = `hotfix/${name}`;
    const results = [];

    // Switch to main
    let r = this._git(['checkout', 'main']);
    if (!r.success) return { success: false, error: `Cannot switch to main: ${r.output}` };

    // Pull latest
    r = this._git(['pull', 'origin', 'main'], { timeout: 60000 });
    results.push({ step: 'pull', ...r });

    // Merge hotfix
    r = this._git(['merge', '--no-ff', branchName, '-m', `fix: merge hotfix/${name}`]);
    if (!r.success) return { success: false, error: `Merge conflict: ${r.output}`, step: 'merge' };
    results.push({ step: 'merge', ...r });

    return { success: true, branch: branchName, results };
  }

  /**
   * Get PR info via gh CLI.
   */
  prInfo(number) {
    if (!this.hasGh()) return { success: false, error: 'gh CLI not available' };
    const r = this._gh([
      'pr',
      'view',
      String(number),
      '--json',
      'number,title,state,author,url,body,labels,reviewDecision',
    ]);
    if (r.success) {
      try {
        return { success: true, data: JSON.parse(r.output) };
      } catch {
        /* parse error */
      }
    }
    return { success: false, error: r.output };
  }

  /**
   * List open PRs.
   */
  prList() {
    if (!this.hasGh()) return { success: false, error: 'gh CLI not available' };
    const r = this._gh(['pr', 'list', '--json', 'number,title,state,author,url']);
    if (r.success) {
      try {
        return { success: true, data: JSON.parse(r.output) };
      } catch {
        /* parse error */
      }
    }
    return { success: false, error: r.output };
  }

  /**
   * Generate changelog between two refs.
   */
  changelog(options = {}) {
    const from = options.from;
    const to = options.to || 'HEAD';
    const range = from ? `${from}..${to}` : '';
    const args = ['log', '--pretty=format:%h %s (%an)', '--no-merges'];
    if (range) args.push(range);
    args.push('--', '.'); // limit to current dir

    const r = this._git(args);
    if (!r.success) return [];

    return r.output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\w+) (.+) \((.+)\)$/);
        return match ? { hash: match[1], message: match[2], author: match[3] } : { raw: line };
      });
  }

  /**
   * List contributors.
   */
  contributors() {
    const r = this._git(['shortlog', '-sn', '--no-merges', 'HEAD']);
    if (!r.success) return [];
    return r.output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        return match ? { commits: parseInt(match[1], 10), name: match[2] } : null;
      })
      .filter(Boolean);
  }

  /**
   * Repository statistics.
   */
  stats() {
    const branch = this.currentBranch();
    const logR = this._git(['rev-list', '--count', 'HEAD']);
    const tagR = this._git(['tag', '--list']);
    const remoteR = this._git(['remote', '-v']);

    return {
      branch,
      totalCommits: logR.success ? parseInt(logR.output, 10) : 0,
      tags: tagR.success ? tagR.output.split('\n').filter(Boolean) : [],
      remotes: remoteR.success ? remoteR.output : '',
      contributors: this.contributors(),
    };
  }
}

// ── Module exports ───────────────────────────────────────────

module.exports = { GitUtils };

// ── CLI ──────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '--help') {
    console.log('  Usage: node tools/cobolt-git.js <command> [args]');
    console.log(
      '  Commands: branch-create, hotfix-create, hotfix-ship, pr-info, pr-list, changelog, contributors, stats',
    );
    process.exit(0);
  }

  const git = new GitUtils();

  switch (cmd) {
    case 'branch-create': {
      if (!args[1]) {
        console.error('  Usage: branch-create <name> [--base main]');
        process.exit(1);
      }
      const options = {};
      if (args[2] === '--base' && args[3]) options.base = args[3];
      const r = git.branchCreate(args[1], options);
      console.log(r.success ? `  \u2713 Branch: ${r.branch}` : `  \u2717 ${r.error}`);
      break;
    }
    case 'hotfix-create': {
      if (!args[1]) {
        console.error('  Usage: hotfix-create <name>');
        process.exit(1);
      }
      const r = git.hotfixCreate(args[1]);
      console.log(r.success ? `  \u2713 Hotfix branch: ${r.branch}` : `  \u2717 ${r.error}`);
      break;
    }
    case 'hotfix-ship': {
      if (!args[1]) {
        console.error('  Usage: hotfix-ship <name>');
        process.exit(1);
      }
      const r = git.hotfixShip(args[1]);
      console.log(r.success ? `  \u2713 Hotfix merged: ${r.branch}` : `  \u2717 ${r.error}`);
      break;
    }
    case 'pr-info': {
      if (!args[1]) {
        console.error('  Usage: pr-info <number>');
        process.exit(1);
      }
      const r = git.prInfo(args[1]);
      console.log(r.success ? JSON.stringify(r.data, null, 2) : `  \u2717 ${r.error}`);
      break;
    }
    case 'pr-list': {
      const r = git.prList();
      if (r.success) {
        for (const pr of r.data) console.log(`  #${pr.number} ${pr.title} (${pr.author.login})`);
      } else {
        console.log(`  \u2717 ${r.error}`);
      }
      break;
    }
    case 'changelog': {
      const options = {};
      if (args[1] === '--from' && args[2]) options.from = args[2];
      if (args[3] === '--to' && args[4]) options.to = args[4];
      const entries = git.changelog(options);
      for (const e of entries) console.log(`  ${e.hash || ''} ${e.message || e.raw}`);
      break;
    }
    case 'contributors': {
      const contribs = git.contributors();
      for (const c of contribs) console.log(`  ${String(c.commits).padStart(5)} ${c.name}`);
      break;
    }
    case 'stats': {
      console.log(JSON.stringify(git.stats(), null, 2));
      break;
    }
    default:
      console.error(`  Unknown command: ${cmd}`);
      process.exit(1);
  }
}
