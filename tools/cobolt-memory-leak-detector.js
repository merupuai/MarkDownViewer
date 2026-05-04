#!/usr/bin/env node

// CoBolt Memory Leak Detector — deterministic static analysis for memory leak patterns
//
// Detects common memory leak patterns in JS/TS, Elixir, Go, Python via pure
// regex/heuristic scanning. No exec/execSync. Runs in <5 seconds.
//
// Usage:
//   node tools/cobolt-memory-leak-detector.js scan [--dir src/] [--json] [--save]
//
// Exit codes:
//   0 = no high-severity leaks detected
//   1 = potential leaks detected

const fs = require('node:fs');
const path = require('node:path');

const { atomicWrite } = require('../lib/cobolt-atomic-write');

const { paths: _paths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();

// ── Language Detection ─────────────────────────────────────────

const LANG_MAP = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.go': 'go',
  '.py': 'python',
  '.pyw': 'python',
};

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
  '.nuxt',
  'vendor',
  '_cobolt-output',
  'coverage',
  '.tox',
  '.venv',
  'venv',
  'env',
  '.mypy_cache',
  '.claude',
  'static',
  'public',
  'assets',
]);

const SKIP_FILES = /(?:\.min\.js|\.bundle\.js|\.compiled\.|priv[/\\]static)/;

// ── File Walker ────────────────────────────────────────────────

function walkFiles(dir, langFilter) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      results.push(...walkFiles(full, langFilter));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      const lang = LANG_MAP[ext];
      if (!lang) continue;
      if (langFilter && !langFilter.includes(lang)) continue;
      if (SKIP_FILES.test(full)) continue;
      results.push({ file: full, lang });
    }
  }

  return results;
}

// ── Finding ID Counter ─────────────────────────────────────────
// Counter is reset per scan() call via the scanState object to avoid
// cross-invocation ID collisions when used programmatically.

const scanState = { counter: 0 };

function nextId(prefix) {
  scanState.counter++;
  return `${prefix}-${String(scanState.counter).padStart(3, '0')}`;
}

// ── Pattern Checkers ───────────────────────────────────────────

/**
 * Check 1: Event listeners without cleanup
 * addEventListener/on without corresponding removeEventListener/off/removeAllListeners
 * Languages: JS/TS
 */
