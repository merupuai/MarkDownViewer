#!/usr/bin/env node

const path = require('node:path');

const enterprise = require('../lib/cobolt-enterprise');

function argValue(args, name, fallback = null) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] || fallback : fallback;
}

function cmdInit(args) {
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  const output = argValue(args, '--output');
  const policyPath = enterprise.writeDefaultRbacPolicy(root, output);
  console.log(`rbac policy written: ${policyPath}`);
  return 0;
}

function cmdCheck(args) {
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  const action = argValue(args, '--action', 'status:show');
  const role = argValue(args, '--role');
  const tenant = argValue(args, '--tenant');
  const policyPath = argValue(args, '--policy');
  const decision = enterprise.checkRbacAccess({ projectRoot: root, action, role, tenant, policyPath });
  console.log(JSON.stringify({ schema: 'cobolt-rbac-check@1', ...decision }, null, 2));
  return decision.ok ? 0 : 1;
}

function cmdWhoami(args) {
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  const loaded = enterprise.loadRbacPolicy(root, argValue(args, '--policy'));
  const tenant = enterprise.resolveTenant(root, argValue(args, '--tenant'));
  console.log(
    JSON.stringify(
      {
        schema: 'cobolt-rbac-identity@1',
        configured: loaded.configured,
        role: enterprise.activeRole(root, loaded.policy),
        tenant,
        policyPath: loaded.policyPath,
      },
      null,
      2,
    ),
  );
  return 0;
}

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  const args = argv.slice(1);
  if (cmd === 'init') return cmdInit(args);
  if (cmd === 'check' || cmd === 'authorize') return cmdCheck(args);
  if (cmd === 'whoami') return cmdWhoami(args);
  console.log('Usage: node tools/cobolt-rbac.js init|check|whoami [--role ROLE] [--tenant TENANT] [--action ACTION]');
  return cmd ? 1 : 0;
}

if (require.main === module) process.exit(main());

module.exports = { main, cmdInit, cmdCheck, cmdWhoami };
