#!/usr/bin/env node

// CoBolt Step Proof — execution verification for pipeline build steps
//
// Usage:
//   node tools/cobolt-step-proof.js record <milestone> <step> [--tests-planned N] ...
//   node tools/cobolt-step-proof.js check <milestone> <step>
//   node tools/cobolt-step-proof.js list <milestone>
//   node tools/cobolt-step-proof.js verify <milestone>
//   node tools/cobolt-step-proof.js validate-gate <milestone> <step>

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWriteJSON } = require('../lib/cobolt-atomic-write');
const { paths: _paths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();

// ── Constants ─────────────────────────────────────────────────

const HARD_GATE_STEPS = new Set([
  '01b-spec-validation',
  '02-tdd-red',
  '03-tdd-green',
  '03a-code-gap-analysis',
  '03b-integration-smoke',
  '04-tdd-refactor',
  '04a-deep-verification',
  '04b-build-issue-registry',
  '05-review',
  '06-fix',
  '06b-contract-replay',
  '06c-schema-replay',
  '06d-nfr-enforce',
  '07-validate',
  '08b-cross-milestone-smoke',
  '08-milestone-complete',
]);

/**
 * Hard-gate validation rules per step.
 * Each rule is a function(proof) → {valid, error}.
 */
const HARD_GATE_RULES = {
  '02-tdd-red': (proof) => {
    if (!proof.tests || proof.tests.planned <= 0) {
      return { valid: false, error: '02-tdd-red requires tests.planned > 0 (write failing tests first)' };
    }
    return { valid: true, error: null };
  },
  '03-tdd-green': (proof) => {
    if (!proof.tests) {
      return { valid: false, error: '03-tdd-green requires test evidence' };
    }
    if (proof.tests.executed !== proof.tests.planned) {
      return {
        valid: false,
        error: `03-tdd-green requires tests.executed (${proof.tests.executed}) == tests.planned (${proof.tests.planned})`,
      };
    }
    if (proof.tests.failed !== 0) {
      return { valid: false, error: `03-tdd-green requires tests.failed == 0, got ${proof.tests.failed}` };
    }
    return { valid: true, error: null };
  },
  '04-tdd-refactor': (proof) => {
    const cmds = proof.commands_executed || [];
    const hasTestCmd = cmds.some(
      (c) => c.exit_code === 0 && typeof c.command === 'string' && c.command.toLowerCase().includes('test'),
    );
    if (!hasTestCmd) {
      return {
        valid: false,
        error:
          '04-tdd-refactor requires at least one commands_executed entry with exit_code 0 and "test" in the command',
      };
    }
    return { valid: true, error: null };
  },
  '06-fix': (proof) => {
    const cmds = proof.commands_executed || [];
    const arts = proof.artifacts || [];
    if (cmds.length === 0 && arts.length === 0) {
      return { valid: false, error: '06-fix requires at least one command or checkpoint artifact as evidence' };
    }
    if (Object.hasOwn(proof, 'status') && proof.status !== 'passed') {
      return { valid: false, error: `06-fix proof status must be passed, got ${proof.status || 'missing'}` };
    }
    return { valid: true, error: null };
  },
  '07-validate': (proof) => {
    const cmds = proof.commands_executed || [];
    const arts = proof.artifacts || [];
    if (cmds.length === 0 && arts.length === 0) {
      return { valid: false, error: '07-validate requires at least one command or artifact as evidence' };
    }
    return { valid: true, error: null };
  },
};

// ── Path resolution ───────────────────────────────────────────

function defaultProofDir() {
  const p = typeof _paths === 'function' ? _paths() : null;
  if (p && typeof p.build === 'function') {
    return path.join(p.build(), 'proofs');
  }
  return path.join(process.cwd(), '_cobolt-output', 'latest', 'build', 'proofs');
}

function resolveProofDir(opts) {
  return opts?.proofDir ? opts.proofDir : defaultProofDir();
}

function proofFileName(milestone, step) {
  return `${milestone}-${step}.proof.json`;
}

function proofFilePath(milestone, step, opts) {
  return path.join(resolveProofDir(opts), proofFileName(milestone, step));
}

function _ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

// ── Hashing ───────────────────────────────────────────────────

/**
 * Compute SHA256 of the JSON representation of data.
 * @param {object} data
 * @returns {string} hex digest
 */
function hashPayload(data) {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

/**
 * Compute the canonical hash for a proof object.
 * Strips _hash before hashing so the field can be embedded.
 * @param {object} proof
 * @returns {string} hex digest
 */
function computeProofHash(proof) {
  const copy = Object.assign({}, proof);
  delete copy._hash;
  return hashPayload(copy);
}

// ── Status computation ────────────────────────────────────────

/**
 * Determine proof status based on hard-gate rules and test data.
 * @param {string} step
 * @param {object} tests  { planned, executed, passed, failed }
 * @param {object[]} commandsExecuted
 * @param {object[]} artifacts
 * @returns {'passed'|'failed'}
 */
function computeStatus(step, tests, commandsExecuted, artifacts) {
  // Hard-gate steps apply specific rules
  if (HARD_GATE_STEPS.has(step)) {
    const rule = HARD_GATE_RULES[step];
    if (rule) {
      // Build a minimal proof-like object for the rule
      const pseudoProof = { tests, commands_executed: commandsExecuted, artifacts };
      const result = rule(pseudoProof);
      return result.valid ? 'passed' : 'failed';
    }
    if (step !== '08-milestone-complete' && commandsExecuted.length === 0 && artifacts.length === 0) return 'failed';
  }
  // General rule: if tests were planned but none executed → failed
  if (tests.planned > 0 && tests.executed === 0) return 'failed';
  // Any test failures → failed
  if (tests.failed > 0) return 'failed';
  return 'passed';
}

// ── Core API ──────────────────────────────────────────────────

/**
 * Record a build step proof.
 *
 * @param {string} milestone  e.g. 'M1'
 * @param {string} step       e.g. '03-tdd-green'
 * @param {object} data
 *   @param {number}   [data.testsPlanned=0]
 *   @param {number}   [data.testsExecuted=0]
 *   @param {number}   [data.testsPassed=0]
 *   @param {Array}    [data.artifacts=[]]
 *   @param {Array}    [data.commandsExecuted=[]]
 *   @param {string[]} [data.agentsDispatched=[]]
 *   @param {string[]} [data.prerequisites=[]]
 *   @param {string}   [data.startedAt]
 *   @param {number}   [data.duration]
 * @param {object} [opts]
 *   @param {string} [opts.proofDir]  Override proof directory (for testing)
 * @returns {object} The written proof object
 */
function record(milestone, step, data, opts) {
  if (!milestone || !step) throw new Error('milestone and step are required');

  const testsPlanned = data && data.testsPlanned != null ? data.testsPlanned : 0;
  const testsExecuted = data && data.testsExecuted != null ? data.testsExecuted : 0;
  const testsPassed = data && data.testsPassed != null ? data.testsPassed : 0;
  const testsFailed = testsExecuted - testsPassed < 0 ? 0 : testsExecuted - testsPassed;
  const testsSkipped = testsPlanned - testsExecuted < 0 ? 0 : testsPlanned - testsExecuted;

  // Normalise artifacts to plain path strings for hashing consistency;
  // keep originals for storage
  const rawArtifacts = data?.artifacts ? data.artifacts : [];
  const commandsExecuted = data?.commandsExecuted ? data.commandsExecuted : [];

  const tests = {
    planned: testsPlanned,
    executed: testsExecuted,
    passed: testsPassed,
    failed: testsFailed,
    skipped: testsSkipped,
  };

  const status = computeStatus(step, tests, commandsExecuted, rawArtifacts);

  const proof = {
    milestone,
    step,
    status,
    tests,
    artifacts: rawArtifacts,
    commands_executed: commandsExecuted,
    agents_dispatched: data?.agentsDispatched ? data.agentsDispatched : [],
    prerequisites: data?.prerequisites ? data.prerequisites : [],
    startedAt: data?.startedAt ? data.startedAt : new Date().toISOString(),
    duration: data && data.duration != null ? data.duration : null,
    recordedAt: new Date().toISOString(),
  };

  proof._hash = computeProofHash(proof);

  atomicWriteJSON(proofFilePath(milestone, step, opts), proof, { mode: 0o600 });
  return proof;
}

/**
 * Record a skipped step proof.
 *
 * @param {string} milestone
 * @param {string} step
 * @param {string} reason     Human-readable skip reason
 * @param {string} gate       e.g. 'optional', 'hard', 'soft'
 * @param {object} [opts]
 * @returns {object}
 */
function recordSkip(milestone, step, reason, gate, opts) {
  if (!milestone || !step) throw new Error('milestone and step are required');

  const proof = {
    milestone,
    step,
    status: 'skipped',
    skipReason: reason || '',
    gate: gate || 'optional',
    tests: { planned: 0, executed: 0, passed: 0, failed: 0, skipped: 0 },
    artifacts: [],
    commands_executed: [],
    agents_dispatched: [],
    prerequisites: [],
    recordedAt: new Date().toISOString(),
  };

  proof._hash = computeProofHash(proof);

  atomicWriteJSON(proofFilePath(milestone, step, opts), proof, { mode: 0o600 });
  return proof;
}

/**
 * Record a not-applicable step proof.
 *
 * @param {string}   milestone
 * @param {string}   step
 * @param {string}   reason         Why this step is N/A
 * @param {string[]} unmetPrereqs   Prerequisite steps that were not met
 * @param {object}   [opts]
 * @returns {object}
 */
function recordNotApplicable(milestone, step, reason, unmetPrereqs, opts) {
  if (!milestone || !step) throw new Error('milestone and step are required');

  const proof = {
    milestone,
    step,
    status: 'not_applicable',
    skipReason: reason || '',
    unmetPrerequisites: Array.isArray(unmetPrereqs) ? unmetPrereqs : [],
    tests: { planned: 0, executed: 0, passed: 0, failed: 0, skipped: 0 },
    artifacts: [],
    commands_executed: [],
    agents_dispatched: [],
    prerequisites: [],
    recordedAt: new Date().toISOString(),
  };

  proof._hash = computeProofHash(proof);

  atomicWriteJSON(proofFilePath(milestone, step, opts), proof, { mode: 0o600 });
  return proof;
}

/**
 * Check whether a proof file exists for a given milestone + step.
 *
 * @param {string} milestone
 * @param {string} step
 * @param {object} [opts]
 * @returns {boolean}
 */
function check(milestone, step, opts) {
  return fs.existsSync(proofFilePath(milestone, step, opts));
}

/**
 * Read and parse a proof file, or return null if it does not exist.
 *
 * @param {string} milestone
 * @param {string} step
 * @param {object} [opts]
 * @returns {object|null}
 */
function readProof(milestone, step, opts) {
  const fp = proofFilePath(milestone, step, opts);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (_e) {
    return null;
  }
}

/**
 * List all proofs for a milestone, sorted alphabetically by step name.
 *
 * @param {string} milestone
 * @param {object} [opts]
 * @returns {object[]}
 */
function list(milestone, opts) {
  const dir = resolveProofDir(opts);
  if (!fs.existsSync(dir)) return [];

  const prefix = `${milestone}-`;
  const suffix = '.proof.json';

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
    .sort(); // lexicographic = step-order for numeric-prefixed names

  const proofs = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      proofs.push(parsed);
    } catch (_e) {
      /* skip unparseable file */
    }
  }
  return proofs;
}

