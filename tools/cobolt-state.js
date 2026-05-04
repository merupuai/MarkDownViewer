#!/usr/bin/env node

// CoBolt State Manager — CLI for cobolt-state.json
//
// Usage:
//   node tools/cobolt-state.js get <path>           # Read a nested value (dot notation)
//   node tools/cobolt-state.js set <path> <value>    # Write a nested value
//   node tools/cobolt-state.js show                  # Pretty-print full state
//   node tools/cobolt-state.js stage                 # Show current pipeline stage
//   node tools/cobolt-state.js stage <name>          # Set pipeline stage
//   node tools/cobolt-state.js milestone             # Show current milestone
//   node tools/cobolt-state.js milestone <name>      # Set current milestone
//   node tools/cobolt-state.js reset                 # Reset to template defaults
//   node tools/cobolt-state.js repair                # Back up corrupt state and recreate it
//   node tools/cobolt-state.js validate              # Validate against schema

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { atomicWriteJSON } = require('../lib/cobolt-atomic-write');
const enterprise = require('../lib/cobolt-enterprise');
// Boot-time WAL recovery — replays any orphan writeAtomic transactions left
// behind by a crashed process before this tool mutates state. Idempotent.
try {
  require('../lib/cobolt-state-boot').bootRecovery();
} catch {
  /* boot recovery is advisory; a broken boot must not block the state CLI */
}

const STATE_FILE = 'cobolt-state.json';
const TEMPLATE_FILE = path.join(__dirname, '..', 'source', 'templates', 'cobolt-state.json');
const SCHEMA_FILE = path.join(__dirname, '..', 'source', 'schemas', 'cobolt-state.schema.json');

class StateFileError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'StateFileError';
    this.code = details.code || 'COBOLT_STATE_ERROR';
    Object.assign(this, details);
  }
}

function findStateFile() {
  const candidate = path.join(process.cwd(), STATE_FILE);
  return fs.existsSync(candidate) ? candidate : null;
}

function stateFilePath() {
  return findStateFile() || path.join(process.cwd(), STATE_FILE);
}

