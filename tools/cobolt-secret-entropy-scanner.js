#!/usr/bin/env node

// CoBolt Secret Entropy Scanner — high-entropy string detection for secret discovery
//
// Complements pattern-based tools (gitleaks, trufflehog) by detecting secrets
// that don't match known patterns. Uses Shannon entropy to find likely secrets.
//
// No LLM inference. Pure information-theory calculation.
//
// Usage:
//   node tools/cobolt-secret-entropy-scanner.js scan [--dir src/] [--json] [--save]
//   node tools/cobolt-secret-entropy-scanner.js scan --threshold 4.5
//
// Exit codes:  0 = no high-entropy strings found, 1 = potential secrets detected

const fs = require('node:fs');
const path = require('node:path');

const { paths: _paths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();

const SOURCE_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.go',
  '.ex',
  '.exs',
  '.rs',
  '.rb',
  '.java',
  '.yaml',
  '.yml',
  '.toml',
  '.json',
  '.env',
  '.cfg',
  '.ini',
  '.conf',
]);
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.agent',
  '_build',
  'deps',
  '__pycache__',
  'dist',
  'build',
  'target',
  '.next',
  'coverage',
  'test',
  'tests',
  '__tests__',
  '__mocks__',
  'fixtures',
  '__fixtures__',
  '_cobolt-output',
  '.claude',
  '.codex',
  'vendor',
  '.stryker-tmp',
]);
const SKIP_FILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'mix.lock',
  'go.sum',
  'Cargo.lock',
  'poetry.lock',
  'Gemfile.lock',
]);

const MIN_STRING_LENGTH = 16;
const DEFAULT_ENTROPY_THRESHOLD = 4.5;
const MAX_STRING_LENGTH = 256;
const NO_CONTEXT_ENTROPY_THRESHOLD = 4.85;
const CONTEXTUAL_ENTROPY_THRESHOLD = 3.8;
const HEX_CONTEXTUAL_ENTROPY_THRESHOLD = 3.2;
const DENSE_TOKEN_MIN_LENGTH = 24;
const NO_CONTEXT_MIN_LENGTH = 32;

function shannonEntropy(str) {
  if (!str || str.length === 0) return 0;
  const freq = {};
  for (const char of str) freq[char] = (freq[char] || 0) + 1;
  let entropy = 0;
  const len = str.length;
  for (const count of Object.values(freq)) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const FALSE_POSITIVE_PATTERNS = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  // Note: hex-only strings are NOT suppressed globally — they could be API keys.
  // Lock files and known hash files are skipped via SKIP_FILES instead.
  /^data:image\//,
  /\$\{|\{\{|\}\}/,
  /^(?:Usage:|Run:|Status:|Score:)/i,
  /^(?:BUILD|AUDIT|CONTEXT|CARRY-FORWARD|CHECKPOINT|PIPELINE|COMPLETE|CLAIM)[ _-]?GATE/i,
  /^[a-z][a-z0-9+.-]*:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::|\/|$)/i,
  /^[a-z][-a-z0-9_\s]+$/,
  /^(https?:\/\/|\/\/|\.\/|\.\.\/)/,
  /^\d+\.\d+\.\d+/,
  /^[\^~>=<]+\d/,
  /^[a-z]+\.[a-z]+\.[a-z]+$/,
  /^[/\\]?[\w-]+([/\\][\w-]+)+/,
  /^(.)\1{7,}$/,
  /lorem\s+ipsum/i,
  /^test|^mock|^fake|^dummy|^sample|^example/i,
  /(?:mock|fake|dummy|sample|example|placeholder|replace[_-]?me|your[_-])/i,
  /registry\.npmjs\.org/,
];

function isFalsePositive(str) {
  return FALSE_POSITIVE_PATTERNS.some((p) => p.test(str));
}

