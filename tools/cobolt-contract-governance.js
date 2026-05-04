#!/usr/bin/env node

// CoBolt contract-governance verifier.
//
// Adds write-boundary enforcement around the existing contract semantic,
// replay, break, and invention gates:
//   1) breaking contract-registry changes require an approved renegotiation
//      ledger entry with two distinct architect-role principals and ADR evidence;
//   2) producer/consumer boundary writes require a fresh write-boundary replay
//      verdict whose contentHash matches the pending write content.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fingerprintContracts } = require('../lib/cobolt-contract-fingerprint');

const FRESH_WINDOW_MS = 72 * 60 * 60 * 1000;

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function outputRoot(cwd) {
  return path.join(cwd, '_cobolt-output');
}

function contractsPath(cwd) {
  const candidates = [
    path.join(outputRoot(cwd), 'latest', 'planning', 'interface-contracts.json'),
    path.join(outputRoot(cwd), 'planning', 'interface-contracts.json'),
  ];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  return null;
}

function normalizeRel(cwd, filePath) {
  if (!filePath) return '';
  const abs = path.isAbsolute(filePath) ? path.normalize(filePath) : path.normalize(path.join(cwd, filePath));
  return path.relative(cwd, abs).replace(/\\/g, '/');
}

function isContractRegistryPath(cwd, filePath) {
  const rel = normalizeRel(cwd, filePath);
  return /(?:^|\/)_cobolt-output\/(?:latest\/)?planning\/interface-contracts\.json$/i.test(rel);
}

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function collectStrings(value, out = []) {
  if (!value) return out;
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value)) collectStrings(v, out);
  }
  return out;
}

function contractId(contract) {
  return String(contract?.id || contract?.contractId || contract?.name || '').trim();
}

function contractsList(doc) {
  if (Array.isArray(doc)) return doc;
  return Array.isArray(doc?.contracts) ? doc.contracts : [];
}

function boundaryPaths(contract, side) {
  const keys =
    side === 'producer'
      ? [
          'producerFiles',
          'producerArtifactPaths',
          'providerFiles',
          'providerArtifactPaths',
          'outputArtifacts',
          'producerOutputs',
          'producer',
          'provider',
        ]
      : [
          'consumerFiles',
          'consumerArtifactPaths',
          'consumerInputExpectationPaths',
          'inputExpectationPaths',
          'consumerInputs',
          'consumer',
          'consumers',
        ];
  const paths = [];
  for (const key of keys) collectStrings(contract?.[key], paths);
  return paths;
}

