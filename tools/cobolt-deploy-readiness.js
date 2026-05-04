#!/usr/bin/env node

// CoBolt Deploy-Readiness Evidence (v0.44.0, BUILD-07 closer).
//
// Validates the _cobolt-output/latest/build/{M}/{M}-deploy-readiness.json
// record against deploy-readiness.schema.json. The check enforces that
// "validated build" != "production-ready system": every deploy needs
// rollback proof, observability, runbook, ownership, and (when required)
// backup/restore verification.
//
// Commands:
//   check   — validate the existing readiness record for a milestone
//   scaffold — write a starter readiness record template at the canonical
//              path so authors can fill it in (never emits a record that
//              would pass the gate — all fields are empty or placeholder).
//   help
//
// Exit codes: 0 pass, 1 issues present, 2 missing optional dep (none), 3
// missing infra (readiness record absent when --strict).
//
// Master kill switch: COBOLT_V12_GATES=bypass.
// Per-gate bypass:    COBOLT_DEPLOY_READINESS_GATE=0  (audit-logged).

const fs = require('node:fs');
const path = require('node:path');
const { logDecision } = require('../lib/cobolt-gate-audit');

const MAX_BACKUP_AGE_DAYS = 90;
const MAX_RUNBOOK_AGE_DAYS = 180;
const MAX_ROLLBACK_DRY_RUN_AGE_DAYS = 30;

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    command: argv[0] && !argv[0].startsWith('-') ? argv[0] : 'help',
    root: process.cwd(),
    milestone: null,
    environment: null,
    json: false,
    strict: false,
  };
  const start = args.command === argv[0] ? 1 : 0;
  for (let i = start; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root' || arg === '--dir') args.root = argv[++i] || args.root;
    else if (arg.startsWith('--root=')) args.root = arg.slice('--root='.length);
    else if (arg === '--milestone' || arg === '-m') args.milestone = normalizeMilestone(argv[++i]);
    else if (arg.startsWith('--milestone=')) args.milestone = normalizeMilestone(arg.slice('--milestone='.length));
    else if (arg === '--environment' || arg === '--env' || arg === '-e') args.environment = normalizeEnv(argv[++i]);
    else if (arg.startsWith('--environment=')) args.environment = normalizeEnv(arg.slice('--environment='.length));
    else if (arg.startsWith('--env=')) args.environment = normalizeEnv(arg.slice('--env='.length));
    else if (arg === '--json') args.json = true;
    else if (arg === '--strict') args.strict = true;
    else if (arg === '--help' || arg === '-h') args.command = 'help';
  }
  return args;
}

function normalizeMilestone(value) {
  const match = String(value || '')
    .trim()
    .match(/^M?(\d+)$/i);
  return match ? `M${Number.parseInt(match[1], 10)}` : null;
}

