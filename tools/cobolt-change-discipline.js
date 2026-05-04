#!/usr/bin/env node

// CoBolt Change Discipline
//
// Deterministic diff analysis for CoBolt's native coding-discipline layer.
// The tool is advisory by default and highlights broad changes, speculative
// abstractions, added TODO debt, scope drift, and source edits without tests.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DEFAULTS = {
  maxFiles: 8,
  maxChangedLines: 400,
};

const TODO_RE = /^(?:\s*(?:\/\/|#|\/\*|\*|--|-)\s*)?(?:TODO|FIXME|HACK|XXX)\b(?::|$|\s)/i;
const COMMENT_RE = /^(?:\/\/|#|\/\*|\*|--|<!--)/;
const TEST_FILE_RE = /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|(?:\.test\.|\.spec\.)/i;
const SOURCE_FILE_RE = /\.(?:c|cc|cpp|cs|ex|exs|go|java|js|jsx|kt|php|py|rb|rs|scala|swift|ts|tsx)$/i;
const ABSTRACTION_PATTERNS = [
  {
    type: 'abstract-declaration',
    regex: /\b(?:abstract\s+class|interface|protocol|trait)\b/i,
    reason: 'Adds a new abstraction declaration',
  },
  {
    type: 'heavy-type-name',
    regex:
      /\b[A-Z][A-Za-z0-9]*(?:Factory|Strategy|Builder|Registry|Coordinator|Provider|Adapter|Facade|Manager|Wrapper|Orchestrator)\b/,
    reason: 'Introduces a heavy abstraction-style type name',
  },
  {
    type: 'options-surface',
    regex: /\b[A-Z][A-Za-z0-9]*Options\b/,
    reason: 'Adds a new options/configuration surface',
  },
];
const HEAVY_FILENAME_RE =
  /(?:Factory|Strategy|Builder|Registry|Coordinator|Provider|Adapter|Facade|Manager|Wrapper|Orchestrator|Options)\.[^.]+$/;

function normalizeFilePath(filePath) {
  return String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/^(?:a|b)\//, '');
}

function isTestFile(filePath) {
  return TEST_FILE_RE.test(normalizeFilePath(filePath));
}

function isSourceFile(filePath) {
  return SOURCE_FILE_RE.test(normalizeFilePath(filePath));
}

function isCommentLine(line) {
  const trimmed = String(line || '').trim();
  return trimmed === '' || COMMENT_RE.test(trimmed);
}

function parseUnifiedDiff(diffText) {
  const files = [];
  const lines = String(diffText || '').split(/\r?\n/);
  let current = null;

  function flushCurrent() {
    if (!current) return;
    current.file = normalizeFilePath(current.newFile || current.oldFile || current.file);
    if (!current.file) return;
    files.push({
      file: current.file,
      added: current.added.slice(),
      removed: current.removed.slice(),
    });
  }

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flushCurrent();
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      current = {
        oldFile: match ? match[1] : null,
        newFile: match ? match[2] : null,
        added: [],
        removed: [],
      };
      continue;
    }

    if (!current) continue;

    if (line.startsWith('--- ')) {
      const value = line.slice(4).trim();
      if (value !== '/dev/null') current.oldFile = normalizeFilePath(value);
      continue;
    }

    if (line.startsWith('+++ ')) {
      const value = line.slice(4).trim();
      if (value !== '/dev/null') current.newFile = normalizeFilePath(value);
      continue;
    }

    if (line.startsWith('@@ ')) {
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.added.push(line.slice(1));
      continue;
    }

    if (line.startsWith('-') && !line.startsWith('---')) {
      current.removed.push(line.slice(1));
    }
  }

  flushCurrent();
  return files;
}

function loadScopeRules(filePath) {
  if (!filePath) return [];
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];

  if (raw.startsWith('[') || raw.startsWith('{')) {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed.allowed || parsed.paths || [];
    return list.map(normalizeFilePath).filter(Boolean);
  }

  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map(normalizeFilePath);
}

function matchesScope(filePath, rules) {
  const normalized = normalizeFilePath(filePath);
  return rules.some((rule) => normalized === rule || normalized.startsWith(rule.endsWith('/') ? rule : `${rule}/`));
}