/**
 * Re-hash all proofs for a milestone to detect tampering.
 *
 * @param {string} milestone
 * @param {object} [opts]
 * @returns {Array<{step, status, integrity, savedHash, computedHash}>}
 */
function verify(milestone, opts) {
  const proofs = list(milestone, opts);
  return proofs.map((proof) => {
    const savedHash = proof._hash;
    const computedHash = computeProofHash(proof);
    const integrity = savedHash === computedHash ? 'valid' : 'corrupted';
    return {
      step: proof.step,
      status: proof.status,
      integrity,
      savedHash,
      computedHash,
    };
  });
}

/**
 * Validate hard-gate rules for a step by reading its proof.
 *
 * @param {string} milestone
 * @param {string} step
 * @param {object} [opts]
 * @returns {{valid: boolean, error: string|null}}
 */
function validateHardGate(milestone, step, opts) {
  if (!HARD_GATE_STEPS.has(step)) {
    return { valid: true, error: null }; // non-hard-gate steps always pass
  }

  const proof = readProof(milestone, step, opts);
  if (!proof) {
    return { valid: false, error: `No proof found for ${milestone}/${step}` };
  }

  const rule = HARD_GATE_RULES[step];
  if (!rule) {
    const cmds = proof.commands_executed || [];
    const arts = proof.artifacts || [];
    if (Object.hasOwn(proof, 'status') && proof.status !== 'passed') {
      return { valid: false, error: `${step} proof status must be passed, got ${proof.status || 'missing'}` };
    }
    if (step !== '08-milestone-complete' && cmds.length === 0 && arts.length === 0) {
      return { valid: false, error: `${step} requires at least one command or artifact as evidence` };
    }
    return { valid: true, error: null };
  }

  return rule(proof);
}

