#!/usr/bin/env node

/**
 * cobolt-a11y-linter.js — Deterministic WCAG 2.1 AA compliance checker
 * Scans TSX/JSX for accessibility violations via regex/pattern matching.
 *
 * Usage: node tools/cobolt-a11y-linter.js [--json] [--help]
 */

const fs = require('node:fs');
const path = require('node:path');

function findSourceFiles(projectRoot) {
  const extensions = ['.tsx', '.jsx', '.css'];
  const excludeDirs = ['node_modules', '.next', 'dist', '_cobolt-output', '.git', '.claude'];
  const files = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (excludeDirs.includes(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (extensions.some((ext) => entry.name.endsWith(ext))) files.push(fullPath);
    }
  }

  walk(projectRoot);
  return files;
}

const CHECKS = {
  A11Y001_iconButtonNoLabel(line, lineNum, file) {
    // Icon-only button without aria-label
    if (
      /<(?:Button|button)[^>]*>[^<]*<(?:Icon|[A-Z]\w+Icon|\w+)\s*\/>\s*<\/(?:Button|button)>/i.test(line) &&
      !/aria-label/i.test(line)
    ) {
      return [{ id: 'A11Y001', severity: 'error', file, line: lineNum, message: 'Icon button missing aria-label.' }];
    }
    return [];
  },

  A11Y002_divOnClick(line, lineNum, file) {
    if (/<(?:div|span)\s[^>]*onClick/i.test(line)) {
      return [
        {
          id: 'A11Y002',
          severity: 'error',
          file,
          line: lineNum,
          message: 'Use <button> instead of <div/span onClick> for accessibility.',
        },
      ];
    }
    return [];
  },

  A11Y003_imgNoAlt(line, lineNum, file) {
    if (/<img\s/i.test(line) && !/alt=/i.test(line)) {
      return [{ id: 'A11Y003', severity: 'error', file, line: lineNum, message: 'Image missing alt attribute.' }];
    }
    return [];
  },

  A11Y004_inputNoLabel(line, lineNum, file) {
    if (/<(?:Input|input)\s/i.test(line) && !/aria-label|aria-labelledby|id=/i.test(line)) {
      return [
        {
          id: 'A11Y004',
          severity: 'warning',
          file,
          line: lineNum,
          message: 'Input may lack associated label. Verify <label htmlFor> or aria-label exists.',
        },
      ];
    }
    return [];
  },

  A11Y005_noFocusVisible(line, lineNum, file) {
    // Interactive elements without focus-visible styling
    if (
      /<(?:Button|button|a|Link)\s/i.test(line) &&
      /className/i.test(line) &&
      !/focus-visible|focus:|focus-within/i.test(line)
    ) {
      return [
        {
          id: 'A11Y005',
          severity: 'warning',
          file,
          line: lineNum,
          message: 'Interactive element may lack focus-visible ring. Add focus:ring or focus-visible: classes.',
        },
      ];
    }
    return [];
  },

  A11Y006_headingSkip(line, lineNum, file, _prefs, context) {
    // Track heading levels for hierarchy check
    const match = line.match(/<h([1-6])\b/i);
    if (match) {
      const level = parseInt(match[1], 10);
      if (context.lastHeading && level > context.lastHeading + 1) {
        context.lastHeading = level;
        return [
          {
            id: 'A11Y006',
            severity: 'warning',
            file,
            line: lineNum,
            message: `Heading hierarchy skip: h${context.lastHeading - (level - context.lastHeading)} to h${level}.`,
          },
        ];
      }
      context.lastHeading = level;
    }
    return [];
  },
};

function checkGlobalCSS(projectRoot) {
  const findings = [];
  const globalsPath = path.join(projectRoot, 'app', 'globals.css');
  if (!fs.existsSync(globalsPath)) return findings;

  const content = fs.readFileSync(globalsPath, 'utf8');
  if (!content.includes('prefers-reduced-motion')) {
    findings.push({
      id: 'A11Y007',
      severity: 'warning',
      file: 'app/globals.css',
      line: 0,
      message: 'Missing @media (prefers-reduced-motion: reduce) rule.',
    });
  }
  return findings;
}

function run(projectRoot) {
  const files = findSourceFiles(projectRoot);
  const allFindings = [];

  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    const context = { lastHeading: 0 };

    for (let i = 0; i < lines.length; i++) {
      for (const check of Object.values(CHECKS)) {
        const findings = check(lines[i], i + 1, path.relative(projectRoot, file), {}, context);
        allFindings.push(...findings);
      }
    }
  }

  allFindings.push(...checkGlobalCSS(projectRoot));

  const summary = {
    total: allFindings.length,
    errors: allFindings.filter((f) => f.severity === 'error').length,
    warnings: allFindings.filter((f) => f.severity === 'warning').length,
    filesScanned: files.length,
    pass: allFindings.filter((f) => f.severity === 'error').length === 0,
  };

  return { findings: allFindings, summary };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: cobolt-a11y-linter [--json] [--help]');
    console.log('  Deterministic WCAG 2.1 AA accessibility checker.');
    process.exit(0);
  }
  const result = run(process.cwd());

  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\nA11y Linter — ${result.summary.filesScanned} files scanned`);
    for (const f of result.findings.slice(0, 50)) {
      const icon = f.severity === 'error' ? 'ERROR' : 'WARN';
      console.log(`  [${icon}] ${f.id} ${f.file}:${f.line} — ${f.message}`);
    }
    console.log(
      `\n${result.summary.pass ? 'PASS' : 'FAIL'} — ${result.summary.errors} errors, ${result.summary.warnings} warnings\n`,
    );
    process.exit(result.summary.pass ? 0 : 1);
  }
}

module.exports = { run };
