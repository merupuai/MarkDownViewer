#!/usr/bin/env node

// CoBolt Hotfix Release Contract
//
// Materializes the compressed emergency-release controls that still must be
// present before a hotfix ships.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_OUTPUT_DIR = path.join('_cobolt-output', 'latest', 'fix');
const REQUIRED_FIELDS = [
  'incidentId',
  'severity',
  'approval',
  'minimalVerification',
  'rollback',
  'communication',
  'deployWindow',
  'postDeployMonitoring',
  'rcaDeadline',
  'retrospective',
];

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function readJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseArgs(argv) {
  const out = {
    outputDir: DEFAULT_OUTPUT_DIR,
    incidentId: null,
    severity: 'high',
    approval: null,
    minimalVerification: null,
    rollback: null,
    communication: null,
    deployWindow: null,
    postDeployMonitoring: null,
    rcaDeadline: null,
    retrospective: null,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output-dir') out.outputDir = argv[++index] || out.outputDir;
    else if (arg === '--incident-id') out.incidentId = argv[++index] || null;
    else if (arg === '--severity') out.severity = argv[++index] || out.severity;
    else if (arg === '--approval' || arg === '--approved-by') out.approval = argv[++index] || null;
    else if (arg === '--verification' || arg === '--minimal-verification')
      out.minimalVerification = argv[++index] || null;
    else if (arg === '--rollback') out.rollback = argv[++index] || null;
    else if (arg === '--communication') out.communication = argv[++index] || null;
    else if (arg === '--deploy-window') out.deployWindow = argv[++index] || null;
    else if (arg === '--monitoring' || arg === '--post-deploy-monitoring')
      out.postDeployMonitoring = argv[++index] || null;
    else if (arg === '--rca-deadline') out.rcaDeadline = argv[++index] || null;
    else if (arg === '--retrospective' || arg === '--dream-update') out.retrospective = argv[++index] || null;
    else if (arg === '--json') out.json = true;
    else if (arg.startsWith('--')) out.unknown = arg;
  }
  return out;
}

function normalizeSeverity(value) {
  const severity = String(value || '')
    .trim()
    .toLowerCase();
  return ['critical', 'high', 'medium', 'low'].includes(severity) ? severity : 'high';
}

function validateHotfixContract(contract) {
  const issues = [];
  for (const field of REQUIRED_FIELDS) {
    if (!String(contract?.[field] || '').trim()) issues.push(`missing:${field}`);
  }
  const rcaDeadline = Date.parse(contract?.rcaDeadline || '');
  if (!Number.isFinite(rcaDeadline)) issues.push('invalid:rcaDeadline');
  return {
    passed: issues.length === 0,
    issues,
  };
}

function buildHotfixContract(options = {}) {
  const contract = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-hotfix-release-contract',
    required: true,
    incidentId: options.incidentId,
    severity: normalizeSeverity(options.severity),
    approval: options.approval,
    minimalVerification: options.minimalVerification,
    rollback: options.rollback,
    communication: options.communication,
    deployWindow: options.deployWindow,
    postDeployMonitoring: options.postDeployMonitoring,
    rcaDeadline: options.rcaDeadline,
    retrospective: options.retrospective,
  };
  const validation = validateHotfixContract(contract);
  return {
    ...contract,
    status: validation.passed ? 'ready' : 'blocked',
    passed: validation.passed,
    issues: validation.issues,
  };
}

function contractPath(outputDir = DEFAULT_OUTPUT_DIR) {
  return path.join(outputDir, 'hotfix-release-contract.json');
}

function runGenerate(options = {}) {
  const contract = buildHotfixContract(options);
  writeJson(contractPath(options.outputDir), contract);
  return contract;
}

function runCheck(options = {}) {
  const contract = readJson(contractPath(options.outputDir));
  if (!contract) {
    return {
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      generatedBy: 'cobolt-hotfix-release-contract',
      required: true,
      status: 'blocked',
      passed: false,
      issues: ['missing:hotfix-release-contract.json'],
    };
  }
  const validation = validateHotfixContract(contract);
  const next = {
    ...contract,
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-hotfix-release-contract',
    status: validation.passed ? 'ready' : 'blocked',
    passed: validation.passed,
    issues: validation.issues,
  };
  writeJson(contractPath(options.outputDir), next);
  return next;
}

function printUsage() {
  console.log(`
CoBolt Hotfix Release Contract

Usage:
  node tools/cobolt-hotfix-release-contract.js generate --incident-id <id> --severity critical --approval <who> --verification <artifact> --rollback <plan> --communication <note> --deploy-window <window> --monitoring <artifact> --rca-deadline <iso> --retrospective <path> [--output-dir <dir>] [--json]
  node tools/cobolt-hotfix-release-contract.js check [--output-dir <dir>] [--json]
`);
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseArgs(rest);
  if (command !== 'generate' && command !== 'check') {
    printUsage();
    return command ? 2 : 0;
  }
  const result = command === 'generate' ? runGenerate(options) : runCheck(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`[cobolt-hotfix-release-contract] ${result.status}`);
  return result.passed ? 0 : 1;
}

if (require.main === module) process.exit(main());

module.exports = {
  REQUIRED_FIELDS,
  buildHotfixContract,
  runCheck,
  runGenerate,
  validateHotfixContract,
};