// ── CLI ───────────────────────────────────────────────────────

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return flags;
}

function parseCommandsJsonArg(value) {
  try {
    return JSON.parse(value);
  } catch (jsonError) {
    const raw = String(value || '').trim();
    const powerShellStripped = raw.match(
      /^\[\s*\{\s*command\s*:\s*(.+)\s*,\s*(?:exit_code|exitCode)\s*:\s*(-?\d+)\s*\}\s*\]$/i,
    );
    if (!powerShellStripped) throw jsonError;
    return [
      {
        command: powerShellStripped[1].trim(),
        exit_code: Number(powerShellStripped[2]),
      },
    ];
  }
}

function cliRecord(args) {
  const positional = args.filter((a) => !a.startsWith('--'));
  const [milestone, step] = positional;
  if (!milestone || !step) {
    console.error('Usage: record <milestone> <step> [--tests-planned N] ...');
    process.exit(1);
  }

  const flags = parseFlags(args);
  const testsPlanned = flags['tests-planned'] ? parseInt(flags['tests-planned'], 10) : 0;
  const testsExecuted = flags['tests-executed'] ? parseInt(flags['tests-executed'], 10) : 0;
  const testsPassed = flags['tests-passed'] ? parseInt(flags['tests-passed'], 10) : 0;
  const artifacts = flags.artifacts ? flags.artifacts.split(',').map((s) => s.trim()) : [];
  let commandsExecuted = [];
  if (flags['commands-json']) {
    try {
      commandsExecuted = parseCommandsJsonArg(flags['commands-json']);
    } catch (e) {
      console.error(`[step-proof] Invalid --commands-json: ${e.message}`);
      process.exit(1);
    }
  }

  const proof = record(milestone, step, { testsPlanned, testsExecuted, testsPassed, artifacts, commandsExecuted });
  console.log(
    `[step-proof] Recorded ${milestone}/${step} → status=${proof.status} hash=${proof._hash.slice(0, 12)}...`,
  );
}

