#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noThenProperty: 'then' is a workflow next-step indicator in the FX repair-class table, not a Promise thenable
// cobolt-fix-repair — Surgical repair of an already-run cobolt-fix iteration.
//
// v0.63+ Phase 2 of the Cobolt-Fix Pipeline Parity Initiative. Mirrors the
// cobolt-plan-fix repair-class architecture for fix-stage failures.
//
// 25-row FX repair-class table maps failure-classes to repair pathways
// (sub-skill, agent, or tool dispatch). Spec:
// docs/superpowers/specs/2026-05-03-cobolt-fix-parity-design.md §5.2
//
// Commands:
//   detect [--milestone M{n}]        Classify the current fix-stage failure
//                                    from finding-tracker, verdict, gate-skip-log.
//   dispatch <classId>               Look up repair pathway, return JSON contract.
//   classify-critique <M> <round>    Given fix-critic verdict, classify into
//                                    FX1 / FX8 / FX9 / etc.
//   advisory-request --milestone M --iteration N --verdict V
//                                    Write _cobolt-output/audit/advisory-request.json
//                                    for SKILL-level recovery-advisor dispatch.
//   record <classId> --strike        Increment strike count for a class.
//   iterate                          Full loop: detect → dispatch → re-verify
//                                    (orchestrated by /cobolt-fix-repair SKILL).
//
// Exit codes follow the standard contract: 0 success, 1 hard error, 2 missing
// optional dep, 3 missing infra. Strike-3-exhausted exits 0 with verdict=halt.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const FIX_DIR = path.join(ROOT, '_cobolt-output/latest/fix');
const AUDIT_DIR = path.join(ROOT, '_cobolt-output/audit');
const ITERATIONS_LEDGER = path.join(AUDIT_DIR, 'fix-repair-iterations.jsonl');
const ADVISORY_REQUEST = path.join(AUDIT_DIR, 'advisory-request.json');

