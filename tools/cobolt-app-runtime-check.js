#!/usr/bin/env node

// CoBolt App Runtime Check - verifies that a built application has a runnable surface.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { CoboltPaths } = require('../lib/cobolt-paths');

const DEFAULT_TIMEOUT_MS = 90 * 1000;
const SERVER_DEPS = new Set([
  'express',
  'fastify',
  'koa',
  'hono',
  '@nestjs/core',
  'graphql',
  'apollo-server',
  'next',
  'vite',
  '@vitejs/plugin-react',
  'react-scripts',
  '@sveltejs/kit',
  'astro',
]);

function parseArgs(argv = process.argv.slice(2)) {
  const flags = {
    command: 'check',
    cwd: process.cwd(),
    milestone: null,
    json: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    baseUrl: null,
    noStart: false,
  };

  if (argv[0] && !argv[0].startsWith('-')) flags.command = argv.shift();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd') flags.cwd = path.resolve(argv[++i] || flags.cwd);
    else if (arg === '--milestone') flags.milestone = normalizeMilestone(argv[++i] || '');
    else if (arg === '--json') flags.json = true;
    else if (arg === '--timeout-ms') flags.timeoutMs = Number(argv[++i] || DEFAULT_TIMEOUT_MS);
    else if (arg === '--base-url') flags.baseUrl = argv[++i] || null;
    else if (arg === '--no-start') flags.noStart = true;
    else if (!arg.startsWith('-') && !flags.milestone) flags.milestone = normalizeMilestone(arg);
  }
  return flags;
}

function normalizeMilestone(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return /^m\d+$/i.test(raw) ? raw.toUpperCase() : raw;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, ''));
  } catch {
    return null;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, '');
  } catch {
    return '';
  }
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function packageJson(cwd) {
  return readJson(path.join(cwd, 'package.json')) || {};
}

function dependencyNames(pkg) {
  return Object.keys({
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
    ...(pkg.peerDependencies || {}),
  });
}

function planningText(cwd) {
  const dir = new CoboltPaths(cwd).latestPlanning();
  const files = [
    'prd.md',
    'feature-prd.md',
    'api-contracts.md',
    'ux-design-specification.md',
    // wireframes content is read via the resolver below — it spans the
    // per-surface fan-out (v2.1+) and falls back to the merged file when only
    // the legacy layout exists.
    'architecture.md',
    'delivery-plan.md',
  ];
  const baseText = files.map((file) => readText(path.join(dir, file))).join('\n');
  // v2.1+: include all wireframe surfaces — per-surface files carry the
  // screen-level detail this textual analysis benefits from.
  const wireframeResolver = require('./../lib/cobolt-wireframe-resolver');
  const wireframeText = wireframeResolver.readAllWireframeContent({
    cwd,
    includeFoundations: false,
    includeReadme: true,
  });
  return wireframeText ? `${baseText}\n${wireframeText}` : baseText;
}

function detectUi(cwd) {
  try {
    const detector = require('./cobolt-ui-detection');
    if (detector?.detectUIProject) return detector.detectUIProject(cwd);
  } catch {
    /* fall through */
  }
  return { hasUI: false, signals: [], frameworks: [] };
}

function walkProjectFiles(cwd, predicate, options = {}) {
  const ignored = new Set([
    '.git',
    'node_modules',
    '_cobolt-output',
    'bin',
    'obj',
    'dist',
    'build',
    ...(options.ignored || []),
  ]);
  const matches = [];
  const stack = [cwd];
  while (stack.length && matches.length < (options.limit || 200)) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) stack.push(full);
      } else if (predicate(full, entry.name)) {
        matches.push(full);
      }
    }
  }
  return matches;
}

