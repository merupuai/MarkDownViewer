#!/usr/bin/env node

// CoBolt Code & Document Index
// Structural code search, codebase mapping, dependency graphs, and document navigation.
// Uses ast-grep (tree-sitter) for 20+ languages, marked for markdown documents.
//
// Usage:
//   node tools/cobolt-code-index.js <command> [args]
//
// Commands:
//   index / reindex          Full index rebuild
//   search <pattern> [lang]  Structural pattern search (ast-grep syntax)
//   symbols <path>           List all symbols (functions, classes, exports) in scope
//   exports <file>           Show exports of a file/module
//   imports <file>           Show imports of a file/module
//   deps [symbol|file]       Dependency graph (who imports whom)
//   map [path]               Structural overview of codebase or directory
//   doc-map [path]           TOC of all documents in a directory
//   doc-outline <file>       Heading tree + section sizes for a document
//   doc-section <file> <heading>  Extract a specific section by heading
//   doc-search <query>       Search across all documents
//   watch                    Start file watcher for auto re-index
//   stats                    Index health and coverage

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { searchText } = require('../lib/cobolt-search');

// ── Language Registry ────────────────────────────────────────

const EXT_TO_LANG = {
  // Built-in (uppercase)
  '.js': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.jsx': 'JavaScript',
  '.ts': 'TypeScript',
  '.mts': 'TypeScript',
  '.cts': 'TypeScript',
  '.tsx': 'Tsx',
  '.css': 'Css',
  '.scss': 'Css',
  '.less': 'Css',
  '.html': 'Html',
  '.htm': 'Html',
  '.vue': 'Html',
  '.svelte': 'Html',
  // Dynamic (lowercase, registered via registerDynamicLanguage)
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.rb': 'ruby',
  '.rake': 'ruby',
  '.cs': 'csharp',
  '.php': 'php',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.swift': 'swift',
  '.sh': 'bash_lang',
  '.bash': 'bash_lang',
  '.zsh': 'bash_lang',
  '.json': 'json_lang',
  '.yaml': 'yaml_lang',
  '.yml': 'yaml_lang',
  '.sql': 'sql',
  '.scala': 'scala',
  '.sc': 'scala',
  // Document types (handled by doc indexer, not ast-grep)
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.txt': 'text',
  '.toml': 'toml_lang',
};

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst']);
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '_cobolt-output',
  '_cobolt-docker',
  '.claude',
  '.cursor',
  '.windsurf',
  '.opencode',
  '.codex',
  '.github',
  '.vscode',
  '.idea',
  '__pycache__',
  'vendor',
  '.next',
  '.nuxt',
  'coverage',
  '.turbo',
  'target',
]);
const MAX_FILE_SIZE = 512 * 1024; // 512KB — skip huge generated files

// ── AST-Grep Setup ───────────────────────────────────────────

let sg = null;
let sgReady = false;
const _sgSkippedLanguages = [];

function initAstGrep() {
  if (sgReady) return sg;
  try {
    sg = require('@ast-grep/napi');
    // Register all dynamic languages in one call
    const dynamicLangs = {};
    const langPackages = {
      python: '@ast-grep/lang-python',
      go: '@ast-grep/lang-go',
      rust: '@ast-grep/lang-rust',
      java: '@ast-grep/lang-java',
      ruby: '@ast-grep/lang-ruby',
      csharp: '@ast-grep/lang-csharp',
      php: '@ast-grep/lang-php',
      kotlin: '@ast-grep/lang-kotlin',
      c: '@ast-grep/lang-c',
      cpp: '@ast-grep/lang-cpp',
      swift: '@ast-grep/lang-swift',
      bash_lang: '@ast-grep/lang-bash',
      json_lang: '@ast-grep/lang-json',
      yaml_lang: '@ast-grep/lang-yaml',
      sql: '@ast-grep/lang-sql',
      scala: '@ast-grep/lang-scala',
    };
    _sgSkippedLanguages.length = 0;
    for (const [name, pkg] of Object.entries(langPackages)) {
      try {
        dynamicLangs[name] = require(pkg);
      } catch {
        _sgSkippedLanguages.push(pkg);
      }
    }
    if (Object.keys(dynamicLangs).length > 0) {
      sg.registerDynamicLanguage(dynamicLangs);
    }
    if (_sgSkippedLanguages.length > 0) {
      console.warn(
        `[code-index] ${_sgSkippedLanguages.length} ast-grep language pack(s) not installed:`,
        _sgSkippedLanguages.join(', '),
      );
    }
    sgReady = true;
  } catch (e) {
    console.error('ast-grep not available:', e.message);
    process.exit(1);
  }
  return sg;
}