const SECRET_KEY_PATTERNS = [
  /(?:^|[_-])(?:api|access|private|public|client|webhook|signing|encryption|secret|session|refresh|auth|bearer|jwt)[_-]?(?:key|token|secret|password|credential|signature)$/i,
  /^(?:api[_-]?key|apikey|token|auth[_-]?token|bearer[_-]?token|access[_-]?token|refresh[_-]?token)$/i,
  /^(?:password|passwd|pwd|secret|secret[_-]?key|jwt[_-]?secret|client[_-]?secret|webhook[_-]?secret)$/i,
  /^(?:database[_-]?url|connection[_-]?string|mongo[_-]?uri|redis[_-]?url)$/i,
  /(?:^|[_-])(?:password|passwd|pwd|secret|credential)(?:$|[_-])/i,
];

const SECRET_VALUE_PREFIXES = [
  /^AKIA[0-9A-Z]{16}$/,
  /^ASIA[0-9A-Z]{16}$/,
  /^gh[pousr]_[A-Za-z0-9_]{20,}$/,
  /^github_pat_[A-Za-z0-9_]{20,}$/,
  /^sk_(?:live|test)_[A-Za-z0-9]{20,}$/,
  /^pk_(?:live|test)_[A-Za-z0-9]{20,}$/,
  /^sk-ant-[A-Za-z0-9_-]{20,}$/,
  /^xox[baprs]-[A-Za-z0-9-]{20,}$/,
  /^SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/,
];