// ── 25-row FX repair-class table ──────────────────────────────────────────
// Each row: {classId, title, source, dispatch: {kind, target, contextHints}}
// kind: 'sub-skill' | 'agent' | 'tool' | 'halt'
// source: signal that triggers detection (gate id, verdict marker, ledger entry)
const FX_TABLE = {
  FX1: {
    title: 'phantom-write — agent claimed fix but no diff applied',
    source: 'cobolt-agent-dispatch-ledger:zero-diff-completion',
    dispatch: { kind: 'agent', target: 'recovery-advisor', then: 'fix-lead-retry' },
    severity: 'critical',
  },
  FX2: {
    title: 'tool-gate-regression — lint/type/security broke after fix',
    source: 'step-5-tool-gate:non-zero-exit',
    dispatch: {
      kind: 'agent',
      target: 'domain-fix-by-prefix',
      contextHints: ['regression-context', 'tool-gate-output'],
    },
    severity: 'high',
  },
  FX3: {
    title: 'secret-gate-block — fix introduced hardcoded secret',
    source: 'cobolt-secret-gate:block',
    dispatch: { kind: 'agent', target: 'cobolt-backend-fix', contextHints: ['secret-gate-violation'] },
    severity: 'critical',
  },
  FX4: {
    title: 'non-deferrable-class-deferred — guard pre-loop hard-fail',
    source: 'pre-loop-guard:exit-1',
    dispatch: { kind: 'agent', target: 'architect-fix-agent', fallback: 'recovery-advisor:escalate' },
    severity: 'critical',
  },
  FX5: {
    title: 'test-introduced-regression — fix broke unrelated tests',
    source: 'step-5-regression-test:failure',
    dispatch: {
      kind: 'agent',
      target: 'test-writer',
      then: 'domain-fix-by-prefix',
      contextHints: ['regression-test-failure-set'],
    },
    severity: 'high',
  },
  FX6: {
    title: 'phantom-rate-spike — >80% phantom in batch',
    source: 'phantom-rate-tracker:gt-80',
    dispatch: {
      kind: 'agent',
      target: 'alternate-domain-fix',
      contextHints: ['rejected-batch', 'phantom-evidence'],
    },
    severity: 'high',
  },
  FX7: {
    title: 'tautology-in-regression-test — vacuous assertion',
    source: 'cobolt-fix-tautology-gate:block',
    dispatch: {
      kind: 'agent',
      target: 'test-writer',
      contextHints: ['tautology-detector-output', 'real-fix-required'],
    },
    severity: 'high',
  },
  FX8: {
    title: 'exception-swallow-introduced — silent error suppression',
    source: 'cobolt-fix-exception-swallow-gate:block',
    dispatch: {
      kind: 'agent',
      target: 'cobolt-backend-fix',
      contextHints: ['silent-failure-reviewer-context', 'log-removal-detected'],
    },
    severity: 'high',
  },
  FX9: {
    title: 'cosmetic-only-fix — comment-only diff',
    source: 'cobolt-fix-cosmetic-gate:block',
    dispatch: {
      kind: 'agent',
      target: 'domain-fix-by-prefix',
      contextHints: ['cosmetic-only-rejection', 'real-fix-required'],
    },
    severity: 'high',
  },
  FX10: {
    title: 'test-deletion-without-carry-forward',
    source: 'cobolt-fix-test-deletion-gate:block',
    dispatch: { kind: 'agent', target: 'fix-lead', contextHints: ['rejected-test-deletion'] },
    severity: 'critical',
  },
  FX11: {
    title: 'finding-without-traceability — orphan fix-stage edit',
    source: 'cobolt-fix-finding-traceability-gate:block',
    dispatch: {
      kind: 'tool',
      target: 'cobolt-fix-readiness.js',
      args: ['repair-finding-tracker'],
      then: 'fix-lead',
    },
    severity: 'high',
  },
  FX12: {
    title: 'arch-mutation-cross-milestone-conflict',
    source: 'cobolt-cross-milestone-smoke:retroactive-drift',
    dispatch: {
      kind: 'sub-skill',
      target: 'cobolt-plan-fix',
      contextHints: ['cross-milestone-repair', 'shipped-milestone-affected'],
    },
    severity: 'critical',
  },
  FX13: {
    title: 'sec-fix-without-exploit-verification',
    source: 'exploit-attempts.jsonl:missing',
    dispatch: { kind: 'agent', target: 'security-exploit-verifier', contextHints: ['sec-finding-id'] },
    severity: 'critical',
  },
  FX14: {
    title: 'db-fix-without-migration-replay',
    source: 'migration-replay.json:missing-or-fail',
    dispatch: { kind: 'agent', target: 'cobolt-db-fix', contextHints: ['migration-replay-required'] },
    severity: 'high',
  },
  FX15: {
    title: 'a11y-fix-without-axe-evidence',
    source: 'axe-results.json:missing',
    dispatch: { kind: 'agent', target: 'cobolt-frontend-fix', contextHints: ['wcag-verification-required'] },
    severity: 'high',
  },
  FX16: {
    title: 'perf-fix-without-budget-verdict',
    source: 'perf-budget-verdict.json:missing',
    dispatch: { kind: 'tool', target: 'cobolt-perf-budget.js', args: ['measure'] },
    severity: 'high',
  },
  FX17: {
    title: 'i18n-fix-incomplete-locales',
    source: 'locale-coverage:mismatch',
    dispatch: { kind: 'agent', target: 'cobolt-frontend-fix', contextHints: ['all-locales-required'] },
    severity: 'medium',
  },
  FX18: {
    title: 'comp-fix-without-regulation-checklist',
    source: 'regulation-checklist:missing',
    dispatch: { kind: 'agent', target: 'cobolt-compliance-fix', contextHints: ['regulation-checklist-injection'] },
    severity: 'high',
  },
  FX19: {
    title: 'api-contract-drift-mid-fix',
    source: 'interface-contracts.json:fingerprint-drift',
    dispatch: {
      kind: 'agent',
      target: 'architect-fix-agent',
      then: 'cross-milestone-smoke-verification',
    },
    severity: 'critical',
  },
  FX20: {
    title: 'wire-or-lifecycle-finding-recurring',
    source: 'WIRE-or-LIFECYCLE:2nd-iteration',
    dispatch: {
      kind: 'tool',
      target: 'cobolt-entrypoint-wiring-check.js',
      then: 'cobolt-worker-lifecycle-check.js',
    },
    severity: 'high',
  },
  FX21: {
    title: 'rca-incomplete-or-missing',
    source: 'rca-report.json:schema-fail',
    dispatch: { kind: 'tool', target: 'scripts/generate-rca.sh', args: ['--mandatory-sections'] },
    severity: 'medium',
  },
  FX22: {
    title: 'scope-gap-finding-deferred',
    source: 'pre-loop-non-deferrable:scope-gap',
    dispatch: { kind: 'halt', target: 'cobolt-unblock', reason: 'human-review-required' },
    severity: 'critical',
  },
  FX23: {
    title: 'illusion-critical-or-high-deferred',
    source: 'illusion-detector:deferred-on-critical-high',
    dispatch: {
      kind: 'halt',
      target: 'cobolt-unblock',
      reason: 'illusion-cannot-accept-skip-with-debt',
    },
    severity: 'critical',
  },
  FX24: {
    title: 'rtm-validated-fail-recurring',
    source: 'rtm-validated-fail:2nd-iteration',
    dispatch: {
      kind: 'agent',
      target: 'rtm-analyst',
      then: { kind: 'tool', target: 'cobolt-rtm.js', args: ['reconcile'] },
    },
    severity: 'high',
  },
  FX25: {
    title: 'story-count-mismatch-from-fix-side-effect',
    source: 'story-count-delta:post-fix',
    dispatch: { kind: 'sub-skill', target: 'cobolt-plan-fix', contextHints: ['cross-skill-escalation'] },
    severity: 'high',
  },
};

