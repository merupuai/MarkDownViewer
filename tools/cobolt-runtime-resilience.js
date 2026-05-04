#!/usr/bin/env node

const path = require('node:path');

const runtime = require('../lib/cobolt-runtime-resilience');

function printHelp() {
  console.log(`Usage: node tools/cobolt-runtime-resilience.js <subcommand> [flags]

Subcommands:
  check                         Validate RT registry, protocol pinning, and gate telemetry surfaces
  report                        Write runtime-resilience.json and closure-class transparency report
  fault-inject                  List or run registered failure-class regression commands
  doctor                        Human-readable alias for check

Flags:
  --json                        Print machine-readable JSON
  --no-write                    report only: do not write files
  --run                         fault-inject only: execute commands instead of listing them
  --no-protocol                 Skip protocol CLI execution (test harness only)
  --root <path>                 Project root (default: cwd)
  --registry <path>             Registry path relative to root
  --help, -h                    Show this help
`);
}

function parseCommon(args) {
  const options = {
    rootDir: process.cwd(),
    registryPath: undefined,
    json: false,
    noWrite: false,
    run: false,
    skipProtocol: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--no-write') options.noWrite = true;
    else if (arg === '--run') options.run = true;
    else if (arg === '--no-protocol') options.skipProtocol = true;
    else if (arg === '--root') options.rootDir = path.resolve(args[++i] || options.rootDir);
    else if (arg.startsWith('--root=')) options.rootDir = path.resolve(arg.slice('--root='.length));
    else if (arg === '--registry') options.registryPath = args[++i];
    else if (arg.startsWith('--registry=')) options.registryPath = arg.slice('--registry='.length);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function formatCheck(result) {
  const lines = [];
  lines.push(`Runtime resilience: ${result.ok ? 'PASS' : 'FAIL'}`);
  lines.push(`  Closure classes: ${result.summary.closureClasses}`);
  lines.push(`  Fault commands: ${result.summary.classesWithFaultCommands}`);
  lines.push(`  Adversarial probes: ${result.summary.adversarialProbes}`);
  lines.push(`  Protocol check: ${result.protocol.ok ? 'PASS' : 'FAIL'}`);
  lines.push(`  Gate telemetry surface: ${result.gateTelemetry.ok ? 'PASS' : 'FAIL'}`);
  if (result.registry.warnings.length > 0) {
    lines.push('  Warnings:');
    for (const warning of result.registry.warnings) lines.push(`    - ${warning.code}: ${warning.message}`);
  }
  if (result.findings.length > 0) {
    lines.push('  Findings:');
    for (const finding of result.findings) lines.push(`    - ${finding.code}: ${finding.message}`);
  }
  return lines.join('\n');
}

function formatFaultInjection(result) {
  const lines = [];
  lines.push(
    `Runtime resilience fault injection: ${result.ok ? 'PASS' : 'FAIL'} (${result.run ? 'executed' : 'planned'})`,
  );
  for (const item of result.results) {
    lines.push(`  - ${item.status.padEnd(7)} ${item.classId}: ${item.command}`);
    if (item.outputTail) lines.push(`    ${item.outputTail.replace(/\r?\n/g, '\n    ')}`);
  }
  if (result.findings.length > 0) {
    lines.push('  Findings:');
    for (const finding of result.findings) lines.push(`    - ${finding.code}: ${finding.message}`);
  }
  return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
    return 0;
  }

  const sub = argv[0];
  const options = parseCommon(argv.slice(1));
  if (options.help) {
    printHelp();
    return 0;
  }

  if (sub === 'check' || sub === 'doctor') {
    const result = runtime.checkRuntimeResilience(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else console.log(formatCheck(result));
    return result.ok ? 0 : 1;
  }

  if (sub === 'report') {
    const report = runtime.buildReport(options);
    let reports = null;
    if (!options.noWrite) reports = runtime.writeReports(report, options.rootDir);
    if (options.json) console.log(JSON.stringify({ ...report, reports }, null, 2));
    else {
      console.log(formatCheck({ ...report, registry: report.registry, summary: report.summary }));
      if (reports) {
        console.log(`  JSON: ${reports.jsonPath}`);
        console.log(`  Markdown: ${reports.mdPath}`);
      }
    }
    return report.ok ? 0 : 1;
  }

  if (sub === 'fault-inject') {
    const result = runtime.runFaultInjection(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else console.log(formatFaultInjection(result));
    return result.ok ? 0 : 1;
  }

  throw new Error(`Unknown subcommand: ${sub}`);
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { main, parseCommon };
