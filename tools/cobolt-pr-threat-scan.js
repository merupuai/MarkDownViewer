#!/usr/bin/env node

// CoBolt PR Threat Scanner — Deterministic diff-level threat detection
//
// Scans PR diffs for 75+ threat patterns across 8 categories.
// Pure regex — no LLM, no ML, no network calls. Same input = same output.
//
// Usage:
//   node tools/cobolt-pr-threat-scan.js --pr 42 --repo owner/repo   # Scan GitHub PR
//   node tools/cobolt-pr-threat-scan.js --diff patch.diff            # Scan diff file
//   node tools/cobolt-pr-threat-scan.js --stdin < diff.patch         # Scan from stdin
//   node tools/cobolt-pr-threat-scan.js --path src/                  # Scan directory files
//   node tools/cobolt-pr-threat-scan.js --format json|markdown       # Output format
//   node tools/cobolt-pr-threat-scan.js --severity HIGH              # Min severity filter
//
// Exit codes:
//   0 = PASS  (no CRITICAL or HIGH findings)
//   1 = REVIEW (HIGH findings — needs human review)
//   2 = BLOCK  (CRITICAL findings — PR must be blocked)

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// ═══════════════════════════════════════════════════════════════
// IGNORE MANIFEST — files we MUST NOT scan
// ═══════════════════════════════════════════════════════════════
//
// Closes the ~88% phantom-finding class observed during brownfield --scan full
// runs: zero-width hits in compiled .exe/.dll, font glyph data, minified
// bundles, and sub-worktree build outputs are useless signals. The PR-diff
// mode keeps these armed when a diff explicitly modifies them — the manifest
// is only applied in directory/path scan mode where every file is a candidate.
//
// Two layers:
//   (1) DEFAULT_IGNORE_DIRS — pruned during recursion (saves IO).
//   (2) DEFAULT_IGNORE_EXTENSIONS / DEFAULT_IGNORE_FILE_PATTERNS — applied
//       per-file before pattern scanning (handles edge cases where a binary
//       sits outside the standard build directories).

const DEFAULT_IGNORE_DIRS = Object.freeze([
  'node_modules',
  '.git',
  '_cobolt-output',
  'vendor',
  '__pycache__',
  '.next',
  '.nuxt',
  '.worktrees',
  '.cache',
  'build',
  'dist',
  'out',
  'target',
  'obj',
  'coverage',
  '.venv',
  'venv',
]);

const DEFAULT_IGNORE_EXTENSIONS = new Set([
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.dat',
  '.o',
  '.obj',
  '.a',
  '.lib',
  '.class',
  '.jar',
  '.war',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.bmp',
  '.webp',
  '.svg',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.7z',
  '.rar',
  '.pdf',
  '.docx',
  '.xlsx',
  '.pptx',
  '.mp3',
  '.mp4',
  '.webm',
  '.mov',
  '.wav',
  '.flac',
  '.db',
  '.sqlite',
  '.sqlite3',
  '.mdb',
  '.wasm',
]);

const DEFAULT_IGNORE_FILE_PATTERNS = Object.freeze([
  /\.min\.(?:js|css|mjs|cjs)$/i,
  /\.bundle\.(?:js|css|mjs|cjs)$/i,
  /\.map$/,
]);

// CoBolt's own scaffolding — written by /cobolt-init, not a threat surface
// when scanning a project tree. Still flagged in PR-diff mode where a diff
// could be poisoning a fresh init. Override per-mode via the scanner option
// `excludeCoboltScaffold` (true for directory scans, false for PR diffs).

const COBOLT_SCAFFOLD_PATH_PATTERNS = Object.freeze([
  /(?:^|\/)\.claude\/settings\.json$/,
  /(?:^|\/)\.claude\/settings\.local\.json$/,
  /(?:^|\/)\.env\.cobolt$/,
  /(?:^|\/)cobolt-state\.json$/,
]);

const COBOLT_SYSTEM_THREAT_IDS = new Set(['CS-001', 'CS-002', 'CS-003', 'CS-004', 'CS-005', 'CS-006']);

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/');
}

function isIgnoredPath(filePath, options = {}) {
  const norm = normalizePath(filePath);
  if (!norm) return true;

  for (const dir of DEFAULT_IGNORE_DIRS) {
    if (norm.startsWith(`${dir}/`) || norm.includes(`/${dir}/`)) return true;
  }
  const ext = path.extname(norm).toLowerCase();
  if (ext && DEFAULT_IGNORE_EXTENSIONS.has(ext)) return true;
  for (const re of DEFAULT_IGNORE_FILE_PATTERNS) {
    if (re.test(norm)) return true;
  }
  if (options.excludeCoboltScaffold) {
    for (const re of COBOLT_SCAFFOLD_PATH_PATTERNS) {
      if (re.test(norm)) return true;
    }
  }
  return false;
}

// Comment-prefixed lines in env templates document connection strings that
// would otherwise match SE-005 (postgres://user:pass@host) — but the file is
// a template, not a leaked secret. Suppress secret-pattern matches on lines
// that are clearly env/shell comments.
function isCommentLine(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;
  return trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith(';');
}

const SECRET_CATEGORY = 'secrets-exposure';

// ═══════════════════════════════════════════════════════════════
// THREAT PATTERN DATABASE — 8 categories, 75+ signatures
// ═══════════════════════════════════════════════════════════════

