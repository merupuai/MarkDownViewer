#!/usr/bin/env node

/**
 * cobolt-perf-linter.js — Deterministic performance budget enforcer
 * Checks bundle sizes, image optimization, font loading, and code patterns.
 *
 * Usage: node tools/cobolt-perf-linter.js [--json] [--lighthouse path/to/report.json] [--help]
 */

const fs = require('node:fs');
const path = require('node:path');

const BUDGETS = {
  mainBundleGzip: 150 * 1024, // 150KB gzip
  routeChunkGzip: 50 * 1024, // 50KB gzip
  cssTotal: 30 * 1024, // 30KB gzip
  lcp: 2500, // ms
  cls: 0.1,
  inp: 200, // ms
};

function findSourceFiles(projectRoot) {
  const extensions = ['.tsx', '.jsx', '.ts'];
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

function checkCodePatterns(projectRoot) {
  const files = findSourceFiles(projectRoot);
  const findings = [];

  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    const relFile = path.relative(projectRoot, file);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Raw <img> instead of Next.js <Image>
      if (/<img\s/i.test(line) && !/eslint-disable/.test(line)) {
        findings.push({
          id: 'PERF001',
          severity: 'warning',
          file: relFile,
          line: i + 1,
          message: 'Use Next.js <Image> instead of raw <img> for optimization.',
        });
      }

      // External font CSS import
      if (/@import.*fonts\.googleapis|link.*fonts\.googleapis/i.test(line)) {
        findings.push({
          id: 'PERF002',
          severity: 'error',
          file: relFile,
          line: i + 1,
          message: 'External font CSS import. Use next/font for optimized loading.',
        });
      }

      // Animating layout properties
      if (
        /animate.*(?:width|height|top|left|right|bottom|margin|padding)/i.test(line) &&
        !/transform|opacity/.test(line)
      ) {
        findings.push({
          id: 'PERF003',
          severity: 'warning',
          file: relFile,
          line: i + 1,
          message: 'Animating layout property. Use transform/opacity for GPU compositing.',
        });
      }

      // Image without dimensions
      if (/<(?:Image|img)\s/i.test(line) && !/width/i.test(line) && !/fill/i.test(line)) {
        findings.push({
          id: 'PERF004',
          severity: 'warning',
          file: relFile,
          line: i + 1,
          message: 'Image without width/height. May cause layout shift (CLS).',
        });
      }
    }
  }

  return findings;
}

function checkBundleSizes(projectRoot) {
  const findings = [];
  const chunksDir = path.join(projectRoot, '.next', 'static', 'chunks');
  if (!fs.existsSync(chunksDir)) return findings;

  try {
    const files = fs.readdirSync(chunksDir).filter((f) => f.endsWith('.js'));
    for (const file of files) {
      const fullPath = path.join(chunksDir, file);
      const stats = fs.statSync(fullPath);
      const estimatedGzip = Math.round(stats.size * 0.3); // rough gzip estimate

      if (file.startsWith('main') && estimatedGzip > BUDGETS.mainBundleGzip) {
        findings.push({
          id: 'PERF005',
          severity: 'error',
          file: `chunks/${file}`,
          line: 0,
          message: `Main bundle ${Math.round(estimatedGzip / 1024)}KB gzip exceeds ${Math.round(BUDGETS.mainBundleGzip / 1024)}KB budget.`,
        });
      } else if (estimatedGzip > BUDGETS.routeChunkGzip) {
        findings.push({
          id: 'PERF006',
          severity: 'warning',
          file: `chunks/${file}`,
          line: 0,
          message: `Route chunk ${Math.round(estimatedGzip / 1024)}KB gzip exceeds ${Math.round(BUDGETS.routeChunkGzip / 1024)}KB budget.`,
        });
      }
    }
  } catch {
    /* build dir not available */
  }

  return findings;
}

function checkLighthouse(lighthousePath) {
  const findings = [];
  if (!lighthousePath || !fs.existsSync(lighthousePath)) return findings;

  try {
    const report = JSON.parse(fs.readFileSync(lighthousePath, 'utf8'));
    const audits = report.audits || {};

    if (audits['largest-contentful-paint'] && audits['largest-contentful-paint'].numericValue > BUDGETS.lcp) {
      findings.push({
        id: 'PERF007',
        severity: 'error',
        file: 'lighthouse',
        line: 0,
        message: `LCP ${Math.round(audits['largest-contentful-paint'].numericValue)}ms exceeds ${BUDGETS.lcp}ms budget.`,
      });
    }
    if (audits['cumulative-layout-shift'] && audits['cumulative-layout-shift'].numericValue > BUDGETS.cls) {
      findings.push({
        id: 'PERF008',
        severity: 'error',
        file: 'lighthouse',
        line: 0,
        message: `CLS ${audits['cumulative-layout-shift'].numericValue} exceeds ${BUDGETS.cls} budget.`,
      });
    }
  } catch {
    /* invalid lighthouse report */
  }

  return findings;
}

function run(projectRoot, options = {}) {
  const allFindings = [
    ...checkCodePatterns(projectRoot),
    ...checkBundleSizes(projectRoot),
    ...checkLighthouse(options.lighthouse),
  ];

  const summary = {
    total: allFindings.length,
    errors: allFindings.filter((f) => f.severity === 'error').length,
    warnings: allFindings.filter((f) => f.severity === 'warning').length,
    pass: allFindings.filter((f) => f.severity === 'error').length === 0,
  };

  return { findings: allFindings, summary, budgets: BUDGETS };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: cobolt-perf-linter [--json] [--lighthouse path] [--help]');
    process.exit(0);
  }
  const lighthouseIdx = args.indexOf('--lighthouse');
  const lighthouse = lighthouseIdx >= 0 ? args[lighthouseIdx + 1] : null;
  const result = run(process.cwd(), { lighthouse });

  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\nPerformance Linter`);
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