function findDotnetDesktopProject(cwd) {
  const projects = walkProjectFiles(cwd, (_full, name) => name.endsWith('.csproj'), { limit: 100 });
  for (const projectPath of projects) {
    const text = readText(projectPath);
    const targetFramework =
      text.match(/<TargetFramework>\s*([^<]+)\s*<\/TargetFramework>/iu)?.[1]?.trim() ||
      text.match(/<TargetFrameworks>\s*([^<;]+)[^<]*<\/TargetFrameworks>/iu)?.[1]?.trim() ||
      null;
    const useWpf = /<UseWPF>\s*true\s*<\/UseWPF>/iu.test(text);
    const useWinForms = /<UseWindowsForms>\s*true\s*<\/UseWindowsForms>/iu.test(text);
    const winExe = /<OutputType>\s*WinExe\s*<\/OutputType>/iu.test(text);
    const windowsTarget = /net\d+(?:\.\d+)?-windows/iu.test(targetFramework || text);
    if (!useWpf && !useWinForms && !(winExe && windowsTarget)) continue;

    return {
      projectPath,
      relativeProjectPath: path.relative(cwd, projectPath).replace(/\\/g, '/'),
      projectName: path.basename(projectPath, '.csproj'),
      targetFramework,
      framework: useWpf ? 'dotnet-wpf' : useWinForms ? 'dotnet-winforms' : 'dotnet-windows-desktop',
    };
  }
  return null;
}

