#!/usr/bin/env node

// CoBolt UI Placeholder Check - deterministic placeholder/mock UI detector

const fs = require('node:fs');
const path = require('node:path');
const { buildProvenance } = require('./_brownfield-provenance');
const { walkFilteredFiles } = require('./_brownfield-scan-filter');

const UI_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.html']);
const UI_PATTERNS = [/\bplaceholder\b/i, /\bMOCK_[A-Z0-9_]+\b/, /\bmock data\b/i, /\bLorem Ipsum\b/i];

function isUiFile(filePath) {
  return UI_EXTENSIONS.has(path.extname(filePath));
}

function scan(projectDir) {
  const findings = [];
  const { files, skipped } = walkFilteredFiles(projectDir, isUiFile);
  for (const filePath of files) {
    const relativePath = path.relative(projectDir, filePath);
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const pattern of UI_PATTERNS) {
        if (!pattern.test(line)) continue;
        findings.push({
          id: `UI-${String(findings.length + 1).padStart(3, '0')}`,
          file: relativePath,
          line: index + 1,
          pattern: pattern.toString(),
          snippet: line.trim(),
        });
        break;
      }
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-ui-placeholder-check',
    projectDir: path.resolve(projectDir),
    ...buildProvenance(projectDir, files),
    summary: {
      findings: findings.length,
      scannedFiles: files.length,
      excludedFiles: skipped.files,
      excludedDirs: skipped.dirs,
    },
    scanScope: { excluded: skipped },
    findings,
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
    console.log('Usage: node tools/cobolt-ui-placeholder-check.js scan [project-path] [--json] [--output <path>]');
    process.exit(command ? 2 : 0);
  }

  const report = scan(projectDir);
  const targetPath =
    outputPath || path.join(projectDir, '_cobolt-output', 'latest', 'brownfield', 'ui-placeholder-mock-scan.json');
  writeReport(targetPath, report);

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[cobolt-ui-placeholder-check] ${report.summary.findings} placeholder/mock UI markers found`);
    console.log(`  Written: ${targetPath}`);
  }

  process.exit(report.summary.findings === 0 ? 0 : 1);
}

module.exports = { scan, writeReport, UI_PATTERNS };
