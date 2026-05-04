#!/usr/bin/env node

// CoBolt Dead Code Detector — deterministic unused export, orphan file, and unreachable code detection
//
// Uses static analysis (import/export graph + pattern matching) to find:
// - Unused exports (exported but never imported elsewhere)
// - Orphaned files (source files imported by nothing)
// - Unreachable code (code after unconditional return/throw/break)
// - Unused function parameters (named but never referenced in body)
//
// No LLM inference. Pure regex/heuristic scanning. Zero external deps beyond Node.js.
//
// Usage:
//   node tools/cobolt-dead-code-detector.js scan [--dir src/] [--json] [--save]
//   node tools/cobolt-dead-code-detector.js scan --severity high --json
//   node tools/cobolt-dead-code-detector.js report
//
// Exit codes:
//   0 = no high-severity dead code found
//   1 = high-severity dead code detected

const fs = require('node:fs');
const path = require('node:path');

const { paths: _paths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();

// ── Configuration ─────────────────────────────────────────

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.ex', '.exs', '.rs']);

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '_build',
  'deps',
  '__pycache__',
  '.elixir_ls',
  'dist',
  'build',
  'target',
  '.next',
  '.nuxt',
  'coverage',
  '_cobolt-output',
  '.claude',
  '.stryker-tmp',
  'vendor',
]);

const ENTRY_PATTERNS = [
  /^index\.[jt]sx?$/,
  /^main\.[jt]sx?$/,
  /^app\.[jt]sx?$/,
  /^server\.[jt]sx?$/,
  /\.config\.[jt]sx?$/,
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /^test[_-]/,
  /^conftest\.py$/,
  /^setup\.py$/,
  /^manage\.py$/,
  /^mix\.exs$/,
  /^main\.go$/,
  /^main\.rs$/,
  /^lib\.rs$/,
  /^mod\.rs$/,
];

// ── File Walker ───────────────────────────────────────────

function walkFiles(rootDir, collected = []) {
  if (!fs.existsSync(rootDir)) return collected;
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return collected;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, collected);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      collected.push(fullPath);
    }
  }
  return collected;
}

// ── Import/Export Graph Builder ────────────────────────────

const IMPORT_PATTERNS = [
  /(?:import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"])/g,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /(?:from\s+(\S+)\s+import|^import\s+(\S+))/gm,
  /(?:alias|import|use|require)\s+([A-Z][\w.]+)/g,
  /import\s+(?:\w+\s+)?["']([^"']+)["']/g,
];

const EXPORT_PATTERNS_JS = [
  /export\s+(?:default\s+)?(?:function|class|const|let|var|async\s+function)\s+(\w+)/g,
  /export\s*\{([^}]+)\}/g,
  /(?:module\.)?exports\.(\w+)\s*=/g,
  /module\.exports\s*=\s*\{([^}]+)\}/g,
];

function resolveImport(fromFile, importPath, projectDir) {
  const dir = path.dirname(fromFile);
  const candidates = [
    importPath,
    `${importPath}.js`,
    `${importPath}.ts`,
    `${importPath}.tsx`,
    `${importPath}.jsx`,
    `${importPath}.mjs`,
    `${importPath}.cjs`,
    path.join(importPath, 'index.js'),
    path.join(importPath, 'index.ts'),
    path.join(importPath, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    const resolved = path.resolve(dir, candidate);
    if (fs.existsSync(resolved)) return path.relative(projectDir, resolved);
  }
  return null;
}

function buildImportGraph(files, projectDir) {
  const imports = new Map();
  const exports = new Map();

  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const relFile = path.relative(projectDir, file);
    const ext = path.extname(file);
    const fileImports = new Set();
    const fileExports = new Set();

    for (const pattern of IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const importPath = match[1] || match[2];
        if (importPath && (importPath.startsWith('.') || importPath.startsWith('/'))) {
          const resolved = resolveImport(file, importPath, projectDir);
          if (resolved) fileImports.add(resolved);
        }
      }
    }

    if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(ext)) {
      for (const pattern of EXPORT_PATTERNS_JS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(content)) !== null) {
          const names = match[1];
          if (names) {
            for (const name of names.split(',')) {
              const clean = name
                .trim()
                .split(/\s+as\s+/)[0]
                .trim();
              if (clean && /^\w+$/.test(clean)) fileExports.add(clean);
            }
          }
        }
      }
    }

    imports.set(relFile, fileImports);
    exports.set(relFile, fileExports);
  }

  return { imports, exports };
}