function checkEventListenerLeaks(_content, lines, relPath, lang) {
  if (lang !== 'javascript' && lang !== 'typescript') return [];
  const findings = [];

  // Collect all addEventListener / .on( calls and remove* calls
  const addPatterns = [];
  const removePatterns = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // addEventListener
    const addMatch = line.match(/\.addEventListener\s*\(\s*['"`](\w+)['"`]/);
    if (addMatch) {
      addPatterns.push({ line: i + 1, event: addMatch[1], type: 'addEventListener', snippet: line.trim() });
    }

    // .on('event', ...)  — but not .once(
    const onMatch = line.match(/\.on\s*\(\s*['"`](\w+)['"`]/);
    if (onMatch && !/\.once\s*\(/.test(line)) {
      addPatterns.push({ line: i + 1, event: onMatch[1], type: '.on()', snippet: line.trim() });
    }

    // removeEventListener
    const removeAddMatch = line.match(/\.removeEventListener\s*\(\s*['"`](\w+)['"`]/);
    if (removeAddMatch) removePatterns.add(removeAddMatch[1]);

    // .off( or .removeListener(
    const offMatch = line.match(/\.(?:off|removeListener)\s*\(\s*['"`](\w+)['"`]/);
    if (offMatch) removePatterns.add(offMatch[1]);

    // removeAllListeners — clears everything
    if (/\.removeAllListeners\s*\(/.test(line)) {
      // If removeAllListeners is called, consider all events cleaned
      for (const p of addPatterns) removePatterns.add(p.event);
    }
  }

  // Flag addEventListener/on without matching remove
  for (const add of addPatterns) {
    if (!removePatterns.has(add.event)) {
      findings.push({
        id: nextId('LEAK'),
        type: 'event-listener-no-cleanup',
        severity: 'high',
        file: relPath,
        line: add.line,
        message: `${add.type} for "${add.event}" without corresponding cleanup (removeEventListener/off/removeAllListeners)`,
        snippet: add.snippet,
        suggestion: `Add a matching removeEventListener/off for "${add.event}" in cleanup/unmount/destroy lifecycle`,
      });
    }
  }

  return findings;
}

/**
 * Check 2: Unbounded caches (Map/Set/Object growing without eviction)
 * Languages: JS/TS, Elixir (ETS)
 */
function checkUnboundedCaches(content, lines, relPath, lang) {
  const findings = [];

  if (lang === 'javascript' || lang === 'typescript') {
    // Module-level Map/Set/Object used as cache
    // Look for: const cache = new Map() at module level with .set() but no .delete()/.clear()
    const cacheDecls = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const declMatch = line.match(/(?:const|let|var)\s+(\w+)\s*=\s*new\s+(?:Map|Set|WeakMap|WeakSet)\s*\(/);
      if (declMatch) {
        cacheDecls.push({ name: declMatch[1], line: i + 1, snippet: line.trim() });
      }
    }

    for (const decl of cacheDecls) {
      // WeakMap/WeakSet are GC-friendly — skip
      if (/WeakMap|WeakSet/.test(lines[decl.line - 1])) continue;

      const name = decl.name;
      const hasAdd = new RegExp(`\\b${name}\\s*\\.\\s*(?:set|add)\\s*\\(`).test(content);
      const hasEvict = new RegExp(`\\b${name}\\s*\\.\\s*(?:delete|clear)\\s*\\(`).test(content);
      const hasSizeCheck = new RegExp(`\\b${name}\\s*\\.\\s*size\\b`).test(content);

      if (hasAdd && !hasEvict && !hasSizeCheck) {
        findings.push({
          id: nextId('LEAK'),
          type: 'unbounded-cache',
          severity: 'high',
          file: relPath,
          line: decl.line,
          message: `Map/Set "${name}" grows via set/add but has no delete/clear eviction logic`,
          snippet: decl.snippet,
          suggestion: `Add eviction logic: check ${name}.size and delete oldest entries, or use an LRU cache library`,
        });
      }
    }
  }

  if (lang === 'elixir') {
    // ETS tables without size limit
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const etsMatch = line.match(/:ets\.new\s*\(\s*:(\w+)/);
      if (etsMatch) {
        // Check if there's a corresponding :ets.delete or size management
        const tableName = etsMatch[1];
        const hasDelete = /:ets\.delete\b/.test(content);
        const hasInfo = /:ets\.info\b/.test(content);
        const hasSelectDelete = /:ets\.(?:select_delete|match_delete)\b/.test(content);

        if (!hasDelete && !hasInfo && !hasSelectDelete) {
          findings.push({
            id: nextId('LEAK'),
            type: 'unbounded-ets',
            severity: 'high',
            file: relPath,
            line: i + 1,
            message: `ETS table :${tableName} created without eviction/delete logic`,
            snippet: line.trim(),
            suggestion: `Add periodic cleanup with :ets.select_delete or size checks with :ets.info`,
          });
        }
      }
    }
  }

  return findings;
}

/**
 * Check 3: Closures capturing large contexts in timers
 * setInterval/setTimeout with closures referencing variables from outer scope
 * Languages: JS/TS
 */
function checkClosureLeaks(content, lines, relPath, lang) {
  if (lang !== 'javascript' && lang !== 'typescript') return [];
  const findings = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // setInterval with inline function (not clearInterval nearby)
    const intervalMatch = line.match(/setInterval\s*\(/);
    if (intervalMatch) {
      // Check if the return value is stored (for clearInterval)
      const hasAssignment = /(?:const|let|var)\s+\w+\s*=\s*setInterval|(\w+)\s*=\s*setInterval/.test(line);
      // Check if clearInterval exists in the file
      const hasClear = /clearInterval\s*\(/.test(content);

      if (!hasAssignment && !hasClear) {
        findings.push({
          id: nextId('LEAK'),
          type: 'interval-no-clear',
          severity: 'medium',
          file: relPath,
          line: i + 1,
          message: 'setInterval without stored reference or clearInterval — interval runs forever',
          snippet: line.trim(),
          suggestion: 'Store the interval ID and call clearInterval in cleanup/destroy',
        });
      }
    }

    // setTimeout in a loop or recursive pattern
    if (/setTimeout\s*\(/.test(line)) {
      // Look for recursive setTimeout (function calling setTimeout with itself)
      const context = lines.slice(Math.max(0, i - 5), Math.min(lines.length, i + 10)).join('\n');
      if (/function\s+(\w+)[\s\S]*setTimeout\s*\(\s*\1/.test(context)) {
        // Recursive setTimeout is a pattern, not necessarily a leak — skip
      }
    }
  }

  return findings;
}

/**
 * Check 4: GenServer state accumulation
 * handle_cast/handle_info that only adds to state, never removes
 * Languages: Elixir
 */
function checkGenServerAccumulation(content, lines, relPath, lang) {
  if (lang !== 'elixir') return [];
  const findings = [];

  // Check if file defines a GenServer
  if (!/use GenServer/.test(content)) return findings;

  const handlePatterns = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match handle_cast, handle_info, handle_call
    const handleMatch = line.match(/def\s+(handle_(?:cast|info|call))\s*\(/);
    if (handleMatch) {
      // Gather the function body until next def or end at same indent
      const bodyLines = [];
      for (let j = i + 1; j < Math.min(lines.length, i + 30); j++) {
        if (/^\s*def[p]?\s/.test(lines[j])) break;
        if (/^\s*end\s*$/.test(lines[j])) {
          bodyLines.push(lines[j]);
          break;
        }
        bodyLines.push(lines[j]);
      }
      const body = bodyLines.join('\n');

      // Check for state growing patterns without removal
      const hasAppend = /\+\+|\[.*\|.*state|Map\.put|Map\.merge|put_in/.test(body);
      const hasRemove = /Map\.delete|List\.delete|Enum\.reject|Enum\.filter|tl\(|Keyword\.delete|pop_in/.test(body);

      if (hasAppend && !hasRemove) {
        handlePatterns.push({
          line: i + 1,
          handler: handleMatch[1],
          snippet: line.trim(),
        });
      }
    }
  }

  for (const hp of handlePatterns) {
    findings.push({
      id: nextId('LEAK'),
      type: 'genserver-state-accumulation',
      severity: 'medium',
      file: relPath,
      line: hp.line,
      message: `${hp.handler} appends to state without removal — state may grow unbounded`,
      snippet: hp.snippet,
      suggestion: 'Add state pruning logic (e.g., cap list size, expire old entries, or use :queue with max length)',
    });
  }

  return findings;
}

/**
 * Check 5: React useEffect without cleanup
 * useEffect with subscriptions/intervals but no return cleanup function
 * Languages: JS/TS (JSX/TSX)
 */
function checkUseEffectCleanup(content, lines, relPath, lang) {
  if (lang !== 'javascript' && lang !== 'typescript') return [];
  const findings = [];

  // Only check React-like files
  if (!/\buseEffect\b/.test(content)) return findings;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!/useEffect\s*\(/.test(line)) continue;

    // Gather the useEffect body (find matching closing)
    let braceDepth = 0;
    let started = false;
    const bodyLines = [];
    let bodyEnd = i;

    for (let j = i; j < Math.min(lines.length, i + 80); j++) {
      for (const ch of lines[j]) {
        if (ch === '(' && !started) {
          started = true;
        }
        if (ch === '{') braceDepth++;
        if (ch === '}') {
          braceDepth--;
          if (started && braceDepth === 0) {
            bodyEnd = j;
            break;
          }
        }
      }
      bodyLines.push(lines[j]);
      if (started && braceDepth === 0 && bodyEnd === j) break;
    }

    const body = bodyLines.join('\n');

    // Check if effect has side effects that need cleanup
    const hasSubscription = /addEventListener|\.on\s*\(|\.subscribe\s*\(/.test(body);
    const hasInterval = /setInterval\s*\(/.test(body);
    const _hasTimeout = /setTimeout\s*\(/.test(body);
    const _hasFetch = /fetch\s*\(|axios\.|\.get\s*\(|\.post\s*\(/.test(body);
    const hasWebSocket = /WebSocket|new\s+EventSource/.test(body);

    const needsCleanup = hasSubscription || hasInterval || hasWebSocket;

    if (!needsCleanup) continue;

    // Check if there's a return () => { ... } cleanup function
    const hasCleanup = /return\s*(?:\(\s*\)\s*=>|function\s*\()/.test(body);

    if (!hasCleanup) {
      const reasons = [];
      if (hasSubscription) reasons.push('event subscription');
      if (hasInterval) reasons.push('setInterval');
      if (hasWebSocket) reasons.push('WebSocket/EventSource');

      findings.push({
        id: nextId('LEAK'),
        type: 'useeffect-no-cleanup',
        severity: 'high',
        file: relPath,
        line: i + 1,
        message: `useEffect with ${reasons.join(', ')} but no cleanup return function`,
        snippet: line.trim(),
        suggestion: 'Add a return () => { ... } cleanup function to remove listeners/clear intervals/close connections',
      });
    }
  }

  return findings;
}

/**
 * Check 6: Global variable accumulation
 * Module-level arrays/objects that push/append but never trim
 * Languages: JS/TS, Python
 */
function checkGlobalAccumulation(content, lines, relPath, lang) {
  const findings = [];

  if (lang === 'javascript' || lang === 'typescript') {
    // Module-level arrays with .push() but no .splice()/.pop()/.shift()/length assignment
    const arrayDecls = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Module-level: no indentation or single-level const/let/var
      const declMatch = line.match(/^(?:const|let|var)\s+(\w+)\s*=\s*\[\s*\]/);
      if (declMatch) {
        arrayDecls.push({ name: declMatch[1], line: i + 1, snippet: line.trim() });
      }
    }

    for (const decl of arrayDecls) {
      const name = decl.name;
      const hasPush = new RegExp(`\\b${name}\\s*\\.\\s*push\\s*\\(`).test(content);
      const hasTrim = new RegExp(
        `\\b${name}\\s*\\.\\s*(?:splice|pop|shift|slice)\\s*\\(|\\b${name}\\s*\\.\\s*length\\s*=|\\b${name}\\s*=\\s*\\[`,
      ).test(content);

      // Only flag if array is pushed to and never trimmed
      // Also skip if it looks like it's inside a class/function (check indent)
      if (hasPush && !hasTrim) {
        findings.push({
          id: nextId('LEAK'),
          type: 'global-accumulation',
          severity: 'medium',
          file: relPath,
          line: decl.line,
          message: `Module-level array "${name}" grows via push() but is never trimmed`,
          snippet: decl.snippet,
          suggestion: `Add a maximum size check and trim old entries, or reset the array periodically`,
        });
      }
    }
  }

  if (lang === 'python') {
    // Module-level list with .append() but no clear()/pop()/del/slice assignment
    const listDecls = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Module-level: no leading whitespace
      const declMatch = line.match(/^(\w+)\s*(?::\s*[Ll]ist\s*(?:\[.*\])?\s*)?=\s*\[\s*\]/);
      if (declMatch) {
        listDecls.push({ name: declMatch[1], line: i + 1, snippet: line.trim() });
      }
    }

    for (const decl of listDecls) {
      const name = decl.name;
      const hasAppend = new RegExp(`\\b${name}\\s*\\.\\s*(?:append|extend|insert)\\s*\\(`).test(content);
      const hasTrim = new RegExp(
        `\\b${name}\\s*\\.\\s*(?:pop|remove|clear)\\s*\\(|\\bdel\\s+${name}\\b|\\b${name}\\s*=\\s*\\[|\\b${name}\\s*\\[.*:\\s*\\]`,
      ).test(content);

      if (hasAppend && !hasTrim) {
        findings.push({
          id: nextId('LEAK'),
          type: 'global-accumulation',
          severity: 'medium',
          file: relPath,
          line: decl.line,
          message: `Module-level list "${name}" grows via append/extend but is never trimmed`,
          snippet: decl.snippet,
          suggestion: `Add a maximum size check (e.g., collections.deque(maxlen=N)) or periodic clear()`,
        });
      }
    }
  }

  return findings;
}

/**
 * Check 7: Stream/connection not closed
 * createReadStream/createWriteStream/connect without .close/.end/.destroy
 * Languages: JS/TS, Python, Go
 */
function checkUnclosedStreams(content, lines, relPath, lang) {
  const findings = [];

  if (lang === 'javascript' || lang === 'typescript') {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // createReadStream / createWriteStream
      const streamMatch = line.match(
        /(?:const|let|var)\s+(\w+)\s*=\s*(?:fs\.)?(?:createReadStream|createWriteStream)\s*\(/,
      );
      if (streamMatch) {
        const name = streamMatch[1];
        const hasClose = new RegExp(`\\b${name}\\s*\\.\\s*(?:close|end|destroy|pipe)\\s*\\(`).test(content);
        const hasOn = new RegExp(`\\b${name}\\s*\\.\\s*on\\s*\\(\\s*['"\`](?:close|end|finish)['"\`]`).test(content);

        if (!hasClose && !hasOn) {
          findings.push({
            id: nextId('LEAK'),
            type: 'stream-not-closed',
            severity: 'medium',
            file: relPath,
            line: i + 1,
            message: `Stream "${name}" created but never closed/ended/destroyed`,
            snippet: line.trim(),
            suggestion: `Call ${name}.destroy() in a finally block or use pipeline() for automatic cleanup`,
          });
        }
      }

      // net.connect / net.createConnection / http.request without .end()
      const connMatch = line.match(
        /(?:const|let|var)\s+(\w+)\s*=\s*(?:net\.connect|net\.createConnection|http\.request|https\.request)\s*\(/,
      );
      if (connMatch) {
        const name = connMatch[1];
        const hasClosed = new RegExp(`\\b${name}\\s*\\.\\s*(?:end|destroy|close)\\s*\\(`).test(content);

        if (!hasClosed) {
          findings.push({
            id: nextId('LEAK'),
            type: 'connection-not-closed',
            severity: 'medium',
            file: relPath,
            line: i + 1,
            message: `Connection "${name}" opened but never closed/ended`,
            snippet: line.trim(),
            suggestion: `Call ${name}.end() or ${name}.destroy() when done`,
          });
        }
      }
    }
  }

  if (lang === 'python') {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // open() without 'with' context manager
      const openMatch = line.match(/(\w+)\s*=\s*open\s*\(/);
      if (openMatch && !/^\s*with\s/.test(line)) {
        const name = openMatch[1];
        const hasClose = new RegExp(`\\b${name}\\s*\\.\\s*close\\s*\\(`).test(content);

        if (!hasClose) {
          findings.push({
            id: nextId('LEAK'),
            type: 'file-not-closed',
            severity: 'medium',
            file: relPath,
            line: i + 1,
            message: `File handle "${name}" opened without context manager (with) and no .close()`,
            snippet: line.trim(),
            suggestion: 'Use "with open(...) as f:" for automatic cleanup',
          });
        }
      }
    }
  }

  if (lang === 'go') {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // os.Open / os.Create without defer .Close()
      const fileMatch = line.match(/(\w+)\s*(?:,\s*\w+)?\s*(?::=|=)\s*os\.(?:Open|Create|OpenFile)\s*\(/);
      if (fileMatch) {
        const name = fileMatch[1];
        // Look for defer name.Close() within next 5 lines
        const nextLines = lines.slice(i + 1, Math.min(lines.length, i + 6)).join('\n');
        const hasDefer = new RegExp(`defer\\s+${name}\\.Close\\s*\\(`).test(nextLines);

        if (!hasDefer) {
          findings.push({
            id: nextId('LEAK'),
            type: 'file-not-closed',
            severity: 'medium',
            file: relPath,
            line: i + 1,
            message: `File handle "${name}" opened without defer ${name}.Close()`,
            snippet: line.trim(),
            suggestion: `Add "defer ${name}.Close()" immediately after error check`,
          });
        }
      }
    }
  }

  return findings;
}

// ── Scanner ────────────────────────────────────────────────────

class MemoryLeakDetector {
  constructor(projectDir) {
    this.projectDir = projectDir || process.cwd();
  }

  scan(options = {}) {
    scanState.counter = 0;
    const dir = options.dir ? path.resolve(this.projectDir, options.dir) : this.projectDir;
    const langFilter = options.lang
      ? options.lang.split(',').map((l) => {
          const norm = { ts: 'typescript', js: 'javascript', py: 'python', ex: 'elixir' };
          return norm[l.trim().toLowerCase()] || l.trim().toLowerCase();
        })
      : null;

    const files = walkFiles(dir, langFilter);
    const findings = [];
    let scannedFiles = 0;

    for (const { file, lang } of files) {
      let content;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }

      const relPath = path.relative(this.projectDir, file);

      // Skip test files — they intentionally create and discard resources
      if (/(?:test|spec|_test\.|\.test\.|\.spec\.|__tests__|fixtures?|mocks?)/i.test(relPath)) continue;

      // Skip CoBolt infrastructure files
      if (/^(?:tools|source|scripts|bin|lib)[/\\]/.test(relPath)) continue;

      if (SKIP_FILES.test(relPath)) continue;

      const lines = content.split('\n');
      scannedFiles++;

      findings.push(...checkEventListenerLeaks(content, lines, relPath, lang));
      findings.push(...checkUnboundedCaches(content, lines, relPath, lang));
      findings.push(...checkClosureLeaks(content, lines, relPath, lang));
      findings.push(...checkGenServerAccumulation(content, lines, relPath, lang));
      findings.push(...checkUseEffectCleanup(content, lines, relPath, lang));
      findings.push(...checkGlobalAccumulation(content, lines, relPath, lang));
      findings.push(...checkUnclosedStreams(content, lines, relPath, lang));
    }

    // Compute severity counts
    const bySeverity = { high: 0, medium: 0, low: 0 };
    const byType = {};
    for (const f of findings) {
      bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
      byType[f.type] = (byType[f.type] || 0) + 1;
    }

    // Score: 100 - (high×18 + medium×8 + low×2)
    const score = Math.max(0, 100 - (bySeverity.high * 18 + bySeverity.medium * 8 + bySeverity.low * 2));

    let verdict;
    if (score >= 90) verdict = 'PASS';
    else if (score >= 75) verdict = 'WATCH';
    else verdict = 'FAIL';

    return {
      timestamp: new Date().toISOString(),
      tool: 'cobolt-memory-leak-detector',
      scannedFiles,
      totalFindings: findings.length,
      score,
      verdict,
      bySeverity,
      byType,
      findings,
    };
  }
}

// ── Output Helpers ─────────────────────────────────────────────

function getOutputDir() {
  const _p = typeof _paths === 'function' ? _paths() : null;
  if (_p) {
    const runDir = _p.currentRun();
    const auditDir = path.join(runDir, 'audit');
    if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
    return auditDir;
  }
  const fallback = path.join(process.cwd(), '_cobolt-output', 'latest', 'audit');
  if (!fs.existsSync(fallback)) fs.mkdirSync(fallback, { recursive: true, mode: 0o700 });
  return fallback;
}

function saveResult(filename, data) {
  const dir = getOutputDir();
  const filePath = path.join(dir, filename);
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  atomicWrite(filePath, content, { encoding: 'utf8' });
  return filePath;
}

function toMarkdown(result) {
  const lines = [
    '# Memory Leak Detection Report',
    '',
    `**Scan Date:** ${result.timestamp}`,
    `**Files Scanned:** ${result.scannedFiles}`,
    `**Score:** ${result.score}/100`,
    `**Verdict:** ${result.verdict}`,
    '',
    '---',
    '',
    '## Summary',
    '',
    `**Total Findings:** ${result.totalFindings}`,
    '',
    '| Severity | Count |',
    '|----------|-------|',
    `| HIGH     | ${result.bySeverity.high || 0} |`,
    `| MEDIUM   | ${result.bySeverity.medium || 0} |`,
    `| LOW      | ${result.bySeverity.low || 0} |`,
    '',
    '| Pattern | Count |',
    '|---------|-------|',
  ];

  for (const [type, count] of Object.entries(result.byType)) {
    lines.push(`| ${type} | ${count} |`);
  }
  lines.push('');

  if (result.findings.length > 0) {
    lines.push('---', '', '## Findings', '');
    for (const f of result.findings) {
      lines.push(
        `### ${f.id}: ${f.type}`,
        '',
        `- **File:** \`${f.file}:${f.line}\``,
        `- **Severity:** ${f.severity.toUpperCase()}`,
        `- **Message:** ${f.message}`,
        `- **Snippet:** \`${f.snippet}\``,
        `- **Suggestion:** ${f.suggestion}`,
        '',
      );
    }
  }

  lines.push('---', '', '*CoBolt Memory Leak Detector — Static Memory Leak Pattern Detection*');
  return lines.join('\n');
}

// ── CLI ────────────────────────────────────────────────────────

function printUsage() {
  console.log(`
  CoBolt Memory Leak Detector — static memory leak pattern detection
  ==================================================================

  Detects common memory leak patterns in JS/TS, Elixir, Go, Python.
  Pure regex/heuristic scanning. No exec/execSync.

  Usage: node tools/cobolt-memory-leak-detector.js <command> [options]

  Commands:
    scan              Scan for memory leak patterns

  Options:
    --dir <path>      Directory to scan (default: project root)
    --lang <list>     Comma-separated languages (js,ts,py,ex,go)
    --save            Save results to _cobolt-output/
    --json            Output as JSON
    --help            Show this help

  Exit codes:
    0 = no high-severity leaks detected
    1 = potential high-severity leaks detected

  Detected patterns:
    1. Event listeners without cleanup (addEventListener/on without remove) — HIGH
    2. Unbounded caches (Map/Set growing without eviction, ETS without limit) — HIGH
    3. Closures capturing large contexts (setInterval without clearInterval) — MEDIUM
    4. GenServer state accumulation (handle_cast/info that only grows state) — MEDIUM
    5. Missing cleanup in React useEffect (subscriptions without return cleanup) — HIGH
    6. Global variable accumulation (module-level push without trim) — MEDIUM
    7. Stream/connection not closed (createReadStream without close/destroy) — MEDIUM

  Scoring: 100 - (high×18 + medium×8 + low×2)
  Verdict: PASS (>=90), WATCH (>=75), FAIL (<75)
`);
}

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    printUsage();
    process.exit(0);
  }

  const command = args[0];
  if (command !== 'scan') {
    printUsage();
    process.exit(command ? 2 : 0);
  }

  let scanDir = null;
  let lang = null;
  const jsonMode = args.includes('--json');
  const saveMode = args.includes('--save');

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--dir' && args[i + 1]) {
      scanDir = args[++i];
    } else if (args[i] === '--lang' && args[i + 1]) {
      lang = args[++i];
    }
  }

  const detector = new MemoryLeakDetector(process.cwd());
  const options = {};
  if (scanDir) options.dir = scanDir;
  if (lang) options.lang = lang;

  const result = detector.scan(options);

  if (saveMode) {
    const jsonPath = saveResult('memory-leak-findings.json', result);
    const mdPath = saveResult('memory-leak-findings.md', toMarkdown(result));
    if (!jsonMode) {
      console.log(`[cobolt-memory-leak-detector] Results saved:`);
      console.log(`  JSON: ${jsonPath}`);
      console.log(`  MD:   ${mdPath}`);
    }
  }

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[cobolt-memory-leak-detector] Score: ${result.score}/100 — ${result.verdict}`);
    console.log(`  Files scanned: ${result.scannedFiles}`);
    console.log(
      `  Findings: ${result.totalFindings} (high: ${result.bySeverity.high}, medium: ${result.bySeverity.medium}, low: ${result.bySeverity.low})`,
    );

    if (result.findings.length > 0) {
      console.log('');
      for (const f of result.findings) {
        const sev = f.severity.toUpperCase().padEnd(6);
        console.log(`  ${sev} ${f.file}:${f.line} — ${f.message}`);
      }
    }
  }

  // Exit 1 if any high-severity leaks found
  process.exit(result.bySeverity.high > 0 ? 1 : 0);
}

module.exports = { MemoryLeakDetector, toMarkdown, saveResult };
