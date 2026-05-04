#!/usr/bin/env node

// CoBolt Validate-Escalation Router (v0.52+).
//
// Sister to tools/cobolt-gap-escalation-router.js. Replaces the terminal
// `auto_fail validation-layer-failed` at Step 07 line 147 of
// cobolt-build/steps/07-validate.md. When deterministic validation
// (cobolt-validate-milestone.js) reports failed layers, the legacy contract
// was: write hard-block evidence and stop before Step 08. The new contract:
// route the layer set into the broader review-lead → fix-lead → domain
// fix-agents → recovery-advisor network and only halt for *infrastructure*
// failures, not for *layer-failure count*.
//
// This tool is the deterministic planner that transforms an
// M{n}-validation-results.json (and optional builder-return-log) into a
// structured dispatch plan that the skill consumes one-step-at-a-time.
//
// Inputs:
//   - <milestone>                  e.g. M1
//   - --report <path>              M{n}-validation-results.json (required)
//   - --return-log <path>          builder-return-log.jsonl (optional)
//   - --domain-filter <list>       comma-separated subset (db,backend,frontend,test,framework,traceability,review,other)
//   - --json                       machine-readable output (default human)
//   - --out <file>                 write JSON to file (implies --json)
//
// Output JSON shape:
//   {
//     milestone: "M1",
//     totalFailedLayers: 8,
//     byDomain: { backend: 3, frontend: 1, test: 2, framework: 1, traceability: 1 },
//     dispatchPlan: [
//       {
//         step: 1,
//         primary: "review-lead",
//         fallback: "recovery-advisor",
//         domain: "backend",
//         fixAgent: "backend-fix",
//         layers: ["L3_fr_coverage", ...],
//         layerDetail: { L3_fr_coverage: "0% verified FR coverage..." },
//         contextBundleHints: { suggestedSteps: ["Step 03 gap loop", "Step 06 fix"] }
//       },
//       ...
//     ],
//     recommendation: {
//       deferEligible: false,
//       splitMilestoneCandidate: true,
//       suggestedNextSkill: "review-lead-dispatch"
//     }
//   }
//
// Exit codes (per tools/CLAUDE.md exit contract):
//   0 = success — dispatch plan emitted (one or more layers to route)
//   1 = usage / unhandled error
//   2 = no failed layers (caller should mark step PASS — not an escalation)

const fs = require('node:fs');
const path = require('node:path');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_NO_LAYERS = 2;

// Layer → domain mapping. Layer names come from cobolt-validate-milestone.js
// L1*, L1b*, L2*, L2b*, L3*, L4*, L4b*, L5*, L5b*, L5c*, L6* etc.
//
// The mapping reflects which fix-agent / recovery-target is best positioned to
// remediate that class of failure. When a layer fits multiple domains, we pick
// the "first responder" — the agent whose 70% closure target is most
// achievable for that layer.
const LAYER_TO_DOMAIN = {
  // Compile / test execution failures — depend on language; default to backend
  // (most validation runs are server-side test suites). Frontend-only test
  // failures still surface useful error trails for the reviewer to triage.
  L1_compile_tests: 'test',
  L1b_test_obligations: 'test',

  // Stub / illusion detection — placeholder bodies in production code
  L2_stub_detection: 'backend',
  L2b_illusion_detection: 'backend',

  // FR coverage — requirements traceability and implementation gap
  L3_fr_coverage: 'backend',

  // RTM integrity — upstream planning authoring; route to review-lead
  L4_rtm_integrity: 'traceability',

  // UI integrity — components, a11y, design tokens, frontend runtime
  L4b_ui_integrity: 'frontend',

  // Route health / wiring — server entrypoint and route registration
  L5_route_health: 'backend',
  L5b_orphan_publishers: 'backend',
  L5c_framework_bootstrap: 'framework',

  // Reviewer completeness — re-dispatch the missing reviewers
  L6_reviewer_completeness: 'review',
};

// Domain → fix-agent mapping. Agents must exist in source/agents/.
const DOMAIN_TO_AGENT = {
  backend: 'backend-fix',
  frontend: 'frontend-fix',
  db: 'db-fix',
  test: 'test-writer',
  framework: 'architect-fix-agent',
  traceability: 'rtm-analyst',
  review: 'review-lead',
  other: 'backend-fix',
};

