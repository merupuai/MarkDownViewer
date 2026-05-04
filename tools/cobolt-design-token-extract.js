#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const STYLE_EXTENSIONS = new Set([
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.styl',
  '.pcss',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.md',
]);

const IGNORE_DIRS = new Set([
  '.git',
  '.claude',
  '.codex',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '_build',
  '_cobolt-output',
  'build',
  'coverage',
  'deps',
  'dist',
  'node_modules',
  'target',
  'tmp',
  'vendor',
]);

function normalizePath(rootDir, filePath) {
  const relative = path.relative(rootDir, filePath);
  return relative ? relative.replace(/\\/g, '/') : path.basename(filePath);
}

function shouldScanFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (STYLE_EXTENSIONS.has(ext)) return true;
  const base = path.basename(filePath).toLowerCase();
  return (
    base.includes('tailwind') ||
    base.includes('theme') ||
    base.includes('token') ||
    base.includes('design-system') ||
    base.includes('style')
  );
}

function walkFiles(rootDir) {
  const results = [];
  const queue = [path.resolve(rootDir)];

  while (queue.length > 0) {
    const current = queue.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const nextPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          queue.push(nextPath);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (shouldScanFile(nextPath)) {
        results.push(nextPath);
      }
    }
  }

  return results.sort();
}

