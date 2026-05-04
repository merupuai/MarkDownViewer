#!/usr/bin/env node

// CoBolt Frontend Runtime Check - static checks for frontend build/runtime wiring.

const fs = require('node:fs');
const path = require('node:path');
const { walkSourceFiles } = require('../lib/cobolt-source-scan');

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function parseMajor(spec) {
  const match = String(spec || '').match(/(\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function detectTailwind(projectRoot) {
  const pkg = readJson(path.join(projectRoot, 'package.json'));
  const dependencies = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const spec = dependencies.tailwindcss || null;
  return {
    present: Boolean(spec),
    spec,
    major: parseMajor(spec),
    v4: parseMajor(spec) >= 4,
  };
}

function detectPhoenix(projectRoot) {
  const mixPath = path.join(projectRoot, 'mix.exs');
  const heexFiles = walkSourceFiles(projectRoot, { includeExtensions: ['.heex', '.ex'] }).filter((file) =>
    /(?:^|\/)lib\/.*_web\//.test(file.relativePath),
  );
  return {
    present: fs.existsSync(mixPath) || heexFiles.length > 0,
    mixPath: fs.existsSync(mixPath) ? 'mix.exs' : null,
    templateCount: heexFiles.length,
  };
}

function collectCssFiles(projectRoot) {
  return walkSourceFiles(projectRoot, { includeExtensions: ['.css'] }).map((file) => {
    let content = '';
    try {
      content = fs.readFileSync(file.path, 'utf8');
    } catch {
      content = '';
    }
    return { ...file, content };
  });
}

function checkFrontendRuntime(projectRoot = process.cwd()) {
  const tailwind = detectTailwind(projectRoot);
  const phoenix = detectPhoenix(projectRoot);
  const cssFiles = collectCssFiles(projectRoot);
  const tailwindCssFiles = cssFiles.filter((file) => /@import\s+["']tailwindcss["']|@tailwind\b/i.test(file.content));
  const issues = [];
  const warnings = [];

  if (tailwind.v4 && phoenix.present && tailwindCssFiles.length > 0) {
    const sourcedFiles = tailwindCssFiles.filter((file) => /@source\s+["'][^"']*lib[^"']*["']/i.test(file.content));
    if (sourcedFiles.length === 0) {
      issues.push(
        'Tailwind v4 is used with Phoenix/HEEx templates, but no Tailwind CSS entrypoint declares an @source path for lib/*_web templates. Utility CSS can compile nearly empty.',
      );
    }
  }

  if (tailwind.present && tailwindCssFiles.length === 0) {
    warnings.push('tailwindcss is installed, but no CSS entrypoint imports Tailwind.');
  }

  return {
    passed: issues.length === 0,
    issues,
    warnings,
    summary: {
      errors: issues.length,
      warnings: warnings.length,
      tailwind,
      phoenix,
      tailwindCssFiles: tailwindCssFiles.map((file) => file.relativePath),
    },
  };
}

function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  const report = checkFrontendRuntime(process.cwd());
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.passed) {
    console.log('[cobolt-frontend-runtime-check] Frontend runtime wiring checks passed.');
    for (const warning of report.warnings) console.warn(`[cobolt-frontend-runtime-check] WARN: ${warning}`);
  } else {
    for (const issue of report.issues) console.error(`[cobolt-frontend-runtime-check] ${issue}`);
  }
  process.exit(report.passed ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  checkFrontendRuntime,
  detectPhoenix,
  detectTailwind,
};
