#!/usr/bin/env node
// cobolt-standards - orchestrator for deterministic standards evidence.
//
// Usage:
//   node tools/cobolt-standards.js all
//   node tools/cobolt-standards.js all --profile planning
//   node tools/cobolt-standards.js report

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { spawnSync } = require('node:child_process');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
// GT-01: bypass routes through signed ledger. Lazy lookup (per-call) so a
// ledger grant issued mid-process is honored without restart. Env-var still
// auto-promotes to a 24h ledger entry during the deprecation window.
function KILL() {
  const { isGateBypassed } = require('../lib/cobolt-bypass-resolver');
  return isGateBypassed('standards', { projectRoot: process.cwd() });
}

const MODULES = [
  { key: 'iso25010', file: 'cobolt-iso25010.js', cmd: ['check'] },
  { key: 'iso5055', file: 'cobolt-iso5055.js', cmd: ['measure'] },
  { key: 'aiGovernance', file: 'cobolt-ai-governance.js', cmd: ['validate'] },
  { key: 'dora', file: 'cobolt-dora.js', cmd: ['report'] },
  { key: 'iso29148', file: 'cobolt-req-quality.js', cmd: ['audit'] },
  // v0.65.1 Wave 5 §5.7 — Reverse-engineering evidence module. Runs 5 RE-specific checks
  // (SBVR 1.5 conformance, DMN 1.5 hit-policy validity, ISO 14764 maintenance category,
  // NIST SP 800-160 loss-control citation, GDPR Art. 30 records-of-processing) against
  // brownfield artifacts. Skips silently on non-RE projects (no false positives).
  { key: 'reEvidence', file: 'cobolt-re-evidence.js', cmd: ['check'] },
];

const PROFILES = {
  all: ['iso25010', 'iso5055', 'aiGovernance', 'dora', 'iso29148'],
  planning: ['iso29148', 'aiGovernance'],
  build: ['iso5055', 'aiGovernance'],
  review: ['iso5055', 'iso25010', 'aiGovernance'],
  release: ['dora', 'iso25010', 'aiGovernance'],
  health: ['iso25010', 'dora'],
  // v0.65.1 Wave 5 §5.7 — RE profile invoked at brownfield P3→P4 boundary when
  // forensicAuditRequired || reverseEngineeringMode is set (per CLAUDE.md §16).
  // Pairs the RE-specific evidence module with iso5055 (code quality) + aiGovernance
  // (AI usage in modernization decisions) — keeping the RE profile sized like other
  // narrow profiles (planning, health) to limit blast radius on non-RE projects.
  'reverse-engineering': ['reEvidence', 'iso5055', 'aiGovernance'],
};

function moduleByKey() {
  return new Map(MODULES.map((mod) => [mod.key, mod]));
}

function selectModules(profile = 'all') {
  const map = moduleByKey();
  const keys = PROFILES[profile] || PROFILES.all;
  return keys.map((key) => map.get(key)).filter(Boolean);
}

function parseArgs(args) {
  const getOpt = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : null;
  };
  const command = args[0] || 'all';
  const profileArg = getOpt('--profile');
  const positionalProfile = PROFILES[command] ? command : null;
  return {
    command: positionalProfile ? 'all' : command,
    profile: profileArg || positionalProfile || 'all',
    json: args.includes('--json') || args.includes('--quiet-json'),
    quietJson: args.includes('--quiet-json') || args.includes('--json'),
    sequential: args.includes('--sequential'),
  };
}

function writeStandardArtifact(projectRoot, fileName, payload) {
  const outDir = path.join(projectRoot, '_cobolt-output', 'standards');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, fileName);
  atomicWrite(outPath, JSON.stringify(payload, null, 2));
  return outPath;
}

