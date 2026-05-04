#!/usr/bin/env node

// CoBolt Dispatch Depth Manager
//
// Universal dispatch depth tracking for ALL pipelines (build, fix, review, brownfield).
// Skills call this BEFORE and AFTER dispatching agents so the sub-agent write guard
// can detect nested dispatches and block file-writing sub-agents.
//
// Usage:
//   node tools/cobolt-dispatch-depth.js set <level>   — set depth to specific level
//   node tools/cobolt-dispatch-depth.js get            — read current depth (exits with depth as code)
//   node tools/cobolt-dispatch-depth.js enter          — increment depth + write marker file
//   node tools/cobolt-dispatch-depth.js exit           — decrement depth + remove marker if depth 0
//   node tools/cobolt-dispatch-depth.js reset          — force reset to 0 (cleanup)
//
// State: pipeline.dispatchDepth in cobolt-state.json
// Marker: _cobolt-output/.agent-dispatch-active (JSON, auto-detection fallback)

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
const {
  DEFAULT_DISPATCH_TOKEN_TTL_MS,
  computeWorkspaceHash,
  resolveConfiguredTokenTtlMs,
} = require('../lib/cobolt-dispatch-token-policy');
const STATE_FILE = path.join(process.cwd(), 'cobolt-state.json');
const MARKER_DIR = path.join(process.cwd(), '_cobolt-output');
const MARKER_FILE = path.join(MARKER_DIR, '.agent-dispatch-active');
const DISPATCH_TOKEN_FILE = path.join(MARKER_DIR, '.dispatch-round-token.json');
const EXPERT_GOVERNANCE_FILE = path.join(MARKER_DIR, '.expert-governance.json');
const DISPATCH_TOKEN_TTL_MS = DEFAULT_DISPATCH_TOKEN_TTL_MS;

// ── State helpers ───────────────────────────────────────────

