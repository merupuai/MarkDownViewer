#!/usr/bin/env node

// CoBolt Semantic Stub Check - deterministic stub/no-op detector

const fs = require('node:fs');
const path = require('node:path');
const { buildProvenance } = require('./_brownfield-provenance');
const { walkFilteredFiles } = require('./_brownfield-scan-filter');

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.go', '.py', '.rb', '.java', '.rs', '.ex', '.exs']);
const STUB_PATTERNS = [
  /\bnot fully implemented\b/i,
  /\bnot implemented\b/i,
  /\bplaceholder\b/i,
  /\bTODO\b/i,
  /\bFIXME\b/i,
  /\bmock data\b/i,
  /throw new Error\(["']not implemented["']\)/i,
  /errors\.New\(["'][^"']*not[^"']*implemented[^"']*["']\)/i,
  // Go HTTP stub patterns: handlers returning hardcoded JSON with no real logic
  /w\.WriteHeader\(http\.StatusNotImplemented\)/,
  /w\.WriteHeader\(http\.StatusServiceUnavailable\)/,
  // Go/JS/TS: placeholder string values in responses (matches the VALUE, not the full json.Encode chain)
  /["'](?:redirect to |coming soon|under construction|not yet implemented|pending implementation)/i,
  // Go handlers with Encode of a literal map on same line
  /Encode\(map\[string\]string\{/,
];

// Multi-line Go stub detection: handler functions that write a JSON response
// but never call a service, repository, or database.
const GO_HANDLER_STUB_PATTERN = /^func\s+(?:\([^)]*\)\s+)?Handle\w+\s*\(/;
const GO_REAL_WORK_INDICATORS = [
  /\b(?:repo|repository|service|store|cache|client|db|tx)\b/i,
  /\.(?:Create|Update|Delete|Find|Get|List|Query|Insert|Select|Exec)\s*\(/,
  /(?:nats|redis|kafka|amqp|rabbit)\./i,
  /r\.(?:Body|FormValue|URL\.Query|ParseForm|ParseMultipartForm)/,
  /context\.(?:WithTimeout|WithCancel|WithValue)/,
  /sql\.(?:Open|Query|Exec)/,
];

function isSourceFile(filePath) {
  return SOURCE_EXTENSIONS.has(path.extname(filePath));
}

/**
 * Extract Go function body between braces starting from line index.
 * Returns { body: string, endLine: number, bodyLines: number } or null.
 */
function extractGoFuncBody(lines, startIdx) {
  let braceDepth = 0;
  let bodyStart = -1;
  let bodyEnd = startIdx;

  for (let j = startIdx; j < Math.min(lines.length, startIdx + 200); j++) {
    for (const ch of lines[j]) {
      if (ch === '{') {
        braceDepth++;
        if (bodyStart === -1) bodyStart = j + 1;
      }
      if (ch === '}') {
        braceDepth--;
        if (braceDepth === 0) {
          bodyEnd = j;
          const bodyLines = lines.slice(bodyStart, bodyEnd).filter((l) => l.trim() && !l.trim().startsWith('//'));
          return { body: bodyLines.join('\n'), endLine: bodyEnd, bodyLines: bodyLines.length };
        }
      }
    }
  }
  return null;
}

function scan(projectDir) {
  const findings = [];
  const { files, skipped } = walkFilteredFiles(projectDir, isSourceFile);
  for (const filePath of files) {
    const relativePath = path.relative(projectDir, filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const isGoFile = path.extname(filePath) === '.go';
    const isTestFile = /(?:_test\.go|\.test\.|\.spec\.|tests?[/\\])/i.test(relativePath);

    // Line-by-line pattern matching (all languages)
    lines.forEach((line, index) => {
      for (const pattern of STUB_PATTERNS) {
        if (!pattern.test(line)) continue;
        findings.push({
          id: `STUB-${String(findings.length + 1).padStart(3, '0')}`,
          file: relativePath,
          line: index + 1,
          pattern: pattern.toString(),
          snippet: line.trim(),
        });
        break;
      }
    });

    // Go handler-level stub detection: finds Handle* functions that write JSON
    // but never call a service, repository, or read the request body.
    if (isGoFile && !isTestFile) {
      for (let i = 0; i < lines.length; i++) {
        if (!GO_HANDLER_STUB_PATTERN.test(lines[i])) continue;
        const funcInfo = extractGoFuncBody(lines, i);
        if (!funcInfo || funcInfo.bodyLines > 15 || funcInfo.bodyLines < 1) continue;

        const hasJsonWrite =
          /json\.(?:NewEncoder|Marshal)/.test(funcInfo.body) || /w\.Write(?:Header)?\s*\(/.test(funcInfo.body);
        if (!hasJsonWrite) continue;

        const hasRealWork = GO_REAL_WORK_INDICATORS.some((pattern) => pattern.test(funcInfo.body));
        if (!hasRealWork) {
          const funcName = lines[i].match(/(?:Handle\w+)/)?.[0] || 'unknown';
          findings.push({
            id: `STUB-${String(findings.length + 1).padStart(3, '0')}`,
            file: relativePath,
            line: i + 1,
            pattern: 'go-handler-no-real-work',
            snippet: `${funcName}: writes JSON response but never calls service/repo/db or reads request body`,
          });
        }
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-semantic-stub-check',
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
    console.log('Usage: node tools/cobolt-semantic-stub-check.js scan [project-path] [--json] [--output <path>]');
    process.exit(command ? 2 : 0);
  }

  const report = scan(projectDir);
  const targetPath =
    outputPath || path.join(projectDir, '_cobolt-output', 'latest', 'brownfield', 'semantic-stub-findings.json');
  writeReport(targetPath, report);

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[cobolt-semantic-stub-check] ${report.summary.findings} stub markers found`);
    console.log(`  Written: ${targetPath}`);
  }

  process.exit(report.summary.findings === 0 ? 0 : 1);
}

module.exports = { scan, writeReport, STUB_PATTERNS };
