#!/usr/bin/env node

/**
 * cobolt-test-assertion-quality.js — Deterministic test assertion quality checker
 *
 * Verifies test files contain meaningful assertions, not vacuous ones
 * (expect(true).toBe(true)), empty test bodies, or comment-only tests.
 *
 * Usage:
 *   node tools/cobolt-test-assertion-quality.js scan [--files f1,f2] [--json]
 */

const fs = require('node:fs');
const path = require('node:path');

const TEST_EXTENSIONS = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.mts', '.cs']);
const IGNORED_DIRS = new Set(['.git', 'node_modules', '_cobolt-output', 'dist', 'build', 'coverage']);

// Patterns for test block detection
const TEST_BLOCK_RE = /\b(?:it|test|specify)\s*\(\s*['"`]/g;
const _DESCRIBE_BLOCK_RE = /\b(?:describe|context|suite)\s*\(\s*['"`]/g;
const CSHARP_TEST_ATTRIBUTE_RE = /^\s*\[(?:Fact|Theory|Test|TestMethod|DataTestMethod)(?:\s*\([^)]*\))?\]\s*$/;

// Assertion patterns (what counts as a real assertion)
const ASSERTION_PATTERNS = [
  /\bexpect(?:\.\w+)?\s*\(/g,
  /\bassert(?:\.\w+)?\s*\(/g,
  /\bshould\.\w+\s*\(/g,
  /\.\s*should\b/g,
  /\bAssert\.\w+\s*\(/g,
  /\b(?:CollectionAssert|StringAssert)\.\w+\s*\(/g,
  /\.Should\s*\(/g,
];

// Vacuous assertion patterns (always-true)
const VACUOUS_PATTERNS = [
  /expect\s*\(\s*true\s*\)\s*\.toBe\s*\(\s*true\s*\)/,
  /expect\s*\(\s*false\s*\)\s*\.toBe\s*\(\s*false\s*\)/,
  /expect\s*\(\s*1\s*\)\s*\.toBe\s*\(\s*1\s*\)/,
  /expect\s*\(\s*0\s*\)\s*\.toBe\s*\(\s*0\s*\)/,
  /expect\s*\(\s*['"`].*['"`]\s*\)\s*\.toBe\s*\(\s*['"`].*['"`]\s*\)/,
  /expect\s*\(\s*null\s*\)\s*\.toBeNull\s*\(\s*\)/,
  /expect\s*\(\s*undefined\s*\)\s*\.toBeUndefined\s*\(\s*\)/,
  /expect\s*\(\s*true\s*\)\s*\.toBeTruthy\s*\(\s*\)/,
  /expect\s*\(\s*false\s*\)\s*\.toBeFalsy\s*\(\s*\)/,
  /assert\s*\(\s*true\s*\)/,
  /assert\.ok\s*\(\s*true\s*\)/,
  /assert\.strictEqual\s*\(\s*true\s*,\s*true\s*\)/,
  /assert\.strictEqual\s*\(\s*1\s*,\s*1\s*\)/,
  /Assert\.True\s*\(\s*true\s*\)/,
  /Assert\.False\s*\(\s*false\s*\)/,
  /Assert\.Equal\s*\(\s*1\s*,\s*1\s*\)/,
  /Assert\.Equal\s*\(\s*0\s*,\s*0\s*\)/,
  /Assert\.Equal\s*\(\s*"([^"]*)"\s*,\s*"\1"\s*\)/,
];

function isTestFile(filePath) {
  const name = path.basename(filePath).toLowerCase();
  const ext = path.extname(filePath);
  if (!TEST_EXTENSIONS.has(ext)) return false;
  return (
    /\.(test|spec|_test)\b/.test(name) ||
    /^test[_-]/.test(name) ||
    filePath.includes('/test/') ||
    filePath.includes('/tests/') ||
    filePath.includes('\\test\\') ||
    filePath.includes('\\tests\\')
  );
}

function walkTestFiles(rootDir, collected = []) {
  if (!fs.existsSync(rootDir)) return collected;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        walkTestFiles(fullPath, collected);
      }
      continue;
    }
    if (isTestFile(fullPath)) {
      collected.push(fullPath);
    }
  }
  return collected;
}

function stripComments(content) {
  return content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function countAssertions(content) {
  let count = 0;
  for (const pattern of ASSERTION_PATTERNS) {
    count += (content.match(pattern) || []).length;
  }
  return count;
}

function extractTestBlocks(content) {
  const blocks = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    if (TEST_BLOCK_RE.test(lines[i])) {
      TEST_BLOCK_RE.lastIndex = 0;

      // Find the test block body (simplistic brace matching)
      let braceDepth = 0;
      let blockStarted = false;
      const bodyLines = [];
      const bodyStart = i;

      for (let j = i; j < lines.length && j < i + 100; j++) {
        const line = lines[j];
        for (const ch of line) {
          if (ch === '{') {
            braceDepth++;
            blockStarted = true;
          }
          if (ch === '}' && blockStarted) {
            braceDepth--;
          }
        }

        if (blockStarted) {
          bodyLines.push(line);
        }

        if (blockStarted && braceDepth <= 0) break;
      }

      blocks.push({
        line: i + 1,
        title: lines[i].trim(),
        body: bodyLines.join('\n'),
        bodyStart: bodyStart + 1,
      });
    }
    TEST_BLOCK_RE.lastIndex = 0;
  }

  return blocks;
}

function extractCSharpTestBlocks(content) {
  const blocks = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    if (!CSHARP_TEST_ATTRIBUTE_RE.test(lines[i])) continue;

    let signatureIndex = i + 1;
    while (signatureIndex < lines.length && lines[signatureIndex].trim() === '') signatureIndex += 1;

    let braceDepth = 0;
    let blockStarted = false;
    const bodyLines = [lines[i]];

    for (let j = signatureIndex; j < lines.length && j < signatureIndex + 160; j += 1) {
      const line = lines[j];
      bodyLines.push(line);
      for (const ch of line) {
        if (ch === '{') {
          braceDepth += 1;
          blockStarted = true;
        }
        if (ch === '}' && blockStarted) {
          braceDepth -= 1;
        }
      }

      if (blockStarted && braceDepth <= 0) break;
    }

    blocks.push({
      line: i + 1,
      title: (lines[signatureIndex] || lines[i]).trim(),
      body: bodyLines.join('\n'),
      bodyStart: i + 1,
    });
  }

  return blocks;
}

function analyzeFile(filePath, projectDir) {
  const findings = [];
  const relativePath = path.relative(projectDir, filePath);

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { findings, testsFound: 0, totalAssertions: 0 };
  }

  const ext = path.extname(filePath).toLowerCase();
  const testBlocks = ext === '.cs' ? extractCSharpTestBlocks(content) : extractTestBlocks(content);
  let totalAssertions = 0;

  for (const block of testBlocks) {
    const body = block.body;
    const executableBody = stripComments(body);
    const assertionCount = countAssertions(executableBody);

    // Check: assertion-free test
    if (assertionCount === 0) {
      // Check if it's comment-only
      const stripped = executableBody.trim();
      const nonEmpty = stripped.replace(/[{}\s();\n]/g, '');

      if (nonEmpty.length < 5) {
        findings.push({
          check: 'comment-only',
          file: relativePath,
          line: block.bodyStart,
          snippet: block.title.slice(0, 120),
          message: 'Test body contains only comments/whitespace — no executable code',
        });
      } else {
        findings.push({
          check: 'assertion-free',
          file: relativePath,
          line: block.bodyStart,
          snippet: block.title.slice(0, 120),
          message: 'Test block has no assertions (expect/assert/should) — test verifies nothing',
        });
      }
      continue;
    }

    // Count assertions
    totalAssertions += assertionCount;

    // Check: vacuous assertions
    for (const pattern of VACUOUS_PATTERNS) {
      if (pattern.test(executableBody)) {
        findings.push({
          check: 'vacuous',
          file: relativePath,
          line: block.bodyStart,
          snippet: block.title.slice(0, 120),
          message: 'Test contains a vacuous assertion (always passes regardless of implementation)',
        });
        break;
      }
    }
  }

  // Check: low assertion density
  if (testBlocks.length > 0) {
    const density = totalAssertions / testBlocks.length;
    if (density < 1) {
      findings.push({
        check: 'low-density',
        file: relativePath,
        line: 1,
        snippet: `${totalAssertions} assertions across ${testBlocks.length} tests (density: ${density.toFixed(2)})`,
        message: `Low assertion density: ${density.toFixed(2)} assertions per test (minimum: 1.0)`,
      });
    }
  }

  return { findings, testsFound: testBlocks.length, totalAssertions };
}

function scan(projectDir, targetFiles) {
  let files;

  if (targetFiles && targetFiles.length > 0) {
    files = targetFiles.map((f) => path.resolve(projectDir, f)).filter((f) => fs.existsSync(f));
  } else {
    files = walkTestFiles(projectDir);
  }

  const allFindings = [];
  let totalTests = 0;
  let totalAssertions = 0;

  for (const file of files) {
    const result = analyzeFile(file, projectDir);
    allFindings.push(...result.findings);
    totalTests += result.testsFound;
    totalAssertions += result.totalAssertions;
  }

  // Assign IDs
  allFindings.forEach((f, i) => {
    f.id = `TAQ-${String(i + 1).padStart(3, '0')}`;
  });

  const vacuous = allFindings.filter((f) => f.check === 'vacuous').length;
  const assertionFree = allFindings.filter((f) => f.check === 'assertion-free').length;
  const commentOnly = allFindings.filter((f) => f.check === 'comment-only').length;
  const lowDensity = allFindings.filter((f) => f.check === 'low-density').length;
  const errors = vacuous + assertionFree + commentOnly;

  return {
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-test-assertion-quality',
    summary: {
      filesScanned: files.length,
      testsFound: totalTests,
      totalAssertions,
      vacuous,
      assertionFree,
      commentOnly,
      lowDensity,
      errors,
      pass: errors === 0,
    },
    findings: allFindings,
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];
  const jsonMode = args.includes('--json');
  let projectDir = process.cwd();
  let targetFiles = null;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--files' && args[i + 1]) {
      targetFiles = args[++i].split(',').map((f) => f.trim());
    } else if (!args[i].startsWith('--')) {
      projectDir = path.resolve(args[i]);
    }
  }

  if (command !== 'scan') {
    console.log('Usage: node tools/cobolt-test-assertion-quality.js scan [--files f1,f2] [--json]');
    process.exit(command ? 2 : 0);
  }

  const report = scan(projectDir, targetFiles);

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `[cobolt-test-assertion-quality] ${report.summary.errors} error(s), ${report.summary.lowDensity} warning(s)`,
    );
    console.log(`  Tests: ${report.summary.testsFound}, Assertions: ${report.summary.totalAssertions}`);
    console.log(
      `  Vacuous: ${report.summary.vacuous}, Empty: ${report.summary.assertionFree}, Comment-only: ${report.summary.commentOnly}`,
    );
    if (!report.summary.pass) {
      for (const f of report.findings.filter((x) => x.check !== 'low-density').slice(0, 10)) {
        console.log(`  ${f.id}: ${f.file}:${f.line} — ${f.check}: ${f.message}`);
      }
    }
  }

  process.exit(report.summary.pass ? 0 : 1);
}

module.exports = { scan, analyzeFile, isTestFile };
