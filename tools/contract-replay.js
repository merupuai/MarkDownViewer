#!/usr/bin/env node

// CoBolt Pact Contract Replay
//
// Loads consumer-driven pact artifacts from
//   _cobolt-output/latest/planning/contracts/*.pact.json
// replays each declared interaction against the current producer's recorded
// runtime handlers (captured by the build pipeline at step S6.3), and writes
// any failures to _cobolt-output/audit/contract-breaks.jsonl.
//
// Scope: CENSUS — every (contractId x consumer) pair is replayed. No sampling.
// Freshness: replay must be executed at milestone close with current HEAD.
// Modes:
//   node tools/contract-replay.js replay --milestone M3          # run + append audit
//   node tools/contract-replay.js check  --milestone M3 [--json] # verify verdict present & passing
//
// Exit codes:
//   0 — pass / permissive no-op (M1, no pacts)
//   1 — one or more pact interactions broke
//   2 — invalid inputs / malformed pact

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PACT_DIR_REL = path.join('_cobolt-output', 'latest', 'planning', 'contracts');
const RUNTIME_DIR_REL = path.join('_cobolt-output', 'latest', 'build');
const VERDICT_DIR_REL = path.join('_cobolt-output', 'latest', 'contracts');
const AUDIT_DIR_REL = path.join('_cobolt-output', 'audit');
const AUDIT_LOG = 'contract-breaks.jsonl';
const FRESH_WINDOW_MS = 72 * 60 * 60 * 1000;
const API_CONTRACTS_MD_REL = path.join('_cobolt-output', 'latest', 'planning', 'api-contracts.md');

