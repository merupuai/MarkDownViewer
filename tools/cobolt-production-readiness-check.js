#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CoboltPaths } = require('../lib/cobolt-paths');

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

function parseArgs(argv = process.argv.slice(2)) {
  const flags = {
    command: 'check',
    cwd: process.cwd(),
    milestone: null,
    json: false,
    skipApp: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  if (argv[0] && !argv[0].startsWith('-')) flags.command = argv.shift();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd') flags.cwd = path.resolve(argv[++i] || flags.cwd);
    else if (arg === '--milestone') flags.milestone = normalizeMilestone(argv[++i] || '');
    else if (arg === '--json') flags.json = true;
    else if (arg === '--skip-app') flags.skipApp = true;
    else if (arg === '--timeout-ms') flags.timeoutMs = Number(argv[++i] || DEFAULT_TIMEOUT_MS);
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
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function inferMilestone(cwd, explicitMilestone = null) {
  const normalized = normalizeMilestone(explicitMilestone);
  if (normalized) return normalized;

  const state = readJson(path.join(cwd, 'cobolt-state.json')) || {};
  const candidates = [
    state.pipeline?.currentMilestone,
    state.build?.currentMilestone,
    state.currentMilestone,
    state.pipeline?.priorMilestone,
  ];
  for (const candidate of candidates) {
    const value = normalizeMilestone(candidate);
    if (value) return value;
  }
  return null;
}

function nodeCommand() {
  return process.execPath;
}

function buildSteps(options) {
  const milestoneArgs = options.milestone ? ['--milestone', options.milestone] : [];
  const steps = [
    {
      id: 'tools-gate',
      label: 'Deterministic tool gate',
      command: nodeCommand(),
      args: ['tools/cobolt-gate.js'],
      required: true,
    },
  ];

  steps.push(
    ...(!options.skipApp
      ? [
          {
            id: 'app-runtime',
            label: 'Verify application starts and responds on declared URL',
            command: nodeCommand(),
            args: ['tools/cobolt-app-runtime-check.js', 'check', ...milestoneArgs],
            required: true,
          },
        ]
      : []),
    {
      id: 'agent-failure-review',
      label: 'Review agent/runtime failures and write review-lead escalation packet',
      command: nodeCommand(),
      args: ['tools/cobolt-agent-failure-review.js'],
      required: false,
    },
    {
      id: 'observability-check',
      label: 'Run observability primitive gate',
      command: nodeCommand(),
      args: ['tools/cobolt-observability-check.js', 'gate'],
      required: true,
    },
    {
      id: 'plateau-rollup',
      label: 'Summarize fix-loop plateau events for escalation',
      command: nodeCommand(),
      args: ['tools/cobolt-plateau-rollup.js'],
      required: false,
    },
    {
      id: 'production-evidence',
      label: 'Run executable production evidence gate',
      command: nodeCommand(),
      args: ['tools/cobolt-production-evidence.js', 'check'],
      required: true,
    },
    {
      id: 'production-quality',
      label: 'Run production quality gate without mutating state',
      command: nodeCommand(),
      args: ['tools/cobolt-production-quality.js', 'check', '--no-state-write', ...milestoneArgs],
      required: true,
    },
    {
      id: 'state-reconcile',
      label: 'Compare cobolt-state.json readiness with durable evidence',
      command: nodeCommand(),
      args: ['tools/cobolt-state-readiness-reconcile.js'],
      required: false,
    },
    {
      id: 'release-readiness',
      label: 'Run deterministic release readiness checklist gate',
      command: nodeCommand(),
      args: ['tools/cobolt-release-readiness-check.js'],
      required: true,
    },
  );

  return steps;
}

function defaultCommandRunner(step, options) {
  const startedAt = Date.now();
  const run = spawnSync(step.command, step.args, {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: options.timeoutMs,
    windowsHide: true,
  });

  return {
    id: step.id,
    label: step.label,
    command: [step.command, ...step.args].join(' '),
    required: step.required,
    exitCode: typeof run.status === 'number' ? run.status : 1,
    durationMs: Date.now() - startedAt,
    stdout: trimOutput(run.stdout),
    stderr: trimOutput(run.stderr || run.error?.message || ''),
  };
}

function trimOutput(value) {
  const text = String(value || '').trim();
  if (text.length <= 8000) return text;
  return `${text.slice(0, 4000)}\n...\n${text.slice(-4000)}`;
}

function runCheck(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const paths = new CoboltPaths(cwd);
  const commandRunner = options.commandRunner || defaultCommandRunner;
  const resolvedMilestone = inferMilestone(cwd, options.milestone);
  const resolvedOptions = { ...options, milestone: resolvedMilestone };
  const steps = buildSteps(resolvedOptions);
  const result = {
    version: 1,
    generatedAt: new Date().toISOString(),
    milestone: resolvedMilestone,
    skippedAppVerification: Boolean(options.skipApp),
    status: 'failed',
    steps: [],
    blockers: [],
    advisoryFailures: [],
    artifacts: {},
  };

  for (const step of steps) {
    const outcome = commandRunner(step, { cwd, timeoutMs: Number(resolvedOptions.timeoutMs || DEFAULT_TIMEOUT_MS) });
    result.steps.push(outcome);
    if (outcome.exitCode !== 0) {
      const entry = {
        id: outcome.id,
        label: outcome.label,
        command: outcome.command,
        exitCode: outcome.exitCode,
      };
      if (step.required) result.blockers.push(entry);
      else result.advisoryFailures.push(entry);
    }
  }

  result.status = result.blockers.length ? 'failed' : 'passed';
  writeReports(cwd, paths, result);
  return result;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, value, { encoding: 'utf8', mode: 0o600 });
}

function rel(cwd, filePath) {
  return path.relative(cwd, filePath).replace(/\\/g, '/');
}

function writeReports(cwd, paths, result) {
  const latestDir = path.join(paths.latest(), 'production-readiness');
  const reportDir = paths.reports('project');
  const jsonPath = path.join(latestDir, 'check-report.json');
  const mdPath = path.join(latestDir, 'check-report.md');
  const projectMdPath = path.join(reportDir, 'production-readiness-check.md');

  result.artifacts = {
    json: rel(cwd, jsonPath),
    markdown: rel(cwd, mdPath),
    projectReport: rel(cwd, projectMdPath),
  };

  writeJson(jsonPath, result);
  const markdown = renderMarkdown(result);
  writeText(mdPath, markdown);
  writeText(projectMdPath, markdown);
  writeEscalationPacket(cwd, paths, result);
  writeJson(jsonPath, result);
}

function productionQualityArtifact(cwd, result) {
  const qualityStep = result.steps.find((step) => step.id === 'production-quality');
  if (!qualityStep) return null;

  const modeMatch = String(qualityStep.command || '').match(/--mode\s+(\S+)/u);
  const mode = modeMatch?.[1] || 'release-candidate';
  const filePath = path.join(new CoboltPaths(cwd).latest(), 'production-quality', `${mode}-gate.json`);
  const data = readJson(filePath);
  if (!data) return null;
  return { path: rel(cwd, filePath), data };
}

function writeEscalationPacket(cwd, paths, result) {
  const failedSteps = result.steps.filter((step) => step.exitCode !== 0);
  const quality = productionQualityArtifact(cwd, result);
  const packet = {
    version: 1,
    generatedAt: new Date().toISOString(),
    to: 'review-lead',
    advisor: result.blockers.length ? 'recovery-advisor' : 'enhancement-advisor',
    advisorRequired: result.blockers.length > 0,
    status: failedSteps.length ? 'failures-detected' : 'clear',
    failureCount: failedSteps.length,
    milestone: result.milestone || null,
    failures: failedSteps.map((step) => ({
      id: step.id,
      label: step.label,
      required: Boolean(step.required),
      command: step.command,
      exitCode: step.exitCode,
      stdout: step.stdout || '',
      stderr: step.stderr || '',
    })),
    productionQuality: quality
      ? {
          artifact: quality.path,
          passed: quality.data.passed === true,
          score: quality.data.score ?? null,
          readiness: quality.data.readiness || null,
          blockers: Array.isArray(quality.data.blockers) ? quality.data.blockers : [],
        }
      : null,
    blockers: result.blockers,
    advisoryFailures: result.advisoryFailures,
    doneCriteria: [
      'review-lead receives the complete failed step stdout/stderr, command, exit code, and artifact paths.',
      'Each required blocker is assigned to the owning lead before another release-readiness attempt.',
      'If review-lead cannot close the blocker from local evidence, recovery-advisor must propose the next executable path.',
    ],
  };

  const packetPath = path.join(paths.latest(), 'production-readiness', 'review-lead-escalation-packet.json');
  writeJson(packetPath, packet);
}

function renderMarkdown(result) {
  const lines = [
    '# Production Readiness Check',
    '',
    `- Status: ${result.status}`,
    `- Milestone: ${result.milestone || 'not specified'}`,
    `- App verification skipped: ${result.skippedAppVerification ? 'yes' : 'no'}`,
    `- Required blockers: ${result.blockers.length}`,
    `- Advisory failures: ${result.advisoryFailures.length}`,
    '',
    '## Steps',
    '',
  ];

  for (const step of result.steps) {
    const status = step.exitCode === 0 ? 'PASS' : step.required ? 'FAIL' : 'ADVISORY';
    lines.push(`- ${status} ${step.id}: ${step.label}`);
  }

  if (result.blockers.length) {
    lines.push('', '## Required Blockers', '');
    for (const blocker of result.blockers) lines.push(`- ${blocker.id}: ${blocker.label}`);
  }

  if (result.advisoryFailures.length) {
    lines.push('', '## Advisory Failures', '');
    for (const failure of result.advisoryFailures) lines.push(`- ${failure.id}: ${failure.label}`);
  }

  return `${lines.join('\n')}\n`;
}

function main() {
  const argv = process.argv.slice(2);
  const isHelp = argv.includes('--help') || argv.includes('-h') || argv[0] === 'help';
  const usage =
    'Usage: cobolt-production-readiness-check.js check [--milestone M5] [--skip-app] [--json] [--timeout-ms 1200000]';
  if (isHelp) {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  const flags = parseArgs();
  if (flags.command !== 'check') {
    process.stderr.write(`${usage}\n`);
    return 2;
  }
  const result = runCheck(flags);
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Production readiness check - ${result.status.toUpperCase()}`);
    if (result.blockers.length) {
      console.log('Required blockers:');
      for (const blocker of result.blockers) console.log(`- ${blocker.id}: ${blocker.label}`);
    }
    console.log(`Report: ${result.artifacts.markdown}`);
  }
  return result.status === 'passed' ? 0 : 1;
}

if (require.main === module) process.exit(main());

module.exports = { runCheck, parseArgs, buildSteps, defaultCommandRunner, inferMilestone };
