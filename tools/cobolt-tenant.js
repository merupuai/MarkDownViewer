#!/usr/bin/env node

const path = require('node:path');

const enterprise = require('../lib/cobolt-enterprise');

function argValue(args, name, fallback = null) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] || fallback : fallback;
}

function cmdInit(args) {
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  const tenant = argValue(args, '--tenant', args[0] || enterprise.DEFAULT_TENANT);
  const profile = enterprise.ensureTenant(root, tenant, {
    owner: argValue(args, '--owner'),
    description: argValue(args, '--description'),
  });
  console.log(JSON.stringify(profile, null, 2));
  return 0;
}

function cmdList(args) {
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  console.log(JSON.stringify({ schema: 'cobolt-tenant-list@1', tenants: enterprise.listTenants(root) }, null, 2));
  return 0;
}

function cmdPath(args) {
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  const tenant = enterprise.resolveTenant(root, argValue(args, '--tenant', args[0]));
  console.log(enterprise.tenantOutputRoot(root, tenant));
  return 0;
}

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  const args = argv.slice(1);
  if (cmd === 'init') return cmdInit(args);
  if (cmd === 'list' || cmd === 'status') return cmdList(args);
  if (cmd === 'path') return cmdPath(args);
  console.log('Usage: node tools/cobolt-tenant.js init|list|path [--tenant TENANT]');
  return cmd ? 1 : 0;
}

if (require.main === module) process.exit(main());

module.exports = { main, cmdInit, cmdList, cmdPath };