function detectSurfaces(cwd) {
  const pkg = packageJson(cwd);
  const deps = dependencyNames(pkg);
  const text = planningText(cwd);
  const lowerText = text.toLowerCase();
  const ui = detectUi(cwd);
  const desktop = findDotnetDesktopProject(cwd);
  const planningDir = new CoboltPaths(cwd).latestPlanning();
  const apiContractsText = readText(path.join(planningDir, 'api-contracts.md'));
  const noHttpApiContract = /\b(no|n\/a|not applicable)\b.{0,40}\b(http|external|public|rest)?\s*api\b/iu.test(
    apiContractsText,
  );

  const hasApi =
    !noHttpApiContract &&
    (fs.existsSync(path.join(planningDir, 'api-contracts.md')) ||
      fs.existsSync(path.join(cwd, 'openapi.json')) ||
      fs.existsSync(path.join(cwd, 'openapi.yaml')) ||
      deps.some((dep) => SERVER_DEPS.has(dep)) ||
      /\b(api|endpoint|graphql|webhook|http route|rest)\b/u.test(lowerText));

  const planningOnlyWebIntent =
    !ui.nonUiDeclared &&
    /\b(ui|frontend|browser|screen|dashboard|wireframe|user flow|web app|landing page)\b/u.test(lowerText);
  const hasWebIntent = ui.hasUI || planningOnlyWebIntent;

  const hasServerFiles =
    fs.existsSync(path.join(cwd, 'mix.exs')) ||
    fs.existsSync(path.join(cwd, 'go.mod')) ||
    fs.existsSync(path.join(cwd, 'requirements.txt')) ||
    fs.existsSync(path.join(cwd, 'pyproject.toml'));

  const hasServerDeps = deps.some((dep) => SERVER_DEPS.has(dep));
  const hasCli = Boolean(pkg.bin) || fs.existsSync(path.join(cwd, 'cli', 'index.js'));
  const hasLibrary = Boolean(pkg.main || pkg.exports);
  const requiresRuntime = Boolean(desktop || hasWebIntent || hasApi || hasServerFiles || hasServerDeps);

  return {
    requiresRuntime,
    hasUI: Boolean(desktop || ui.hasUI || hasWebIntent),
    hasApi: Boolean(hasApi),
    hasDesktop: Boolean(desktop),
    desktop,
    hasCli,
    hasLibrary,
    signals: unique([
      ...(ui.signals || []).map((signal) => `ui:${signal}`),
      desktop ? 'desktop-app' : null,
      hasApi ? 'api-surface' : null,
      hasWebIntent ? 'web-intent' : null,
      hasServerFiles ? 'server-manifest' : null,
      hasServerDeps ? 'server-dependency' : null,
      hasCli ? 'cli-surface' : null,
      hasLibrary ? 'library-surface' : null,
    ]),
    frameworks: unique([...(ui.frameworks || []), desktop?.framework]),
    packageScripts: Object.keys(pkg.scripts || {}),
  };
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

const SHELL_OPERATOR_RX = /(?:&&|\|\||[|<>;`]|[$][(]|\r|\n)/u;

function tokenizeCommandLine(value) {
  const input = String(value || '').trim();
  if (!input) return { tokens: [] };
  if (SHELL_OPERATOR_RX.test(input)) {
    return { error: 'shell operators are not allowed in app start commands' };
  }

  const tokens = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && i + 1 < input.length) {
        current += input[++i];
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/u.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (quote) return { error: 'unterminated quote in app start command' };
  if (current) tokens.push(current);
  return { tokens };
}

function envStartCommand(value, source) {
  const display = String(value || '').trim();
  const parsed = tokenizeCommandLine(display);
  if (parsed.error) {
    return { source, command: null, args: [], shell: false, display, invalid: true, error: parsed.error };
  }
  if (!parsed.tokens.length) return null;
  const [rawCommand, ...args] = parsed.tokens;
  const command = /^npm(?:\.cmd)?$/iu.test(rawCommand) ? npmCommand() : rawCommand;
  return { source, command, args, shell: false, display };
}

function detectStartCommand(cwd) {
  const envCommand = process.env.COBOLT_APP_START_COMMAND || process.env.APP_START_COMMAND;
  if (envCommand) return envStartCommand(envCommand, 'env');

  const pkg = packageJson(cwd);
  const scripts = pkg.scripts || {};
  for (const script of ['cobolt:serve', 'serve', 'start', 'dev', 'preview']) {
    if (scripts[script]) {
      return {
        source: `package.json:scripts.${script}`,
        command: npmCommand(),
        args: ['run', script],
        shell: false,
        display: `npm run ${script}`,
      };
    }
  }

  if (fs.existsSync(path.join(cwd, 'mix.exs'))) {
    return { source: 'mix.exs', command: 'mix', args: ['phx.server'], shell: false, display: 'mix phx.server' };
  }
  if (fs.existsSync(path.join(cwd, 'go.mod'))) {
    const candidates = ['cmd/api', 'cmd/server', '.'];
    const target = candidates.find((candidate) => {
      const full = path.join(cwd, candidate);
      return fs.existsSync(path.join(full, 'main.go'));
    });
    if (target) {
      return {
        source: 'go.mod',
        command: 'go',
        args: ['run', `./${target}`],
        shell: false,
        display: `go run ./${target}`,
      };
    }
  }
  if (fs.existsSync(path.join(cwd, 'pyproject.toml')) || fs.existsSync(path.join(cwd, 'requirements.txt'))) {
    for (const app of ['main:app', 'app:app', 'server:app']) {
      const file = app.split(':')[0];
      if (fs.existsSync(path.join(cwd, `${file}.py`))) {
        return {
          source: `${file}.py`,
          command: 'python',
          args: ['-m', 'uvicorn', app, '--host', '127.0.0.1', '--port', '8000'],
          shell: false,
          display: `python -m uvicorn ${app}`,
        };
      }
    }
  }

  return null;
}

function inferBaseUrls(cwd, explicitBaseUrl, surfaces) {
  const pkg = packageJson(cwd);
  const infra = readJson(new CoboltPaths(cwd).infraManifest()) || {};
  const values = [
    explicitBaseUrl,
    process.env.APP_URL,
    process.env.BASE_URL,
    pkg.cobolt?.runtime?.baseUrl,
    pkg.cobolt?.baseUrl,
    stripHealthPath(infra.compute?.health_endpoint || infra.compute?.healthEndpoint),
    infra.staging?.url,
    infra.url,
  ];

  const depSet = new Set(dependencyNames(pkg));
  if (depSet.has('vite') || depSet.has('@vitejs/plugin-react')) values.push('http://127.0.0.1:5173');
  if (depSet.has('next') || depSet.has('react-scripts') || (surfaces.hasUI && !surfaces.hasDesktop)) {
    values.push('http://127.0.0.1:3000');
  }
  if (fs.existsSync(path.join(cwd, 'mix.exs'))) values.push('http://127.0.0.1:4000');
  if (fs.existsSync(path.join(cwd, 'go.mod')) || surfaces.hasApi) values.push('http://127.0.0.1:8080');
  if (fs.existsSync(path.join(cwd, 'pyproject.toml')) || fs.existsSync(path.join(cwd, 'requirements.txt'))) {
    values.push('http://127.0.0.1:8000');
  }

  return unique(values.map(normalizeBaseUrl));
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return raw.replace(/\/+$/u, '');
}

function stripHealthPath(value) {
  const url = normalizeBaseUrl(value);
  if (!url) return null;
  return url.replace(/\/(?:api\/)?(?:health|ready|live)$/iu, '');
}

function buildProbeTargets(baseUrls, surfaces) {
  const paths = surfaces.hasUI ? ['/', '/login'] : ['/health', '/api/health', '/ready', '/'];
  if (surfaces.hasUI && surfaces.hasApi) paths.push('/health', '/api/health');

  const targets = [];
  for (const baseUrl of baseUrls) {
    for (const probePath of unique(paths)) {
      targets.push(`${baseUrl}${probePath}`);
    }
  }
  return targets;
}

async function probeUrl(url, timeoutMs) {
  const startedAt = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(timeoutMs, 5000));
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    clearTimeout(timeout);
    const text = await response.text().catch(() => '');
    return {
      url,
      status: response.status,
      ok: response.status >= 200 && response.status < 400,
      durationMs: Date.now() - startedAt,
      bodyBytes: Buffer.byteLength(text || ''),
    };
  } catch (err) {
    return {
      url,
      status: 0,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: err?.name === 'AbortError' ? 'timeout' : err?.message || 'request failed',
    };
  }
}

async function probeUntilReady(targets, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  const attempts = [];

  while (Date.now() < deadline) {
    if (child?.exitCode !== null) break;
    for (const target of targets) {
      const result = await probeUrl(target, Math.min(5000, deadline - Date.now()));
      attempts.push(result);
      if (result.ok) return { passed: true, target: result, attempts };
    }
    await sleep(1000);
  }

  return { passed: false, attempts };
}

function isWindowsCommandScript(command, platform = process.platform) {
  return platform === 'win32' && /\.(?:cmd|bat)$/iu.test(String(command || ''));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startRuntime(cwd, startCommand, baseUrls) {
  const env = { ...process.env };
  if (baseUrls[0]) {
    env.APP_URL = baseUrls[0];
    env.BASE_URL = baseUrls[0];
  }

  const child = spawn(startCommand.command, startCommand.args || [], {
    cwd,
    env,
    shell: isWindowsCommandScript(startCommand.command),
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output = { stdout: '', stderr: '' };
  child.stdout?.on('data', (chunk) => {
    output.stdout = trim(`${output.stdout}${chunk.toString()}`, 6000);
  });
  child.stderr?.on('data', (chunk) => {
    output.stderr = trim(`${output.stderr}${chunk.toString()}`, 6000);
  });

  return { child, output };
}

function stopRuntime(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already stopped */
    }
  }
}

function trim(value, limit) {
  const text = String(value || '');
  if (text.length <= limit) return text;
  return text.slice(-limit);
}

function verifyCliSurface(cwd) {
  const pkg = packageJson(cwd);
  const missing = [];
  const bins = typeof pkg.bin === 'string' ? { [pkg.name || 'cli']: pkg.bin } : pkg.bin || {};
  for (const [name, target] of Object.entries(bins)) {
    if (!fs.existsSync(path.join(cwd, target))) missing.push(`${name}:${target}`);
  }
  if (!pkg.bin && fs.existsSync(path.join(cwd, 'cli', 'index.js'))) return { passed: true, missing: [] };
  return { passed: missing.length === 0, missing };
}

function dotnetCommand() {
  return process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';
}

function isChildProcessDeniedError(error) {
  const message = String(error?.message || '');
  return error?.code === 'EPERM' || error?.code === 'EACCES' || /\b(?:EPERM|EACCES)\b/u.test(message);
}

function dotnetRuntimeEnv(cwd) {
  const cacheRoot = path.join(cwd, '_cobolt-output', '.dotnet-runtime-cache');
  return {
    ...process.env,
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    DOTNET_NOLOGO: '1',
    MSBUILDDISABLENODEREUSE: '1',
    DOTNET_CLI_HOME: cacheRoot,
    NUGET_PACKAGES: path.join(cacheRoot, 'nuget'),
    TMP: path.join(cacheRoot, 'tmp'),
    TEMP: path.join(cacheRoot, 'tmp'),
  };
}

function dotnetBuildArgs(projectPath) {
  return ['build', projectPath, '--disable-build-servers', '-m:1', '/nr:false', '/p:UseSharedCompilation=false'];
}

function spawnDotnetBuild(cwd, desktop, env, timeoutMs, runner = spawnSync) {
  const args = dotnetBuildArgs(desktop.projectPath);
  const options = {
    cwd,
    env,
    encoding: 'utf8',
    timeout: Math.max(timeoutMs, 30000),
    windowsHide: true,
    shell: false,
  };
  let child = runner(dotnetCommand(), args, options);
  if (process.platform === 'win32' && child?.error && isChildProcessDeniedError(child.error)) {
    child = runner(dotnetCommand(), args, { ...options, shell: true });
    if (child?.error) {
      child.error.message = `${child.error.message}; shell fallback after EPERM also failed`;
    }
  }
  return child;
}

function dotnetBuildFallbackCommand(cwd, desktop) {
  const projectLiteral = String(desktop.projectPath).replace(/'/g, "''");
  const logPath = path.join(cwd, '_cobolt-output', 'latest', 'runtime', 'desktop-runtime-build-fallback.log');
  return [
    "$env:DOTNET_CLI_TELEMETRY_OPTOUT='1'",
    "$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE='1'",
    "$env:DOTNET_NOLOGO='1'",
    "$env:MSBUILDDISABLENODEREUSE='1'",
    "$env:DOTNET_CLI_HOME=(Join-Path (Get-Location) '_cobolt-output\\.dotnet-runtime-cache')",
    "$env:NUGET_PACKAGES=(Join-Path $env:DOTNET_CLI_HOME 'nuget')",
    "$env:TMP=(Join-Path $env:DOTNET_CLI_HOME 'tmp')",
    '$env:TEMP=$env:TMP',
    `$log='${logPath.replace(/'/g, "''")}'`,
    'New-Item -ItemType Directory -Force -Path $env:DOTNET_CLI_HOME,$env:NUGET_PACKAGES,$env:TMP,(Split-Path $log -Parent) | Out-Null',
    `$output = & '${dotnetCommand()}' build '${projectLiteral}' --disable-build-servers -m:1 /nr:false /p:UseSharedCompilation=false 2>&1 | ForEach-Object { $_.ToString() }`,
    '$code=$LASTEXITCODE',
    `& '${dotnetCommand()}' build-server shutdown 2>$null | Out-Null`,
    '[System.IO.File]::WriteAllText($log, (($output -join [Environment]::NewLine) + [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))',
    'Get-Content $log -Raw',
    'exit $code',
  ].join('; ');
}