function cliCheck(args) {
  const [milestone, step] = args.filter((a) => !a.startsWith('--'));
  if (!milestone || !step) {
    console.error('Usage: check <milestone> <step>');
    process.exit(1);
  }
  const exists = check(milestone, step);
  if (exists) {
    console.log(`[step-proof] FOUND: ${milestone}/${step}`);
    process.exit(0);
  } else {
    console.log(`[step-proof] MISSING: ${milestone}/${step}`);
    process.exit(1);
  }
}

function cliList(args) {
  const [milestone] = args.filter((a) => !a.startsWith('--'));
  if (!milestone) {
    console.error('Usage: list <milestone>');
    process.exit(1);
  }
  const proofs = list(milestone);
  if (proofs.length === 0) {
    console.log(`[step-proof] No proofs found for ${milestone}`);
    return;
  }
  console.log(`[step-proof] Proofs for ${milestone} (${proofs.length}):`);
  for (const p of proofs) {
    const icon = p.status === 'passed' ? '✓' : p.status === 'skipped' ? '~' : '✗';
    console.log(`  ${icon} ${p.step}  [${p.status}]  hash=${(p._hash || '').slice(0, 12)}...`);
  }
}

function cliVerify(args) {
  const [milestone] = args.filter((a) => !a.startsWith('--'));
  if (!milestone) {
    console.error('Usage: verify <milestone>');
    process.exit(1);
  }
  const results = verify(milestone);
  if (results.length === 0) {
    console.log(`[step-proof] No proofs to verify for ${milestone}`);
    return;
  }
  let allValid = true;
  console.log(`[step-proof] Integrity check for ${milestone} (${results.length} proofs):`);
  for (const r of results) {
    const icon = r.integrity === 'valid' ? '✓' : '✗';
    console.log(`  ${icon} ${r.step}  [${r.integrity}]`);
    if (r.integrity !== 'valid') {
      allValid = false;
      console.log(`      saved:    ${r.savedHash}`);
      console.log(`      computed: ${r.computedHash}`);
    }
  }
  if (!allValid) process.exit(1);
}

