#!/usr/bin/env node

// CoBolt Query Migration Contract - deterministic query/table coverage checker

const fs = require('node:fs');
const path = require('node:path');
const { buildProvenance } = require('./_brownfield-provenance');
const { isMigrationLikePath, walkFilteredFiles } = require('./_brownfield-scan-filter');

const CODE_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.go',
  '.py',
  '.rb',
  '.java',
  '.rs',
  '.ex',
  '.exs',
  '.sql',
]);
const TABLE_REF_PATTERN = /\b(?:from|join|update|into|table)\s+([a-zA-Z_][\w.]*)/gi;
const CREATE_TABLE_PATTERN = /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?([a-zA-Z_][\w.]*)/gi;

function isRelevantFile(filePath) {
  return CODE_EXTENSIONS.has(path.extname(filePath));
}

function normalizeTableName(tableName) {
  return tableName.replace(/["`]/g, '').split('.').pop().toLowerCase();
}

function scan(projectDir) {
  const { files, skipped } = walkFilteredFiles(projectDir, isRelevantFile);
  const queriedTables = new Map();
  const migratedTables = new Map();

  for (const filePath of files) {
    const relativePath = path.relative(projectDir, filePath);
    const text = fs.readFileSync(filePath, 'utf8');
    const queryPattern = new RegExp(TABLE_REF_PATTERN);
    const createPattern = new RegExp(CREATE_TABLE_PATTERN);
    const migrationLike = isMigrationLikePath(relativePath);
    let match;

    if (!migrationLike) {
      while ((match = queryPattern.exec(text)) !== null) {
        const table = normalizeTableName(match[1]);
        if (!queriedTables.has(table)) queriedTables.set(table, []);
        queriedTables.get(table).push(relativePath);
      }
    }

    while ((match = createPattern.exec(text)) !== null) {
      const table = normalizeTableName(match[1]);
      if (!migratedTables.has(table)) migratedTables.set(table, []);
      migratedTables.get(table).push(relativePath);
    }
  }

  const tables = [...queriedTables.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([table, references]) => ({
      table,
      queryCount: references.length,
      queryFiles: [...new Set(references)],
      migrationPresent: migratedTables.has(table),
      migrationFiles: migratedTables.has(table) ? [...new Set(migratedTables.get(table))] : [],
    }));

  const violations = tables.filter((table) => !table.migrationPresent);

  return {
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-query-migration-contract',
    projectDir: path.resolve(projectDir),
    ...buildProvenance(projectDir, files),
    summary: {
      queriedTables: tables.length,
      migratedTables: migratedTables.size,
      violations: violations.length,
      scannedFiles: files.length,
      excludedFiles: skipped.files,
      excludedDirs: skipped.dirs,
    },
    scanScope: {
      excluded: skipped,
      queryReferencesSkipMigrationFiles: true,
    },
    tables,
    violations,
  };
}

function writeReport(filePath, report) {
  const resolvedPath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return resolvedPath;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];
  let projectDir = process.cwd();
  let outputPath = null;
  const jsonMode = args.includes('--json');

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--output' && args[i + 1]) {
      outputPath = args[++i];
    } else if (!args[i].startsWith('--')) {
      projectDir = path.resolve(args[i]);
    }
  }

  if (command !== 'scan') {
    console.log('Usage: node tools/cobolt-query-migration-contract.js scan [project-path] [--json] [--output <path>]');
    process.exit(command ? 2 : 0);
  }

  const report = scan(projectDir);
  const targetPath =
    outputPath || path.join(projectDir, '_cobolt-output', 'latest', 'brownfield', 'query-migration-contract.json');
  writeReport(targetPath, report);

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[cobolt-query-migration-contract] ${report.summary.queriedTables} queried tables scanned`);
    console.log(`  Violations: ${report.summary.violations}`);
    console.log(`  Written: ${targetPath}`);
  }

  process.exit(report.summary.violations === 0 ? 0 : 1);
}

module.exports = { normalizeTableName, scan, writeReport };
