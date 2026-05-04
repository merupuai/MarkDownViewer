#!/usr/bin/env node
/**
 * cobolt-production-evidence-validate
 *
 * Deterministic pre-gate schema validator for the 4 production-evidence
 * artifacts consumed by cobolt-production-evidence:
 *   - executable-prd.json
 *   - release-slices.json
 *   - architecture-readiness.json
 *   - boundary-contracts.json
 *
 * Exit 0: all schemas valid.
 * Exit 1: one or more artifacts violate their schema (human-readable errors).
 * Exit 2: missing mandatory artifact (before the business-logic gate runs).
 *
 * Run BEFORE cobolt-production-evidence.js check so LLM producers see a
 * clear "required field X missing" error instead of cryptic business-logic
 * failures like "all-frs-executable [fail]" with 39 FR IDs in evidence.
 *
 * Added v0.40.5 because production-evidence expectations were encoded only
 * in source; real pipeline runs surfaced the gap when an LLM-authored
 * artifact violated the shape and the user had no schema to consult.
 */

const fs = require('node:fs');
const path = require('node:path');

const ARTIFACTS = [
  {
    id: 'executable-prd',
    filename: 'executable-prd.json',
    schema: 'executable-prd.schema.json',
    requiredRootKeys: ['version', 'requirements'],
    perItemRequired: {
      field: 'requirements',
      keys: [
        'id',
        'acceptanceCriteria',
        'negativeCases',
        'edgeCases',
        'permissions',
        'dataLifecycle',
        'auditLogging',
        'performanceTargets',
        'securityRequirements',
        'failureBehavior',
        'observability',
        'migrationRollback',
        'stateTransitions',
        'apiContracts',
        'e2eScenarios',
      ],
    },
  },
  {
    id: 'release-slices',
    filename: 'release-slices.json',
    schema: 'release-slices.schema.json',
    requiredRootKeys: ['version', 'slices', 'sharedCapabilities'],
    sharedCapabilities: ['auth', 'billing', 'notifications', 'files', 'search', 'permissions'],
    perItemRequired: {
      field: 'slices',
      keys: ['id', 'milestone', 'frs', 'ui', 'api', 'database', 'tests', 'observability'],
    },
  },
  {
    id: 'architecture-readiness',
    filename: 'architecture-readiness.json',
    schema: 'architecture-readiness.schema.json',
    requiredRootKeys: ['version', 'controls'],
    requiredControlKeys: [
      'boundedContexts',
      'databaseOwnership',
      'versionedApiContracts',
      'authRbacTenantModel',
      'backgroundJobsRetries',
      'integrationContracts',
      'failureModes',
      'nfrBudgets',
    ],
  },
  {
    id: 'boundary-contracts',
    filename: 'boundary-contracts.json',
    schema: 'boundary-contracts.schema.json',
    requiredRootKeys: ['version', 'boundaries'],
    boundaryTypes: [
      'frontend-backend-api',
      'backend-database-schema',
      'service-queue',
      'webhooks',
      'third-party-integrations',
      'auth-session',
      'file-storage',
      'email-sms-payment',
      'feature-flags-config',
    ],
  },
];