function detectGitRemote(projectRoot) {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

function buildResetState(existingState) {
  const template = JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8'));
  const projectRoot = process.cwd();
  const projectId = existingState?.projectId || path.basename(projectRoot) || 'cobolt-project';

  return {
    ...template,
    ...existingState,
    projectId,
    projectType: existingState?.projectType || template.projectType || '',
    currentStage: existingState?.currentStage || 'initialized',
    version: require('../package.json').version,
    resolvedRoot: existingState?.resolvedRoot || fs.realpathSync(projectRoot),
    gitRemote: existingState?.gitRemote || detectGitRemote(projectRoot) || undefined,
    lastUpdated: new Date().toISOString(),
  };
}

function buildCorruptBackupPath(stateFile) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${stateFile}.corrupt.${stamp}`;
}

function writeStateToFile(stateFile, state) {
  state.lastUpdated = new Date().toISOString();
  try {
    if (fs.existsSync(stateFile)) enterprise.backupState(path.dirname(stateFile));
  } catch {
    /* backup is best-effort; atomic write remains authoritative */
  }
  // Atomic write: write to temp file then rename (prevents corruption on crash)
  atomicWriteJSON(stateFile, state, { mode: 0o600 });
}

function repairState() {
  const stateFile = stateFilePath();
  if (!fs.existsSync(stateFile)) {
    throw new StateFileError(
      `State file not found: ${stateFile}. Run "node tools/cobolt-state.js reset" to create from template.`,
      {
        code: 'COBOLT_STATE_MISSING',
        stateFile,
      },
    );
  }

  const backupFile = buildCorruptBackupPath(stateFile);
  fs.copyFileSync(stateFile, backupFile);

  const repairedState = buildResetState();
  writeStateToFile(stateFile, repairedState);

  return {
    state: repairedState,
    stateFile,
    backupFile,
  };
}

function readState(options = {}) {
  const stateFile = stateFilePath();
  if (!fs.existsSync(stateFile)) {
    throw new StateFileError(
      `State file not found: ${stateFile}. Run "node tools/cobolt-state.js reset" to create from template.`,
      {
        code: 'COBOLT_STATE_MISSING',
        stateFile,
      },
    );
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (err) {
    if (options.onCorrupt === 'repair') {
      return repairState().state;
    }

    throw new StateFileError(
      `State file is corrupted and could not be parsed: ${stateFile}. Run "node tools/cobolt-state.js repair" to back it up and recreate it.`,
      {
        code: 'COBOLT_STATE_INVALID_JSON',
        stateFile,
        cause: err,
      },
    );
  }
}

function writeState(state) {
  writeStateToFile(stateFilePath(), state);
}

function getNestedValue(obj, keyPath) {
  const keys = keyPath.split('.');
  let current = obj;
  for (const key of keys) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

function setNestedValue(obj, keyPath, value) {
  const keys = keyPath.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (current[keys[i]] == null || typeof current[keys[i]] !== 'object') {
      current[keys[i]] = {};
    }
    current = current[keys[i]];
  }
  // Auto-parse JSON values
  try {
    current[keys[keys.length - 1]] = JSON.parse(value);
  } catch {
    current[keys[keys.length - 1]] = value;
  }
}

function deleteNestedValue(obj, keyPath) {
  const keys = keyPath.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (current[keys[i]] == null || typeof current[keys[i]] !== 'object') {
      return false; // path doesn't exist
    }
    current = current[keys[i]];
  }
  const leaf = keys[keys.length - 1];
  if (!(leaf in current)) return false;
  delete current[leaf];
  return true;
}

// ── Autonomous Flag Guard (v0.23.3) ────────────────────────
//
// Mirrors the PreToolUse hook at source/hooks/cobolt-autonomous-flag-guard.js
// for defense in depth. Refuses raw `set` / `batch-set` / `delete` against
// the canonical autonomous-mode keys when the current state isAutonomous
// and the build is mid-flight. Operators legitimately need to flip those
// flags via the canonical `set-autonomous` / `ensure-autonomous` /
// `normalize-autonomous` subcommands — those run through
// applyAutonomousFlags() and are not blocked here.
//
// Bypass: COBOLT_AUTONOMOUS_FLAG_GUARD=bypass (logged). Master kill-switch:
// COBOLT_V12_GATES=bypass.
const AUTONOMOUS_PROTECTED_KEYS = new Set([
  'build.autonomous',
  'pipeline.autonomous',
  'pipeline.mode',
  'build.milestoneLoop.autoMode',
  'flags.autonomous',
  'planning.autonomous',
  'planning.auto',
  'autonomousMode',
]);

const AUTONOMOUS_TERMINAL_BUILD_STEPS = new Set(['completed', '08-milestone-complete']);
const AUTONOMOUS_TERMINAL_STAGES = new Set(['completed', 'failed', 'paused']);

function autonomousGuardBypassActive() {
  const v12 = String(process.env.COBOLT_V12_GATES || '').toLowerCase();
  if (v12 === 'bypass' || v12 === 'off') return true;
  const local = String(process.env.COBOLT_AUTONOMOUS_FLAG_GUARD || '').toLowerCase();
  return local === 'bypass' || local === '0' || local === 'off';
}

function autonomousGuardIsAutonomous(state) {
  try {
    const { isAutonomous } = require(path.join(__dirname, '..', 'lib', 'cobolt-autonomous.js'));
    return isAutonomous(state);
  } catch {
    if (!state || typeof state !== 'object') return false;
    if (state.build?.autonomous === true) return true;
    if (state.pipeline?.autonomous === true) return true;
    if (state.pipeline?.mode === 'autonomous') return true;
    if (state.build?.milestoneLoop?.autoMode === true) return true;
    if (state.flags?.autonomous === true) return true;
    if (state.autonomousMode === true) return true;
    if (state.planning?.auto === true || state.planning?.auto === 1) return true;
    if (state.planning?.autonomous === true || state.planning?.autonomous === 1) return true;
    return false;
  }
}

function autonomousGuardBuildTerminal(state) {
  if (!state) return true;
  const step = String(state.build?.currentStep || '').trim();
  if (AUTONOMOUS_TERMINAL_BUILD_STEPS.has(step)) return true;
  const stage = String(state.pipeline?.currentStage || state.currentStage || '')
    .trim()
    .toLowerCase();
  if (!stage && !step) return true;
  if (AUTONOMOUS_TERMINAL_STAGES.has(stage)) return true;
  return false;
}

function autonomousGuardLog(entry) {
  try {
    const dir = path.join(process.cwd(), '_cobolt-output', 'audit');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      path.join(dir, 'autonomous-flag-guard.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), source: 'cobolt-state.js', ...entry })}\n`,
      { mode: 0o600 },
    );
  } catch {
    /* best-effort */
  }
}