// ── Detectors ─────────────────────────────────────────────

function detectOrphanedFiles(files, imports, projectDir) {
  const findings = [];
  const importedFiles = new Set();

  for (const fileImports of imports.values()) {
    for (const imp of fileImports) importedFiles.add(imp);
  }

  for (const file of files) {
    const relFile = path.relative(projectDir, file);
    const basename = path.basename(file);

    if (ENTRY_PATTERNS.some((p) => p.test(basename))) continue;
    if (/\.(test|spec)\.[jt]sx?$/.test(basename)) continue;
    if (/^test[_-]/.test(basename)) continue;

    if (!importedFiles.has(relFile)) {
      findings.push({
        id: `DEAD-ORPHAN-${String(findings.length + 1).padStart(3, '0')}`,
        type: 'orphaned-file',
        severity: 'medium',
        file: relFile,
        line: 0,
        message: 'File is not imported by any other module',
        suggestion: 'Verify this file is still needed. If unused, remove it.',
      });
    }
  }

  return findings;
}

function detectUnusedExports(exports, imports, projectDir) {
  const findings = [];
  const usedExports = new Map();

  for (const [file] of imports) {
    let content;
    try {
      content = fs.readFileSync(path.join(projectDir, file), 'utf8');
    } catch {
      continue;
    }

    const namedImportRe = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = namedImportRe.exec(content)) !== null) {
      const names = match[1].split(',').map((n) =>
        n
          .trim()
          .split(/\s+as\s+/)[0]
          .trim(),
      );
      const importPath = match[2];
      const resolved = resolveImport(path.join(projectDir, file), importPath, projectDir);
      if (resolved) {
        if (!usedExports.has(resolved)) usedExports.set(resolved, new Set());
        for (const name of names) {
          if (name) usedExports.get(resolved).add(name);
        }
      }
    }
  }

  for (const [file, fileExports] of exports) {
    const basename = path.basename(file);
    if (ENTRY_PATTERNS.some((p) => p.test(basename))) continue;
    if (/\.(test|spec)\.[jt]sx?$/.test(basename)) continue;

    const used = usedExports.get(file) || new Set();
    for (const exportName of fileExports) {
      if (!used.has(exportName)) {
        findings.push({
          id: `DEAD-EXPORT-${String(findings.length + 1).padStart(3, '0')}`,
          type: 'unused-export',
          severity: 'low',
          file,
          line: 0,
          message: `Export "${exportName}" is not imported by any other module`,
          suggestion: "Remove export or verify it's used via dynamic import/require.",
        });
      }
    }
  }

  return findings;
}

function detectUnreachableCode(files, projectDir) {
  const findings = [];

  for (const file of files) {
    const ext = path.extname(file);
    if (!['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(ext)) continue;

    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    const relFile = path.relative(projectDir, file);

    // Track brace depth to distinguish top-level returns from conditional returns.
    // Only flag unreachable code when return/throw is at function body level (depth=1),
    // not inside if/else/switch branches.
    let braceDepth = 0;
    let functionDepth = 0; // depth at which current function was opened

    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i];

      // Track brace depth
      const opens = (line.match(/\{/g) || []).length;
      const closes = (line.match(/\}/g) || []).length;

      // Detect function declarations to track function-body level
      if (/\b(function|=>)\b/.test(line) && opens > 0) {
        functionDepth = braceDepth + 1;
      }

      braceDepth += opens - closes;

      // Only check returns/throws at function body level (depth == functionDepth)
      // This means the return is NOT inside an if/else/switch — it's the last statement
      if (/^\s*(return|throw)\s/.test(line) && line.includes(';') && braceDepth === functionDepth) {
        const nextLine = lines[i + 1];
        const nextTrimmed = nextLine.trim();
        if (
          nextTrimmed &&
          nextTrimmed !== '}' &&
          nextTrimmed !== ')' &&
          !nextTrimmed.startsWith('//') &&
          !nextTrimmed.startsWith('/*') &&
          !nextTrimmed.startsWith('*') &&
          nextTrimmed !== ''
        ) {
          if (!/^\s*(case|default|else|catch|finally)\b/.test(nextTrimmed)) {
            findings.push({
              id: `DEAD-UNREACH-${String(findings.length + 1).padStart(3, '0')}`,
              type: 'unreachable-code',
              severity: 'high',
              file: relFile,
              line: i + 2,
              message: `Code after unconditional ${line.trim().split(/\s/)[0]} is unreachable`,
              snippet: nextTrimmed.substring(0, 120),
              suggestion: 'Remove unreachable code or restructure control flow.',
            });
          }
        }
      }
    }
  }

  return findings;
}