function loadPlanningDir(projectRoot) {
  const candidates = [
    path.join(projectRoot, '_cobolt-output', 'latest', 'planning'),
    path.join(projectRoot, '_cobolt-output', 'planning'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function validateArtifact(planningDir, spec) {
  const errors = [];
  const warnings = [];
  const filepath = path.join(planningDir, spec.filename);

  if (!fs.existsSync(filepath)) {
    return {
      id: spec.id,
      filename: spec.filename,
      exists: false,
      schemaPath: spec.schema,
      errors: [`Artifact missing: ${filepath}`],
      warnings: [],
      valid: false,
    };
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (err) {
    return {
      id: spec.id,
      filename: spec.filename,
      exists: true,
      schemaPath: spec.schema,
      errors: [`JSON parse error: ${err.message}`],
      warnings: [],
      valid: false,
    };
  }

  // Root-level required keys.
  for (const key of spec.requiredRootKeys) {
    if (!Object.hasOwn(data, key)) {
      errors.push(`Root missing required key "${key}" (schema: ${spec.schema})`);
    }
  }

  // Version pin.
  if (data.version !== undefined && data.version !== 1) {
    errors.push(`version must be 1 (got ${JSON.stringify(data.version)})`);
  }

  // Per-item required keys (for arrays of objects).
  if (spec.perItemRequired) {
    const arr = data[spec.perItemRequired.field];
    if (!Array.isArray(arr)) {
      errors.push(`Field "${spec.perItemRequired.field}" must be an array (schema: ${spec.schema})`);
    } else {
      arr.forEach((item, idx) => {
        if (!item || typeof item !== 'object') {
          errors.push(`${spec.perItemRequired.field}[${idx}] must be an object`);
          return;
        }
        for (const k of spec.perItemRequired.keys) {
          if (!Object.hasOwn(item, k)) {
            errors.push(
              `${spec.perItemRequired.field}[${idx}] (${item.id || item.featureId || 'unknown'}) missing required key "${k}"`,
            );
            continue;
          }
          // v0.40.5: reject empty array values on required fields so producers
          // get the diagnostic at schema-validation time instead of at the
          // business-logic gate (where the error surfaces as "executable-field-
          // depth [fail] incomplete: [26 FRs with missing fields]" with no
          // actionable hint). The business-logic gate `evaluatePrdDepth`
          // requires every array field to have ≥1 item.
          const v = item[k];
          if (Array.isArray(v) && v.length === 0) {
            errors.push(
              `${spec.perItemRequired.field}[${idx}] (${item.id || item.featureId || 'unknown'}) field "${k}" must not be empty array — add at least one entry or use "N/A: <reason>" string if the concept is genuinely absent`,
            );
          }
        }
      });
    }
  }

  // Shared capabilities check (release-slices).
  if (spec.sharedCapabilities) {
    const sc = data.sharedCapabilities || {};
    for (const cap of spec.sharedCapabilities) {
      if (!Object.hasOwn(sc, cap)) {
        errors.push(`sharedCapabilities missing required key "${cap}"`);
      } else if (!sc[cap] || sc[cap].platformOwned !== true) {
        errors.push(`sharedCapabilities.${cap}.platformOwned must be true`);
      }
    }
  }

  // Boundary types check (boundary-contracts).
  if (spec.boundaryTypes) {
    const declaredTypes = new Set((data.boundaries || []).map((b) => b?.type).filter(Boolean));
    for (const t of spec.boundaryTypes) {
      if (!declaredTypes.has(t)) {
        errors.push(`boundaries missing required type "${t}"`);
      }
    }
    // External boundaries need realOrSandboxVerified OR notApplicable:true
    const external = new Set(['webhooks', 'third-party-integrations', 'file-storage', 'email-sms-payment']);
    for (const b of data.boundaries || []) {
      if (external.has(b?.type)) {
        const hasVerified = b.realOrSandboxVerified === true || b.notApplicable === true;
        if (!hasVerified) {
          errors.push(
            `boundaries[type=${b.type}] external boundary requires realOrSandboxVerified:true OR notApplicable:true`,
          );
        }
      }
    }
  }

  // Architecture-readiness: controls live under data.controls.<key>.
  // Every control must be present and have passed:true OR status:'pass'/'passed'.
  if (spec.id === 'architecture-readiness') {
    const controls = data?.controls && typeof data.controls === 'object' ? data.controls : null;
    if (!controls) {
      errors.push('architecture-readiness.json must have a "controls" object wrapper (data.controls.<name>)');
    } else {
      for (const k of spec.requiredControlKeys || []) {
        if (!Object.hasOwn(controls, k)) {
          errors.push(`controls.${k} missing (required by architecture-gate dimension)`);
        } else {
          const c = controls[k];
          const passed =
            c === true ||
            (c &&
              typeof c === 'object' &&
              (c.passed === true ||
                ['pass', 'passed', 'ok', 'verified', 'not-applicable'].includes(
                  String(c.status || '').toLowerCase(),
                ))) ||
            (typeof c === 'string' && ['pass', 'passed', 'ok', 'verified', 'not-applicable'].includes(c.toLowerCase()));
          if (!passed) {
            warnings.push(`controls.${k} is not in a passing state — will fail architecture-gate`);
          }
        }
      }
    }
  }

  return {
    id: spec.id,
    filename: spec.filename,
    exists: true,
    schemaPath: spec.schema,
    errors,
    warnings,
    valid: errors.length === 0,
  };
}

function validateProductionEvidenceArtifacts(projectRoot = process.cwd()) {
  const planningDir = loadPlanningDir(projectRoot);
  if (!planningDir) {
    return {
      status: 'missing-planning-dir',
      projectRoot,
      planningDir: null,
      results: [],
      summary: {
        total: ARTIFACTS.length,
        valid: 0,
        invalid: 0,
        missing: ARTIFACTS.length,
      },
      reason:
        'No _cobolt-output/latest/planning or _cobolt-output/planning directory found. ' +
        'Validator cannot run without a plan packet. Remediation:\n' +
        '  (A) For a real project plan: run `/cobolt-plan` (or `cobolt-cli plan --auto`).\n' +
        '  (B) For CoBolt internal self-audit only: run `node tools/cobolt-self-audit-stub-pack.js generate --force`.\n' +
        'NOTE: production-readiness-check no longer auto-generates a stub plan. This is intentional — ' +
        'silent stub generation previously clobbered real plan packets.',
      remediation: {
        realPlan: '/cobolt-plan or cobolt-cli plan --auto',
        selfAudit: 'node tools/cobolt-self-audit-stub-pack.js generate --force',
      },
      passed: false,
    };
  }

  const results = ARTIFACTS.map((spec) => validateArtifact(planningDir, spec));
  const anyMissing = results.some((r) => !r.exists);
  const anyInvalid = results.some((r) => !r.valid);

  return {
    generatedAt: new Date().toISOString(),
    projectRoot,
    planningDir,
    results,
    summary: {
      total: results.length,
      valid: results.filter((r) => r.valid).length,
      invalid: results.filter((r) => !r.valid && r.exists).length,
      missing: results.filter((r) => !r.exists).length,
    },
    passed: !anyMissing && !anyInvalid,
  };
}

function run(args) {
  const jsonMode = args.includes('--json');
  const projectArg = args.indexOf('--project');
  const projectRoot = projectArg >= 0 && args[projectArg + 1] ? path.resolve(args[projectArg + 1]) : process.cwd();

  const report = validateProductionEvidenceArtifacts(projectRoot);
  if (report.status === 'missing-planning-dir') {
    if (jsonMode) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stderr.write(`[production-evidence-validate] ${report.reason}\n`);
    process.exit(2);
  }

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write('[production-evidence-validate] Schema check for 4 pre-build artifacts\n');
    for (const r of report.results) {
      const flag = r.valid ? 'OK' : r.exists ? 'INVALID' : 'MISSING';
      process.stdout.write(`  [${flag}] ${r.filename} (schema: ${r.schemaPath})\n`);
      for (const e of r.errors) process.stdout.write(`      - ${e}\n`);
      for (const w of r.warnings) process.stdout.write(`      ! ${w}\n`);
    }
    process.stdout.write(`\nResult: ${report.passed ? 'PASS' : 'FAIL'}\n`);
  }

  if (report.summary.missing > 0) process.exit(2);
  if (report.summary.invalid > 0) process.exit(1);
  process.exit(0);
}

function usage() {
  process.stdout.write('Usage: node tools/cobolt-production-evidence-validate.js [--project <dir>] [--json]\n\n');
  process.stdout.write('Exit codes:\n');
  process.stdout.write('  0  All 4 artifacts schema-valid\n');
  process.stdout.write('  1  Schema violations (see stderr/JSON for details)\n');
  process.stdout.write('  2  Missing artifact or planning dir\n');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    process.exit(0);
  }
  // Tool-exit-contract: positional args that aren't flags or known subcommands
  // are misuse. This tool takes no subcommands — only flags.
  const unknown = args.filter((a) => !a.startsWith('--') && !a.startsWith('-'));
  // --project takes a value, consume it
  const projIdx = args.indexOf('--project');
  if (projIdx >= 0 && args[projIdx + 1]) {
    const consumed = args[projIdx + 1];
    const idx = unknown.indexOf(consumed);
    if (idx >= 0) unknown.splice(idx, 1);
  }
  if (unknown.length > 0) {
    process.stderr.write(`unknown argument: ${unknown[0]}\n`);
    usage();
    process.exit(1);
  }
  run(args);
}

module.exports = { validateArtifact, validateProductionEvidenceArtifacts, loadPlanningDir, ARTIFACTS };
