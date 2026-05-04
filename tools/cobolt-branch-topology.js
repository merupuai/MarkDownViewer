#!/usr/bin/env node

// CoBolt Branch Topology - stale-base and overlap checks before PR fan-out.

const { execFileSync } = require('node:child_process');

function git(projectRoot, args) {
  return execFileSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 15000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function isGitRepo(projectRoot = process.cwd()) {
  try {
    return git(projectRoot, ['rev-parse', '--is-inside-work-tree']) === 'true';
  } catch {
    return false;
  }
}

function currentBranch(projectRoot = process.cwd()) {
  return git(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

function refExists(projectRoot, ref) {
  try {
    git(projectRoot, ['rev-parse', '--verify', ref]);
    return true;
  } catch {
    return false;
  }
}

function changedFiles(projectRoot, baseRef, headRef) {
  if (!refExists(projectRoot, baseRef) || !refExists(projectRoot, headRef)) return [];
  const mergeBase = git(projectRoot, ['merge-base', baseRef, headRef]);
  const output = git(projectRoot, ['diff', '--name-only', `${mergeBase}...${headRef}`]);
  return output
    ? output
        .split(/\r?\n/)
        .filter(Boolean)
        .map((file) => file.replaceAll('\\', '/'))
    : [];
}

function commitsBehind(projectRoot, baseRef, headRef) {
  if (!refExists(projectRoot, baseRef) || !refExists(projectRoot, headRef)) return 0;
  const output = git(projectRoot, ['rev-list', '--count', `${headRef}..${baseRef}`]);
  return Number.parseInt(output, 10) || 0;
}

function detectOverlappingChangedFiles(changeMap) {
  const owners = new Map();
  const overlaps = [];
  for (const [branch, files] of Object.entries(changeMap || {})) {
    for (const file of files || []) {
      const normalized = String(file).replaceAll('\\', '/');
      if (owners.has(normalized)) {
        overlaps.push({ file: normalized, branches: [owners.get(normalized), branch] });
      } else {
        owners.set(normalized, branch);
      }
    }
  }
  return overlaps;
}

function checkBranchTopology(projectRoot = process.cwd(), options = {}) {
  const issues = [];
  const warnings = [];
  if (!isGitRepo(projectRoot)) {
    return { passed: true, skipped: 'not-a-git-repo', issues, warnings };
  }

  const base = options.base || 'main';
  const head = options.head || currentBranch(projectRoot);
  const siblings = options.siblings || [];
  const maxBehind = Number(options.maxBehind ?? 0);

  if (!refExists(projectRoot, base)) {
    return { passed: true, skipped: `base-ref-missing:${base}`, issues, warnings };
  }
  if (!refExists(projectRoot, head)) {
    issues.push(`Head branch/ref does not exist: ${head}`);
  }

  const behind = issues.length === 0 ? commitsBehind(projectRoot, base, head) : 0;
  if (behind > maxBehind) {
    issues.push(`${head} is ${behind} commit(s) behind ${base}; rebase/merge base before opening PR.`);
  }

  const changeMap = {};
  if (issues.length === 0) changeMap[head] = changedFiles(projectRoot, base, head);
  for (const sibling of siblings) {
    if (!refExists(projectRoot, sibling)) {
      warnings.push(`Sibling branch/ref missing: ${sibling}`);
      continue;
    }
    changeMap[sibling] = changedFiles(projectRoot, base, sibling);
  }

  const overlaps = detectOverlappingChangedFiles(changeMap).filter((overlap) => overlap.branches.includes(head));
  for (const overlap of overlaps) {
    issues.push(`File ${overlap.file} is modified by overlapping branches: ${overlap.branches.join(', ')}.`);
  }

  return {
    passed: issues.length === 0,
    issues,
    warnings,
    base,
    head,
    siblings,
    behind,
    changeMap,
    overlaps,
  };
}

function parseList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'check';
  const json = argv.includes('--json');
  const baseIndex = argv.indexOf('--base');
  const headIndex = argv.indexOf('--head');
  const siblingsIndex = argv.indexOf('--siblings');
  const maxBehindIndex = argv.indexOf('--max-behind');

  if (command !== 'check') {
    console.error(
      'Usage: node tools/cobolt-branch-topology.js check [--base main] [--head branch] [--siblings a,b] [--json]',
    );
    process.exit(2);
  }

  const report = checkBranchTopology(process.cwd(), {
    base: baseIndex !== -1 ? argv[baseIndex + 1] : 'main',
    head: headIndex !== -1 ? argv[headIndex + 1] : null,
    siblings: siblingsIndex !== -1 ? parseList(argv[siblingsIndex + 1]) : [],
    maxBehind: maxBehindIndex !== -1 ? Number.parseInt(argv[maxBehindIndex + 1], 10) : 0,
  });

  if (json) console.log(JSON.stringify(report, null, 2));
  else if (report.passed) console.log('[cobolt-branch-topology] Branch topology passed.');
  else for (const issue of report.issues) console.error(`[cobolt-branch-topology] ${issue}`);
  process.exit(report.passed ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  changedFiles,
  checkBranchTopology,
  commitsBehind,
  detectOverlappingChangedFiles,
  isGitRepo,
};
