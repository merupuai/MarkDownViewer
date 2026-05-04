#!/usr/bin/env node

// CoBolt Contract Replay Verifier
//
// Verifies that consumer-driven contract tests actually EXECUTED and PASSED
// for every (contract × consumer) pair between milestones. Complements the
// shape gate (cobolt-contract-verify) and semantic gate
// (cobolt-contract-semantic-verify) by requiring runtime proof.
//
// Looks for a verdict at:
//   _cobolt-output/latest/contracts/{M}-replay-verdict.json
//
// Verdict schema (expected):
//   {
//     milestone: "M2",
//     measuredAt: "2026-04-14T10:00:00Z",
//     gitSha: "abc123...",
//     pairs: [
//       {
//         contractId: "C-001",
//         consumer: "M2",
//         executed: true,
//         testFile: "tests/contracts/C-001.m2.test.js",
//         assertions: { request: {...}, response: {...} },
//         actualResponse: {...},
//         schemaValid: true,
//         semanticMatch: true,
//         failed: false
//       }, ...
//     ]
//   }
//
// Coverage = executed pairs / total (contract × consumer) pairs. Must == 1.0.
// Freshness: measuredAt within 72h AND gitSha == HEAD.
// Any failed assertion => fail.
//
// Usage:
//   node tools/cobolt-contract-replay.js check [--milestone M2] [--json]
//
// Exit codes:
//   0 — pass (or permissive no-op)
//   1 — fail
//   2 — invalid inputs

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const FRESH_WINDOW_MS = 72 * 60 * 60 * 1000;

function outputRoot(cwd) {
  return path.join(cwd, '_cobolt-output');
}