// v0.47.4: Fail-closed when Planning declares API work but no replay fixtures
// exist. Previously M1/no-pacts/no-relevant-pacts all returned ok:true — that
// let a milestone claim green even when the Plan said "there are APIs" and
// the Build produced zero replay evidence.
function planningDeclaresApiContracts(cwd) {
  try {
    const docPath = path.join(cwd, API_CONTRACTS_MD_REL);
    if (!fs.existsSync(docPath)) return { declared: false, reason: 'api-contracts.md missing' };
    const text = fs.readFileSync(docPath, 'utf8');
    if (text.trim().length < 80) return { declared: false, reason: 'api-contracts.md too small' };
    // Heuristic: look for any HTTP verb table row or OpenAPI-style path.
    // Matches `| GET | /x | ...`, `**GET** /x`, `GET /x`, `- POST /x`, `get: /x`,
    // and markdown-table rows with pipes between the verb and the path.
    const verbPattern = /(^|[\s*`|])(GET|POST|PUT|PATCH|DELETE)[\s|*`"':]+\/\S+/im;
    if (verbPattern.test(text)) return { declared: true, evidence: 'http-verb-route' };
    // OpenAPI YAML style: `paths: /...` or `  /path:`
    if (/\bpaths\s*:/.test(text) || /^\s+\/[A-Za-z][\w-]*:/m.test(text)) {
      return { declared: true, evidence: 'openapi-paths' };
    }
    return { declared: false, reason: 'no route-like declarations found' };
  } catch {
    return { declared: false, reason: 'unreadable' };
  }
}

function readJson(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

function isM1(m) {
  return typeof m === 'string' && /^M0*1$/.test(m);
}

function listPactFiles(cwd) {
  const dir = path.join(cwd, PACT_DIR_REL);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.pact.json'))
    .map((f) => path.join(dir, f));
}

function loadProducerRuntime(cwd, providerMilestone) {
  // Producer runtime captured at step S6.3 — either a manifest of handlers
  // (HTTP routes/events/function signatures) or an explicit replay fixture.
  const candidates = [
    path.join(cwd, RUNTIME_DIR_REL, providerMilestone, 'runtime-manifest.json'),
    path.join(cwd, RUNTIME_DIR_REL, providerMilestone, 'contract-runtime.json'),
  ];
  for (const c of candidates) {
    const doc = readJson(c);
    if (doc) return { path: c, doc };
  }
  return null;
}

// Structural matcher — supports:
//   - exact scalar equality
//   - array shape check (length + per-index recurse)
//   - object: every declared key present with matching value; extras ignored
//   - matchingRules: {$.path: {type: 'type'|'regex'|'integer'|'decimal', regex?}}
function matches(expected, actual, rules, jsonPath = '$') {
  const rule = rules?.[jsonPath];
  if (rule) {
    if (rule.type === 'type') return typeof expected === typeof actual;
    if (rule.type === 'integer') return Number.isInteger(actual);
    if (rule.type === 'decimal') return typeof actual === 'number';
    if (rule.type === 'regex' && typeof actual === 'string') {
      try {
        return new RegExp(rule.regex).test(actual);
      } catch {
        return false;
      }
    }
  }
  if (expected === null || actual === null) return expected === actual;
  if (typeof expected !== typeof actual) return false;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    for (let i = 0; i < expected.length; i++) {
      if (!matches(expected[i], actual[i], rules, `${jsonPath}[${i}]`)) return false;
    }
    return true;
  }
  if (typeof expected === 'object') {
    for (const k of Object.keys(expected)) {
      if (!(k in actual)) return false;
      if (!matches(expected[k], actual[k], rules, `${jsonPath}.${k}`)) return false;
    }
    return true;
  }
  return expected === actual;
}

function findRuntimeResponse(runtime, request) {
  // runtime.doc shape (advisory, producer-emitted):
  //   { handlers: [{ kind, method?, path?, topic?, response: {status, body, headers} }] }
  const handlers = runtime?.doc?.handlers || runtime?.doc?.interactions || [];
  for (const h of handlers) {
    if (h.kind !== request.kind) continue;
    if (request.kind === 'http') {
      if (h.method === request.method && h.path === request.path) return h.response;
    } else if (request.kind === 'event') {
      if (h.topic === request.topic) return h.response;
    } else if (request.kind === 'function' || request.kind === 'rpc') {
      if (h.name === request.path || h.path === request.path) return h.response;
    } else if (request.kind === 'sql') {
      if (h.path === request.path) return h.response;
    }
  }
  return null;
}

function validatePactDoc(doc) {
  if (!doc || typeof doc !== 'object') return 'not-an-object';
  for (const k of ['pactVersion', 'contractId', 'provider', 'consumer', 'interactions']) {
    if (!(k in doc)) return `missing-field:${k}`;
  }
  if (!Array.isArray(doc.interactions) || doc.interactions.length === 0) return 'no-interactions';
  if (!doc.provider?.milestone || !/^M\d+$/.test(doc.provider.milestone)) return 'bad-provider';
  if (!doc.consumer?.milestone || !/^M\d+$/.test(doc.consumer.milestone)) return 'bad-consumer';
  return null;
}

function headSha(cwd) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function appendAudit(cwd, entries) {
  if (!entries.length) return;
  const dir = path.join(cwd, AUDIT_DIR_REL);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fp = path.join(dir, AUDIT_LOG);
  const lines = `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
  fs.appendFileSync(fp, lines, { mode: 0o600 });
  try {
    fs.chmodSync(fp, 0o600);
  } catch {
    /* best-effort */
  }
}

function writeVerdict(cwd, milestone, verdict) {
  const dir = path.join(cwd, VERDICT_DIR_REL);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${milestone}-pact-verdict.json`);
  fs.writeFileSync(fp, `${JSON.stringify(verdict, null, 2)}\n`);
  return fp;
}

function createVerdict(cwd, milestone, overrides = {}) {
  const sha = headSha(cwd);
  return {
    milestone,
    measuredAt: new Date().toISOString(),
    gitSha: sha,
    cacheHeadSha: sha,
    ok: true,
    skipped: false,
    reason: '',
    totalPairs: 0,
    executedPairs: 0,
    failed: 0,
    pass: true,
    pacts: [],
    ...overrides,
  };
}

function writeSkipVerdict(cwd, milestone, reason, pacts = [], options = {}) {
  // v0.47.4: If Planning declared API work but we'd otherwise skip, flip the
  // verdict to fail-closed. Callers that legitimately have no APIs pass
  // `options.forceSkipOk = true` (reserved for back-compat callers).
  const planIntent = options.forceSkipOk ? { declared: false } : planningDeclaresApiContracts(cwd);
  const planGapFails = planIntent.declared;
  const verdict = createVerdict(cwd, milestone, {
    skipped: true,
    reason: planGapFails ? `${reason}-but-plan-declared-apis` : reason,
    planIntent,
    totalPairs: 0,
    executedPairs: 0,
    failed: planGapFails ? 1 : 0,
    pass: !planGapFails,
    ok: !planGapFails,
    pacts,
  });
  const verdictPath = writeVerdict(cwd, milestone, verdict);
  return {
    ok: !planGapFails,
    skipped: true,
    reason: verdict.reason,
    failures: planGapFails
      ? [
          {
            reason: 'plan-declared-apis-without-pact-replay',
            evidence: planIntent.evidence,
            remediation:
              'Planning produced api-contracts.md with declared routes but no pact fixtures or replay evidence. ' +
              'Produce contract pacts under _cobolt-output/latest/planning/contracts/*.pact.json ' +
              'and a runtime manifest under _cobolt-output/latest/build/<M>/runtime-manifest.json.',
          },
        ]
      : [],
    totalPairs: 0,
    executedPairs: 0,
    coverage: planGapFails ? 0 : 1,
    verdict,
    verdictPath,
    planIntent,
  };
}

function replay({ cwd = process.cwd(), milestone } = {}) {
  if (!milestone || !/^M\d+$/.test(milestone)) {
    return { ok: false, skipped: false, reason: 'bad-milestone', failures: [] };
  }
  if (isM1(milestone)) {
    return writeSkipVerdict(cwd, milestone, 'M1-permissive');
  }
  const pactFiles = listPactFiles(cwd);
  if (pactFiles.length === 0) {
    return writeSkipVerdict(cwd, milestone, 'no-pacts');
  }

  const failures = [];
  let totalPairs = 0;
  let executedPairs = 0;
  const relevant = [];

  for (const fp of pactFiles) {
    const doc = readJson(fp);
    const err = validatePactDoc(doc);
    if (err) {
      failures.push({
        pactFile: fp,
        contractId: doc?.contractId,
        consumer: doc?.consumer?.milestone,
        interactionId: null,
        reason: `pact-malformed:${err}`,
      });
      continue;
    }
    // Only replay pacts where this milestone is the PRODUCER closing.
    if (doc.provider.milestone !== milestone) continue;
    relevant.push({ fp, doc });
  }

  if (relevant.length === 0) {
    return writeSkipVerdict(
      cwd,
      milestone,
      'no-relevant-pacts',
      pactFiles.map((fp) => path.relative(cwd, fp)),
    );
  }

  const runtime = loadProducerRuntime(cwd, milestone);
  if (!runtime) {
    for (const { fp, doc } of relevant) {
      for (const it of doc.interactions) {
        totalPairs++;
        failures.push({
          pactFile: fp,
          contractId: doc.contractId,
          consumer: doc.consumer.milestone,
          interactionId: it.id,
          reason: 'producer-runtime-manifest-missing',
        });
      }
    }
  } else {
    for (const { fp, doc } of relevant) {
      for (const it of doc.interactions) {
        totalPairs++;
        executedPairs++;
        const actual = findRuntimeResponse(runtime, it.request);
        if (!actual) {
          failures.push({
            pactFile: fp,
            contractId: doc.contractId,
            consumer: doc.consumer.milestone,
            interactionId: it.id,
            reason: 'no-matching-handler',
            request: {
              kind: it.request.kind,
              method: it.request.method,
              path: it.request.path,
              topic: it.request.topic,
            },
          });
          continue;
        }
        const exp = it.expectedResponse || {};
        const rules = exp.matchingRules || {};
        if (exp.status !== undefined && exp.status !== actual.status) {
          failures.push({
            pactFile: fp,
            contractId: doc.contractId,
            consumer: doc.consumer.milestone,
            interactionId: it.id,
            reason: 'status-mismatch',
            expected: exp.status,
            actual: actual.status,
          });
          continue;
        }
        if (exp.body !== undefined && !matches(exp.body, actual.body, rules, '$.body')) {
          failures.push({
            pactFile: fp,
            contractId: doc.contractId,
            consumer: doc.consumer.milestone,
            interactionId: it.id,
            reason: 'body-mismatch',
          });
        }
      }
    }
  }

  const verdict = createVerdict(cwd, milestone, {
    ok: failures.length === 0,
    totalPairs,
    executedPairs,
    failed: failures.length,
    pass: failures.length === 0,
    pacts: relevant.map(({ fp }) => path.relative(cwd, fp)),
  });
  writeVerdict(cwd, milestone, verdict);

  if (failures.length > 0) {
    const ts = new Date().toISOString();
    appendAudit(
      cwd,
      failures.map((f) => ({ ...f, milestone, ts, gitSha: verdict.gitSha })),
    );
  }

  return {
    ok: failures.length === 0,
    skipped: false,
    failures,
    totalPairs,
    executedPairs,
    coverage: totalPairs === 0 ? 1 : executedPairs / totalPairs,
    verdict,
  };
}

function check({ cwd = process.cwd(), milestone } = {}) {
  if (!milestone || !/^M\d+$/.test(milestone)) {
    return { ok: false, skipped: false, reason: 'bad-milestone', failures: [] };
  }
  const verdictPath = path.join(cwd, VERDICT_DIR_REL, `${milestone}-pact-verdict.json`);
  const v = readJson(verdictPath);
  if (!v) {
    return { ok: false, reason: 'verdict-missing', failures: [{ reason: 'verdict-missing' }] };
  }

  const pactFiles = listPactFiles(cwd);
  const relevant = pactFiles
    .map((fp) => ({ fp, doc: readJson(fp) }))
    .filter(({ doc }) => doc && doc.provider?.milestone === milestone);
  const skipReason = isM1(milestone)
    ? 'M1-permissive'
    : pactFiles.length === 0
      ? 'no-pacts'
      : relevant.length === 0
        ? 'no-relevant-pacts'
        : '';
  const ageMs = Date.now() - Date.parse(v.measuredAt || 0);
  if (!(ageMs >= 0) || ageMs > FRESH_WINDOW_MS) {
    return { ok: false, reason: 'verdict-stale', failures: [{ reason: 'verdict-stale' }], verdict: v };
  }
  if (v.gitSha && headSha(cwd) && v.gitSha !== headSha(cwd)) {
    return { ok: false, reason: 'sha-mismatch', failures: [{ reason: 'sha-mismatch' }], verdict: v };
  }
  if (v.failed > 0 || v.pass === false) {
    return {
      ok: false,
      reason: 'verdict-failing',
      failures: [{ reason: `verdict-failing: ${v.failed} breaks` }],
      verdict: v,
    };
  }
  if (skipReason) {
    return { ok: true, skipped: true, reason: v.reason || skipReason, failures: [], verdict: v, coverage: 1 };
  }
  return { ok: true, verdict: v, coverage: v.totalPairs === 0 ? 1 : v.executedPairs / v.totalPairs };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--milestone') out.milestone = argv[++i];
    else if (a === '--cwd') out.cwd = argv[++i];
    else if (a === '--json') out.json = true;
  }
  return out;
}

function main(argv) {
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  const cwd = args.cwd || process.cwd();
  let result;
  if (cmd === 'replay') {
    result = replay({ cwd, milestone: args.milestone });
  } else if (cmd === 'check') {
    result = check({ cwd, milestone: args.milestone });
  } else {
    process.stderr.write('usage: contract-replay.js <replay|check> --milestone M<n> [--cwd PATH] [--json]\n');
    process.exit(2);
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(
      `${cmd} ${args.milestone}: ${result.ok ? 'PASS' : 'FAIL'}` +
        (result.reason ? ` (${result.reason})` : '') +
        (result.failures?.length ? ` — ${result.failures.length} break(s)` : '') +
        '\n',
    );
  }
  if (!result.ok && !result.skipped) process.exit(1);
  process.exit(0);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { replay, check, matches, validatePactDoc };
