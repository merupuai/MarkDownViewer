#!/usr/bin/env node

// CoBolt Fix Risk Acceptance
//
// Produces and validates the fix-level risk-acceptance.json contract with
// HMAC-backed approvals for unresolved high-risk findings.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_OUTPUT_DIR = path.join('_cobolt-output', 'latest', 'fix');
const HIGH_RISK_PREFIXES = new Set([
  'SEC',
  'AUTHZ',
  'AISEC',
  'PEN',
  'SIL',
  'COMP',
  'DB',
  'QRY',
  'INT',
  'API',
  'WIRE',
  'APIWIRE',
  'OPS',
  'CONF',
  'DEP',
]);
const RESOLVED_STATUSES = new Set(['verified-resolved', 'resolved', 'closed', 'accepted-resolved']);

function readJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function riskContractPath(outputDir = DEFAULT_OUTPUT_DIR) {
  return path.join(outputDir, 'risk-acceptance.json');
}

function requireAuditSecret() {
  const secret = String(process.env.COBOLT_AUDIT_SECRET || '').trim();
  if (!secret || secret === 'default-audit-secret-CHANGE-ME') {
    throw new Error('COBOLT_AUDIT_SECRET is required to sign or verify fix risk acceptances');
  }
  return secret;
}

function canonicalAcceptance(acceptance) {
  const clone = { ...acceptance };
  delete clone.hmac;
  delete clone.signature;
  return clone;
}

function signAcceptance(acceptance, secret = requireAuditSecret()) {
  return crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(canonicalAcceptance(acceptance)))
    .digest('hex');
}

function defaultContract() {
  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-fix-risk-acceptance',
    policy: {
      requiredFor:
        'unresolved critical/high security, compliance, supply-chain, data, authz, integration, deployment, or NFR findings before release',
      signature: 'HMAC-SHA256 over the acceptance payload without hmac/signature fields',
    },
    acceptances: [],
    pending: [],
    summary: {
      passed: true,
      required: 0,
      accepted: 0,
      missing: 0,
      invalid: 0,
      expired: 0,
    },
  };
}

function loadContract(outputDir = DEFAULT_OUTPUT_DIR) {
  return readJson(riskContractPath(outputDir)) || defaultContract();
}

function parseArgs(argv) {
  const out = {
    outputDir: DEFAULT_OUTPUT_DIR,
    tracker: null,
    findingId: null,
    severity: null,
    domain: [],
    owner: null,
    expiresAt: null,
    scope: null,
    justification: null,
    compensatingControl: null,
    evidence: [],
    approvedBy: null,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output-dir') out.outputDir = argv[++index] || out.outputDir;
    else if (arg === '--tracker') out.tracker = argv[++index] || null;
    else if (arg === '--finding' || arg === '--finding-id') out.findingId = argv[++index] || null;
    else if (arg === '--severity') out.severity = argv[++index] || null;
    else if (arg === '--domain') out.domain.push(argv[++index]);
    else if (arg === '--owner') out.owner = argv[++index] || null;
    else if (arg === '--expires' || arg === '--expires-at') out.expiresAt = argv[++index] || null;
    else if (arg === '--scope') out.scope = argv[++index] || null;
    else if (arg === '--justification') out.justification = argv[++index] || null;
    else if (arg === '--control' || arg === '--compensating-control') out.compensatingControl = argv[++index] || null;
    else if (arg === '--evidence') out.evidence.push(argv[++index]);
    else if (arg === '--approved-by' || arg === '--approver') out.approvedBy = argv[++index] || null;
    else if (arg === '--json') out.json = true;
    else if (arg.startsWith('--')) out.unknown = arg;
  }
  out.domain = out.domain.flatMap((value) => String(value || '').split(/[,\s]+/u)).filter(Boolean);
  out.evidence = out.evidence.flatMap((value) => String(value || '').split(/[,\s]+/u)).filter(Boolean);
  return out;
}

function normalizeSeverity(value) {
  const severity = String(value || '')
    .trim()
    .toLowerCase();
  return ['critical', 'high', 'medium', 'low'].includes(severity) ? severity : 'medium';
}

function riskDomainsForFinding(finding) {
  const prefix = String(finding?.prefix || finding?.id || '').match(/^([A-Z]+)/u)?.[1] || 'CODE';
  const domains = [];
  if (['SEC', 'AUTHZ', 'AISEC', 'PEN', 'SIL'].includes(prefix)) domains.push('security-privacy');
  if (prefix === 'COMP') domains.push('compliance');
  if (['DB', 'QRY'].includes(prefix)) domains.push('data-migration');
  if (['INT', 'API', 'WIRE', 'APIWIRE'].includes(prefix)) domains.push('integration');
  if (['OPS', 'CONF', 'DEP'].includes(prefix)) domains.push('operations');
  return domains.length > 0 ? domains : ['code-quality'];
}

function isRiskAcceptanceRequired(finding) {
  const severity = normalizeSeverity(finding?.severity);
  const prefix = String(finding?.prefix || finding?.id || '').match(/^([A-Z]+)/u)?.[1] || '';
  const status = String(finding?.status || 'open').toLowerCase();
  return ['critical', 'high'].includes(severity) && !RESOLVED_STATUSES.has(status) && HIGH_RISK_PREFIXES.has(prefix);
}

function requiredAcceptancesFromTracker(trackerPath) {
  const tracker = readJson(trackerPath);
  const findings = Array.isArray(tracker?.findings)
    ? tracker.findings
    : Array.isArray(tracker?.items)
      ? tracker.items
      : [];
  return findings.filter(isRiskAcceptanceRequired).map((finding) => ({
    findingId: String(finding.id || '').trim(),
    severity: normalizeSeverity(finding.severity),
    riskDomains: riskDomainsForFinding(finding),
    status: String(finding.status || 'open').toLowerCase(),
  }));
}