function normalizeIdentifier(identifier) {
  return String(identifier || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .toLowerCase();
}

function isSecretContextKey(key) {
  if (!key) return false;
  const normalized = normalizeIdentifier(key);
  if (
    /(?:token|secret).*(?:budget|count|limit|usage|window|optimizer|saving|saved|ratio|threshold)/i.test(normalized)
  ) {
    return false;
  }
  if (/(?:secret|token).*(?:result|pattern|scanner|scan|gate|context|message|finding|detected)/i.test(normalized)) {
    return false;
  }
  return SECRET_KEY_PATTERNS.some((p) => p.test(normalized));
}

function extractContextKey(line, value) {
  if (!line || !value) return null;
  const valueIndex = line.indexOf(value);
  if (valueIndex < 0) return null;
  const before = line.slice(0, valueIndex);
  const assignment = before.match(
    /(?:const|let|var|export\s+const|export\s+let|export\s+var)?\s*["']?([A-Za-z_][\w.-]*)["']?\s*(?::|=)\s*["'`]?$/,
  );
  if (assignment) return assignment[1].split('.').pop();
  const envAssignment = before.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*["']?$/);
  if (envAssignment) return envAssignment[1];
  return null;
}

function isCommentLine(line) {
  const trimmed = String(line || '').trim();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('<!--') ||
    trimmed.startsWith('--')
  );
}

function hasProviderPrefix(value) {
  return SECRET_VALUE_PREFIXES.some((p) => p.test(value));
}

function isJwt(value) {
  return /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(value);
}

function isCredentialedConnectionString(value) {
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@[^/\s]+/i.test(value)) return false;
  return !/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(value);
}

function charClassCount(value) {
  let count = 0;
  if (/[a-z]/.test(value)) count++;
  if (/[A-Z]/.test(value)) count++;
  if (/\d/.test(value)) count++;
  if (/[^A-Za-z0-9]/.test(value)) count++;
  return count;
}

function tokenAlphabetRatio(value) {
  if (!value) return 0;
  const tokenChars = value.match(/[A-Za-z0-9._~+/=-]/g) || [];
  return tokenChars.length / value.length;
}

function isHexToken(value) {
  return /^[a-f0-9]{32,}$/i.test(value) && /[a-f]/i.test(value) && /\d/.test(value);
}

function isDenseToken(value) {
  if (value.length < DENSE_TOKEN_MIN_LENGTH) return false;
  if (/\s/.test(value)) return false;
  if (/[|<>`]/.test(value)) return false;
  if (/[{}]/.test(value)) return false;
  return tokenAlphabetRatio(value) >= 0.88 && charClassCount(value) >= 2;
}

function isContextualPasswordShape(value) {
  if (value.length < MIN_STRING_LENGTH || /\s/.test(value)) return false;
  if (/[`{}<>|]/.test(value)) return false;
  return charClassCount(value) >= 3;
}

function assessCandidate(str, lineContent, threshold) {
  let value = String(str.value || '').trim();
  if (value.length < MIN_STRING_LENGTH || value.length > MAX_STRING_LENGTH) return null;
  if (isCommentLine(lineContent)) return null;
  let embeddedKey = null;
  const embeddedAssignment = value.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
  if (embeddedAssignment) {
    embeddedKey = embeddedAssignment[1];
    value = embeddedAssignment[2].trim().replace(/^["']|["']$/g, '');
  }
  if (value.length < MIN_STRING_LENGTH || value.length > MAX_STRING_LENGTH) return null;
  if (isFalsePositive(value)) return null;

  const entropy = shannonEntropy(value);
  const contextKey = str.key || embeddedKey || extractContextKey(lineContent, value);
  const secretContext = isSecretContextKey(contextKey);
  const providerPrefix = hasProviderPrefix(value);
  const jwt = isJwt(value);
  const connectionString = isCredentialedConnectionString(value);
  const hexToken = isHexToken(value);
  const denseToken = isDenseToken(value);
  const contextualPassword = isContextualPasswordShape(value);

  if (providerPrefix || jwt || connectionString) {
    return {
      entropy,
      severity: 'high',
      contextKey,
      value,
      reason: providerPrefix ? 'Provider token prefix' : jwt ? 'JWT-shaped token' : 'Credentialed connection string',
    };
  }

  if (secretContext) {
    const contextualThreshold = hexToken
      ? HEX_CONTEXTUAL_ENTROPY_THRESHOLD
      : Math.min(threshold, CONTEXTUAL_ENTROPY_THRESHOLD);
    if ((denseToken || hexToken || contextualPassword) && entropy >= contextualThreshold) {
      return {
        entropy,
        severity: 'high',
        contextKey,
        value,
        reason: 'Secret-like assignment context',
      };
    }
    return null;
  }

  if (
    denseToken &&
    value.length >= NO_CONTEXT_MIN_LENGTH &&
    entropy >= Math.max(threshold, NO_CONTEXT_ENTROPY_THRESHOLD)
  ) {
    return {
      entropy,
      severity: 'medium',
      contextKey,
      value,
      reason: 'High-entropy token-shaped literal',
    };
  }

  return null;
}

function extractStrings(content) {
  const strings = [];
  const patterns = [/["']([^"'\n]{16,256})["']/g, /`([^`\n]{16,256})`/g];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(content)) !== null) {
      const value = m[1];
      if (value.length >= MIN_STRING_LENGTH && value.length <= MAX_STRING_LENGTH) {
        const lineNum = (content.substring(0, m.index).match(/\n/g) || []).length + 1;
        strings.push({ value, line: lineNum });
      }
    }
  }
  const envPat = /^([A-Z_][A-Z0-9_]*)\s*=\s*["']?([^"'\n\s]{16,256})["']?/gm;
  let m;
  while ((m = envPat.exec(content)) !== null) {
    if (m[2].length >= MIN_STRING_LENGTH && m[2].length <= MAX_STRING_LENGTH) {
      const lineNum = (content.substring(0, m.index).match(/\n/g) || []).length + 1;
      strings.push({ value: m[2], line: lineNum, key: m[1] });
    }
  }
  return strings;
}

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
    if (entry.isDirectory()) walkFiles(fullPath, collected);
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !SKIP_FILES.has(entry.name)) collected.push(fullPath);
  }
  return collected;
}

