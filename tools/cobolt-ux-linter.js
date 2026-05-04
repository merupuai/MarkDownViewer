#!/usr/bin/env node

/**
 * cobolt-ux-linter.js — Deterministic UX pattern detector
 * Checks for loading states, error handling, empty states, form validation, touch targets.
 *
 * Usage: node tools/cobolt-ux-linter.js [--json] [--help]
 */

const fs = require('node:fs');
const path = require('node:path');

function findSourceFiles(projectRoot) {
  const extensions = ['.tsx', '.jsx'];
  const excludeDirs = ['node_modules', '.next', 'dist', '_cobolt-output', '.git', '.claude', 'components/ui'];
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

function analyzeFile(content, relFile) {
  const findings = [];
  const hasDataFetch = /useQuery|useSWR|fetch\(|axios\.|\.get\(|\.post\(|use\w+Query/i.test(content);
  const hasLoadingState = /isLoading|isPending|loading|Skeleton|Spinner|Suspense/i.test(content);
  const hasErrorHandling = /isError|error\b|catch\b|ErrorBoundary|onError/i.test(content);
  const hasEmptyState = /\.length\s*===\s*0|!.*\.length|empty|no\s+(?:data|results|items)/i.test(content);
  const hasFormValidation = /zodResolver|useForm|FormMessage|onBlur.*valid|setError/i.test(content);
  const hasForm = /<form|<Form|onSubmit|handleSubmit/i.test(content);

  if (hasDataFetch && !hasLoadingState) {
    findings.push({
      id: 'UX001',
      severity: 'warning',
      file: relFile,
      line: 0,
      message: 'Data fetch without loading state. Add Skeleton or isLoading check.',
    });
  }

  if (hasDataFetch && !hasErrorHandling) {
    findings.push({
      id: 'UX002',
      severity: 'warning',
      file: relFile,
      line: 0,
      message: 'Data fetch without error handling. Add error state UI.',
    });
  }

  if (hasDataFetch && !hasEmptyState) {
    findings.push({
      id: 'UX003',
      severity: 'warning',
      file: relFile,
      line: 0,
      message: 'Data fetch without empty state. Add fallback for zero results.',
    });
  }

  if (hasForm && !hasFormValidation) {
    findings.push({
      id: 'UX004',
      severity: 'warning',
      file: relFile,
      line: 0,
      message: 'Form without client validation. Add Zod + React Hook Form or inline validation.',
    });
  }

  // Check for submit button without disabled state
  if (hasForm && !/disabled.*submit|isSubmitting/i.test(content)) {
    findings.push({
      id: 'UX005',
      severity: 'warning',
      file: relFile,
      line: 0,
      message: 'Form submit button may lack disabled state during submission.',
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
    allFindings.push(...analyzeFile(content, path.relative(projectRoot, file)));
  }

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
    console.log('Usage: cobolt-ux-linter [--json] [--help]');
    process.exit(0);
  }
  const result = run(process.cwd());

  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\nUX Pattern Linter — ${result.summary.filesScanned} files scanned`);
    for (const f of result.findings.slice(0, 50)) {
      console.log(`  [WARN] ${f.id} ${f.file} — ${f.message}`);
    }
    console.log(
      `\n${result.summary.pass ? 'PASS' : 'FAIL'} — ${result.summary.errors} errors, ${result.summary.warnings} warnings\n`,
    );
    process.exit(result.summary.pass ? 0 : 1);
  }
}

module.exports = { run };
