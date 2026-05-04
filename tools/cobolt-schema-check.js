#!/usr/bin/env node

// CoBolt Schema Check — validate an artifact JSON file against a schema in source/schemas/.
//
// Skill-safe wrapper around lib/schema-validator. Skills cannot require('./lib/...')
// (lib/ does not exist in user projects), so this tool is the approved entry point
// invoked via `node tools/cobolt-schema-check.js` — the skill bootstrap junctions
// the CoBolt-install tools/ directory into the user project, and this tool then
// reaches its own ../lib/schema-validator at install-time paths.
//
// Usage:
//   node tools/cobolt-schema-check.js --schema <schema.json> --artifact <path> [--milestone M{n}]

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--schema') args.schema = argv[++i];
    else if (a === '--artifact') args.artifact = argv[++i];
    else if (a === '--milestone') args.milestone = argv[++i];
    else if (a === '--schemas-dir') args.schemasDir = argv[++i];
  }
  return args;
}

function resolveSchemasDir(explicit) {
  if (explicit && fs.existsSync(explicit)) return path.resolve(explicit);
  const candidates = [path.join(process.cwd(), 'source', 'schemas'), path.join(__dirname, '..', 'source', 'schemas')];
  for (const c of candidates) {
    if (fs.existsSync(c)) return path.resolve(c);
  }
  return null;
}

function writeReport(milestone, report) {
  if (!milestone) return;
  const outDir = path.join(process.cwd(), '_cobolt-output', 'latest', 'build', milestone);
  try {
    atomicWrite(path.join(outDir, `${milestone}-schema-check-report.json`), JSON.stringify(report, null, 2));
  } catch {
    // non-fatal: report write is advisory only
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.schema || !args.artifact) {
    console.error('Usage: cobolt-schema-check --schema <schema.json> --artifact <path> [--milestone M{n}]');
    process.exit(2);
  }
  const schemasDir = resolveSchemasDir(args.schemasDir);
  if (!schemasDir) {
    console.error('FATAL: cannot locate source/schemas/ — pass --schemas-dir explicitly.');
    process.exit(2);
  }
  const artifactPath = path.resolve(args.artifact);
  if (!fs.existsSync(artifactPath)) {
    console.error(`FATAL: artifact not found: ${artifactPath}`);
    writeReport(args.milestone, {
      valid: false,
      schema: args.schema,
      artifact: artifactPath,
      errors: ['artifact-missing'],
    });
    process.exit(1);
  }

  let artifact;
  try {
    artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  } catch (e) {
    console.error(`FATAL: artifact is not valid JSON: ${e.message}`);
    writeReport(args.milestone, { valid: false, errors: [`json-parse: ${e.message}`] });
    process.exit(1);
  }

  let SchemaValidator;
  try {
    ({ SchemaValidator } = require('../lib/schema-validator'));
  } catch (e) {
    console.error(`FATAL: lib/schema-validator unavailable: ${e.message}`);
    process.exit(2);
  }

  const validator = new SchemaValidator(schemasDir);
  const result = validator.validate(artifact, args.schema);
  writeReport(args.milestone, {
    valid: result.valid,
    schema: args.schema,
    artifact: artifactPath,
    errors: result.errors || [],
    checkedAt: new Date().toISOString(),
  });
  if (!result.valid) {
    console.error(`HARD GATE FAIL: ${args.schema} validation failed.`);
    for (const err of result.errors || []) console.error(`  - ${err}`);
    process.exit(1);
  }
  console.log(`OK: ${path.basename(artifactPath)} conforms to ${args.schema}`);
}

main();