function scan(projectDir, options = {}) {
  const scanDir = options.dir ? path.resolve(projectDir, options.dir) : projectDir;
  const threshold = options.threshold || DEFAULT_ENTROPY_THRESHOLD;
  const files = walkFiles(scanDir);
  const findings = [];
  let suppressed = 0;

  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const relFile = path.relative(projectDir, file);
    const strings = extractStrings(content);
    const lines = content.split('\n');
    const seenInFile = new Set();

    for (const str of strings) {
      const dedupeKey = `${str.line}:${str.key || ''}:${str.value}`;
      if (seenInFile.has(dedupeKey)) continue;
      seenInFile.add(dedupeKey);
      const lineContent = lines[str.line - 1] || '';
      const assessment = assessCandidate(str, lineContent, threshold);
      if (!assessment) {
        suppressed++;
        continue;
      }
      const entropy = assessment.entropy;
      const findingValue = assessment.value || str.value;
      findings.push({
        id: `ENT-${String(findings.length + 1).padStart(3, '0')}`,
        type: 'high-entropy-string',
        severity: assessment.severity,
        file: relFile,
        line: str.line,
        entropy: Math.round(entropy * 100) / 100,
        length: findingValue.length,
        contextKey: assessment.contextKey || null,
        contextHint: assessment.reason,
        preview: `${findingValue.substring(0, 8)}...${findingValue.substring(findingValue.length - 4)}`,
        message: `High-entropy string (${entropy.toFixed(2)} bits/char) — potential hardcoded secret`,
        suggestion: 'Move to environment variable or secrets manager.',
      });
    }
  }

  // Cross-reference with .env
  const envFile = path.join(projectDir, '.env');
  const envVars = new Set();
  if (fs.existsSync(envFile)) {
    try {
      for (const l of fs.readFileSync(envFile, 'utf8').split('\n')) {
        const m = l.match(/^([A-Z_][A-Z0-9_]*)\s*=/);
        if (m) envVars.add(m[1]);
      }
    } catch {}
  }
  for (const f of findings) {
    if (f.contextKey && envVars.has(f.contextKey)) {
      f.message += ' (also defined in .env)';
      f.severity = 'high';
    }
  }

  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  const penalties = { high: 18, medium: 8, low: 2 };
  const score = Math.max(0, 100 - findings.reduce((s, f) => s + (penalties[f.severity] || 0), 0));

  return {
    findings,
    summary: {
      total: findings.length,
      bySeverity,
      filesScanned: files.length,
      entropyThreshold: threshold,
      suppressedCandidates: suppressed,
    },
    score,
    verdict: score >= 90 ? 'PASS' : score >= 75 ? 'WATCH' : 'FAIL',
    timestamp: new Date().toISOString(),
  };
}

function writeReport(projectDir, result) {
  const _p = typeof _paths === 'function' ? _paths(projectDir) : null;
  const outDir = _p ? _p.review() : path.join(projectDir, '_cobolt-output/latest/review');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const dest = path.join(outDir, 'entropy-scan-report.json');
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, dest);
  return dest;
}

module.exports = {
  scan,
  writeReport,
  shannonEntropy,
  extractStrings,
  assessCandidate,
  isSecretContextKey,
  extractContextKey,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === 'scan') {
    const options = {};
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--dir' && args[i + 1]) options.dir = args[++i];
      else if (args[i] === '--threshold' && args[i + 1]) options.threshold = parseFloat(args[++i]);
      else if (args[i] === '--json') options.json = true;
      else if (args[i] === '--save') options.save = true;
    }
    const result = scan(process.cwd(), options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\n  CoBolt Secret Entropy Scanner — ${result.summary.filesScanned} files`);
      console.log('  ══════════════════════════════════════════════');
      console.log(
        `  Threshold: ${result.summary.entropyThreshold} bits/char | High: ${result.summary.bySeverity.high || 0} | Medium: ${result.summary.bySeverity.medium || 0} | Low: ${result.summary.bySeverity.low || 0} | Suppressed: ${result.summary.suppressedCandidates || 0}`,
      );
      console.log(`  Score: ${result.score}% — ${result.verdict}`);
      console.log('  ══════════════════════════════════════════════');
      for (const f of result.findings.slice(0, 15)) {
        console.log(
          `  ${f.severity === 'high' ? '\u2717' : '\u26A0'} ${f.file}:${f.line} entropy=${f.entropy} — ${f.preview}`,
        );
      }
    }
    if (options.save) {
      const dest = writeReport(process.cwd(), result);
      if (!options.json) console.log(`\n  Report saved: ${dest}`);
    }
    process.exit(result.findings.some((f) => f.severity === 'high') ? 1 : 0);
  } else {
    console.log(
      '  Usage: node tools/cobolt-secret-entropy-scanner.js scan [--dir src/] [--threshold 4.5] [--json] [--save]',
    );
  }
}