const DEFAULT_FALLBACK = {
  classId: 'DEFAULT',
  title: 'Unmapped failure-class — recovery-advisor terminal triage',
  dispatch: { kind: 'agent', target: 'recovery-advisor', contextHints: ['full-failure-ledger'] },
  severity: 'high',
};

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  } catch {
    /* exists */
  }
}

function readJSONSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function appendIterationLedger(entry) {
  ensureDir(AUDIT_DIR);
  fs.appendFileSync(ITERATIONS_LEDGER, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, {
    mode: 0o600,
  });
}

function readStrikeLedger() {
  if (!fs.existsSync(ITERATIONS_LEDGER)) return {};
  const lines = fs.readFileSync(ITERATIONS_LEDGER, 'utf8').split('\n').filter(Boolean);
  const strikes = {};
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry.classId) continue;
    if (entry.strike === true || entry.outcome === 'stuck') {
      strikes[entry.classId] = (strikes[entry.classId] || 0) + 1;
    }
  }
  return strikes;
}

// Detect classifies the current fix-stage failure from on-disk evidence.
// Reads (in priority order):
//   1. _cobolt-output/audit/fix-{tautology,exception-swallow,cosmetic,test-deletion,finding-traceability}-gate.jsonl
//      — recent block events map directly to FX7-FX11.
//   2. _cobolt-output/latest/fix/fix-verdict-iter-{N}.json — verdict tool output.
//   3. _cobolt-output/latest/fix/finding-tracker.json — IN_PROGRESS unresolved findings.
//   4. _cobolt-output/audit/gate-skip-log.jsonl — recent gate fails.
function cmdDetect(args) {
  const milestone = args.milestone || readJSONSafe(path.join(ROOT, 'cobolt-state.json'))?.currentMilestone || 'M1';

  const evidence = [];

  // 1. Recent producer-side gate blocks (FX7-FX11)
  const gateLogMap = {
    FX7: 'fix-tautology-gate.jsonl',
    FX8: 'fix-exception-swallow-gate.jsonl',
    FX9: 'fix-cosmetic-gate.jsonl',
    FX10: 'fix-test-deletion-gate.jsonl',
    FX11: 'fix-finding-traceability-gate.jsonl',
  };
  for (const [classId, logFile] of Object.entries(gateLogMap)) {
    const logPath = path.join(AUDIT_DIR, logFile);
    if (!fs.existsSync(logPath)) continue;
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).slice(-10);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.event?.includes('block')) {
          evidence.push({ classId, source: logFile, event: entry.event, at: entry.at });
        }
      } catch {
        /* skip */
      }
    }
  }

  // 2. Verdict tool output (last iteration)
  const verdictGlob = fs.existsSync(FIX_DIR)
    ? fs.readdirSync(FIX_DIR).filter((f) => /^fix-verdict-iter-\d+\.json$/.test(f))
    : [];
  if (verdictGlob.length > 0) {
    verdictGlob.sort();
    const lastVerdict = readJSONSafe(path.join(FIX_DIR, verdictGlob[verdictGlob.length - 1]));
    if (lastVerdict) {
      const v = lastVerdict.verdict || lastVerdict.action || '';
      // LOOP_PLATEAU/LOOP_PIVOT/LOOP_ARCH_ESCALATE/LOOP_INTEGRATION_PLATEAU map to FX classes
      if (v === 'LOOP_PIVOT' || v === 'LOOP_PLATEAU') {
        evidence.push({ classId: 'FX1', source: 'fix-verdict', verdict: v });
      } else if (v === 'LOOP_ARCH_ESCALATE' || v === 'LOOP_INTEGRATION_PLATEAU') {
        evidence.push({ classId: 'FX12', source: 'fix-verdict', verdict: v });
      } else if (v === 'LOOP_EXHAUSTED') {
        evidence.push({ classId: 'FX22', source: 'fix-verdict', verdict: v });
      }
    }
  }

  // 3. WIRE/LIFECYCLE finding recurrence (FX20)
  const tracker = readJSONSafe(path.join(FIX_DIR, 'finding-tracker.json'));
  if (tracker) {
    const findings = Array.isArray(tracker.findings) ? tracker.findings : Array.isArray(tracker) ? tracker : [];
    const recurring = findings.filter((f) => /^(WIRE|LIFECYCLE)-/.test(f.id || '') && (f.iteration || 0) >= 2);
    if (recurring.length > 0) {
      evidence.push({ classId: 'FX20', source: 'finding-tracker', count: recurring.length });
    }
  }

  // Pick highest-severity unresolved class.
  const candidates = evidence.map((e) => ({ ...e, severity: FX_TABLE[e.classId]?.severity || 'low' }));
  const pick = candidates.find((c) => c.severity === 'critical') || candidates[0] || null;

  const out = {
    milestone,
    evidenceCount: evidence.length,
    candidates,
    picked: pick ? { classId: pick.classId, severity: pick.severity, source: pick.source } : null,
    fallback: pick ? null : DEFAULT_FALLBACK.classId,
  };
  console.log(JSON.stringify(out, null, 2));
  return out;
}

