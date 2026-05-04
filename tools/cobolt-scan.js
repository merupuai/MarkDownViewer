#!/usr/bin/env node

// CoBolt Security Scanner — orchestrates all 18 security tools from tool-registry
//
// Runs available security tools against the project and produces a unified report.
// Uses analyzer-base for cross-platform tool discovery with Docker fallback.
//
// Usage:
//   node tools/cobolt-scan.js                        # Run all available tools (native + Docker fallback)
//   node tools/cobolt-scan.js --docker                # Force ALL tools through Docker containers
//   node tools/cobolt-scan.js --no-docker             # Disable Docker fallback, native only
//   node tools/cobolt-scan.js --docker-pull           # Pre-pull all Docker images
//   node tools/cobolt-scan.js --category sast         # Run specific category
//   node tools/cobolt-scan.js --category sast,secrets  # Multiple categories
//   node tools/cobolt-scan.js --priority core          # Only core tools
//   node tools/cobolt-scan.js --json                   # JSON output
//   node tools/cobolt-scan.js --fix                    # Auto-fix where supported

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { AnalyzerBase } = require('../lib/analyzer-base');
const { TOOL_REGISTRY } = require('../lib/tool-registry');
const { isDockerAvailable, pullAllImages } = require('../lib/docker-tool-runner');
const { paths: _paths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();

const CATEGORY_LABELS = {
  sast: 'Static Analysis (SAST)',
  deps: 'Dependency Scanning',
  secrets: 'Secret Detection',
  dast: 'Dynamic Analysis (DAST)',
  iac: 'Infrastructure as Code',
  'supply-chain': 'Supply Chain Security',
  container: 'Container Security',
};

const DEFAULT_SCAN_EXCLUDES = [
  '.git',
  'node_modules',
  'bower_components',
  'vendor',
  'venv',
  '.venv',
  'env',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.nox',
  '.cache',
  '.turbo',
  '.parcel-cache',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'coverage',
  'dist',
  'build',
  'out',
  'target',
  'bin',
  'obj',
  '_cobolt-output',
  '_cobolt-docker',
  '.claude',
  '.codex',
  '.agent',
  '.playwright-mcp',
  '.serena',
  '.planning',
  '.vscode',
  '.idea',
  'screenshots',
  'test-results',
  'playwright-report',
  'app/deps',
  'app/_build',
  'app/tmp',
  'docs/olddocs',
  'tools/tools',
  // .github/* is gitignored except workflows/ and dependabot.yml, so these
  // subpaths are untracked install artifacts that shouldn't be scanned.
  '.github/skills',
  '.github/agents',
  '.github/cobolt',
];

const LOCAL_SECRET_FILE_PATTERNS = [
  /^\.env$/i,
  /^\.env\.local$/i,
  /^\.env\.[^/\\]+\.local$/i,
  /^\.env\.cobolt$/i,
  /^\.env\.mcp$/i,
  /^_cobolt-docker[\\/]\.env$/i,
];

function sameResolvedPath(left, right) {
  const leftPath = path.resolve(left);
  const rightPath = path.resolve(right);
  return process.platform === 'win32' ? leftPath.toLowerCase() === rightPath.toLowerCase() : leftPath === rightPath;
}

function isCoBoltRuntimeToolsMirror(projectDir) {
  const candidatePath = path.join(projectDir, 'tools');
  if (!fs.existsSync(candidatePath)) return false;

  let stat;
  try {
    stat = fs.lstatSync(candidatePath);
  } catch {
    return false;
  }
  if (!stat.isDirectory() && !stat.isSymbolicLink()) return false;

  const markerFiles = ['cobolt-test.js', 'cobolt-scan.js', 'index.js'];
  const markerCount = markerFiles.filter((file) => fs.existsSync(path.join(candidatePath, file))).length;
  if (markerCount < 2) return false;

  try {
    if (sameResolvedPath(fs.realpathSync(candidatePath), fs.realpathSync(__dirname))) return true;
  } catch {
    // Fall through to marker-based copy detection.
  }

  return stat.isSymbolicLink() || markerCount === markerFiles.length;
}

function getScanExcludes(projectDir) {
  const excludes = [...DEFAULT_SCAN_EXCLUDES];
  if (isCoBoltRuntimeToolsMirror(projectDir)) excludes.push('tools');
  return excludes;
}

function buildExcludeRegex(excludes) {
  return excludes.map((dir) => dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '[\\\\/]')).join('|');
}