function cliValidateGate(args) {
  const [milestone, step] = args.filter((a) => !a.startsWith('--'));
  if (!milestone || !step) {
    console.error('Usage: validate-gate <milestone> <step>');
    process.exit(1);
  }
  const result = validateHardGate(milestone, step);
  if (result.valid) {
    console.log(`[step-proof] Gate PASSED: ${milestone}/${step}`);
    process.exit(0);
  } else {
    console.log(`[step-proof] Gate FAILED: ${milestone}/${step} — ${result.error}`);
    process.exit(1);
  }
}

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const isHelp = cmd === '--help' || cmd === '-h' || cmd === 'help';
  switch (cmd) {
    case 'record':
      cliRecord(rest);
      break;
    case 'check':
      cliCheck(rest);
      break;
    case 'list':
      cliList(rest);
      break;
    case 'verify':
      cliVerify(rest);
      break;
    case 'validate-gate':
      cliValidateGate(rest);
      break;
    default:
      console.log('CoBolt Step Proof\n');
      console.log('Commands:');
      console.log(
        '  record <milestone> <step> [--tests-planned N] [--tests-executed N] [--tests-passed N] [--artifacts "f1,f2"] [--commands-json \'[...]\']',
      );
      console.log('  check <milestone> <step>');
      console.log('  list <milestone>');
      console.log('  verify <milestone>');
      console.log('  validate-gate <milestone> <step>');
      // --help / -h / help → exit 0. No args → exit 0 (usage printed).
      // Unknown command → exit 1 (usage error).
      process.exit(isHelp || !cmd ? 0 : 1);
  }
}

// ── Exports ───────────────────────────────────────────────────

module.exports = {
  record,
  recordSkip,
  recordNotApplicable,
  check,
  readProof,
  list,
  verify,
  validateHardGate,
  _testOnly: {
    HARD_GATE_STEPS,
    HARD_GATE_RULES,
    hashPayload,
    parseCommandsJsonArg,
  },
};