function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  atomicWrite(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function getCurrentDepth(state) {
  const s = state || readState();
  if (s.pipeline && typeof s.pipeline.dispatchDepth === 'number') {
    return s.pipeline.dispatchDepth;
  }
  // Legacy fallback
  if (s.build && typeof s.build.dispatchDepth === 'number') {
    return s.build.dispatchDepth;
  }
  return 0;
}

function setDepth(level) {
  const state = readState();
  if (!state.pipeline) state.pipeline = {};
  state.pipeline.dispatchDepth = level;
  writeState(state);
  return level;
}

// ── Marker file (auto-detection fallback for hooks) ─────────

function writeMarker(depth) {
  try {
    const marker = {
      depth,
      timestamp: new Date().toISOString(),
      pid: process.pid,
    };
    atomicWrite(MARKER_FILE, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  } catch {
    /* marker is advisory — never fail loudly */
  }
}

function removeMarker() {
  try {
    if (fs.existsSync(MARKER_FILE)) fs.unlinkSync(MARKER_FILE);
  } catch {
    /* best effort */
  }
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeExpertList(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(raw.map((entry) => String(entry || '').trim()).filter(Boolean))];
}

function readExpertGovernance(state = readState()) {
  const governance = state.pipeline?.expertGovernance || {};
  return {
    orchestrator: governance.orchestrator || null,
    maxActiveExperts: Number.isFinite(Number(governance.maxActiveExperts))
      ? Math.max(1, Number(governance.maxActiveExperts))
      : null,
    fixedExpertSet: normalizeExpertList(governance.fixedExpertSet),
    activeExperts: normalizeExpertList(governance.activeExperts),
    claimedAt: governance.claimedAt || null,
    updatedAt: governance.updatedAt || null,
  };
}

function writeExpertGovernanceMarker(governance) {
  try {
    atomicWrite(EXPERT_GOVERNANCE_FILE, `${JSON.stringify(governance)}\n`, { mode: 0o600 });
  } catch {
    /* marker is advisory */
  }
}

function clearExpertGovernanceMarker() {
  try {
    if (fs.existsSync(EXPERT_GOVERNANCE_FILE)) fs.unlinkSync(EXPERT_GOVERNANCE_FILE);
  } catch {
    /* best effort */
  }
}

function persistExpertGovernance(next, state = readState()) {
  if (!state.pipeline) state.pipeline = {};
  const governance = {
    orchestrator: next.orchestrator || null,
    maxActiveExperts: next.maxActiveExperts || null,
    fixedExpertSet: normalizeExpertList(next.fixedExpertSet),
    activeExperts: normalizeExpertList(next.activeExperts),
    claimedAt: next.claimedAt || null,
    updatedAt: nowIso(),
  };
  state.pipeline.expertGovernance = governance;
  writeState(state);
  if (governance.fixedExpertSet.length > 0 || governance.activeExperts.length > 0) {
    writeExpertGovernanceMarker(governance);
  } else {
    clearExpertGovernanceMarker();
  }
  return governance;
}

function setExpertPolicy({ maxActiveExperts, fixedExpertSet, orchestrator = null } = {}) {
  const experts = normalizeExpertList(fixedExpertSet);
  const max = Number.parseInt(maxActiveExperts, 10);
  if (!Number.isFinite(max) || max < 1) {
    throw new Error('maxActiveExperts must be a positive integer');
  }
  if (experts.length === 0) {
    throw new Error('fixedExpertSet must contain at least one expert');
  }

  const current = readExpertGovernance();
  const retainedActiveExperts = current.activeExperts.filter((expert) => experts.includes(expert)).slice(0, max);
  return persistExpertGovernance({
    orchestrator: orchestrator || current.orchestrator || null,
    maxActiveExperts: max,
    fixedExpertSet: experts,
    activeExperts: retainedActiveExperts,
    claimedAt: retainedActiveExperts.length > 0 ? current.claimedAt || nowIso() : null,
  });
}

function claimExperts(requestedExperts, options = {}) {
  const governance = readExpertGovernance();
  const requested = normalizeExpertList(requestedExperts);
  if (!Number.isFinite(governance.maxActiveExperts)) {
    throw new Error('expert policy not configured');
  }
  if (governance.fixedExpertSet.length === 0) {
    throw new Error('fixedExpertSet is empty');
  }
  if (requested.length === 0) {
    throw new Error('at least one expert must be requested');
  }
  const unknown = requested.filter((expert) => !governance.fixedExpertSet.includes(expert));
  if (unknown.length > 0) {
    throw new Error(`requested experts not in fixedExpertSet: ${unknown.join(', ')}`);
  }
  if (requested.length > governance.maxActiveExperts) {
    throw new Error(`requested ${requested.length} experts exceeds maxActiveExperts=${governance.maxActiveExperts}`);
  }

  return persistExpertGovernance({
    ...governance,
    orchestrator: options.orchestrator || governance.orchestrator || null,
    activeExperts: requested,
    claimedAt: nowIso(),
  });
}

function clearExperts() {
  const governance = readExpertGovernance();
  return persistExpertGovernance({
    ...governance,
    activeExperts: [],
    claimedAt: null,
  });
}

// ── Commands ────────────────────────────────────────────────

function cmdSet(level) {
  const n = parseInt(level, 10);
  if (Number.isNaN(n) || n < 0) {
    console.error('ERROR: depth must be a non-negative integer');
    process.exit(1);
  }
  setDepth(n);
  if (n > 0) {
    writeMarker(n);
  } else {
    removeMarker();
  }
  console.log(`dispatch depth set to ${n}`);
}

function cmdGet() {
  const depth = getCurrentDepth();
  console.log(depth);
  process.exit(depth); // exit code = depth (0, 1, 2, etc.)
}

function cmdEnter() {
  const current = getCurrentDepth();
  const next = current + 1;
  setDepth(next);
  writeMarker(next);
  console.log(`dispatch depth: ${current} → ${next}`);
}

function cmdExit() {
  const current = getCurrentDepth();
  const next = Math.max(0, current - 1);
  setDepth(next);
  if (next === 0) {
    removeMarker();
  } else {
    writeMarker(next);
  }
  console.log(`dispatch depth: ${current} → ${next}`);
}

function cmdReset() {
  setDepth(0);
  removeMarker();
  console.log('dispatch depth reset to 0');
}

function cmdTeamActive() {
  const state = readState();
  if (!state.pipeline) state.pipeline = {};
  state.pipeline.teamActive = true;
  writeState(state);
  console.log('agent team marked active — write guard bypassed');
}

function cmdTeamInactive() {
  const state = readState();
  if (!state.pipeline) state.pipeline = {};
  state.pipeline.teamActive = false;
  writeState(state);
  console.log('agent team marked inactive — write guard re-enabled');
}

function cmdSetExpertPolicy(args = []) {
  const maxIndex = args.indexOf('--max-active');
  const expertsIndex = args.indexOf('--experts');
  const orchestratorIndex = args.indexOf('--orchestrator');
  const maxActiveExperts = maxIndex >= 0 ? args[maxIndex + 1] : null;
  const fixedExpertSet = expertsIndex >= 0 ? args[expertsIndex + 1] : null;
  const orchestrator = orchestratorIndex >= 0 ? args[orchestratorIndex + 1] : null;
  const governance = setExpertPolicy({ maxActiveExperts, fixedExpertSet, orchestrator });
  console.log(`expert policy set (max=${governance.maxActiveExperts}, experts=${governance.fixedExpertSet.join(',')})`);
}

function cmdClaimExperts(expertsArg, args = []) {
  const orchestratorIndex = args.indexOf('--orchestrator');
  const orchestrator = orchestratorIndex >= 0 ? args[orchestratorIndex + 1] : null;
  const governance = claimExperts(expertsArg, { orchestrator });
  console.log(`active experts set to ${governance.activeExperts.join(',')}`);
}

function cmdClearExperts() {
  clearExperts();
  console.log('active experts cleared');
}

function cmdShowExpertPolicy() {
  console.log(JSON.stringify(readExpertGovernance(), null, 2));
}

function cmdWriteToken() {
  try {
    const ttlPolicy = resolveConfiguredTokenTtlMs(process.cwd());
    const token = {
      created: Date.now(),
      ttl: ttlPolicy.ttlMs,
      ttlSource: ttlPolicy.source,
      phase: 'dispatch',
      pid: process.pid,
      workspaceHash: computeWorkspaceHash(),
    };
    atomicWrite(DISPATCH_TOKEN_FILE, `${JSON.stringify(token)}\n`, { mode: 0o600 });
    console.log(`dispatch token written (TTL: ${ttlPolicy.ttlMs}ms, source: ${ttlPolicy.source})`);
  } catch (err) {
    console.error(`ERROR writing dispatch token: ${err.message}`);
    process.exit(1);
  }
}

function cmdDoctorClock() {
  const ttlPolicy = resolveConfiguredTokenTtlMs(process.cwd());
  console.log(
    JSON.stringify(
      {
        schema: 'cobolt-dispatch-token-policy@1',
        tokenTtlMs: ttlPolicy.ttlMs,
        source: ttlPolicy.source,
        minMs: ttlPolicy.minMs,
        maxMs: ttlPolicy.maxMs,
        clockSkewAudit: '_cobolt-output/audit/dispatch-clock-skew.jsonl',
      },
      null,
      2,
    ),
  );
}

function cmdClearToken() {
  try {
    if (fs.existsSync(DISPATCH_TOKEN_FILE)) fs.unlinkSync(DISPATCH_TOKEN_FILE);
    console.log('dispatch token cleared');
  } catch {
    /* best effort */
  }
}

// ── Programmatic API ────────────────────────────────────────

module.exports = {
  getCurrentDepth,
  setDepth,
  writeMarker,
  removeMarker,
  computeWorkspaceHash,
  readExpertGovernance,
  setExpertPolicy,
  claimExperts,
  clearExperts,
  cmdTeamActive,
  cmdTeamInactive,
  cmdSetExpertPolicy,
  cmdClaimExperts,
  cmdClearExperts,
  cmdShowExpertPolicy,
  cmdWriteToken,
  cmdClearToken,
  cmdDoctorClock,
  STATE_FILE,
  MARKER_FILE,
  DISPATCH_TOKEN_FILE,
  EXPERT_GOVERNANCE_FILE,
  DISPATCH_TOKEN_TTL_MS,
};

// ── CLI ─────────────────────────────────────────────────────

if (require.main === module) {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case 'set':
      cmdSet(args[0]);
      break;
    case 'get':
      cmdGet();
      break;
    case 'enter':
      cmdEnter();
      break;
    case 'exit':
      cmdExit();
      break;
    case 'reset':
      cmdReset();
      break;
    case 'team-active':
      cmdTeamActive();
      break;
    case 'team-inactive':
      cmdTeamInactive();
      break;
    case 'set-expert-policy':
      cmdSetExpertPolicy(args);
      break;
    case 'claim-experts':
      cmdClaimExperts(args[0], args.slice(1));
      break;
    case 'clear-experts':
      cmdClearExperts();
      break;
    case 'show-expert-policy':
      cmdShowExpertPolicy();
      break;
    case 'write-token':
      cmdWriteToken();
      break;
    case 'doctor-clock':
      cmdDoctorClock();
      break;
    case 'clear-token':
      cmdClearToken();
      break;
    default:
      console.log('Usage: cobolt-dispatch-depth.js <set N|get|enter|exit|reset>');
      console.log('');
      console.log('  set <N>       Set dispatch depth to N');
      console.log('  get           Print current depth (exit code = depth)');
      console.log('  enter         Increment depth (before agent dispatch)');
      console.log('  exit          Decrement depth (after agent completion)');
      console.log('  reset         Force reset to 0');
      console.log('  team-active   Mark agent team as active (bypass write guard)');
      console.log('  team-inactive Mark agent team as inactive (re-enable write guard)');
      console.log('  set-expert-policy --max-active N --experts a,b,c [--orchestrator name]');
      console.log('                 Configure the fixed expert set and active expert cap');
      console.log('  claim-experts a,b [--orchestrator name]');
      console.log('                 Claim a bounded subset of the fixed experts');
      console.log('  clear-experts Clear active experts while preserving the policy');
      console.log('  show-expert-policy');
      console.log('                 Print the current expert governance state');
      console.log('  write-token   Write dispatch token (5s TTL, allows orchestrator dispatch)');
      console.log('  clear-token   Clear dispatch token');
      process.exit(cmd ? 1 : 0);
  }
}
