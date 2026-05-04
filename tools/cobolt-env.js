#!/usr/bin/env node

// CoBolt Environment Configuration (.env.cobolt)
//
// Manages user-provided infrastructure configuration. Users declare
// their existing services so the pipeline skips auto-provisioning.
//
// Usage:
//   node tools/cobolt-env.js init                   # Generate .env.cobolt template
//   node tools/cobolt-env.js validate               # Validate .env.cobolt
//   node tools/cobolt-env.js status                 # Show provided vs auto-provisioned
//   node tools/cobolt-env.js merge [--dry-run]      # Merge into infra-manifest.json
//   node tools/cobolt-env.js show [section]         # Show parsed config (JSON)

const fs = require('node:fs');
const path = require('node:path');
const coboltEnv = require('../lib/cobolt-env');
const telemetry = require('../lib/cobolt-telemetry');
const { createSecretsProvider, loadProviderConfig } = require('../lib/cobolt-secrets-provider');
const coboltPaths = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return null;
  }
})();

const PROJECT_ROOT = process.cwd();

// ── Commands ─────────────────────────────────────────────────

/**
 * Generate .env.cobolt template from source/templates/env-cobolt.template.
 * Sets file permissions to 0o600 and ensures .gitignore entry.
 */
function cmdInit() {
  const dest = path.join(PROJECT_ROOT, coboltEnv.ENV_FILENAME);
  if (fs.existsSync(dest)) {
    coboltEnv.ensureGitignored(PROJECT_ROOT);
    const security = coboltEnv.secureEnvFile(dest);
    console.log(`  ${coboltEnv.ENV_FILENAME} already exists at ${dest}`);
    console.log('  Repaired .gitignore entry and re-applied best-effort file hardening.');
    if (security.warning) {
      console.log(`  WARNING: ${security.warning}`);
    }
    console.log('  Use "validate" or "status" to inspect it.');
    return;
  }

  // Find template
  let templatePath = null;
  if (coboltPaths) {
    const p = coboltPaths.paths(PROJECT_ROOT);
    if (typeof p.envCoboltTemplate === 'function') {
      templatePath = p.envCoboltTemplate();
    }
  }
  if (!templatePath || !fs.existsSync(templatePath)) {
    templatePath = path.join(PROJECT_ROOT, 'source', 'templates', 'env-cobolt.template');
  }
  if (!templatePath || !fs.existsSync(templatePath)) {
    // Fallback: look relative to this file (installed context)
    templatePath = path.join(__dirname, '..', 'source', 'templates', 'env-cobolt.template');
  }

  if (!fs.existsSync(templatePath)) {
    console.error('  ERROR: Template not found. Expected at source/templates/env-cobolt.template');
    process.exit(1);
  }

  fs.copyFileSync(templatePath, dest);
  coboltEnv.ensureGitignored(PROJECT_ROOT);
  const security = coboltEnv.secureEnvFile(dest);

  console.log(`  Created ${coboltEnv.ENV_FILENAME} from template.`);
  if (security.warning) {
    console.log(`  WARNING: ${security.warning}`);
  }
  console.log(`  Edit it with your infrastructure details, then run: node tools/cobolt-env.js validate`);
}

/**
 * Parse and validate .env.cobolt, print results.
 */
