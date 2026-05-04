#!/usr/bin/env node

// CoBolt N+1 Query Detector — deterministic database query anti-pattern detection
//
// Detects loop-inside-query patterns, missing preloads/joins, unbounded SELECTs,
// and sequential API calls that could be batched.
//
// Supports: Ecto (Elixir), Sequelize/Prisma/Knex (JS/TS), SQLAlchemy/Django (Python), GORM (Go)
//
// No LLM inference. Pure regex/heuristic scanning.
//
// Usage:
//   node tools/cobolt-n-plus-one-detector.js scan [--dir src/] [--json] [--save]
//
// Exit codes:
//   0 = no high-severity patterns found
//   1 = high-severity N+1 patterns detected

const fs = require('node:fs');
const path = require('node:path');

const { paths: _paths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();

// ── Configuration ─────────────────────────────────────────

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.ex', '.exs']);

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '_build',
  'deps',
  '__pycache__',
  '.elixir_ls',
  'dist',
  'build',
  'target',
  '.next',
  'coverage',
  '_cobolt-output',
  '.claude',
  'vendor',
  'test',
  'tests',
  'spec',
]);

// ── Pattern Definitions ──────���────────────────────────────

const PATTERNS = {
  // N+1: DB query inside a loop
  loopQuery: {
    id: 'NP1',
    severity: 'high',
    message: 'Database query inside a loop — likely N+1 pattern',
    suggestion: 'Use batch query, preload, or join instead of per-iteration queries.',
    matchers: [
      // Ecto: Enum.map/each/reduce with Repo.get/one/all inside
      { lang: ['ex', 'exs'], loop: /Enum\.(map|each|reduce|filter)\b/, query: /Repo\.(get|get!|one|one!|all)\b/ },
      // Ecto: for comprehension with Repo query
      { lang: ['ex', 'exs'], loop: /\bfor\s+\w+\s+<-/, query: /Repo\.(get|get!|one|one!|all|insert|update|delete)\b/ },
      // JS: .map/.forEach/.for with await db query
      {
        lang: ['js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs'],
        loop: /\.(map|forEach|reduce|filter)\s*\(/,
        query: /await\s+.*\.(find|findOne|findAll|query|execute|get|select|where)\s*\(/,
      },
      // JS: for...of with await query
      {
        lang: ['js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs'],
        loop: /for\s*\(.*\bof\b/,
        query: /await\s+.*\.(find|findOne|findAll|query|execute)\s*\(/,
      },
      // Python: for loop with ORM query
      {
        lang: ['py'],
        loop: /\bfor\s+\w+\s+in\b/,
        query: /\.(query|filter|get|objects\.get|objects\.filter|execute|fetchone|fetchall)\s*\(/,
      },
      // Go: for range with db query
      { lang: ['go'], loop: /for\s+.*:?=\s*range\b/, query: /\.(Find|First|Where|Raw|Exec|Query|QueryRow)\s*\(/ },
    ],
  },

  // Missing preload/eager loading
  missingPreload: {
    id: 'NP2',
    severity: 'medium',
    message: 'Query loads association without preload — may cause N+1 on access',
    suggestion: 'Add preload/include/eager_load to the initial query.',
    matchers: [
      // Ecto: Repo.all without preload, followed by accessing association
      { lang: ['ex', 'exs'], pattern: /Repo\.(all|get|one)\b(?!.*preload)/ },
      // Sequelize: findAll without include
      { lang: ['js', 'ts', 'tsx', 'jsx'], pattern: /\.findAll\s*\(\s*\{(?![\s\S]*include)/ },
      // Django: objects.all() without select_related/prefetch_related
      { lang: ['py'], pattern: /objects\.(all|filter)\(\)(?!.*(?:select_related|prefetch_related))/ },
    ],
  },

  // Unbounded SELECT (no LIMIT)
  unboundedSelect: {
    id: 'NP3',
    severity: 'medium',
    message: 'Query without LIMIT may return unbounded results',
    suggestion: 'Add LIMIT/pagination to prevent loading entire tables.',
    matchers: [
      { lang: ['ex', 'exs'], pattern: /Repo\.all\s*\(\s*\w+\s*\)(?!.*limit)/ },
      { lang: ['js', 'ts', 'tsx', 'jsx'], pattern: /\.findAll\s*\(\s*\)/ },
      { lang: ['py'], pattern: /\.objects\.all\(\)(?!.*\[:)/ },
      { lang: ['go'], pattern: /\.Find\s*\(\s*&\w+\s*\)(?!.*Limit)/ },
    ],
  },

  // Sequential API calls that could be batched
  sequentialApiCalls: {
    id: 'NP4',
    severity: 'low',
    message: 'Sequential await calls that could be parallelized with Promise.all',
    suggestion: 'Use Promise.all([...]) or Task.async_stream for parallel execution.',
    matchers: [
      // JS: multiple sequential awaits to same API
      { lang: ['js', 'ts', 'tsx', 'jsx', 'mjs'], pattern: /await\s+fetch\s*\(/g, minOccurrences: 3 },
      // Elixir: sequential Task.await calls
      { lang: ['ex', 'exs'], pattern: /Task\.await\s*\(/g, minOccurrences: 3 },
    ],
  },

  // SELECT * anti-pattern
  selectStar: {
    id: 'NP5',
    severity: 'low',
    message: 'SELECT * loads all columns — specify only needed columns',
    suggestion: 'Use select() to specify columns, reducing memory and network overhead.',
    matchers: [
      { lang: ['js', 'ts', 'py', 'go', 'ex'], pattern: /SELECT\s+\*\s+FROM/i },
      { lang: ['js', 'ts'], pattern: /\.query\s*\(\s*['"`]SELECT\s+\*/i },
    ],
  },
};

// ── File Walker ───────��───────────────────────────────────

function walkFiles(rootDir, collected = []) {
  if (!fs.existsSync(rootDir)) return collected;
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return collected;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, collected);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      collected.push(fullPath);
    }
  }
  return collected;
}

// ── Scanner ───────────────────────────────────────────────

function scanFile(filePath, projectDir) {
  const findings = [];
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return findings;
  }

  const ext = path.extname(filePath).slice(1); // remove dot
  const relFile = path.relative(projectDir, filePath);
  const lines = content.split('\n');

  for (const [, patternDef] of Object.entries(PATTERNS)) {
    for (const matcher of patternDef.matchers) {
      if (!matcher.lang.includes(ext)) continue;

      // Loop+Query pattern (N+1 detection) — stack-based for nested loops
      if (matcher.loop && matcher.query) {
        const loopStack = []; // { startLine, braceDepth }

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const opens = (line.match(/\{/g) || []).length;
          const closes = (line.match(/\}/g) || []).length;

          if (matcher.loop.test(line)) {
            loopStack.push({ startLine: i + 1, braceDepth: 0 });
          }

          // Update brace depth for all active loops
          for (const loop of loopStack) {
            loop.braceDepth += opens - closes;
          }

          // Check query inside any active loop
          if (loopStack.length > 0 && matcher.query.test(line)) {
            const innerLoop = loopStack[loopStack.length - 1];
            findings.push({
              id: `${patternDef.id}-${String(findings.length + 1).padStart(3, '0')}`,
              type: patternDef.id,
              severity: patternDef.severity,
              file: relFile,
              line: i + 1,
              loopLine: innerLoop.startLine,
              message: patternDef.message,
              snippet: line.trim().substring(0, 120),
              suggestion: patternDef.suggestion,
            });
          }

          // Pop completed loops from stack (brace depth back to 0 or below)
          while (loopStack.length > 0) {
            const top = loopStack[loopStack.length - 1];
            if (top.braceDepth <= 0 && i >= top.startLine) {
              loopStack.pop();
            } else {
              break;
            }
          }
        }
        continue;
      }

      // Simple pattern matching
      if (matcher.pattern) {
        if (matcher.minOccurrences) {
          const matches = content.match(matcher.pattern);
          if (matches && matches.length >= matcher.minOccurrences) {
            findings.push({
              id: `${patternDef.id}-${String(findings.length + 1).padStart(3, '0')}`,
              type: patternDef.id,
              severity: patternDef.severity,
              file: relFile,
              line: 0,
              message: `${patternDef.message} (${matches.length} occurrences)`,
              suggestion: patternDef.suggestion,
            });
          }
          continue;
        }

        for (let i = 0; i < lines.length; i++) {
          matcher.pattern.lastIndex = 0;
          if (matcher.pattern.test(lines[i])) {
            findings.push({
              id: `${patternDef.id}-${String(findings.length + 1).padStart(3, '0')}`,
              type: patternDef.id,
              severity: patternDef.severity,
              file: relFile,
              line: i + 1,
              message: patternDef.message,
              snippet: lines[i].trim().substring(0, 120),
              suggestion: patternDef.suggestion,
            });
          }
        }
      }
    }
  }

  return findings;
}

function scan(projectDir, options = {}) {
  const scanDir = options.dir ? path.resolve(projectDir, options.dir) : projectDir;
  const files = walkFiles(scanDir);

  const allFindings = [];
  for (const file of files) {
    allFindings.push(...scanFile(file, projectDir));
  }

  const filtered = options.severity ? allFindings.filter((f) => f.severity === options.severity) : allFindings;

  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const f of filtered) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;

  const byType = {};
  for (const f of filtered) byType[f.type] = (byType[f.type] || 0) + 1;

  const penalties = { high: 18, medium: 8, low: 2 };
  const totalPenalty = filtered.reduce((s, f) => s + (penalties[f.severity] || 0), 0);
  const score = Math.max(0, 100 - totalPenalty);

  return {
    findings: filtered,
    summary: { total: filtered.length, bySeverity, byType, filesScanned: files.length },
    score,
    verdict: score >= 90 ? 'PASS' : score >= 75 ? 'WATCH' : 'FAIL',
    timestamp: new Date().toISOString(),
  };
}

function writeReport(projectDir, result) {
  const _p = typeof _paths === 'function' ? _paths(projectDir) : null;
  const outDir = _p ? _p.review() : path.join(projectDir, '_cobolt-output/latest/review');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const dest = path.join(outDir, 'n-plus-one-report.json');
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, dest);
  return dest;
}

module.exports = { scan, writeReport, PATTERNS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === 'scan') {
    const options = {};
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--dir' && args[i + 1]) options.dir = args[++i];
      else if (args[i] === '--severity' && args[i + 1]) options.severity = args[++i];
      else if (args[i] === '--json') options.json = true;
      else if (args[i] === '--save') options.save = true;
    }

    const result = scan(process.cwd(), options);

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\n  CoBolt N+1 Query Detector — ${result.summary.filesScanned} files scanned`);
      console.log('  ═════════��════════════════════════════════════');
      console.log(
        `  High: ${result.summary.bySeverity.high || 0} | Medium: ${result.summary.bySeverity.medium || 0} | Low: ${result.summary.bySeverity.low || 0}`,
      );
      console.log(`  Score: ${result.score}% �� ${result.verdict}`);
      console.log('  ════════���═════════════════════════════════════');

      for (const f of result.findings.slice(0, 20)) {
        const icon = f.severity === 'high' ? '\u2717' : f.severity === 'medium' ? '\u26A0' : '\u2022';
        const loc = f.line > 0 ? `:${f.line}` : '';
        console.log(`  ${icon} [${f.type}] ${f.file}${loc} — ${f.message}`);
      }
      if (result.findings.length > 20) console.log(`  ... and ${result.findings.length - 20} more`);
    }

    if (options.save) {
      const dest = writeReport(process.cwd(), result);
      if (!options.json) console.log(`\n  Report saved: ${dest}`);
    }

    process.exit(result.findings.some((f) => f.severity === 'high') ? 1 : 0);
  }

  console.log('  CoBolt N+1 Query Detector');
  console.log(
    '  Usage: node tools/cobolt-n-plus-one-detector.js scan [--dir src/] [--severity high|medium|low] [--json] [--save]',
  );
}