function validateAcceptance(acceptance, now = new Date()) {
  const issues = [];
  for (const field of [
    'findingId',
    'severity',
    'riskDomains',
    'owner',
    'expiresAt',
    'scope',
    'justification',
    'compensatingControl',
    'evidence',
    'approvedBy',
    'acceptedAt',
    'hmac',
  ]) {
    if (Array.isArray(acceptance?.[field])) {
      if (acceptance[field].length === 0) issues.push(`missing:${field}`);
    } else if (!String(acceptance?.[field] || '').trim()) {
      issues.push(`missing:${field}`);
    }
  }
  const expiresAt = Date.parse(acceptance?.expiresAt || '');
  if (!Number.isFinite(expiresAt)) issues.push('invalid-expiry');
  else if (expiresAt <= now.getTime()) issues.push('expired');
  if (String(acceptance?.justification || '').trim().length < 20) issues.push('weak-justification');
  try {
    const expected = signAcceptance(acceptance);
    if (acceptance.hmac !== expected) issues.push('invalid-hmac');
  } catch (error) {
    issues.push(`hmac-check-failed:${error.message}`);
  }
  return {
    findingId: acceptance?.findingId || null,
    valid: issues.length === 0,
    issues,
  };
}

function createAcceptance(options = {}) {
  const acceptance = {
    findingId: options.findingId,
    severity: normalizeSeverity(options.severity),
    riskDomains: options.domain && options.domain.length > 0 ? options.domain : ['code-quality'],
    owner: options.owner,
    expiresAt: options.expiresAt,
    scope: options.scope,
    justification: options.justification,
    compensatingControl: options.compensatingControl,
    evidence: options.evidence || [],
    approvedBy: options.approvedBy,
    acceptedAt: new Date().toISOString(),
  };
  const dryValidation = validateAcceptance({ ...acceptance, hmac: 'placeholder' });
  const blocking = dryValidation.issues.filter((issue) => !issue.startsWith('invalid-hmac'));
  if (blocking.length > 0) {
    throw new Error(`Risk acceptance is incomplete: ${blocking.join(', ')}`);
  }
  acceptance.hmac = signAcceptance(acceptance);
  return acceptance;
}

function acceptRisk(options = {}) {
  const contract = loadContract(options.outputDir);
  const acceptance = createAcceptance(options);
  const acceptances = Array.isArray(contract.acceptances) ? contract.acceptances : [];
  const next = {
    ...contract,
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-fix-risk-acceptance',
    acceptances: [...acceptances.filter((entry) => entry.findingId !== acceptance.findingId), acceptance],
  };
  writeJson(riskContractPath(options.outputDir), next);
  return { ok: true, acceptance, contract: next };
}

function checkRiskAcceptances(options = {}) {
  const contract = loadContract(options.outputDir);
  const required = options.tracker
    ? requiredAcceptancesFromTracker(options.tracker)
    : Array.isArray(contract.pending)
      ? contract.pending
      : [];
  const acceptances = Array.isArray(contract.acceptances) ? contract.acceptances : [];
  const validations = acceptances.map((acceptance) => validateAcceptance(acceptance));
  const validByFinding = new Set(validations.filter((result) => result.valid).map((result) => result.findingId));
  const missing = required.filter((entry) => !validByFinding.has(entry.findingId));
  const invalid = validations.filter((result) => result.issues.some((issue) => !['expired'].includes(issue)));
  const expired = validations.filter((result) => result.issues.includes('expired'));
  const summary = {
    passed: missing.length === 0 && invalid.length === 0 && expired.length === 0,
    required: required.length,
    accepted: validByFinding.size,
    missing: missing.length,
    invalid: invalid.length,
    expired: expired.length,
  };
  const next = {
    ...contract,
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-fix-risk-acceptance',
    pending: missing,
    validations,
    summary,
  };
  writeJson(riskContractPath(options.outputDir), next);
  return next;
}

function printUsage() {
  console.log(`
CoBolt Fix Risk Acceptance

Usage:
  node tools/cobolt-fix-risk-acceptance.js accept --finding <id> --severity high --domain security-privacy --owner <name> --expires <iso> --scope <scope> --justification <text> --control <text> --evidence <path> --approved-by <name> [--output-dir <dir>]
  node tools/cobolt-fix-risk-acceptance.js check [--tracker <finding-tracker.json>] [--output-dir <dir>] [--json]
  node tools/cobolt-fix-risk-acceptance.js list [--output-dir <dir>] [--json]
`);
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseArgs(rest);
  try {
    if (command === 'accept') {
      const result = acceptRisk(options);
      console.log(JSON.stringify(options.json ? result : { ok: result.ok, acceptance: result.acceptance }, null, 2));
      return 0;
    }
    if (command === 'check') {
      const result = checkRiskAcceptances(options);
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`[cobolt-fix-risk-acceptance] ${result.summary.passed ? 'pass' : 'fail'}`);
      return result.summary.passed ? 0 : 1;
    }
    if (command === 'list') {
      const result = loadContract(options.outputDir);
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    printUsage();
    return command ? 2 : 0;
  } catch (error) {
    if (options.json) console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    else console.error(`[cobolt-fix-risk-acceptance] ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exit(main());

module.exports = {
  HIGH_RISK_PREFIXES,
  acceptRisk,
  checkRiskAcceptances,
  createAcceptance,
  isRiskAcceptanceRequired,
  requiredAcceptancesFromTracker,
  riskDomainsForFinding,
  signAcceptance,
  validateAcceptance,
};
