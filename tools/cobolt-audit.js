#!/usr/bin/env node

// CoBolt PRD Compliance Audit — deterministic stub/simulation detection,
// requirement tracing, and implementation depth analysis.
//
// No LLM inference. Pure regex/heuristic scanning. Runs in <5 seconds.
//
// Usage:
//   node tools/cobolt-audit.js stub-scan [--dir src/] [--lang py,js,ts]
//   node tools/cobolt-audit.js trace-requirements --prd docs/PRD.md
//   node tools/cobolt-audit.js depth-analyze [--dir src/]
//   node tools/cobolt-audit.js report --prd docs/PRD.md
//   node tools/cobolt-audit.js full --prd docs/PRD.md [--save] [--json]

const fs = require('node:fs');
const path = require('node:path');
const {
  extractRequirementDefinitions,
  normalizeRequirementId,
  requirementReferenceRegex,
} = require('../lib/cobolt-requirements');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
const accuracyEvaluator = (() => {
  try {
    return require('../lib/cobolt-accuracy-evaluator');
  } catch {
    return null;
  }
})();

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
  '.go': 'go',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.rs': 'rust',
};

// Directories to always skip
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
]);

// ── Stub/Simulation Pattern Library ────────────────────────────

const PATTERNS = [
  // CRITICAL — definitely placeholder code
  {
    id: 'not-implemented-py',
    lang: ['python'],
    severity: 'critical',
    category: 'not-implemented',
    regex: /raise\s+NotImplementedError/,
    desc: 'Raises NotImplementedError',
  },
  {
    id: 'pass-todo-py',
    lang: ['python'],
    severity: 'critical',
    category: 'stub-body',
    regex: /^\s*pass\s*#\s*(TODO|FIXME|stub|placeholder)/i,
    desc: 'pass with TODO/stub comment',
  },
  {
    id: 'placeholder-return',
    lang: null,
    severity: 'critical',
    category: 'hardcoded-return',
    regex: /return\s+["']placeholder/i,
    desc: 'Returns placeholder string',
  },
  {
    id: 'hardcoded-token',
    lang: null,
    severity: 'critical',
    category: 'hardcoded-return',
    regex: /return\s+["'](placeholder-token|fake[-_]?token|test[-_]?token|dummy[-_]?token|TODO|FAKE)["']/i,
    desc: 'Returns hardcoded token/fake value',
  },
  {
    id: 'not-implemented-js',
    lang: ['javascript', 'typescript'],
    severity: 'critical',
    category: 'not-implemented',
    regex: /throw\s+new\s+Error\(\s*["']Not\s*[Ii]mplemented/,
    desc: 'Throws Not Implemented error',
  },
  {
    id: 'todo-macro-rs',
    lang: ['rust'],
    severity: 'critical',
    category: 'not-implemented',
    regex: /todo!\s*\(/,
    desc: 'todo!() macro',
  },
  {
    id: 'unimplemented-rs',
    lang: ['rust'],
    severity: 'critical',
    category: 'not-implemented',
    regex: /unimplemented!\s*\(/,
    desc: 'unimplemented!() macro',
  },
  {
    id: 'panic-not-impl-go',
    lang: ['go'],
    severity: 'critical',
    category: 'not-implemented',
    regex: /panic\(\s*["']not\s+implemented/i,
    desc: 'panic("not implemented")',
  },
  {
    id: 'raise-not-impl-ex',
    lang: ['elixir'],
    severity: 'critical',
    category: 'not-implemented',
    regex: /raise\s+["'](not implemented|TODO)/i,
    desc: 'raise "not implemented"',
  },

  // HIGH — likely placeholder/simulation
  {
    id: 'simulated-comment',
    lang: null,
    severity: 'high',
    category: 'simulated',
    regex: /(?:#|\/\/)\s*(?:simulated|placeholder|stub(?:bed)?|fake|dummy|mock(?:ed)?)\b/i,
    desc: 'Simulated/placeholder comment',
  },
  {
    id: 'hardcoded-success',
    lang: null,
    severity: 'high',
    category: 'hardcoded-return',
    regex: /return\s+["'](?:SUCCESS|OK|DONE|COMPLETED)["']\s*;?\s*$/i,
    desc: 'Returns hardcoded success string',
  },
  {
    id: 'empty-body-py',
    lang: ['python'],
    severity: 'high',
    category: 'empty-body',
    regex: /^\s*(?:pass|\.\.\.)\s*$/,
    desc: 'Empty function body (pass/...)',
  },
  {
    id: 'noop-return-py',
    lang: ['python'],
    severity: 'high',
    category: 'stub-body',
    regex: /^\s*return\s+None\s*$/,
    desc: 'return None (potential stub)',
  },

  // MEDIUM — markers that indicate incomplete work
  {
    id: 'todo-marker',
    lang: null,
    severity: 'medium',
    category: 'todo-marker',
    regex: /\b(TODO|FIXME|HACK|XXX|TEMP)\b(?:\s*[:(]|\s*$)/,
    desc: 'TODO/FIXME/HACK marker',
  },
  {
    id: 'wip-comment',
    lang: null,
    severity: 'medium',
    category: 'todo-marker',
    regex: /(?:#|\/\/)\s*WIP\b/i,
    desc: 'WIP comment',
  },
];

// ── File Walker ────────────────────────────────────────────────

function walkFiles(dir, langFilter) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

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

// ── Stub Scanner ───────────────────────────────────────────────

class StubScanner {
  constructor(projectDir) {
    this.projectDir = projectDir || process.cwd();
  }

  scan(options = {}) {
    const dir = options.dir ? path.resolve(this.projectDir, options.dir) : this.projectDir;
    const langFilter = options.lang ? options.lang.split(',').map((l) => l.trim().toLowerCase()) : null;
    // Normalize lang aliases
    const langNorm = langFilter
      ? langFilter.map((l) =>
          l === 'ts'
            ? 'typescript'
            : l === 'js'
              ? 'javascript'
              : l === 'py'
                ? 'python'
                : l === 'ex'
                  ? 'elixir'
                  : l === 'rs'
                    ? 'rust'
                    : l,
        )
      : null;

    const files = walkFiles(dir, langNorm);
    const findings = [];
    let scannedFiles = 0;
    let scannedLines = 0;
    let skippedTestFiles = 0;

    for (const { file, lang } of files) {
      const relPath = path.relative(this.projectDir, file);
      // v0.40.3 — skip test/spec/fixture files when scanning for stubs.
      // DepthAnalyzer already skips them (line ~541); StubScanner was not,
      // so any legitimate test-local helper like `return "OK"` got flagged
      // as a high-severity production stub (false positive). Align with
      // DepthAnalyzer's test-file heuristic.
      if (/(?:test|spec|__mocks__|fixtures?)[/\\]|(?:_test\.|\.test\.|\.spec\.)/i.test(relPath)) {
        skippedTestFiles++;
        continue;
      }
      let content;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }

      const lines = content.split('\n');
      scannedFiles++;
      scannedLines += lines.length;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        for (const pattern of PATTERNS) {
          // Language filter: null means all languages
          if (pattern.lang && !pattern.lang.includes(lang)) continue;

          if (pattern.regex.test(line)) {
            // Context: function/class name from preceding lines
            const context = this._findContext(lines, i, lang);

            findings.push({
              id: `STUB-${String(findings.length + 1).padStart(3, '0')}`,
              file: path.relative(this.projectDir, file),
              line: i + 1,
              column: line.search(pattern.regex) + 1,
              pattern: pattern.id,
              matchedText: line.trim(),
              severity: pattern.severity,
              category: pattern.category,
              description: pattern.desc,
              language: lang,
              context: context || '',
            });
            break; // One finding per line
          }
        }
      }
    }

    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
    const byCategory = {};
    for (const f of findings) {
      bySeverity[f.severity]++;
      byCategory[f.category] = (byCategory[f.category] || 0) + 1;
    }

    return {
      timestamp: new Date().toISOString(),
      scannedFiles,
      scannedLines,
      skippedTestFiles,
      totalFindings: findings.length,
      bySeverity,
      byCategory,
      findings,
    };
  }

  _findContext(lines, idx, lang) {
    // Walk backwards to find enclosing function/method/class
    const funcPatterns = {
      python: /^\s*(?:def|class|async\s+def)\s+(\w+)/,
      javascript: /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=|(\w+)\s*\(|class\s+(\w+))/,
      typescript: /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=|(\w+)\s*\(|class\s+(\w+))/,
      go: /^func\s+(?:\([^)]*\)\s+)?(\w+)/,
      elixir: /^\s*def[p]?\s+(\w+)/,
      rust: /^\s*(?:pub\s+)?(?:fn|struct|impl|trait)\s+(\w+)/,
    };

    const pattern = funcPatterns[lang];
    if (!pattern) return null;

    for (let i = idx; i >= Math.max(0, idx - 20); i--) {
      const match = lines[i].match(pattern);
      if (match) {
        const name = match[1] || match[2] || match[3] || match[4];
        return name ? `${lines[i].trim()}` : null;
      }
    }
    return null;
  }
}

// ── Requirement Tracer ─────────────────────────────────────────

class RequirementTracer {
  constructor(projectDir) {
    this.projectDir = projectDir || process.cwd();
  }

  trace(options = {}) {
    const prdPath = resolvePreferredPrdPath(this.projectDir, options.prd);
    if (!prdPath || !fs.existsSync(prdPath)) {
      return { error: `PRD file not found: ${options.prd || '(not specified)'}`, requirements: [] };
    }

    // 1. Extract requirement IDs from canonical planning artifacts
    const planningDir = path.dirname(prdPath);
    const canonicalSources = [
      { file: prdPath, types: ['functional', 'non-functional'] },
      {
        file: options.trd ? path.resolve(this.projectDir, options.trd) : path.join(planningDir, 'trd.md'),
        types: ['technical'],
      },
      {
        file: options.implicit
          ? path.resolve(this.projectDir, options.implicit)
          : path.join(planningDir, 'implicit-requirements.md'),
        types: ['implicit'],
      },
    ];

    const reqsById = new Map();
    for (const source of canonicalSources) {
      if (!source.file || !fs.existsSync(source.file)) continue;
      const definitions = extractRequirementDefinitions(fs.readFileSync(source.file, 'utf8'), {
        types: source.types,
      });
      for (const definition of definitions) {
        reqsById.set(normalizeRequirementId(definition.id), definition);
      }
    }
    const reqIds = [...reqsById.keys()];

    if (reqIds.length === 0) {
      return {
        prdSource: options.prd,
        totalRequirements: 0,
        traced: 0,
        untraced: 0,
        traceRate: 0,
        requirements: [],
        note: 'No requirement identifiers found in PRD',
      };
    }

    // 2. Scan source and test files for references
    const files = walkFiles(this.projectDir, null);
    const reqMap = {};
    for (const id of reqIds) {
      reqMap[id] = {
        id,
        type: reqsById.get(id)?.type || null,
        codeReferences: [],
        testReferences: [],
      };
    }

    for (const { file } of files) {
      let content;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }

      const relPath = path.relative(this.projectDir, file);
      const isTest = /(?:test|spec|_test\.|\.test\.|\.spec\.)/i.test(relPath);

      const lines = content.split('\n');
      const reqMatchers = reqIds.map((id) => ({ id, regex: requirementReferenceRegex(id) }));
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const { id, regex } of reqMatchers) {
          if (regex.test(line)) {
            const ref = { file: relPath, line: i + 1, context: line.trim().substring(0, 120) };
            if (isTest) {
              reqMap[id].testReferences.push(ref);
            } else {
              reqMap[id].codeReferences.push(ref);
            }
          }
        }
      }
    }

    // 3. Classify
    const requirements = [];
    let traced = 0;
    let untraced = 0;
    const byType = {};

    for (const id of reqIds) {
      const r = reqMap[id];
      const hasCode = r.codeReferences.length > 0;
      const hasTest = r.testReferences.length > 0;
      const status = hasCode || hasTest ? 'traced' : 'untraced';

      if (status === 'traced') traced++;
      else untraced++;
      if (r.type) {
        if (!byType[r.type]) byType[r.type] = { total: 0, traced: 0 };
        byType[r.type].total++;
        if (status === 'traced') byType[r.type].traced++;
      }

      requirements.push({ ...r, status, hasCode, hasTest });
    }

    return {
      prdSource: options.prd || path.relative(this.projectDir, prdPath),
      resolvedPrdSource: path.relative(this.projectDir, prdPath),
      totalRequirements: reqIds.length,
      traced,
      untraced,
      traceRate: reqIds.length > 0 ? Math.round((traced / reqIds.length) * 1000) / 10 : 0,
      byType,
      requirements,
    };
  }
}

// ── Phase 4 Acceptance-Criteria Verifier ───────────────────────
//
// Issue 20 (v0.40.6) — deterministic grep-tier quick-depth AC verification.
//
// cobolt-audit-agent's Phase 4 documentation says: for huge PRDs (>100 FRs),
// tier Phase 4 depth so Critical/High get full per-AC verification while
// Medium/Low fall back to a grep-based "first line of AC appears in some
// file" quick check. Previously this was prompt-instruction only — agents
// skip instructions under task pressure. This verifier implements the quick
// check as a pure tool so every requirement has a deterministic floor.

const AC_STOPWORDS = new Set([
  'given',
  'when',
  'then',
  'and',
  'but',
  'that',
  'this',
  'with',
  'from',
  'into',
  'will',
  'shall',
  'must',
  'should',
  'may',
  'the',
  'a',
  'an',
  'of',
  'to',
  'in',
  'on',
  'at',
  'for',
  'by',
  'as',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'it',
  'its',
  'they',
  'them',
  'their',
  'there',
  'these',
  'those',
  'each',
  'any',
  'all',
  'some',
  'other',
  'such',
  'than',
  'so',
  'if',
  'else',
  'not',
  'no',
  'yes',
  'do',
  'does',
  'did',
  'done',
  'per',
  'via',
  'over',
  'under',
  'up',
  'down',
  'out',
  'off',
  'user',
  'system',
  'page',
  'data',
  'content',
  'value',
  'field',
  'input',
  'output',
  'request',
  'response',
  'status',
  'code',
  'action',
  'result',
  'state',
  'have',
  'has',
  'had',
  'can',
  'could',
  'would',
  'set',
  'get',
  'use',
  'used',
  'using',
  'able',
]);

class AcceptanceCriteriaVerifier {
  constructor(projectDir) {
    this.projectDir = projectDir || process.cwd();
  }

  verifyQuick(options = {}) {
    const prdPath = resolvePreferredPrdPath(this.projectDir, options.prd);
    if (!prdPath || !fs.existsSync(prdPath)) {
      return { error: `PRD file not found: ${options.prd || '(not specified)'}`, requirementCoverage: [] };
    }
    const planningDir = path.dirname(prdPath);
    const sources = [
      { file: prdPath, types: ['functional', 'non-functional'] },
      {
        file: options.trd ? path.resolve(this.projectDir, options.trd) : path.join(planningDir, 'trd.md'),
        types: ['technical'],
      },
      {
        file: options.implicit
          ? path.resolve(this.projectDir, options.implicit)
          : path.join(planningDir, 'implicit-requirements.md'),
        types: ['implicit'],
      },
    ];
    const defs = [];
    for (const s of sources) {
      if (!s.file || !fs.existsSync(s.file)) continue;
      const list = extractRequirementDefinitions(fs.readFileSync(s.file, 'utf8'), { types: s.types });
      for (const d of list) defs.push(d);
    }
    if (defs.length === 0) {
      return {
        prdSource: options.prd,
        totalRequirements: 0,
        requirementCoverage: [],
        note: 'No requirement definitions found',
      };
    }

    const minCluster = Math.max(1, Number(options.minClusterSize) || 2);
    const maxKw = Math.max(1, Number(options.maxKeywordsPerAc) || 6);
    const windowLines = 5;

    const files = walkFiles(this.projectDir, null);
    const fileCache = new Map();
    const loadFile = (file) => {
      if (fileCache.has(file)) return fileCache.get(file);
      try {
        const text = fs.readFileSync(file, 'utf8');
        const lines = text.split('\n');
        fileCache.set(file, { text, lines, lowered: lines.map((l) => l.toLowerCase()) });
        return fileCache.get(file);
      } catch {
        fileCache.set(file, null);
        return null;
      }
    };

    const extractKeywords = (line) =>
      Array.from(
        new Set(
          String(line || '')
            .toLowerCase()
            .replace(/[^a-z0-9_\s-]+/g, ' ')
            .split(/\s+/)
            .filter((tok) => tok.length >= 3 && !/^\d+$/.test(tok) && !AC_STOPWORDS.has(tok)),
        ),
      ).slice(0, maxKw);

    const requirementCoverage = [];
    let quickFull = 0;
    let quickPartial = 0;
    let quickMissing = 0;
    let acTotal = 0;
    let acHit = 0;

    for (const def of defs) {
      const acs = Array.isArray(def.acceptanceCriteria) ? def.acceptanceCriteria : [];
      const acLines = acs.length > 0 ? acs : [def.description || def.title || def.id];
      const perAC = [];
      for (let i = 0; i < acLines.length; i++) {
        const acText = acLines[i];
        const keywords = extractKeywords(acText);
        acTotal++;
        if (keywords.length < minCluster) {
          perAC.push({ index: i + 1, ac: acText, keywords, hit: false, reason: 'insufficient-keywords' });
          continue;
        }
        let hit = null;
        outer: for (const { file } of files) {
          const cached = loadFile(file);
          if (!cached) continue;
          const { lines, lowered } = cached;
          for (let li = 0; li < lowered.length; li++) {
            const windowEnd = Math.min(lowered.length, li + windowLines);
            const matched = [];
            for (let wi = li; wi < windowEnd; wi++) {
              const low = lowered[wi];
              for (const kw of keywords) {
                if (!matched.includes(kw) && low.includes(kw)) matched.push(kw);
                if (matched.length >= minCluster) break;
              }
              if (matched.length >= minCluster) break;
            }
            if (matched.length >= minCluster) {
              hit = {
                file: path.relative(this.projectDir, file),
                line: li + 1,
                context: (lines[li] || '').trim().substring(0, 160),
                matchedKeywords: matched,
              };
              break outer;
            }
          }
        }
        if (hit) {
          acHit++;
          perAC.push({ index: i + 1, ac: acText, keywords, hit: true, ...hit });
        } else {
          perAC.push({ index: i + 1, ac: acText, keywords, hit: false, reason: 'no-cluster-match' });
        }
      }
      const hits = perAC.filter((a) => a.hit).length;
      const status = hits === perAC.length ? 'full-hit' : hits === 0 ? 'missing' : 'partial';
      if (status === 'full-hit') quickFull++;
      else if (status === 'partial') quickPartial++;
      else quickMissing++;
      requirementCoverage.push({
        id: def.id,
        type: def.type,
        title: def.title,
        phase4Depth: 'quick',
        status,
        acCount: perAC.length,
        acHits: hits,
        perAC,
      });
    }

    return {
      prdSource: options.prd || path.relative(this.projectDir, prdPath),
      resolvedPrdSource: path.relative(this.projectDir, prdPath),
      phase4Depth: 'quick',
      minClusterSize: minCluster,
      totalRequirements: defs.length,
      totalAcceptanceCriteria: acTotal,
      acceptanceCriteriaHit: acHit,
      acceptanceCriteriaCoverage: acTotal > 0 ? Math.round((acHit / acTotal) * 1000) / 10 : 0,
      requirementsFull: quickFull,
      requirementsPartial: quickPartial,
      requirementsMissing: quickMissing,
      requirementCoverage,
    };
  }
}

function resolvePreferredPrdPath(projectDir, requestedPrd) {
  const canonicalPlanningPrd = path.join(projectDir, '_cobolt-output', 'latest', 'planning', 'prd.md');

  if (!requestedPrd) {
    return fs.existsSync(canonicalPlanningPrd) ? canonicalPlanningPrd : null;
  }

  const requestedPath = path.resolve(projectDir, requestedPrd);
  const normalizedRequested = String(requestedPrd).replace(/\\/g, '/').toLowerCase();
  if (normalizedRequested === 'docs/prd.md' && fs.existsSync(canonicalPlanningPrd)) {
    return canonicalPlanningPrd;
  }

  return requestedPath;
}

class SecurityInvariantScanner {
  constructor(projectDir) {
    this.projectDir = projectDir || process.cwd();
  }

  scan(options = {}) {
    const dir = options.dir ? path.resolve(this.projectDir, options.dir) : this.projectDir;
    const files = walkFiles(dir, null);
    const findings = [];
    const patterns = [
      {
        id: 'client-token-storage',
        severity: 'high',
        category: 'token-storage',
        regex:
          /\b(?:localStorage|sessionStorage)\.(?:setItem|getItem)\s*\([^)\n]*(?:access|refresh|auth|jwt|bearer|token)[^)\n]*\)/i,
        desc: 'Auth/session token handled via browser storage',
      },
      {
        id: 'token-query-parameter',
        severity: 'high',
        category: 'token-transport',
        regex:
          /\b(?:searchParams\.(?:get|set)|URLSearchParams|req\.query|r\.URL\.Query\(\)|query\[[^\]]+\])[^.\n]*(?:access[_-]?token|refresh[_-]?token|jwt|bearer)/i,
        desc: 'Access or refresh token handled via URL/query parameters',
      },
      {
        id: 'plaintext-sensitive-persistence',
        severity: 'high',
        category: 'secret-persistence',
        regex:
          /\b(?:create|insert|update|upsert|save|persist)\w*\([^)\n]*(?:resetToken|verificationToken|refreshToken|apiKey|api_key|secret|recoveryCode)/i,
        desc: 'Sensitive token/secret appears to be persisted without obvious hashing or encryption',
      },
    ];

    for (const { file } of files) {
      let content;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }

      const relPath = path.relative(this.projectDir, file);
      if (/(?:test|spec|_test\.|\.test\.|\.spec\.)/i.test(relPath)) continue;

      for (const [index, line] of content.split('\n').entries()) {
        for (const pattern of patterns) {
          if (!pattern.regex.test(line)) continue;
          findings.push({
            id: `SECINV-${String(findings.length + 1).padStart(3, '0')}`,
            file: relPath,
            line: index + 1,
            severity: pattern.severity,
            category: pattern.category,
            description: pattern.desc,
            matchedText: line.trim(),
          });
          break;
        }
      }
    }

    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
    const byCategory = {};
    for (const finding of findings) {
      bySeverity[finding.severity] = (bySeverity[finding.severity] || 0) + 1;
      byCategory[finding.category] = (byCategory[finding.category] || 0) + 1;
    }

    return {
      timestamp: new Date().toISOString(),
      scannedFiles: files.length,
      totalFindings: findings.length,
      bySeverity,
      byCategory,
      findings,
    };
  }
}

// ── Implementation Depth Analyzer ──────────────────────────────

class DepthAnalyzer {
  constructor(projectDir) {
    this.projectDir = projectDir || process.cwd();
  }

  analyze(options = {}) {
    const dir = options.dir ? path.resolve(this.projectDir, options.dir) : this.projectDir;
    const files = walkFiles(dir, null);
    const findings = [];

    for (const { file, lang } of files) {
      let content;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }

      const relPath = path.relative(this.projectDir, file);
      // Skip test files for depth analysis
      if (/(?:test|spec|_test\.|\.test\.|\.spec\.)/i.test(relPath)) continue;

      const functions = this._extractFunctions(content, lang);

      for (const fn of functions) {
        const issues = [];

        // Check: empty/trivial body
        if (fn.bodyLines <= 1 && /^\s*(?:pass|return\s+None|return\s*;?|\.\.\.)\s*$/.test(fn.body.trim())) {
          issues.push({ type: 'empty-body', severity: 'high', desc: 'Function body is empty or trivial' });
        }

        // Check: hardcoded return without logic
        const bodyTrimmed = fn.body.trim();
        if (
          fn.bodyLines <= 3 &&
          /^return\s+["'{}[\]]/.test(bodyTrimmed) &&
          !/if\b|for\b|while\b|switch\b|case\b|match\b|cond\b/.test(fn.body)
        ) {
          issues.push({
            type: 'hardcoded-return',
            severity: 'high',
            desc: 'Returns hardcoded value without conditional logic',
          });
        }

        // Check: action-named function without external calls
        const actionNames =
          /^(?:provision|upload|deploy|send|sync|connect|authenticate|publish|notify|fetch|download|submit|create_|update_|delete_)/i;
        if (actionNames.test(fn.name)) {
          const hasExternalCall =
            /(?:http|https|fetch|request|axios|client\.|sdk\.|api\.|\.post\(|\.get\(|\.put\(|\.delete\(|\.patch\(|httpx|aiohttp|urllib|requests\.|GenServer\.call|HTTPoison|Tesla|Finch|Net::HTTP|Faraday)/i.test(
              fn.body,
            );
          const hasDbOnly =
            /(?:db\.|\.add\(|\.commit\(|\.save\(|Repo\.|\.insert|\.create\(|\.update\(|session\.|cursor\.)/.test(
              fn.body,
            );

          if (!hasExternalCall && hasDbOnly) {
            issues.push({
              type: 'db-only-simulation',
              severity: 'high',
              desc: 'Action function creates DB records but makes no external service calls',
            });
          } else if (!hasExternalCall && fn.bodyLines > 2) {
            issues.push({
              type: 'no-external-call',
              severity: 'medium',
              desc: 'Action-named function makes no external service calls',
            });
          }
        }

        if (issues.length > 0) {
          findings.push({
            file: relPath,
            line: fn.startLine,
            name: fn.name,
            bodyLines: fn.bodyLines,
            issues,
          });
        }
      }
    }

    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of findings) {
      for (const issue of f.issues) {
        bySeverity[issue.severity]++;
      }
    }

    return {
      timestamp: new Date().toISOString(),
      totalFunctions: findings.length,
      bySeverity,
      findings,
    };
  }

  _extractFunctions(content, lang) {
    const functions = [];
    const lines = content.split('\n');

    if (lang === 'python') {
      // Match def/async def and capture body via indentation
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/);
        if (!match) continue;

        const indent = match[1].length;
        const name = match[2];
        const startLine = i + 1;

        // Find body (lines with deeper indentation, skip docstrings)
        const bodyStart = i + 1;
        let bodyEnd = bodyStart;
        let inDocstring = false;

        for (let j = bodyStart; j < lines.length; j++) {
          const line = lines[j];
          if (line.trim() === '') {
            bodyEnd = j;
            continue;
          }

          // Track docstrings
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

          // If dedented back to function level or less, stop
          const lineIndent = line.match(/^(\s*)/)[1].length;
          if (lineIndent <= indent && line.trim() !== '') break;

          bodyEnd = j;
        }

        const bodyLines = lines
          .slice(bodyStart, bodyEnd + 1)
          .filter((l) => l.trim() && !l.trim().startsWith('#') && !/^\s*(?:"""|''')/.test(l));
        functions.push({
          name,
          startLine,
          bodyLines: bodyLines.length,
          body: bodyLines.join('\n'),
        });
      }
    } else if (lang === 'javascript' || lang === 'typescript') {
      // Match function declarations and arrow functions
      for (let i = 0; i < lines.length; i++) {
        const fnMatch = lines[i].match(
          /(?:(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(?[^)]*\)?\s*=>|(\w+)\s*\([^)]*\)\s*\{)/,
        );
        if (!fnMatch) continue;

        const name = fnMatch[1] || fnMatch[2] || fnMatch[3];
        if (!name) continue;
        const startLine = i + 1;

        // Find brace-delimited body
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
          const bodyLines = lines
            .slice(bodyStart, bodyEnd)
            .filter((l) => l.trim() && !l.trim().startsWith('//') && !l.trim().startsWith('*'));
          functions.push({
            name,
            startLine,
            bodyLines: bodyLines.length,
            body: bodyLines.join('\n'),
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
          functions.push({ name, startLine, bodyLines: bodyLines.length, body: bodyLines.join('\n') });
        }
      }
    } else if (lang === 'elixir') {
      // Detects two clause forms (mirrors tools/cobolt-illusion-scan.js
      // extractFunctions Elixir branch — same false-negative bug class):
      //   1) Block form:      def(p)? name(args) do ... end
      //   2) Shorthand form:  def(p)? name(args), do: expr
      //                       (or def(p)? name(args), do: expr, else: ..., rescue: ...)
      // The shorthand has NO trailing `end` — its body is the single expression
      // after `do:`. Without shorthand detection, the depth-walk forward-search
      // for `end` finds none, the body slice collapses to 0 lines, and every
      // shorthand clause gets reported as a shallow-implementation finding.
      // Identifier rule: Elixir function names may end in `?` or `!`
      // (`valid?`, `save!`). Plain `\w+` silently drops those clauses.
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
          // the captured body is just the primary `do:` expression.
          bodyExpr = bodyExpr.replace(/\s*,\s*(?:else|rescue|after|catch):\s.*$/, '');
          const bodyLineCount = bodyExpr.trim() ? 1 : 0;
          functions.push({ name, startLine, bodyLines: bodyLineCount, body: bodyExpr });
          continue;
        }

        // Find matching end (block form)
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
        functions.push({ name, startLine, bodyLines: bodyLines.length, body: bodyLines.join('\n') });
      }
    }

    return functions;
  }
}

// ── Audit Report Generator ─────────────────────────────────────

class AuditReporter {
  constructor(projectDir) {
    this.projectDir = projectDir || process.cwd();
  }

  generate(stubResult, traceResult, depthResult, options = {}) {
    // Calculate score
    const criticalStubs = stubResult.bySeverity.critical || 0;
    const highStubs = stubResult.bySeverity.high || 0;
    const mediumStubs = stubResult.bySeverity.medium || 0;

    const stubPenalty = criticalStubs * 5 + highStubs * 3 + mediumStubs * 1;

    const traceRate = traceResult.traceRate || 0;
    const totalReqs = traceResult.totalRequirements || 0;

    const simulatedCount = depthResult.findings.filter((f) =>
      f.issues.some((i) => i.type === 'db-only-simulation'),
    ).length;
    const shallowCount = depthResult.findings.filter((f) =>
      f.issues.some((i) => i.type === 'empty-body' || i.type === 'hardcoded-return'),
    ).length;
    const depthPenalty = simulatedCount * 4 + shallowCount * 2;

    const baseScore = traceRate - stubPenalty - depthPenalty;
    const score = Math.max(0, Math.min(100, Math.round(baseScore * 10) / 10));

    const grade =
      score >= 98 ? 'A+' : score >= 95 ? 'A' : score >= 85 ? 'B' : score >= 70 ? 'C' : score >= 50 ? 'D' : 'F';
    const verdict =
      (grade === 'A+' || grade === 'A') && criticalStubs === 0
        ? 'PASS'
        : grade === 'B' && criticalStubs === 0
          ? 'CONDITIONAL_PASS'
          : 'FAIL';

    const report = {
      // v0.40.3 — explicit schemaVersion so downstream consumers
      // (validation-critic, deploy gate, milestone-validate, gap-closer) can
      // detect format drift and fail-closed on incompatible versions rather
      // than parsing silently against the wrong contract.
      schemaVersion: 'cobolt-audit-report/v1',
      timestamp: new Date().toISOString(),
      projectDir: this.projectDir,
      prdSource: traceResult.prdSource || null,
      mode: options.mode || 'milestone',
      milestone: options.milestone || null,
      summary: {
        score,
        grade,
        verdict,
        totalRequirements: totalReqs,
        tracedRequirements: traceResult.traced || 0,
        untracedRequirements: traceResult.untraced || 0,
        traceRate,
        totalStubs: stubResult.totalFindings,
        criticalStubs,
        highStubs,
        mediumStubs,
        simulatedFunctions: simulatedCount,
        shallowFunctions: shallowCount,
      },
      gradeScale: {
        'A+': '98-100 — Production-ready, exceeds PRD',
        A: '95-97 — Production-ready, meets PRD fully',
        B: '85-94 — Mostly complete, minor gaps',
        C: '70-84 — Significant gaps, needs work',
        D: '50-69 — Major gaps, substantial work needed',
        F: '0-49 — Critical failure, most PRD unimplemented',
      },
      verdictRules: {
        PASS: 'Grade A or A+ AND zero critical stubs',
        CONDITIONAL_PASS: 'Grade B AND zero critical stubs',
        FAIL: 'Grade C or below OR any critical stub unresolved',
      },
      stubs: stubResult,
      traceability: traceResult,
      depth: depthResult,
    };

    return report;
  }

  toMarkdown(report) {
    const s = report.summary;
    const lines = [
      '# PRD Compliance Audit Report',
      '',
      `**Audit Date:** ${report.timestamp}`,
      `**PRD Source:** ${report.prdSource || 'Not specified'}`,
      `**Mode:** ${report.mode}`,
      report.milestone ? `**Milestone:** ${report.milestone}` : '',
      '',
      '---',
      '',
      '## Executive Summary',
      '',
      `**Overall Score: ${s.score}% | Grade: ${s.grade} | Verdict: ${s.verdict}**`,
      '',
      `- **Requirements Traced:** ${s.tracedRequirements}/${s.totalRequirements} (${s.traceRate}%)`,
      `- **Stub/Placeholder Findings:** ${s.totalStubs} (${s.criticalStubs} critical, ${s.highStubs} high, ${s.mediumStubs} medium)`,
      `- **Simulated Functions:** ${s.simulatedFunctions} (DB-only, no external calls)`,
      `- **Shallow Functions:** ${s.shallowFunctions} (empty body or hardcoded return)`,
      '',
      '---',
      '',
      '## 1. Stub/Placeholder Findings',
      '',
      '| Severity | Count |',
      '|----------|-------|',
      `| CRITICAL | ${s.criticalStubs} |`,
      `| HIGH | ${s.highStubs} |`,
      `| MEDIUM | ${s.mediumStubs} |`,
      `| **TOTAL** | **${s.totalStubs}** |`,
      '',
    ];

    // Critical findings detail
    const criticals = report.stubs.findings.filter((f) => f.severity === 'critical');
    if (criticals.length > 0) {
      lines.push('### Critical Findings', '');
      for (const f of criticals) {
        lines.push(
          `#### ${f.id}: ${f.description}`,
          '',
          `**File:** \`${f.file}:${f.line}\``,
          `**Pattern:** ${f.pattern}`,
          `**Context:** \`${f.context}\``,
          '',
          '```',
          f.matchedText,
          '```',
          '',
        );
      }
    }

    // High findings
    const highs = report.stubs.findings.filter((f) => f.severity === 'high');
    if (highs.length > 0) {
      lines.push('### High-Priority Findings', '');
      for (const f of highs) {
        lines.push(`- **${f.id}** \`${f.file}:${f.line}\` — ${f.description}: \`${f.matchedText.substring(0, 80)}\``);
      }
      lines.push('');
    }

    // Requirement traceability
    lines.push(
      '---',
      '',
      '## 2. Requirement Traceability',
      '',
      `**Trace Rate:** ${s.traceRate}% (${s.tracedRequirements}/${s.totalRequirements})`,
      '',
    );

    const untraced = (report.traceability.requirements || []).filter((r) => r.status === 'untraced');
    if (untraced.length > 0) {
      lines.push('### Untraced Requirements (no code or test reference found)', '');
      lines.push('| Requirement ID | Status |');
      lines.push('|---------------|--------|');
      for (const r of untraced) {
        lines.push(`| ${r.id} | UNTRACED |`);
      }
      lines.push('');
    }

    // Depth analysis
    lines.push(
      '---',
      '',
      '## 3. Implementation Depth',
      '',
      `**Simulated Functions:** ${s.simulatedFunctions}`,
      `**Shallow Functions:** ${s.shallowFunctions}`,
      '',
    );

    const depthFindings = report.depth.findings || [];
    if (depthFindings.length > 0) {
      lines.push('| Function | File | Issue | Severity |');
      lines.push('|----------|------|-------|----------|');
      for (const f of depthFindings) {
        for (const issue of f.issues) {
          lines.push(`| ${f.name} | \`${f.file}:${f.line}\` | ${issue.desc} | ${issue.severity} |`);
        }
      }
      lines.push('');
    }

    if (report.accuracy) {
      lines.push(
        '---',
        '',
        '## 4. Accuracy Evaluation',
        '',
        `**Score:** ${report.accuracy.score}%`,
        `**Grade:** ${report.accuracy.grade}`,
        `**Verdict:** ${report.accuracy.verdict}`,
        '',
      );
    }

    // Grade scale
    lines.push(
      '---',
      '',
      '## 5. Grading',
      '',
      '| Grade | Threshold | Description |',
      '|-------|-----------|-------------|',
    );
    for (const [g, desc] of Object.entries(report.gradeScale)) {
      lines.push(`| ${g} | ${desc.split(' — ')[0]} | ${desc.split(' — ')[1] || ''} |`);
    }
    lines.push('', `**This audit: Grade ${s.grade} (${s.score}%) — Verdict: ${s.verdict}**`);
    lines.push('', '---', '', '*Made by CoBolt — Autonomous Development Platform*');

    return lines.filter((l) => l !== undefined).join('\n');
  }
}

// ── Full Audit Runner ──────────────────────────────────────────

function runFull(options = {}) {
  const projectDir = options.projectDir || process.cwd();

  const stubScanner = new StubScanner(projectDir);
  const stubResult = stubScanner.scan(options);

  const tracer = new RequirementTracer(projectDir);
  const traceResult = tracer.trace(options);

  const depthAnalyzer = new DepthAnalyzer(projectDir);
  const depthResult = depthAnalyzer.analyze(options);

  const reporter = new AuditReporter(projectDir);
  const report = reporter.generate(stubResult, traceResult, depthResult, options);
  const accuracyReport =
    typeof accuracyEvaluator?.evaluateAccuracy === 'function'
      ? accuracyEvaluator.evaluateAccuracy(projectDir, { traceabilityResult: traceResult })
      : null;
  if (accuracyReport?.summary) {
    report.accuracy = accuracyReport.summary;
  }

  return { report, markdown: reporter.toMarkdown(report), accuracyReport };
}

// ── Output Helpers ─────────────────────────────────────────────

function outputDir() {
  const _p = typeof _paths === 'function' ? _paths() : null;
  if (_p) {
    // Use run-scoped audit directory
    const runDir = _p.currentRun();
    const auditDir = path.join(runDir, 'audit');
    if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
    return auditDir;
  }
  const fallback = path.join(process.cwd(), '_cobolt-output', 'latest', 'audit');
  if (!fs.existsSync(fallback)) fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

function saveResult(filename, data) {
  const dir = outputDir();
  const filePath = path.join(dir, filename);
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  atomicWrite(filePath, content, { encoding: 'utf8' });
  return filePath;
}

// ── CLI ────────────────────────────────────────────────────────

function printUsage() {
  console.log(`
  CoBolt PRD Compliance Audit — deterministic stub/simulation detection
  =====================================================================

  Usage: node tools/cobolt-audit.js <command> [options]

  Commands:
    stub-scan           Scan for stub/placeholder/simulation patterns
    trace-requirements  Cross-reference PRD requirements against code
    depth-analyze       Analyze implementation depth of functions
    ac-verify           Quick-depth grep-tier acceptance-criteria verification (huge PRDs)
    security-invariants Scan for auth/session/token invariant violations
    report              Generate audit report from scan results
    full                Run all scans and generate report

  Options:
    --prd <path>        Path to PRD file (required for trace/report/full)
    --dir <path>        Directory to scan (default: project root)
    --lang <list>       Comma-separated languages to scan (py,js,ts,go,ex,rs)
    --save              Save results to _cobolt-output/latest/audit/
    --json              Output results as JSON
    --mode <mode>       milestone or final (for report context)
    --milestone <id>    Milestone ID (e.g., M1)
`);
}

function parseArgs(argv) {
  const args = { _: [] };
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
      args._.push(argv[i]);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let command = args._[0];

  if (!command && (args.prd || args.milestone || args.output || args.strict)) {
    command = 'full';
  }

  if (!command || args.help) {
    printUsage();
    process.exit(0);
  }

  const projectDir = process.cwd();
  const options = { dir: args.dir, lang: args.lang, prd: args.prd, mode: args.mode, milestone: args.milestone };

  try {
    if (command === 'stub-scan') {
      const scanner = new StubScanner(projectDir);
      const result = scanner.scan(options);

      if (args.save) saveResult('stub-inventory.json', result);
      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n  Stub Scan: ${result.scannedFiles} files, ${result.scannedLines} lines`);
        console.log(
          `  Findings: ${result.totalFindings} (${result.bySeverity.critical} critical, ${result.bySeverity.high} high, ${result.bySeverity.medium} medium)\n`,
        );
        for (const f of result.findings) {
          const icon = f.severity === 'critical' ? 'X' : f.severity === 'high' ? '!' : '-';
          console.log(`  ${icon} [${f.severity.toUpperCase()}] ${f.file}:${f.line} — ${f.description}`);
        }
      }

      process.exit(result.bySeverity.critical > 0 ? 1 : 0);
    } else if (command === 'trace-requirements') {
      const tracer = new RequirementTracer(projectDir);
      const result = tracer.trace(options);

      if (result.error) {
        console.error(`  Error: ${result.error}`);
        process.exit(1);
      }
      if (args.save) saveResult('requirement-traceability.json', result);
      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n  Requirement Tracing: ${result.totalRequirements} requirements found in PRD`);
        console.log(`  Traced: ${result.traced} | Untraced: ${result.untraced} | Rate: ${result.traceRate}%\n`);
        for (const r of result.requirements.filter((r) => r.status === 'untraced')) {
          console.log(`  X [UNTRACED] ${r.id} — no code or test references found`);
        }
      }

      process.exit(result.untraced > 0 ? 2 : 0);
    } else if (command === 'depth-analyze') {
      const analyzer = new DepthAnalyzer(projectDir);
      const result = analyzer.analyze(options);

      if (args.save) saveResult('implementation-depth.json', result);
      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n  Depth Analysis: ${result.totalFunctions} functions with issues`);
        console.log(
          `  By severity: ${result.bySeverity.critical} critical, ${result.bySeverity.high} high, ${result.bySeverity.medium} medium\n`,
        );
        for (const f of result.findings) {
          for (const issue of f.issues) {
            console.log(`  ! [${issue.severity.toUpperCase()}] ${f.file}:${f.line} ${f.name}() — ${issue.desc}`);
          }
        }
      }

      process.exit(result.bySeverity.critical > 0 || result.bySeverity.high > 0 ? 1 : 0);
    } else if (command === 'ac-verify') {
      // Issue 20 (v0.40.6) — deterministic quick-depth grep-tier AC verification.
      const verifier = new AcceptanceCriteriaVerifier(projectDir);
      const result = verifier.verifyQuick(options);
      if (args.save) saveResult('acceptance-criteria-quick.json', result);
      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.error) {
        console.log(`\n  AC-Verify ERROR: ${result.error}\n`);
      } else {
        console.log(
          `\n  AC-Verify (quick depth): ${result.requirementsFull}/${result.totalRequirements} fully covered, ${result.requirementsPartial} partial, ${result.requirementsMissing} missing`,
        );
        console.log(
          `  AC coverage: ${result.acceptanceCriteriaHit}/${result.totalAcceptanceCriteria} lines (${result.acceptanceCriteriaCoverage}%)`,
        );
      }
      process.exit(result.error ? 1 : 0);
    } else if (command === 'security-invariants') {
      const scanner = new SecurityInvariantScanner(projectDir);
      const result = scanner.scan(options);

      if (args.save) saveResult('security-invariants.json', result);
      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n  Security Invariants: ${result.totalFindings} findings`);
        for (const finding of result.findings) {
          console.log(
            `  ! [${finding.severity.toUpperCase()}] ${finding.file}:${finding.line} - ${finding.description}`,
          );
        }
      }

      process.exit(result.totalFindings > 0 ? 1 : 0);
    } else if (command === 'report') {
      // Load saved results or run fresh
      const dir = outputDir();
      let stubResult, traceResult, depthResult;

      try {
        stubResult = JSON.parse(fs.readFileSync(path.join(dir, 'stub-inventory.json'), 'utf8'));
      } catch {
        const scanner = new StubScanner(projectDir);
        stubResult = scanner.scan(options);
      }
      try {
        traceResult = JSON.parse(fs.readFileSync(path.join(dir, 'requirement-traceability.json'), 'utf8'));
      } catch {
        const tracer = new RequirementTracer(projectDir);
        traceResult = tracer.trace(options);
      }
      try {
        depthResult = JSON.parse(fs.readFileSync(path.join(dir, 'implementation-depth.json'), 'utf8'));
      } catch {
        const analyzer = new DepthAnalyzer(projectDir);
        depthResult = analyzer.analyze(options);
      }

      const reporter = new AuditReporter(projectDir);
      const report = reporter.generate(stubResult, traceResult, depthResult, options);
      const accuracyReport =
        typeof accuracyEvaluator?.evaluateAccuracy === 'function'
          ? accuracyEvaluator.evaluateAccuracy(projectDir, { traceabilityResult: traceResult })
          : null;
      if (accuracyReport?.summary) report.accuracy = accuracyReport.summary;
      const markdown = reporter.toMarkdown(report);

      if (args.save) {
        saveResult('audit-report.json', report);
        saveResult('audit-report.md', markdown);
        if (accuracyReport && typeof accuracyEvaluator?.writeAccuracyReport === 'function') {
          accuracyEvaluator.writeAccuracyReport(projectDir, accuracyReport);
        }
      }
      if (args.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(markdown);
      }

      process.exit(report.summary.verdict === 'PASS' ? 0 : report.summary.verdict === 'CONDITIONAL_PASS' ? 2 : 1);
    } else if (command === 'full') {
      const { report, markdown, accuracyReport } = runFull({ ...options, projectDir });

      if (args.save) {
        saveResult('stub-inventory.json', report.stubs);
        saveResult('requirement-traceability.json', report.traceability);
        saveResult('implementation-depth.json', report.depth);
        saveResult('audit-report.json', report);
        saveResult('audit-report.md', markdown);
        if (accuracyReport && typeof accuracyEvaluator?.writeAccuracyReport === 'function') {
          accuracyEvaluator.writeAccuracyReport(projectDir, accuracyReport);
        }
        console.log(`\n  Reports saved to: ${outputDir()}`);
      }

      if (args.output) {
        fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      }

      if (args.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(markdown);
      }

      const exitCode = report.summary.verdict === 'PASS' ? 0 : report.summary.verdict === 'CONDITIONAL_PASS' ? 2 : 1;
      console.log(`\n  Exit code: ${exitCode} (${report.summary.verdict})`);
      process.exit(exitCode);
    } else {
      console.error(`  Unknown command: ${command}`);
      printUsage();
      process.exit(1);
    }
  } catch (err) {
    console.error(`  Audit error: ${err.message}`);
    if (args.json) console.log(JSON.stringify({ error: err.message }, null, 2));
    process.exit(1);
  }
}

// ── Module Exports ─────────────────────────────────────────────

// Internal helper exposed for regression testing of the Elixir shorthand /
// `?`/`!` suffix fix that mirrors tools/cobolt-illusion-scan.js. Not intended
// for outside callers — the public surface is DepthAnalyzer.analyze().
function _extractFunctionsForTesting(content, lang) {
  const analyzer = new DepthAnalyzer(process.cwd());
  return analyzer._extractFunctions(content, lang);
}

module.exports = {
  StubScanner,
  RequirementTracer,
  DepthAnalyzer,
  SecurityInvariantScanner,
  AcceptanceCriteriaVerifier,
  AuditReporter,
  runFull,
  _extractFunctionsForTesting,
};

// Run CLI if invoked directly
if (require.main === module) {
  main();
}