function collectAbstractionHits(filePath, addedLines) {
  const hits = [];
  const fileName = path.posix.basename(normalizeFilePath(filePath));

  if (HEAVY_FILENAME_RE.test(fileName)) {
    hits.push({
      type: 'heavy-file-name',
      reason: 'File name introduces a heavy abstraction surface',
      snippet: fileName,
    });
  }

  for (const line of addedLines) {
    const trimmed = line.trim();
    if (!trimmed || isCommentLine(trimmed)) continue;
    for (const pattern of ABSTRACTION_PATTERNS) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(trimmed)) {
        hits.push({
          type: pattern.type,
          reason: pattern.reason,
          snippet: trimmed.slice(0, 140),
        });
      }
    }
  }

  const seen = new Set();
  return hits.filter((hit) => {
    const key = `${hit.type}:${hit.snippet}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarizeFileChange(file) {
  const addedCodeLines = file.added.filter((line) => !isCommentLine(line)).length;
  const removedCodeLines = file.removed.filter((line) => !isCommentLine(line)).length;
  const todoHits = file.added.filter((line) => TODO_RE.test(line)).map((line) => line.trim().slice(0, 140));

  return {
    file: normalizeFilePath(file.file),
    addedLines: file.added.length,
    removedLines: file.removed.length,
    addedCodeLines,
    removedCodeLines,
    isSourceFile: isSourceFile(file.file),
    isTestFile: isTestFile(file.file),
    abstractionHits: collectAbstractionHits(file.file, file.added),
    todoHits,
  };
}

function analyzeDiffText(diffText, options = {}) {
  const parsed = parseUnifiedDiff(diffText).map(summarizeFileChange);
  const scopeRules = options.scopeRules || [];
  const maxFiles = Number(options.maxFiles || DEFAULTS.maxFiles);
  const maxChangedLines = Number(options.maxChangedLines || DEFAULTS.maxChangedLines);
  const warnings = [];

  const changedFiles = parsed.filter((file) => file.addedLines > 0 || file.removedLines > 0);
  const totals = changedFiles.reduce(
    (acc, file) => {
      acc.addedLines += file.addedLines;
      acc.removedLines += file.removedLines;
      return acc;
    },
    { addedLines: 0, removedLines: 0 },
  );
  const changedLineCount = totals.addedLines + totals.removedLines;

  if (changedFiles.length > maxFiles) {
    warnings.push({
      type: 'broad-change-set',
      severity: changedFiles.length > maxFiles * 2 ? 'high' : 'medium',
      message: `Change touches ${changedFiles.length} files (threshold ${maxFiles}). Verify the diff is still surgical.`,
    });
  }

  if (changedLineCount > maxChangedLines) {
    warnings.push({
      type: 'large-delta',
      severity: changedLineCount > maxChangedLines * 2 ? 'high' : 'medium',
      message: `Change modifies ${changedLineCount} lines (threshold ${maxChangedLines}). Re-check whether the implementation can be smaller.`,
    });
  }

  const sourceChanges = changedFiles.filter((file) => file.isSourceFile && !file.isTestFile);
  const testChanges = changedFiles.filter((file) => file.isTestFile);
  if (sourceChanges.length > 0 && testChanges.length === 0) {
    warnings.push({
      type: 'source-without-tests',
      severity: 'medium',
      message: `Source files changed (${sourceChanges.length}) without matching test updates. Confirm coverage is intentional.`,
    });
  }

  for (const file of changedFiles) {
    if (scopeRules.length > 0 && !matchesScope(file.file, scopeRules)) {
      warnings.push({
        type: 'scope-drift',
        severity: 'high',
        file: file.file,
        message: `${file.file} is outside the declared change scope.`,
      });
    }

    if (file.abstractionHits.length > 0) {
      warnings.push({
        type: 'speculative-abstraction',
        severity: file.abstractionHits.length >= 2 ? 'high' : 'medium',
        file: file.file,
        message: `${file.file} introduces abstraction-heavy additions. Confirm the task truly needs them.`,
        evidence: file.abstractionHits,
      });
    }

    if (file.todoHits.length > 0) {
      warnings.push({
        type: 'todo-debt',
        severity: 'medium',
        file: file.file,
        message: `${file.file} adds TODO/FIXME/HACK markers. Prefer complete behavior or explicit carry-forward tracking.`,
        evidence: file.todoHits,
      });
    }
  }

  const summary = {
    changedFiles: changedFiles.length,
    addedLines: totals.addedLines,
    removedLines: totals.removedLines,
    changedLines: changedLineCount,
    sourceFiles: sourceChanges.length,
    testFiles: testChanges.length,
  };

  const highCount = warnings.filter((warning) => warning.severity === 'high').length;
  const status = highCount > 0 ? 'needs-review' : warnings.length > 0 ? 'warn' : 'pass';

  return {
    status,
    summary,
    files: changedFiles,
    warnings,
  };
}

function renderReport(result) {
  const lines = [
    '# CoBolt Change Discipline',
    '',
    `- Status: ${result.status}`,
    `- Files Changed: ${result.summary.changedFiles}`,
    `- Lines Changed: ${result.summary.changedLines} (+${result.summary.addedLines} / -${result.summary.removedLines})`,
    `- Source Files: ${result.summary.sourceFiles}`,
    `- Test Files: ${result.summary.testFiles}`,
    '',
  ];

  if (result.warnings.length === 0) {
    lines.push('No discipline warnings detected.');
    return `${lines.join('\n')}\n`;
  }

  lines.push('## Warnings', '');
  for (const warning of result.warnings) {
    const prefix = warning.file ? `${warning.file}: ` : '';
    lines.push(`- [${warning.severity}] ${prefix}${warning.message}`);
  }

  return `${lines.join('\n')}\n`;
}

function collectGitDiff(projectDir, options = {}) {
  const commands = [];
  if (options.base) {
    commands.push(['diff', '--no-ext-diff', '--unified=0', '--relative', options.base]);
  } else {
    commands.push(['diff', '--cached', '--no-ext-diff', '--unified=0', '--relative']);
    commands.push(['diff', '--no-ext-diff', '--unified=0', '--relative']);
  }

  const chunks = [];
  for (const args of commands) {
    try {
      const output = execFileSync('git', args, {
        cwd: projectDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (output.trim()) chunks.push(output.trim());
    } catch {
      if (options.base) {
        throw new Error(`Unable to read git diff for base "${options.base}"`);
      }
    }
  }
  return chunks.join('\n');
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      index++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function runCheck(projectDir = process.cwd(), options = {}) {
  const diffText = options.diffText
    ? String(options.diffText)
    : options.diffFile
      ? fs.readFileSync(options.diffFile, 'utf8')
      : collectGitDiff(projectDir, options);
  const scopeRules = options.scopeRules || loadScopeRules(options.scopeFile);
  const result = analyzeDiffText(diffText, {
    maxFiles: options.maxFiles,
    maxChangedLines: options.maxChangedLines,
    scopeRules,
  });
  return {
    ...result,
    diffEmpty: !diffText.trim(),
  };
}

function printUsage() {
  console.log(`
CoBolt Change Discipline

Usage:
  node tools/cobolt-change-discipline.js check [--base <ref>] [--scope-file <path>] [--json]
  node tools/cobolt-change-discipline.js check --diff-file <path> [--strict]

Options:
  --base <ref>         Compare current tree against a git ref
  --diff-file <path>   Analyze a unified diff from disk
  --scope-file <path>  JSON array or newline list of allowed path prefixes
  --max-files <n>      Override file-count threshold (default 8)
  --max-lines <n>      Override changed-line threshold (default 400)
  --json               Print JSON instead of Markdown
  --strict             Exit 1 when high-severity warnings are present
`);
}

function main(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv);
  const command = args._[0] || 'check';

  if (command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    return 0;
  }

  if (command !== 'check') {
    console.error(`Unknown command: ${command}`);
    printUsage();
    return 1;
  }

  let result;
  try {
    result = runCheck(options.projectDir || process.cwd(), {
      diffFile: args['diff-file'],
      base: args.base,
      scopeFile: args['scope-file'],
      maxFiles: args['max-files'],
      maxChangedLines: args['max-lines'],
      diffText: options.diffText,
      scopeRules: options.scopeRules,
    });
  } catch (error) {
    console.error(`[cobolt-change-discipline] ${error.message}`);
    return 1;
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    process.stdout.write(renderReport(result));
  }

  if (args.strict && result.warnings.some((warning) => warning.severity === 'high')) {
    return 1;
  }
  return 0;
}

module.exports = {
  DEFAULTS,
  parseUnifiedDiff,
  loadScopeRules,
  isTestFile,
  isSourceFile,
  analyzeDiffText,
  renderReport,
  runCheck,
  main,
};

if (require.main === module) {
  process.exit(main());
}
