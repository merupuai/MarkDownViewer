#!/usr/bin/env node

// CoBolt Capability Contract - deterministic per-feature behavioral contract gate.
//
// Produces, validates, and enforces the capability-contract layer introduced in
// v0.34.0. Sits between feature dossiers (FEAT layer) and TRD/architecture
// (system layer). Every FEAT-NNN must have a contract declaring operations with
// pre/post-conditions, invariants, error taxonomy, idempotency, timeouts,
// retries, degraded modes, perf budgets, observability contracts, and
// optionally state machines / domain events / config-and-flags.
//
// Subcommands:
//   scaffold   Generate stub contracts for every FEAT-NNN in feature-registry.json
//   validate   Validate each contract against the JSON Schema (structural)
//   check      Run the gate: census + semantic checks + summary index (--stage intake|final)
//   census     Quick ID-level inventory of which FEATs have contracts
//
// Exit codes (per tools/CLAUDE.md contract):
//   0  success
//   1  hard error (validation failed, gate failed, bug)
//   2  missing optional dep (e.g. ajv)
//   3  missing infra (planning dir absent)

const fs = require('node:fs');
const path = require('node:path');

const { getPlanningDir } = (() => {
  try {
    return require('../lib/cobolt-planning-artifacts');
  } catch {
    return {
      getPlanningDir: (root) => path.join(root || process.cwd(), '_cobolt-output', 'latest', 'planning'),
    };
  }
})();

const SCHEMA_VERSION = '1.0.0';
const SCHEMA_PATH = path.resolve(__dirname, '..', 'source', 'schemas', 'capability-contract.schema.json');
const INDEX_SCHEMA_PATH = path.resolve(__dirname, '..', 'source', 'schemas', 'capability-contracts-index.schema.json');

// ---------- IO helpers ----------

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readTextSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.contract.json'))
    .map((f) => path.join(dir, f));
}

// ---------- Planning context ----------

function resolvePaths(cwd) {
  const root = cwd || process.cwd();
  const planningDir = getPlanningDir(root) || path.join(root, '_cobolt-output', 'latest', 'planning');
  const contractsDir = path.join(planningDir, 'capability-contracts');
  const indexFile = path.join(planningDir, 'capability-contracts-index.json');
  const reportFile = path.join(planningDir, 'capability-contracts-report.md');
  const featureRegistryFile = path.join(planningDir, 'feature-registry.json');
  const capabilitySpecIndexFile = path.join(planningDir, 'capability-spec-index.json');
  const trdFile = path.join(planningDir, 'trd.md');
  const archFile = path.join(planningDir, 'architecture.md');
  const apiContractsFile = path.join(planningDir, 'api-contracts.md');
  const dataModelFile = path.join(planningDir, 'data-model-spec.md');
  const testStrategyFile = path.join(planningDir, 'test-strategy.md');
  return {
    root,
    planningDir,
    contractsDir,
    indexFile,
    reportFile,
    featureRegistryFile,
    capabilitySpecIndexFile,
    trdFile,
    archFile,
    apiContractsFile,
    dataModelFile,
    testStrategyFile,
  };
}

function ensurePlanningDir(paths) {
  if (!fs.existsSync(paths.planningDir)) {
    return {
      ok: false,
      exitCode: 3,
      message: `Planning directory missing: ${paths.planningDir}. Run cobolt-plan first.`,
    };
  }
  return { ok: true };
}

// ---------- Schema + AJV (optional dep) ----------

function loadAjv() {
  const addFormats = (() => {
    try {
      return require('ajv-formats');
    } catch {
      return null;
    }
  })();
  // Prefer Ajv2020 (supports $schema: draft/2020-12 used by the capability-contract schema).
  try {
    const Ajv2020 = require('ajv/dist/2020');
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    if (addFormats) addFormats(ajv);
    return ajv;
  } catch {
    /* fall through */
  }
  try {
    const Ajv = require('ajv');
    const ajv = new Ajv({ allErrors: true, strict: false });
    if (addFormats) addFormats(ajv);
    return ajv;
  } catch {
    return null;
  }
}

function loadSchema() {
  const raw = readJsonSafe(SCHEMA_PATH);
  if (!raw) {
    throw new Error(`Cannot read schema at ${SCHEMA_PATH}`);
  }
  return raw;
}

// ---------- Feature registry loader ----------