// ── File Walking ────────────────────────────────────────���────

function walkFiles(dir, filter) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      results.push(...walkFiles(fullPath, filter));
    } else if (entry.isFile()) {
      if (filter && !filter(fullPath)) continue;
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > MAX_FILE_SIZE) continue;
      } catch {
        continue;
      }
      results.push(fullPath);
    }
  }
  return results;
}

function fileHash(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

// ── Index Storage ────────────────────────────────────────────

function indexDir(root) {
  const dir = path.join(root, '_cobolt-output', 'code-index');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readIndex(root, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(indexDir(root), name), 'utf8'));
  } catch {
    return null;
  }
}

function writeIndex(root, name, data) {
  fs.writeFileSync(path.join(indexDir(root), name), JSON.stringify(data, null, 2), 'utf8');
}

// ── Code Symbol Extraction ───────────────────────────────────

function extractSymbols(filePath, lang, source) {
  const astGrep = initAstGrep();
  let tree;
  try {
    tree = astGrep.parse(lang, source);
  } catch {
    return null;
  }

  const root = tree.root();
  const symbols = { functions: [], classes: [], exports: [], imports: [], types: [] };
  const relPath = path.relative(process.cwd(), filePath).replace(/\\/g, '/');

  function visit(node, depth) {
    if (depth > 20) return; // prevent infinite recursion
    const kind = node.kind();
    const text = node.text();
    const line = node.range().start.line + 1;

    // Functions
    if (/function_declaration|function_definition|function_item|method_definition|method|arrow_function/.test(kind)) {
      const nameNode = node
        .children()
        .find((c) => c.kind() === 'identifier' || c.kind() === 'property_identifier' || c.kind() === 'name');
      const name = nameNode ? nameNode.text() : text.match(/(?:function|def|func|fn)\s+(\w+)/)?.[1] || '<anonymous>';
      symbols.functions.push({ name, line, kind });
    }

    // Classes / structs / interfaces
    if (
      /class_declaration|class_definition|struct_item|struct_definition|interface_declaration|trait_item|object_definition/.test(
        kind,
      )
    ) {
      const nameNode = node
        .children()
        .find((c) => c.kind() === 'identifier' || c.kind() === 'type_identifier' || c.kind() === 'name');
      const name = nameNode ? nameNode.text() : '<unnamed>';
      symbols.classes.push({ name, line, kind });
    }

    // Types
    if (/type_alias_declaration|type_declaration|type_definition/.test(kind)) {
      const nameNode = node.children().find((c) => c.kind() === 'identifier' || c.kind() === 'type_identifier');
      const name = nameNode ? nameNode.text() : '<unnamed>';
      symbols.types.push({ name, line, kind });
    }

    // Imports
    if (/import_statement|import_declaration|use_declaration|require/.test(kind)) {
      const importText = text.split('\n')[0].trim().slice(0, 200);
      symbols.imports.push({ text: importText, line });
    }

    // Exports (JS/TS specific patterns)
    if (/export_statement|export_declaration/.test(kind)) {
      const exportText = text.split('\n')[0].trim().slice(0, 200);
      symbols.exports.push({ text: exportText, line });
    }

    // Module.exports pattern (CommonJS)
    if (kind === 'assignment_expression' && text.startsWith('module.exports')) {
      symbols.exports.push({ text: text.split('\n')[0].trim().slice(0, 200), line });
    }

    for (const child of node.children()) {
      visit(child, depth + 1);
    }
  }

  visit(root, 0);
  return { file: relPath, lang, ...symbols };
}

// ── Document Parsing ─────────────────────────────────────────

function parseDocument(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const relPath = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
  const ext = path.extname(filePath).toLowerCase();
  const lines = content.split('\n');
  const totalLines = lines.length;

  if (ext === '.md' || ext === '.mdx') {
    return parseMarkdown(relPath, content, totalLines);
  }
  // Plain text — just provide line count and first line as summary
  return {
    file: relPath,
    type: 'text',
    totalLines,
    summary: lines[0]?.trim().slice(0, 100) || '',
    sections: [],
  };
}