const THREAT_PATTERNS = [
  // ── PI: Prompt Injection (CRITICAL) ─────────────────────────
  // Attempts to manipulate LLM reviewer agents via embedded instructions
  {
    id: 'PI-001',
    category: 'prompt-injection',
    severity: 'CRITICAL',
    target: 'content',
    name: 'Direct instruction override',
    pattern:
      /ignore\s+(all\s+)?(previous|prior|above|earlier|system|original)\s+(instructions?|rules?|guidelines?|prompts?|context)/i,
  },
  {
    id: 'PI-002',
    category: 'prompt-injection',
    severity: 'CRITICAL',
    target: 'content',
    name: 'Instruction disregard',
    pattern:
      /disregard\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?|guidelines?|prompts?|directions?)/i,
  },
  {
    id: 'PI-003',
    category: 'prompt-injection',
    severity: 'CRITICAL',
    target: 'content',
    name: 'Instruction forget/reset',
    pattern:
      /forget\s+(all\s+)?(your|the|previous|prior|above)\s+(instructions?|rules?|guidelines?|prompts?|context|training)/i,
  },
  {
    id: 'PI-004',
    category: 'prompt-injection',
    severity: 'CRITICAL',
    target: 'content',
    name: 'Role reassignment',
    pattern: /you\s+are\s+now\s+(a|an|the)\s+(helpful|new|different|unrestricted|unfiltered)/i,
  },
  {
    id: 'PI-005',
    category: 'prompt-injection',
    severity: 'CRITICAL',
    target: 'content',
    name: 'System prompt injection delimiter',
    pattern: /(?:<<SYS>>|\[INST\]|\[\/INST\]|\[SYSTEM\]\s*(?:message|prompt|instruction|override))/i,
  },
  {
    id: 'PI-006',
    category: 'prompt-injection',
    severity: 'CRITICAL',
    target: 'content',
    name: 'PR approval manipulation',
    pattern:
      /(?:approve|accept|pass|green[- ]?light)\s+(?:this|the)\s+(?:PR|pull\s*request|merge\s*request|code|change|commit)/i,
  },
  {
    id: 'PI-007',
    category: 'prompt-injection',
    severity: 'CRITICAL',
    target: 'content',
    name: 'Finding suppression',
    pattern:
      /do\s+not\s+(?:report|flag|mention|note|log|raise|create)\s+(?:any\s+)?(?:security|vulnerabilit|issue|finding|problem|concern|warning|error)/i,
  },
  {
    id: 'PI-008',
    category: 'prompt-injection',
    severity: 'CRITICAL',
    target: 'content',
    name: 'Forced merge instruction',
    pattern:
      /(?:must|should|please|immediately)\s+(?:auto[- ]?)?merge|merge\s+(?:this|the)\s+(?:PR|pull\s*request)\s+(?:immediately|now|without\s+review)/i,
  },
  {
    id: 'PI-009',
    category: 'prompt-injection',
    severity: 'CRITICAL',
    target: 'content',
    name: 'Security bypass instruction',
    pattern:
      /(?:override|bypass|disable|skip|ignore)\s+(?:the\s+)?(?:security|review|safety|compliance|governance|quality)\s+(?:check|gate|policy|scan|verification|review)/i,
  },
  {
    id: 'PI-010',
    category: 'prompt-injection',
    severity: 'CRITICAL',
    target: 'content',
    name: 'Urgent instruction to reviewer',
    pattern:
      /(?:IMPORTANT|CRITICAL|URGENT|ATTENTION|NOTE\s+TO\s+(?:REVIEWER|AI|ASSISTANT|BOT|AGENT))\s*[:!]\s*(?:ignore|skip|approve|merge|mark|set|disregard|forget|override|bypass)/i,
  },
  {
    id: 'PI-011',
    category: 'prompt-injection',
    severity: 'HIGH',
    target: 'content',
    name: 'Jailbreak/DAN attempt',
    pattern: /\b(?:jailbreak|DAN\s+mode|developer\s+mode|unrestricted\s+mode|God\s+mode|evil\s+mode)\b/i,
  },
  {
    id: 'PI-012',
    category: 'prompt-injection',
    severity: 'CRITICAL',
    target: 'content',
    name: 'Output control instruction',
    pattern:
      /(?:respond|output|reply|answer|say)\s+(?:only\s+)?(?:with|exactly)\s*[:'"]\s*(?:APPROVED|PASS|LGTM|no\s+issues?|safe|clean|merged)/i,
  },
  {
    id: 'PI-013',
    category: 'prompt-injection',
    severity: 'CRITICAL',
    target: 'content',
    name: 'Persona/role impersonation',
    pattern:
      /(?:pretend|imagine|assume|act\s+as\s+if)\s+(?:you\s+are|to\s+be|you're|this\s+is)\s+(?:a|an|the)\s+(?:admin|system|root|owner|maintainer|approved|senior)/i,
  },
  {
    id: 'PI-014',
    category: 'prompt-injection',
    severity: 'HIGH',
    target: 'content',
    name: 'Testing mode bypass',
    pattern:
      /(?:this\s+is\s+a\s+test|testing\s+mode|debug\s+mode|bypass\s+for\s+testing|test\s+override)\s*[,.:;]?\s*(?:all|every|no|disable|skip)\s*(?:security|check|gate|validation|review)/i,
  },
  {
    id: 'PI-015',
    category: 'prompt-injection',
    severity: 'CRITICAL',
    target: 'content',
    name: 'System prompt override',
    pattern:
      /(?:new|updated?|changed?|replacement|override|inject)\s+(?:system\s+)?(?:prompt|instruction|directive|message|rule)\s*[:=]/i,
  },
  {
    id: 'PI-016',
    category: 'prompt-injection',
    severity: 'CRITICAL',
    target: 'content',
    name: 'CoBolt pipeline manipulation',
    pattern:
      /(?:tell|instruct|force|make)\s+(?:CoBolt|cobolt|the\s+(?:reviewer|scanner|pipeline|agent))\s+(?:to\s+)?(?:approve|merge|skip|pass|ignore|bypass)/i,
  },

  // ── CI: CI/CD Poisoning ─────────────────────────────────────
  {
    id: 'CI-001',
    category: 'ci-cd-poisoning',
    severity: 'HIGH',
    target: 'path',
    name: 'GitHub workflow modification',
    pattern: /\.github\/workflows\//,
  },
  {
    id: 'CI-002',
    category: 'ci-cd-poisoning',
    severity: 'CRITICAL',
    target: 'content',
    name: 'Remote code execution in build',
    pattern: /(?:curl|wget|fetch)\s+.*\|\s*(?:ba)?sh/i,
  },
  {
    id: 'CI-003',
    category: 'ci-cd-poisoning',
    severity: 'HIGH',
    target: 'content',
    name: 'Dockerfile external download',
    pattern: /^\s*(?:ADD|COPY)\s+https?:\/\//i,
  },
  {
    id: 'CI-004',
    category: 'ci-cd-poisoning',
    severity: 'HIGH',
    target: 'content',
    name: 'NPM lifecycle script injection',
    pattern:
      /"(?:preinstall|postinstall|preuninstall|postuninstall|prepare|prepublish)"\s*:\s*".*(?:curl|wget|node\s+-e|exec|spawn|child_process)/i,
  },
  {
    id: 'CI-005',
    category: 'ci-cd-poisoning',
    severity: 'HIGH',
    target: 'path',
    name: 'Git hooks directory modification',
    pattern: /\.(?:githooks|husky)\//,
  },
  {
    id: 'CI-006',
    category: 'ci-cd-poisoning',
    severity: 'CRITICAL',
    target: 'content',
    name: 'Container privilege escalation',
    pattern:
      /--privileged|--cap-add\s+(?:ALL|SYS_ADMIN|SYS_PTRACE)|--net=host|--pid=host|--security-opt\s+(?:apparmor|seccomp)=unconfined/i,
  },
  {
    id: 'CI-007',
    category: 'ci-cd-poisoning',
    severity: 'HIGH',
    target: 'content',
    name: 'Build script external download',
    pattern:
      /^\s*(?:RUN|run)\s+.*(?:curl|wget|fetch)\s+(?:https?:\/\/|ftp:\/\/)\S+.*>|(?:curl|wget)\s+.*-[oO]\s+\S+.*&&.*(?:chmod|bash|sh|\.\/)/i,
  },
  {
    id: 'CI-008',
    category: 'ci-cd-poisoning',
    severity: 'MEDIUM',
    target: 'content',
    name: 'Unpinned GitHub Action',
    pattern: /uses:\s+[\w-]+\/[\w-]+@(?:main|master|HEAD|latest)\b/i,
  },

  // ── SC: Supply Chain Attacks ────────────────────────────────
  {
    id: 'SC-001',
    category: 'supply-chain',
    severity: 'CRITICAL',
    target: 'content',
    name: 'Package registry redirect',
    pattern:
      /registry\s*=\s*(?:https?:\/\/(?!registry\.npmjs\.org|registry\.yarnpkg\.com|pypi\.org|proxy\.golang\.org))\S+/i,
  },
  {
    id: 'SC-003',
    category: 'supply-chain',
    severity: 'HIGH',
    target: 'path',
    name: 'Git submodule modification',
    pattern: /\.gitmodules$/,
  },
  {
    id: 'SC-004',
    category: 'supply-chain',
    severity: 'MEDIUM',
    target: 'content',
    name: 'Suspicious install script',
    pattern:
      /"(?:preinstall|postinstall|prepare)"\s*:\s*"(?!npm|node|tsc|babel|webpack|vite|esbuild|rollup|jest|mocha|eslint|prettier|husky|patch-package|rimraf|mkdirp|cross-env)/i,
  },
  {
    id: 'SC-005',
    category: 'supply-chain',
    severity: 'MEDIUM',
    target: 'content',
    name: 'Version constraint weakening',
    pattern: /"[\w@/-]+"\s*:\s*"\*"/,
  },
  {
    id: 'SC-006',
    category: 'supply-chain',
    severity: 'HIGH',
    target: 'path',
    name: 'Registry config file modification',
    pattern: /\.(?:npmrc|yarnrc|pip\.conf|pypirc)$/,
  },

  // ── MC: Malicious Code ──────────────────────────────────────
  {
    id: 'MC-001',
    category: 'malicious-code',
    severity: 'CRITICAL',
    target: 'content',
    name: 'Reverse shell',
    pattern:
      /(?:\/bin\/(?:ba)?sh\s+-i|nc\s+-[elp]|ncat\s.*-e|python.*socket.*connect|ruby.*TCPSocket|perl.*socket.*INET|bash\s+-c\s+.*\/dev\/tcp)/i,
  },
  {
    id: 'MC-002',
    category: 'malicious-code',
    severity: 'CRITICAL',
    target: 'content',
    name: 'Data exfiltration',
    pattern:
      /(?:fetch|axios|http\.request|https\.request|XMLHttpRequest|curl|wget)\s*\(?\s*['"`]https?:\/\/(?!localhost|127\.0\.0\.|::1|0\.0\.0\.0).*(?:process\.env|\.ssh|\.aws|credentials|password|secret|token|api.?key)/i,
  },
  {
    id: 'MC-003',
    category: 'malicious-code',
    severity: 'HIGH',
    target: 'content',
    name: 'Environment variable harvesting',
    pattern:
      /JSON\.stringify\s*\(\s*process\.env\s*\)|Object\.(?:keys|entries|values)\s*\(\s*process\.env\s*\)|os\.environ\b.*(?:dump|json|str|print|send|post|fetch)/i,
  },
  {
    id: 'MC-004',
    category: 'malicious-code',
    severity: 'CRITICAL',
    target: 'content',
    name: 'Sensitive file access',
    pattern:
      /(?:readFile|readFileSync|open|cat|type)\s*\(?\s*['"`](?:\/etc\/(?:passwd|shadow|hosts)|~\/\.ssh\/|~\/\.aws\/|~\/\.gnupg\/|\/proc\/self|C:\\Windows\\System32|C:\\Users\\.*\\\.ssh)/i,
  },
  {
    id: 'MC-005',
    category: 'malicious-code',
    severity: 'HIGH',
    target: 'content',
    name: 'Cryptocurrency mining',
    pattern: /stratum\+tcp:\/\/|stratum\+ssl:\/\/|xmr(?:ig|stak)|coinhive|cryptonight|monero.*pool|mining.*pool/i,
  },
  {
    id: 'MC-006',
    category: 'malicious-code',
    severity: 'CRITICAL',
    target: 'content',
    name: 'Hardcoded authentication bypass',
    pattern:
      /(?:password|passwd|secret|auth_token)\s*(?:===?|!==?|==)\s*['"`](?:admin|root|master|backdoor|password|letmein|12345|test123)/i,
  },
  {
    id: 'MC-007',
    category: 'malicious-code',
    severity: 'HIGH',
    target: 'content',
    name: 'OS command injection vector',
    pattern:
      /(?:exec|execSync|spawn|spawnSync|execFile|system|popen)\s*\(\s*(?:req\.|request\.|params\.|query\.|body\.|args\.|input\.|user)/i,
  },
  {
    id: 'MC-008',
    category: 'malicious-code',
    severity: 'HIGH',
    target: 'content',
    name: 'Arbitrary system path write',
    pattern:
      /(?:writeFile|writeFileSync|write|fwrite|open\(.*['"]w)\s*\(?\s*['"`](?:\/etc\/|\/usr\/|\/var\/|\/tmp\/|C:\\Windows\\|C:\\Program\s*Files)/i,
  },
  {
    id: 'MC-009',
    category: 'malicious-code',
    severity: 'CRITICAL',
    target: 'content',
    name: 'Destructive system command',
    pattern: /(?:rm\s+-[a-zA-Z]*r[a-zA-Z]*f|rm\s+-[a-zA-Z]*f[a-zA-Z]*r|rmdir\s+\/s|del\s+\/[sfq])\s*[/~\\C]/i,
  },
  {
    id: 'MC-010',
    category: 'malicious-code',
    severity: 'CRITICAL',
    target: 'content',
    name: 'Destructive SQL in code',
    pattern:
      /(?:DROP\s+(?:DATABASE|TABLE|SCHEMA|INDEX|VIEW)|TRUNCATE\s+TABLE|DELETE\s+FROM\s+\w+\s*(?:;|$)|ALTER\s+TABLE\s+\w+\s+DROP)/i,
  },

  // ── SE: Secrets Exposure ────────────────────────────────────
  {
    id: 'SE-001',
    category: 'secrets-exposure',
    severity: 'CRITICAL',
    target: 'content',
    name: 'AWS access key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    id: 'SE-002',
    category: 'secrets-exposure',
    severity: 'CRITICAL',
    target: 'content',
    name: 'GitHub token',
    pattern: /\b(?:ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59})\b/,
  },
  {
    id: 'SE-003',
    category: 'secrets-exposure',
    severity: 'CRITICAL',
    target: 'content',
    name: 'API key pattern',
    pattern: /\b(?:sk-[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9-]{20,}|sk-proj-[A-Za-z0-9]{20,})\b/,
  },
  {
    id: 'SE-004',
    category: 'secrets-exposure',
    severity: 'CRITICAL',
    target: 'content',
    name: 'Private key material',
    pattern: /-----BEGIN\s+(?:RSA\s+)?(?:PRIVATE|EC)\s+KEY-----/,
  },
  {
    id: 'SE-005',
    category: 'secrets-exposure',
    severity: 'CRITICAL',
    target: 'content',
    name: 'Connection string with credentials',
    pattern: /(?:mongodb|postgres|postgresql|mysql|redis|amqp|mssql):\/\/[^:\s]+:[^@\s]+@/i,
  },
  {
    id: 'SE-006',
    category: 'secrets-exposure',
    severity: 'HIGH',
    target: 'content',
    name: 'Hardcoded password assignment',
    pattern:
      /(?:password|passwd|secret|api_?key|access_?key|auth_?token|private_?key)\s*[:=]\s*['"`][A-Za-z0-9+/=!@#$%^&*]{8,}['"`]/i,
  },

  // ── OB: Obfuscation ────────────────────────────────────────
  {
    id: 'OB-001',
    category: 'obfuscation',
    severity: 'HIGH',
    target: 'content',
    name: 'Dynamic code evaluation',
    pattern: /\b(?:eval|Function)\s*\(\s*(?:[a-zA-Z_$]|['"`])/i,
  },
  {
    id: 'OB-002',
    category: 'obfuscation',
    severity: 'HIGH',
    target: 'content',
    name: 'Base64 decode of long payload',
    pattern: /(?:Buffer\.from|atob|base64\.b64decode|Base64\.decode64)\s*\(\s*['"`][A-Za-z0-9+/=]{100,}/,
  },
  {
    id: 'OB-003',
    category: 'obfuscation',
    severity: 'HIGH',
    target: 'content',
    name: 'Hex-encoded executable string',
    pattern: /(?:\\x[0-9a-fA-F]{2}){10,}/,
  },
  {
    id: 'OB-004',
    category: 'obfuscation',
    severity: 'MEDIUM',
    target: 'content',
    name: 'Character code string assembly',
    pattern: /String\.fromCharCode\s*\(\s*(?:\d+\s*,\s*){5,}/,
  },
  {
    id: 'OB-005',
    category: 'obfuscation',
    severity: 'CRITICAL',
    target: 'content',
    name: 'Zero-width/invisible characters',
    pattern: /(?:\u200B|\u200C|\u200D|\uFEFF|\u2060|\u200E|\u200F|\u2028|\u2029|\u00AD)/,
  },
  {
    id: 'OB-006',
    category: 'obfuscation',
    severity: 'HIGH',
    target: 'content',
    name: 'Homoglyph/Cyrillic substitution',
    pattern:
      /[\u0400-\u04FF].*(?:function|class|const|let|var|import|require|def|fn )|(?:function|class|const|let|var|import|require|def|fn ).*[\u0400-\u04FF]/,
  },
  {
    id: 'OB-007',
    category: 'obfuscation',
    severity: 'MEDIUM',
    target: 'content',
    name: 'Unicode escape sequence string',
    pattern: /(?:\\u[0-9a-fA-F]{4}){8,}/,
  },

  // ── GA: Git/Repository Attacks ──────────────────────────────
  {
    id: 'GA-001',
    category: 'git-attacks',
    severity: 'CRITICAL',
    target: 'content',
    name: 'Gitattributes code execution',
    pattern: /^\s*\*?\s+(?:filter|smudge|clean)\s*=\s*\S+/i,
  },
  {
    id: 'GA-002',
    category: 'git-attacks',
    severity: 'CRITICAL',
    target: 'path',
    name: 'Gitattributes file modification',
    pattern: /\.gitattributes$/,
  },
  {
    id: 'GA-003',
    category: 'git-attacks',
    severity: 'HIGH',
    target: 'content',
    name: 'Symlink path traversal',
    pattern: /^\+.*(?:->|symlink)\s*.*\.\.\//,
  },
  {
    id: 'GA-004',
    category: 'git-attacks',
    severity: 'CRITICAL',
    target: 'path',
    name: 'Git internal directory manipulation',
    pattern: /^\.git\//,
  },
  {
    id: 'GA-005',
    category: 'git-attacks',
    severity: 'HIGH',
    target: 'path',
    name: 'IDE config with command execution',
    pattern: /\.vscode\/(?:tasks|launch|settings)\.json$|\.idea\/.*\.xml$/,
  },

  // ── CM: Config Manipulation ─────────────────────────────────
  {
    id: 'CM-001',
    category: 'config-manipulation',
    severity: 'HIGH',
    target: 'content',
    name: 'Suspicious version number',
    pattern: /"version"\s*:\s*"(?:0\.0\.0|999\.\d+\.\d+|\d{3,}\.\d+\.\d+)"/,
  },
  {
    id: 'CM-002',
    category: 'config-manipulation',
    severity: 'MEDIUM',
    target: 'content',
    name: 'CORS allow-all',
    pattern: /(?:Access-Control-Allow-Origin|cors|allowedOrigins?)\s*[:=]\s*['"`]\*['"`]/i,
  },
  {
    id: 'CM-003',
    category: 'config-manipulation',
    severity: 'HIGH',
    target: 'content',
    name: 'CSP disabled or unsafe',
    pattern: /(?:Content-Security-Policy|contentSecurityPolicy)\s*[:=].*(?:unsafe-inline|unsafe-eval|\*|'none')/i,
  },
  {
    id: 'CM-004',
    category: 'config-manipulation',
    severity: 'CRITICAL',
    target: 'content',
    name: 'TLS verification disabled',
    pattern:
      /(?:rejectUnauthorized|verify_ssl|VERIFY_SSL|verify|SSL_VERIFY|NODE_TLS_REJECT_UNAUTHORIZED)\s*[:=]\s*(?:false|0|'0'|"0"|False|FALSE)/i,
  },
  {
    id: 'CM-005',
    category: 'config-manipulation',
    severity: 'HIGH',
    target: 'content',
    name: 'Authentication/authorization disabled',
    pattern:
      /(?:auth(?:entication)?|authorization|requireAuth|authRequired|protect(?:ed)?)\s*[:=]\s*(?:false|disabled|off|none|False|FALSE)/i,
  },
  {
    id: 'CM-006',
    category: 'config-manipulation',
    severity: 'MEDIUM',
    target: 'path',
    name: 'Environment secrets file added',
    pattern: /(?:^|\/)\.(env|env\.local|env\.production|env\.staging)$/,
  },
  {
    id: 'CM-007',
    category: 'config-manipulation',
    severity: 'HIGH',
    target: 'path',
    name: 'License file deletion',
    pattern: /^LICENSE(?:\.md|\.txt)?$/i,
  },
  {
    id: 'CM-008',
    category: 'config-manipulation',
    severity: 'HIGH',
    target: 'content',
    name: 'Logging/audit disabled',
    pattern: /(?:logging|audit(?:ing)?|monitoring)\s*[:=]\s*(?:false|disabled|off|none|False|FALSE)/i,
  },

  // ── CS: CoBolt System Attacks ───────────────────────────────
  {
    id: 'CS-001',
    category: 'cobolt-system',
    severity: 'CRITICAL',
    target: 'path',
    name: 'CoBolt hook modification',
    pattern: /(?:\.claude|\.opencode|\.gemini)\/hooks\//,
  },
  {
    id: 'CS-002',
    category: 'cobolt-system',
    severity: 'CRITICAL',
    target: 'path',
    name: 'CoBolt settings modification',
    pattern: /(?:\.claude|\.opencode|\.gemini)\/settings\.json$/,
  },
  {
    id: 'CS-003',
    category: 'cobolt-system',
    severity: 'CRITICAL',
    target: 'path',
    name: 'CoBolt state manipulation',
    pattern: /cobolt-state\.json$/,
  },
  {
    id: 'CS-004',
    category: 'cobolt-system',
    severity: 'CRITICAL',
    target: 'path',
    name: 'CoBolt evidence/audit tampering',
    pattern: /_cobolt-output\/(?:evidence|audit)\//,
  },
  {
    id: 'CS-005',
    category: 'cobolt-system',
    severity: 'HIGH',
    target: 'path',
    name: 'CoBolt source hook modification',
    pattern: /source\/hooks\//,
  },
  {
    id: 'CS-006',
    category: 'cobolt-system',
    severity: 'HIGH',
    target: 'path',
    name: 'CoBolt agent/skill modification',
    pattern: /source\/(?:agents|skills)\//,
  },
];

// ── Cross-File Checks ─────────────────────────────────────────
// Structural checks that look at the SET of modified files, not individual lines.

const CROSS_FILE_CHECKS = [
  {
    id: 'SC-002',
    category: 'supply-chain',
    severity: 'HIGH',
    name: 'Lock file tampered without package change',
    check(files) {
      const lockFiles = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];
      const pkgFiles = ['package.json'];
      const hasLock = files.some((f) => lockFiles.some((l) => f.endsWith(l)));
      const hasPkg = files.some((f) => pkgFiles.some((p) => f.endsWith(p)));
      return hasLock && !hasPkg;
    },
  },
  {
    id: 'SC-007',
    category: 'supply-chain',
    severity: 'HIGH',
    name: 'Go checksum tampered without module change',
    check(files) {
      const hasSum = files.some((f) => f.endsWith('go.sum'));
      const hasMod = files.some((f) => f.endsWith('go.mod'));
      return hasSum && !hasMod;
    },
  },
  {
    id: 'GA-006',
    category: 'git-attacks',
    severity: 'HIGH',
    name: 'Multiple sensitive config files modified',
    check(files) {
      const sensitive = ['.gitattributes', '.gitmodules', '.github/workflows/', '.npmrc', '.yarnrc'];
      const matches = files.filter((f) => sensitive.some((s) => f.includes(s)));
      return matches.length >= 3;
    },
  },
  {
    id: 'CM-009',
    category: 'config-manipulation',
    severity: 'HIGH',
    name: 'Security-related files modified in bulk',
    check(files) {
      const securityRelated = /(?:auth|security|permission|rbac|acl|policy|cors|csp|helmet)/i;
      const matches = files.filter((f) => securityRelated.test(f));
      return matches.length >= 5;
    },
  },
  {
    id: 'CI-009',
    category: 'ci-cd-poisoning',
    severity: 'HIGH',
    name: 'Both CI config and source code modified',
    check(files) {
      const hasCI = files.some((f) => /\.github\/workflows\//.test(f));
      const hasDockerfile = files.some((f) => /Dockerfile/i.test(f));
      const hasSource = files.some((f) => /\.(js|ts|py|go|rs|rb|java|ex|exs)$/.test(f));
      return (hasCI || hasDockerfile) && hasSource;
    },
  },
];

// ═══════════════════════════════════════════════════════════════
// DIFF PARSER
// ═══════════════════════════════════════════════════════════════

function parseDiff(diffText) {
  const files = [];
  let current = null;
  let lineNum = 0;

  for (const line of (diffText || '').split('\n')) {
    // New file header
    const fileMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (fileMatch) {
      current = { file: fileMatch[2], addedLines: [], isNew: false, isDeleted: false, isBinary: false };
      files.push(current);
      lineNum = 0;
      continue;
    }

    if (!current) continue;

    if (line.startsWith('new file mode')) {
      current.isNew = true;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      current.isDeleted = true;
      continue;
    }
    if (line.startsWith('Binary files')) {
      current.isBinary = true;
      continue;
    }

    // Hunk header — extract target line number
    const hunkMatch = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunkMatch) {
      lineNum = parseInt(hunkMatch[1], 10) - 1;
      continue;
    }

    // Added line (not the +++ header)
    if (line.startsWith('+') && !line.startsWith('+++')) {
      lineNum++;
      current.addedLines.push({ num: lineNum, text: line.slice(1) });
      continue;
    }

    // Context or removed line
    if (!line.startsWith('-') || line.startsWith('---')) {
      lineNum++;
    }
  }

  return files;
}

// ═══════════════════════════════════════════════════════════════
// THREAT SCANNER
// ═══════════════════════════════════════════════════════════════

class PRThreatScanner {
  constructor(options = {}) {
    this.minSeverity = options.minSeverity || 'LOW';
    this.excludeCoboltScaffold = options.excludeCoboltScaffold === true;
  }

  /**
   * Scan parsed diff files against all threat patterns.
   * @param {{ file: string, addedLines: {num: number, text: string}[], isNew: boolean, isDeleted: boolean, isBinary: boolean }[]} parsedFiles
   * @returns {{ findings: object[], crossFileFindings: object[], verdict: string, stats: object }}
   */
  scan(parsedFiles) {
    const findings = [];
    const severityOrder = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };
    const minLevel = severityOrder[this.minSeverity] || 0;
    const startTime = Date.now();

    const ignoreOptions = { excludeCoboltScaffold: this.excludeCoboltScaffold };
    const filteredFiles = [];
    let filesIgnored = 0;
    for (const file of parsedFiles) {
      if (file.isBinary) {
        filesIgnored++;
        continue;
      }
      if (isIgnoredPath(file.file, ignoreOptions)) {
        filesIgnored++;
        continue;
      }
      filteredFiles.push(file);
    }

    // Separate patterns by target type
    const contentPatterns = THREAT_PATTERNS.filter((p) => p.target === 'content' || p.target === 'both');
    const pathPatterns = THREAT_PATTERNS.filter((p) => p.target === 'path' || p.target === 'both');

    let linesScanned = 0;

    for (const file of filteredFiles) {
      // Path-based pattern checks
      for (const pat of pathPatterns) {
        if ((severityOrder[pat.severity] || 0) < minLevel) continue;
        if (this.excludeCoboltScaffold && COBOLT_SYSTEM_THREAT_IDS.has(pat.id)) continue;
        if (pat.pattern.test(file.file)) {
          findings.push({
            id: pat.id,
            category: pat.category,
            severity: pat.severity,
            name: pat.name,
            file: file.file,
            line: null,
            match: file.file,
            context: `File path matches threat pattern: ${pat.name}`,
            isDeleted: file.isDeleted || false,
          });
        }
      }

      // Content-based pattern checks (only added lines)
      for (const added of file.addedLines) {
        linesScanned++;
        const lineIsComment = isCommentLine(added.text);
        for (const pat of contentPatterns) {
          if ((severityOrder[pat.severity] || 0) < minLevel) continue;
          // Suppress secret-exposure matches that originate from env/shell
          // comment lines — env templates document connection strings that
          // would otherwise read as leaked credentials.
          if (lineIsComment && pat.category === SECRET_CATEGORY) continue;
          const match = added.text.match(pat.pattern);
          if (match) {
            findings.push({
              id: pat.id,
              category: pat.category,
              severity: pat.severity,
              name: pat.name,
              file: file.file,
              line: added.num,
              match: match[0].substring(0, 120),
              context: added.text.substring(0, 200).trim(),
            });
          }
        }
      }
    }

    // Cross-file checks: use the filtered file set so that build artifacts
    // and CoBolt scaffolding do not skew structural detectors.
    const allFiles = filteredFiles.map((f) => f.file);
    const crossFileFindings = [];
    for (const check of CROSS_FILE_CHECKS) {
      if ((severityOrder[check.severity] || 0) < minLevel) continue;
      if (check.check(allFiles)) {
        crossFileFindings.push({
          id: check.id,
          category: check.category,
          severity: check.severity,
          name: check.name,
          file: null,
          line: null,
          match: null,
          context: `Cross-file structural check: ${check.name}`,
        });
      }
    }

    // Deduplicate: same pattern+file only once (keep first occurrence)
    const seen = new Set();
    const deduped = findings.filter((f) => {
      const key = `${f.id}:${f.file}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Path-only findings on deleted files are informational only
    for (const f of deduped) {
      if (f.isDeleted && f.line === null) {
        // Downgrade deleted file path matches (deleting a workflow is not an attack)
        if (f.severity === 'CRITICAL') f.severity = 'MEDIUM';
        if (f.severity === 'HIGH') f.severity = 'LOW';
        f.context += ' (file was DELETED — likely benign)';
      }
    }

    const allFindings = [...deduped, ...crossFileFindings];

    // Stats
    const stats = {
      filesScanned: filteredFiles.length,
      filesIgnored,
      linesScanned,
      patternsChecked: THREAT_PATTERNS.length + CROSS_FILE_CHECKS.length,
      findings: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
      duration: Date.now() - startTime,
      excludeCoboltScaffold: this.excludeCoboltScaffold,
    };
    for (const f of allFindings) {
      stats.findings[f.severity] = (stats.findings[f.severity] || 0) + 1;
    }

    return {
      findings: allFindings,
      verdict: PRThreatScanner.calculateVerdict(allFindings),
      stats,
    };
  }

  /**
   * Scan a GitHub PR by number.
   */
  scanPR(prNumber, repo) {
    const args = ['pr', 'diff', String(prNumber)];
    if (repo) args.push('--repo', repo);
    try {
      const diff = execFileSync('gh', args, { encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
      const parsed = parseDiff(diff);
      return this.scan(parsed);
    } catch (err) {
      return {
        findings: [],
        verdict: 'ERROR',
        stats: { error: err.message },
        error: `Failed to fetch PR diff: ${err.message}`,
      };
    }
  }

  /**
   * Scan a diff file.
   */
  scanDiffFile(filePath) {
    const diff = fs.readFileSync(filePath, 'utf8');
    return this.scan(parseDiff(diff));
  }

  /**
   * Scan raw diff text.
   */
  scanDiffText(diffText) {
    return this.scan(parseDiff(diffText));
  }

  /**
   * Scan all files in a directory (non-diff mode — treats all content as "added").
   *
   * Directory mode auto-enables `excludeCoboltScaffold` for the duration of
   * the scan: in a deployed CoBolt project, `.claude/settings.json`,
   * `.env.cobolt`, and `cobolt-state.json` are expected scaffolding written
   * by `/cobolt-init` and not threat surface. PR-diff mode keeps them armed.
   */
  scanDirectory(dirPath) {
    const files = [];
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (DEFAULT_IGNORE_DIRS.includes(entry.name)) continue;
          walk(full);
          continue;
        }
        const rel = path.relative(dirPath, full).replace(/\\/g, '/');
        if (isIgnoredPath(rel, { excludeCoboltScaffold: true })) continue;
        try {
          const content = fs.readFileSync(full, 'utf8');
          const lines = content.split('\n').map((text, i) => ({ num: i + 1, text }));
          files.push({ file: rel, addedLines: lines, isNew: false, isDeleted: false, isBinary: false });
        } catch {
          /* skip binary/unreadable */
        }
      }
    };
    walk(dirPath);
    const previousScaffoldFlag = this.excludeCoboltScaffold;
    this.excludeCoboltScaffold = true;
    try {
      return this.scan(files);
    } finally {
      this.excludeCoboltScaffold = previousScaffoldFlag;
    }
  }

  // ── Verdict ────────────────────────────────────────────────

  static calculateVerdict(findings) {
    if (findings.some((f) => f.severity === 'CRITICAL')) return 'BLOCK';
    if (findings.some((f) => f.severity === 'HIGH')) return 'REVIEW';
    return 'PASS';
  }

  // ── Formatters ─────────────────────────────────────────────

  static toJSON(result) {
    return JSON.stringify(
      {
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        verdict: result.verdict,
        stats: result.stats,
        findings: result.findings,
      },
      null,
      2,
    );
  }

  static toMarkdown(result) {
    const lines = [];
    const icon = { BLOCK: 'BLOCK', REVIEW: 'REVIEW', PASS: 'PASS', ERROR: 'ERROR' };
    const s = result.stats;

    lines.push('# PR Threat Scan Report');
    lines.push('');
    lines.push(
      `> **Verdict: ${icon[result.verdict] || result.verdict}** | Files: ${s.filesScanned || 0} | Lines: ${s.linesScanned || 0} | Patterns: ${s.patternsChecked || 0} | Time: ${s.duration || 0}ms`,
    );
    lines.push('');

    if (result.error) {
      lines.push(`**Error:** ${result.error}`);
      return lines.join('\n');
    }

    if (result.findings.length === 0) {
      lines.push('No threats detected. PR is clean.');
      return lines.join('\n');
    }

    // Group by severity
    for (const sev of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']) {
      const group = result.findings.filter((f) => f.severity === sev);
      if (group.length === 0) continue;

      lines.push(`## ${sev} Findings (${group.length})`);
      lines.push('');

      for (const f of group) {
        const loc = f.line ? `${f.file}:${f.line}` : f.file || 'cross-file';
        lines.push(`### ${f.id}: ${f.name}`);
        lines.push(`- **Location**: \`${loc}\``);
        if (f.match) lines.push(`- **Match**: \`${f.match}\``);
        if (f.context) lines.push(`- **Context**: \`${f.context}\``);
        lines.push('');
      }
    }

    // Summary table
    lines.push('## Summary');
    lines.push('');
    lines.push('| Category | CRITICAL | HIGH | MEDIUM | LOW |');
    lines.push('|----------|----------|------|--------|-----|');

    const categories = [...new Set(result.findings.map((f) => f.category))];
    for (const cat of categories) {
      const catFindings = result.findings.filter((f) => f.category === cat);
      const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
      for (const f of catFindings) counts[f.severity] = (counts[f.severity] || 0) + 1;
      lines.push(`| ${cat} | ${counts.CRITICAL} | ${counts.HIGH} | ${counts.MEDIUM} | ${counts.LOW} |`);
    }

    return lines.join('\n');
  }
}

// ── Module exports ─────────────────────────────────────────────

module.exports = {
  PRThreatScanner,
  parseDiff,
  THREAT_PATTERNS,
  CROSS_FILE_CHECKS,
  DEFAULT_IGNORE_DIRS,
  DEFAULT_IGNORE_EXTENSIONS,
  DEFAULT_IGNORE_FILE_PATTERNS,
  COBOLT_SCAFFOLD_PATH_PATTERNS,
  COBOLT_SYSTEM_THREAT_IDS,
  isIgnoredPath,
  isCommentLine,
};

// ── CLI ────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log();
    console.log('  CoBolt PR Threat Scanner');
    console.log('  ═══════════════════════════════════════════');
    console.log();
    console.log('  Usage:');
    console.log('    node tools/cobolt-pr-threat-scan.js --pr <number> [--repo owner/repo]');
    console.log('    node tools/cobolt-pr-threat-scan.js --diff <file.patch>');
    console.log('    node tools/cobolt-pr-threat-scan.js --stdin');
    console.log('    node tools/cobolt-pr-threat-scan.js --path <directory>');
    console.log();
    console.log('  Options:');
    console.log('    --format json|markdown          Output format (default: json)');
    console.log('    --severity CRITICAL|HIGH|MEDIUM|LOW  Min severity (default: LOW)');
    console.log('    --exclude-cobolt-scaffold       Skip .claude/settings.json, .env.cobolt, cobolt-state.json');
    console.log('    --no-exclude-cobolt-scaffold    Keep CoBolt scaffolding armed (default for --pr/--diff)');
    console.log('    --patterns                      List all threat patterns');
    console.log();
    console.log('  Path filter:');
    console.log('    Directories pruned: node_modules, .git, _cobolt-output, vendor, __pycache__,');
    console.log('      .next, .nuxt, .worktrees, .cache, build, dist, out, target, obj, coverage, .venv, venv');
    console.log('    Extensions skipped: .exe, .dll, .so, .dylib, .woff, .woff2, .ttf, .otf, .eot,');
    console.log('      .png, .jpg, .pdf, .zip, .mp4, .wasm, .min.js, .bundle.js, .map, etc.');
    console.log();
    console.log('  Exit codes:');
    console.log('    0 = PASS    No CRITICAL or HIGH findings');
    console.log('    1 = REVIEW  HIGH findings present');
    console.log('    2 = BLOCK   CRITICAL findings present');
    console.log();
    process.exit(0);
  }

  // List patterns
  if (args.includes('--patterns')) {
    console.log();
    console.log(`  ${THREAT_PATTERNS.length} content/path patterns + ${CROSS_FILE_CHECKS.length} cross-file checks`);
    console.log();
    const cats = {};
    for (const p of THREAT_PATTERNS) {
      if (!cats[p.category]) cats[p.category] = [];
      cats[p.category].push(p);
    }
    for (const [cat, pats] of Object.entries(cats)) {
      console.log(`  ${cat.toUpperCase()} (${pats.length})`);
      for (const p of pats) {
        console.log(`    ${p.id} [${p.severity}] ${p.name} (${p.target})`);
      }
      console.log();
    }
    process.exit(0);
  }

  // Parse flags
  const getFlag = (flag) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
  };

  const format = getFlag('--format') || 'json';
  const minSeverity = getFlag('--severity') || 'LOW';
  // Directory scans auto-set excludeCoboltScaffold; PR/diff scans default
  // to false (still flag scaffolding poisoning in a diff context). CLI
  // flags --exclude-cobolt-scaffold / --no-exclude-cobolt-scaffold force.
  const explicitExclude = args.includes('--exclude-cobolt-scaffold');
  const explicitInclude = args.includes('--no-exclude-cobolt-scaffold');
  const excludeCoboltScaffold = explicitExclude && !explicitInclude;
  const scanner = new PRThreatScanner({ minSeverity, excludeCoboltScaffold });

  let result;

  if (getFlag('--pr')) {
    const prNum = getFlag('--pr');
    const repo = getFlag('--repo');
    result = scanner.scanPR(prNum, repo);
  } else if (getFlag('--diff')) {
    const diffFile = getFlag('--diff');
    if (!fs.existsSync(diffFile)) {
      console.error(`  File not found: ${diffFile}`);
      process.exit(1);
    }
    result = scanner.scanDiffFile(diffFile);
  } else if (args.includes('--stdin')) {
    try {
      const input = fs.readFileSync(0, 'utf8');
      result = scanner.scanDiffText(input);
    } catch {
      console.error('  Cannot read from stdin');
      process.exit(1);
    }
  } else if (getFlag('--path')) {
    const dirPath = getFlag('--path');
    if (!fs.existsSync(dirPath)) {
      console.error(`  Directory not found: ${dirPath}`);
      process.exit(1);
    }
    result = scanner.scanDirectory(dirPath);
  } else {
    console.error('  No input specified. Use --pr, --diff, --stdin, or --path.');
    process.exit(1);
  }

  // Output
  if (format === 'markdown') {
    console.log(PRThreatScanner.toMarkdown(result));
  } else {
    console.log(PRThreatScanner.toJSON(result));
  }

  // Exit code
  const exitCodes = { PASS: 0, REVIEW: 1, BLOCK: 2, ERROR: 1 };
  process.exit(exitCodes[result.verdict] || 0);
}
