#!/usr/bin/env node

const path = require('node:path');

const telemetry = require('../lib/cobolt-telemetry');

function argValue(args, name, fallback = null) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] || fallback : fallback;
}

function cmdCertify(args) {
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  const result = telemetry.certifyNoNetwork(root);
  const out = args.includes('--no-write') ? null : telemetry.writeTelemetryReport(root, result);
  console.log(JSON.stringify({ ...result, reportPath: out }, null, 2));
  return result.ok ? 0 : 1;
}

function cmdScan(args) {
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  const result = telemetry.scanNetworkCallsites(root);
  const out = args.includes('--no-write')
    ? null
    : telemetry.writeTelemetryReport(root, result, 'network-callsites.json');
  console.log(JSON.stringify({ ...result, reportPath: out }, null, 2));
  return 0;
}

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0] || 'certify';
  const args = argv.slice(1);
  if (cmd === 'certify' || cmd === 'no-network') return cmdCertify(args);
  if (cmd === 'scan') return cmdScan(args);
  console.log('Usage: node tools/cobolt-telemetry.js certify|scan [--root DIR]');
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = { main, cmdCertify, cmdScan };
