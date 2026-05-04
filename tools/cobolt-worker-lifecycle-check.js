#!/usr/bin/env node

// CoBolt Worker Lifecycle Check - deterministic background worker startup verifier

const fs = require('node:fs');
const path = require('node:path');

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.go', '.ex', '.exs']);
const IGNORED_DIRS = new Set(['.git', 'node_modules', '_cobolt-output', 'dist', 'build', 'coverage', 'deps', '_build']);

function walkFiles(rootDir, predicate, collected = []) {
  if (!fs.existsSync(rootDir)) return collected;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        walkFiles(fullPath, predicate, collected);
      }
      continue;
    }
    if (predicate(fullPath)) {
      collected.push(fullPath);
    }
  }
  return collected;
}

function isSourceFile(filePath) {
  return SOURCE_EXTENSIONS.has(path.extname(filePath));
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

// --- Go worker detection ---

function findGoWorkers(projectDir, allFiles) {
  const workers = [];
  const goFiles = allFiles.filter((f) => f.endsWith('.go'));

  for (const filePath of goFiles) {
    const text = readText(filePath);
    const relativePath = path.relative(projectDir, filePath);

    // Match: func (w *XxxWorker) Start/Run/Process(...)
    const methodPattern = /func\s+\(\w+\s+\*(\w+Worker)\)\s+(Start|Run|Process)\b/g;
    let match;
    while ((match = methodPattern.exec(text)) !== null) {
      const workerName = match[1];
      const method = match[2];
      if (!workers.some((w) => w.name === workerName && w.language === 'go')) {
        workers.push({
          name: workerName,
          method,
          file: relativePath,
          language: 'go',
        });
      }
    }

    // Match: func NewXxxWorker(...)
    const constructorPattern = /func\s+(New\w+Worker)\s*\(/g;
    while ((match = constructorPattern.exec(text)) !== null) {
      const constructorName = match[1];
      const workerName = constructorName.replace(/^New/, '');
      if (!workers.some((w) => w.name === workerName && w.language === 'go')) {
        workers.push({
          name: workerName,
          method: constructorName,
          file: relativePath,
          language: 'go',
        });
      }
    }

    // Match: func processXxx(...) standalone
    const standaloneFuncPattern = /func\s+(process\w+)\s*\(/g;
    while ((match = standaloneFuncPattern.exec(text)) !== null) {
      const funcName = match[1];
      if (!workers.some((w) => w.name === funcName && w.language === 'go')) {
        workers.push({
          name: funcName,
          method: funcName,
          file: relativePath,
          language: 'go',
        });
      }
    }
  }

  return workers;
}

function isGoEntryFile(filePath) {
  const base = path.basename(filePath);
  return base === 'main.go' || base === 'app.go' || base === 'server.go';
}

function checkGoWorkerStartup(projectDir, worker, allFiles) {
  const goEntryFiles = allFiles.filter((f) => f.endsWith('.go') && isGoEntryFile(f));
  const nameEscaped = worker.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  for (const entryFile of goEntryFiles) {
    const text = readText(entryFile);
    const relativePath = path.relative(projectDir, entryFile);

    const startPatterns = [
      /go\s+\w+\.(?:Start|Run|Process)/g,
      new RegExp(`${nameEscaped}`, 'g'),
      new RegExp(`New${nameEscaped}\\s*\\(`, 'g'),
    ];

    for (const pattern of startPatterns) {
      if (pattern.test(text)) {
        return {
          startedIn: relativePath,
          evidence: `${worker.name} started in ${relativePath}`,
        };
      }
    }
  }

  return null;
}

// --- Node.js worker detection ---

function findNodeWorkers(projectDir, allFiles) {
  const workers = [];
  const jsFiles = allFiles.filter((f) => /\.[jt]sx?$/.test(f));

  for (const filePath of jsFiles) {
    const text = readText(filePath);
    const relativePath = path.relative(projectDir, filePath);

    // Match: class XxxWorker
    const classPattern = /class\s+(\w+Worker)\b/g;
    let match;
    while ((match = classPattern.exec(text)) !== null) {
      const workerName = match[1];
      if (!workers.some((w) => w.name === workerName && w.language === 'node')) {
        workers.push({
          name: workerName,
          method: 'class',
          file: relativePath,
          language: 'node',
        });
      }
    }

    // Match: new Queue('name').process(...)
    const queuePattern = /new\s+Queue\s*\(\s*['"](\w[\w-]*)['"](?:,\s*[^)]+)?\)/g;
    while ((match = queuePattern.exec(text)) !== null) {
      const queueName = match[1];
      if (/\.process\s*\(/g.test(text)) {
        if (!workers.some((w) => w.name === queueName && w.language === 'node')) {
          workers.push({
            name: queueName,
            method: 'Queue.process',
            file: relativePath,
            language: 'node',
          });
        }
      }
    }
  }

  return workers;
}

function isNodeEntryFile(filePath) {
  const base = path.basename(filePath);
  return /^(index|app|server|main)\.[jt]sx?$/.test(base);
}

function checkNodeWorkerStartup(projectDir, worker, allFiles) {
  const entryFiles = allFiles.filter((f) => /\.[jt]sx?$/.test(f) && isNodeEntryFile(f));
  const workerFilePath = path.join(projectDir, worker.file);
  const workerDir = path.dirname(workerFilePath);
  const workerBase = path.basename(workerFilePath, path.extname(workerFilePath));

  for (const entryFile of entryFiles) {
    const text = readText(entryFile);
    const relativePath = path.relative(projectDir, entryFile);

    const relFromEntry = path.relative(path.dirname(entryFile), workerDir).replace(/\\/g, '/');
    const requirePath = relFromEntry ? `${relFromEntry}/${workerBase}` : `./${workerBase}`;
    const requirePathNormalized = requirePath.startsWith('.') ? requirePath : `./${requirePath}`;

    const importPatterns = [
      worker.name,
      requirePathNormalized,
      requirePathNormalized.replace(/^\.\//, ''),
      worker.file.replace(/\\/g, '/'),
    ];

    for (const pattern of importPatterns) {
      if (text.includes(pattern)) {
        return {
          startedIn: relativePath,
          evidence: `${worker.name} imported in ${relativePath}`,
        };
      }
    }
  }

  return null;
}

// --- Elixir worker detection ---

function findElixirWorkers(projectDir, allFiles) {
  const workers = [];
  const exFiles = allFiles.filter((f) => f.endsWith('.ex') || f.endsWith('.exs'));

  for (const filePath of exFiles) {
    const text = readText(filePath);
    const relativePath = path.relative(projectDir, filePath);

    if (/use\s+GenServer\b/.test(text)) {
      const moduleMatch = text.match(/defmodule\s+([\w.]+)\s+do/);
      if (moduleMatch) {
        const moduleName = moduleMatch[1];
        if (!workers.some((w) => w.name === moduleName && w.language === 'elixir')) {
          workers.push({
            name: moduleName,
            method: 'GenServer',
            file: relativePath,
            language: 'elixir',
          });
        }
      }
    }
  }

  return workers;
}

function isElixirApplicationFile(filePath) {
  const base = path.basename(filePath);
  return base === 'application.ex' || base === 'supervisor.ex';
}

function checkElixirWorkerStartup(projectDir, worker, allFiles) {
  const appFiles = allFiles.filter((f) => (f.endsWith('.ex') || f.endsWith('.exs')) && isElixirApplicationFile(f));

  for (const appFile of appFiles) {
    const text = readText(appFile);
    const relativePath = path.relative(projectDir, appFile);

    if (text.includes(worker.name)) {
      return {
        startedIn: relativePath,
        evidence: `${worker.name} in supervision tree at ${relativePath}`,
      };
    }
  }

  return null;
}

// --- Main scan function ---

function scan(projectDir) {
  const resolvedDir = path.resolve(projectDir);
  const allFiles = walkFiles(resolvedDir, isSourceFile);

  const goWorkers = findGoWorkers(resolvedDir, allFiles);
  const nodeWorkers = findNodeWorkers(resolvedDir, allFiles);
  const elixirWorkers = findElixirWorkers(resolvedDir, allFiles);

  const allWorkers = [...goWorkers, ...nodeWorkers, ...elixirWorkers];

  const workers = allWorkers.map((worker) => {
    let startup = null;

    if (worker.language === 'go') {
      startup = checkGoWorkerStartup(resolvedDir, worker, allFiles);
    } else if (worker.language === 'node') {
      startup = checkNodeWorkerStartup(resolvedDir, worker, allFiles);
    } else if (worker.language === 'elixir') {
      startup = checkElixirWorkerStartup(resolvedDir, worker, allFiles);
    }

    return {
      name: worker.name,
      method: worker.method,
      file: worker.file,
      language: worker.language,
      status: startup ? 'started' : 'defined-not-started',
      startedIn: startup ? startup.startedIn : null,
      evidence: startup
        ? startup.evidence
        : `${worker.name} defined in ${worker.file} but not started in any entry point`,
    };
  });

  const started = workers.filter((w) => w.status === 'started').length;
  const definedNotStarted = workers.filter((w) => w.status === 'defined-not-started').length;

  return {
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-worker-lifecycle-check',
    projectDir: resolvedDir,
    summary: {
      total: workers.length,
      started,
      definedNotStarted,
    },
    workers,
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
  let projectDir = process.cwd();
  let outputPath = null;
  const jsonMode = args.includes('--json');

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--output' && args[i + 1]) {
      outputPath = args[++i];
    } else if (!args[i].startsWith('--')) {
      projectDir = path.resolve(args[i]);
    }
  }

  if (command !== 'scan') {
    console.log('Usage: node tools/cobolt-worker-lifecycle-check.js scan [project-dir] [--json] [--output <path>]');
    process.exit(command ? 2 : 0);
  }

  const report = scan(projectDir);
  const targetPath =
    outputPath || path.join(projectDir, '_cobolt-output', 'latest', 'brownfield', 'worker-lifecycle.json');
  writeReport(targetPath, report);

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[cobolt-worker-lifecycle-check] ${report.summary.total} workers scanned`);
    console.log(`  Started: ${report.summary.started}`);
    console.log(`  Defined-not-started: ${report.summary.definedNotStarted}`);
    console.log(`  Written: ${targetPath}`);
  }

  process.exit(report.summary.definedNotStarted === 0 ? 0 : 1);
}

module.exports = { scan };
