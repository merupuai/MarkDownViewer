#!/usr/bin/env node

// CoBolt Runtime Truth - deterministic compile/build/test execution proof
//
// Detects common backend/frontend manifests and runs their build/typecheck/test
// commands to produce runtime-truth.json for brownfield gating.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildProvenance, hashStructuredInput } = require('./_brownfield-provenance');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function uniqueCommands(commands) {
  const seen = new Set();
  return commands.filter((command) => {
    const key = `${command.cwd}::${command.command}::${command.args.join(' ')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function existingDirs(projectDir, relativeDirs) {
  return relativeDirs
    .map((relativeDir) => path.join(projectDir, relativeDir))
    .filter((fullPath) => fs.existsSync(fullPath));
}

function platformCommand(baseName) {
  // pnpm and yarn ship as .cmd shims on Windows, same as npm. bun ships as
  // bun.exe and is invoked plainly. Forgetting pnpm/yarn here was the second
  // half of the npm-monoculture bug — a Bun-only project with `pnpm` declared
  // would still stderr 'pnpm is not recognized' on Windows runtime-truth runs.
  if (
    process.platform === 'win32' &&
    ['npm', 'pnpm', 'yarn', 'mvn', 'gradle', 'composer', 'bundle'].includes(baseName)
  ) {
    return `${baseName}.cmd`;
  }
  return baseName;
}

function wrapperCommand(dir, unixName, windowsName = `${unixName}.cmd`) {
  const wrapperPath = path.join(dir, process.platform === 'win32' ? windowsName : unixName);
  return fs.existsSync(wrapperPath) ? wrapperPath : null;
}

function walkDirs(rootDir, maxDepth, collected = [], depth = 0) {
  if (!fs.existsSync(rootDir) || depth > maxDepth) return collected;
  collected.push(rootDir);
  if (depth === maxDepth) return collected;

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(rootDir, entry.name);
    if (
      ['.git', 'node_modules', '_cobolt-output', 'dist', 'build', 'coverage', 'vendor', '.venv'].includes(entry.name)
    ) {
      continue;
    }
    walkDirs(fullPath, maxDepth, collected, depth + 1);
  }

  return collected;
}

function hasFile(rootDir, fileNames, maxDepth = 0) {
  for (const dir of walkDirs(rootDir, maxDepth, [])) {
    for (const fileName of fileNames) {
      if (fs.existsSync(path.join(dir, fileName))) {
        return true;
      }
    }
  }
  return false;
}

function hasExtension(rootDir, extensions, maxDepth = 1) {
  for (const dir of walkDirs(rootDir, maxDepth, [])) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase())) {
        return true;
      }
    }
  }
  return false;
}

function findComposeFile(projectDir) {
  const candidates = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
  for (const file of candidates) {
    const fullPath = path.join(projectDir, file);
    if (fs.existsSync(fullPath)) return fullPath;
  }
  return null;
}

function extractComposeServices(composeFile) {
  if (!composeFile || !fs.existsSync(composeFile)) return [];

  const services = [];
  const lines = fs.readFileSync(composeFile, 'utf8').split(/\r?\n/);
  let inServices = false;
  let serviceIndent = null;

  for (const line of lines) {
    if (!inServices) {
      if (/^\s*services:\s*$/.test(line)) {
        inServices = true;
      }
      continue;
    }

    if (!line.trim() || /^\s*#/.test(line)) continue;

    const match = line.match(/^(\s*)([A-Za-z0-9._-]+):\s*$/);
    if (!match) {
      if (serviceIndent !== null && line.trim() && !line.startsWith(' '.repeat(serviceIndent))) break;
      continue;
    }

    const indent = match[1].length;
    if (serviceIndent === null) {
      serviceIndent = indent;
      if (indent > 0) services.push(match[2]);
      continue;
    }

    if (indent < serviceIndent) break;
    if (indent === serviceIndent) services.push(match[2]);
  }

  return [...new Set(services)];
}

function detectDockerContext(projectDir) {
  const composeFile = findComposeFile(projectDir);
  const dockerfile = path.join(projectDir, 'Dockerfile');
  const dockerfileExists = fs.existsSync(dockerfile);
  const services = extractComposeServices(composeFile);

  return {
    detected: Boolean(composeFile || dockerfileExists),
    composeFile,
    dockerfile: dockerfileExists ? dockerfile : null,
    services,
  };
}

// Detect the package manager from lockfiles + the corepack `packageManager`
// field. Order of preference matches the canonical lockfile convention so a
// project that has multiple lockfiles (rare, usually a migration artifact)
// resolves to the most-recently-used manager. Falls back to npm only when
// no signal is found — preserves prior behavior for greenfield projects.
function detectNodePackageManager(dir, pkg) {
  const declared = typeof pkg?.packageManager === 'string' ? pkg.packageManager.toLowerCase() : '';
  if (declared.startsWith('bun@')) return 'bun';
  if (declared.startsWith('pnpm@')) return 'pnpm';
  if (declared.startsWith('yarn@')) return 'yarn';
  if (declared.startsWith('npm@')) return 'npm';

  if (fs.existsSync(path.join(dir, 'bun.lock')) || fs.existsSync(path.join(dir, 'bun.lockb'))) return 'bun';
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(dir, 'package-lock.json'))) return 'npm';
  return 'npm';
}

function pmRunArgs(manager, scriptName) {
  // Each manager uses a different invocation shape. Keep the call sites flat
  // — the runtime-truth tool just wants {command, args} pairs.
  if (manager === 'bun') return { command: platformCommand('bun'), args: ['run', scriptName] };
  if (manager === 'pnpm') return { command: platformCommand('pnpm'), args: ['run', scriptName] };
  if (manager === 'yarn') return { command: platformCommand('yarn'), args: [scriptName] };
  return { command: platformCommand('npm'), args: ['run', scriptName] };
}

function pmTestArgs(manager) {
  if (manager === 'bun') return { command: platformCommand('bun'), args: ['test'] };
  if (manager === 'pnpm') return { command: platformCommand('pnpm'), args: ['test'] };
  if (manager === 'yarn') return { command: platformCommand('yarn'), args: ['test'] };
  return { command: platformCommand('npm'), args: ['test'] };
}

function detectNodeCommands(projectDir, includeTests) {
  const commands = [];
  for (const dir of existingDirs(projectDir, ['.', 'frontend', 'dashboard', 'app', 'client', 'web'])) {
    const packageJsonPath = path.join(dir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) continue;
    const pkg = readJson(packageJsonPath);
    const scripts = pkg.scripts || {};
    const manager = detectNodePackageManager(dir, pkg);
    if (scripts.build) {
      const { command, args } = pmRunArgs(manager, 'build');
      commands.push({
        id: `node-build:${path.relative(projectDir, dir) || '.'}`,
        kind: 'build',
        cwd: dir,
        command,
        args,
        packageManager: manager,
      });
    }
    if (scripts.typecheck) {
      const { command, args } = pmRunArgs(manager, 'typecheck');
      commands.push({
        id: `node-typecheck:${path.relative(projectDir, dir) || '.'}`,
        kind: 'typecheck',
        cwd: dir,
        command,
        args,
        packageManager: manager,
      });
    }
    if (includeTests && scripts.test) {
      const { command, args } = pmTestArgs(manager);
      commands.push({
        id: `node-test:${path.relative(projectDir, dir) || '.'}`,
        kind: 'test',
        cwd: dir,
        command,
        args,
        packageManager: manager,
      });
    }
  }
  return commands;
}

function detectGoCommands(projectDir, includeTests) {
  const commands = [];
  for (const dir of existingDirs(projectDir, ['.', 'backend', 'server'])) {
    if (!fs.existsSync(path.join(dir, 'go.mod'))) continue;
    commands.push({
      id: `go-build:${path.relative(projectDir, dir) || '.'}`,
      kind: 'build',
      cwd: dir,
      command: 'go',
      args: ['build', './...'],
    });
    if (includeTests) {
      commands.push({
        id: `go-test:${path.relative(projectDir, dir) || '.'}`,
        kind: 'test',
        cwd: dir,
        command: 'go',
        args: ['test', './...'],
      });
    }
  }
  return commands;
}

function detectPythonCommands(projectDir, includeTests) {
  const commands = [];
  for (const dir of existingDirs(projectDir, ['.', 'backend', 'server'])) {
    const hasPython = ['pyproject.toml', 'requirements.txt', 'setup.py'].some((file) =>
      fs.existsSync(path.join(dir, file)),
    );
    if (!hasPython) continue;
    commands.push({
      id: `python-compile:${path.relative(projectDir, dir) || '.'}`,
      kind: 'build',
      cwd: dir,
      command: 'python',
      args: ['-m', 'compileall', '.'],
    });
    if (includeTests) {
      commands.push({
        id: `python-test:${path.relative(projectDir, dir) || '.'}`,
        kind: 'test',
        cwd: dir,
        command: 'python',
        args: ['-m', 'pytest'],
      });
    }
  }
  return commands;
}

function detectRustCommands(projectDir, includeTests) {
  const commands = [];
  for (const dir of existingDirs(projectDir, ['.', 'backend'])) {
    if (!fs.existsSync(path.join(dir, 'Cargo.toml'))) continue;
    commands.push({
      id: `cargo-build:${path.relative(projectDir, dir) || '.'}`,
      kind: 'build',
      cwd: dir,
      command: 'cargo',
      args: ['build'],
    });
    if (includeTests) {
      commands.push({
        id: `cargo-test:${path.relative(projectDir, dir) || '.'}`,
        kind: 'test',
        cwd: dir,
        command: 'cargo',
        args: ['test'],
      });
    }
  }
  return commands;
}

function detectElixirCommands(projectDir, includeTests) {
  const commands = [];
  for (const dir of existingDirs(projectDir, ['.', 'backend', 'app'])) {
    if (!fs.existsSync(path.join(dir, 'mix.exs'))) continue;
    commands.push({
      id: `mix-compile:${path.relative(projectDir, dir) || '.'}`,
      kind: 'build',
      cwd: dir,
      command: 'mix',
      args: ['compile'],
    });
    if (includeTests) {
      commands.push({
        id: `mix-test:${path.relative(projectDir, dir) || '.'}`,
        kind: 'test',
        cwd: dir,
        command: 'mix',
        args: ['test'],
      });
    }
  }
  return commands;
}

function detectJavaCommands(projectDir, includeTests) {
  const commands = [];
  for (const dir of existingDirs(projectDir, ['.', 'backend', 'server', 'app'])) {
    const gradleWrapper = wrapperCommand(dir, 'gradlew', 'gradlew.bat');
    const gradleFiles = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'];
    const hasGradle = gradleWrapper || hasFile(dir, gradleFiles, 0);
    if (hasGradle) {
      const command = gradleWrapper || platformCommand('gradle');
      commands.push({
        id: `gradle-build:${path.relative(projectDir, dir) || '.'}`,
        kind: 'build',
        cwd: dir,
        command,
        args: ['classes'],
      });
      if (includeTests) {
        commands.push({
          id: `gradle-test:${path.relative(projectDir, dir) || '.'}`,
          kind: 'test',
          cwd: dir,
          command,
          args: ['test'],
        });
      }
      continue;
    }

    const mavenWrapper = wrapperCommand(dir, 'mvnw', 'mvnw.cmd');
    const hasMaven = mavenWrapper || fs.existsSync(path.join(dir, 'pom.xml'));
    if (!hasMaven) continue;

    const command = mavenWrapper || platformCommand('mvn');
    commands.push({
      id: `maven-build:${path.relative(projectDir, dir) || '.'}`,
      kind: 'build',
      cwd: dir,
      command,
      args: ['-q', '-DskipTests', 'compile'],
    });
    if (includeTests) {
      commands.push({
        id: `maven-test:${path.relative(projectDir, dir) || '.'}`,
        kind: 'test',
        cwd: dir,
        command,
        args: ['-q', 'test'],
      });
    }
  }
  return commands;
}

function detectDotnetCommands(projectDir, includeTests) {
  const commands = [];
  for (const dir of existingDirs(projectDir, ['.', 'backend', 'server', 'app', 'src'])) {
    const hasDotnetProject = hasExtension(dir, ['.sln', '.csproj', '.fsproj', '.vbproj'], 2);
    if (!hasDotnetProject) continue;

    commands.push({
      id: `dotnet-build:${path.relative(projectDir, dir) || '.'}`,
      kind: 'build',
      cwd: dir,
      command: 'dotnet',
      args: ['build'],
    });
    if (includeTests) {
      commands.push({
        id: `dotnet-test:${path.relative(projectDir, dir) || '.'}`,
        kind: 'test',
        cwd: dir,
        command: 'dotnet',
        args: ['test'],
      });
    }
  }
  return commands;
}

function detectUnsupportedSignals(projectDir) {
  const signals = [];
  const candidateDirs = existingDirs(projectDir, ['.', 'backend', 'server', 'app', 'src']);

  for (const dir of candidateDirs) {
    if (hasFile(dir, ['composer.json'], 1)) signals.push('php/composer');
    if (hasFile(dir, ['Gemfile', 'Rakefile'], 1)) signals.push('ruby/bundler');
    if (hasFile(dir, ['build.xml'], 0)) signals.push('java/ant');
  }

  return [...new Set(signals)];
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function renderShellCommand(command) {
  return [command.command, ...(command.args || [])].map(shellEscape).join(' ');
}

function resolveDockerService(command, dockerContext, options = {}) {
  const explicit = options.dockerService;
  if (explicit) return explicit;

  const services = dockerContext.services || [];
  if (services.length === 1) return services[0];

  const cwdName = path.basename(command.cwd || '').toLowerCase();
  const exact = services.find((service) => service.toLowerCase() === cwdName);
  if (exact) return exact;

  const common = ['app', 'web', 'backend', 'api', 'server'];
  for (const preferred of common) {
    const match = services.find((service) => service.toLowerCase() === preferred);
    if (match) return match;
  }

  return null;
}

function wrapCommandForDocker(command, projectDir, dockerContext, options = {}) {
  if (!dockerContext.composeFile) {
    return {
      command,
      error: 'Docker mode requires docker-compose.yml / compose.yaml so commands can run via docker compose run',
    };
  }

  const dockerService = resolveDockerService(command, dockerContext, options);
  if (!dockerService) {
    return {
      command,
      error: 'Unable to infer docker compose service. Re-run with --docker-service <name>.',
    };
  }

  const composeArgs = [
    'compose',
    '-f',
    dockerContext.composeFile,
    'run',
    '--rm',
    '-T',
    dockerService,
    'sh',
    '-lc',
    renderShellCommand(command),
  ];
  return {
    command: {
      ...command,
      cwd: projectDir,
      command: 'docker',
      args: composeArgs,
      runtime: 'docker-compose',
      dockerService,
      originalCommand: {
        command: command.command,
        args: [...command.args],
        cwd: command.cwd,
      },
    },
    error: null,
  };
}

function detectCommands(projectDir, options = {}) {
  const includeTests = options.includeTests !== false;
  return uniqueCommands([
    ...detectNodeCommands(projectDir, includeTests),
    ...detectGoCommands(projectDir, includeTests),
    ...detectPythonCommands(projectDir, includeTests),
    ...detectRustCommands(projectDir, includeTests),
    ...detectElixirCommands(projectDir, includeTests),
    ...detectJavaCommands(projectDir, includeTests),
    ...detectDotnetCommands(projectDir, includeTests),
  ]);
}

function snippet(text) {
  return (text || '').trim().slice(0, 400);
}

function runCommand(command, timeoutMs) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command.command)) {
    const cmdExe = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
    const commandLine = [`"${command.command}"`, ...command.args].join(' ');
    return spawnSync(cmdExe, ['/d', '/s', '/c', commandLine], {
      cwd: command.cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { ...process.env, CI: '1' },
    });
  }

  return spawnSync(command.command, command.args, {
    cwd: command.cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, CI: '1' },
  });
}

function runRuntimeTruth(projectDir, options = {}) {
  const docker = detectDockerContext(projectDir);
  let commands = detectCommands(projectDir, options);
  const unsupportedSignals = commands.length === 0 ? detectUnsupportedSignals(projectDir) : [];
  const timeoutMs = Number(options.timeoutMs) || 180000;
  const results = [];
  let dockerWrapError = null;

  if (options.docker) {
    const wrapped = commands.map((command) => wrapCommandForDocker(command, projectDir, docker, options));
    dockerWrapError = wrapped.find((entry) => entry.error)?.error || null;
    if (!dockerWrapError) {
      commands = wrapped.map((entry) => entry.command);
    }
  }

  if (dockerWrapError) {
    return {
      generatedAt: new Date().toISOString(),
      generatedBy: 'cobolt-runtime-truth',
      projectDir,
      ...buildProvenance(projectDir),
      inputArtifactsHash: hashStructuredInput({ docker, dockerRequested: true }),
      status: 'failed',
      reason: dockerWrapError,
      unsupported: false,
      unsupportedSignals,
      passed: false,
      summary: {
        detected: commands.length,
        executed: 0,
        passed: 0,
        failed: 0,
      },
      docker: {
        ...docker,
        mode: 'docker-compose',
      },
      commands: [],
    };
  }

  for (const command of commands) {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const execution = runCommand(command, timeoutMs);
    const durationMs = Date.now() - started;
    const timedOut = execution.error?.code === 'ETIMEDOUT';
    const success = execution.status === 0 && !timedOut;
    results.push({
      ...command,
      startedAt,
      durationMs,
      success,
      exitCode: execution.status,
      errorCode: execution.error?.code || null,
      timedOut,
      stdoutSnippet: snippet(execution.stdout),
      stderrSnippet: snippet(execution.stderr || execution.error?.message || ''),
    });
  }

  const summary = {
    detected: commands.length,
    executed: results.length,
    passed: results.filter((result) => result.success).length,
    failed: results.filter((result) => !result.success).length,
  };

  const allMissingExecutors =
    !options.docker &&
    docker.detected &&
    summary.executed > 0 &&
    results.every((result) => !result.success && result.errorCode === 'ENOENT');
  const dockerNoLocalCommands = !options.docker && docker.detected && summary.executed === 0;
  const unsupported =
    (summary.executed === 0 && unsupportedSignals.length > 0) || dockerNoLocalCommands || allMissingExecutors;
  const status = unsupported ? 'unsupported' : summary.executed > 0 && summary.failed === 0 ? 'passed' : 'failed';
  const reason = unsupported
    ? unsupportedSignals.length > 0 && summary.executed === 0
      ? `No supported runtime executor for detected stack(s): ${unsupportedSignals.join(', ')}`
      : dockerNoLocalCommands
        ? 'Docker-first project detected; no local runtime commands were detected. Runtime truth is a soft pass unless re-run with --docker.'
        : 'Docker-first project detected, but local runtime executors are unavailable. Re-run with --docker to execute commands inside docker compose.'
    : summary.executed === 0
      ? 'No runtime commands detected'
      : summary.failed > 0
        ? `${summary.failed} runtime command(s) failed`
        : 'All runtime commands passed';

  return {
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-runtime-truth',
    projectDir,
    ...buildProvenance(projectDir),
    inputArtifactsHash: hashStructuredInput({
      commands: commands.map((command) => ({
        id: command.id,
        kind: command.kind,
        cwd: path.relative(projectDir, command.cwd),
        command: command.command,
        args: command.args,
        runtime: command.runtime || 'local',
        dockerService: command.dockerService || null,
      })),
      unsupportedSignals,
      docker,
      dockerRequested: options.docker === true,
    }),
    status,
    reason,
    unsupported,
    unsupportedSignals,
    passed: status === 'passed',
    summary,
    docker: {
      ...docker,
      mode: options.docker ? 'docker-compose' : 'local',
    },
    commands: results,
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
  const options = {};
  let projectDir = process.cwd();

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--json') {
      options.json = true;
    } else if (args[i] === '--output' && args[i + 1]) {
      options.output = args[++i];
    } else if (args[i] === '--timeout-ms' && args[i + 1]) {
      options.timeoutMs = Number(args[++i]);
    } else if (args[i] === '--no-tests') {
      options.includeTests = false;
    } else if (args[i] === '--docker') {
      options.docker = true;
    } else if (args[i] === '--docker-service' && args[i + 1]) {
      options.dockerService = args[++i];
    } else if (!args[i].startsWith('--')) {
      projectDir = path.resolve(args[i]);
    }
  }

  if (command !== 'run') {
    console.log(
      'Usage: node tools/cobolt-runtime-truth.js run [project-path] [--json] [--output <path>] [--timeout-ms <n>] [--no-tests] [--docker] [--docker-service <name>]',
    );
    process.exit(command ? 2 : 0);
  }

  const report = runRuntimeTruth(projectDir, options);
  const outputPath =
    options.output || path.join(projectDir, '_cobolt-output', 'latest', 'brownfield', 'runtime-truth.json');
  writeReport(outputPath, report);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[cobolt-runtime-truth] ${report.summary.executed} commands executed`);
    console.log(`  Status: ${report.status}`);
    console.log(`  Passed: ${report.summary.passed}`);
    console.log(`  Failed: ${report.summary.failed}`);
    if (report.reason) console.log(`  Detail: ${report.reason}`);
    console.log(`  Written: ${outputPath}`);
  }

  process.exit(report.status === 'failed' ? 1 : 0);
}

module.exports = {
  detectCommands,
  detectDockerContext,
  detectUnsupportedSignals,
  runRuntimeTruth,
  writeReport,
};
