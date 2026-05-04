#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const {
  appendExecutionEvent,
  checkExecutionConsistency,
  projectExecutionLedger,
  readExecutionLedger,
  seedExecutionLedger,
} = require('../lib/cobolt-execution-ledger');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    command: argv[0] || 'project',
    json: false,
    eventType: 'artifact_written',
    source: 'tool',
    severity: 'info',
    data: {},
    metadata: {},
    artifacts: [],
  };

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--event-type') args.eventType = argv[++i] || args.eventType;
    else if (arg === '--source') args.source = argv[++i] || args.source;
    else if (arg === '--severity') args.severity = argv[++i] || args.severity;
    else if (arg === '--data-file') args.data = safeReadJson(argv[++i], {});
    else if (arg === '--metadata-file') args.metadata = safeReadJson(argv[++i], {});
    else if (arg === '--artifact') args.artifacts.push(argv[++i]);
    else if (arg === '--help' || arg === '-h') args.command = 'help';
  }

  return args;
}

function safeReadJson(filePath, fallback = {}) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  } catch {
    return fallback;
  }
}

function print(result, jsonMode) {
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result?.usage) {
    console.log(result.usage);
    return;
  }

  if (result?.event) {
    console.log(`[cobolt-execution-ledger] appended ${result.event.event_type} (${result.event.cursor})`);
    return;
  }

  if (result?.check) {
    if (result.check.ok) console.log('[cobolt-execution-ledger] consistency check passed');
    else console.error(`[cobolt-execution-ledger] consistency check failed: ${result.check.errors.join(' | ')}`);
    return;
  }

  if (result?.ledger && result?.projections) {
    console.log(
      `[cobolt-execution-ledger] projected ${result.ledger.items.length} item(s) across ${result.projections.milestones.milestones.length} milestone(s)`,
    );
    return;
  }

  if (result?.ledger) {
    console.log(`[cobolt-execution-ledger] ledger has ${result.ledger.items.length} item(s)`);
  }
}

function main() {
  const args = parseArgs();
  try {
    let result;
    switch (args.command) {
      case 'seed':
        result = { ledger: seedExecutionLedger(process.cwd()) };
        break;
      case 'append':
        result = {
          event: appendExecutionEvent(process.cwd(), {
            event_type: args.eventType,
            source: args.source,
            severity: args.severity,
            data: args.data,
            metadata: args.metadata,
            artifactPaths: args.artifacts,
          }),
        };
        break;
      case 'project':
        result = projectExecutionLedger(process.cwd());
        break;
      case 'check':
        result = { check: checkExecutionConsistency(process.cwd()) };
        break;
      case 'show':
        result = { ledger: readExecutionLedger(process.cwd()) };
        break;
      default:
        result = {
          usage: [
            'Usage: node tools/cobolt-execution-ledger.js <command> [options]',
            '',
            'Commands:',
            '  seed                 Seed ledger from planning artifacts',
            '  append               Append one evidence-event-compatible execution event',
            '  project              Materialize status/progress/milestones/findings projections',
            '  check                Validate projection consistency and freshness',
            '  show                 Print the current ledger',
            '',
            'Options:',
            '  --json',
            '  --event-type <type>',
            '  --source <source>',
            '  --severity <severity>',
            '  --data-file <path>',
            '  --metadata-file <path>',
            '  --artifact <path>',
          ].join('\n'),
        };
        break;
    }

    print(result, args.json);
    const exitCode = result?.check?.ok === false ? 1 : 0;
    process.exit(exitCode);
  } catch (error) {
    const payload = { ok: false, error: error.message || String(error) };
    if (args.json) console.log(JSON.stringify(payload, null, 2));
    else console.error(`[cobolt-execution-ledger] ${payload.error}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  appendExecutionEvent,
  checkExecutionConsistency,
  projectExecutionLedger,
  readExecutionLedger,
  seedExecutionLedger,
};