function runOneInProcess(mod, projectRoot, reason = null) {
  try {
    if (mod.key === 'iso5055') {
      const { scan } = require('./cobolt-iso5055');
      const data = scan(projectRoot, {});
      const outPath = writeStandardArtifact(projectRoot, 'iso5055-measures.json', data);
      return { key: mod.key, status: 0, stdout: `iso5055: in-process written ${outPath}`, stderr: reason || '' };
    }

    if (mod.key === 'aiGovernance') {
      const { build } = require('./cobolt-ai-governance');
      const data = build(projectRoot);
      const outPath = writeStandardArtifact(projectRoot, 'ai-governance-report.json', data);
      return { key: mod.key, status: 0, stdout: `ai-governance: in-process written ${outPath}`, stderr: reason || '' };
    }

    if (mod.key === 'iso25010') {
      const { build } = require('./cobolt-iso25010');
      const data = build(projectRoot, {});
      const outPath = writeStandardArtifact(projectRoot, 'iso25010-scorecard.json', data);
      return { key: mod.key, status: 0, stdout: `iso25010: in-process written ${outPath}`, stderr: reason || '' };
    }

    if (mod.key === 'iso29148') {
      const { build, findPrdFiles, summarize } = require('./cobolt-req-quality');
      const files = findPrdFiles(projectRoot);
      const data = files.length
        ? build(projectRoot, { files, minAverageScore: 70, maxFailing: null, strict: false })
        : {
            standard: 'ISO/IEC/IEEE 29148:2018',
            generatedAt: new Date().toISOString(),
            source: '',
            requirements: [],
            summary: summarize([], { minAverageScore: 70, maxFailing: null, strict: false }),
            skipped: true,
            reason: 'no PRD artifacts found',
          };
      const outPath = writeStandardArtifact(projectRoot, 'iso29148-req-quality.json', data);
      return { key: mod.key, status: 0, stdout: `req-quality: in-process written ${outPath}`, stderr: reason || '' };
    }

    if (mod.key === 'dora') {
      const { computeAll, overallRating, render } = require('./cobolt-dora');
      const data = computeAll(projectRoot, 90);
      data.overallRating = overallRating(data);
      const outPath = writeStandardArtifact(projectRoot, 'dora-metrics.json', data);
      const mdPath = path.join(projectRoot, '_cobolt-output', 'standards', 'dora-metrics.md');
      atomicWrite(mdPath, render(data));
      const auditDir = path.join(projectRoot, '_cobolt-output', 'audit');
      fs.mkdirSync(auditDir, { recursive: true });
      fs.appendFileSync(path.join(auditDir, 'dora-metrics.jsonl'), `${JSON.stringify(data)}\n`);
      return { key: mod.key, status: 0, stdout: `dora: in-process written ${outPath}`, stderr: reason || '' };
    }

    if (mod.key === 'reEvidence') {
      const { build } = require('./cobolt-re-evidence');
      const data = build(projectRoot);
      const outPath = writeStandardArtifact(projectRoot, 're-evidence.json', data);
      // Skipped (non-RE project) is reported as status 0 with the artifact carrying
      // skipped:true. Failures (data.passed === false on an applicable run) report
      // status -1 so the orchestrator surfaces the failure in the consolidated report.
      const status = data.skipped || data.passed ? 0 : -1;
      return { key: mod.key, status, stdout: `re-evidence: in-process written ${outPath}`, stderr: reason || '' };
    }

    return { key: mod.key, status: -1, stdout: '', stderr: reason || `No in-process runner for ${mod.key}` };
  } catch (error) {
    return { key: mod.key, status: -1, stdout: '', stderr: error.message };
  }
}

function runOneSync(mod, projectRoot) {
  const file = path.resolve(__dirname, mod.file);
  const result = spawnSync(process.execPath, [file, ...mod.cmd], {
    cwd: projectRoot,
    env: process.env,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) return runOneInProcess(mod, projectRoot, result.error.message);
  return {
    key: mod.key,
    status: result.status ?? -1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function runOne(mod, projectRoot) {
  const file = path.resolve(__dirname, mod.file);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [file, ...mod.cmd], {
        cwd: projectRoot,
        env: process.env,
        windowsHide: true,
      });
    } catch (error) {
      resolve(runOneInProcess(mod, projectRoot, error.message));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      settle(runOneInProcess(mod, projectRoot, error.message));
    });
    child.on('close', (status) => {
      settle({ key: mod.key, status: status ?? -1, stdout, stderr });
    });
  });
}

async function runModules(modules, projectRoot, options = {}) {
  if (options.inProcess) {
    return modules.map((mod) => runOneInProcess(mod, projectRoot));
  }
  if (options.sequential) {
    return modules.map((mod) => runOneSync(mod, projectRoot));
  }
  const byKey = new Map(
    (await Promise.all(modules.map((mod) => runOne(mod, projectRoot)))).map((result) => [result.key, result]),
  );
  return modules.map((mod) => byKey.get(mod.key));
}

function loadArtifact(projectRoot, name) {
  const artifactPath = path.join(projectRoot, '_cobolt-output', 'standards', name);
  try {
    return JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  } catch {
    return null;
  }
}