function writeChildProcessDeniedRuntimeContract(cwd, details) {
  const contractPath = path.join(cwd, '_cobolt-output', 'latest', 'runtime', 'app-runtime-child-process-denied.json');
  writeJson(contractPath, {
    status: 'blocked',
    marker: 'COBOLT_CHILD_PROCESS_DENIED',
    generatedAt: new Date().toISOString(),
    framework: 'dotnet-desktop',
    reason: 'Node child_process execution is blocked before desktop runtime verification can run.',
    ...details,
  });
  return path.relative(cwd, contractPath).replace(/\\/g, '/');
}

function shellQuote(value) {
  const text = String(value || '');
  if (process.platform === 'win32') return `'${text.replace(/'/g, "''")}'`;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function appRuntimeFallbackCommand(cwd, startCommand) {
  const command = [startCommand.command, ...(startCommand.args || [])].filter(Boolean).map(shellQuote).join(' ');
  const logPath = path.join(cwd, '_cobolt-output', 'latest', 'runtime', 'app-runtime-start-fallback.log');
  if (process.platform === 'win32') {
    return [
      `$log='${logPath.replace(/'/g, "''")}'`,
      'New-Item -ItemType Directory -Force -Path (Split-Path $log -Parent) | Out-Null',
      `$output = & ${command} 2>&1 | ForEach-Object { $_.ToString() }`,
      '$code=$LASTEXITCODE',
      '[System.IO.File]::WriteAllText($log, (($output -join [Environment]::NewLine) + [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))',
      'Get-Content $log -Raw',
      'exit $code',
    ].join('; ');
  }
  return `${command} > ${shellQuote(logPath)} 2>&1`;
}

function writeAppChildProcessDeniedRuntimeContract(cwd, startCommand, error) {
  const fallbackCommand = appRuntimeFallbackCommand(cwd, startCommand);
  const contractPath = path.join(cwd, '_cobolt-output', 'latest', 'runtime', 'app-runtime-child-process-denied.json');
  writeJson(contractPath, {
    status: 'blocked',
    marker: 'COBOLT_CHILD_PROCESS_DENIED',
    generatedAt: new Date().toISOString(),
    framework: 'web-or-api-runtime',
    phase: 'app-start',
    startCommand: startCommand.display || [startCommand.command, ...(startCommand.args || [])].join(' '),
    error: error?.message || String(error || 'child process denied'),
    fallbackCommand,
    fallbackLog: '_cobolt-output/latest/runtime/app-runtime-start-fallback.log',
  });
  return {
    fallbackCommand,
    fallbackContract: path.relative(cwd, contractPath).replace(/\\/g, '/'),
  };
}

function findBuiltDesktopExecutable(_cwd, desktop) {
  const projectDir = path.dirname(desktop.projectPath);
  const candidates = walkProjectFiles(
    path.join(projectDir, 'bin'),
    (_full, name) => name.toLowerCase() === `${desktop.projectName.toLowerCase()}.exe`,
    { ignored: [], limit: 20 },
  );
  return candidates.sort((a, b) => b.length - a.length)[0] || null;
}

async function runDotnetDesktopRuntime(cwd, desktop, options = {}) {
  if (process.platform !== 'win32') {
    return {
      passed: false,
      blocker: {
        id: 'desktop-runtime-platform-unsupported',
        message: 'Windows desktop runtime verification requires a Windows host.',
      },
    };
  }

  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const stableMs = Math.min(Math.max(Number(options.stableMs || 4000), 1000), Math.max(timeoutMs, 1000));
  const env = dotnetRuntimeEnv(cwd);
  fs.mkdirSync(env.TMP, { recursive: true });
  fs.mkdirSync(env.NUGET_PACKAGES, { recursive: true });

  const build = spawnDotnetBuild(cwd, desktop, env, timeoutMs, options.spawnSyncRunner);
  if (build?.error && isChildProcessDeniedError(build.error)) {
    const fallbackCommand = dotnetBuildFallbackCommand(cwd, desktop);
    const fallbackContract = writeChildProcessDeniedRuntimeContract(cwd, {
      phase: 'desktop-build',
      projectPath: path.relative(cwd, desktop.projectPath).replace(/\\/g, '/'),
      error: build.error.message,
      fallbackCommand,
      fallbackLog: '_cobolt-output/latest/runtime/desktop-runtime-build-fallback.log',
    });
    return {
      passed: false,
      blockedBySandbox: true,
      buildExitCode: build.status,
      stdout: trim(build.stdout || '', 6000),
      stderr: trim(build.stderr || build.error.message || '', 6000),
      fallbackCommand,
      fallbackContract,
      blocker: {
        id: 'desktop-runtime-child-process-denied',
        message:
          'Node child_process execution was denied before desktop runtime verification could run. A CoBolt fallback command and contract were written.',
      },
    };
  }
  if (build.status !== 0) {
    return {
      passed: false,
      buildExitCode: build.status,
      stdout: trim(build.stdout || '', 6000),
      stderr: trim(build.stderr || build.error?.message || '', 6000),
      blocker: {
        id: 'desktop-runtime-build-failed',
        message: `Desktop project failed to build before runtime verification (exit ${build.status}).`,
      },
    };
  }

  const executable = findBuiltDesktopExecutable(cwd, desktop);
  if (!executable) {
    return {
      passed: false,
      buildExitCode: build.status,
      blocker: {
        id: 'desktop-runtime-executable-missing',
        message: `Desktop build passed, but ${desktop.projectName}.exe was not found under the project bin directory.`,
      },
    };
  }

  const child = spawn(executable, [], {
    cwd: path.dirname(executable),
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  let exit = null;
  child.stdout?.on('data', (chunk) => {
    output.stdout = trim(`${output.stdout}${chunk.toString()}`, 6000);
  });
  child.stderr?.on('data', (chunk) => {
    output.stderr = trim(`${output.stderr}${chunk.toString()}`, 6000);
  });
  child.on('exit', (code, signal) => {
    exit = { code, signal };
  });

  await sleep(stableMs);
  const stayedAlive = exit === null;
  if (stayedAlive) stopRuntime(child);

  return {
    passed: stayedAlive,
    executable: path.relative(cwd, executable).replace(/\\/g, '/'),
    stableMs,
    runtimeStdoutTail: output.stdout,
    runtimeStderrTail: output.stderr,
    exit,
    blocker: stayedAlive
      ? null
      : {
          id: 'desktop-runtime-exited',
          message: `Desktop application exited before the ${stableMs}ms startup stability window completed.`,
        },
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, value, { encoding: 'utf8', mode: 0o600 });
}

function renderMarkdown(result) {
  const lines = [
    '# App Runtime Check',
    '',
    `- Status: ${result.status}`,
    `- Milestone: ${result.milestone || 'not specified'}`,
    `- Runtime required: ${result.surfaces.requiresRuntime ? 'yes' : 'no'}`,
    `- Start command: ${result.startCommand?.display || 'none'}`,
    `- Base URLs: ${result.baseUrls.length ? result.baseUrls.join(', ') : 'none'}`,
  ];

  if (result.blockers.length) {
    lines.push('', '## Blockers', '');
    for (const blocker of result.blockers) lines.push(`- ${blocker.id}: ${blocker.message}`);
  }

  if (result.probes.length) {
    lines.push('', '## Probe Attempts', '');
    for (const probe of result.probes.slice(-10)) {
      lines.push(
        `- ${probe.ok ? 'PASS' : 'FAIL'} ${probe.url} status=${probe.status}${probe.error ? ` error=${probe.error}` : ''}`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

function writeReports(cwd, result) {
  const paths = new CoboltPaths(cwd);
  const runtimeDir = path.join(paths.latest(), 'runtime');
  const reportDir = paths.reports('project');
  const jsonPath = path.join(runtimeDir, 'app-runtime-check.json');
  const mdPath = path.join(runtimeDir, 'app-runtime-check.md');
  const projectMdPath = path.join(reportDir, 'app-runtime-check.md');
  result.artifacts = {
    json: path.relative(cwd, jsonPath).replace(/\\/g, '/'),
    markdown: path.relative(cwd, mdPath).replace(/\\/g, '/'),
    projectReport: path.relative(cwd, projectMdPath).replace(/\\/g, '/'),
  };
  writeJson(jsonPath, result);
  const markdown = renderMarkdown(result);
  writeText(mdPath, markdown);
  writeText(projectMdPath, markdown);
}

async function checkAppRuntime(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const milestone = normalizeMilestone(options.milestone);
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const surfaces = detectSurfaces(cwd);
  const startCommand = detectStartCommand(cwd);
  const baseUrls = inferBaseUrls(cwd, options.baseUrl, surfaces);
  const result = {
    version: 1,
    generatedAt: new Date().toISOString(),
    milestone,
    status: 'failed',
    surfaces,
    startCommand,
    baseUrls,
    probes: [],
    blockers: [],
    runtimeStdoutTail: '',
    runtimeStderrTail: '',
    artifacts: {},
  };

  if (!surfaces.requiresRuntime) {
    const cli = verifyCliSurface(cwd);
    if (!cli.passed) {
      result.blockers.push({
        id: 'cli-bin-missing',
        message: `CLI package declares bin targets that do not exist: ${cli.missing.join(', ')}`,
      });
    }
    result.status = result.blockers.length ? 'failed' : 'passed';
    if (!result.blockers.length) {
      result.reason =
        surfaces.hasCli || surfaces.hasLibrary
          ? 'non-server package surface verified'
          : 'no executable app surface detected';
    }
    writeReports(cwd, result);
    return result;
  }

  if (surfaces.hasDesktop) {
    const desktopResult = options.desktopRuntimeRunner
      ? await options.desktopRuntimeRunner({ cwd, desktop: surfaces.desktop, timeoutMs })
      : await runDotnetDesktopRuntime(cwd, surfaces.desktop, {
          timeoutMs,
          stableMs: options.desktopStableMs,
        });
    result.desktopRuntime = desktopResult;
    result.runtimeStdoutTail = desktopResult.runtimeStdoutTail || desktopResult.stdout || '';
    result.runtimeStderrTail = desktopResult.runtimeStderrTail || desktopResult.stderr || '';
    if (desktopResult.passed) {
      result.status = 'passed';
      result.reason = 'desktop application built and remained alive through the startup stability window';
    } else if (desktopResult.blockedBySandbox) {
      result.status = 'blocked';
      result.reason = 'desktop runtime verification was blocked by child_process execution denial';
      result.fallbackCommand = desktopResult.fallbackCommand;
      result.fallbackContract = desktopResult.fallbackContract;
      if (desktopResult.blocker) result.blockers.push(desktopResult.blocker);
    } else if (desktopResult.blocker) {
      result.blockers.push(desktopResult.blocker);
    } else {
      result.blockers.push({
        id: 'desktop-runtime-failed',
        message: 'Desktop runtime verification failed.',
      });
    }
    writeReports(cwd, result);
    return result;
  }

  if (!startCommand) {
    result.blockers.push({
      id: 'app-start-command-missing',
      message: 'Application surface detected, but no start/dev/serve command or framework entry point was found.',
    });
    writeReports(cwd, result);
    return result;
  }

  if (startCommand.invalid) {
    result.blockers.push({
      id: 'app-start-command-unsafe',
      message: `Application start command from ${startCommand.source} is not executable without a shell: ${startCommand.error}.`,
    });
    writeReports(cwd, result);
    return result;
  }

  if (baseUrls.length === 0) {
    result.blockers.push({
      id: 'app-base-url-missing',
      message: 'Application surface detected, but no base URL could be inferred or supplied.',
    });
    writeReports(cwd, result);
    return result;
  }

  const targets = buildProbeTargets(baseUrls, surfaces);

  if (options.noStart) {
    const probe = await probeUntilReady(targets, timeoutMs, null);
    result.probes = probe.attempts;
    if (probe.passed) result.status = 'passed';
    else {
      result.blockers.push({
        id: 'app-runtime-unreachable',
        message: 'No running application responded on the declared or inferred base URL.',
      });
    }
    writeReports(cwd, result);
    return result;
  }

  let runtime = null;
  try {
    const runtimeStarter = options.runtimeStarter || startRuntime;
    runtime = runtimeStarter(cwd, startCommand, baseUrls);
    const probe = await probeUntilReady(targets, timeoutMs, runtime.child);
    result.probes = probe.attempts;
    result.runtimeStdoutTail = runtime.output.stdout;
    result.runtimeStderrTail = runtime.output.stderr;
    if (probe.passed) {
      result.status = 'passed';
      result.readyUrl = probe.target.url;
      result.readyStatus = probe.target.status;
    } else {
      result.blockers.push({
        id: runtime.child.exitCode === null ? 'app-runtime-unreachable' : 'app-runtime-exited',
        message:
          runtime.child.exitCode === null
            ? 'Application process started but no probe URL returned HTTP 2xx/3xx before timeout.'
            : `Application process exited before a probe passed (exit ${runtime.child.exitCode}).`,
      });
    }
  } catch (err) {
    if (isChildProcessDeniedError(err)) {
      const fallback = writeAppChildProcessDeniedRuntimeContract(cwd, startCommand, err);
      result.status = 'blocked';
      result.reason = 'app runtime verification was blocked by child_process execution denial';
      result.fallbackCommand = fallback.fallbackCommand;
      result.fallbackContract = fallback.fallbackContract;
      result.blockers.push({
        id: 'app-runtime-child-process-denied',
        message:
          'Node child_process execution was denied before application runtime verification could start. A CoBolt fallback command and contract were written.',
      });
    } else {
      result.blockers.push({
        id: 'app-runtime-start-failed',
        message: err?.message || 'Application runtime failed to start.',
      });
    }
  } finally {
    if (runtime?.child) {
      result.runtimeStdoutTail = runtime.output.stdout;
      result.runtimeStderrTail = runtime.output.stderr;
      stopRuntime(runtime.child);
    }
  }

  writeReports(cwd, result);
  return result;
}

async function main() {
  const flags = parseArgs();
  if (flags.command !== 'check') {
    console.error(
      'Usage: cobolt-app-runtime-check.js check [--milestone M5] [--base-url URL] [--json] [--timeout-ms 90000]',
    );
    return 2;
  }
  const result = await checkAppRuntime(flags);
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`App runtime check - ${result.status.toUpperCase()}`);
    if (result.blockers.length) {
      console.log('Blockers:');
      for (const blocker of result.blockers) console.log(`- ${blocker.id}: ${blocker.message}`);
    }
    console.log(`Report: ${result.artifacts.markdown}`);
  }
  return result.status === 'passed' ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => process.exit(code || 0));
}

module.exports = {
  checkAppRuntime,
  parseArgs,
  detectSurfaces,
  detectStartCommand,
  findDotnetDesktopProject,
  isWindowsCommandScript,
  runDotnetDesktopRuntime,
  tokenizeCommandLine,
  inferBaseUrls,
  buildProbeTargets,
};