function cmdDispatch(args) {
  const classId = args._[0] || args.class;
  if (!classId) {
    console.error('Usage: cobolt-fix-repair dispatch <classId>');
    process.exit(1);
  }
  const row = FX_TABLE[classId] || DEFAULT_FALLBACK;
  const strikes = readStrikeLedger();
  const strikeCount = strikes[classId] || 0;

  const out = {
    classId,
    title: row.title,
    severity: row.severity || 'medium',
    dispatch: row.dispatch,
    strikeCount,
    escalateAfter: 3,
    advice:
      strikeCount >= 3
        ? 'Three-strike rule reached: escalate to recovery-advisor or write HUMAN-REVIEW-REQUIRED.md for /cobolt-unblock.'
        : 'Dispatch via the indicated kind/target. Inject contextHints into the agent prompt or tool args.',
  };

  appendIterationLedger({
    classId,
    action: 'dispatch',
    strike: strikeCount + 1,
    outcome: 'in-progress',
  });

  console.log(JSON.stringify(out, null, 2));
  return out;
}

// classify-critique <milestone> <round> — read fix-critic verdict and return
// the FX class. Used by Step 4.5 in cobolt-fix/SKILL.md.
function cmdClassifyCritique(args) {
  const milestone = args._[0];
  const round = args._[1];
  if (!milestone || !round) {
    console.error('Usage: cobolt-fix-repair classify-critique <milestone> <round>');
    process.exit(1);
  }
  const critiquePath = path.join(FIX_DIR, milestone, 'self-critique', `round-${round}.json`);
  const critique = readJSONSafe(critiquePath);
  if (!critique) {
    console.log(JSON.stringify({ classId: null, reason: 'no-critique-file', critiquePath }));
    return;
  }
  const verdict = critique.verdict || critique.action || '';
  const targets = Array.isArray(critique.revisionTargets) ? critique.revisionTargets : [];

  let classId = null;
  if (verdict === 'pass') {
    classId = null;
  } else if (targets.some((t) => /comment-only|cosmetic/i.test(t.fixPrompt || ''))) {
    classId = 'FX9';
  } else if (targets.some((t) => /catch|swallow|silent/i.test(t.fixPrompt || ''))) {
    classId = 'FX8';
  } else if (targets.some((t) => /tautolog/i.test(t.fixPrompt || ''))) {
    classId = 'FX7';
  } else if (targets.some((t) => /phantom|no.?diff/i.test(t.fixPrompt || ''))) {
    classId = 'FX1';
  } else if (verdict === 'needs-revision') {
    classId = 'FX1'; // generic phantom-or-incomplete class
  }

  console.log(JSON.stringify({ classId, verdict, targetCount: targets.length, critiquePath }));
}