function parseMarkdown(relPath, content, totalLines) {
  const lines = content.split('\n');
  const sections = [];
  let currentSection = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      if (currentSection) {
        currentSection.endLine = i;
        currentSection.lineCount = currentSection.endLine - currentSection.startLine;
      }
      currentSection = {
        level: headingMatch[1].length,
        heading: headingMatch[2].trim(),
        startLine: i + 1,
        endLine: totalLines,
        lineCount: 0,
      };
      sections.push(currentSection);
    }
  }
  if (currentSection) {
    currentSection.endLine = totalLines;
    currentSection.lineCount = currentSection.endLine - currentSection.startLine;
  }

  // Extract tables, code blocks, links counts
  const tables = (content.match(/^\|.+\|$/gm) || []).length;
  const codeBlocks = (content.match(/^```/gm) || []).length / 2;
  const links = (content.match(/\[.+?\]\(.+?\)/g) || []).length;

  return {
    file: relPath,
    type: 'markdown',
    totalLines,
    sections,
    tables: Math.floor(tables / 2), // header + separator = 2 lines per table
    codeBlocks: Math.floor(codeBlocks),
    links,
  };
}

// ── Index Builder ────────────────────────────────────────────

function buildIndex(root, opts = {}) {
  const startTime = Date.now();
  const codeFiles = walkFiles(root, (f) => {
    const ext = path.extname(f).toLowerCase();
    return EXT_TO_LANG[ext] && !DOC_EXTENSIONS.has(ext);
  });
  const docFiles = walkFiles(root, (f) => DOC_EXTENSIONS.has(path.extname(f).toLowerCase()));

  // Load existing index for incremental updates
  const existingCode = readIndex(root, 'code-index.json') || { files: {}, hashes: {} };
  const existingDocs = readIndex(root, 'doc-index.json') || { files: {}, hashes: {} };

  const codeIndex = { files: {}, hashes: {}, builtAt: new Date().toISOString() };
  const docIndex = { files: {}, hashes: {}, builtAt: new Date().toISOString() };
  const deps = { imports: {}, importedBy: {}, builtAt: new Date().toISOString() };

  let parsed = 0,
    skipped = 0,
    failed = 0;

  // Index code files
  initAstGrep();
  for (const filePath of codeFiles) {
    const relPath = path.relative(root, filePath).replace(/\\/g, '/');
    const hash = fileHash(filePath);

    // Skip unchanged files (incremental)
    if (!opts.force && existingCode.hashes[relPath] === hash && existingCode.files[relPath]) {
      codeIndex.files[relPath] = existingCode.files[relPath];
      codeIndex.hashes[relPath] = hash;
      skipped++;
      continue;
    }

    const ext = path.extname(filePath).toLowerCase();
    const lang = EXT_TO_LANG[ext];
    if (!lang) continue;

    try {
      const source = fs.readFileSync(filePath, 'utf8');
      const symbols = extractSymbols(filePath, lang, source);
      if (symbols) {
        codeIndex.files[relPath] = symbols;
        codeIndex.hashes[relPath] = hash;

        // Build dependency graph from imports
        const importPaths = symbols.imports.map((i) => i.text);
        deps.imports[relPath] = importPaths;
        for (const imp of importPaths) {
          // Extract module name from import text
          const mod = imp.match(
            /from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|use\s+(\S+)/,
          );
          if (mod) {
            const target = mod[1] || mod[2] || mod[3] || mod[4];
            if (!deps.importedBy[target]) deps.importedBy[target] = [];
            deps.importedBy[target].push(relPath);
          }
        }
        parsed++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }

  // Index document files
  for (const filePath of docFiles) {
    const relPath = path.relative(root, filePath).replace(/\\/g, '/');
    const hash = fileHash(filePath);

    if (!opts.force && existingDocs.hashes[relPath] === hash && existingDocs.files[relPath]) {
      docIndex.files[relPath] = existingDocs.files[relPath];
      docIndex.hashes[relPath] = hash;
      skipped++;
      continue;
    }

    const doc = parseDocument(filePath);
    if (doc) {
      docIndex.files[relPath] = doc;
      docIndex.hashes[relPath] = hash;
      parsed++;
    }
  }

  writeIndex(root, 'code-index.json', codeIndex);
  writeIndex(root, 'doc-index.json', docIndex);
  writeIndex(root, 'deps.json', deps);

  const elapsed = Date.now() - startTime;
  return {
    parsed,
    skipped,
    failed,
    codeFiles: codeFiles.length,
    docFiles: docFiles.length,
    elapsed,
    skippedLanguages: _sgSkippedLanguages.slice(),
  };
}

// ── Commands ─────────────────────────────────────────────────

function cmdIndex(root, opts) {
  console.log('Building index...');
  const result = buildIndex(root, opts);
  console.log(`Indexed ${result.parsed} files (${result.skipped} unchanged, ${result.failed} failed)`);
  console.log(`  Code files: ${result.codeFiles}`);
  console.log(`  Doc files:  ${result.docFiles}`);
  console.log(`  Time: ${result.elapsed}ms`);
  console.log(`  Index: _cobolt-output/code-index/`);
  if (result.skippedLanguages.length > 0) {
    console.warn(`warning: ${result.skippedLanguages.length} language pack(s) unavailable — affected files skipped`);
    console.warn(`  missing: ${result.skippedLanguages.join(', ')}`);
  }
}

function cmdSearch(root, pattern, langFilter) {
  const astGrep = initAstGrep();
  const codeIndex = readIndex(root, 'code-index.json');
  if (!codeIndex) {
    console.log('No index found. Run: cobolt-code-index index');
    return;
  }

  const results = [];
  for (const [relPath, entry] of Object.entries(codeIndex.files)) {
    if (langFilter && entry.lang !== langFilter) continue;
    const fullPath = path.join(root, relPath);
    try {
      const source = fs.readFileSync(fullPath, 'utf8');
      const tree = astGrep.parse(entry.lang, source);
      const matches = tree.root().findAll(pattern);
      for (const match of matches) {
        const line = match.range().start.line + 1;
        const text = match.text().split('\n')[0].slice(0, 120);
        results.push({ file: relPath, line, text });
      }
    } catch {
      /* skip unparseable files */
    }
  }

  if (results.length === 0) {
    console.log(`No matches for pattern: ${pattern}`);
    return;
  }
  console.log(`${results.length} match(es) for: ${pattern}\n`);
  for (const r of results.slice(0, 100)) {
    console.log(`  ${r.file}:${r.line}  ${r.text}`);
  }
  if (results.length > 100) console.log(`  ... and ${results.length - 100} more`);
}

function cmdSymbols(root, targetPath) {
  ensureIndex(root);
  const codeIndex = readIndex(root, 'code-index.json');
  if (!codeIndex) return;

  const target = path.relative(root, path.resolve(targetPath)).replace(/\\/g, '/');
  const entries = Object.entries(codeIndex.files).filter(
    ([f]) => f === target || f.startsWith(`${target}/`) || f.startsWith(target),
  );

  if (entries.length === 0) {
    console.log(`No indexed files matching: ${target}`);
    return;
  }

  for (const [relPath, entry] of entries) {
    console.log(`\n${relPath} (${entry.lang}):`);
    if (entry.functions.length) {
      console.log('  Functions:');
      for (const f of entry.functions) console.log(`    ${f.name} (line ${f.line})`);
    }
    if (entry.classes.length) {
      console.log('  Classes:');
      for (const c of entry.classes) console.log(`    ${c.name} (line ${c.line})`);
    }
    if (entry.types.length) {
      console.log('  Types:');
      for (const t of entry.types) console.log(`    ${t.name} (line ${t.line})`);
    }
    if (entry.exports.length) {
      console.log('  Exports:');
      for (const e of entry.exports) console.log(`    ${e.text} (line ${e.line})`);
    }
  }
}

function cmdExports(root, filePath) {
  ensureIndex(root);
  const codeIndex = readIndex(root, 'code-index.json');
  if (!codeIndex) return;
  const rel = path.relative(root, path.resolve(filePath)).replace(/\\/g, '/');
  const entry = codeIndex.files[rel];
  if (!entry) {
    console.log(`File not in index: ${rel}`);
    return;
  }

  console.log(`Exports from ${rel}:\n`);
  if (entry.exports.length === 0) {
    // Fallback: show top-level functions/classes as potential exports
    console.log('  (no explicit exports found — top-level symbols:)');
    for (const f of entry.functions) console.log(`  function ${f.name} (line ${f.line})`);
    for (const c of entry.classes) console.log(`  class ${c.name} (line ${c.line})`);
  } else {
    for (const e of entry.exports) console.log(`  ${e.text} (line ${e.line})`);
  }
}

function cmdImports(root, filePath) {
  ensureIndex(root);
  const codeIndex = readIndex(root, 'code-index.json');
  if (!codeIndex) return;
  const rel = path.relative(root, path.resolve(filePath)).replace(/\\/g, '/');
  const entry = codeIndex.files[rel];
  if (!entry) {
    console.log(`File not in index: ${rel}`);
    return;
  }

  console.log(`Imports in ${rel}:\n`);
  if (entry.imports.length === 0) {
    console.log('  (no imports found)');
  } else {
    for (const i of entry.imports) console.log(`  ${i.text} (line ${i.line})`);
  }
}

function cmdDeps(root, target) {
  ensureIndex(root);
  const deps = readIndex(root, 'deps.json');
  if (!deps) return;

  if (target) {
    // Show what this file/module imports and who imports it
    const rel = path.relative(root, path.resolve(target)).replace(/\\/g, '/');
    console.log(`Dependencies for: ${rel || target}\n`);
    const imports = deps.imports[rel] || deps.imports[target] || [];
    console.log(`  Imports (${imports.length}):`);
    for (const i of imports) console.log(`    ${i}`);

    const importedBy = deps.importedBy[rel] || deps.importedBy[target] || [];
    console.log(`\n  Imported by (${importedBy.length}):`);
    for (const i of importedBy) console.log(`    ${i}`);
  } else {
    // Show top-level dependency summary
    const files = Object.keys(deps.imports);
    const modules = Object.keys(deps.importedBy);
    console.log(`Dependency graph: ${files.length} files, ${modules.length} imported modules\n`);
    // Show most-imported modules
    const sorted = Object.entries(deps.importedBy)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 20);
    console.log('Most imported:');
    for (const [mod, importers] of sorted) {
      console.log(`  ${mod} (${importers.length} files)`);
    }
  }
}

function cmdMap(root, targetPath) {
  ensureIndex(root);
  const codeIndex = readIndex(root, 'code-index.json');
  const docIndex = readIndex(root, 'doc-index.json');
  if (!codeIndex && !docIndex) return;

  const target = targetPath ? path.relative(root, path.resolve(targetPath)).replace(/\\/g, '/') : '';

  console.log(`Codebase map${target ? `: ${target}` : ''}\n`);

  // Group by directory
  const dirs = {};
  if (codeIndex) {
    for (const [relPath, entry] of Object.entries(codeIndex.files)) {
      if (target && !relPath.startsWith(target)) continue;
      const dir = path.dirname(relPath);
      if (!dirs[dir]) dirs[dir] = { code: [], docs: [] };
      const symbolCount = entry.functions.length + entry.classes.length + entry.types.length;
      dirs[dir].code.push({ file: path.basename(relPath), lang: entry.lang, symbols: symbolCount });
    }
  }
  if (docIndex) {
    for (const [relPath, entry] of Object.entries(docIndex.files)) {
      if (target && !relPath.startsWith(target)) continue;
      const dir = path.dirname(relPath);
      if (!dirs[dir]) dirs[dir] = { code: [], docs: [] };
      dirs[dir].docs.push({
        file: path.basename(relPath),
        lines: entry.totalLines,
        sections: (entry.sections || []).length,
      });
    }
  }

  const sortedDirs = Object.keys(dirs).sort();
  for (const dir of sortedDirs) {
    const d = dirs[dir];
    console.log(`${dir}/`);
    for (const c of d.code) {
      console.log(`  ${c.file} (${c.lang}, ${c.symbols} symbols)`);
    }
    for (const doc of d.docs) {
      console.log(`  ${doc.file} (${doc.lines} lines, ${doc.sections} sections)`);
    }
  }
}

function cmdDocMap(root, targetPath) {
  ensureIndex(root);
  const docIndex = readIndex(root, 'doc-index.json');
  if (!docIndex) return;

  const target = targetPath ? path.relative(root, path.resolve(targetPath)).replace(/\\/g, '/') : '';

  console.log(`Document map${target ? `: ${target}` : ''}\n`);

  for (const [relPath, entry] of Object.entries(docIndex.files)) {
    if (target && !relPath.startsWith(target)) continue;
    console.log(`${relPath} (${entry.totalLines} lines)`);
    if (entry.sections) {
      for (const s of entry.sections) {
        const indent = '  '.repeat(s.level);
        console.log(`${indent}${s.heading} (${s.lineCount} lines, L${s.startLine})`);
      }
    }
    if (entry.tables) console.log(`  [${entry.tables} tables, ${entry.codeBlocks} code blocks, ${entry.links} links]`);
    console.log('');
  }
}

function cmdDocOutline(root, filePath) {
  ensureIndex(root);
  const docIndex = readIndex(root, 'doc-index.json');
  if (!docIndex) return;

  const rel = path.relative(root, path.resolve(filePath)).replace(/\\/g, '/');
  const entry = docIndex.files[rel];
  if (!entry) {
    console.log(`Document not in index: ${rel}`);
    return;
  }

  console.log(`Outline: ${rel} (${entry.totalLines} lines)\n`);
  if (entry.sections) {
    for (const s of entry.sections) {
      const bar = '\u2502';
      const indent = '  '.repeat(s.level - 1);
      const sizeLabel = s.lineCount > 50 ? ` [LARGE: ${s.lineCount} lines]` : ` (${s.lineCount} lines)`;
      console.log(`${indent}${bar} ${'#'.repeat(s.level)} ${s.heading}${sizeLabel} — L${s.startLine}-${s.endLine}`);
    }
  }
  console.log('');
  if (entry.tables) console.log(`Tables: ${entry.tables}`);
  if (entry.codeBlocks) console.log(`Code blocks: ${entry.codeBlocks}`);
  if (entry.links) console.log(`Links: ${entry.links}`);
}

function cmdDocSection(root, filePath, heading) {
  const fullPath = path.resolve(filePath);
  let content;
  try {
    content = fs.readFileSync(fullPath, 'utf8');
  } catch {
    console.log(`Cannot read: ${filePath}`);
    return;
  }

  const lines = content.split('\n');
  const headingLower = heading.toLowerCase();
  let startLine = -1;
  let startLevel = 0;
  let endLine = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)/);
    if (!match) continue;
    const level = match[1].length;
    const text = match[2].trim().toLowerCase();

    if (startLine === -1 && text.includes(headingLower)) {
      startLine = i;
      startLevel = level;
    } else if (startLine !== -1 && level <= startLevel) {
      endLine = i;
      break;
    }
  }

  if (startLine === -1) {
    console.log(`Section "${heading}" not found in ${filePath}`);
    // Show available sections
    ensureIndex(root);
    const docIndex = readIndex(root, 'doc-index.json');
    if (docIndex) {
      const rel = path.relative(root, fullPath).replace(/\\/g, '/');
      const entry = docIndex.files[rel];
      if (entry?.sections) {
        console.log('\nAvailable sections:');
        for (const s of entry.sections) console.log(`  ${'#'.repeat(s.level)} ${s.heading}`);
      }
    }
    return;
  }

  const section = lines.slice(startLine, endLine).join('\n');
  console.log(section);
}

function cmdDocSearch(root, query) {
  ensureIndex(root);
  const docIndex = readIndex(root, 'doc-index.json');
  if (!docIndex) return;

  const queryLower = query.toLowerCase();
  const headingResults = [];

  for (const [relPath, entry] of Object.entries(docIndex.files)) {
    // Search in section headings
    if (entry.sections) {
      for (const s of entry.sections) {
        if (s.heading.toLowerCase().includes(queryLower)) {
          headingResults.push({ file: relPath, heading: s.heading, line: s.startLine, type: 'heading' });
        }
      }
    }
  }

  const contentSearch = searchText(root, query, {
    extensions: [...DOC_EXTENSIONS],
    limit: 200,
    preferNative: true,
  });
  const contentResults = contentSearch.results.map((result) => ({
    file: result.file,
    line: result.line,
    text: result.text.slice(0, 120),
    type: 'content',
  }));

  if (headingResults.length === 0 && contentResults.length === 0) {
    console.log(`No matches for: "${query}" across documents`);
    return;
  }

  if (headingResults.length) {
    console.log(`Section matches (${headingResults.length}):\n`);
    for (const h of headingResults) console.log(`  ${h.file} -> ${h.heading} (L${h.line})`);
  }

  if (contentResults.length) {
    const shownCount = Math.min(contentResults.length, 50);
    console.log(`\nContent matches (${shownCount} of ${contentSearch.totalMatches} via ${contentSearch.backend}):\n`);
    for (const c of contentResults.slice(0, 50)) console.log(`  ${c.file}:${c.line}  ${c.text}`);
  }
}

function cmdWatch(root) {
  let chokidar;
  try {
    chokidar = require('chokidar');
  } catch {
    console.error('chokidar not installed. Run: npm install chokidar');
    process.exit(2);
  }

  console.log('Starting file watcher...');
  ensureIndex(root);

  const ignored = [...IGNORE_DIRS].map((d) => `**/${d}/**`);
  ignored.push('**/_cobolt-output/**');
  const watcher = chokidar.watch(root, {
    ignored,
    persistent: true,
    ignoreInitial: true,
    cwd: root,
  });

  let debounceTimer = null;
  const pendingFiles = new Set();

  function processChanges() {
    if (pendingFiles.size === 0) return;
    const files = [...pendingFiles];
    pendingFiles.clear();

    for (const relPath of files) {
      const ext = path.extname(relPath).toLowerCase();
      const fullPath = path.join(root, relPath);

      if (DOC_EXTENSIONS.has(ext)) {
        // Re-index single document
        const docIndex = readIndex(root, 'doc-index.json') || { files: {}, hashes: {} };
        if (fs.existsSync(fullPath)) {
          const doc = parseDocument(fullPath);
          if (doc) {
            docIndex.files[relPath] = doc;
            docIndex.hashes[relPath] = fileHash(fullPath);
          }
        } else {
          delete docIndex.files[relPath];
          delete docIndex.hashes[relPath];
        }
        writeIndex(root, 'doc-index.json', docIndex);
      } else if (EXT_TO_LANG[ext] && !DOC_EXTENSIONS.has(ext)) {
        // Re-index single code file
        const codeIndex = readIndex(root, 'code-index.json') || { files: {}, hashes: {} };
        if (fs.existsSync(fullPath)) {
          try {
            const source = fs.readFileSync(fullPath, 'utf8');
            const lang = EXT_TO_LANG[ext];
            const symbols = extractSymbols(fullPath, lang, source);
            if (symbols) {
              codeIndex.files[relPath] = symbols;
              codeIndex.hashes[relPath] = fileHash(fullPath);
            }
          } catch {
            /* skip */
          }
        } else {
          delete codeIndex.files[relPath];
          delete codeIndex.hashes[relPath];
        }
        writeIndex(root, 'code-index.json', codeIndex);
      }
    }
    const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
    console.log(`[${time}] Re-indexed ${files.length} file(s): ${files.join(', ')}`);
  }

  watcher.on('change', (filePath) => {
    pendingFiles.add(filePath.replace(/\\/g, '/'));
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processChanges, 300);
  });
  watcher.on('add', (filePath) => {
    pendingFiles.add(filePath.replace(/\\/g, '/'));
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processChanges, 300);
  });
  watcher.on('unlink', (filePath) => {
    pendingFiles.add(filePath.replace(/\\/g, '/'));
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processChanges, 300);
  });

  console.log('Watching for file changes (Ctrl+C to stop)...');
}

