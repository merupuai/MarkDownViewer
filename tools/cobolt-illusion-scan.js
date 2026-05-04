#!/usr/bin/env node

// CoBolt Illusion Scanner — deterministic behavioral illusion detection.
//
// Catches code that LOOKS complete but isn't doing real work. Unlike cobolt-audit.js
// (which catches explicit stubs like TODO/NotImplementedError), this scanner detects
// BEHAVIORAL illusions: functions that appear implemented but are actually facades,
// pass-throughs, mock-data generators, or no-op wrappers.
//
// No LLM inference. Pure regex/heuristic scanning. Runs in <5 seconds.
//
// Usage:
//   node tools/cobolt-illusion-scan.js scan [--dir src/] [--json] [--out <file>] [--save]
//   node tools/cobolt-illusion-scan.js scan --threshold 0 --json
//   node tools/cobolt-illusion-scan.js report
//
// Exit codes:
//   0 = no critical illusions found
//   1 = critical illusions detected

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
  '.py': 'python',
  '.pyw': 'python',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.jsx': 'javascript',
  '.cs': 'csharp',
  '.go': 'go',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.rs': 'rust',
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

// Files to skip (compiled bundles, minified files, generated code)
const SKIP_FILES = /(?:\.min\.js|\.bundle\.js|\.compiled\.|priv[/\\]static)/;

function splitParameterList(rawParams) {
  const params = [];
  let current = '';
  let depth = 0;
  for (const ch of rawParams) {
    if (ch === ',' && depth === 0) {
      params.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
    if (ch === '<' || ch === '(' || ch === '[' || ch === '{') depth++;
    if ((ch === '>' || ch === ')' || ch === ']' || ch === '}') && depth > 0) depth--;
  }
  if (current.trim()) params.push(current.trim());
  return params;
}

function parseParameterName(rawParam, lang) {
  let param = String(rawParam || '')
    .replace(/\[[^\]]*\]/g, '')
    .split('=')[0]
    .trim();
  if (!param || param.startsWith('_') || param.startsWith('...') || param.startsWith('*')) return null;

  if (lang === 'csharp') {
    param = param.replace(/\b(?:ref|out|in|params|this)\b\s*/g, '').trim();
    const parts = param.split(/\s+/).filter(Boolean);
    const name = parts
      .at(-1)
      ?.replace(/[?*]+$/u, '')
      .trim();
    return /^[A-Za-z_]\w*$/u.test(name || '') ? name : null;
  }

  return param.split(/[\s:=]/)[0].trim();
}

// ── Illusion Pattern Library ──────────────────────────────────
//
// These detect code that appears complete (no TODO/stub markers)
// but isn't performing real work. Each pattern targets a specific
// behavioral illusion category.