// Domain → suggested upstream remediation step (for orchestrator hints)
const DOMAIN_TO_SUGGESTED_STEPS = {
  backend: ['Step 06 fix', 'Step 03 gap loop'],
  frontend: ['Step 06 fix', 'Step 04A wireframe-fidelity'],
  db: ['Step 06 fix', 'Step 06C schema-replay'],
  test: ['Step 06 fix', 'Step 02 RED', 'Step 03 GREEN'],
  framework: ['Step 03B integration-smoke', 'Step 06 fix'],
  traceability: ['Step 04B issues-registry', 'cobolt-rtm map-milestones'],
  review: ['Step 05 re-dispatch'],
  other: ['Step 06 fix'],
};

function classifyLayer(layerName) {
  const exact = LAYER_TO_DOMAIN[layerName];
  if (exact) return exact;
  // Fallback: prefix-based heuristic for unknown layer names so future
  // additions to cobolt-validate-milestone.js degrade gracefully rather
  // than dropping into 'other' silently.
  if (/^L1/i.test(layerName)) return 'test';
  if (/^L2/i.test(layerName)) return 'backend';
  if (/^L3/i.test(layerName)) return 'backend';
  if (/^L4b/i.test(layerName)) return 'frontend';
  if (/^L4/i.test(layerName)) return 'traceability';
  if (/^L5c/i.test(layerName)) return 'framework';
  if (/^L5/i.test(layerName)) return 'backend';
  if (/^L6/i.test(layerName)) return 'review';
  return 'other';
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    const k = v.startsWith('--') ? v.slice(2) : null;
    if (!k) {
      args._.push(v);
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[k] = true;
    } else {
      args[k] = next;
      i++;
    }
  }
  return args;
}

function readJSONSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function buildDispatchPlan({ milestone, validationResults, returnLog, domainFilter }) {
  const failedLayers = Array.isArray(validationResults?.failedLayers) ? validationResults.failedLayers : [];
  const layerDetailMap = {};
  for (const [name, layer] of Object.entries(validationResults?.layers || {})) {
    if (layer && (layer.status === 'failed' || layer.passed === false)) {
      layerDetailMap[name] = layer.detail || layer.message || 'failure detail unavailable';
    }
  }

  // Build domain -> [layers] map.
  const byDomain = {};
  for (const layer of failedLayers) {
    const domain = classifyLayer(layer);
    if (domainFilter && !domainFilter.includes(domain)) continue;
    (byDomain[domain] = byDomain[domain] || []).push(layer);
  }

  // Optional: enrich with builder-return-log statistics so the orchestrator
  // can prioritize agents that produced the most failed layers.
  const byAgent = {};
  if (returnLog && Array.isArray(returnLog)) {
    for (const entry of returnLog) {
      const agent = entry.agent || entry.reviewerAgent || 'unknown';
      byAgent[agent] = (byAgent[agent] || 0) + 1;
    }
  }

  const dispatchPlan = [];
  let stepCounter = 1;
  // Stable ordering: traceability/review last (they typically gate, not produce).
  const domainOrder = ['db', 'framework', 'backend', 'frontend', 'test', 'traceability', 'review', 'other'];
  for (const domain of domainOrder) {
    if (!byDomain[domain] || byDomain[domain].length === 0) continue;
    const layers = byDomain[domain];
    const fixAgent = DOMAIN_TO_AGENT[domain] || DOMAIN_TO_AGENT.other;
    const layerDetail = {};
    for (const layer of layers) layerDetail[layer] = layerDetailMap[layer] || 'no-detail';
    dispatchPlan.push({
      step: stepCounter++,
      primary: 'review-lead',
      fallback: 'recovery-advisor',
      domain,
      fixAgent,
      layers,
      layerDetail,
      contextBundleHints: {
        suggestedSteps: DOMAIN_TO_SUGGESTED_STEPS[domain] || DOMAIN_TO_SUGGESTED_STEPS.other,
        layerCount: layers.length,
      },
    });
  }

  // Recommendation: split-milestone-candidate when a single domain accounts
  // for >60% of failed layers (suggests the milestone scope was too broad
  // for the chosen architecture surface).
  const totalFailed = failedLayers.length;
  let largestDomain = null;
  let largestSize = 0;
  for (const [d, ls] of Object.entries(byDomain)) {
    if (ls.length > largestSize) {
      largestDomain = d;
      largestSize = ls.length;
    }
  }
  const splitMilestoneCandidate = totalFailed > 0 && largestSize / totalFailed > 0.6 && totalFailed >= 4;

  // Defer-eligible only when 100% of failures are in low-risk domains
  // (review, traceability) — never when backend/db/framework fail.
  const safeDomains = new Set(['review', 'traceability']);
  const allSafe = Object.keys(byDomain).every((d) => safeDomains.has(d));
  const deferEligible = totalFailed > 0 && allSafe;

  const suggestedNextSkill =
    dispatchPlan.length === 0
      ? 'no-action'
      : dispatchPlan.length === 1 && dispatchPlan[0].domain === 'review'
        ? 'cobolt-review-redispatch'
        : 'review-lead-dispatch';

  return {
    milestone,
    generatedAt: new Date().toISOString(),
    totalFailedLayers: totalFailed,
    byDomain: Object.fromEntries(Object.entries(byDomain).map(([d, ls]) => [d, ls.length])),
    byAgent,
    dispatchPlan,
    recommendation: {
      deferEligible,
      splitMilestoneCandidate,
      largestDomain,
      largestDomainShare: totalFailed > 0 ? Math.round((largestSize / totalFailed) * 100) : 0,
      suggestedNextSkill,
    },
  };
}

