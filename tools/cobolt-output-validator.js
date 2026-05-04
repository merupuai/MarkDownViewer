#!/usr/bin/env node

// Deterministic output validator CLI.
// Complements the hook implementation by supporting explicit schema/file checks
// used by pipeline orchestrators, especially cobolt-fix agent output validation.

const fs = require('node:fs');
const path = require('node:path');
const { SchemaValidator } = require('../lib/schema-validator');

const SCHEMA_ALIASES = {
  'fix-agent-output': 'agent-outputs/fix-agent-output.schema.json',
  'fix-report': 'agent-outputs/fix-report.schema.json',
  'finding-tracker': 'finding-tracker.schema.json',
  'review-findings': 'review-findings.schema.json',
};

function parseArgs(argv) {
  const out = { schema: null, file: null, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--schema') {
      out.schema = argv[i + 1] || null;
      i += 1;
    } else if (arg.startsWith('--schema=')) out.schema = arg.slice('--schema='.length);
    else if (arg === '--file') {
      out.file = argv[i + 1] || null;
      i += 1;
    } else if (arg.startsWith('--file=')) out.file = arg.slice('--file='.length);
    else if (arg.startsWith('--')) out.unknown = arg;
  }
  return out;
}

function printUsage() {
  console.log('Usage: node tools/cobolt-output-validator.js --schema <name|schema.json> --file <json> [--json]');
  console.log();
  console.log('Known aliases: fix-agent-output, fix-report, finding-tracker, review-findings');
}

function resolveSchemasDir(root = process.cwd()) {
  const candidates = [
    path.join(root, 'source', 'schemas'),
    path.join(__dirname, '..', 'source', 'schemas'),
    process.env.COBOLT_HOME && path.join(process.env.COBOLT_HOME, 'source', 'schemas'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function normalizeSchemaName(schemaName) {
  if (!schemaName) return null;
  if (SCHEMA_ALIASES[schemaName]) return SCHEMA_ALIASES[schemaName];
  return schemaName.replace(/\\/g, '/');
}

function validateFile({ schema, file, cwd = process.cwd() }) {
  const schemaFile = normalizeSchemaName(schema);
  if (!schemaFile) {
    return { ok: false, schema: null, file, errors: ['Missing --schema'] };
  }
  if (!file) {
    return { ok: false, schema: schemaFile, file: null, errors: ['Missing --file'] };
  }

  const filePath = path.resolve(cwd, file);
  if (!fs.existsSync(filePath)) {
    return { ok: false, schema: schemaFile, file: filePath, errors: [`File not found: ${filePath}`] };
  }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return { ok: false, schema: schemaFile, file: filePath, errors: [`Invalid JSON: ${error.message}`] };
  }

  const schemasDir = resolveSchemasDir(cwd);
  if (!schemasDir) {
    return { ok: false, schema: schemaFile, file: filePath, errors: ['Could not resolve source/schemas directory'] };
  }

  const validator = new SchemaValidator(schemasDir);
  const result = validator.validate(payload, schemaFile);
  return {
    ok: result.valid,
    schema: schemaFile,
    file: filePath,
    errors: result.errors,
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printUsage();
    return 0;
  }
  if (args.unknown) {
    console.error(`Unknown option: ${args.unknown}`);
    printUsage();
    return 2;
  }

  const result = validateFile(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(`[cobolt-output-validator] PASS ${result.file} against ${result.schema}`);
  } else {
    console.error(
      `[cobolt-output-validator] FAIL ${result.file || '(missing file)'} against ${result.schema || '(missing schema)'}`,
    );
    for (const error of result.errors || []) console.error(`  - ${error}`);
  }
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  SCHEMA_ALIASES,
  normalizeSchemaName,
  resolveSchemasDir,
  validateFile,
  main,
};