function loadFeatureRegistry(paths) {
  const raw = readJsonSafe(paths.featureRegistryFile);
  if (!raw || !Array.isArray(raw.features)) {
    return { features: [], present: false };
  }
  return { features: raw.features, present: true };
}

// ---------- Scaffold ----------

const SCAFFOLD_STUB_OPERATION_NAME = 'TODO-operation-name';
const SCAFFOLD_STUB_NOTES_MARKER = 'STUB —';

function matchCapabilitySpecToFeature(feature, specIndex) {
  if (!specIndex || !Array.isArray(specIndex.specs) || specIndex.specs.length === 0) return null;
  const haystack = [feature.title, feature.featureId, ...(feature.keywordHints || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const spec of specIndex.specs) {
    const title = (spec.title || '').toLowerCase();
    const specTokens = title.split(/[\s\-_/]+/).filter((t) => t.length > 2);
    let score = 0;
    for (const token of specTokens) {
      if (haystack.includes(token)) score++;
    }
    for (const hint of spec.operationHints || []) {
      const noun = hint.split('-')[1];
      if (noun && haystack.includes(noun)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = spec;
    }
  }
  return bestScore >= 2 ? best : null;
}

function deriveTriggerFromHint(hint) {
  if (!hint || typeof hint !== 'string') return { kind: 'internal' };
  const lower = hint.toLowerCase();
  if (
    /^(submit|create|upload|send|pay|charge|invite|assign|publish|issue|notify|schedule|cancel|sign|register|enroll|redeem|mint)-/.test(
      lower,
    )
  ) {
    return { kind: 'http', verb: 'POST', path: `/api/${lower}` };
  }
  if (/^(update|approve|reject|revoke|grant|deny|flag|tag|share|configure|watermark)-/.test(lower)) {
    return { kind: 'http', verb: 'PATCH', path: `/api/${lower}` };
  }
  if (/^delete-/.test(lower)) return { kind: 'http', verb: 'DELETE', path: `/api/${lower}` };
  if (/^(view|search|filter|render|export)-/.test(lower)) {
    return { kind: 'http', verb: 'GET', path: `/api/${lower}` };
  }
  if (/^(log|audit|process|replay|calculate|verify|encrypt|decrypt|generate)-/.test(lower)) {
    return { kind: 'event', verb: '' };
  }
  return { kind: 'internal' };
}

function opHintToName(hint) {
  return (
    String(hint || '')
      .replace(/[^a-z0-9-]/gi, '')
      .replace(/-+/g, '-')
      .toLowerCase()
      .slice(0, 60) || 'TODO-operation-name'
  );
}

function scaffoldContract(feature, context = {}) {
  const featureId = feature.featureId;
  const title = feature.title || 'Untitled feature';
  const sourceIdsBase =
    Array.isArray(feature.sourceIds) && feature.sourceIds.length > 0
      ? feature.sourceIds
      : Array.isArray(feature.requirementIds) && feature.requirementIds.length > 0
        ? feature.requirementIds
        : ['SRC-UNMAPPED'];

  const spec = context.specMatch || null;
  const topHint =
    spec && Array.isArray(spec.operationHints) && spec.operationHints.length > 0 ? spec.operationHints[0] : null;
  const behaviorSeed = spec && Array.isArray(spec.behaviors) && spec.behaviors.length > 0 ? spec.behaviors[0] : null;

  const operationName = topHint ? opHintToName(topHint) : SCAFFOLD_STUB_OPERATION_NAME;
  const trigger = topHint ? deriveTriggerFromHint(topHint) : { kind: 'internal' };
  const postcondition = behaviorSeed
    ? `TODO: verify postcondition — ${behaviorSeed.text.slice(0, 180)}`
    : 'TODO: declare at least one observable postcondition';
  const actors = spec && Array.isArray(spec.actorHints) ? spec.actorHints.slice(0, 4) : [];
  const specSourceIds = spec ? [`capability-specs/${path.basename(spec.path || '')}`] : [];
  const sourceIds = [...sourceIdsBase, ...specSourceIds];
  const evidenceLevel = spec ? 'DERIVED' : 'ASSUMPTION';
  const notes = spec
    ? `DERIVED from capability spec ${spec.specId} (${spec.path}). Replace TODO markers with real postconditions, invariants, and error codes grounded in the spec + feature dossier.`
    : 'STUB — regenerate with real content grounded in the feature dossier, PRD, implicit-requirements, TRD, and data model. evidenceLevel must not remain ASSUMPTION at final stage.';

  return {
    schemaVersion: SCHEMA_VERSION,
    featureId,
    title,
    sourceIds,
    evidenceLevel,
    generatedAt: new Date().toISOString(),
    domainInvariants: [],
    stateMachines: [],
    operations: [
      {
        name: operationName,
        description: spec
          ? `DERIVED: primary operation of ${featureId} mapped to capability ${spec.specId}`
          : `TODO: describe the primary operation of ${featureId} (${title})`,
        trigger,
        actors,
        preconditions: [],
        postconditions: [postcondition],
        invariants: [],
        errorTaxonomy: [
          {
            code: 'TODO_ERR_001',
            condition: 'TODO: describe the error condition',
            retriable: false,
          },
        ],
        idempotency: { required: false, strategy: 'not-applicable' },
        timeouts: { totalMs: 5000 },
        retryPolicy: { strategy: 'none', maxAttempts: 0 },
        degradedModes: [],
        budgets: { p95Ms: 1000 },
        observability: {
          span: spec
            ? `feat.${featureId.toLowerCase()}.${operationName.toLowerCase()}`
            : `feat.${featureId.toLowerCase()}.todo-op`,
          logEvents: [],
          metrics: [],
        },
        propertyTests: [],
      },
    ],
    featureComposition: { dependsOn: [], orchestrationPattern: 'none' },
    domainEvents: { produces: [], consumes: [] },
    configAndFlags: { featureFlags: [], configValues: [] },
    notes,
  };
}

function isScaffoldStub(contract) {
  if (!contract || !Array.isArray(contract.operations) || contract.operations.length !== 1) return false;
  const op = contract.operations[0];
  const name = typeof op?.name === 'string' ? op.name : '';
  const notes = typeof contract.notes === 'string' ? contract.notes : '';
  if (name === SCAFFOLD_STUB_OPERATION_NAME && notes.includes(SCAFFOLD_STUB_NOTES_MARKER)) return true;
  if (/^TODO/i.test(name) && contract.evidenceLevel === 'ASSUMPTION') return true;
  return false;
}

function loadCapabilitySpecIndex(paths) {
  if (!paths?.capabilitySpecIndexFile) return null;
  return readJsonSafe(paths.capabilitySpecIndexFile);
}

function backfillCapabilitySpecIndex(paths, updates) {
  if (!paths?.capabilitySpecIndexFile || !fs.existsSync(paths.capabilitySpecIndexFile)) return;
  const index = readJsonSafe(paths.capabilitySpecIndexFile);
  if (!index || !Array.isArray(index.specs)) return;
  let changed = false;
  for (const spec of index.specs) {
    const update = updates.get(spec.specId);
    if (!update) continue;
    spec.traced = spec.traced || { features: [], epics: [], stories: [] };
    for (const featureId of update.features || []) {
      if (!spec.traced.features.includes(featureId)) {
        spec.traced.features.push(featureId);
        changed = true;
      }
    }
  }
  if (changed) {
    writeJson(paths.capabilitySpecIndexFile, index);
  }
}

function cmdScaffold(argv) {
  const flags = parseFlags(argv);
  const paths = resolvePaths(flags.cwd);
  const infra = ensurePlanningDir(paths);
  if (!infra.ok) {
    fail(flags, infra.message, infra.exitCode);
    return;
  }
  const registry = loadFeatureRegistry(paths);
  if (!registry.present) {
    fail(
      flags,
      `feature-registry.json missing or empty at ${paths.featureRegistryFile}. Run cobolt-analyze-features first.`,
      1,
    );
    return;
  }
  fs.mkdirSync(paths.contractsDir, { recursive: true });

  const specIndex = loadCapabilitySpecIndex(paths);
  const backfillUpdates = new Map();

  const results = [];
  for (const feature of registry.features) {
    if (!feature?.featureId) continue;
    const target = path.join(paths.contractsDir, `${feature.featureId}.contract.json`);
    if (fs.existsSync(target) && !flags.force) {
      results.push({ featureId: feature.featureId, action: 'skipped', path: target });
      continue;
    }
    const specMatch = matchCapabilitySpecToFeature(feature, specIndex);
    const contract = scaffoldContract(feature, { specMatch });
    writeJson(target, contract);
    if (specMatch) {
      const prev = backfillUpdates.get(specMatch.specId) || { features: [] };
      prev.features.push(feature.featureId);
      backfillUpdates.set(specMatch.specId, prev);
    }
    results.push({
      featureId: feature.featureId,
      action: fs.existsSync(target) && flags.force ? 'overwritten' : 'created',
      path: target,
      specMatched: specMatch ? specMatch.specId : null,
    });
  }

  if (backfillUpdates.size > 0) {
    backfillCapabilitySpecIndex(paths, backfillUpdates);
  }

  emit(flags, {
    ok: true,
    command: 'scaffold',
    total: registry.features.length,
    created: results.filter((r) => r.action === 'created').length,
    skipped: results.filter((r) => r.action === 'skipped').length,
    overwritten: results.filter((r) => r.action === 'overwritten').length,
    specMatched: results.filter((r) => r.specMatched).length,
    results,
  });
}

// ---------- Validate ----------

function validateContract(contract, schema, ajv, filePath) {
  const errors = [];
  if (ajv && schema) {
    const validator = ajv.compile(schema);
    const ok = validator(contract);
    if (!ok && Array.isArray(validator.errors)) {
      for (const e of validator.errors) {
        errors.push({
          kind: 'schema',
          path: e.instancePath || e.schemaPath,
          message: e.message,
        });
      }
    }
  } else {
    // Fallback structural check when ajv is unavailable — covers the critical fields only.
    const required = ['schemaVersion', 'featureId', 'title', 'sourceIds', 'evidenceLevel', 'operations'];
    for (const key of required) {
      if (contract[key] === undefined || contract[key] === null) {
        errors.push({ kind: 'schema-fallback', path: `/${key}`, message: 'required field missing' });
      }
    }
    if (Array.isArray(contract.operations)) {
      contract.operations.forEach((op, i) => {
        if (!op.name || !op.trigger || !op.postconditions || !op.errorTaxonomy || !op.budgets || !op.observability) {
          errors.push({
            kind: 'schema-fallback',
            path: `/operations/${i}`,
            message: 'required operation fields missing',
          });
        }
      });
    } else {
      errors.push({ kind: 'schema-fallback', path: '/operations', message: 'must be an array' });
    }
  }
  return { file: filePath, errors };
}

function cmdValidate(argv) {
  const flags = parseFlags(argv);
  const paths = resolvePaths(flags.cwd);
  const infra = ensurePlanningDir(paths);
  if (!infra.ok) {
    fail(flags, infra.message, infra.exitCode);
    return;
  }
  const schema = loadSchema();
  const ajv = loadAjv();
  const files = listJsonFiles(paths.contractsDir);
  if (files.length === 0) {
    fail(
      flags,
      `No *.contract.json files under ${paths.contractsDir}. Run cobolt-capability-contract.js scaffold first.`,
      1,
    );
    return;
  }
  const results = [];
  for (const file of files) {
    const contract = readJsonSafe(file);
    if (!contract) {
      results.push({ file, errors: [{ kind: 'read', message: 'not valid JSON' }] });
      continue;
    }
    results.push(validateContract(contract, schema, ajv, file));
  }
  const failed = results.filter((r) => r.errors.length > 0);
  if (failed.length > 0) {
    fail(
      flags,
      {
        ok: false,
        command: 'validate',
        totalFiles: files.length,
        failedFiles: failed.length,
        ajvLoaded: Boolean(ajv),
        errors: failed,
      },
      1,
    );
    return;
  }
  emit(flags, {
    ok: true,
    command: 'validate',
    totalFiles: files.length,
    ajvLoaded: Boolean(ajv),
  });
}

// ---------- Semantic checks (gate) ----------

function analyzeContract(contract, otherArtifacts) {
  const gaps = [];
  const warnings = [];

  if (!Array.isArray(contract.operations) || contract.operations.length === 0) {
    gaps.push('no operations declared');
  } else {
    contract.operations.forEach((op, i) => {
      const opId = `${contract.featureId}#${op.name || `op${i}`}`;

      if (!Array.isArray(op.postconditions) || op.postconditions.length === 0) {
        gaps.push(`${opId}: at least one postcondition required`);
      }
      if (!Array.isArray(op.errorTaxonomy) || op.errorTaxonomy.length === 0) {
        gaps.push(`${opId}: at least one errorTaxonomy entry required`);
      }
      if (!op.budgets || typeof op.budgets.p95Ms !== 'number') {
        gaps.push(`${opId}: budgets.p95Ms required`);
      }
      if (!op.observability?.span) {
        gaps.push(`${opId}: observability.span required`);
      }
      // Non-GET, non-internal triggers should declare idempotency intent.
      const kind = op.trigger?.kind;
      const verb = op.trigger && (op.trigger.verb || '').toUpperCase();
      const mutating =
        kind === 'http'
          ? verb && verb !== 'GET' && verb !== 'HEAD'
          : ['event', 'cli', 'ui-action', 'webhook'].includes(kind);
      if (mutating && !op.idempotency?.strategy) {
        gaps.push(`${opId}: mutating operations must declare idempotency.strategy`);
      }
      // If retryPolicy has attempts >0, timeouts must exist.
      if (op.retryPolicy?.maxAttempts && op.retryPolicy.maxAttempts > 0) {
        if (!op.timeouts?.totalMs) {
          gaps.push(`${opId}: retryPolicy.maxAttempts>0 requires timeouts.totalMs`);
        }
      }
      // Property tests should cover each referenced invariant (advisory — warns, not gap).
      if (Array.isArray(op.invariants) && op.invariants.length > 0) {
        const covered = new Set();
        for (const pt of op.propertyTests || []) {
          for (const inv of pt.coversInvariants || []) {
            covered.add(inv);
          }
        }
        for (const inv of op.invariants) {
          if (!covered.has(inv)) {
            warnings.push(`${opId}: invariant ${inv} not covered by any propertyTest`);
          }
        }
      }
      // Stub language detection (advisory at intake, gap at final).
      const postJoin = (op.postconditions || []).join('\n');
      if (/\bTODO\b|PLACEHOLDER|TBD/i.test(postJoin)) {
        warnings.push(`${opId}: postconditions contain stub markers (TODO/TBD/PLACEHOLDER)`);
      }
    });
  }

  if (contract.evidenceLevel === 'ASSUMPTION') {
    warnings.push('evidenceLevel=ASSUMPTION — must be resolved before final stage');
  }

  // State machine referential integrity
  if (Array.isArray(contract.stateMachines) && contract.stateMachines.length > 0) {
    const smNames = new Set(contract.stateMachines.map((sm) => sm.name));
    (contract.operations || []).forEach((op) => {
      if (op.stateMachineRef && !smNames.has(op.stateMachineRef)) {
        gaps.push(`${contract.featureId}#${op.name}: stateMachineRef ${op.stateMachineRef} missing`);
      }
    });
    contract.stateMachines.forEach((sm) => {
      if (!sm.states.includes(sm.initialState)) {
        gaps.push(`stateMachine ${sm.name}: initialState ${sm.initialState} not in states[]`);
      }
      (sm.terminalStates || []).forEach((t) => {
        if (!sm.states.includes(t)) {
          gaps.push(`stateMachine ${sm.name}: terminalState ${t} not in states[]`);
        }
      });
      (sm.transitions || []).forEach((tr, i) => {
        if (!sm.states.includes(tr.from)) {
          gaps.push(`stateMachine ${sm.name}.transitions[${i}]: from state ${tr.from} not in states[]`);
        }
        if (!sm.states.includes(tr.to)) {
          gaps.push(`stateMachine ${sm.name}.transitions[${i}]: to state ${tr.to} not in states[]`);
        }
      });
    });
  }

  // Invariant referential integrity — every op invariant must exist on contract.
  if (Array.isArray(contract.domainInvariants)) {
    const invIds = new Set(contract.domainInvariants.map((i) => i.id));
    (contract.operations || []).forEach((op) => {
      (op.invariants || []).forEach((invId) => {
        if (!invIds.has(invId)) {
          gaps.push(`${contract.featureId}#${op.name}: invariant ${invId} not in domainInvariants`);
        }
      });
      (op.propertyTests || []).forEach((pt) => {
        (pt.coversInvariants || []).forEach((invId) => {
          if (!invIds.has(invId)) {
            gaps.push(
              `${contract.featureId}#${op.name}: propertyTest ${pt.name} references missing invariant ${invId}`,
            );
          }
        });
      });
    });
  }

  // Final-stage cross-artifact checks (best-effort; advisory when artifacts absent).
  if (otherArtifacts.stage === 'final') {
    const trdAndObs = `${otherArtifacts.trd || ''}\n${otherArtifacts.architecture || ''}`;
    (contract.operations || []).forEach((op) => {
      const span = op.observability?.span;
      if (span && otherArtifacts.trd && !trdAndObs.toLowerCase().includes(span.toLowerCase())) {
        warnings.push(
          `${contract.featureId}#${op.name}: span "${span}" not found in trd.md/architecture.md — observability contract may not be honored`,
        );
      }
      (op.observability?.metrics ? op.observability.metrics : []).forEach((m) => {
        if (m.name && otherArtifacts.trd && !trdAndObs.toLowerCase().includes(m.name.toLowerCase())) {
          warnings.push(`${contract.featureId}#${op.name}: metric "${m.name}" not found in trd.md/architecture.md`);
        }
      });
    });
    // Invariants should be cited in test-strategy.md
    if (otherArtifacts.testStrategy && Array.isArray(contract.domainInvariants)) {
      contract.domainInvariants.forEach((inv) => {
        if (!otherArtifacts.testStrategy.includes(inv.id)) {
          warnings.push(`invariant ${inv.id} not referenced in test-strategy.md`);
        }
      });
    }
  }

  return { gaps, warnings };
}

// ---------- Check (gate) ----------

function deriveStatus({ gaps, warnings }, contract, stage) {
  if (!contract?.featureId) return 'BLOCKED';
  if (gaps.length > 0) return 'BLOCKED';
  // v0.48+: an untouched scaffold stub is always BLOCKED — a PASS with 25
  // identical boilerplate contracts is the exact failure class this guards.
  if (isScaffoldStub(contract)) return 'BLOCKED';
  if (contract.evidenceLevel === 'ASSUMPTION') return stage === 'final' ? 'BLOCKED' : 'DRAFT_ONLY';
  if (warnings.length > 0 && stage === 'final') return 'DRAFT_ONLY';
  return 'READY';
}

function cmdCheck(argv) {
  const flags = parseFlags(argv);
  const stage = flags.stage || 'intake';
  if (stage !== 'intake' && stage !== 'final') {
    fail(flags, `Invalid --stage ${stage}. Use intake or final.`, 1);
    return;
  }
  const paths = resolvePaths(flags.cwd);
  const infra = ensurePlanningDir(paths);
  if (!infra.ok) {
    fail(flags, infra.message, infra.exitCode);
    return;
  }

  const registry = loadFeatureRegistry(paths);
  if (!registry.present) {
    fail(flags, `feature-registry.json missing — run cobolt-analyze-features before capability-contract.`, 1);
    return;
  }

  const schema = loadSchema();
  const ajv = loadAjv();
  const trd = readTextSafe(paths.trdFile);
  const architecture = readTextSafe(paths.archFile);
  const testStrategy = readTextSafe(paths.testStrategyFile);
  const otherArtifacts = { trd, architecture, testStrategy, stage };

  const contracts = [];
  const missingFeatures = [];

  for (const feature of registry.features) {
    if (!feature?.featureId) continue;
    const file = path.join(paths.contractsDir, `${feature.featureId}.contract.json`);
    if (!fs.existsSync(file)) {
      missingFeatures.push({
        featureId: feature.featureId,
        path: file,
        status: 'MISSING',
        gaps: ['contract file missing'],
      });
      continue;
    }
    const contract = readJsonSafe(file);
    if (!contract) {
      contracts.push({
        featureId: feature.featureId,
        path: file,
        operationCount: 0,
        invariantCount: 0,
        stateMachineCount: 0,
        evidenceLevel: 'ASSUMPTION',
        status: 'BLOCKED',
        gaps: ['contract file is not valid JSON'],
      });
      continue;
    }
    const structural = validateContract(contract, schema, ajv, file);
    const semantic = analyzeContract(contract, otherArtifacts);
    const gaps = [...structural.errors.map((e) => `schema: ${e.path} ${e.message}`), ...semantic.gaps];
    const warnings = semantic.warnings;
    const status = deriveStatus({ gaps, warnings }, contract, stage);

    contracts.push({
      featureId: contract.featureId,
      path: file,
      operationCount: Array.isArray(contract.operations) ? contract.operations.length : 0,
      invariantCount: Array.isArray(contract.domainInvariants) ? contract.domainInvariants.length : 0,
      stateMachineCount: Array.isArray(contract.stateMachines) ? contract.stateMachines.length : 0,
      evidenceLevel: contract.evidenceLevel || 'ASSUMPTION',
      status,
      gaps,
      warnings,
    });
  }

  const allContracts = [...contracts, ...missingFeatures];

  const summary = {
    ready: allContracts.filter((c) => c.status === 'READY').length,
    draftOnly: allContracts.filter((c) => c.status === 'DRAFT_ONLY').length,
    blocked: allContracts.filter((c) => c.status === 'BLOCKED').length,
    missing: allContracts.filter((c) => c.status === 'MISSING').length,
  };

  const index = {
    version: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    planningDir: paths.planningDir,
    totalFeatures: registry.features.length,
    contracts: allContracts.map(({ warnings, ...rest }) => rest),
    summary,
  };

  writeJson(paths.indexFile, index);
  writeMarkdownReport(paths.reportFile, allContracts, summary, stage);

  // v0.48+: DRAFT_ONLY contracts pass through silently under the pre-v0.48 gate,
  // which is how 25 untouched scaffold stubs earned a 25/25 READY PASS. At
  // --stage final, in --auto mode, or when --strict-draft is forwarded by the
  // orchestrator, DRAFT_ONLY also blocks.
  const draftBlocking = stage === 'final' || flags.auto === true || flags.strictDraft === true;
  const passing = summary.blocked === 0 && summary.missing === 0 && (draftBlocking ? summary.draftOnly === 0 : true);
  const payload = {
    ok: passing,
    command: 'check',
    stage,
    draftBlocking,
    totalFeatures: registry.features.length,
    summary,
    indexFile: paths.indexFile,
    reportFile: paths.reportFile,
    ajvLoaded: Boolean(ajv),
    findings: allContracts,
  };
  if (passing) {
    emit(flags, payload);
  } else {
    fail(flags, payload, 1);
  }
}

function writeMarkdownReport(reportFile, contracts, summary, stage) {
  const lines = [];
  lines.push('# Capability Contracts Report');
  lines.push('');
  lines.push(`Stage: \`${stage}\``);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- READY: ${summary.ready}`);
  lines.push(`- DRAFT_ONLY: ${summary.draftOnly}`);
  lines.push(`- BLOCKED: ${summary.blocked}`);
  lines.push(`- MISSING: ${summary.missing}`);
  lines.push('');
  lines.push('## Per-Feature');
  lines.push('');
  lines.push('| Feature | Status | Ops | Invariants | State Machines | Evidence | Gaps |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const c of contracts) {
    const gapsText = Array.isArray(c.gaps) && c.gaps.length > 0 ? c.gaps.slice(0, 3).join('; ') : '—';
    lines.push(
      `| ${c.featureId} | ${c.status} | ${c.operationCount || 0} | ${c.invariantCount || 0} | ${c.stateMachineCount || 0} | ${c.evidenceLevel || '—'} | ${gapsText} |`,
    );
  }
  lines.push('');
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, `${lines.join('\n')}\n`, 'utf8');
}

// ---------- Census ----------

function cmdCensus(argv) {
  const flags = parseFlags(argv);
  const paths = resolvePaths(flags.cwd);
  const infra = ensurePlanningDir(paths);
  if (!infra.ok) {
    fail(flags, infra.message, infra.exitCode);
    return;
  }
  const registry = loadFeatureRegistry(paths);
  const files = listJsonFiles(paths.contractsDir).map((p) => path.basename(p, '.contract.json'));
  const have = new Set(files);
  const featureIds = (registry.features || []).map((f) => f?.featureId).filter(Boolean);
  const missing = featureIds.filter((id) => !have.has(id));
  const orphans = files.filter((id) => !featureIds.includes(id));
  const payload = {
    ok: missing.length === 0 && orphans.length === 0,
    command: 'census',
    featuresInRegistry: featureIds.length,
    contractsOnDisk: files.length,
    missing,
    orphans,
  };
  if (payload.ok) {
    emit(flags, payload);
  } else {
    fail(flags, payload, 1);
  }
}

// ---------- CLI plumbing ----------

function parseFlags(argv) {
  const flags = { json: false, force: false, auto: false, strictDraft: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--auto') flags.auto = true;
    else if (a === '--strict-draft') flags.strictDraft = true;
    else if (a === '--stage') flags.stage = argv[++i];
    else if (a === '--cwd') flags.cwd = argv[++i];
    else positional.push(a);
  }
  flags.positional = positional;
  return flags;
}

function emit(flags, payload) {
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderHuman(payload)}\n`);
  }
  process.exit(0);
}