function addToken(store, category, rawValue, filePath, extra = {}) {
  const value = String(rawValue || '').trim();
  if (!value) return;
  if (!store[category].has(value)) {
    store[category].set(value, {
      value,
      count: 0,
      files: new Set(),
      ...extra,
    });
  }
  const entry = store[category].get(value);
  entry.count += 1;
  entry.files.add(filePath);
  if (extra.name && !entry.name) {
    entry.name = extra.name;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function categorizeVariable(name) {
  const normalized = String(name || '').toLowerCase();
  if (/(color|brand|primary|accent|surface|bg|foreground|text|border)/.test(normalized)) return 'colors';
  if (/(font|type)/.test(normalized)) return 'fonts';
  if (/(space|spacing|gap|padding|margin|gutter|size)/.test(normalized)) return 'spacing';
  if (/(radius|rounded|corner)/.test(normalized)) return 'radii';
  if (/(shadow|elevation)/.test(normalized)) return 'shadows';
  return 'variables';
}

function extractDesignTokens(projectDir = process.cwd(), options = {}) {
  const rootDir = path.resolve(projectDir);
  const files = walkFiles(rootDir);
  const store = {
    colors: new Map(),
    fonts: new Map(),
    spacing: new Map(),
    radii: new Map(),
    shadows: new Map(),
    variables: new Map(),
  };

  const fileSummaries = [];

  for (const absolutePath of files) {
    const text = readText(absolutePath);
    if (!text) continue;

    const relativePath = normalizePath(rootDir, absolutePath);
    let localMatches = 0;

    for (const match of text.matchAll(/(--[a-z0-9-_]+)\s*:\s*([^;}{\n]+)/gi)) {
      const name = match[1];
      const value = match[2].trim();
      const category = categorizeVariable(name);
      addToken(store, category, value, relativePath, { name });
      addToken(store, 'variables', name, relativePath, { name, resolvedValue: value });
      localMatches += 1;
    }

    for (const match of text.matchAll(/#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi)) {
      addToken(store, 'colors', match[0], relativePath);
      localMatches += 1;
    }

    for (const match of text.matchAll(/font-family\s*:\s*([^;}{\n]+)/gi)) {
      const families = match[1]
        .split(',')
        .map((item) => item.trim().replace(/^['"`]|['"`]$/g, ''))
        .filter(Boolean)
        .slice(0, 4);
      for (const family of families) {
        addToken(store, 'fonts', family, relativePath);
        localMatches += 1;
      }
    }

    for (const match of text.matchAll(
      /\b(?:gap|spacing|padding|margin|space-[xy]|inset|radius|rounded|shadow)\b[^:\n=]*[:=]\s*['"`]?([^'"`\n,;]+)/gi,
    )) {
      const rawValue = match[1].trim();
      if (/^(?:\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%)|0)$/.test(rawValue)) {
        const category = /radius|rounded/i.test(match[0]) ? 'radii' : 'spacing';
        addToken(store, category, rawValue, relativePath);
        localMatches += 1;
      }
    }

    for (const match of text.matchAll(/\b(box-shadow|shadow)\b[^:\n=]*[:=]\s*([^;\n]+)/gi)) {
      addToken(store, 'shadows', match[2].trim(), relativePath);
      localMatches += 1;
    }

    if (localMatches > 0) {
      fileSummaries.push({
        file: relativePath,
        tokenMatches: localMatches,
      });
    }
  }

  const result = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-design-token-extract',
    sourceRoot: rootDir,
    filesScanned: files.length,
    filesWithMatches: fileSummaries.length,
    tokenCounts: {},
    categories: {},
    topFiles: fileSummaries.sort((left, right) => right.tokenMatches - left.tokenMatches).slice(0, 10),
  };

  for (const [category, entries] of Object.entries(store)) {
    const sorted = [...entries.values()]
      .map((entry) => ({
        ...entry,
        files: [...entry.files].sort(),
      }))
      .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
      .slice(0, options.limitPerCategory || 30);

    result.categories[category] = sorted;
    result.tokenCounts[category] = sorted.length;
  }

  return result;
}

function formatTokenSummary(result) {
  const colors = result.categories.colors || [];
  const fonts = result.categories.fonts || [];
  const spacing = result.categories.spacing || [];
  const radii = result.categories.radii || [];
  const shadows = result.categories.shadows || [];

  const lines = [
    '# Design Token Candidates',
    '',
    `- Files scanned: ${result.filesScanned}`,
    `- Files with matches: ${result.filesWithMatches}`,
    `- Color candidates: ${result.tokenCounts.colors || 0}`,
    `- Font candidates: ${result.tokenCounts.fonts || 0}`,
    `- Spacing candidates: ${result.tokenCounts.spacing || 0}`,
    `- Radius candidates: ${result.tokenCounts.radii || 0}`,
    `- Shadow candidates: ${result.tokenCounts.shadows || 0}`,
    '',
    '## Top Colors',
    ...(colors.length
      ? colors.slice(0, 6).map((entry) => `- ${entry.value} (${entry.count} hits)`)
      : ['- None detected']),
    '',
    '## Top Fonts',
    ...(fonts.length
      ? fonts.slice(0, 6).map((entry) => `- ${entry.value} (${entry.count} hits)`)
      : ['- None detected']),
    '',
    '## Layout Signals',
    ...(spacing.length
      ? spacing.slice(0, 6).map((entry) => `- Spacing ${entry.value} (${entry.count} hits)`)
      : ['- No spacing tokens detected']),
    ...(radii.length ? radii.slice(0, 4).map((entry) => `- Radius ${entry.value} (${entry.count} hits)`) : []),
    ...(shadows.length ? shadows.slice(0, 4).map((entry) => `- Shadow ${entry.value} (${entry.count} hits)`) : []),
  ];

  return lines.join('\n');
}

function writeDesignTokenArtifacts(projectDir = process.cwd(), options = {}) {
  const result = extractDesignTokens(projectDir, options);
  const outputPath =
    options.outputPath ||
    path.join(path.resolve(projectDir), '_cobolt-output', 'latest', 'brownfield', '08b-design-token-candidates.json');
  const summaryPath = options.summaryPath || path.join(path.dirname(outputPath), '08b-design-token-candidates.md');

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  fs.writeFileSync(summaryPath, `${formatTokenSummary(result)}\n`, 'utf8');

  return { result, outputPath, summaryPath };
}

function printUsage() {
  console.log('Usage: node tools/cobolt-design-token-extract.js <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  extract [--dir path] [--out file] [--summary file] [--json]');
  console.log('  summary [--dir path]');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0] || 'extract';
  const jsonMode = args.includes('--json');
  const dirIndex = args.indexOf('--dir');
  const outIndex = args.indexOf('--out');
  const summaryIndex = args.indexOf('--summary');
  const projectDir = dirIndex >= 0 ? args[dirIndex + 1] : process.cwd();

  if (command === '--help' || command === '-h' || command === 'help') {
    printUsage();
    process.exit(0);
  }

  if (command === 'summary') {
    const result = extractDesignTokens(projectDir);
    console.log(formatTokenSummary(result));
    process.exit(0);
  }

  if (command === 'extract') {
    const outputPath = outIndex >= 0 ? args[outIndex + 1] : undefined;
    const summaryPath = summaryIndex >= 0 ? args[summaryIndex + 1] : undefined;
    const written = writeDesignTokenArtifacts(projectDir, { outputPath, summaryPath });
    console.log(
      jsonMode ? JSON.stringify(written.result, null, 2) : `Wrote ${written.outputPath} and ${written.summaryPath}`,
    );
    process.exit(0);
  }

  printUsage();
  process.exit(2);
}

module.exports = {
  STYLE_EXTENSIONS,
  walkFiles,
  extractDesignTokens,
  formatTokenSummary,
  writeDesignTokenArtifacts,
};
