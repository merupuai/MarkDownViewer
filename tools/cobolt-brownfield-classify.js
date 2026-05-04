#!/usr/bin/env node

// CoBolt Brownfield Classify - Deterministic project classification
//
// Replaces P0 Step 0.1 LLM-driven classification with a decision tree.
// Classifies project as: brownfield | inflight | legacy | greenfield
//
// Usage:
//   node tools/cobolt-brownfield-classify.js [--dir <path>]                  # Classify project
//   node tools/cobolt-brownfield-classify.js [--force brownfield] --json     # Machine-readable
//
// Exit codes:
//   0 = classification successful
//   1 = error

const fs = require('node:fs');
const path = require('node:path');

const LEGACY_EXTENSIONS = new Set([
  '.cob',
  '.cbl',
  '.cpy',
  '.bas',
  '.frm',
  '.cls',
  '.vbp',
  '.pas',
  '.dpr',
  '.dfm',
  '.prg',
  '.fxp',
  '.scx',
  '.vcx',
  '.swf',
  '.fla',
  '.as',
  '.rpgle',
  '.rpg',
  '.clp',
  '.dds',
  '.4gl',
  '.per',
  '.p',
  '.w',
  '.i',
  '.cfm',
  '.cfc',
  '.asp',
]);

const MODERN_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.py',
  '.pyi',
  '.go',
  '.rs',
  '.ex',
  '.exs',
  '.rb',
  '.java',
  '.kt',
  '.kts',
  '.cs',
  '.swift',
  '.dart',
  '.vue',
  '.svelte',
]);

const MANIFEST_TO_MANAGER = new Map([
  ['package.json', 'npm'],
  ['go.mod', 'go'],
  ['requirements.txt', 'pip'],
  ['Pipfile', 'pipenv'],
  ['pyproject.toml', 'poetry/pip'],
  ['Cargo.toml', 'cargo'],
  ['mix.exs', 'hex'],
  ['Gemfile', 'bundler'],
  ['pom.xml', 'maven'],
  ['build.gradle', 'gradle'],
  ['composer.json', 'composer'],
]);

const FORCEABLE_CLASSIFICATIONS = new Set(['brownfield', 'inflight', 'legacy', 'greenfield']);
const ACTIVE_INFLIGHT_STAGES = new Set(['building', 's5-s6']);
const STABLE_INFLIGHT_STAGES = new Set(['completed']);
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  'target',
  '_build',
  'deps',
  '.next',
  '.nuxt',
  '_cobolt-output',
  '.claude',
  '.codex',
  '.opencode',
]);

function normalizeStageName(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function readCoboltState(dir) {
  const statePath = path.join(dir, 'cobolt-state.json');
  if (!fs.existsSync(statePath)) {
    return {
      exists: false,
      statePath,
      status: 'absent',
      stage: null,
      reason: null,
      classifyAsInflight: false,
    };
  }

  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (error) {
    return {
      exists: true,
      statePath,
      status: 'invalid',
      stage: null,
      reason: `cobolt-state.json exists but is unreadable (${error.message})`,
      classifyAsInflight: false,
    };
  }

  const pipelineStage = normalizeStageName(state?.pipeline?.currentStage);
  const currentStage = normalizeStageName(state?.currentStage);
  const stage = pipelineStage || currentStage || null;

  if (stage && ACTIVE_INFLIGHT_STAGES.has(stage)) {
    return {
      exists: true,
      statePath,
      status: 'active',
      stage,
      reason: `CoBolt state indicates an active build-stage pipeline (${stage})`,
      classifyAsInflight: true,
    };
  }

  if (stage && STABLE_INFLIGHT_STAGES.has(stage)) {
    return {
      exists: true,
      statePath,
      status: 'stable',
      stage,
      reason: `CoBolt state indicates a completed managed project (${stage})`,
      classifyAsInflight: true,
    };
  }

  return {
    exists: true,
    statePath,
    status: 'stale',
    stage,
    reason: stage
      ? `cobolt-state.json exists but only records an incomplete or stale stage (${stage})`
      : 'cobolt-state.json exists but does not indicate an active build or completed pipeline',
    classifyAsInflight: false,
  };
}

function shouldSkipDirectory(entry) {
  return SKIP_DIRS.has(entry.name) || entry.name.startsWith('.');
}

function scanDirectory(dir, signals) {
  const queue = [dir];

  while (queue.length > 0) {
    const currentDir = queue.pop();
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!entry.isSymbolicLink() && !shouldSkipDirectory(entry)) {
          queue.push(path.join(currentDir, entry.name));
        }
        continue;
      }

      if (!entry.isFile()) continue;

      const manifestManager = MANIFEST_TO_MANAGER.get(entry.name);
      if (manifestManager) {
        signals.hasPackageManifest = true;
        if (!signals.packageManagers.includes(manifestManager)) {
          signals.packageManagers.push(manifestManager);
        }
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (LEGACY_EXTENSIONS.has(ext)) {
        signals.legacyFileCount++;
        signals.totalSourceFiles++;
        if (!signals.legacyExtensions.includes(ext)) signals.legacyExtensions.push(ext);
      } else if (MODERN_EXTENSIONS.has(ext)) {
        signals.modernFileCount++;
        signals.totalSourceFiles++;
        if (!signals.modernExtensions.includes(ext)) signals.modernExtensions.push(ext);
      }
    }
  }
}