function readReturnLog(returnLogPath) {
  if (!returnLogPath || !fs.existsSync(returnLogPath)) return null;
  try {
    return fs
      .readFileSync(returnLogPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return null;
  }
}

function showHelp() {
  process.stdout.write(
    'Usage: cobolt-validate-escalation-router plan <milestone> --report <validation-results.json> ' +
      '[--return-log <path>] [--domain-filter <csv>] [--json] [--out <file>]\n',
  );
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    showHelp();
    process.exit(EXIT_OK);
  }
  const cmd = argv[0];
  if (cmd !== 'plan') {
    console.error(`[validate-escalation-router] unknown command: ${cmd}`);
    showHelp();
    process.exit(EXIT_USAGE);
  }
  const args = parseArgs(argv.slice(1));
  const milestone = args.milestone || args._[0];
  if (!milestone) {
    console.error('Missing milestone argument.');
    showHelp();
    process.exit(EXIT_USAGE);
  }
  if (!args.report) {
    console.error('Missing --report path (M{n}-validation-results.json).');
    showHelp();
    process.exit(EXIT_USAGE);
  }
  const validationResults = readJSONSafe(args.report);
  if (!validationResults) {
    console.error(`Could not read or parse: ${args.report}`);
    process.exit(EXIT_USAGE);
  }
  const failedLayers = Array.isArray(validationResults.failedLayers) ? validationResults.failedLayers : [];
  if (failedLayers.length === 0) {
    console.log(JSON.stringify({ milestone, totalFailedLayers: 0, dispatchPlan: [] }));
    process.exit(EXIT_NO_LAYERS);
  }

  const returnLog = readReturnLog(args['return-log']);
  const domainFilter =
    typeof args['domain-filter'] === 'string'
      ? args['domain-filter']
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      : null;

  const plan = buildDispatchPlan({ milestone, validationResults, returnLog, domainFilter });
  const json = JSON.stringify(plan, null, 2);

  const wantJson = args.json || args.out;
  const outFile = typeof args.out === 'string' ? args.out : null;

  if (outFile) {
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.writeFileSync(outFile, json, { encoding: 'utf8', mode: 0o600 });
  }
  if (wantJson || !outFile) {
    process.stdout.write(`${json}\n`);
  } else {
    // Human-readable summary
    process.stdout.write(`Validate Escalation Plan — ${milestone}\n`);
    process.stdout.write(`Total failed layers: ${plan.totalFailedLayers}\n`);
    for (const step of plan.dispatchPlan) {
      process.stdout.write(
        `  Step ${step.step}: ${step.domain} → ${step.fixAgent} (${step.layers.length} layer${step.layers.length === 1 ? '' : 's'}: ${step.layers.join(', ')})\n`,
      );
    }
  }
  process.exit(EXIT_OK);
}

if (require.main === module) main();

module.exports = { buildDispatchPlan, classifyLayer, LAYER_TO_DOMAIN, DOMAIN_TO_AGENT };