function parseJsonPayload(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}

  const starts = [text.indexOf('{'), text.indexOf('[')].filter((index) => index >= 0).sort((a, b) => a - b);
  for (const start of starts) {
    const closer = text[start] === '{' ? '}' : ']';
    const end = text.lastIndexOf(closer);
    if (end <= start) continue;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function pathSegmentExcludeRegex(excludePath) {
  const normalized = String(excludePath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!normalized) return null;
  const segments = normalized
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (segments.length === 0) return null;
  return `(^|[\\\\/])${segments.join('[\\\\/]')}([\\\\/]|$)`;
}

function findProjectGitleaksConfig(projectDir) {
  for (const fileName of ['.gitleaks.toml', 'gitleaks.toml']) {
    const candidate = path.join(projectDir, fileName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function writeGitleaksAllowlistConfig(projectDir, excludes = DEFAULT_SCAN_EXCLUDES) {
  const outputDir = path.join(projectDir, '_cobolt-output', 'latest', 'security');
  fs.mkdirSync(outputDir, { recursive: true });
  const projectConfig = findProjectGitleaksConfig(projectDir);
  const hash = crypto
    .createHash('sha256')
    .update(path.resolve(projectDir))
    .update('\0')
    .update(excludes.join('\0'))
    .digest('hex')
    .slice(0, 12);
  const outputPath = path.join(outputDir, `gitleaks-cobolt-excludes-${hash}.toml`);
  const pathRegexes = excludes.map(pathSegmentExcludeRegex).filter(Boolean);
  const lines = [
    '# Generated by CoBolt. Do not edit by hand.',
    projectConfig ? '[extend]' : '[extend]',
    projectConfig ? `path = ${JSON.stringify(projectConfig.replace(/\\/g, '/'))}` : 'useDefault = true',
    '',
    '[[allowlists]]',
    'description = "CoBolt generated, dependency, and build-output directories"',
    'paths = [',
    ...pathRegexes.map((regex) => `  ${JSON.stringify(regex)},`),
    ']',
    '',
  ];
  fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');
  return outputPath;
}

function writeSemgrepCoreConfig(projectDir) {
  const outputDir = path.join(projectDir, '_cobolt-output', 'latest', 'security');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'semgrep-cobolt-core.yml');
  const rules = [
    '# Generated by CoBolt. Do not edit by hand.',
    '# Deterministic core SAST rules used when Semgrep registry auto-config',
    '# cannot run with metrics disabled.',
    'rules:',
    '  - id: cobolt-js-dangerous-eval',
    '    languages: [javascript, typescript]',
    '    severity: ERROR',
    '    message: Avoid runtime code execution through eval or Function constructors.',
    '    pattern-either:',
    '      - pattern: eval(...)',
    '      - pattern: new Function(...)',
    '',
    '  - id: cobolt-js-react-dangerous-html',
    '    languages: [javascript, typescript]',
    '    severity: ERROR',
    '    message: Avoid direct HTML injection in React components.',
    '    pattern-regex: |',
    '      dangerouslySetInnerHTML\\s*=\\s*\\{\\s*\\{\\s*__html\\s*:',
    '',
    '  - id: cobolt-js-hardcoded-secret',
    '    languages: [javascript, typescript]',
    '    severity: WARNING',
    '    message: Hardcoded credential-like values must not be committed to source.',
    '    patterns:',
    '      - pattern-either:',
    '          - pattern: |',
    '              const $KEY = "$VALUE"',
    '          - pattern: |',
    "              const $KEY = '$VALUE'",
    '          - pattern: |',
    '              let $KEY = "$VALUE"',
    '          - pattern: |',
    "              let $KEY = '$VALUE'",
    '          - pattern: |',
    '              var $KEY = "$VALUE"',
    '          - pattern: |',
    "              var $KEY = '$VALUE'",
    '      - metavariable-regex:',
    '          metavariable: $KEY',
    '          regex: (?i).*(api[_-]?key|secret|token|password|private[_-]?key).*',
    '      - metavariable-regex:',
    '          metavariable: $VALUE',
    '          regex: ^[A-Za-z0-9_./+=:@$-]{16,}$',
    '',
    '  - id: cobolt-python-dangerous-eval',
    '    languages: [python]',
    '    severity: ERROR',
    '    message: Avoid runtime code execution through eval or exec.',
    '    pattern-either:',
    '      - pattern: eval(...)',
    '      - pattern: exec(...)',
    '',
    '  - id: cobolt-python-subprocess-shell-true',
    '    languages: [python]',
    '    severity: ERROR',
    '    message: subprocess with shell=True must be avoided unless input is fully controlled.',
    '    pattern-either:',
    '      - pattern: subprocess.run(..., shell=True, ...)',
    '      - pattern: subprocess.Popen(..., shell=True, ...)',
    '      - pattern: subprocess.call(..., shell=True, ...)',
    '      - pattern: subprocess.check_call(..., shell=True, ...)',
    '      - pattern: subprocess.check_output(..., shell=True, ...)',
    '',
  ].join('\n');
  fs.writeFileSync(outputPath, rules, 'utf8');
  return outputPath;
}

function buildScanArgs(excludes = DEFAULT_SCAN_EXCLUDES, opts = {}) {
  const semgrepExcludes = excludes.flatMap((dir) => ['--exclude', dir]);
  const trivySkipDirs = excludes.flatMap((dir) => ['--skip-dirs', dir]);
  const checkovSkipPaths = excludes.flatMap((dir) => ['--skip-path', dir]);
  const defaultExcludeRegex = buildExcludeRegex(excludes);
  const semgrepConfig = opts.semgrepConfig || 'auto';
  const semgrepMetrics = opts.semgrepMetrics || (semgrepConfig === 'auto' ? 'auto' : 'off');

  return {
    semgrep: [
      'scan',
      '--json',
      '--config',
      semgrepConfig,
      '--severity',
      'ERROR',
      '--metrics',
      semgrepMetrics,
      ...semgrepExcludes,
      '.',
    ],
    bandit: ['-q', '-r', '.', '-f', 'json', '-ll', '-x', excludes.join(',')],
    gosec: ['-fmt', 'json', './...'],
    'npm-audit': null, // special handling
    'pip-audit': ['--format', 'json'],
    govulncheck: ['-json', './...'],
    trivy: [
      'fs',
      '--format',
      'json',
      '--timeout',
      '5m',
      '--scanners',
      'vuln',
      '--skip-version-check',
      ...trivySkipDirs,
      '.',
    ],
    snyk: ['test', '--json'],
    'osv-scanner': ['--json', '-r', '.'],
    nuclei: ['-u', 'http://localhost:3000', '-json'],
    gitleaks: [
      'detect',
      '--no-git',
      '--source',
      '.',
      '--redact',
      '--report-format',
      'json',
      '--report-path',
      '-',
      '--timeout',
      '90',
      '--log-level',
      'error',
    ],
    trufflehog: ['filesystem', '.', '--json'],
    'detect-secrets': ['scan', '.', '--exclude-files', defaultExcludeRegex],
    checkov: ['-d', '.', '-o', 'json', ...checkovSkipPaths],
    tfsec: ['--format', 'json', '.'],
    hadolint: [], // needs Dockerfile path
    scorecard: [], // needs --repo flag
    'kube-bench': ['--json'],
  };
}

function normalizeFindingPath(filePath, projectDir) {
  if (!filePath || typeof filePath !== 'string') return null;
  const raw = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!raw || /^[a-z]+:\/\//iu.test(raw)) return null;

  if (path.isAbsolute(filePath)) {
    return path.relative(projectDir, filePath).replace(/\\/g, '/');
  }
  return raw;
}

function isDefaultExcludedPath(filePath, projectDir, excludes = DEFAULT_SCAN_EXCLUDES) {
  const normalized = normalizeFindingPath(filePath, projectDir);
  if (!normalized || normalized.startsWith('..')) return false;
  return excludes.some((dir) => {
    const cleanDir = dir.replace(/\\/g, '/');
    return normalized === cleanDir || normalized.startsWith(`${cleanDir}/`) || normalized.includes(`/${cleanDir}/`);
  });
}

function isLocalSecretFilePath(filePath, projectDir) {
  const normalized = normalizeFindingPath(filePath, projectDir);
  if (!normalized || normalized.startsWith('..')) return false;
  const clean = normalized.replace(/\\/g, '/');
  return LOCAL_SECRET_FILE_PATTERNS.some((pattern) => pattern.test(clean));
}

function collectFindingPaths(value, paths = [], depth = 0) {
  if (!value || depth > 4) return paths;
  if (Array.isArray(value)) {
    for (const item of value) collectFindingPaths(item, paths, depth + 1);
    return paths;
  }
  if (typeof value !== 'object') return paths;

  for (const [key, child] of Object.entries(value)) {
    if (/^(file|filename|path|target)$/iu.test(key) && typeof child === 'string') {
      paths.push(child);
    } else if (child && typeof child === 'object') {
      collectFindingPaths(child, paths, depth + 1);
    }
  }
  return paths;
}

function summarizeSuppressedFinding(finding, projectDir, reason) {
  const paths = collectFindingPaths(finding);
  const firstPath = paths.find((filePath) => isLocalSecretFilePath(filePath, projectDir)) || paths[0] || null;
  return {
    reason,
    ruleId: finding.RuleID || finding.ruleId || finding.rule || finding.check_id || 'unknown',
    file: firstPath ? normalizeFindingPath(firstPath, projectDir) : null,
    startLine: finding.StartLine || finding.startLine || finding.line || null,
    endLine: finding.EndLine || finding.endLine || null,
  };
}

function filterIgnoredFindings(findings, projectDir, excludes = DEFAULT_SCAN_EXCLUDES) {
  const kept = [];
  const suppressed = [];
  for (const finding of findings) {
    const paths = collectFindingPaths(finding);
    if (paths.some((filePath) => isDefaultExcludedPath(filePath, projectDir, excludes))) {
      continue;
    }
    if (paths.some((filePath) => isLocalSecretFilePath(filePath, projectDir))) {
      suppressed.push(summarizeSuppressedFinding(finding, projectDir, 'local-secret-file'));
      continue;
    }
    kept.push(finding);
  }
  return { findings: kept, suppressed };
}

function filterExcludedFindings(findings, projectDir, excludes = DEFAULT_SCAN_EXCLUDES) {
  return filterIgnoredFindings(findings, projectDir, excludes).findings;
}

function isSemgrepBlockingError(error) {
  if (!error || typeof error !== 'object') return false;
  const level = String(error.level || error.severity || '').toLowerCase();
  const type = Array.isArray(error.type) ? error.type.join(' ') : String(error.type || error.error_type || '');
  if (level === 'warn' || level === 'warning') return false;
  if (/partialparsing|partial parsing|fixpoint timeout/i.test(type) && /warn|warning/i.test(level)) return false;
  return true;
}

function parsedToolErrors(tool, parsed) {
  if (tool !== 'semgrep' || !parsed || !Array.isArray(parsed.errors)) return [];
  return parsed.errors.filter(isSemgrepBlockingError);
}

// Tool-specific scan arguments
const SCAN_ARGS = buildScanArgs(DEFAULT_SCAN_EXCLUDES);

// Docker-specific arg overrides — tools that need different args inside a container
// (e.g. read-only mounts mean tools can't write report files to the project dir)
const DOCKER_SCAN_ARGS = {
  // gitleaks: --report-path /dev/stdout sends JSON to stdout instead of writing a file
  gitleaks: [
    'detect',
    '--no-git',
    '--source',
    '.',
    '--redact',
    '--report-format',
    'json',
    '--report-path',
    '-',
    '--timeout',
    '90',
    '--log-level',
    'error',
  ],
  // nuclei: use host.docker.internal instead of localhost to reach host services
  nuclei: ['-u', 'http://host.docker.internal:3000', '-json'],
};

class SecurityScanner {
  constructor(projectDir, opts = {}) {
    this.projectDir = projectDir || process.cwd();
    this.analyzer = new AnalyzerBase(this.projectDir, {
      dockerFallback: opts.dockerFallback !== false,
      forceDocker: opts.forceDocker || false,
    });
    this.analyzer.results = { tools: [] };
    this.results = [];
    this._forceDocker = opts.forceDocker || false;
    this.scanExcludes = getScanExcludes(this.projectDir);
    this.scanArgs = buildScanArgs(this.scanExcludes, {
      semgrepConfig: writeSemgrepCoreConfig(this.projectDir),
      semgrepMetrics: 'off',
    });
  }

  _hasPythonProject() {
    const manifests = ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py'];
    return manifests.some((file) => fs.existsSync(path.join(this.projectDir, file)));
  }

  /**
   * Discover which security tools are available.
   */
  discover() {
    const available = [];
    for (const tool of TOOL_REGISTRY) {
      const disc = this.analyzer._discoverTool(tool.name);
      available.push({
        ...tool,
        available: disc.found,
        method: disc.method,
        resolvedPath: disc.resolvedPath,
      });
    }
    return available;
  }

  /**
   * Run a single security tool.
   */
  runTool(toolEntry) {
    const startTime = Date.now();
    const name = toolEntry.name;

    // Special handling for npm-audit (built-in)
    if (name === 'npm-audit') {
      return this._runNpmAudit(startTime);
    }

    if (name === 'pip-audit' && !this._hasPythonProject()) {
      return {
        tool: name,
        category: toolEntry.category,
        priority: toolEntry.priority,
        status: 'SKIPPED',
        message: 'No Python dependency manifest found',
        durationMs: 0,
      };
    }

    // Use Docker-specific args if tool will run via Docker
    const discovery = this.analyzer._discoverTool(name);
    const willUseDocker = this._forceDocker || discovery.method === 'docker';
    const argsSource = willUseDocker && DOCKER_SCAN_ARGS[name] ? DOCKER_SCAN_ARGS[name] : this.scanArgs[name];
    const args = [...(argsSource || [])];
    if (args.length === 0) {
      return { tool: name, status: 'SKIPPED', message: 'No scan args defined', durationMs: 0 };
    }
    if (name === 'gitleaks' && !args.includes('--config')) {
      args.push('--config', writeGitleaksAllowlistConfig(this.projectDir, this.scanExcludes));
    }

    // Handle hadolint (needs Dockerfile)
    if (name === 'hadolint') {
      const dockerfilePath = path.join(this.projectDir, 'Dockerfile');
      if (!fs.existsSync(dockerfilePath)) {
        return { tool: name, status: 'SKIPPED', message: 'No Dockerfile found', durationMs: 0 };
      }
      args.push(dockerfilePath);
    }

    const result = this.analyzer._run(name, args, { timeout: 300000 });
    const durationMs = Date.now() - startTime;

    const method = result.method || toolEntry.method || 'native';

    // Parse stdout (kept separate from stderr by analyzer-base so that INFO/progress
    // lines don't corrupt structured JSON output). Security tools that exit non-zero
    // with a parseable JSON payload (bandit, semgrep, gitleaks, trivy, govulncheck)
    // are already normalized to success=true by the Docker-runner pattern in _exec.
    const parseSource = result.output || '';
    let findings = [];
    let suppressedFindings = [];
    let parseOk = false;
    let parsedToolErrorDetails = [];
    try {
      const parsed = parseJsonPayload(parseSource);
      if (!parsed) throw new Error('missing JSON payload');
      parsedToolErrorDetails = parsedToolErrors(name, parsed);
      if (parsedToolErrorDetails.length === 0) {
        const filtered = filterIgnoredFindings(this._extractFindings(name, parsed), this.projectDir, this.scanExcludes);
        findings = filtered.findings;
        suppressedFindings = filtered.suppressed;
      }
      parseOk = true;
    } catch {
      // Fall through — unparseable output is a real tool failure
    }

    if (!parseOk) {
      const stderrSnippet = result.stderr ? String(result.stderr).substring(0, 300) : '';
      return {
        tool: name,
        category: toolEntry.category,
        priority: toolEntry.priority,
        status: 'ERROR',
        method,
        findings: [],
        findingCount: 0,
        durationMs,
        raw: parseSource ? String(parseSource).substring(0, 500) : '',
        stderrSnippet,
        message: `Tool failed (exit ${result.code ?? 'unknown'}) with unparseable output`,
      };
    }

    if (parsedToolErrorDetails.length > 0) {
      return {
        tool: name,
        category: toolEntry.category,
        priority: toolEntry.priority,
        status: 'ERROR',
        method,
        findings: [],
        findingCount: 0,
        durationMs,
        raw: parseSource ? String(parseSource).substring(0, 500) : '',
        errors: parsedToolErrorDetails.slice(0, 10),
        message: `Tool reported ${parsedToolErrorDetails.length} blocking error(s)`,
      };
    }

    // Status is determined by findings, not by exit code. Non-zero exit with
    // parseable output is how most security scanners signal "findings present".
    return {
      tool: name,
      category: toolEntry.category,
      priority: toolEntry.priority,
      status: findings.length > 0 ? 'FINDINGS' : 'PASS',
      method,
      findings,
      findingCount: findings.length,
      suppressedFindingCount: suppressedFindings.length,
      suppressedFindings,
      durationMs,
      raw: String(parseSource).substring(0, 500),
    };
  }

  _runNpmAudit(startTime) {
    const lockFile = path.join(this.projectDir, 'package-lock.json');
    if (!fs.existsSync(lockFile)) {
      return { tool: 'npm-audit', status: 'SKIPPED', message: 'No package-lock.json', durationMs: 0 };
    }
    const result = this.analyzer._run('npm', ['audit', '--json'], { timeout: 60000 });
    const durationMs = Date.now() - startTime;
    let findings = [];
    let parsed;

    if (!result.output || !String(result.output).trim()) {
      return {
        tool: 'npm-audit',
        category: 'deps',
        priority: 'core',
        status: 'ERROR',
        findings: [],
        findingCount: 0,
        durationMs,
        raw: '',
        message: `npm audit failed without JSON output (exit ${result.code ?? 'unknown'})`,
      };
    }

    try {
      parsed = JSON.parse(result.output);
      const vulns = parsed.metadata ? parsed.metadata.vulnerabilities : {};
      const total = (vulns.critical || 0) + (vulns.high || 0) + (vulns.moderate || 0) + (vulns.low || 0);
      findings = Array.from({ length: total }, (_, i) => ({ index: i, severity: 'varies' }));
    } catch (err) {
      return {
        tool: 'npm-audit',
        category: 'deps',
        priority: 'core',
        status: 'ERROR',
        findings: [],
        findingCount: 0,
        durationMs,
        raw: String(result.output).substring(0, 500),
        message: `npm audit output was not parseable JSON: ${err.message}`,
      };
    }

    return {
      tool: 'npm-audit',
      category: 'deps',
      priority: 'core',
      status: findings.length > 0 ? 'FINDINGS' : result.success ? 'PASS' : 'ERROR',
      findings,
      findingCount: findings.length,
      durationMs,
      message: !result.success && findings.length === 0 ? `npm audit exited ${result.code ?? 'unknown'}` : undefined,
    };
  }

  _extractFindings(tool, parsed) {
    // Each tool has different output formats — normalize
    if (tool === 'semgrep' && parsed.results) return parsed.results;
    if (tool === 'gitleaks' && Array.isArray(parsed)) return parsed;
    if (tool === 'trivy' && parsed.Results) {
      return parsed.Results.flatMap((r) => r.Vulnerabilities || []);
    }
    if (tool === 'bandit' && parsed.results) return parsed.results;
    if (Array.isArray(parsed)) return parsed;
    return [];
  }

  /**
   * Run all available tools, optionally filtered.
   */
  runAll(options = {}) {
    const allTools = this.discover();
    let toRun = allTools.filter((t) => t.available);
    const quiet = options.quiet || options.json || options.quietJson;
    const unavailable = allTools.filter((t) => !t.available);

    if (options.category) {
      const cats = options.category.split(',');
      toRun = toRun.filter((t) => cats.includes(t.category));
    }
    if (options.priority) {
      toRun = toRun.filter((t) => t.priority === options.priority);
    }

    const dockerTools = toRun.filter((t) => t.method === 'docker');
    const nativeTools = toRun.filter((t) => t.method !== 'docker');

    if (!quiet) {
      console.log(`\n  CoBolt Security Scan: ${toRun.length} tools to run`);
      if (nativeTools.length > 0) console.log(`    Native: ${nativeTools.length}`);
      if (dockerTools.length > 0) console.log(`    Docker: ${dockerTools.length}`);
      if (unavailable.length > 0)
        console.log(`    Unavailable: ${unavailable.length} (no native install or Docker image)`);
      console.log();
    }

    this.results = [];
    for (const tool of toRun) {
      const dockerBadge = tool.method === 'docker' ? ' [Docker]' : '';
      if (!quiet) {
        process.stdout.write(`  [${tool.category}] ${tool.name}${dockerBadge}... `);
      }
      const result = this.runTool(tool);
      this.results.push(result);

      if (!quiet) {
        const methodTag = result.method === 'docker' ? ' (docker)' : '';
        if (result.status === 'PASS') console.log(`PASS${methodTag} (${result.durationMs}ms)`);
        else if (result.status === 'FINDINGS')
          console.log(`${result.findingCount} findings${methodTag} (${result.durationMs}ms)`);
        else if (result.status === 'SKIPPED') console.log(`SKIPPED (${result.message})`);
        else console.log(`ERROR${methodTag} (${result.durationMs}ms)`);
      }
    }

    return this.results;
  }

  /**
   * Run all available tools in parallel using async child processes.
   * Groups by category to limit concurrent tool contention.
   * Returns a Promise — caller must await.
   */
  async runAllParallel(options = {}) {
    const allTools = this.discover();
    let toRun = allTools.filter((t) => t.available);
    const quiet = options.quiet || options.json || options.quietJson;

    if (options.category) {
      const cats = options.category.split(',');
      toRun = toRun.filter((t) => cats.includes(t.category));
    }
    if (options.priority) {
      toRun = toRun.filter((t) => t.priority === options.priority);
    }

    if (!quiet) {
      console.log(`\n  CoBolt Security Scan: ${toRun.length} tools (parallel)`);
    }

    // Group by category
    const groups = {};
    for (const tool of toRun) {
      const cat = tool.category;
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(tool);
    }

    this.results = [];
    const startTime = Date.now();

    // Run all categories concurrently; tools within each category run sequentially
    // to avoid same-tool contention (e.g., two SAST tools fighting over the same files)
    const categoryPromises = Object.entries(groups).map(([cat, tools]) =>
      (async () => {
        const categoryResults = [];
        for (const tool of tools) {
          const result = this.runTool(tool);
          categoryResults.push(result);
          if (!quiet) {
            const methodTag = result.method === 'docker' ? ' (docker)' : '';
            const statusIcon =
              result.status === 'PASS'
                ? 'PASS'
                : result.status === 'FINDINGS'
                  ? `${result.findingCount} findings`
                  : result.status === 'SKIPPED'
                    ? 'SKIP'
                    : 'ERR';
            console.log(`  [${cat}] ${tool.name}: ${statusIcon}${methodTag} (${result.durationMs}ms)`);
          }
        }
        return categoryResults;
      })(),
    );

    const allCategoryResults = await Promise.all(categoryPromises);
    this.results = allCategoryResults.flat();

    if (!quiet) {
      console.log(`\n  Total: ${Date.now() - startTime}ms (${Object.keys(groups).length} categories parallel)`);
    }

    return this.results;
  }

  /**
   * Compute overall security posture using per-tool-severity policy.
   *
   * Policy:
   *   UNKNOWN  — a CORE tool errored. We cannot honestly claim zero findings.
   *              Exit code 2 (CI must fail loudly, distinguishable from 1).
   *   FINDINGS — all core tools ran; at least one tool reported findings.
   *              Exit code 1 (standard "found something" signal).
   *   DEGRADED — all core tools ran with zero findings; a recommended or
   *              optional tool errored (e.g. nuclei couldn't reach host).
   *              Exit code 0 with a prominent warning.
   *   CLEAN    — all tools ran, zero findings. Exit code 0.
   *
   * Rationale: core tool errors are a trust boundary. If bandit silently
   * fails we cannot ship. Non-core tool errors are noise we tolerate so
   * transient network/Docker hiccups don't block the pipeline.
   */
  computePosture() {
    const errored = this.results.filter((r) => r.status === 'ERROR');
    const coreErrored = errored.filter((r) => r.priority === 'core');
    const coreResults = this.results.filter((r) => r.priority === 'core');
    const coreExecuted = coreResults.filter((r) => r.status !== 'SKIPPED');
    const withFindings = this.results.filter((r) => r.status === 'FINDINGS');

    if (coreExecuted.length === 0) {
      return {
        posture: 'UNKNOWN',
        exitCode: 2,
        reason: 'no core security tools executed',
      };
    }
    if (coreErrored.length > 0) {
      return {
        posture: 'UNKNOWN',
        exitCode: 2,
        reason: `${coreErrored.length} core tool(s) errored: ${coreErrored.map((t) => t.tool).join(', ')}`,
      };
    }
    if (withFindings.length > 0) {
      const total = withFindings.reduce((s, r) => s + (r.findingCount || 0), 0);
      return {
        posture: 'FINDINGS',
        exitCode: 1,
        reason: `${total} finding(s) across ${withFindings.length} tool(s): ${withFindings.map((t) => t.tool).join(', ')}`,
      };
    }
    if (errored.length > 0) {
      return {
        posture: 'DEGRADED',
        exitCode: 0,
        reason: `${errored.length} non-core tool(s) errored: ${errored.map((t) => t.tool).join(', ')}`,
      };
    }
    return { posture: 'CLEAN', exitCode: 0, reason: 'all tools ran, zero findings' };
  }

  /**
   * Generate scan report.
   */
  report() {
    const passed = this.results.filter((r) => r.status === 'PASS');
    const withFindings = this.results.filter((r) => r.status === 'FINDINGS');
    const errors = this.results.filter((r) => r.status === 'ERROR');
    const totalFindings = this.results.reduce((s, r) => s + (r.findingCount || 0), 0);
    const suppressedFindings = this.results.reduce((s, r) => s + (r.suppressedFindingCount || 0), 0);
    const dockerRun = this.results.filter((r) => r.method === 'docker');
    const nativeRun = this.results.filter((r) => r.method && r.method !== 'docker');
    const postureInfo = this.computePosture();

    return {
      timestamp: new Date().toISOString(),
      summary: {
        toolsRun: this.results.length,
        passed: passed.length,
        withFindings: withFindings.length,
        errors: errors.length,
        totalFindings,
        suppressedFindings,
        nativeTools: nativeRun.length,
        dockerTools: dockerRun.length,
        posture: postureInfo.posture,
        postureReason: postureInfo.reason,
        exitCode: postureInfo.exitCode,
      },
      results: this.results,
    };
  }

  /**
   * Save report to _cobolt-output.
   */
  save() {
    const _p = typeof _paths === 'function' ? _paths(this.projectDir) : null;
    const reportDir = _p ? _p.review() : path.join(this.projectDir, '_cobolt-output/latest/review');
    if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

    const reportData = this.report();
    const reportPath = path.join(reportDir, 'security-scan-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(reportData, null, 2), 'utf8');
    return reportPath;
  }
}

function writeReportFile(filePath, reportData) {
  const resolvedPath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, JSON.stringify(reportData, null, 2), 'utf8');
  return resolvedPath;
}

function quietJsonPayload(reportData, reportPath) {
  return {
    summary: reportData?.summary || {},
    reportPath,
  };
}

// ── Module exports ───────────────────────────────────────────

module.exports = {
  SecurityScanner,
  SCAN_ARGS,
  CATEGORY_LABELS,
  writeReportFile,
  quietJsonPayload,
  _testOnly: {
    DEFAULT_SCAN_EXCLUDES,
    buildScanArgs,
    getScanExcludes,
    isCoBoltRuntimeToolsMirror,
    filterExcludedFindings,
    filterIgnoredFindings,
    isDefaultExcludedPath,
    isLocalSecretFilePath,
    parsedToolErrors,
    isSemgrepBlockingError,
    pathSegmentExcludeRegex,
    writeGitleaksAllowlistConfig,
    writeSemgrepCoreConfig,
    quietJsonPayload,
  },
};

// ── CLI ──────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};
  let projectDir = process.cwd();
  let dockerMode = 'auto'; // 'auto' | 'force' | 'off'

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--category' && args[i + 1]) {
      options.category = args[++i];
    } else if (args[i] === '--priority' && args[i + 1]) {
      options.priority = args[++i];
    } else if (args[i] === '--json') {
      options.json = true;
    } else if (args[i] === '--quiet-json') {
      options.json = true;
      options.quietJson = true;
    } else if (args[i] === '--output' && args[i + 1]) {
      options.output = args[++i];
    } else if (args[i] === '--save') {
      options.save = true;
    } else if (args[i] === '--docker') {
      dockerMode = 'force';
    } else if (args[i] === '--no-docker') {
      dockerMode = 'off';
    } else if (args[i] === '--docker-pull') {
      // Pre-pull all Docker images and exit
      if (!isDockerAvailable()) {
        console.error('  Docker is not available. Install Docker Desktop first.');
        process.exit(1);
      }
      console.log('\n  Pulling Docker images for all security tools...\n');
      const result = pullAllImages({
        priority: options.priority,
        category: options.category,
        onProgress: (msg) => console.log(`  ${msg}`),
      });
      console.log(
        `\n  Pulled: ${result.pulled.length} | Already cached: ${result.skipped.length} | Failed: ${result.failed.length}`,
      );
      if (result.failed.length > 0) {
        for (const f of result.failed) console.log(`    Failed: ${f.name} — ${f.message}`);
      }
      process.exit(result.failed.length > 0 ? 1 : 0);
    } else if (args[i] === '--parallel') {
      options.parallel = true;
    } else if (args[i] === '--help') {
      console.log('  Usage: node tools/cobolt-scan.js [project-path] [options]');
      console.log('  Options:');
      console.log('    --category <cat>     Filter by category (sast|deps|secrets|dast|iac|supply-chain|container)');
      console.log('    --priority <pri>     Filter by priority (core|recommended|optional)');
      console.log('    --parallel           Run tools in parallel (grouped by category)');
      console.log('    --docker             Force ALL tools to run via Docker containers');
      console.log('    --no-docker          Disable Docker fallback, native tools only');
      console.log('    --docker-pull        Pre-pull all Docker images and exit');
      console.log('    --json|--quiet-json  JSON output');
      console.log('    --output <path>      Write report to custom path');
      console.log('    --save               Save report to _cobolt-output');
      process.exit(0);
    } else if (!args[i].startsWith('--')) {
      projectDir = path.resolve(args[i]);
    }
  }

  const scannerOpts = {
    dockerFallback: dockerMode !== 'off',
    forceDocker: dockerMode === 'force',
  };

  const scanner = new SecurityScanner(projectDir, scannerOpts);

  // Use async parallel mode if --parallel, otherwise sync sequential
  const runScan = async () => {
    if (options.parallel) {
      await scanner.runAllParallel(options);
    } else {
      scanner.runAll(options);
    }
    return scanner.report();
  };

  runScan()
    .then((reportData) => {
      const savedPath = options.output ? writeReportFile(options.output, reportData) : scanner.save();

      if (options.json && options.quietJson && options.output) {
        console.log(JSON.stringify(quietJsonPayload(reportData, savedPath), null, 2));
      } else if (options.json) {
        console.log(JSON.stringify(reportData, null, 2));
      } else {
        const r = reportData;
        console.log();
        console.log('  ══════════════════════════════════════════════');
        console.log('  CoBolt Security Scan Report');
        console.log('  ══════════════════════════════════════════════');
        console.log(
          `  Tools: ${r.summary.toolsRun} | Pass: ${r.summary.passed} | Findings: ${r.summary.withFindings} | Errors: ${r.summary.errors}`,
        );
        console.log(`  Total findings: ${r.summary.totalFindings}`);
        console.log(`  Posture: ${r.summary.posture} — ${r.summary.postureReason}`);
        if (r.summary.dockerTools > 0) {
          console.log(`  Docker: ${r.summary.dockerTools} tools | Native: ${r.summary.nativeTools} tools`);
        }
        console.log('  ══════════════════════════════════════════════');
        if (r.summary.posture === 'UNKNOWN') {
          console.log('  [!] POSTURE UNKNOWN: core tool(s) failed. totalFindings cannot be trusted.');
          console.log('  [!] Fix scanner errors before relying on this report. (exit 2)');
        } else if (r.summary.posture === 'DEGRADED') {
          console.log('  [!] DEGRADED: non-core tool(s) errored; core tools ran clean.');
        }
      }

      if (!options.json || options.save) {
        console.log(`  Report saved: ${savedPath}`);
      }
      process.exit(reportData.summary.exitCode);
    })
    .catch((err) => {
      process.stderr.write(`Fatal: ${err.message}\n`);
      process.exit(1);
    });
}