function cmdStats(root) {
  const codeIndex = readIndex(root, 'code-index.json');
  const docIndex = readIndex(root, 'doc-index.json');
  const deps = readIndex(root, 'deps.json');

  if (!codeIndex && !docIndex) {
    console.log('No index found. Run: cobolt-code-index index');
    return;
  }

  console.log('Index Stats\n');

  if (codeIndex) {
    const files = Object.keys(codeIndex.files);
    const langCounts = {};
    let totalFunctions = 0,
      totalClasses = 0,
      totalImports = 0,
      totalExports = 0;
    for (const entry of Object.values(codeIndex.files)) {
      langCounts[entry.lang] = (langCounts[entry.lang] || 0) + 1;
      totalFunctions += entry.functions.length;
      totalClasses += entry.classes.length;
      totalImports += entry.imports.length;
      totalExports += entry.exports.length;
    }
    console.log(`Code: ${files.length} files`);
    console.log(
      `  Languages: ${Object.entries(langCounts)
        .map(([l, c]) => `${l}(${c})`)
        .join(', ')}`,
    );
    console.log(`  Symbols: ${totalFunctions} functions, ${totalClasses} classes`);
    console.log(`  Imports: ${totalImports}, Exports: ${totalExports}`);
    console.log(`  Built: ${codeIndex.builtAt}`);
  }

  if (docIndex) {
    const files = Object.keys(docIndex.files);
    let totalSections = 0,
      totalLines = 0;
    for (const entry of Object.values(docIndex.files)) {
      totalSections += (entry.sections || []).length;
      totalLines += entry.totalLines || 0;
    }
    console.log(`\nDocs: ${files.length} files, ${totalLines} total lines, ${totalSections} sections`);
    console.log(`  Built: ${docIndex.builtAt}`);
  }

  if (deps) {
    console.log(
      `\nDeps: ${Object.keys(deps.imports).length} files with imports, ${Object.keys(deps.importedBy).length} imported modules`,
    );
  }
}