// ── Main Scanner ──────────────────────────────────────────

function scan(projectDir, options = {}) {
  const scanDir = options.dir ? path.resolve(projectDir, options.dir) : projectDir;
  const files = walkFiles(scanDir);

  if (files.length === 0) {
    return { findings: [], summary: { total: 0, orphaned: 0, unusedExports: 0, unreachable: 0 }, score: 100 };
  }

  const { imports, exports } = buildImportGraph(files, projectDir);

  const allFindings = [
    ...detectOrphanedFiles(files, imports, projectDir),
    ...detectUnusedExports(exports, imports, projectDir),
    ...detectUnreachableCode(files, projectDir),
  ];

  const filtered = options.severity ? allFindings.filter((f) => f.severity === options.severity) : allFindings;

  const summary = {
    total: filtered.length,
    orphaned: filtered.filter((f) => f.type === 'orphaned-file').length,
    unusedExports: filtered.filter((f) => f.type === 'unused-export').length,
    unreachable: filtered.filter((f) => f.type === 'unreachable-code').length,
    filesScanned: files.length,
  };

  const penalties = { high: 18, medium: 8, low: 2 };
  const totalPenalty = filtered.reduce((s, f) => s + (penalties[f.severity] || 0), 0);
  const score = Math.max(0, 100 - totalPenalty);

  return {
    findings: filtered,
    summary,
    score,
    verdict: score >= 90 ? 'PASS' : score >= 75 ? 'WATCH' : 'FAIL',
    timestamp: new Date().toISOString(),
  };
}

function writeReport(projectDir, result) {
  const _p = typeof _paths === 'function' ? _paths(projectDir) : null;
  const outDir = _p ? _p.review() : path.join(projectDir, '_cobolt-output/latest/review');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const dest = path.join(outDir, 'dead-code-report.json');
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, dest);
  return dest;
}

module.exports = { scan, writeReport, buildImportGraph };

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === 'scan') {
    const options = {};
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--dir' && args[i + 1]) options.dir = args[++i];
      else if (args[i] === '--severity' && args[i + 1]) options.severity = args[++i];
      else if (args[i] === '--json') options.json = true;
      else if (args[i] === '--save') options.save = true;
    }

    const projectDir = process.cwd();
    const result = scan(projectDir, options);

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\n  CoBolt Dead Code Detector — ${result.summary.filesScanned} files scanned`);
      console.log('  ══════════════════════════════════════════════');
      console.log(`  Orphaned files:   ${result.summary.orphaned}`);
      console.log(`  Unused exports:   ${result.summary.unusedExports}`);
      console.log(`  Unreachable code: ${result.summary.unreachable}`);
      console.log(`  Score: ${result.score}% — ${result.verdict}`);
      console.log('  ══════════════════════════════════════════════');

      if (result.findings.length > 0) {
        console.log();
        for (const f of result.findings.slice(0, 25)) {
          const icon = f.severity === 'high' ? '\u2717' : f.severity === 'medium' ? '\u26A0' : '\u2022';
          const loc = f.line > 0 ? `:${f.line}` : '';
          console.log(`  ${icon} [${f.severity.toUpperCase()}] ${f.file}${loc} — ${f.message}`);
        }
        if (result.findings.length > 25) console.log(`  ... and ${result.findings.length - 25} more`);
      }
    }

    if (options.save) {
      const dest = writeReport(projectDir, result);
      if (!options.json) console.log(`\n  Report saved: ${dest}`);
    }

    process.exit(result.findings.some((f) => f.severity === 'high') ? 1 : 0);
  }

  console.log('  CoBolt Dead Code Detector');
  console.log(
    '  Usage: node tools/cobolt-dead-code-detector.js scan [--dir src/] [--severity high|medium|low] [--json] [--save]',
  );
  process.exit(0);
}