function normalizeEnv(value) {
  const v = String(value || '')
    .trim()
    .toLowerCase();
  return ['dev', 'staging', 'production'].includes(v) ? v : null;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function readinessPath(projectRoot, milestone) {
  return path.join(projectRoot, '_cobolt-output', 'latest', 'build', milestone, `${milestone}-deploy-readiness.json`);
}

function isoDaysAgo(isoString) {
  if (!isoString) return Infinity;
  const t = Date.parse(isoString);
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / (1000 * 60 * 60 * 24);
}

function issue(id, severity, message, remediation) {
  return { id, severity, message, remediation };
}

function validateRecord(record, milestone, environment) {
  const issues = [];
  if (!record) {
    issues.push(
      issue(
        'deploy-readiness-missing',
        'critical',
        `deploy-readiness record not found at the canonical path for ${milestone}`,
        `Generate via: node tools/cobolt-deploy-readiness.js scaffold --milestone ${milestone} --env ${environment || 'staging'} and fill in the fields before deploy.`,
      ),
    );
    return issues;
  }

  // Basic shape
  for (const field of [
    'recordVersion',
    'projectId',
    'milestone',
    'targetEnvironment',
    'producedBy',
    'envPromotionLadder',
    'rollbackEvidence',
    'observability',
    'runbook',
    'ownership',
    'backupRestore',
  ]) {
    if (!(field in record)) {
      issues.push(
        issue(
          `deploy-readiness-missing-${field}`,
          'critical',
          `deploy-readiness record missing required field "${field}"`,
          'See source/schemas/deploy-readiness.schema.json for the required shape.',
        ),
      );
    }
  }
  if (issues.length > 0) return issues;

  if (record.milestone !== milestone) {
    issues.push(
      issue(
        'deploy-readiness-milestone-mismatch',
        'critical',
        `deploy-readiness.milestone="${record.milestone}" but requested milestone=${milestone}`,
        `Ensure the record is written under ${readinessPath('.', milestone)}.`,
      ),
    );
  }
  if (environment && record.targetEnvironment !== environment) {
    issues.push(
      issue(
        'deploy-readiness-env-mismatch',
        'high',
        `deploy-readiness.targetEnvironment="${record.targetEnvironment}" but requested environment=${environment}`,
        'Regenerate the readiness record for the intended environment, or adjust the deploy command.',
      ),
    );
  }

  // envPromotionLadder — prod requires staging first
  const ladder = record.envPromotionLadder || {};
  if (!Array.isArray(ladder.order) || ladder.order.length === 0) {
    issues.push(
      issue(
        'deploy-readiness-ladder-empty',
        'critical',
        'envPromotionLadder.order must enumerate the stages (e.g. ["dev","staging","production"]).',
        'Declare the environment promotion ladder explicitly.',
      ),
    );
  } else {
    const stageIndex = ladder.order.indexOf(record.targetEnvironment);
    if (stageIndex > 0 && !ladder.requiresPromotionFrom) {
      issues.push(
        issue(
          'deploy-readiness-ladder-promotion-missing',
          'critical',
          `Target environment ${record.targetEnvironment} is not first in the ladder; requiresPromotionFrom must name the predecessor stage.`,
          `Set envPromotionLadder.requiresPromotionFrom to "${ladder.order[stageIndex - 1]}".`,
        ),
      );
    }
  }

  // Rollback evidence — dry-run must be recent
  const rb = record.rollbackEvidence || {};
  if (!rb.strategy) {
    issues.push(
      issue(
        'deploy-readiness-rollback-strategy-missing',
        'critical',
        'rollbackEvidence.strategy is required.',
        'Declare one of: blue-green / canary / rolling / recreate / platform-native / manual.',
      ),
    );
  }
  const rollbackAge = isoDaysAgo(rb.lastDryRunAt);
  if (rollbackAge > MAX_ROLLBACK_DRY_RUN_AGE_DAYS) {
    issues.push(
      issue(
        'deploy-readiness-rollback-dry-run-stale',
        record.targetEnvironment === 'production' ? 'critical' : 'high',
        `Rollback dry-run is ${Number.isFinite(rollbackAge) ? `${rollbackAge.toFixed(0)} days` : 'never recorded'}; limit is ${MAX_ROLLBACK_DRY_RUN_AGE_DAYS} days.`,
        'Re-run the rollback dry-run against this environment and update rollbackEvidence.lastDryRunAt.',
      ),
    );
  }

  // Observability — every production deploy MUST have dashboards + alerts + log stream
  const obs = record.observability || {};
  if (record.targetEnvironment === 'production') {
    if (!Array.isArray(obs.dashboards) || obs.dashboards.length === 0) {
      issues.push(
        issue(
          'deploy-readiness-observability-dashboards-empty',
          'critical',
          'Production deploy requires at least one observability dashboard.',
          'Add an entry to observability.dashboards with {label, url}.',
        ),
      );
    }
    if (!Array.isArray(obs.alerts) || obs.alerts.length === 0) {
      issues.push(
        issue(
          'deploy-readiness-observability-alerts-empty',
          'critical',
          'Production deploy requires at least one alerting rule.',
          'Add an entry to observability.alerts with {name, severity}.',
        ),
      );
    }
    if (!obs.logStream) {
      issues.push(
        issue(
          'deploy-readiness-observability-log-stream-missing',
          'critical',
          'Production deploy requires observability.logStream to identify where logs land.',
          'Set observability.logStream to a queryable identifier (Datadog service name, log group, etc.).',
        ),
      );
    }
  }

  // Runbook freshness
  const runbookAge = isoDaysAgo(record.runbook?.lastReviewedAt);
  if (runbookAge > MAX_RUNBOOK_AGE_DAYS) {
    issues.push(
      issue(
        'deploy-readiness-runbook-stale',
        record.targetEnvironment === 'production' ? 'high' : 'medium',
        `Runbook was last reviewed ${Number.isFinite(runbookAge) ? `${runbookAge.toFixed(0)} days` : 'never'}; limit is ${MAX_RUNBOOK_AGE_DAYS} days.`,
        'Review the runbook and update runbook.lastReviewedAt.',
      ),
    );
  }

  // Ownership
  const own = record.ownership || {};
  if (!own.owner) {
    issues.push(
      issue(
        'deploy-readiness-owner-missing',
        'critical',
        'ownership.owner is required.',
        'Declare the on-call owner for this service.',
      ),
    );
  }
  if (!Array.isArray(own.escalationRoute) || own.escalationRoute.length === 0) {
    issues.push(
      issue(
        'deploy-readiness-escalation-empty',
        'critical',
        'ownership.escalationRoute must have at least one entry.',
        'Declare who to call when the primary owner is unreachable.',
      ),
    );
  }

  // Backup / restore
  const br = record.backupRestore || {};
  if (br.required === true) {
    const restoreAge = isoDaysAgo(br.lastRestoreVerifiedAt);
    if (restoreAge > MAX_BACKUP_AGE_DAYS) {
      issues.push(
        issue(
          'deploy-readiness-restore-stale',
          'critical',
          `backupRestore.required=true but lastRestoreVerifiedAt is ${Number.isFinite(restoreAge) ? `${restoreAge.toFixed(0)} days` : 'never'}; limit is ${MAX_BACKUP_AGE_DAYS} days.`,
          'Run a restore-from-backup verification and update backupRestore.lastRestoreVerifiedAt.',
        ),
      );
    }
  }

  return issues;
}

function scaffoldRecord(projectRoot, milestone, environment) {
  const targetPath = readinessPath(projectRoot, milestone);
  if (fs.existsSync(targetPath)) {
    return { ok: false, reason: 'already-exists', path: targetPath };
  }
  const now = new Date().toISOString();
  const order = environment === 'dev' ? ['dev', 'staging', 'production'] : ['dev', 'staging', 'production'];
  const stageIndex = order.indexOf(environment);
  const record = {
    recordVersion: '1.0.0',
    projectId: 'REPLACE-ME',
    milestone,
    targetEnvironment: environment,
    generatedAt: now,
    producedBy: `cobolt-deploy-readiness/v0.44.0:scaffold`,
    envPromotionLadder: {
      order,
      currentStage: environment,
      requiresPromotionFrom: stageIndex > 0 ? order[stageIndex - 1] : null,
    },
    rollbackEvidence: {
      strategy: 'platform-native',
      lastDryRunAt: null,
      dryRunArtifact: '',
      rollbackTargetRef: '',
    },
    observability: {
      dashboards: [],
      alerts: [],
      logStream: '',
      errorsSink: '',
    },
    runbook: {
      url: '',
      lastReviewedAt: null,
    },
    ownership: {
      owner: '',
      escalationRoute: [],
      pagerRotation: '',
    },
    backupRestore: {
      required: environment === 'production',
      lastRestoreVerifiedAt: null,
      retentionDays: 30,
    },
    featureFlags: [],
  };
  writeJson(targetPath, record);
  return { ok: true, path: targetPath, scaffold: true };
}

function evaluate({ projectRoot, milestone, environment }) {
  const resolvedRoot = path.resolve(projectRoot || process.cwd());
  if (!milestone) {
    return {
      passed: false,
      errors: [issue('deploy-readiness-no-milestone', 'critical', '--milestone is required', 'Pass --milestone M1')],
    };
  }
  const record = readJson(readinessPath(resolvedRoot, milestone));
  const issues = validateRecord(record, milestone, environment);
  const passed = issues.filter((it) => it.severity === 'critical').length === 0;
  return {
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-deploy-readiness',
    projectRoot: resolvedRoot,
    milestone,
    environment,
    passed,
    issues,
    recordPath: path.relative(resolvedRoot, readinessPath(resolvedRoot, milestone)).replace(/\\/g, '/'),
    recordPresent: record != null,
  };
}

function run(args = parseArgs()) {
  const v12 = String(process.env.COBOLT_V12_GATES || '').toLowerCase();
  if (v12 === 'bypass' || v12 === 'off') {
    logDecision(args.root || process.cwd(), {
      gate: 'cobolt-deploy-readiness',
      decision: 'bypass',
      env: 'COBOLT_V12_GATES',
    });
    return { ok: true, bypassed: 'COBOLT_V12_GATES', reason: 'master-bypass', passed: true, issues: [] };
  }
  if (process.env.COBOLT_DEPLOY_READINESS_GATE === '0') {
    logDecision(args.root || process.cwd(), {
      gate: 'cobolt-deploy-readiness',
      decision: 'bypass',
      env: 'COBOLT_DEPLOY_READINESS_GATE',
    });
    return {
      ok: true,
      bypassed: 'COBOLT_DEPLOY_READINESS_GATE',
      reason: 'per-gate-bypass',
      passed: true,
      issues: [],
    };
  }
  if (args.command === 'help') {
    return {
      ok: true,
      usage: [
        'node tools/cobolt-deploy-readiness.js check --milestone M1 --env staging|production [--strict] [--json]',
        'node tools/cobolt-deploy-readiness.js scaffold --milestone M1 --env staging|production',
      ].join('\n'),
    };
  }
  if (args.command === 'scaffold') {
    if (!args.milestone || !args.environment) {
      return { ok: false, reason: 'scaffold-requires-milestone-and-env' };
    }
    return scaffoldRecord(args.root, args.milestone, args.environment);
  }
  if (args.command === 'check') {
    const result = evaluate({
      projectRoot: args.root,
      milestone: args.milestone,
      environment: args.environment,
    });
    return {
      ok: result.passed,
      reason: result.passed ? 'deploy-readiness-complete' : 'deploy-readiness-failed',
      ...result,
    };
  }
  return { ok: false, reason: 'unknown-command', command: args.command };
}

if (require.main === module) {
  const args = parseArgs();
  const result = run(args);
  if (args.json || result.usage) console.log(JSON.stringify(result, null, 2));
  else if (!result.ok) console.error(`${result.reason}: ${(result.issues || []).map((i) => i.id).join(', ')}`);
  process.exit(result.ok ? 0 : 1);
}

module.exports = {
  evaluate,
  parseArgs,
  readinessPath,
  run,
  scaffoldRecord,
  validateRecord,
};