// ── Auto-Index ───────────────────────────────────────────────

function ensureIndex(root) {
  const codeIndex = readIndex(root, 'code-index.json');
  if (!codeIndex) {
    console.log('No index found — building automatically...');
    buildIndex(root);
    console.log('');
  }
}

// ── CLI ──────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';
  const root = process.cwd();

  switch (command) {
    case 'index':
    case 'reindex':
      cmdIndex(root, { force: command === 'reindex' });
      break;
    case 'search':
      if (!args[1]) {
        console.log('Usage: cobolt-code-index search <pattern> [lang]');
        break;
      }
      ensureIndex(root);
      cmdSearch(root, args[1], args[2]);
      break;
    case 'symbols':
      if (!args[1]) {
        console.log('Usage: cobolt-code-index symbols <path>');
        break;
      }
      cmdSymbols(root, args[1]);
      break;
    case 'exports':
      if (!args[1]) {
        console.log('Usage: cobolt-code-index exports <file>');
        break;
      }
      cmdExports(root, args[1]);
      break;
    case 'imports':
      if (!args[1]) {
        console.log('Usage: cobolt-code-index imports <file>');
        break;
      }
      cmdImports(root, args[1]);
      break;
    case 'deps':
      cmdDeps(root, args[1]);
      break;
    case 'map':
      cmdMap(root, args[1]);
      break;
    case 'doc-map':
      cmdDocMap(root, args[1]);
      break;
    case 'doc-outline':
      if (!args[1]) {
        console.log('Usage: cobolt-code-index doc-outline <file>');
        break;
      }
      cmdDocOutline(root, args[1]);
      break;
    case 'doc-section':
      if (!args[1] || !args[2]) {
        console.log('Usage: cobolt-code-index doc-section <file> <heading>');
        break;
      }
      cmdDocSection(root, args[1], args.slice(2).join(' '));
      break;
    case 'doc-search':
      if (!args[1]) {
        console.log('Usage: cobolt-code-index doc-search <query>');
        break;
      }
      cmdDocSearch(root, args.slice(1).join(' '));
      break;
    case 'watch':
      cmdWatch(root);
      break;
    case 'stats':
      cmdStats(root);
      break;
    default:
      console.log(`CoBolt Code & Document Index

Usage: node tools/cobolt-code-index.js <command> [args]

Code Commands:
  index               Build/update index (incremental, skips unchanged files)
  reindex             Full rebuild (re-parses all files)
  search <pattern>    Structural search (ast-grep syntax, e.g. "function $NAME()")
  symbols <path>      List functions, classes, types in a file or directory
  exports <file>      Show exports of a file/module
  imports <file>      Show imports of a file/module
  deps [file]         Dependency graph (imports + imported-by)
  map [path]          Structural overview of codebase

Document Commands:
  doc-map [path]      TOC of all documents in a directory
  doc-outline <file>  Heading tree with section sizes
  doc-section <file> <heading>  Extract a section by heading match
  doc-search <query>  Search across all documents

Maintenance:
  watch               Start file watcher for auto re-index
  stats               Index health and coverage
  help                This message

Languages: JavaScript, TypeScript, Python, Go, Rust, Java, C#, Ruby, PHP,
           Kotlin, C, C++, Swift, Bash, Scala, SQL + Markdown documents

Index stored at: _cobolt-output/code-index/ (created on-demand)`);
      break;
  }
}

// Programmatic API
module.exports = {
  buildIndex,
  readIndex,
  ensureIndex,
  extractSymbols,
  parseDocument,
  // Returns the list of ast-grep language packages that were not installed when
  // initAstGrep ran. Empty array until initAstGrep executes. Callers (reviewers,
  // Tier 2 gates) can surface reduced coverage instead of silently accepting it.
  getSkippedLanguages: () => _sgSkippedLanguages.slice(),
};

// CLI entry
if (require.main === module) {
  main();
}