// Throws StateFileError with a remediation message when the requested
// mutation would disable autonomous mode mid-build. Allowed when:
//   * bypass env is set,
//   * the key is not in PROTECTED_KEYS,
//   * current state is not autonomous,
//   * build is terminal,
//   * mutating pipeline.mode to the string "autonomous" (the canonical path),
//   * mutating any protected key TO "true" / "1" (enabling is always safe).
function enforceAutonomousFlagGuard(op, key, value) {
  if (autonomousGuardBypassActive()) {
    autonomousGuardLog({ event: 'gate-bypass', op, key, value });
    return;
  }
  if (!AUTONOMOUS_PROTECTED_KEYS.has(key)) return;
  const valStr = value === undefined ? '' : String(value).trim();
  const lowered = valStr.toLowerCase();
  // Always allow enabling mutations.
  if (op !== 'delete') {
    if (key === 'pipeline.mode' && lowered === 'autonomous') return;
    if (key !== 'pipeline.mode' && (lowered === 'true' || lowered === '1')) return;
  }
  let state;
  try {
    state = readState();
  } catch {
    state = null;
  }
  if (!autonomousGuardIsAutonomous(state)) return;
  if (autonomousGuardBuildTerminal(state)) return;

  autonomousGuardLog({
    event: 'flag_mutation_blocked',
    op,
    key,
    value: valStr,
    buildStep: state?.build?.currentStep || null,
    stage: state?.pipeline?.currentStage || state?.currentStage || null,
  });

  throw new StateFileError(
    `Refusing to ${op} ${key}${value !== undefined ? ` = ${valStr}` : ''} — autonomous mode is active and the build is mid-flight.\n` +
      `  Build step: ${state?.build?.currentStep || 'unknown'}\n` +
      `  Pipeline stage: ${state?.pipeline?.currentStage || state?.currentStage || 'unknown'}\n\n` +
      'Flipping these keys silences every autonomous safety hook.\n' +
      'Use the canonical bootstrap to exit autonomous mode atomically:\n' +
      '  node tools/cobolt-state.js set-autonomous false\n' +
      'Bypass (emergency, logged): COBOLT_AUTONOMOUS_FLAG_GUARD=bypass',
    { code: 'COBOLT_AUTONOMOUS_FLAG_GUARD' },
  );
}

function validate(state) {
  if (!fs.existsSync(SCHEMA_FILE)) {
    console.log('  Schema file not found — skipping validation');
    return true;
  }
  const schema = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  const errors = [];
  const actualType = (value) => {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  };
  const matchesType = (value, expectedType) => {
    const type = actualType(value);
    if (expectedType === 'integer') return Number.isInteger(value);
    if (expectedType === 'number') return type === 'number';
    return type === expectedType;
  };

  function validateNode(value, nodeSchema, nodePath) {
    if (!nodeSchema || typeof nodeSchema !== 'object') return;

    const label = nodePath || 'state';
    const allowedTypes = Array.isArray(nodeSchema.type) ? nodeSchema.type : nodeSchema.type ? [nodeSchema.type] : [];

    if (allowedTypes.length > 0 && !allowedTypes.some((type) => matchesType(value, type))) {
      errors.push(`${label}: expected ${allowedTypes.join('|')}, got ${actualType(value)}`);
      return;
    }

    if (value === null || value === undefined) return;

    if (typeof value === 'string') {
      if (typeof nodeSchema.minLength === 'number' && value.length < nodeSchema.minLength) {
        errors.push(`${label}: must be at least ${nodeSchema.minLength} characters`);
      }
      if (nodeSchema.pattern && !new RegExp(nodeSchema.pattern).test(value)) {
        errors.push(`${label}: does not match required pattern`);
      }
      if (nodeSchema.format === 'date-time' && Number.isNaN(Date.parse(value))) {
        errors.push(`${label}: must be a valid ISO-8601 date-time`);
      }
    }

    if (typeof value === 'number') {
      if (typeof nodeSchema.minimum === 'number' && value < nodeSchema.minimum) {
        errors.push(`${label}: must be >= ${nodeSchema.minimum}`);
      }
      if (typeof nodeSchema.maximum === 'number' && value > nodeSchema.maximum) {
        errors.push(`${label}: must be <= ${nodeSchema.maximum}`);
      }
    }

    if (Array.isArray(nodeSchema.enum) && !nodeSchema.enum.includes(value)) {
      errors.push(`${label}: must be one of ${nodeSchema.enum.join(', ')}`);
    }

    if (actualType(value) === 'object') {
      for (const field of nodeSchema.required || []) {
        if (!(field in value)) errors.push(`${label}: missing required field '${field}'`);
      }
      for (const [childKey, childSchema] of Object.entries(nodeSchema.properties || {})) {
        if (childKey in value) {
          validateNode(value[childKey], childSchema, nodePath ? `${nodePath}.${childKey}` : childKey);
        }
      }
    }

    if (Array.isArray(value) && nodeSchema.items) {
      value.forEach((item, index) => {
        validateNode(item, nodeSchema.items, `${label}[${index}]`);
      });
    }
  }

  validateNode(state, schema, '');

  if (errors.length > 0) {
    console.log('  Validation errors:');
    for (const err of errors) console.log(`    - ${err}`);
    return false;
  }

  console.log('  State is valid');
  return true;
}

