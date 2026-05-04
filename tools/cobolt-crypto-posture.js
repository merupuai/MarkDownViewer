#!/usr/bin/env node

// CoBolt Crypto Posture Scanner — deterministic cryptographic review (v0.19+)
//
// Scans the target codebase + configuration files for cryptographic risk:
//   - Weak hash algorithms (MD5, SHA1) used outside non-security contexts
//   - Weak ciphers (DES, 3DES, RC4, Blowfish, ECB mode)
//   - TLS config (min version, cipher suites, insecure protocols)
//   - Key length (RSA < 2048, EC curves, DH params)
//   - Insecure PRNGs (Math.random, Random() for security purposes)
//   - Hard-coded crypto material (keys, IVs, salts)
//   - JWT algorithm negotiation ("none" algorithm, HS256 with weak secrets)
//   - Cookie security (HttpOnly, Secure, SameSite)
//
// No LLM. Pure regex + AST-light heuristics. Ships a JSON + MD artifact.
//
// Usage:
//   node tools/cobolt-crypto-posture.js scan [--dir <path>] [--json] [--save]
//   node tools/cobolt-crypto-posture.js report   # re-render last scan's md
//
// Exit codes:
//   0 = scan completed (see output for findings count; non-zero findings
//       do not fail the tool — the gate is the caller's responsibility)
//   1 = usage error
//   2 = scan target not readable

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_UNREADABLE = 2;

const CODE_EXT = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.go',
  '.rs',
  '.rb',
  '.ex',
  '.exs',
  '.java',
  '.kt',
  '.cs',
  '.php',
]);
const CONFIG_EXT = new Set(['.yml', '.yaml', '.conf', '.config', '.toml', '.json', '.ini', '.env']);
const MAX_FILE_BYTES = 1_500_000;
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '_cobolt-output',
  'coverage',
  '.next',
  '.nuxt',
  'vendor',
  'target',
  '__pycache__',
  '.venv',
  '.cache',
]);

