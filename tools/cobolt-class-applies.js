#!/usr/bin/env node

// CoBolt Class-Applies CLI
//
// v0.66.5 (Wave 3b 3b-1). Process-level skip predicate over the
// lib/cobolt-pipeline-class-rules registry. Lets step files (06b/06c/06d) and
// orchestration scripts ask "does this round/step apply for the project's
// detected class?" without re-implementing the rule logic in shell.
//
// Usage:
//   node tools/cobolt-class-applies.js round <N>           [--json] [--project-root <path>]
//   node tools/cobolt-class-applies.js step <id>           [--json] [--project-root <path>]
//   node tools/cobolt-class-applies.js summary             [--json] [--project-root <path>]
//
// Examples:
//   node tools/cobolt-class-applies.js step 06b-contract-replay --json
//   node tools/cobolt-class-applies.js round 3
//
// Exit codes (per tools/CLAUDE.md contract):
//   0 — applies (run the round/step as normal)
//   1 — usage / parse error
//   3 — does NOT apply (skip the round/step) — borrowed from "missing infra"
//       semantics so pipelines that already wire exit-3 to skip-and-report
//       behavior get class-aware skipping for free.
//
// IMPORTANT: this tool is read-only and side-effect-free. It NEVER writes
// project-class.json — that's tools/cobolt-project-class.js's job. It only
// READS the artifact via the shared loader and consults the rules registry.

const path = require('node:path');
const { loadProjectClass } = require('../lib/cobolt-project-class-loader');
const {
  appliesToRound,
  appliesToStep,
  skipReasonForRound,
  skipReasonForStep,
  severityForStep,
  summarize,
} = require('../lib/cobolt-pipeline-class-rules');

const EXIT_APPLIES = 0;
const EXIT_USAGE = 1;
const EXIT_SKIP = 3;

function printUsage(stream) {
  (stream || process.stdout).write(
    'Usage: cobolt-class-applies <round N | step ID | summary> [--json] [--project-root <path>]\n' +
      '\n' +
      'Commands:\n' +
      '  round N    — does the build round number N apply for this project class?\n' +
      '  step ID    — does the named step (e.g., 06b-contract-replay) apply?\n' +
      '  summary    — emit the full applies/skip table for the detected class.\n' +
      '\n' +
      'Exit codes:\n' +
      '  0  — applies (run as normal)\n' +
      '  1  — usage error\n' +
      '  3  — does NOT apply (skip)\n' +
      '\n' +
      'When project-class.json is absent, falls back to "unknown" → applies-everywhere\n' +
      '(preserves v0.66.4 behavior so projects without the detector see no change).\n',
  );
}

function flagValue(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1];
}

function parseArgs(argv) {
  const args = argv.slice();
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    printUsage();
    process.exit(EXIT_APPLIES);
  }

  const json = args.includes('--json');
  const projectRoot = flagValue(args, '--project-root') || process.cwd();
  const positional = args.filter(
    (arg, idx) => !arg.startsWith('--') && args[idx - 1] !== '--project-root' && arg !== '--json',
  );

  const command = positional[0];
  const target = positional[1];

  if (!command || (command !== 'summary' && !target)) {
    printUsage(process.stderr);
    process.exit(EXIT_USAGE);
  }
  if (!['round', 'step', 'summary'].includes(command)) {
    process.stderr.write(`cobolt-class-applies: unknown command '${command}'\n`);
    printUsage(process.stderr);
    process.exit(EXIT_USAGE);
  }

  return { command, target, json, projectRoot: path.resolve(projectRoot) };
}

function emit(payload, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (payload.kind === 'round') {
    process.stdout.write(
      `round ${payload.roundNum} (${payload.name}): ${payload.applies ? 'APPLIES' : 'SKIP'} for projectClass=${payload.projectClass}\n`,
    );
    if (payload.skipReason) {
      process.stdout.write(`  reason: ${payload.skipReason.rationale}\n`);
    }
  } else if (payload.kind === 'step') {
    process.stdout.write(
      `step ${payload.stepId}: ${payload.applies ? 'APPLIES' : 'SKIP'} (severity=${payload.severity}) for projectClass=${payload.projectClass}\n`,
    );
    if (payload.skipReason) {
      process.stdout.write(`  reason: ${payload.skipReason.rationale}\n`);
    }
  } else if (payload.kind === 'summary') {
    process.stdout.write(`Project class: ${payload.projectClass}\n`);
    process.stdout.write(`  Source: ${payload.classSource || '(not detected)'}\n`);
    process.stdout.write('  Rounds:\n');
    for (const r of payload.summary.rounds) {
      process.stdout.write(`    ${r.roundNum} ${r.name}: ${r.applies ? 'APPLIES' : 'SKIP'}\n`);
    }
    process.stdout.write('  Steps:\n');
    for (const s of payload.summary.steps) {
      process.stdout.write(`    ${s.stepId}: ${s.applies ? 'APPLIES' : 'SKIP'} (severity=${s.severity})\n`);
    }
  }
}

function main(argv = process.argv.slice(2)) {
  const { command, target, json, projectRoot } = parseArgs(argv);
  const classInfo = loadProjectClass(projectRoot);
  const projectClass = classInfo.projectClass;

  if (command === 'round') {
    const roundNum = Number.parseInt(target, 10);
    if (!Number.isInteger(roundNum) || roundNum < 1 || roundNum > 5) {
      process.stderr.write(`cobolt-class-applies: round must be an integer 1..5; got '${target}'\n`);
      process.exit(EXIT_USAGE);
    }
    const applies = appliesToRound(roundNum, projectClass);
    const skipReason = skipReasonForRound(roundNum, projectClass);
    const payload = {
      kind: 'round',
      command: 'round',
      roundNum,
      name: skipReason ? skipReason.name : `round-${roundNum}`,
      projectClass,
      classSource: classInfo.source,
      applies,
      skipReason,
    };
    emit(payload, json);
    process.exit(applies ? EXIT_APPLIES : EXIT_SKIP);
  }

  if (command === 'step') {
    const applies = appliesToStep(target, projectClass);
    const severity = severityForStep(target, projectClass);
    const skipReason = skipReasonForStep(target, projectClass);
    const payload = {
      kind: 'step',
      command: 'step',
      stepId: target,
      projectClass,
      classSource: classInfo.source,
      applies,
      severity,
      skipReason,
    };
    emit(payload, json);
    process.exit(applies ? EXIT_APPLIES : EXIT_SKIP);
  }

  // summary
  const payload = {
    kind: 'summary',
    command: 'summary',
    projectClass,
    classSource: classInfo.source,
    classConfidence: classInfo.confidence,
    summary: summarize(projectClass),
  };
  emit(payload, json);
  process.exit(EXIT_APPLIES);
}

if (require.main === module) {
  main();
}

module.exports = {
  EXIT_APPLIES,
  EXIT_USAGE,
  EXIT_SKIP,
  parseArgs,
  main,
};