// ── Programmatic API ─────────────────────────────────────────

module.exports = {
  findStateFile,
  stateFilePath,
  buildResetState,
  StateFileError,
  readState,
  repairState,
  writeState,
  getNestedValue,
  setNestedValue,
  validate,
  enforceAutonomousFlagGuard,
  AUTONOMOUS_PROTECTED_KEYS,
};

// ── CLI ──────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log('  Usage: node tools/cobolt-state.js <command> [args]');
    console.log(
      '  Commands: get, set, show, stage, milestone, status-hint, reset, repair, backup, backups, restore, verify, validate',
    );
    process.exit(0);
  }

  try {
    switch (cmd) {
      case 'show': {
        const state = readState();
        console.log(JSON.stringify(state, null, 2));
        break;
      }
      case 'get': {
        if (!args[1]) {
          console.error('  Usage: cobolt-state get <path>');
          process.exit(1);
        }
        const state = readState();
        const value = getNestedValue(state, args[1]);
        if (value === undefined) {
          console.error(`  Key not found: ${args[1]}`);
          process.exit(1);
        }
        console.log(typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value));
        break;
      }
      case 'set': {
        if (!args[1] || args[2] === undefined) {
          console.error('  Usage: cobolt-state set <path> <value>');
          process.exit(1);
        }
        enforceAutonomousFlagGuard('set', args[1], args[2]);
        const state = readState();
        setNestedValue(state, args[1], args[2]);
        writeState(state);
        console.log(`  Set ${args[1]} = ${args[2]}`);
        break;
      }
      case 'batch-set': {
        // Usage: cobolt-state batch-set key1 val1 key2 val2 ...
        // Single read-modify-write cycle for multiple key-value pairs.
        // Identical to calling 'set' N times but with 1 file write instead of N.
        const pairs = args.slice(1);
        if (pairs.length < 2 || pairs.length % 2 !== 0) {
          console.error('  Usage: cobolt-state batch-set <key1> <val1> [<key2> <val2> ...]');
          process.exit(1);
        }
        for (let i = 0; i < pairs.length; i += 2) {
          enforceAutonomousFlagGuard('batch-set', pairs[i], pairs[i + 1]);
        }
        const batchState = readState();
        const applied = [];
        for (let i = 0; i < pairs.length; i += 2) {
          setNestedValue(batchState, pairs[i], pairs[i + 1]);
          applied.push(`${pairs[i]} = ${pairs[i + 1]}`);
        }
        writeState(batchState);
        console.log(`  Batch-set ${applied.length} keys: ${applied.join(', ')}`);
        break;
      }
      case 'stage': {
        const state = readState();
        if (args[1]) {
          if (!state.pipeline) state.pipeline = {};
          state.pipeline.currentStage = args[1];
          delete state.pipeline.stage;
          state.pipeline.lastUpdated = new Date().toISOString();
          writeState(state);
          console.log(`  Stage set to: ${args[1]}`);
        } else {
          const stage =
            getNestedValue(state, 'pipeline.currentStage') || getNestedValue(state, 'pipeline.stage') || 'unknown';
          console.log(stage);
        }
        break;
      }
      case 'milestone': {
        const state = readState();
        if (args[1]) {
          if (!state.pipeline) state.pipeline = {};
          state.pipeline.currentMilestone = args[1];
          state.pipeline.lastUpdated = new Date().toISOString();
          writeState(state);
          console.log(`  Milestone set to: ${args[1]}`);
        } else {
          const ms = getNestedValue(state, 'pipeline.currentMilestone') || 'none';
          console.log(ms);
        }
        break;
      }
      case 'status-hint': {
        const state = readState();
        if (args[1]) {
          state.statusHint = args.slice(1).join(' ').substring(0, 60);
          writeState(state);
          console.log(`  Status hint set: ${state.statusHint}`);
        } else {
          console.log(state.statusHint || '');
        }
        break;
      }
      case 'reset': {
        if (!fs.existsSync(TEMPLATE_FILE)) {
          console.error(`  Template not found: ${TEMPLATE_FILE}`);
          process.exit(1);
        }
        let existing = null;
        try {
          existing = findStateFile() ? readState() : null;
        } catch {
          existing = null;
        }
        const stateFile = stateFilePath();
        const resetState = buildResetState(existing);
        writeStateToFile(stateFile, resetState);
        console.log(`  State reset from template: ${stateFile}`);
        break;
      }
      case 'init-if-missing': {
        // v0.40.8 — idempotent state bootstrap.
        // Used by pipeline skills (cobolt-plan) to guarantee cobolt-state.json
        // exists before any `set` / `ensure-autonomous` / `set-autonomous`
        // call. If cobolt-init was run first (the canonical path), the file
        // exists and this is a no-op. If the user skipped init (the case
        // that used to silently exit 1 on the first `set`), this creates
        // the template and logs the auto-heal. Always exits 0.
        const stateFile = stateFilePath();
        if (fs.existsSync(stateFile)) {
          console.log(`  init-if-missing: cobolt-state.json already present — no-op`);
          break;
        }
        if (!fs.existsSync(TEMPLATE_FILE)) {
          console.error(`  Template not found: ${TEMPLATE_FILE}`);
          process.exit(1);
        }
        const bootstrapState = buildResetState(null);
        writeStateToFile(stateFile, bootstrapState);
        console.log(`  init-if-missing: cobolt-state.json initialized from template: ${stateFile}`);
        break;
      }
      case 'repair': {
        const { stateFile, backupFile } = repairState();
        console.log(`  Corrupted state backed up to: ${backupFile}`);
        console.log(`  State repaired from template: ${stateFile}`);
        break;
      }
      case 'backup': {
        const backup = enterprise.backupState(process.cwd());
        if (!backup) {
          console.error('  No cobolt-state.json found to back up');
          process.exit(1);
        }
        console.log(`  State backup written: ${backup}`);
        break;
      }
      case 'backups': {
        const backups = enterprise.listStateBackups(process.cwd());
        if (backups.length === 0) {
          console.log('  No state backups found.');
          break;
        }
        for (const backup of backups) console.log(`  ${backup.name} (${backup.size} bytes)`);
        break;
      }
      case 'restore': {
        const fromIdx = args.indexOf('--from');
        const from = fromIdx >= 0 ? args[fromIdx + 1] : args[1] || 'latest';
        const result = enterprise.restoreStateBackup(process.cwd(), { from });
        console.log(`  State restored from: ${result.restoredFrom}`);
        if (result.beforeRestore) console.log(`  Pre-restore backup: ${result.beforeRestore}`);
        break;
      }
      case 'verify': {
        const result = enterprise.verifyStateFile(process.cwd());
        console.log(JSON.stringify({ schema: 'cobolt-state-verify@1', ...result }, null, 2));
        process.exit(result.ok ? 0 : 1);
        break;
      }
      case 'delete': {
        const delKey = args[1];
        if (!delKey) {
          console.error('  Usage: cobolt-state.js delete <key.path>');
          process.exit(1);
        }
        enforceAutonomousFlagGuard('delete', delKey);
        const state = readState();
        const deleted = deleteNestedValue(state, delKey);
        if (deleted) {
          writeState(state);
          console.log(`  Deleted: ${delKey}`);
        } else {
          console.log(`  Key not found: ${delKey} (no-op)`);
        }
        break;
      }
      case 'set-autonomous': {
        // Usage: cobolt-state set-autonomous <true|false>
        // Atomically sets ALL canonical autonomous-mode flags. Hooks read
        // these via lib/cobolt-autonomous.js isAutonomous(state).
        const { applyAutonomousFlags } = require(
          require('node:path').join(__dirname, '..', 'lib', 'cobolt-autonomous.js'),
        );
        const val = args[1];
        if (val !== 'true' && val !== 'false') {
          console.error('  Usage: cobolt-state set-autonomous <true|false>');
          process.exit(1);
        }
        const s = readState();
        applyAutonomousFlags(s, val === 'true');
        writeState(s);
        console.log(
          `  set-autonomous: ${val} (build.autonomous, pipeline.autonomous, pipeline.mode, build.milestoneLoop.autoMode, flags.autonomous, planning.autonomous)`,
        );
        break;
      }
      case 'ensure-autonomous': {
        // Usage: cobolt-state ensure-autonomous <raw args...>
        //
        // v0.17.2 — stage-agnostic canonical bootstrap. Every pipeline
        // skill can call this ONCE at entry with its raw $ARGUMENTS.
        // If the args contain any of --auto / --autonomous, ALL canonical
        // autonomous flags are written atomically via applyAutonomousFlags.
        // Idempotent: if already autonomous, no state change is written.
        //
        // Why this matters: /cobolt-fix --autonomous, /cobolt-review
        // --autonomous, /cobolt-audit --autonomous etc. were previously
        // parsing --autonomous into a local MODE variable but never
        // setting canonical state flags. isAutonomous(state) returned
        // false, so every autonomous-mode safety hook (anti-self-halt,
        // chain-enforcer fallback, autonomous-guard) was silently inert
        // for standalone invocations. Same failure class as the
        // planning.auto flag orphaning fixed in v0.17.2.
        const { applyAutonomousFlags, isAutonomous } = require(
          require('node:path').join(__dirname, '..', 'lib', 'cobolt-autonomous.js'),
        );
        const raw = args.slice(1);
        // Token-split to avoid matching --auto-merge, --auto-triage, etc.
        const wantsAutonomous = raw.some((tok) => tok === '--auto' || tok === '--autonomous');
        if (!wantsAutonomous) {
          // Tokens may be a single space-joined string (depending on how
          // the caller passed $ARGUMENTS). Split and re-check.
          const joined = raw.join(' ').split(/\s+/).filter(Boolean);
          const alt = joined.some((tok) => tok === '--auto' || tok === '--autonomous');
          if (!alt) {
            console.log('  ensure-autonomous: no --auto/--autonomous token — no-op');
            break;
          }
        }
        const s = readState();
        if (isAutonomous(s)) {
          console.log('  ensure-autonomous: canonical flags already set — no-op');
          break;
        }
        applyAutonomousFlags(s, true);
        writeState(s);
        console.log('  ensure-autonomous: canonical flags written (all stages see isAutonomous=true)');
        break;
      }
      case 'normalize-autonomous': {
        // Usage: cobolt-state normalize-autonomous
        //
        // Self-heal: if ANY canonical autonomous flag is true, set ALL
        // canonical flags true. Used by session-recovery to repair state
        // drift across partial writes.
        const { normalizeAutonomousFlags } = require(
          require('node:path').join(__dirname, '..', 'lib', 'cobolt-autonomous.js'),
        );
        const s = readState();
        const changed = normalizeAutonomousFlags(s);
        if (changed) {
          writeState(s);
          console.log('  normalize-autonomous: canonical flag drift detected and repaired');
        } else {
          console.log('  normalize-autonomous: canonical flags consistent — no-op');
        }
        break;
      }
      case 'validate': {
        const state = readState();
        const ok = validate(state);
        process.exit(ok ? 0 : 1);
        break;
      }
      default:
        console.error(`  Unknown command: ${cmd}`);
        process.exit(1);
    }
  } catch (err) {
    if (err instanceof StateFileError) {
      console.error(`  ${err.message}`);
      process.exit(1);
    }

    throw err;
  }
}