function cmdValidate(args = []) {
  if (args.includes('--no-network')) {
    const result = telemetry.certifyNoNetwork(PROJECT_ROOT);
    telemetry.writeTelemetryReport(PROJECT_ROOT, result);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  const filePath = coboltEnv.discover(PROJECT_ROOT);
  if (!filePath) {
    console.log(`  ${coboltEnv.ENV_FILENAME} not found. Run: node tools/cobolt-env.js init`);
    process.exit(1);
  }

  const env = coboltEnv.parse(filePath);
  const result = coboltEnv.validate(env);

  console.log();
  console.log('  CoBolt Environment Validation');
  console.log('  ════════════════════════════════════════');
  console.log(`  File: ${filePath}`);
  console.log(`  Keys: ${Object.keys(env).length}`);
  console.log(`  Valid: ${result.valid ? 'YES' : 'NO'}`);
  console.log();

  if (result.errors.length > 0) {
    console.log('  Errors:');
    for (const err of result.errors) {
      console.log(`    - ${err}`);
    }
    console.log();
  }

  if (result.warnings.length > 0) {
    console.log('  Warnings:');
    for (const warn of result.warnings) {
      console.log(`    - ${warn}`);
    }
    console.log();
  }

  if (result.valid && result.warnings.length === 0) {
    console.log('  All checks passed.');
  }

  process.exit(result.valid ? 0 : 1);
}

/**
 * Parse .env.cobolt and show status of provided vs auto-provisioned sections.
 */
function cmdStatus() {
  const filePath = coboltEnv.discover(PROJECT_ROOT);
  if (!filePath) {
    console.log(`  ${coboltEnv.ENV_FILENAME} not found. All services will be auto-provisioned.`);
    console.log(`  Run: node tools/cobolt-env.js init`);
    return;
  }

  const env = coboltEnv.parse(filePath);
  const result = coboltEnv.status(env);

  console.log();
  console.log('  CoBolt Environment Status');
  console.log('  ════════════════════════════════════════');
  console.log(`  File: ${filePath}`);
  console.log(`  ${result.summary}`);
  console.log();

  if (result.provided.length > 0) {
    console.log('  Provided (skip auto-provisioning):');
    for (const s of result.provided) {
      console.log(`    + ${s}`);
    }
    console.log();
  }

  if (result.missing.length > 0) {
    console.log('  Missing (will be auto-provisioned):');
    for (const s of result.missing) {
      console.log(`    - ${s}`);
    }
    console.log();
  }
}

/**
 * Load infra-manifest.json, merge .env.cobolt values, optionally write.
 * @param {boolean} dryRun - If true, print merged result without writing
 */
function cmdMerge(dryRun) {
  const env = coboltEnv.load(PROJECT_ROOT);
  if (Object.keys(env).length === 0) {
    console.log(`  ${coboltEnv.ENV_FILENAME} not found or empty. Nothing to merge.`);
    process.exit(1);
  }

  // Find infra-manifest.json
  let manifestPath = null;
  if (coboltPaths) {
    const p = coboltPaths.paths(PROJECT_ROOT);
    if (typeof p.infraManifest === 'function') {
      manifestPath = p.infraManifest();
    }
  }
  if (!manifestPath) {
    manifestPath = path.join(PROJECT_ROOT, '_cobolt-output', 'latest', 'infra', 'infra-manifest.json');
  }

  if (!fs.existsSync(manifestPath)) {
    console.log(`  infra-manifest.json not found at ${manifestPath}`);
    console.log('  Run cobolt-infra first to generate it, then merge.');
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const merged = coboltEnv.mergeIntoManifest(manifest, env);

  if (dryRun) {
    console.log();
    console.log('  CoBolt Environment Merge (DRY RUN)');
    console.log('  ════════════════════════════════════════');
    console.log('  The following would be written to infra-manifest.json:');
    console.log();
    console.log(JSON.stringify(merged, null, 2));
    return;
  }

  fs.writeFileSync(manifestPath, JSON.stringify(merged, null, 2), 'utf8');
  console.log(`  Merged ${coboltEnv.ENV_FILENAME} into ${manifestPath}`);
}

/**
 * Parse .env.cobolt, extract structure, print as JSON.
 * Optionally filter to a specific section.
 * @param {string|null} section
 */
function cmdShow(section) {
  const env = coboltEnv.load(PROJECT_ROOT);
  if (Object.keys(env).length === 0) {
    console.log(`  ${coboltEnv.ENV_FILENAME} not found or empty.`);
    process.exit(1);
  }

  const structured = coboltEnv.structure(env);

  if (section) {
    if (section in structured) {
      console.log(JSON.stringify(structured[section], null, 2));
    } else {
      console.error(`  Unknown section '${section}'. Available: ${Object.keys(structured).join(', ')}`);
      process.exit(1);
    }
    return;
  }

  console.log(JSON.stringify(structured, null, 2));
}

function valueFromArgs(args) {
  const valueIdx = args.indexOf('--value');
  if (valueIdx >= 0) return args[valueIdx + 1] || '';
  const fileIdx = args.indexOf('--value-file');
  if (fileIdx >= 0) return fs.readFileSync(path.resolve(args[fileIdx + 1]), 'utf8').trim();
  return undefined;
}

function argValue(args, name, fallback = null) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] || fallback : fallback;
}