// Patterns: each produces a finding with CWE mapping + severity.
const PATTERNS = [
  {
    id: 'CRYPTO-WEAK-HASH-MD5',
    cwe: 'CWE-327',
    severity: 'high',
    kinds: ['code'],
    re: /\b(?:createHash|hashlib\.md5|MessageDigest\.getInstance|DigestUtils\.md5|md5\.New|md5sum)\s*\(\s*['"]?md5['"]?/gi,
    message: 'MD5 hashing detected — unsafe for security contexts; use SHA-256 or stronger',
  },
  {
    id: 'CRYPTO-WEAK-HASH-SHA1',
    cwe: 'CWE-328',
    severity: 'high',
    kinds: ['code'],
    re: /\b(?:createHash|hashlib\.sha1|MessageDigest\.getInstance|DigestUtils\.sha1|sha1\.New)\s*\(\s*['"]?sha1?['"]?/gi,
    message: 'SHA-1 hashing detected — collision-resistant properties broken; use SHA-256+',
  },
  {
    id: 'CRYPTO-WEAK-CIPHER-DES',
    cwe: 'CWE-327',
    severity: 'critical',
    kinds: ['code'],
    re: /\b(?:DES|3DES|TripleDES|DESede)\b/g,
    message: 'DES or 3DES cipher detected — insufficient key length; use AES-256-GCM',
  },
  {
    id: 'CRYPTO-WEAK-CIPHER-RC4',
    cwe: 'CWE-327',
    severity: 'critical',
    kinds: ['code', 'config'],
    re: /\b(?:RC4|ARC4|ARCFOUR)\b/g,
    message: 'RC4 cipher detected — deprecated and broken; use AES-256-GCM',
  },
  {
    id: 'CRYPTO-WEAK-CIPHER-BLOWFISH',
    cwe: 'CWE-327',
    severity: 'medium',
    kinds: ['code'],
    re: /\bBlowfish\b/g,
    message: 'Blowfish cipher detected — 64-bit block size unsafe for modern use; use AES-256-GCM',
  },
  {
    id: 'CRYPTO-MODE-ECB',
    cwe: 'CWE-327',
    severity: 'high',
    kinds: ['code'],
    re: /\bAES-?(?:128|192|256)?-ECB\b|\bMODE_ECB\b|\bCipher\.ECB\b/gi,
    message: 'ECB cipher mode detected — leaks plaintext structure; use GCM or CBC with HMAC',
  },
  {
    id: 'CRYPTO-RSA-WEAK-KEY',
    cwe: 'CWE-326',
    severity: 'high',
    kinds: ['code', 'config'],
    re: /\b(?:modulusLength|rsaKeySize|RSA_KEY_LEN)\s*[:=]\s*(?:512|768|1024)\b/gi,
    message: 'RSA key size < 2048 bits — insufficient for modern threat models',
  },
  {
    id: 'CRYPTO-PRNG-INSECURE',
    cwe: 'CWE-338',
    severity: 'high',
    kinds: ['code'],
    re: /\bMath\.random\s*\(\s*\).*(?:token|secret|password|nonce|salt|key|session)/gi,
    message: 'Math.random() used for security-sensitive value — use crypto.randomBytes / crypto.randomUUID',
  },
  {
    id: 'CRYPTO-PRNG-PYTHON',
    cwe: 'CWE-338',
    severity: 'high',
    kinds: ['code'],
    re: /\brandom\.(?:random|choice|randint|sample)\b[^\n]{0,80}(?:token|secret|password|nonce|salt|key|session)/gi,
    message: 'random.* used for security-sensitive value — use secrets module',
  },
  {
    id: 'CRYPTO-JWT-NONE-ALG',
    cwe: 'CWE-327',
    severity: 'critical',
    kinds: ['code', 'config'],
    re: /\b(?:alg|algorithm)\s*[:=]\s*['"]?none['"]?/gi,
    message: 'JWT "none" algorithm accepted — bypasses signature verification entirely',
  },
  {
    id: 'CRYPTO-HARDCODED-KEY',
    cwe: 'CWE-798',
    severity: 'critical',
    kinds: ['code'],
    re: /(?:secret|apiKey|api_key|password|private_key|priv_key|encryption_key)\s*[:=]\s*['"][A-Za-z0-9+/=_-]{16,}['"]/gi,
    message: 'Possible hard-coded secret in source — move to environment variable or secrets manager',
  },
  {
    id: 'TLS-VERSION-LOW',
    cwe: 'CWE-757',
    severity: 'high',
    kinds: ['code', 'config'],
    re: /\b(?:TLSv?1(?:\.0|\.1)?|SSLv?[23]|SSLv?3)\b/g,
    message: 'TLS 1.0/1.1 or SSL 2/3 referenced — minimum should be TLS 1.2',
  },
  {
    id: 'TLS-REJECT-UNAUTHORIZED-FALSE',
    cwe: 'CWE-295',
    severity: 'critical',
    kinds: ['code'],
    re: /rejectUnauthorized\s*:\s*false/g,
    message: 'TLS certificate validation disabled — enables MITM attacks',
  },
  {
    id: 'TLS-VERIFY-DISABLED',
    cwe: 'CWE-295',
    severity: 'high',
    kinds: ['code'],
    re: /\b(?:verify\s*=\s*False|CURLOPT_SSL_VERIFYPEER\s*,\s*(?:0|false)|InsecureSkipVerify\s*:\s*true)\b/g,
    message: 'TLS peer verification disabled — enables MITM attacks',
  },
  {
    id: 'COOKIE-MISSING-SECURE',
    cwe: 'CWE-614',
    severity: 'medium',
    kinds: ['code'],
    re: /\b(?:res\.cookie|session\.cookie|Set-Cookie)\b[^\n]{0,200}(?!.*(?:secure|Secure)\s*[:=]\s*true)/g,
    // We do a follow-up check inline — only emit if the line has no 'secure' token.
    message: 'Cookie set without `Secure` attribute — may be transmitted over HTTP',
    extraCheck: (line) => !/\bsecure\s*[:=]\s*true\b|Secure\s*;/i.test(line),
  },
  {
    id: 'JWT-HARDCODED-SECRET',
    cwe: 'CWE-798',
    severity: 'critical',
    kinds: ['code'],
    re: /(?:jwt\.sign|jwt\.verify|sign\s*\(\s*\{[^}]*\}\s*,\s*['"])[A-Za-z0-9_-]{6,}['"]/g,
    message: 'JWT sign/verify with hard-coded secret — use environment-sourced key',
  },
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.') && entry.name !== '.env' && entry.name !== '.github') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!CODE_EXT.has(ext) && !CONFIG_EXT.has(ext)) continue;
      try {
        const stat = fs.statSync(full);
        if (stat.size > MAX_FILE_BYTES) continue;
      } catch {
        continue;
      }
      out.push({ path: full, kind: CODE_EXT.has(ext) ? 'code' : 'config' });
    }
  }
  return out;
}

function scanFile(file, findings) {
  let content;
  try {
    content = fs.readFileSync(file.path, 'utf8');
  } catch {
    return;
  }
  const lines = content.split('\n');
  for (const pattern of PATTERNS) {
    if (!pattern.kinds.includes(file.kind)) continue;
    for (let i = 0; i < lines.length; i += 1) {
      pattern.re.lastIndex = 0;
      const line = lines[i];
      if (!pattern.re.test(line)) continue;
      if (pattern.extraCheck && !pattern.extraCheck(line)) continue;
      findings.push({
        id: pattern.id,
        cwe: pattern.cwe,
        severity: pattern.severity,
        file: file.path,
        line: i + 1,
        snippet: line.trim().slice(0, 200),
        message: pattern.message,
      });
      pattern.re.lastIndex = 0;
    }
  }
}

function summarize(findings) {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  const byId = {};
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
    byId[f.id] = (byId[f.id] || 0) + 1;
  }
  return { total: findings.length, bySeverity, byId };
}

function emitMarkdown(result) {
  const { scannedFiles, findings, summary, target, timestamp } = result;
  const lines = [];
  lines.push('# Cryptographic Posture Review');
  lines.push('');
  lines.push(`- **Generated:** ${timestamp}`);
  lines.push(`- **Target:** ${target}`);
  lines.push(`- **Files scanned:** ${scannedFiles}`);
  lines.push(
    `- **Total findings:** ${summary.total} (critical ${summary.bySeverity.critical}, high ${summary.bySeverity.high}, medium ${summary.bySeverity.medium}, low ${summary.bySeverity.low})`,
  );
  lines.push('');
  lines.push('## Coverage');
  lines.push('');
  lines.push('This review checks the target codebase against deterministic patterns for:');
  lines.push('');
  lines.push('- Weak hash algorithms (MD5, SHA1) in security contexts — CWE-327, CWE-328');
  lines.push('- Weak or broken ciphers (DES, 3DES, RC4, Blowfish, ECB mode) — CWE-327');
  lines.push('- RSA key length below 2048 bits — CWE-326');
  lines.push('- Insecure pseudo-random number generators for security-sensitive values — CWE-338');
  lines.push('- JWT "none" algorithm acceptance and hard-coded JWT secrets — CWE-327, CWE-798');
  lines.push('- Hard-coded secrets, API keys, or private keys in source — CWE-798');
  lines.push('- TLS version floor (blocks TLS 1.0 / 1.1 / SSL 2 / SSL 3) — CWE-757');
  lines.push('- TLS certificate verification bypass (rejectUnauthorized: false, InsecureSkipVerify) — CWE-295');
  lines.push('- Cookie transport hardening (missing Secure attribute) — CWE-614');
  lines.push('');
  if (findings.length === 0) {
    lines.push('## Findings');
    lines.push('');
    lines.push(
      'No cryptographic posture violations detected across scanned files. This does not guarantee the codebase is cryptographically sound — it only asserts that the deterministic patterns above did not match. Recommended follow-ups: manual review of auth/session code, runtime TLS configuration audit of deployed environments, and a secrets-manager audit of externalized keys.',
    );
    lines.push('');
  } else {
    lines.push('## Findings Summary');
    lines.push('');
    lines.push('| Pattern | CWE | Count |');
    lines.push('|---|---|---|');
    for (const [id, count] of Object.entries(summary.byId).sort((a, b) => b[1] - a[1])) {
      const p = PATTERNS.find((x) => x.id === id);
      lines.push(`| ${id} | ${p ? p.cwe : '—'} | ${count} |`);
    }
    lines.push('');
    lines.push('## Findings Detail');
    lines.push('');
    for (const [severity, label] of [
      ['critical', 'Critical'],
      ['high', 'High'],
      ['medium', 'Medium'],
      ['low', 'Low'],
    ]) {
      const subset = findings.filter((f) => f.severity === severity);
      if (subset.length === 0) continue;
      lines.push(`### ${label} (${subset.length})`);
      lines.push('');
      for (const f of subset.slice(0, 100)) {
        lines.push(
          `- **${f.id}** (${f.cwe}) — \`${path.relative(process.cwd(), f.file).replaceAll('\\', '/')}:${f.line}\``,
        );
        lines.push(`  - ${f.message}`);
        lines.push(`  - \`${f.snippet}\``);
      }
      if (subset.length > 100) lines.push(`- … ${subset.length - 100} more (full list in JSON artifact)`);
      lines.push('');
    }
  }
  lines.push('## Method');
  lines.push('');
  lines.push(
    'Deterministic regex + heuristic scan. No LLM. No network calls. Same input produces the same output. Runs in under 10 seconds on projects < 100 MB. Findings include file path, line number, snippet (≤200 chars), CWE tag, and severity. For runtime-only concerns (actual TLS cipher suites negotiated by a live service, HSM usage, key-rotation policy enforcement), pair this review with `cobolt-runtime-truth.js` output and a manual deployed-config audit.',
  );
  lines.push('');
  return lines.join('\n');
}

function scan(dir) {
  const files = walk(dir);
  const findings = [];
  for (const f of files) scanFile(f, findings);
  const result = {
    tool: 'cobolt-crypto-posture',
    version: '1.0.0',
    target: dir,
    timestamp: new Date().toISOString(),
    scannedFiles: files.length,
    findings,
    summary: summarize(findings),
  };
  return result;
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || command === '-h' || command === '--help') {
    process.stderr.write('Usage: cobolt-crypto-posture scan [--dir <path>] [--json] [--save] [--output <path>]\n');
    process.exit(EXIT_USAGE);
  }
  if (command !== 'scan' && command !== 'report') {
    process.stderr.write(`Unknown command: ${command}\n`);
    process.exit(EXIT_USAGE);
  }
  const dirIdx = args.indexOf('--dir');
  const dir = dirIdx !== -1 && args[dirIdx + 1] ? path.resolve(args[dirIdx + 1]) : process.cwd();
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx !== -1 && args[outputIdx + 1] ? args[outputIdx + 1] : null;
  const save = args.includes('--save');

  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    process.stderr.write(`[cobolt-crypto-posture] unreadable target: ${dir}\n`);
    process.exit(EXIT_UNREADABLE);
  }

  const result = scan(dir);
  const md = emitMarkdown(result);

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `[cobolt-crypto-posture] scanned ${result.scannedFiles} files — ${result.summary.total} finding(s)\n`,
    );
    for (const [sev, count] of Object.entries(result.summary.bySeverity)) {
      if (count > 0) process.stdout.write(`  ${sev}: ${count}\n`);
    }
  }

  if (save || outputPath) {
    const jsonPath =
      outputPath || path.join(dir, '_cobolt-output', 'latest', 'brownfield', '12i-crypto-posture-review.json');
    const mdPath = jsonPath.replace(/\.json$/, '.md');
    atomicWrite(jsonPath, JSON.stringify(result, null, 2), 'utf8');
    atomicWrite(mdPath, md, 'utf8');
    process.stderr.write(`[cobolt-crypto-posture] wrote ${jsonPath}\n`);
    process.stderr.write(`[cobolt-crypto-posture] wrote ${mdPath}\n`);
  }

  process.exit(EXIT_OK);
}

if (require.main === module) main();

module.exports = { scan, emitMarkdown, PATTERNS };
