#!/usr/bin/env node

// CoBolt Security Finding Acceptance Workflow
//
// Records a reviewer-approved acceptance of a critical/high security finding
// so cobolt-security-hard-gate.js stops blocking. Requires justification +
// reviewer name + HMAC signature for tamper detection.
//
// Usage:
//   node tools/cobolt-security-accept.js <FINDING_ID> \
//     --justification "<why>" \
//     --reviewer "<name>" \
//     [--expires "2026-07-13"]
//
//   node tools/cobolt-security-accept.js list
//   node tools/cobolt-security-accept.js revoke <FINDING_ID>
//
// Storage: _cobolt-output/audit/accepted-findings.jsonl (append-only)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function requireAuditSecret() {
  const secret = String(process.env.COBOLT_AUDIT_SECRET || '').trim();
  if (!secret || secret === 'default-audit-secret-CHANGE-ME') {
    throw new Error('COBOLT_AUDIT_SECRET is required to sign accepted security findings');
  }
  return secret;
}

function auditDir() {
  const d = path.join(process.cwd(), '_cobolt-output', 'audit');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

function logFile() {
  return path.join(auditDir(), 'accepted-findings.jsonl');
}

function signEntry(entry) {
  const auditKey = requireAuditSecret();
  const canonical = JSON.stringify({ ...entry, hmac: undefined });
  return crypto.createHmac('sha256', auditKey).update(canonical).digest('hex');
}

function accept(id, opts) {
  if (!id || !opts.justification || !opts.reviewer) {
    throw new Error('FINDING_ID, --justification, and --reviewer are all required');
  }
  if (opts.justification.length < 20) {
    throw new Error('justification must be at least 20 characters — explain why this is accepted');
  }

  const entry = {
    id,
    status: 'accepted',
    justification: opts.justification,
    reviewer: opts.reviewer,
    acceptedAt: new Date().toISOString(),
    expiresAt: opts.expires || null,
    pid: process.pid,
  };
  entry.hmac = signEntry(entry);

  fs.appendFileSync(logFile(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, accepted: entry }, null, 2));
  return 0;
}

function list() {
  const fp = logFile();
  if (!fs.existsSync(fp)) {
    console.log(JSON.stringify({ entries: [] }, null, 2));
    return 0;
  }
  const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean);
  const entries = lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { raw: l, error: 'parse' };
    }
  });
  console.log(JSON.stringify({ count: entries.length, entries }, null, 2));
  return 0;
}

function revoke(id) {
  if (!id) throw new Error('FINDING_ID required');
  const entry = {
    id,
    status: 'revoked',
    revokedAt: new Date().toISOString(),
  };
  entry.hmac = signEntry(entry);
  fs.appendFileSync(logFile(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, revoked: entry }, null, 2));
  return 0;
}

function parseFlags(args) {
  const out = { _: [], justification: null, reviewer: null, expires: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--justification') out.justification = args[++i];
    else if (args[i] === '--reviewer') out.reviewer = args[++i];
    else if (args[i] === '--expires') out.expires = args[++i];
    else out._.push(args[i]);
  }
  return out;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  try {
    if (cmd === 'list') return list();
    if (cmd === 'revoke') return revoke(flags._[0]);
    // default path: accept with ID as first positional
    const id = cmd && !cmd.startsWith('--') ? cmd : flags._[0];
    return accept(id, flags);
  } catch (err) {
    console.error(`[cobolt-security-accept] ${err.message}`);
    return 1;
  }
}

if (require.main === module) process.exit(main());

module.exports = { accept, list, revoke, signEntry, requireAuditSecret };
