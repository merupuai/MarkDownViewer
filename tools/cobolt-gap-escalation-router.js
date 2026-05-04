#!/usr/bin/env node

// CoBolt Gap-Escalation Router (v0.51+) — RC-3 fix.
//
// Replaces the terminal `auto_fail gate-hard-block` at Step 03A line 683 of
// cobolt-build/steps/03a-code-gap-analysis.md. When the in-step escalation
// chain (builder×3 → build-lead×2 → resolve-lead×2 → advisory) cannot close
// critical/high gaps, the legacy contract was: write hard-block evidence and
// stop before Step 04. The new contract: route the gap set into the broader
// `review-lead → fix-lead → domain fix-agents → recovery-advisor` network and
// only halt for *infrastructure* failures, not for *findings count*.
//
// This tool is the deterministic planner that transforms a code-gap report
// (and optional builder-return-log) into a structured dispatch plan that the
// skill consumes one-step-at-a-time.
//
// Inputs:
//   - <milestone>                  e.g. M1
//   - --report <path>              code-gap-report.json (required)
//   - --return-log <path>          builder-return-log.jsonl (optional)
//   - --domain-filter <list>       comma-separated subset (db,backend,frontend,contract,naming,other)
//   - --max-per-agent <n>          max gaps per dispatch (default 25 — keeps
//                                  fix-agent context manageable)
//   - --json                       machine-readable output (default human)
//   - --out <file>                 write JSON to file (implies --json)
//
// Output JSON shape (also exported as buildDispatchPlan):
//   {
//     milestone: "M1",
//     totalGaps: 662,
//     byDomain: { db: 12, backend: 87, frontend: 156, contract: 4, naming: 26, other: 377 },
//     byAgent: { "backend-dev": 87, "frontend-dev": 156, ... },           // when return-log provided
//     dispatchPlan: [
//       {
//         step: 1,
//         primary: "review-lead",
//         fallback: "recovery-advisor",
//         domain: "db",
//         fixAgent: "db-fix",
//         gapsCount: 12,
//         gapIds: ["gap-001", "gap-002", ...],
//         contextBundleHints: { producingAgents: ["backend-dev"], hottestFile: "..." }
//       },
//       ...
//     ],
//     recommendation: {
//       deferEligible: false,                  // only true when low-risk
//       splitMilestoneCandidate: true,         // when one domain dominates
//       suggestedNextSkill: "review-lead-dispatch"
//     }
//   }
//
// Exit codes (per tools/CLAUDE.md exit contract):
//   0 = success — dispatch plan emitted
//   1 = usage / unhandled error
//   2 = no gaps to route (skipped — caller should mark step PASS)

const fs = require('node:fs');
const path = require('node:path');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_NO_GAPS = 2;

const DEFAULT_MAX_PER_AGENT = 25;

// Domain → fix-agent mapping. Agents must exist in source/agents/.
// Verified against the M1 incident: db-fix, backend-fix, frontend-fix all
// exist in tree (per CLAUDE.md domain fix-agents list).
const DOMAIN_TO_AGENT = {
  db: 'db-fix',
  backend: 'backend-fix',
  frontend: 'frontend-fix',
  contract: 'architect-fix-agent',
  naming: 'backend-fix',
  other: 'backend-fix',
};

// Pattern → domain. First match wins. Patterns ordered most-specific first.
// Slashes are normalized to forward in classifyDomain before testing.
const DOMAIN_RULES = [
  // DB
  { test: (p) => /\b(?:priv\/repo\/migrations|migrations\/[0-9])/i.test(p), domain: 'db' },
  { test: (p) => /\.sql$/i.test(p), domain: 'db' },
  { test: (p) => /\b(?:repo|schema)\.ex$|\bschemas?\/[^/]+\.ex$/i.test(p), domain: 'db' },
  // Contract — proto / openapi / graphql sit between backend and frontend
  { test: (p) => /\.(proto|graphql|avsc|openapi\.ya?ml)$/i.test(p), domain: 'contract' },
  { test: (p) => /\bapi[-_]?contracts?[/.]/i.test(p), domain: 'contract' },
  // Frontend — must come BEFORE backend lib/ fallback so that `*_live.ex`
  // and `components/` paths in Elixir umbrella apps don't get swept into
  // backend by the catch-all.
  { test: (p) => /\.(tsx|jsx)$/i.test(p), domain: 'frontend' },
  { test: (p) => /(?:_live|_component)\.ex$|\/live\/[^/]+\.ex$/i.test(p), domain: 'frontend' },
  { test: (p) => /\b(?:components?|pages?|views?)\/[^/]+\.(?:ex|exs|js|ts|jsx|tsx)$/i.test(p), domain: 'frontend' },
  // Backend — controller / router / handler / api shapes (any prefix/suffix).
  // The `_(?:controller|router|handler)(?:_\w+)?\.ex` form catches both
  // `user_controller.ex` and `handler_42.ex` style suffixed files.
  {
    test: (p) => /(?:^|\/|_)(?:controller|router|handler|api)(?:_\w+)?\.(?:ex|exs|js|ts|go|py|rb)$/i.test(p),
    domain: 'backend',
  },
  { test: (p) => /\/api\/[^/]+\.(?:ex|exs|js|ts|go|py|rb)$/i.test(p), domain: 'backend' },
  { test: (p) => /(?:routes?|web)\/[^/]+\.(?:ex|exs|js|ts)$/i.test(p), domain: 'backend' },
  // Fallback: Elixir umbrella lib paths (contexts, operations, services, etc.)
  // are overwhelmingly backend domain. Without this, the M1 RawDrive case
  // (479 structural gaps under apps/<svc>/lib/<svc>/contexts/.../*.ex) all
  // dropped to 'other' and routed to the generic backend-fix anyway. Make
  // the routing explicit so the dispatch plan is auditable.
  { test: (p) => /\/lib\/.+\.(?:ex|exs)$/i.test(p), domain: 'backend' },
];