function classifyProject(dir, options = {}) {
  const forcedClassification = options.force ? String(options.force).trim().toLowerCase() : null;
  if (forcedClassification && !FORCEABLE_CLASSIFICATIONS.has(forcedClassification)) {
    throw new Error(
      `Invalid --force value "${options.force}". Expected one of: ${[...FORCEABLE_CLASSIFICATIONS].join(', ')}`,
    );
  }

  const stateInspection = readCoboltState(dir);
  const signals = {
    hasCoboltState: stateInspection.exists,
    coboltStateStatus: stateInspection.status,
    coboltStateStage: stateInspection.stage,
    coboltStateReason: stateInspection.reason,
    hasFailedCoboltRun: stateInspection.exists && !stateInspection.classifyAsInflight,
    hasSourceCode: false,
    hasLegacyCode: false,
    hasModernCode: false,
    hasPackageManifest: false,
    hasGitHistory: fs.existsSync(path.join(dir, '.git')),
    legacyFileCount: 0,
    modernFileCount: 0,
    totalSourceFiles: 0,
    legacyExtensions: [],
    modernExtensions: [],
    packageManagers: [],
  };

  scanDirectory(dir, signals);

  signals.hasSourceCode = signals.totalSourceFiles > 0;
  signals.hasLegacyCode = signals.legacyFileCount > 0;
  signals.hasModernCode = signals.modernFileCount > 0;

  let classification;
  let confidence;
  let reason;

  if (forcedClassification) {
    classification = forcedClassification;
    confidence = 1.0;
    reason = `Classification forced via --force ${forcedClassification}`;
  } else if (!signals.hasSourceCode && !signals.hasPackageManifest) {
    classification = 'greenfield';
    confidence = 0.95;
    reason = 'No source code or package manifests found';
  } else if (stateInspection.classifyAsInflight) {
    classification = 'inflight';
    confidence = 0.99;
    reason = stateInspection.reason;
  } else if (signals.hasLegacyCode && !signals.hasModernCode) {
    classification = 'legacy';
    confidence = 0.9;
    reason = `Only legacy code detected: ${signals.legacyExtensions.join(', ')} (${signals.legacyFileCount} files)`;
  } else if (signals.hasLegacyCode && signals.hasModernCode) {
    const legacyRatio = signals.legacyFileCount / signals.totalSourceFiles;
    if (legacyRatio > 0.5) {
      classification = 'legacy';
      confidence = 0.8;
      reason = `Majority legacy code (${(legacyRatio * 100).toFixed(0)}%): ${signals.legacyExtensions.join(', ')}`;
    } else {
      classification = 'brownfield';
      confidence = 0.85;
      reason = `Mixed codebase - ${signals.legacyFileCount} legacy + ${signals.modernFileCount} modern files`;
    }
  } else {
    classification = 'brownfield';
    confidence = 0.9;
    reason = `Existing modern codebase: ${signals.modernExtensions.join(', ')} (${signals.modernFileCount} files)`;
  }

  if (
    !forcedClassification &&
    classification !== 'inflight' &&
    stateInspection.status === 'stale' &&
    stateInspection.reason
  ) {
    reason = `${reason}. ${stateInspection.reason}.`;
  }

  return {
    classification,
    confidence,
    reason,
    signals,
    timestamp: new Date().toISOString(),
    generatedBy: 'cobolt-brownfield-classify',
  };
}

function main() {
  const args = process.argv.slice(2);
  const dirIdx = args.indexOf('--dir');
  const dir = dirIdx !== -1 && args[dirIdx + 1] ? args[dirIdx + 1] : process.cwd();
  const forceIdx = args.indexOf('--force');
  const forcedClassification = forceIdx !== -1 && args[forceIdx + 1] ? args[forceIdx + 1] : null;
  const jsonMode = args.includes('--json');

  const result = classifyProject(dir, { force: forcedClassification });

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('[cobolt-brownfield-classify] Project Classification');
    console.log(`  Directory: ${dir}`);
    console.log(`  Classification: ${result.classification.toUpperCase()}`);
    console.log(`  Confidence: ${(result.confidence * 100).toFixed(0)}%`);
    console.log(`  Reason: ${result.reason}`);
    console.log(
      `  Source files: ${result.signals.totalSourceFiles} (${result.signals.modernFileCount} modern, ${result.signals.legacyFileCount} legacy)`,
    );
    if (result.signals.packageManagers.length > 0) {
      console.log(`  Package managers: ${result.signals.packageManagers.join(', ')}`);
    }
  }
}

module.exports = { classifyProject, readCoboltState, scanDirectory };

if (require.main === module) {
  main();
}