function cmdRotate(key, args = []) {
  if (!key) {
    console.error('  rotate requires a key name');
    process.exit(1);
  }
  const configPath = argValue(args, '--config');
  const source = argValue(args, '--source', 'manual');
  const config = loadProviderConfig(PROJECT_ROOT, configPath ? { configPath: path.resolve(configPath) } : {});
  if (args.includes('--provider')) {
    const providerIdx = args.indexOf('--provider');
    config.type = args[providerIdx + 1] || config.type;
  }
  const provider = createSecretsProvider(PROJECT_ROOT, { config });
  const result = provider.rotate(key, { value: valueFromArgs(args), source });
  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        key: result.key,
        provider: result.provider,
        rotatedAt: result.ledgerEntry?.ts,
        ledgerSignature: result.ledgerEntry?.signature?.type,
      },
      null,
      2,
    ),
  );
}

function cmdAudit(args = []) {
  const configPath = argValue(args, '--config');
  const config = loadProviderConfig(PROJECT_ROOT, configPath ? { configPath: path.resolve(configPath) } : {});
  const provider = createSecretsProvider(PROJECT_ROOT, { config });
  const rows = provider.audit();
  console.log(
    JSON.stringify(
      {
        schema: 'cobolt-secrets-audit@1',
        generatedAt: new Date().toISOString(),
        provider: provider.type,
        keys: rows,
      },
      null,
      2,
    ),
  );
}

// ── CLI ──────────────────────────────────────────────────────

function printUsage() {
  console.log();
  console.log('  CoBolt Environment Configuration (.env.cobolt)');
  console.log('  ══════════════════════════════════════════════════');
  console.log();
  console.log('  Usage: node tools/cobolt-env.js <command> [options]');
  console.log();
  console.log('  Commands:');
  console.log('    init                Generate .env.cobolt template (chmod 0o600, gitignored)');
  console.log('    validate            Parse and validate .env.cobolt');
  console.log('    status              Show provided vs auto-provisioned sections');
  console.log('    merge [--dry-run]   Merge into infra-manifest.json');
  console.log('    show [section]      Show parsed config as JSON');
  console.log('    rotate <KEY>        Rotate a secret through the configured provider');
  console.log('    audit               Show secret age / rotation ledger evidence');
  console.log('    validate --no-network  Certify default-off telemetry/no-network posture');
  console.log();
  console.log('  Sections for "show": target, registry, database, cache, cloud,');
  console.log('    paas, k8s, secrets, domain, observability, app, ci, custom_services');
  console.log();
}

// ── Module exports (for programmatic use) ────────────────────

module.exports = { cmdInit, cmdValidate, cmdStatus, cmdMerge, cmdShow, cmdRotate, cmdAudit };

// ── CLI entry point ──────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    printUsage();
    process.exit(0);
  }

  switch (cmd) {
    case 'init':
      cmdInit();
      break;
    case 'validate':
      cmdValidate(args.slice(1));
      break;
    case 'status':
      cmdStatus();
      break;
    case 'merge':
      cmdMerge(args.includes('--dry-run'));
      break;
    case 'show':
      cmdShow(args[1] || null);
      break;
    case 'rotate':
      cmdRotate(args[1], args.slice(2));
      break;
    case 'audit':
      cmdAudit(args.slice(1));
      break;
    default:
      console.error(`  Unknown command: ${cmd}`);
      printUsage();
      process.exit(1);
  }
}