function contractsPath(cwd) {
  const candidates = [
    path.join(outputRoot(cwd), 'latest', 'planning', 'interface-contracts.json'),
    path.join(outputRoot(cwd), 'planning', 'interface-contracts.json'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function verdictPath(cwd, milestone) {
  return path.join(outputRoot(cwd), 'latest', 'contracts', `${milestone}-replay-verdict.json`);
}

function loadJson(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

function headSha(cwd) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function enumeratePairs(contracts, milestone) {
  // A pair is (contract, consumer). We only require replay for consumers that
  // are at or before the current milestone (current milestone consumes prior
  // producers). Filter to contracts whose consumers include `milestone`.
  const pairs = [];
  for (const c of contracts || []) {
    const consumers = c.consumers || [];
    for (const consumer of consumers) {
      if (!milestone || consumer === milestone) {
        pairs.push({ contractId: c.id, consumer });
      }
    }
  }
  return pairs;
}

function checkContractReplay({ cwd = process.cwd(), milestone = null } = {}) {
  const cp = contractsPath(cwd);
  if (!cp) {
    return { ok: true, skipped: true, reason: 'no interface-contracts.json', coverage: 1, failures: [] };
  }
  const contractsDoc = loadJson(cp);
  if (!contractsDoc) {
    return { ok: false, reason: `invalid contracts JSON at ${cp}`, coverage: 0, failures: [] };
  }
  const contracts = contractsDoc.contracts || [];
  const anyConsumers = contracts.some((c) => Array.isArray(c.consumers) && c.consumers.length > 0);
  if (!anyConsumers) {
    return { ok: true, skipped: true, reason: 'no contracts declare consumers', coverage: 1, failures: [] };
  }

  if (!milestone) {
    return { ok: false, reason: 'milestone required', coverage: 0, failures: [] };
  }
  // M1 has no prior producers to consume — permissive.
  if (/^M0*1$/.test(milestone)) {
    return { ok: true, skipped: true, reason: 'M1 — no prior milestone to consume', coverage: 1, failures: [] };
  }

  const pairs = enumeratePairs(contracts, milestone);
  if (pairs.length === 0) {
    return { ok: true, skipped: true, reason: `no contracts declare consumer=${milestone}`, coverage: 1, failures: [] };
  }

  const vp = verdictPath(cwd, milestone);
  if (!fs.existsSync(vp)) {
    return {
      ok: false,
      reason: `missing replay verdict at ${vp}`,
      coverage: 0,
      totalPairs: pairs.length,
      executedPairs: 0,
      failures: pairs.map((p) => ({ ...p, reason: 'not executed — verdict missing' })),
    };
  }
  const verdict = loadJson(vp);
  if (!verdict) {
    return { ok: false, reason: `invalid replay verdict JSON at ${vp}`, coverage: 0, failures: [] };
  }

  const failures = [];

  // Freshness
  const measuredAt = verdict.measuredAt ? Date.parse(verdict.measuredAt) : NaN;
  if (!Number.isFinite(measuredAt)) {
    failures.push({ reason: 'verdict.measuredAt missing or invalid' });
  } else if (Date.now() - measuredAt > FRESH_WINDOW_MS) {
    failures.push({ reason: `stale verdict — measuredAt older than 72h (${verdict.measuredAt})` });
  }
  const head = headSha(cwd);
  if (head && verdict.gitSha && verdict.gitSha !== head) {
    failures.push({ reason: `stale verdict — gitSha=${verdict.gitSha} HEAD=${head}` });
  }

  // Per-pair verification (census, not sampling)
  const verdictPairs = Array.isArray(verdict.pairs) ? verdict.pairs : [];
  const keyOf = (p) => `${p.contractId}::${p.consumer}`;
  const vByKey = new Map(verdictPairs.map((p) => [keyOf(p), p]));

  let executedPairs = 0;
  for (const p of pairs) {
    const v = vByKey.get(keyOf(p));
    if (!v) {
      failures.push({ ...p, reason: 'pair absent from verdict' });
      continue;
    }
    if (v.executed !== true) {
      failures.push({ ...p, reason: 'executed !== true' });
      continue;
    }
    if (!v.testFile || typeof v.testFile !== 'string') {
      failures.push({ ...p, reason: 'testFile missing' });
      continue;
    }
    if (!v.assertions || typeof v.assertions !== 'object' || !v.assertions.request || !v.assertions.response) {
      failures.push({ ...p, reason: 'assertions.request/response missing' });
      continue;
    }
    if (v.actualResponse === undefined || v.actualResponse === null) {
      failures.push({ ...p, reason: 'actualResponse missing' });
      continue;
    }
    if (v.schemaValid !== true) {
      failures.push({ ...p, reason: 'schemaValid !== true' });
      continue;
    }
    if (v.semanticMatch !== true) {
      failures.push({ ...p, reason: 'semanticMatch !== true (examples did not match)' });
      continue;
    }
    if (v.failed === true) {
      failures.push({ ...p, reason: 'assertion failed' });
      continue;
    }
    executedPairs++;
  }

  const coverage = pairs.length === 0 ? 1 : executedPairs / pairs.length;
  const ok = failures.length === 0 && coverage === 1;
  return {
    ok,
    milestone,
    totalPairs: pairs.length,
    executedPairs,
    coverage,
    failures,
    verdictPath: vp,
  };
}

function parseFlags(args) {
  const out = { _: [], milestone: null, json: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--milestone') out.milestone = args[++i];
    else if (args[i] === '--json') out.json = true;
    else out._.push(args[i]);
  }
  return out;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (cmd) {
    case 'check':
    case 'verify': {
      let milestone = flags.milestone;
      if (!milestone) {
        try {
          const sp = path.join(process.cwd(), 'cobolt-state.json');
          if (fs.existsSync(sp)) {
            const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
            milestone = s.pipeline?.currentMilestone || s.currentMilestone || null;
          }
        } catch {
          /* ignore */
        }
      }
      const result = checkContractReplay({ cwd: process.cwd(), milestone });
      console.log(JSON.stringify(result, null, 2));
      if (result.skipped) return 0;
      return result.ok ? 0 : 1;
    }
    default:
      console.error('Usage: cobolt-contract-replay.js check [--milestone M2] [--json]');
      return 2;
  }
}

if (require.main === module) process.exit(main());

module.exports = { checkContractReplay };