function consolidate(projectRoot, options = {}) {
  const activeModules = options.modules?.length ? new Set(options.modules) : null;
  const include = (key) => !activeModules || activeModules.has(key);

  const iso25010 = include('iso25010') ? loadArtifact(projectRoot, 'iso25010-scorecard.json') : null;
  const iso5055 = include('iso5055') ? loadArtifact(projectRoot, 'iso5055-measures.json') : null;
  const aiGov = include('aiGovernance') ? loadArtifact(projectRoot, 'ai-governance-report.json') : null;
  const dora = include('dora') ? loadArtifact(projectRoot, 'dora-metrics.json') : null;
  const iso29148 = include('iso29148') ? loadArtifact(projectRoot, 'iso29148-req-quality.json') : null;
  const reEvidence = include('reEvidence') ? loadArtifact(projectRoot, 're-evidence.json') : null;

  return {
    generatedAt: new Date().toISOString(),
    profile: options.profile || 'all',
    modules: options.modules || [],
    results: options.results || [],
    standards: {
      'ISO/IEC 25010:2023': iso25010 ? { grade: iso25010.overall.grade, score: iso25010.overall.score } : null,
      'ISO/IEC 5055:2021': iso5055
        ? { violations: iso5055.violations.length, filesScanned: iso5055.filesScanned }
        : null,
      'ISO/IEC 42001 + NIST AI RMF': aiGov
        ? { aiDetected: aiGov.aiDetected.present, coveragePct: aiGov.summary.coveragePct }
        : null,
      DORA: dora ? { overallRating: dora.overallRating } : null,
      'ISO/IEC/IEEE 29148:2018': iso29148
        ? iso29148.skipped
          ? { skipped: true, reason: iso29148.reason }
          : {
              averageScore: iso29148.summary.averageScore,
              failing: iso29148.summary.failing,
              passed: iso29148.summary.passed,
            }
        : null,
      // v0.65.1 Wave 5 §5.7 — Reverse-engineering evidence summary.
      'CoBolt RE Evidence (SBVR + DMN + ISO 14764 + NIST 800-160 + GDPR Art. 30)': reEvidence
        ? reEvidence.skipped
          ? { skipped: true, reason: reEvidence.reason }
          : {
              passed: reEvidence.passed,
              applicableChecks: reEvidence.summary.applicableChecks,
              passingChecks: reEvidence.summary.passingChecks,
              failingChecks: reEvidence.summary.failingChecks,
            }
        : null,
    },
  };
}

function render(report) {
  const lines = [];
  lines.push('# Standards Compliance Summary');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Profile: ${report.profile}`);
  lines.push('');
  lines.push('| Standard | Result |');
  lines.push('|----|----|');
  for (const [name, value] of Object.entries(report.standards)) {
    if (!value) {
      lines.push(`| ${name} | _not run_ |`);
      continue;
    }
    lines.push(`| ${name} | ${JSON.stringify(value)} |`);
  }
  return lines.join('\n');
}

function writeSummary(projectRoot, report) {
  const outDir = path.join(projectRoot, '_cobolt-output', 'standards');
  atomicWrite(path.join(outDir, 'summary.json'), JSON.stringify(report, null, 2));
  atomicWrite(path.join(outDir, 'summary.md'), render(report));
  return path.join(outDir, 'summary.json');
}

function printUsage() {
  console.log(
    [
      'cobolt-standards - orchestrator for deterministic standards evidence.',
      '',
      'Usage:',
      '  node tools/cobolt-standards.js [all] [--profile <name>] [--json|--quiet-json] [--sequential]',
      '  node tools/cobolt-standards.js report [--json]',
      '',
      `Profiles: ${Object.keys(PROFILES).join(', ')}`,
      '',
      'No argument defaults to `all`. The `--help` / `-h` flag prints this usage and exits without side effects.',
    ].join('\n'),
  );
}

async function main() {
  if (KILL()) {
    console.log('COBOLT_STANDARDS=off - skipping');
    process.exit(0);
  }

  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const options = parseArgs(argv);
  const projectRoot = process.cwd();
  const selected = selectModules(options.profile);
  let results = [];

  if (options.command === 'all') {
    results = await runModules(selected, projectRoot, options);
    if (!options.quietJson) {
      for (const result of results) {
        const last = (result.stdout || '').trim().split('\n').slice(-2).join(' | ');
        console.log(`[${result.key}] ${result.status === 0 ? 'ok' : 'fail'}  ${last}`);
      }
    }
  }

  const report = consolidate(projectRoot, {
    profile: options.profile,
    modules: selected.map((mod) => mod.key),
    results: results.map((result) => ({ key: result.key, status: result.status })),
  });
  const summaryPath = writeSummary(projectRoot, report);

  if (options.command === 'report' || options.json) {
    console.log(options.json ? JSON.stringify(report, null, 2) : render(report));
  } else {
    console.log(`standards: ${options.profile} summary written to ${summaryPath}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`standards: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  MODULES,
  PROFILES,
  consolidate,
  parseArgs,
  render,
  runOneInProcess,
  runModules,
  selectModules,
};