function fail(flags, payload, code) {
  const exitCode = typeof code === 'number' ? code : 1;
  const body = typeof payload === 'string' ? { ok: false, message: payload } : payload;
  if (flags.json) {
    // tool exit-code contract (tools/CLAUDE.md): failure is signaled by exit
    // code, not by stream choice. Structured JSON output belongs on stdout
    // regardless of pass/fail so consumers can parse it reliably.
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  } else {
    process.stderr.write(`${renderHuman(body)}\n`);
  }
  process.exit(exitCode);
}

function renderHuman(payload) {
  if (!payload || typeof payload !== 'object') return String(payload);
  const lines = [];
  if (payload.command) lines.push(`Command: ${payload.command}`);
  if (payload.stage) lines.push(`Stage:   ${payload.stage}`);
  if (payload.totalFeatures !== undefined) lines.push(`Features: ${payload.totalFeatures}`);
  if (payload.summary) {
    lines.push(
      `Summary: READY=${payload.summary.ready} DRAFT_ONLY=${payload.summary.draftOnly} BLOCKED=${payload.summary.blocked} MISSING=${payload.summary.missing}`,
    );
  }
  if (payload.missing?.length) {
    lines.push(`Missing contracts: ${payload.missing.join(', ')}`);
  }
  if (payload.orphans?.length) {
    lines.push(`Orphan contracts: ${payload.orphans.join(', ')}`);
  }
  if (payload.indexFile) lines.push(`Index:   ${payload.indexFile}`);
  if (payload.reportFile) lines.push(`Report:  ${payload.reportFile}`);
  if (payload.findings && Array.isArray(payload.findings)) {
    for (const f of payload.findings) {
      if (Array.isArray(f.gaps) && f.gaps.length > 0) {
        lines.push(`  ${f.featureId} [${f.status}] gaps:`);
        for (const g of f.gaps) lines.push(`    - ${g}`);
      }
    }
  }
  if (payload.message) lines.push(payload.message);
  return lines.join('\n');
}

