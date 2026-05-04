#!/usr/bin/env node

// CoBolt Auth Contract - auth/session redirect test obligation wrapper.

const fs = require('node:fs');
const path = require('node:path');

const { evaluateTestObligations, formatBlockingFailures } = require('../lib/cobolt-test-obligations');

function findTddEvidence(projectRoot, milestone) {
  const candidates = [
    path.join(projectRoot, '_cobolt-output', 'latest', 'build', milestone, `${milestone}-test-plan.json`),
    path.join(projectRoot, '_cobolt-output', 'latest', 'build', `${milestone}-test-plan.json`),
    path.join(projectRoot, '_cobolt-output', 'latest', 'build', 'checkpoints', `${milestone}-02-tdd-red.json`),
    path.join(projectRoot, '_cobolt-output', 'build', 'checkpoints', `${milestone}-02-tdd-red.json`),
  ];
  return candidates.filter((candidate) => fs.existsSync(candidate));
}

function authObligationsFor(projectRoot, milestone, options = {}) {
  const report = evaluateTestObligations(projectRoot, milestone, options);
  const authObligations = (report.obligations || []).filter((obligation) =>
    String(obligation.id || '').startsWith('auth_'),
  );
  return { report, authObligations };
}

function checkAuthContract(projectRoot = process.cwd(), milestone = 'M1') {
  const preflight = authObligationsFor(projectRoot, milestone);
  const tddEvidence = findTddEvidence(projectRoot, milestone);

  if (preflight.authObligations.length > 0 && tddEvidence.length === 0) {
    return {
      passed: true,
      milestone,
      authRequired: true,
      deferredToTddRed: true,
      blocking: [],
      obligations: preflight.authObligations,
      message: 'Auth contract obligations detected; file enforcement deferred until TDD RED evidence exists.',
    };
  }

  const { report, authObligations } = authObligationsFor(projectRoot, milestone, { enforceFiles: true });
  const blocking = authObligations.filter((obligation) => (obligation.failures || []).length > 0);
  return {
    passed: blocking.length === 0,
    milestone,
    authRequired: authObligations.length > 0,
    deferredToTddRed: false,
    blocking,
    obligations: authObligations,
    message:
      blocking.length === 0
        ? 'Auth contract obligations passed or no auth flow was required.'
        : formatBlockingFailures({ ...report, obligations: blocking }),
  };
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'check';
  const json = argv.includes('--json');
  const milestone = argv.find((arg, index) => index > 0 && /^M\d+$/i.test(arg)) || 'M1';
  if (command !== 'check') {
    console.error('Usage: node tools/cobolt-auth-contract.js check M1 [--json]');
    process.exit(2);
  }
  const report = checkAuthContract(process.cwd(), milestone);
  if (json) console.log(JSON.stringify(report, null, 2));
  else if (report.passed) console.log(`[cobolt-auth-contract] ${report.message}`);
  else console.error(`[cobolt-auth-contract] ${report.message}`);
  process.exit(report.passed ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  checkAuthContract,
};