function pathMatches(candidateRel, pattern) {
  const normalized = String(pattern || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  if (!normalized) return false;
  if (normalized.includes('*')) {
    const rx = new RegExp(
      `^${normalized
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`,
    );
    return rx.test(candidateRel);
  }
  return candidateRel === normalized || candidateRel.endsWith(`/${normalized}`);
}

function matchingBoundaries(cwd, contracts, filePath) {
  const rel = normalizeRel(cwd, filePath);
  const matches = [];
  for (const contract of contractsList(contracts)) {
    const id = contractId(contract);
    if (!id) continue;
    for (const side of ['producer', 'consumer']) {
      if (boundaryPaths(contract, side).some((p) => pathMatches(rel, p))) {
        matches.push({ contract, contractId: id, side, file: rel });
      }
    }
  }
  return matches;
}

function parseJsonLines(filePath) {
  try {
    return fs
      .readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function renegotiationEntries(cwd) {
  const candidates = [
    path.join(outputRoot(cwd), 'latest', 'contracts', 'renegotiation-ledger.jsonl'),
    path.join(outputRoot(cwd), 'audit', 'contract-renegotiation-ledger.jsonl'),
  ];
  const entries = [];
  for (const candidate of candidates) entries.push(...parseJsonLines(candidate));
  const json = readJson(path.join(outputRoot(cwd), 'latest', 'contracts', 'renegotiations.json'));
  if (Array.isArray(json)) entries.push(...json);
  else if (Array.isArray(json?.renegotiations)) entries.push(...json.renegotiations);
  return entries;
}

function approvalIdentity(approval) {
  return String(approval?.principal || approval?.actor || approval?.user || approval?.id || '').trim();
}

function approvalRole(approval) {
  return String(approval?.role || approval?.architectRole || '').trim();
}

function adrExists(cwd, entry) {
  const direct = entry.adrPath || entry.architectureDecisionRecordPath;
  if (direct) {
    const abs = path.isAbsolute(direct) ? direct : path.join(cwd, direct);
    if (fs.existsSync(abs)) return true;
  }
  const needles = [entry.renegotiationId, entry.id, entry.contractId]
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  const candidates = [
    path.join(outputRoot(cwd), 'latest', 'planning', 'architecture-decisions.md'),
    path.join(outputRoot(cwd), 'planning', 'architecture-decisions.md'),
  ];
  for (const dir of [
    path.join(outputRoot(cwd), 'latest', 'planning', 'adrs'),
    path.join(outputRoot(cwd), 'planning', 'adrs'),
  ]) {
    try {
      for (const file of fs.readdirSync(dir)) {
        if (/\.md$/i.test(file)) candidates.push(path.join(dir, file));
      }
    } catch {
      /* ignore */
    }
  }
  for (const candidate of candidates) {
    try {
      const text = fs.readFileSync(candidate, 'utf8');
      if (needles.some((needle) => text.includes(needle))) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

function approvedRenegotiationExists(cwd, contractIdValue, fromFingerprint, toFingerprint) {
  for (const entry of renegotiationEntries(cwd)) {
    if (String(entry.contractId || entry.contract || '').trim() !== contractIdValue) continue;
    if (!['approved', 'accepted'].includes(String(entry.status || '').toLowerCase())) continue;
    if (entry.fromFingerprint && entry.fromFingerprint !== fromFingerprint) continue;
    if (entry.toFingerprint && entry.toFingerprint !== toFingerprint) continue;
    const approvals = asArray(entry.approvals);
    const architectApprovals = approvals.filter((approval) => /architect/i.test(approvalRole(approval)));
    const principals = new Set(architectApprovals.map(approvalIdentity).filter(Boolean));
    const roles = new Set(architectApprovals.map(approvalRole).filter(Boolean));
    if (principals.size < 2 || roles.size < 2) continue;
    if (!adrExists(cwd, entry)) continue;
    return { ok: true, entry };
  }
  return { ok: false };
}

function checkRegistryUpdate({ cwd = process.cwd(), filePath, pendingContent }) {
  if (!isContractRegistryPath(cwd, filePath)) return { ok: true, skipped: true };
  const existingPath = contractsPath(cwd);
  const prior = existingPath ? readJson(existingPath) : null;
  let next;
  try {
    next = JSON.parse(String(pendingContent || ''));
  } catch {
    return { ok: false, reason: 'pending-contract-registry-invalid-json', failures: [] };
  }
  if (!prior) return { ok: true, skipped: true, reason: 'no prior registry' };

  const priorFp = fingerprintContracts(prior);
  const nextFp = fingerprintContracts(next);
  const failures = [];
  const changed = [];
  const priorPer = priorFp.perContract || {};
  const nextPer = nextFp.perContract || {};

  for (const id of Object.keys(priorPer)) {
    if (!(id in nextPer) || priorPer[id] !== nextPer[id]) changed.push(id);
  }

  for (const id of changed) {
    const approved = approvedRenegotiationExists(cwd, id, priorPer[id], nextPer[id]);
    if (!approved.ok) {
      failures.push({
        contractId: id,
        reason: 'missing-approved-renegotiation-quorum-and-adr',
        fromFingerprint: priorPer[id],
        toFingerprint: nextPer[id] || null,
      });
    }
  }

  return {
    ok: failures.length === 0,
    kind: 'registry-update',
    failures,
    changedContracts: changed,
  };
}

function writeBoundaryVerdictCandidates(cwd, contractIdValue, milestone) {
  const base = path.join(outputRoot(cwd), 'latest', 'contracts');
  const safeId = contractIdValue.replace(/[^a-z0-9_.-]/gi, '_');
  return [
    path.join(base, 'write-boundary-verdicts', `${safeId}.json`),
    milestone ? path.join(base, `${milestone}-write-boundary-verdict.json`) : null,
    path.join(base, 'write-boundary-verdict.json'),
  ].filter(Boolean);
}

function freshTimestamp(value, now = Date.now()) {
  const ts = Date.parse(value || '');
  return Number.isFinite(ts) && now - ts <= FRESH_WINDOW_MS;
}

function verdictRecords(verdict) {
  if (!verdict) return [];
  if (Array.isArray(verdict)) return verdict;
  if (Array.isArray(verdict.verdicts)) return verdict.verdicts;
  if (Array.isArray(verdict.boundaries)) return verdict.boundaries;
  if (Array.isArray(verdict.entries)) return verdict.entries;
  return [verdict];
}

function matchingWriteBoundaryVerdict(cwd, boundary, contentHash, milestone) {
  for (const candidate of writeBoundaryVerdictCandidates(cwd, boundary.contractId, milestone)) {
    const verdict = readJson(candidate);
    for (const record of verdictRecords(verdict)) {
      if (String(record.contractId || record.contract || '').trim() !== boundary.contractId) continue;
      if (record.side && String(record.side).toLowerCase() !== boundary.side) continue;
      if (record.contentHash !== contentHash && record.pendingContentHash !== contentHash) continue;
      if (record.ok !== true && record.passed !== true) continue;
      if (!freshTimestamp(record.measuredAt || record.generatedAt || verdict?.measuredAt || verdict?.generatedAt))
        continue;
      if (boundary.side === 'producer' && record.producerReplayPassed === false) continue;
      if (boundary.side === 'consumer' && record.consumerReplayPassed === false) continue;
      return { ok: true, path: candidate, record };
    }
  }
  return { ok: false };
}

function checkBoundaryWrite({ cwd = process.cwd(), contracts, filePath, pendingContent, milestone = null }) {
  const matches = matchingBoundaries(cwd, contracts, filePath);
  if (matches.length === 0) return { ok: true, skipped: true };
  const contentHash = sha256(pendingContent || '');
  const failures = [];
  for (const boundary of matches) {
    const verdict = matchingWriteBoundaryVerdict(cwd, boundary, contentHash, milestone);
    if (!verdict.ok) {
      failures.push({
        contractId: boundary.contractId,
        side: boundary.side,
        file: boundary.file,
        contentHash,
        reason: 'missing-fresh-write-boundary-replay-verdict',
      });
    }
  }
  return { ok: failures.length === 0, kind: 'write-boundary', contentHash, failures };
}

function pendingContentForTool(cwd, toolName, toolInput = {}) {
  const name = String(toolName || '').toLowerCase();
  const filePath = toolInput.file_path || toolInput.path || toolInput.filePath;
  if (!filePath) return { filePath: null, content: null };
  const abs = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  if (name === 'write' || toolInput.content !== undefined) {
    return { filePath, content: String(toolInput.content || '') };
  }
  let current = '';
  try {
    current = fs.readFileSync(abs, 'utf8');
  } catch {
    current = '';
  }
  if (name === 'edit' && toolInput.old_string !== undefined && toolInput.new_string !== undefined) {
    return { filePath, content: current.replace(String(toolInput.old_string), String(toolInput.new_string)) };
  }
  if (name === 'multiedit' && Array.isArray(toolInput.edits)) {
    let next = current;
    for (const edit of toolInput.edits) {
      if (edit?.old_string !== undefined && edit?.new_string !== undefined) {
        next = next.replace(String(edit.old_string), String(edit.new_string));
      }
    }
    return { filePath, content: next };
  }
  return { filePath, content: current };
}

function checkToolWrite({ cwd = process.cwd(), toolName, toolInput = {}, milestone = null } = {}) {
  const { filePath, content } = pendingContentForTool(cwd, toolName, toolInput);
  if (!filePath) return { ok: true, skipped: true, reason: 'no file path' };
  const cp = contractsPath(cwd);
  if (!cp && !isContractRegistryPath(cwd, filePath)) return { ok: true, skipped: true, reason: 'no contracts' };
  const contracts = cp ? readJson(cp) : null;

  const registry = checkRegistryUpdate({ cwd, filePath, pendingContent: content });
  if (!registry.ok) return registry;

  if (contracts) {
    const boundary = checkBoundaryWrite({ cwd, contracts, filePath, pendingContent: content, milestone });
    if (!boundary.ok) return boundary;
  }

  return { ok: true, filePath: normalizeRel(cwd, filePath) };
}

function main() {
  const cmd = process.argv[2] || 'help';
  if (cmd === 'check-write') {
    const file = process.argv[3];
    const contentFile = process.argv[4];
    const content = contentFile ? fs.readFileSync(contentFile, 'utf8') : '';
    const result = checkToolWrite({
      cwd: process.cwd(),
      toolName: 'Write',
      toolInput: { file_path: file, content },
    });
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  console.error('Usage: cobolt-contract-governance.js check-write <file> <content-file>');
  return 2;
}

if (require.main === module) process.exit(main());

module.exports = {
  sha256,
  contractsPath,
  checkRegistryUpdate,
  checkBoundaryWrite,
  checkToolWrite,
  approvedRenegotiationExists,
  matchingBoundaries,
  matchingWriteBoundaryVerdict,
  pendingContentForTool,
};