// Write _cobolt-output/audit/advisory-request.json so the cobolt-fix SKILL
// step 5C can deterministically dispatch recovery-advisor.
function cmdAdvisoryRequest(args) {
  const milestone = args.milestone;
  const iteration = args.iteration;
  const verdict = args.verdict;
  if (!milestone || !iteration || !verdict) {
    console.error('Usage: cobolt-fix-repair advisory-request --milestone M{n} --iteration N --verdict V');
    process.exit(1);
  }

  // Compute failureClass from verdict and recent gate-block evidence.
  const detectResult = cmdDetect({ milestone });
  const failureClass = detectResult.picked
    ? `fix-stage-${detectResult.picked.classId.toLowerCase()}`
    : 'fix-stage-generic';

  const request = {
    schemaVersion: 1,
    requestedAt: new Date().toISOString(),
    failureClass,
    milestone,
    iteration: Number(iteration),
    verdict,
    evidence: detectResult.candidates.slice(0, 5),
    allowedActions: [
      'retry',
      'retry-with-context',
      'fallback-main-session',
      'split-scope',
      'skip-with-debt',
      'escalate',
    ],
    debtRequirements: {
      // v0.52+ FR-loss debt contract extended to fix-stage in v0.62+.
      requiresFindingIds: detectResult.picked && /critical|high/i.test(detectResult.picked.severity || ''),
      requiresJustificationMinChars: 30,
    },
  };

  ensureDir(AUDIT_DIR);
  fs.writeFileSync(ADVISORY_REQUEST, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ written: ADVISORY_REQUEST, failureClass }));
}

function cmdRecord(args) {
  const classId = args._[0] || args.class;
  if (!classId) {
    console.error('Usage: cobolt-fix-repair record <classId> [--strike] [--outcome <s>]');
    process.exit(1);
  }
  appendIterationLedger({
    classId,
    action: 'record',
    strike: args.strike === true || args.strike === 'true',
    outcome: args.outcome || 'unknown',
  });
  console.log(JSON.stringify({ recorded: true, classId }));
}

function cmdList() {
  const out = Object.entries(FX_TABLE).map(([id, row]) => ({
    classId: id,
    title: row.title,
    severity: row.severity,
    dispatch: row.dispatch,
  }));
  console.log(JSON.stringify(out, null, 2));
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v.startsWith('--')) {
      const k = v.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[k] = true;
      } else {
        args[k] = next;
        i++;
      }
    } else {
      args._.push(v);
    }
  }
  return args;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const isHelp = cmd === '--help' || cmd === '-h';
  if (!cmd || isHelp) {
    console.log('Usage: cobolt-fix-repair {detect|dispatch|classify-critique|advisory-request|record|list} [args]');
    process.exit(0);
  }
  const args = parseArgs(rest);
  switch (cmd) {
    case 'detect':
      cmdDetect(args);
      break;
    case 'dispatch':
      cmdDispatch(args);
      break;
    case 'classify-critique':
      cmdClassifyCritique(args);
      break;
    case 'advisory-request':
      cmdAdvisoryRequest(args);
      break;
    case 'record':
      cmdRecord(args);
      break;
    case 'list':
      cmdList();
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  cmdDetect,
  cmdDispatch,
  cmdClassifyCritique,
  cmdAdvisoryRequest,
  cmdRecord,
  cmdList,
  FX_TABLE,
  DEFAULT_FALLBACK,
};