function printUsage() {
  const body = `
CoBolt Capability Contract — per-feature behavioral contract gate.

Usage:
  node tools/cobolt-capability-contract.js <command> [options]

Commands:
  scaffold   Generate stub *.contract.json files for every FEAT-NNN in feature-registry.json.
  validate   Validate every *.contract.json against the JSON Schema.
  check      Run the gate (structural + semantic + cross-artifact) and write index+report.
  census     Inventory which FEATs have contracts; detect orphans.

Options:
  --stage intake|final   Select gate strictness (default: intake).
  --auto                 Treat DRAFT_ONLY contracts as BLOCKED (for --auto pipelines).
  --strict-draft         Same as --auto but independent of autonomous-mode signals.
  --force                Overwrite existing files on scaffold.
  --cwd <dir>            Project root override.
  --json                 Machine-readable JSON output.

Exit codes:
  0  Success
  1  Hard error (validation failed, gate failed, bug, usage error)
  2  Missing optional dep (e.g. ajv not installed)
  3  Missing infra (planning directory absent)
`.trim();
  process.stdout.write(`${body}\n`);
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  switch (cmd) {
    case 'scaffold':
      return cmdScaffold(rest);
    case 'validate':
      return cmdValidate(rest);
    case 'check':
      return cmdCheck(rest);
    case 'census':
      return cmdCensus(rest);
    case '--help':
    case '-h':
    case undefined:
      printUsage();
      return;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n`);
      printUsage();
      process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  SCHEMA_VERSION,
  SCHEMA_PATH,
  INDEX_SCHEMA_PATH,
  scaffoldContract,
  analyzeContract,
  validateContract,
  deriveStatus,
  resolvePaths,
  loadFeatureRegistry,
  isScaffoldStub,
  matchCapabilitySpecToFeature,
  loadCapabilitySpecIndex,
  backfillCapabilitySpecIndex,
};