const ILLUSION_PATTERNS = [
  // ─── CRITICAL: Definitely an illusion ───

  // Functions that return hardcoded data pretending to be dynamic
  {
    id: 'hardcoded-collection',
    severity: 'critical',
    category: 'mock-data',
    desc: 'Returns hardcoded array/list pretending to be dynamic data',
    test: (fn) => {
      if (fn.bodyLines > 8) return null;
      // Returns a literal array/list with 2+ items and no variable/param usage
      const returnsLiteral = /return\s+\[[\s\S]*?,[\s\S]*?\]/.test(fn.body);
      const hasQuery = /(?:query|select|find|fetch|get|search|filter|where|from)\b/i.test(fn.body);
      const hasParam = fn.body.includes('params') || fn.body.includes('args') || fn.body.includes('query');
      if (returnsLiteral && !hasQuery && !hasParam && fn.bodyLines <= 5) {
        return { matched: 'Returns hardcoded collection with no data source query' };
      }
      return null;
    },
  },

  // Console.log / print pretending to be real side effects
  {
    id: 'log-only-action',
    severity: 'critical',
    category: 'noop-facade',
    desc: 'Action function only logs/prints instead of performing real work',
    test: (fn) => {
      const ACTION_NAMES =
        /^(?:send|publish|notify|dispatch|emit|broadcast|deliver|push|post|trigger|execute|process|handle|submit)/i;
      if (!ACTION_NAMES.test(fn.name)) return null;
      if (fn.bodyLines > 5 || fn.bodyLines < 1) return null;
      const lines = fn.body
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('//') && !l.startsWith('#'));
      const logOnlyLines = lines.filter((l) =>
        /^(?:console\.(?:log|info|warn|debug|writeline)|print(?:ln)?|puts|IO\.(?:puts|inspect)|logger?\.|log\.(?:info|debug|warn)|fmt\.Print)/i.test(
          l,
        ),
      );
      if (logOnlyLines.length === lines.length && lines.length >= 1) {
        return { matched: `Action function "${fn.name}" only contains logging statements` };
      }
      return null;
    },
  },

  // Async function that never awaits
  {
    id: 'async-no-await',
    severity: 'critical',
    category: 'noop-facade',
    desc: 'Async function never uses await — fake asynchronous behavior',
    test: (fn) => {
      if (!fn.isAsync) return null;
      if (fn.bodyLines < 2) return null;
      // Must have body that does something (not just a return)
      const hasAwait = /\bawait\b/.test(fn.body);
      const hasPromise = /\bnew\s+Promise\b|\bPromise\./.test(fn.body);
      const hasThen = /\.then\s*\(/.test(fn.body);
      const hasCallback = /\bcallback\s*\(|\bcb\s*\(/.test(fn.body);
      if (!hasAwait && !hasPromise && !hasThen && !hasCallback) {
        return { matched: `Async function "${fn.name}" never awaits — synchronous code wrapped as async` };
      }
      return null;
    },
  },

  // ─── HIGH: Likely an illusion ───

  // Error handler that swallows all errors silently
  {
    id: 'swallowed-error',
    severity: 'high',
    category: 'noop-error-handler',
    desc: 'Catch block swallows error without logging or re-throwing',
    test: (fn) => {
      // Look for empty catch blocks in JS/TS/Go
      const catchEmpty = /catch\s*\([^)]*\)\s*\{\s*\}/.test(fn.body);
      // Python bare except: pass
      const exceptPass = /except\s*(?:\w+\s*(?:as\s+\w+)?)?\s*:\s*\n\s*pass\b/.test(fn.body);
      // Note: Elixir rescue -> :ok is excluded — it's idiomatic for graceful degradation
      // in non-critical operations (caching, telemetry, logging). Only flag if the function
      // name suggests critical behavior.
      if (catchEmpty || exceptPass) {
        return { matched: 'Error handler swallows exceptions without logging or re-throwing' };
      }
      return null;
    },
  },

  // Function that returns its input unchanged (pass-through wrapper)
  {
    id: 'passthrough-wrapper',
    severity: 'high',
    category: 'passthrough',
    desc: 'Function returns its input unchanged — unnecessary wrapper',
    test: (fn) => {
      if (fn.bodyLines > 3 || fn.bodyLines < 1) return null;
      const body = fn.body.trim();
      // return param; or return data; with 1-line body — exclude literals (true/false/null/nil/undefined)
      const returnsParam = /^return\s+\w+\s*;?\s*$/.test(body);
      const returnsLiteral = /^return\s+(?:true|false|null|nil|undefined|None|:ok|:error)\s*;?\s*$/.test(body);
      if (returnsParam && !returnsLiteral && fn.bodyLines === 1) {
        return { matched: `Function "${fn.name}" returns input unchanged — passthrough wrapper` };
      }
      return null;
    },
  },

  // setTimeout/sleep-based simulation of async work
  //
  // Boundary: a clearTimeout + setTimeout pair is a *debounce* pattern, not a
  // fake delay. The simulated-delay heuristic was producing 100% false
  // positives on legitimate debounced handlers (folder search, autocomplete,
  // resize observers), so the test now requires both:
  //   - sleep/setTimeout WITHOUT a paired clearTimeout (debounce excluder)
  //   - no real I/O in the body (existing exclusion)
  // The "no real I/O" check stays a fail-closed indicator — if the body does
  // any work, we silence rather than overshoot.
  {
    id: 'sleep-simulation',
    severity: 'high',
    category: 'simulated-delay',
    desc: 'Uses setTimeout/sleep to simulate async work instead of real I/O',
    test: (fn) => {
      const hasSleep = /(?:setTimeout|sleep|time\.sleep|:timer\.sleep|Thread\.Sleep|tokio::time::sleep)\s*\(/.test(
        fn.body,
      );
      if (!hasSleep) return null;
      // Debounce pattern: clearTimeout(handle) + setTimeout(...) is legitimate.
      const hasClearTimeout = /\bclearTimeout\s*\(/.test(fn.body);
      if (hasClearTimeout) return null;
      const hasRealIO =
        /(?:fetch|http|request|axios|db\.|query|select|insert|fs\.|readFile|writeFile|Repo\.|GenServer)/i.test(fn.body);
      if (!hasRealIO && fn.bodyLines <= 8) {
        return { matched: `Uses delay/sleep to simulate work without any real I/O operations` };
      }
      return null;
    },
  },

  // Math.random / :rand for generating fake data
  {
    id: 'random-data-generator',
    severity: 'high',
    category: 'mock-data',
    desc: 'Generates random/fake data instead of using real data source',
    test: (fn) => {
      const hasRandom = /(?:Math\.random|:rand\.|random\.|faker\.|Faker\.|uuid\.v4|crypto\.randomUUID)/i.test(fn.body);
      const isTestFile = fn._isTestFile;
      const isSeedOrFixture = /(?:seed|fixture|factory|mock|fake|sample|demo|example)/i.test(fn.name);
      const hasDataSource = /(?:db\.|query|select|from|Repo\.|fetch|api\.|http)/i.test(fn.body);
      if (hasRandom && !isTestFile && !isSeedOrFixture && !hasDataSource && fn.bodyLines <= 10) {
        return { matched: `Function "${fn.name}" generates random data without a real data source` };
      }
      return null;
    },
  },

  // Go HTTP handler that writes a response but never reads request or calls services
  {
    id: 'go-handler-facade',
    severity: 'critical',
    category: 'noop-facade',
    desc: 'Go HTTP handler writes response but never calls service/repo or reads request',
    test: (fn) => {
      // Only check Go functions with HTTP handler signatures
      if (fn.isAsync) return null; // Go doesn't have async
      const HANDLER_NAMES = /^(?:Handle|Serve|Process|Do|Execute|Create|Update|Delete|Get|List|Post|Put|Patch)/i;
      if (!HANDLER_NAMES.test(fn.name)) return null;
      if (fn.bodyLines > 15 || fn.bodyLines < 1) return null;

      // Must have response writing
      const writesResponse =
        /json\.(?:NewEncoder|Marshal)/.test(fn.body) ||
        /w\.Write(?:Header)?\s*\(/.test(fn.body) ||
        /\.JSON\s*\(/.test(fn.body) || // gin/echo style
        /render\./.test(fn.body);
      if (!writesResponse) return null;

      // Check for real work indicators
      const hasServiceCall =
        /\b(?:repo|repository|service|store|cache|client|db|tx|conn)\b/i.test(fn.body) &&
        /\.(?:Create|Update|Delete|Find|Get|List|Query|Insert|Select|Exec|Save|Remove|Fetch|Send|Publish)\s*\(/.test(
          fn.body,
        );
      const hasDBCall = /(?:sql\.|sqlx\.|gorm\.|ent\.|pgx\.|mongo\.)/.test(fn.body);
      const hasExternalCall = /(?:http\.(?:Get|Post|Do)|nats\.|redis\.|kafka\.|amqp\.)/.test(fn.body);
      const readsRequest =
        /r\.(?:Body|FormValue|URL\.Query|ParseForm|ParseMultipartForm|Context)/.test(fn.body) ||
        /(?:json\.NewDecoder|io\.Read|ioutil\.Read).*r\.Body/.test(fn.body) ||
        /(?:c\.Bind|c\.ShouldBind|c\.Param|c\.Query)/.test(fn.body); // gin style

      if (!hasServiceCall && !hasDBCall && !hasExternalCall && !readsRequest) {
        return {
          matched: `Handler "${fn.name}" writes HTTP response but never reads request, calls service/repo, or queries DB`,
        };
      }
      return null;
    },
  },

  // Handlers/controllers that bypass the service/usecase layer and talk to repositories directly
  {
    id: 'handler-repo-bypass',
    severity: 'high',
    category: 'architecture-bypass',
    desc: 'Handler/controller calls repository directly instead of going through service/usecase logic',
    test: (fn) => {
      const filePath = fn._filePath || '';
      const isHandlerContext =
        /(?:^|[/\\])(?:handlers?|controllers?|routes?|router|api|delivery|transport)(?:[/\\]|$)/i.test(filePath) ||
        /(?:handler|controller|route)/i.test(filePath) ||
        /^(?:handle|list|get|create|update|delete|serve|post|put|patch)/i.test(fn.name);
      if (!isHandlerContext) return null;

      const directRepoCall =
        /\b(?:repo|repository|store|dao)\b[\w.]*\s*\.\s*(?:Create|Update|Delete|Find|Get|List|Query|Insert|Select|Exec|Save|Remove|Fetch|Aggregate)\s*\(/i.test(
          fn.body,
        ) || /\bRepo\.(?:all|get|get_by|one|insert|update|delete|aggregate|exists)\b/.test(fn.body);
      if (!directRepoCall) return null;

      const serviceCall =
        /\b(?:service|svc|usecase|workflow|manager)\b[\w.]*\s*\.\s*(?:Create|Update|Delete|Find|Get|List|Query|Execute|Run|Handle|Process|Resolve|Aggregate)\s*\(/i.test(
          fn.body,
        );
      if (serviceCall) return null;

      return {
        matched:
          `Handler/controller "${fn.name}" calls repository/data-access code directly without a service/usecase boundary. ` +
          'Business rules such as caps, resolution, and aggregation can be bypassed.',
      };
    },
  },

  // Go error swallowing: if err != nil { } with empty or log-only body
  {
    id: 'go-error-swallow',
    severity: 'high',
    category: 'noop-error-handler',
    desc: 'Go error check swallows error without returning or re-raising',
    test: (fn) => {
      // Line-based approach: find `if err != nil {` lines, then extract the balanced
      // block body using brace-depth tracking (avoids [^}] regex that breaks on nested braces).
      const bodyLines = fn.body.split('\n');
      for (let i = 0; i < bodyLines.length; i++) {
        if (!/if\s+err\s*!=\s*nil\s*\{/.test(bodyLines[i])) continue;

        // Extract the block body with brace balancing
        let depth = 0;
        let blockStart = -1;
        let blockEnd = -1;
        for (let j = i; j < bodyLines.length; j++) {
          for (const ch of bodyLines[j]) {
            if (ch === '{') {
              depth++;
              if (blockStart === -1) blockStart = j + 1;
            }
            if (ch === '}') {
              depth--;
              if (depth === 0) {
                blockEnd = j;
                break;
              }
            }
          }
          if (blockEnd !== -1) break;
        }

        if (blockStart === -1 || blockEnd === -1) continue;
        const inner = bodyLines
          .slice(blockStart, blockEnd)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('//'));

        if (inner.length === 0) {
          return { matched: 'Empty error handler: if err != nil { } — error silently swallowed' };
        }

        // Check: does the block have a return, panic, or error propagation?
        const hasReturn = inner.some((l) => /^return\b/.test(l));
        const hasPanic = inner.some((l) => /^panic\b/.test(l));
        const hasErrProp = inner.some((l) => /err\s*=|errors?\.|fmt\.Errorf/.test(l));
        if (hasReturn || hasPanic || hasErrProp) continue; // legitimate handler

        const allLogging = inner.every((l) => /^(?:log\.|fmt\.Print|logger\.|slog\.|zap\.|println)/.test(l));
        if (allLogging) {
          return {
            matched: 'Error handler only logs but never returns error or aborts — error swallowed after logging',
          };
        }
      }
      return null;
    },
  },

  // ─── MEDIUM: Potential illusion (needs context) ───

  // Validation function that always returns true/valid
  {
    id: 'always-valid',
    severity: 'medium',
    category: 'noop-validation',
    desc: 'Validation/check function always returns truthy — no actual validation',
    test: (fn) => {
      const VALIDATE_NAMES =
        /^(?:validate|check|verify|is_valid|isValid|can|should|has|assert|ensure|guard|authorize|authenticate)/i;
      if (!VALIDATE_NAMES.test(fn.name)) return null;
      if (fn.bodyLines > 3 || fn.bodyLines < 1) return null;
      const body = fn.body.trim();
      const alwaysTrue = /^return\s+(?:true|True|:ok|\{ok,|:valid|"valid"|'valid')\s*;?\s*$/.test(body);
      if (alwaysTrue) {
        return { matched: `Validation function "${fn.name}" always returns truthy — no real validation` };
      }
      return null;
    },
  },

  // Config/env-gated stub: returns early when env var is not set
  {
    id: 'env-gated-noop',
    severity: 'medium',
    category: 'conditional-stub',
    desc: 'Function exits early based on env/config flag — feature-flagged noop',
    test: (fn) => {
      if (fn.bodyLines > 6 || fn.bodyLines < 2) return null;
      const earlyReturn =
        /if\s*\(!?\s*(?:process\.env\.|ENV\[|System\.get_env|os\.(?:environ|getenv)|env\.)[\s\S]*?return\b/i.test(
          fn.body,
        );
      const restIsEmpty = fn.bodyLines <= 3;
      if (earlyReturn && restIsEmpty) {
        return { matched: `Function "${fn.name}" exits on env/config check — likely disabled feature` };
      }
      return null;
    },
  },

  // Middleware/hook that calls next() without doing anything
  {
    id: 'noop-middleware',
    severity: 'medium',
    category: 'passthrough',
    desc: 'Middleware/plug/hook calls next() without performing any work',
    test: (fn) => {
      if (fn.bodyLines > 3 || fn.bodyLines < 1) return null;
      const MIDDLEWARE_NAMES = /(?:middleware|plug|hook|interceptor|filter|guard|pipe)/i;
      const body = fn.body.trim();
      const callsNext = /(?:next\s*\(|call\s*\(|conn\s*$|halt\b)/.test(body);
      if (
        (MIDDLEWARE_NAMES.test(fn.name) || MIDDLEWARE_NAMES.test(fn._context || '')) &&
        callsNext &&
        fn.bodyLines <= 2
      ) {
        return { matched: `Middleware "${fn.name}" passes through without performing work` };
      }
      return null;
    },
  },

  // ─── CRITICAL: Empty function bodies (noop facades) ───

  // Functions with zero executable statements (only comments/whitespace)
  {
    id: 'empty-function-body',
    severity: 'critical',
    category: 'noop-facade',
    desc: 'Function has no executable statements — empty body with only comments or whitespace',
    test: (fn) => {
      // Exclude main entrypoints
      if (fn.name === 'main') return null;
      if (fn.bodyLines === 0) {
        return { matched: `Function "${fn.name}" has an empty body — no executable statements` };
      }
      return null;
    },
  },

  // ─── HIGH: Unused parameters ───
  //
  // Boundary: this pattern is regex-driven against the raw declaration line
  // and the function body. It misses (a) destructured parameters
  // (`function f({ a, b })`), (b) parameters used inside nested closures
  // bound by `this`, and (c) usages renamed by transpilers. On the resolveImage
  // / scheduleFolderSearch corpus it produced a 100% false-positive rate.
  // Until an AST-based replacement lands, the pattern is OFF by default and
  // only fires when the scanner is invoked with `experimental: true`
  // (--include-experimental on the CLI). When the AST refactor lands the
  // boundary documentation and the gate are removed together.
  {
    id: 'unused-parameters',
    severity: 'high',
    category: 'noop-facade',
    experimental: true,
    desc: 'Function accepts multiple parameters but none are used in the body',
    test: (fn) => {
      // Extract parameter names from the function declaration line
      // We look at the first line of the body context — but params are in the declaration,
      // so we need to parse from fn._declLine or reconstruct from fn context.
      // Since extractFunctions doesn't store the declaration, we use the body to check usage.
      // We need the declaration — look for param patterns in the function name context.
      // The fn object doesn't carry the raw declaration line, so we match from body + name.
      // Strategy: the caller sets fn._declLine if available; otherwise skip.
      // Alternative: use fn._params if set. Since neither is available, we parse from fn._raw.
      // Pragmatic approach: scan fn.body for common param extraction patterns.

      // We need the declaration to get param names. Since extractFunctions doesn't provide it,
      // use fn._rawDecl if present (we'll add it), or fall back to a regex on fn._sourceLines.
      if (!fn._rawDecl) return null;

      // Extract param names from the declaration
      const declMatch = fn._rawDecl.match(/\(([^)]*)\)/);
      if (!declMatch) return null;
      const rawParams = declMatch[1];
      if (!rawParams.trim()) return null;

      // Parse parameter names (handle Go, JS, TS, Python styles)
      const params = rawParams
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p && !p.startsWith('_') && !p.startsWith('...') && !p.startsWith('*'))
        .map((p) => {
          // Go: "w http.ResponseWriter" → "w"
          // JS/TS: "name: string" → "name", "name = default" → "name"
          // Python: "name: str" → "name"
          return p.split(/[\s:=]/)[0].trim();
        })
        .filter((p) => p && p !== '_' && p.length > 0);

      const normalizedParams = splitParameterList(rawParams)
        .map((p) => parseParameterName(p, fn._language))
        .filter((p) => p && p !== '_' && p.length > 0);
      const effectiveParams = normalizedParams.length ? normalizedParams : params;

      if (effectiveParams.length < 2) return null;

      if (
        fn._language === 'csharp' &&
        effectiveParams.every((p) => /^(?:sender|e|args|eventArgs)$/iu.test(p)) &&
        /(?:\.\w+\s*\(|\b\w+\s*\(|=|await\b|return\b|new\s+)/u.test(fn.body)
      ) {
        return null;
      }

      // Check if ALL params are unused in the body
      const allUnused = effectiveParams.every((param) => {
        const escaped = param.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const usage = new RegExp(`\\b${escaped}\\b`);
        return !usage.test(fn.body);
      });

      if (allUnused) {
        return {
          matched: `Function "${fn.name}" accepts ${effectiveParams.length} parameters (${effectiveParams.join(', ')}) but none are used in the body`,
        };
      }
      return null;
    },
  },

  // ─── HIGH: Return empty struct/object ───

  // Single-statement functions that return empty structs/objects/arrays
  {
    id: 'return-empty-struct',
    severity: 'high',
    category: 'mock-data',
    desc: 'Function body is a single return of an empty struct, object, or array',
    test: (fn) => {
      if (fn.bodyLines !== 1) return null;
      const body = fn.body.trim();
      // Go: return &Model{} or return Model{}
      const goEmpty = /^return\s+&?\w+\{\s*\}\s*$/.test(body);
      // JS/TS: return {} or return []
      const jsEmpty = /^return\s+(?:\{\s*\}|\[\s*\])\s*;?\s*$/.test(body);
      if (goEmpty || jsEmpty) {
        return { matched: `Function "${fn.name}" returns an empty struct/object — likely a stub` };
      }
      return null;
    },
  },

  // ─── MEDIUM: Import unused service ───

  // Imports a service/repo/client/store/provider but never calls a method on it
  {
    id: 'import-unused-service',
    severity: 'medium',
    category: 'dead-import',
    desc: 'Imports a service/repo/client/store/provider module but never calls a method on it',
    test: (fn) => {
      // This pattern operates at file level, not function level.
      // We check the full file content via fn._fileContent if available.
      // Since the scanner iterates per-function, we only run this on the first function in a file
      // to avoid duplicate findings.
      if (!fn._fileContent || fn._fileFirstFn !== true) return null;

      const content = fn._fileContent;
      const lines = content.split('\n');
      const findings = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Match: const xxxService = require(...) or import xxxService from ...
        const requireMatch = line.match(
          /(?:const|let|var)\s+(\w+(?:Service|Repo|Client|Store|Provider))\s*=\s*require\s*\(/,
        );
        const importMatch = line.match(/import\s+(\w+(?:Service|Repo|Client|Store|Provider))\s+from\b/);
        const varName = requireMatch?.[1] || importMatch?.[1];
        if (!varName) continue;

        // Check if varName.method() appears anywhere after the import line
        const rest = lines.slice(i + 1).join('\n');
        const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const methodCall = new RegExp(`\\b${escaped}\\.\\w+\\s*\\(`);
        if (!methodCall.test(rest)) {
          findings.push(varName);
        }
      }

      if (findings.length > 0) {
        return {
          matched: `Imported service(s) never called: ${findings.join(', ')}`,
        };
      }
      return null;
    },
  },
];

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
      results.push({ file: full, lang });
    }
  }

  return results;
}

function normalizeLangFilter(value) {
  return value
    ? value.split(',').map((l) => {
        const norm = {
          cs: 'csharp',
          csharp: 'csharp',
          ts: 'typescript',
          js: 'javascript',
          py: 'python',
          ex: 'elixir',
          rs: 'rust',
        };
        return norm[l.trim().toLowerCase()] || l.trim().toLowerCase();
      })
    : null;
}

function langForFile(filePath, langFilter) {
  const lang = LANG_MAP[path.extname(filePath).toLowerCase()];
  if (!lang) return null;
  if (langFilter && !langFilter.includes(lang)) return null;
  return lang;
}

function findMatchingParen(line, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < line.length; index += 1) {
    const ch = line[index];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function parseJsFunctionDeclaration(line) {
  const trimmed = String(line || '').trim();
  const keywordNames = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'do']);

  const fn = trimmed.match(/^(?:(async)\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/u);
  if (fn) {
    const openParen = line.indexOf('(', line.indexOf(fn[2]));
    const closeParen = findMatchingParen(line, openParen);
    const bodyOpenColumn = closeParen >= 0 ? line.indexOf('{', closeParen + 1) : -1;
    if (bodyOpenColumn >= 0) return { name: fn[2], isAsync: !!fn[1], bodyOpenColumn };
  }

  const arrow = trimmed.match(
    /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:(async)\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/u,
  );
  if (arrow) {
    const arrowColumn = line.indexOf('=>');
    const bodyOpenColumn = arrowColumn >= 0 ? line.indexOf('{', arrowColumn + 2) : -1;
    if (bodyOpenColumn >= 0) return { name: arrow[1], isAsync: !!arrow[2], bodyOpenColumn };
  }

  const method = trimmed.match(/^(?:(async)\s+)?([A-Za-z_$][\w$]*)\s*\(/u);
  if (method && !keywordNames.has(method[2])) {
    const nameColumn = line.indexOf(method[2]);
    const openParen = line.indexOf('(', nameColumn + method[2].length);
    const closeParen = findMatchingParen(line, openParen);
    const bodyOpenColumn = closeParen >= 0 ? line.indexOf('{', closeParen + 1) : -1;
    if (bodyOpenColumn >= 0) return { name: method[2], isAsync: !!method[1], bodyOpenColumn };
  }

  return null;
}

function extractBraceBlock(lines, startLine, bodyOpenColumn, limit = 200) {
  let braceDepth = 0;
  let started = false;
  let segmentStart = 0;
  const segments = [];

  for (let j = startLine; j < Math.min(lines.length, startLine + limit); j += 1) {
    const line = lines[j];
    const from = j === startLine ? bodyOpenColumn : 0;
    segmentStart = 0;

    for (let index = from; index < line.length; index += 1) {
      const ch = line[index];
      if (!started) {
        if (ch === '{') {
          started = true;
          braceDepth = 1;
          segmentStart = index + 1;
        }
        continue;
      }
      if (ch === '{') braceDepth += 1;
      else if (ch === '}') {
        braceDepth -= 1;
        if (braceDepth === 0) {
          segments.push(line.slice(segmentStart, index));
          const bodyLines = segments.filter((l) => l.trim() && !l.trim().startsWith('//') && !l.trim().startsWith('*'));
          return { bodyEnd: j, bodyLines, body: bodyLines.join('\n') };
        }
      }
    }

    if (started) {
      segments.push(j === startLine ? line.slice(segmentStart) : line);
    }
  }

  return null;
}

function scopedFilesFromManifest(projectDir, manifestPath, langFilter) {
  const resolved = path.resolve(projectDir, manifestPath);
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/u, ''));
  } catch {
    return null;
  }

  const rawFiles = [
    ...(manifest.filesCreated || []),
    ...(manifest.filesModified || []),
    ...(manifest.files || []),
    ...(manifest.changedFiles || []),
    ...(manifest.sourceWriteProvenance || []),
  ];
  const seen = new Set();
  const files = [];
  // Guard: drop manifest entries that resolve outside projectDir.
  // path.resolve(projectDir, raw) silently escapes when `raw` is `../foo`
  // and ignores projectDir entirely when `raw` is absolute, so a hostile
  // or simply over-broad manifest could pull files from the user's home
  // dir / cross-project worktrees into scan output. Anything whose
  // path.relative(projectDir, file) starts with `..` or is itself absolute
  // is rejected — this mirrors the standard isSubpath() pattern.
  const projectRoot = path.resolve(projectDir);
  for (const entry of rawFiles) {
    const raw = typeof entry === 'string' ? entry : entry?.path || entry?.file || entry?.filePath;
    if (!raw) continue;
    const file = path.resolve(projectRoot, raw);
    const rel = path.relative(projectRoot, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (seen.has(file) || !fs.existsSync(file)) continue;
    const lang = langForFile(file, langFilter);
    if (!lang) continue;
    seen.add(file);
    files.push({ file, lang });
  }
  return files;
}

// ── Function Extractor ────────────────────────────────────────
// Shared with cobolt-audit.js DepthAnalyzer but adds isAsync detection

function extractFunctions(content, lang) {
  const functions = [];
  const lines = content.split('\n');

  if (lang === 'python') {
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^(\s*)(async\s+)?def\s+(\w+)\s*\(/);
      if (!match) continue;
      const indent = match[1].length;
      const isAsync = !!match[2];
      const name = match[3];
      const startLine = i + 1;

      let bodyEnd = i;
      let inDocstring = false;
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j];
        if (line.trim() === '') {
          bodyEnd = j;
          continue;
        }
        if (/^\s*(?:"""|''')/.test(line)) {
          inDocstring = !inDocstring;
          if (line.match(/(?:"""|''').*(?:"""|''')/)) inDocstring = false;
          bodyEnd = j;
          continue;
        }
        if (inDocstring) {
          bodyEnd = j;
          continue;
        }
        const lineIndent = line.match(/^(\s*)/)[1].length;
        if (lineIndent <= indent && line.trim() !== '') break;
        bodyEnd = j;
      }

      const bodyLines = lines
        .slice(i + 1, bodyEnd + 1)
        .filter((l) => l.trim() && !l.trim().startsWith('#') && !/^\s*(?:"""|''')/.test(l));
      functions.push({
        name,
        startLine,
        bodyLines: bodyLines.length,
        body: bodyLines.join('\n'),
        isAsync,
        _rawDecl: lines[i],
      });
    }
  } else if (lang === 'javascript' || lang === 'typescript') {
    for (let i = 0; i < lines.length; i++) {
      const declaration = parseJsFunctionDeclaration(lines[i]);
      if (!declaration) continue;
      const { name, isAsync, bodyOpenColumn } = declaration;
      const startLine = i + 1;
      const block = extractBraceBlock(lines, i, bodyOpenColumn);
      if (block) {
        functions.push({
          name,
          startLine,
          bodyLines: block.bodyLines.length,
          body: block.body,
          isAsync,
          _rawDecl: lines[i],
          _language: lang,
        });
      }
    }
  } else if (lang === 'go') {
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(/);
      if (!match) continue;
      const name = match[1];
      const startLine = i + 1;

      let braceDepth = 0;
      let bodyStart = -1;
      let bodyEnd = i;

      for (let j = i; j < Math.min(lines.length, i + 200); j++) {
        for (const ch of lines[j]) {
          if (ch === '{') {
            braceDepth++;
            if (bodyStart === -1) bodyStart = j + 1;
          }
          if (ch === '}') {
            braceDepth--;
            if (braceDepth === 0) {
              bodyEnd = j;
              break;
            }
          }
        }
        if (braceDepth === 0 && bodyStart !== -1) break;
      }

      if (bodyStart !== -1) {
        const bodyLines = lines.slice(bodyStart, bodyEnd).filter((l) => l.trim() && !l.trim().startsWith('//'));
        functions.push({
          name,
          startLine,
          bodyLines: bodyLines.length,
          body: bodyLines.join('\n'),
          isAsync: false,
          _rawDecl: lines[i],
        });
      }
    }
  } else if (lang === 'csharp') {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const declarationLines = [line];
      let declarationEnd = i;
      for (let j = i + 1; j < Math.min(lines.length, i + 20); j++) {
        const rawDecl = declarationLines.join(' ');
        const parenDepth = (rawDecl.match(/\(/g) || []).length - (rawDecl.match(/\)/g) || []).length;
        if (rawDecl.includes('{') || rawDecl.includes('=>') || /;\s*$/u.test(rawDecl)) break;
        const next = lines[j].trim();
        if (!next) continue;
        if (parenDepth > 0 || next.startsWith('{') || next.startsWith('=>') || rawDecl.trim().endsWith(',')) {
          declarationLines.push(lines[j]);
          declarationEnd = j;
          continue;
        }
        break;
      }

      const rawDeclaration = declarationLines.join(' ').trim();
      if (/\b(?:class|record|struct|interface|enum|delegate)\b/u.test(rawDeclaration)) continue;

      const methodMatch = rawDeclaration.match(
        /^\s*(?:(?:public|private|protected|internal|static|virtual|override|async|sealed|partial|extern|new)\s+)+(?:[\w<>[\],.?]+\s+)?(\w+)\s*\([^;]*\)\s*(?:\{|=>)?/u,
      );
      if (!methodMatch) continue;
      const name = methodMatch[1];
      const startLine = i + 1;
      const isAsync = /\basync\b/.test(rawDeclaration);

      if (rawDeclaration.includes('=>')) {
        let expression = rawDeclaration.slice(rawDeclaration.indexOf('=>') + 2);
        let expressionEnd = declarationEnd;
        for (
          let j = declarationEnd + 1;
          !/;\s*$/u.test(expression) && j < Math.min(lines.length, declarationEnd + 20);
          j++
        ) {
          expression += ` ${lines[j].trim()}`;
          expressionEnd = j;
        }
        const body = expression.replace(/;\s*$/u, '').trim();
        functions.push({
          name,
          startLine,
          bodyLines: body ? 1 : 0,
          body,
          isAsync,
          _rawDecl: rawDeclaration,
          _language: lang,
        });
        i = expressionEnd;
        continue;
      }

      if (!rawDeclaration.includes('{') && !lines[declarationEnd + 1]?.trim().startsWith('{')) {
        continue;
      }

      let braceDepth = 0;
      let bodyStart = -1;
      let bodyEnd = i;
      for (let j = declarationEnd; j < Math.min(lines.length, declarationEnd + 240); j++) {
        for (const ch of lines[j]) {
          if (ch === '{') {
            braceDepth++;
            if (bodyStart === -1) bodyStart = j + 1;
          }
          if (ch === '}') {
            braceDepth--;
            if (braceDepth === 0) {
              bodyEnd = j;
              break;
            }
          }
        }
        if (braceDepth === 0 && bodyStart !== -1) break;
      }

      if (bodyStart !== -1) {
        const bodyLines = lines.slice(bodyStart, bodyEnd).filter((l) => l.trim() && !l.trim().startsWith('//'));
        functions.push({
          name,
          startLine,
          bodyLines: bodyLines.length,
          body: bodyLines.join('\n'),
          isAsync,
          _rawDecl: rawDeclaration,
          _language: lang,
        });
        i = bodyEnd;
      }
    }
  } else if (lang === 'elixir') {
    // Detects two clause forms:
    //   1) Block form:      def(p)? name(args) do ... end
    //   2) Shorthand form:  def(p)? name(args), do: expr
    //                       (or def(p)? name(args), do: expr, else: ..., rescue: ...)
    // The shorthand has NO trailing `end` — its body is the single expression
    // after `do:`. Failing to detect it caused every shorthand clause to be
    // reported as bodyLines:0 / pattern:empty-function-body.
    // Identifier rule: Elixir function names may end in `?` or `!` (e.g.
    // `valid?`, `save!`). Plain `\w+` would silently drop those clauses,
    // re-introducing the false-negative the rest of this branch is designed
    // to eliminate. Mirror the same pattern in shorthandRe and the block-form
    // declaration match so both clause shapes accept the punctuated form.
    const elixirIdent = '[a-zA-Z_][\\w]*[!?]?';
    const shorthandRe = new RegExp(`^\\s*defp?\\s+${elixirIdent}(?:\\([^)]*\\))?[^\\n#]*?,\\s*do:\\s*(.+?)\\s*$`);
    const declRe = new RegExp(`^\\s*defp?\\s+(${elixirIdent})`);
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(declRe);
      if (!match) continue;
      const name = match[1];
      const startLine = i + 1;

      // Shorthand-body detection: `, do: expr` on the declaration line itself
      // (with no `do` block-keyword that would open a block instead).
      const shorthand = lines[i].match(shorthandRe);
      const opensBlock = /\bdo\s*$/.test(lines[i]) || /\bdo\s*#/.test(lines[i]);
      if (shorthand && !opensBlock) {
        let bodyExpr = shorthand[1] || '';
        // Strip trailing `, else:`/`, rescue:`/`, after:` qualifier blocks so
        // the captured body is just the primary `do:` expression. Multiline
        // shorthand with continuation is rare; the captured single line is
        // sufficient for empty-vs-non-empty classification.
        bodyExpr = bodyExpr.replace(/\s*,\s*(?:else|rescue|after|catch):\s.*$/, '');
        const bodyLineCount = bodyExpr.trim() ? 1 : 0;
        functions.push({
          name,
          startLine,
          bodyLines: bodyLineCount,
          body: bodyExpr,
          isAsync: false,
          _rawDecl: lines[i],
          _elixirShorthand: true,
        });
        continue;
      }

      let depth = 1;
      let bodyEnd = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s*(?:def[p]?\s|do\b|fn\b|case\b|cond\b|if\b|unless\b|with\b)/.test(lines[j])) depth++;
        if (/^\s*end\b/.test(lines[j])) {
          depth--;
          if (depth === 0) {
            bodyEnd = j;
            break;
          }
        }
      }

      const bodyLines = lines.slice(i + 1, bodyEnd).filter((l) => l.trim() && !l.trim().startsWith('#'));
      functions.push({
        name,
        startLine,
        bodyLines: bodyLines.length,
        body: bodyLines.join('\n'),
        isAsync: false,
        _rawDecl: lines[i],
      });
    }
  }

  return functions;
}

// ── Illusion Scanner ──────────────────────────────────────────

class IllusionScanner {
  constructor(projectDir) {
    this.projectDir = projectDir || process.cwd();
  }

  scan(options = {}) {
    const dir = options.dir ? path.resolve(this.projectDir, options.dir) : this.projectDir;
    const langFilter = normalizeLangFilter(options.lang);
    const includeExperimental = options.experimental === true;

    const scopedFiles = options.files ? scopedFilesFromManifest(this.projectDir, options.files, langFilter) : null;
    const files = scopedFiles || walkFiles(dir, langFilter);
    const findings = [];
    let scannedFiles = 0;
    let scannedFunctions = 0;
    const activePatterns = ILLUSION_PATTERNS.filter((p) => includeExperimental || p.experimental !== true);
    const skippedExperimental = ILLUSION_PATTERNS.filter((p) => p.experimental === true).map((p) => p.id);

    for (const { file, lang } of files) {
      let content;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }

      const relPath = path.relative(this.projectDir, file);

      // Skip test files — they legitimately contain mocks, stubs, fixtures
      const isTestFile = /(?:test|spec|_test\.|\.test\.|\.spec\.|__tests__|fixtures?|mocks?)/i.test(relPath);
      if (isTestFile) continue;

      // Skip tool/script/hook files within CoBolt itself.
      //
      // M5-followup FIX 3 (2026-05-02): also skip CoBolt toolchain bundles
      // that have been installed into a USER project under .claude/cobolt/.
      // Without this, --files manifests that include such paths bypass the
      // walk-level SKIP_DIRS guard (.claude is in SKIP_DIRS, but
      // scopedFilesFromManifest does not consult that set) and the scanner
      // ends up flagging CoBolt's own analyzer-base.js / planner libs as
      // illusions in user reports. See merupuai/maas M5-CF-03.
      const normRel = relPath.split(path.sep).join('/');
      const isCoboltInfra =
        /^(?:tools|source|scripts|bin|lib)\//.test(normRel) ||
        /^(?:\.claude|\.codex)\/(?:cobolt|plugins\/cobolt|plugins\/@mftlabs\/cobolt)\//.test(normRel) ||
        /(?:^|\/)(?:node_modules|deps|_build|vendor|target|dist|build)\//.test(normRel);
      if (isCoboltInfra) continue;

      // Skip compiled/bundled/minified files and priv/static assets
      if (SKIP_FILES.test(relPath)) continue;

      const functions = extractFunctions(content, lang);
      scannedFiles++;
      scannedFunctions += functions.length;

      for (let fi = 0; fi < functions.length; fi++) {
        const fn = functions[fi];
        fn._isTestFile = isTestFile;
        fn._fileContent = content;
        fn._fileFirstFn = fi === 0;
        fn._filePath = relPath;
        fn._language = lang;

        for (const pattern of activePatterns) {
          const result = pattern.test(fn);
          if (result) {
            findings.push({
              id: `ILL-${String(findings.length + 1).padStart(3, '0')}`,
              file: relPath,
              line: fn.startLine,
              function: fn.name,
              bodyLines: fn.bodyLines,
              pattern: pattern.id,
              severity: pattern.severity,
              category: pattern.category,
              description: pattern.desc,
              evidence: result.matched,
              language: lang,
            });
            break; // One illusion per function — take the highest severity
          }
        }
      }
    }

    const bySeverity = { critical: 0, high: 0, medium: 0 };
    const byCategory = {};
    for (const f of findings) {
      bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
      byCategory[f.category] = (byCategory[f.category] || 0) + 1;
    }

    return {
      timestamp: new Date().toISOString(),
      tool: 'cobolt-illusion-scan',
      tier: 'advisory',
      boundary:
        'Heuristic regex/body-line scanner. Default mode is advisory (exit 0 even with critical findings). ' +
        'Pattern unused-parameters and other AST-dependent checks are gated behind --include-experimental. ' +
        'Treat findings as candidates for human review, not as gating signal. AST-based replacement is planned.',
      experimental: includeExperimental,
      experimentalPatternsSkipped: includeExperimental ? [] : skippedExperimental,
      scannedFiles,
      scannedFunctions,
      totalIllusions: findings.length,
      count: findings.length,
      illusionCount: findings.length,
      bySeverity,
      byCategory,
      illusions: findings,
      findings,
    };
  }
}

// ── Output Helpers ────────────────────────────────────────────

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
    '# Illusion Scan Report',
    '',
    `**Scan Date:** ${result.timestamp}`,
    `**Files Scanned:** ${result.scannedFiles}`,
    `**Functions Analyzed:** ${result.scannedFunctions}`,
    '',
    '---',
    '',
    '## Summary',
    '',
    `**Total Illusions Found:** ${result.totalIllusions}`,
    '',
    '| Severity | Count |',
    '|----------|-------|',
    `| CRITICAL | ${result.bySeverity.critical || 0} |`,
    `| HIGH | ${result.bySeverity.high || 0} |`,
    `| MEDIUM | ${result.bySeverity.medium || 0} |`,
    '',
    '| Category | Count |',
    '|----------|-------|',
  ];

  for (const [cat, count] of Object.entries(result.byCategory)) {
    lines.push(`| ${cat} | ${count} |`);
  }
  lines.push('');

  if (result.findings.length > 0) {
    lines.push('---', '', '## Findings', '');
    for (const f of result.findings) {
      lines.push(
        `### ${f.id}: ${f.description}`,
        '',
        `- **File:** \`${f.file}:${f.line}\``,
        `- **Function:** \`${f.function}\``,
        `- **Severity:** ${f.severity.toUpperCase()}`,
        `- **Category:** ${f.category}`,
        `- **Evidence:** ${f.evidence}`,
        '',
      );
    }
  }

  lines.push('---', '', '*CoBolt Illusion Scanner — Behavioral Illusion Detection*');
  return lines.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────

function printUsage() {
  console.log(`
  CoBolt Illusion Scanner — behavioral illusion detection
  =======================================================

  Detects code that LOOKS complete but isn't doing real work.
  Complements cobolt-audit.js (which catches explicit stubs/TODOs).

  Usage: node tools/cobolt-illusion-scan.js <command> [options]

  Commands:
    scan              Scan for behavioral illusions
    report            Generate markdown report from last scan

  Options:
    --dir <path>             Directory to scan (default: project root)
    --files <path>           Build artifact JSON with filesCreated/filesModified to scan
    --lang <list>            Comma-separated languages (py,js,ts,go,ex,rs)
    --save                   Save results to _cobolt-output/
    --json                   Output as JSON
    --out <path>             Write JSON/markdown output as UTF-8 to the given path
    --threshold <n>          Max allowed critical illusions (default: 0)
    --strict                 Exit non-zero when threshold exceeded (default: advisory, exit 0)
    --include-experimental   Run AST-dependent patterns (unused-parameters, etc.). Off by default — these
                             patterns produced 100% false-positive rates on real codebases until the AST
                             replacement lands.

  Tier: ADVISORY (default).
    Findings surface candidate concerns; they do not block. Use --strict to gate.
    The tool is heuristic regex/body-line; results require human review.

  Illusion Categories:
    mock-data          Hardcoded collections, random data generators
    noop-facade        Log-only actions, async functions that never await
    noop-error-handler Catch blocks that swallow errors silently
    passthrough        Functions that return input unchanged
    architecture-bypass Handlers/controllers that bypass the service/usecase layer
    simulated-delay    setTimeout/sleep simulating async work (debounce excluded)
    noop-validation    Validation functions that always return true
    conditional-stub   Env/config-gated noops (disabled features)
`);
}

function writeUtf8(filePath, content) {
  const resolved = path.resolve(process.cwd(), filePath);
  atomicWrite(resolved, content, { encoding: 'utf8' });
}

function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const args = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      positional.push(argv[i]);
    }
  }

  const command = positional[0] || 'scan';
  const projectDir = process.cwd();

  if (command === 'scan') {
    const scanner = new IllusionScanner(projectDir);
    const result = scanner.scan({
      dir: args.dir,
      files: args.files,
      lang: args.lang,
      experimental: args['include-experimental'] === true,
    });

    if (args.save) {
      const savedPath = saveResult('illusion-inventory.json', result);
      process.stderr.write(`[cobolt-illusion-scan] Saved to ${savedPath}\n`);
    }

    if (args.json || args.out) {
      const json = `${JSON.stringify(result, null, 2)}\n`;
      if (args.out) writeUtf8(args.out, json);
      process.stdout.write(json);
    } else {
      console.log(
        `\n  Illusion Scan (advisory tier): ${result.scannedFiles} files, ${result.scannedFunctions} functions`,
      );
      console.log(
        `  Illusions: ${result.totalIllusions} (${result.bySeverity.critical || 0} critical, ${result.bySeverity.high || 0} high, ${result.bySeverity.medium || 0} medium)\n`,
      );
      for (const f of result.findings) {
        const icon = f.severity === 'critical' ? 'X' : f.severity === 'high' ? '!' : '-';
        console.log(`  ${icon} [${f.severity.toUpperCase()}] ${f.file}:${f.line} ${f.function} — ${f.evidence}`);
      }
      if (result.totalIllusions === 0) {
        console.log('  No behavioral illusions detected.\n');
      }
      if (!result.experimental && result.experimentalPatternsSkipped.length > 0) {
        console.log(
          `  Skipped experimental patterns: ${result.experimentalPatternsSkipped.join(', ')} (use --include-experimental to enable)\n`,
        );
      }
    }

    // Advisory tier: default exit is 0 regardless of findings. --strict
    // restores the legacy "critical > threshold = fail" gate for callers
    // that explicitly opt in (e.g. CI gating an audit baseline).
    const threshold = Number.parseInt(args.threshold, 10);
    const maxCritical = Number.isNaN(threshold) ? 0 : threshold;
    const strict = args.strict === true;
    if (strict && (result.bySeverity.critical || 0) > maxCritical) process.exit(1);
    process.exit(0);
  } else if (command === 'report') {
    // Load last scan results
    const dir = getOutputDir();
    const inventoryPath = path.join(dir, 'illusion-inventory.json');
    if (!fs.existsSync(inventoryPath)) {
      console.error('No illusion scan results found. Run: node tools/cobolt-illusion-scan.js scan --save');
      process.exit(1);
    }
    const result = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
    const md = toMarkdown(result);

    if (args.save) {
      saveResult('illusion-report.md', md);
    }
    if (args.out) writeUtf8(args.out, md);
    console.log(md);
  } else {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { IllusionScanner, extractFunctions, toMarkdown, ILLUSION_PATTERNS };