// Patterns that flag a gap as a naming/casing issue.
const NAMING_DRIFT_RE =
  /(snake[_-]?case|camel[_-]?case|underscore|naming[_-]?drift|identifier[-_]?casing|wrong\s+module\s+name)/i;

function classifyDomain(gap) {
  const message = String(gap?.message || gap?.description || '');
  const fileRaw = String(gap?.file || gap?.expectedFile || gap?.filePath || gap?.path || '');
  const file = fileRaw.replace(/\\/g, '/');
  const category = String(gap?.category || gap?.class || '').toLowerCase();

  // Naming drift wins over file-path classification because the file path
  // *itself* may be the offender.
  if (NAMING_DRIFT_RE.test(message) || category === 'naming-drift' || category === 'identifier-casing') {
    return 'naming';
  }

  // Explicit category from the gap report wins over inference.
  if (DOMAIN_TO_AGENT[category]) return category;

  for (const rule of DOMAIN_RULES) {
    if (rule.test(file)) return rule.domain;
  }
  return 'other';
}

function readGapReport(reportPath) {
  let raw;
  try {
    raw = fs.readFileSync(reportPath, 'utf8');
  } catch (e) {
    throw new Error(`Cannot read gap report at ${reportPath}: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Gap report is not valid JSON at ${reportPath}: ${e.message}`);
  }
}

