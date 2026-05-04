#!/usr/bin/env node

// CoBolt RCA Diff — Deterministic before/after code extraction
//
// Extracts before/after code snippets from git diff for RCA documents.
// Replaces LLM-driven code reading in Step 6 of cobolt-fix.
//
// Usage:
//   node tools/cobolt-rca-diff.js extract [--base HEAD~1] [--context 5]     # Extract diffs
//   node tools/cobolt-rca-diff.js extract --tracker <path>                    # From tracker files
//   node tools/cobolt-rca-diff.js extract --json                              # Machine-readable
//   node tools/cobolt-rca-diff.js format --tracker <path>                     # Markdown-formatted
//
// Exit codes:
//   0 = diffs extracted
//   1 = no changes found
//   2 = usage error

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// ── Git Diff Extraction ─────────────────────────────────────

function getChangedFiles(base) {
  try {
    const output = execFileSync('git', ['diff', '--name-only', base], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10000,
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function getFileDiff(file, base, contextLines) {
  try {
    const diff = execFileSync('git', ['diff', `-U${contextLines}`, base, '--', file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10000,
    });
    return diff;
  } catch {
    return '';
  }
}

function getFileContentBefore(file, base) {
  try {
    return execFileSync('git', ['show', `${base}:${file}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10000,
    });
  } catch {
    return null; // File didn't exist before
  }
}

function getFileContentAfter(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null; // File was deleted
  }
}

// ── Snippet Extraction ──────────────────────────────────────

function extractSnippets(file, base, contextLines) {
  const diff = getFileDiff(file, base, contextLines);
  if (!diff) return null;

  // Parse unified diff into hunks
  const hunks = [];
  const lines = diff.split('\n');
  let currentHunk = null;

  for (const line of lines) {
    const hunkHeader = line.match(/^@@\s+-(\d+),?\d*\s+\+(\d+),?\d*\s+@@(.*)/);
    if (hunkHeader) {
      if (currentHunk) hunks.push(currentHunk);
      currentHunk = {
        beforeStart: parseInt(hunkHeader[1], 10),
        afterStart: parseInt(hunkHeader[2], 10),
        context: hunkHeader[3].trim(),
        before: [],
        after: [],
      };
      continue;
    }
    if (!currentHunk) continue;

    if (line.startsWith('-')) {
      currentHunk.before.push(line.slice(1));
    } else if (line.startsWith('+')) {
      currentHunk.after.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      currentHunk.before.push(line.slice(1));
      currentHunk.after.push(line.slice(1));
    }
  }
  if (currentHunk) hunks.push(currentHunk);

  return {
    file,
    hunks,
    isNew: !getFileContentBefore(file, base),
    isDeleted: !getFileContentAfter(file),
  };
}

// ── Tracker Integration ─────────────────────────────────────

function getFilesFromTracker(trackerPath) {
  if (!fs.existsSync(trackerPath)) return [];
  const tracker = JSON.parse(fs.readFileSync(trackerPath, 'utf8'));
  const files = new Set();
  for (const f of tracker.findings || []) {
    for (const candidate of [
      f.file,
      f.path,
      f.location,
      f.location?.file,
      f.location?.path,
      ...(Array.isArray(f.files) ? f.files : []),
    ]) {
      if (typeof candidate === 'string' && candidate.trim()) {
        files.add(candidate.trim().replace(/\\/g, '/'));
      }
    }
  }
  return [...files];
}

// ── Markdown Formatter ──────────────────────────────────────

function formatAsMarkdown(snippets) {
  const lines = [];
  lines.push('## Before / After Code Changes');
  lines.push('');

  for (const snippet of snippets) {
    if (!snippet || snippet.hunks.length === 0) continue;

    const ext = path.extname(snippet.file).replace('.', '') || 'text';
    lines.push(`### ${snippet.file}`);
    lines.push('');

    if (snippet.isNew) {
      lines.push('> New file');
    } else if (snippet.isDeleted) {
      lines.push('> Deleted file');
    }

    for (const hunk of snippet.hunks) {
      if (hunk.context) lines.push(`*${hunk.context}*`);
      lines.push('');

      if (hunk.before.length > 0 && !snippet.isNew) {
        lines.push('**Before:**');
        lines.push(`\`\`\`${ext}`);
        lines.push(hunk.before.join('\n'));
        lines.push('```');
        lines.push('');
      }

      if (hunk.after.length > 0 && !snippet.isDeleted) {
        lines.push('**After:**');
        lines.push(`\`\`\`${ext}`);
        lines.push(hunk.after.join('\n'));
        lines.push('```');
        lines.push('');
      }
    }
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

// ── CLI ─────────────────────────────────────────────────────

function cmdExtract(args) {
  const baseIdx = args.indexOf('--base');
  const base = baseIdx !== -1 && args[baseIdx + 1] ? args[baseIdx + 1] : 'HEAD~1';
  const ctxIdx = args.indexOf('--context');
  const contextLines = ctxIdx !== -1 && args[ctxIdx + 1] ? parseInt(args[ctxIdx + 1], 10) : 5;
  const trackerIdx = args.indexOf('--tracker');
  const trackerPath = trackerIdx !== -1 && args[trackerIdx + 1] ? args[trackerIdx + 1] : null;
  const jsonMode = args.includes('--json');

  let files;
  if (trackerPath) {
    files = getFilesFromTracker(trackerPath);
  } else {
    files = getChangedFiles(base);
  }

  if (files.length === 0) {
    console.log('[cobolt-rca-diff] No changed files found.');
    process.exit(1);
  }

  const snippets = files.map((f) => extractSnippets(f, base, contextLines)).filter(Boolean);

  const result = {
    base,
    contextLines,
    fileCount: files.length,
    hunkCount: snippets.reduce((sum, s) => sum + s.hunks.length, 0),
    snippets,
    timestamp: new Date().toISOString(),
    generatedBy: 'cobolt-rca-diff',
  };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[cobolt-rca-diff] Extracted ${result.hunkCount} hunks from ${result.fileCount} files (base: ${base})`);
    for (const s of snippets) {
      console.log(`  ${s.file}: ${s.hunks.length} hunks${s.isNew ? ' (new)' : ''}${s.isDeleted ? ' (deleted)' : ''}`);
    }
  }

  process.exit(0);
}

function cmdFormat(args) {
  const baseIdx = args.indexOf('--base');
  const base = baseIdx !== -1 && args[baseIdx + 1] ? args[baseIdx + 1] : 'HEAD~1';
  const ctxIdx = args.indexOf('--context');
  const contextLines = ctxIdx !== -1 && args[ctxIdx + 1] ? parseInt(args[ctxIdx + 1], 10) : 5;
  const trackerIdx = args.indexOf('--tracker');
  const trackerPath = trackerIdx !== -1 && args[trackerIdx + 1] ? args[trackerIdx + 1] : null;

  let files;
  if (trackerPath) {
    files = getFilesFromTracker(trackerPath);
  } else {
    files = getChangedFiles(base);
  }

  const snippets = files.map((f) => extractSnippets(f, base, contextLines)).filter(Boolean);
  console.log(formatAsMarkdown(snippets));
  process.exit(0);
}

const [, , command, ...args] = process.argv;

switch (command) {
  case 'extract':
    cmdExtract(args);
    break;
  case 'format':
    cmdFormat(args);
    break;
  default:
    console.log('CoBolt RCA Diff — Deterministic before/after code extraction');
    console.log('');
    console.log('Usage:');
    console.log('  node tools/cobolt-rca-diff.js extract [--base HEAD~1] [--context 5] [--tracker <path>] [--json]');
    console.log('  node tools/cobolt-rca-diff.js format [--base HEAD~1] [--tracker <path>]');
    console.log('');
    console.log('Extracts git diffs as before/after code blocks for RCA documents.');
    process.exit(command ? 2 : 0);
}

module.exports = { extractSnippets, formatAsMarkdown, getChangedFiles };