function readReturnLog(logPath) {
  if (!logPath) return [];
  if (!fs.existsSync(logPath)) return [];
  let text;
  try {
    text = fs.readFileSync(logPath, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
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
}

// Best-effort attribution: for each gap, find the most recent return-log
// entry whose returnedFiles include the gap's file path, and credit that
// agent. Falls back to 'unknown' when nothing matches.
function attributeProducingAgent(gap, returnLog) {
  const file = String(gap?.file || gap?.expectedFile || gap?.filePath || gap?.path || '');
  if (!file) return 'unknown';
  const norm = file.replace(/\\/g, '/').toLowerCase();
  for (let i = returnLog.length - 1; i >= 0; i -= 1) {
    const entry = returnLog[i];
    const files = (entry.returnedFiles || entry.files || []).map((f) => String(f).replace(/\\/g, '/').toLowerCase());
    if (files.some((f) => f === norm || f.endsWith(norm) || norm.endsWith(f))) {
      return entry.agent || entry.subagent_type || entry.dispatchedAgent || 'unknown';
    }
  }
  return 'unknown';
}

function chunk(array, size) {
  if (size <= 0) return [array];
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

function buildDispatchPlan(opts) {
  const report = opts.report; // pre-parsed
  const milestone = opts.milestone || report?.milestone || 'unknown';
  const returnLog = opts.returnLog || [];
  const maxPerAgent = typeof opts.maxPerAgent === 'number' ? opts.maxPerAgent : DEFAULT_MAX_PER_AGENT;
  const domainFilter = opts.domainFilter && opts.domainFilter.length > 0 ? new Set(opts.domainFilter) : null;

  // Accept either {gaps:[...]} or {findings:[...]} or top-level array.
  const allGaps = Array.isArray(report)
    ? report
    : Array.isArray(report?.gaps)
      ? report.gaps
      : Array.isArray(report?.findings)
        ? report.findings
        : [];

  // Critical+High only — medium/low can carry-forward without escalation.
  const gaps = allGaps.filter((g) => {
    const sev = String(g?.severity || '').toLowerCase();
    return sev === 'critical' || sev === 'high';
  });

  // Bucket by domain.
  const byDomainGaps = {};
  const byAgent = {};
  const enriched = gaps
    .map((gap, i) => {
      const domain = classifyDomain(gap);
      if (domainFilter && !domainFilter.has(domain)) return null;
      const producingAgent = attributeProducingAgent(gap, returnLog);
      if (!byDomainGaps[domain]) byDomainGaps[domain] = [];
      byDomainGaps[domain].push(gap);
      if (producingAgent && producingAgent !== 'unknown') {
        byAgent[producingAgent] = (byAgent[producingAgent] || 0) + 1;
      }
      return {
        ...gap,
        _id: gap.id || `gap-${String(i + 1).padStart(4, '0')}`,
        _domain: domain,
        _producingAgent: producingAgent,
      };
    })
    .filter(Boolean);

  // Build dispatch steps. One step per (domain, chunk) — each chunk capped at
  // maxPerAgent so the fix-agent receives a tractable input.
  const dispatchPlan = [];
  let stepNumber = 0;
  for (const domain of Object.keys(byDomainGaps)) {
    const list = enriched.filter((g) => g._domain === domain);
    const chunks = chunk(list, maxPerAgent);
    for (const c of chunks) {
      stepNumber += 1;
      const producing = Array.from(new Set(c.map((g) => g._producingAgent).filter((a) => a !== 'unknown')));
      const fileFreq = {};
      for (const g of c) {
        const f = String(g.file || g.expectedFile || g.filePath || g.path || 'unknown');
        fileFreq[f] = (fileFreq[f] || 0) + 1;
      }
      const hottestFile = Object.entries(fileFreq).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      dispatchPlan.push({
        step: stepNumber,
        primary: 'review-lead',
        fallback: 'recovery-advisor',
        domain,
        fixAgent: DOMAIN_TO_AGENT[domain] || 'backend-fix',
        gapsCount: c.length,
        gapIds: c.map((g) => g._id),
        contextBundleHints: {
          producingAgents: producing,
          hottestFile,
        },
      });
    }
  }

  // Recommendation heuristics:
  //  - If one domain holds >70% of gaps AND total >=200 → split-milestone
  //    candidate. Domain-saturated milestones don't recover from a single
  //    fix-pass; surfacing this lets recovery-advisor consider re-mapping
  //    stories to M(n+1) via cobolt-rtm.js.
  //  - deferEligible: only true when total <=20 critical/high and no single
  //    domain dominates. Below that bar, fix-and-forward stays cheaper than
  //    deferral.
  const total = enriched.length;
  const domainCounts = Object.entries(byDomainGaps).map(([d, list]) => [d, list.length]);
  const dominantDomain = domainCounts.sort((a, b) => b[1] - a[1])[0];
  const dominanceRatio = total > 0 && dominantDomain ? dominantDomain[1] / total : 0;
  const splitMilestoneCandidate = total >= 200 && dominanceRatio >= 0.7;
  const deferEligible = total > 0 && total <= 20 && dominanceRatio < 0.7;

  return {
    milestone,
    totalGaps: total,
    byDomain: Object.fromEntries(domainCounts),
    byAgent,
    dispatchPlan,
    recommendation: {
      deferEligible,
      splitMilestoneCandidate,
      suggestedNextSkill: dispatchPlan.length === 0 ? null : 'review-lead-dispatch',
      dominanceNote:
        dominantDomain && dominanceRatio > 0
          ? `${dominantDomain[0]} accounts for ${(dominanceRatio * 100).toFixed(0)}% of critical/high gaps`
          : null,
    },
  };
}

function emitText(plan) {
  process.stdout.write(`Gap escalation plan for ${plan.milestone} — ${plan.totalGaps} critical/high gaps\n`);
  if (plan.totalGaps === 0) {
    process.stdout.write('  No gaps to route. Caller may proceed to Step 04.\n');
    return;
  }
  process.stdout.write('  By domain:\n');
  for (const [d, n] of Object.entries(plan.byDomain)) {
    process.stdout.write(`    ${d.padEnd(10)} ${n}  → ${DOMAIN_TO_AGENT[d] || 'backend-fix'}\n`);
  }
  if (Object.keys(plan.byAgent).length > 0) {
    process.stdout.write('  Producing agents (from return-log):\n');
    for (const [a, n] of Object.entries(plan.byAgent)) {
      process.stdout.write(`    ${a.padEnd(20)} ${n}\n`);
    }
  }
  process.stdout.write(`  Dispatch steps: ${plan.dispatchPlan.length}\n`);
  for (const step of plan.dispatchPlan.slice(0, 10)) {
    process.stdout.write(
      `    [${step.step}] ${step.primary} → ${step.fixAgent} on ${step.domain} (${step.gapsCount} gaps)\n`,
    );
  }
  if (plan.dispatchPlan.length > 10) {
    process.stdout.write(`    … ${plan.dispatchPlan.length - 10} more (use --json for full plan)\n`);
  }
  process.stdout.write('\nRecommendation:\n');
  if (plan.recommendation.splitMilestoneCandidate) {
    process.stdout.write(
      '  SPLIT-MILESTONE candidate — single domain dominates >=70% of >=200 gaps. Forward to recovery-advisor with split-to-next-milestone hint.\n',
    );
  } else if (plan.recommendation.deferEligible) {
    process.stdout.write(
      '  Defer-eligible — small gap count without single-domain dominance. Recovery-advisor may approve carry-forward.\n',
    );
  } else {
    process.stdout.write('  Standard escalation: dispatch each step in order, re-verify between steps.\n');
  }
  if (plan.recommendation.dominanceNote) {
    process.stdout.write(`  Note: ${plan.recommendation.dominanceNote}\n`);
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args[0];
  const rest = args.slice(1);
  const positional = rest.filter((a) => !a.startsWith('--'));
  const idx = (flag) => rest.indexOf(flag);
  const get = (flag) => (idx(flag) >= 0 ? rest[idx(flag) + 1] : null);
  return {
    cmd,
    positional,
    opts: {
      report: get('--report'),
      returnLog: get('--return-log'),
      domainFilter: get('--domain-filter')
        ? get('--domain-filter')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : null,
      maxPerAgent: get('--max-per-agent') ? Number(get('--max-per-agent')) : DEFAULT_MAX_PER_AGENT,
      json: rest.includes('--json') || idx('--out') >= 0,
      out: get('--out'),
    },
  };
}

function printUsage(stream) {
  stream.write(
    `${[
      'Usage: cobolt-gap-escalation-router plan <milestone> --report <path> [options]',
      '',
      'Required:',
      '  --report <path>            Path to {M}-code-gap-report.json',
      '',
      'Options:',
      '  --return-log <path>        Path to builder-return-log.jsonl (for per-agent attribution)',
      '  --domain-filter <list>     Comma-separated subset (db,backend,frontend,contract,naming,other)',
      '  --max-per-agent <n>        Max gaps per dispatch chunk (default 25)',
      '  --json                     Machine-readable output',
      '  --out <file>               Write JSON to file (implies --json)',
      '',
      'Exit codes: 0 OK | 1 usage | 2 no critical/high gaps to route',
    ].join('\n')}\n`,
  );
}

function main() {
  const { cmd, positional, opts } = parseArgs(process.argv);
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    printUsage(process.stderr);
    process.exit(EXIT_USAGE);
  }
  if (cmd !== 'plan') {
    process.stderr.write(`Unknown command: ${cmd}\n`);
    printUsage(process.stderr);
    process.exit(EXIT_USAGE);
  }
  const milestone = positional[0];
  if (!milestone) {
    process.stderr.write('plan requires a milestone (e.g. M1)\n');
    process.exit(EXIT_USAGE);
  }
  if (!opts.report) {
    process.stderr.write('plan requires --report <path>\n');
    process.exit(EXIT_USAGE);
  }

  let report;
  try {
    report = readGapReport(path.resolve(process.cwd(), opts.report));
  } catch (e) {
    process.stderr.write(`[cobolt-gap-escalation-router] ERROR: ${e.message}\n`);
    process.exit(EXIT_USAGE);
  }
  const returnLog = opts.returnLog ? readReturnLog(path.resolve(process.cwd(), opts.returnLog)) : [];
  const plan = buildDispatchPlan({
    report,
    returnLog,
    milestone,
    domainFilter: opts.domainFilter,
    maxPerAgent: opts.maxPerAgent,
  });

  if (opts.json) {
    const json = `${JSON.stringify(plan, null, 2)}\n`;
    if (opts.out) {
      const outPath = path.resolve(process.cwd(), opts.out);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, json, 'utf8');
    }
    process.stdout.write(json);
  } else {
    emitText(plan);
  }

  if (plan.totalGaps === 0) process.exit(EXIT_NO_GAPS);
  process.exit(EXIT_OK);
}

if (require.main === module) {
  main();
}

module.exports = {
  classifyDomain,
  buildDispatchPlan,
  attributeProducingAgent,
  readGapReport,
  readReturnLog,
  DOMAIN_TO_AGENT,
  DOMAIN_RULES,
  DEFAULT_MAX_PER_AGENT,
};
