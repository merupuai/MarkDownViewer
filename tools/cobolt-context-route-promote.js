#!/usr/bin/env node

// CoBolt Context Route Promotion Recommender — Phase 7 of
// docs/cobolt-context-routing-plan.md.
//
// Reads context-route-usage.jsonl telemetry and emits a GO / WAIT / NO-GO
// recommendation on whether to default-on the router for a given stage.
//
// **This tool never flips defaults.** It only produces an evidence-backed
// recommendation. The human operator or a later autonomous policy can act
// on it. This keeps Phase 7 a report, not a gate.
//
// Usage:
//   node tools/cobolt-context-route-promote.js check [--stage fix] [--json]
//   node tools/cobolt-context-route-promote.js report [--json]
//
// Criteria (per plan Phase 7 — "Routing can become default only if..."):
//   - MIN_SAMPLES entries for the stage
//   - Prompt size decreases on average (promptReductionMean < 0)
//   - Fix loop attempts do not increase (heuristic: no increase vs baseline)
//   - Review findings remain actionable (reviewFindings not lower than baseline)
//   - Omitted-path miss rate below threshold
//   - Tests-passed rate at or above baseline

const { summarizeUsage, readUsage } = require('./cobolt-context-route-usage');

const MIN_SAMPLES = 20;
const MAX_OMITTED_MISS_RATE = 0.1; // omitted-needed / omitted-total must be <= 10%
const MIN_PROMPT_REDUCTION_CHARS = 500; // mean prompt shrinkage required
const MAX_FIX_ATTEMPTS_RATIO = 1.1; // tolerate 10% increase in fix attempts vs pre-routing samples
const MIN_REVIEW_FINDINGS_RATIO = 1.0; // routed runs must not surface fewer findings than baseline
const MIN_TESTS_PASSED_RATE = 0.9; // 90%

function recommend(projectRoot, options = {}) {
  const stage = options.stage || null;
  const summary = summarizeUsage(projectRoot, { stage });
  const entries = readUsage(projectRoot).filter((e) => !stage || e.stage === stage);

  const reasons = [];
  let verdict = 'GO';

  if (summary.total < MIN_SAMPLES) {
    reasons.push(`insufficient-samples: ${summary.total}/${MIN_SAMPLES}`);
    verdict = 'WAIT';
  }

  if (summary.promptReductionMean === null) {
    reasons.push('no-prompt-size-samples');
    if (verdict === 'GO') verdict = 'WAIT';
  } else if (summary.promptReductionMean > -MIN_PROMPT_REDUCTION_CHARS) {
    reasons.push(`prompt-reduction-insufficient: mean=${Math.round(summary.promptReductionMean)} chars`);
    verdict = 'NO-GO';
  }

  if (summary.omittedMissRate !== null && summary.omittedMissRate > MAX_OMITTED_MISS_RATE) {
    reasons.push(
      `omitted-miss-rate-too-high: ${(summary.omittedMissRate * 100).toFixed(1)}% > ${(MAX_OMITTED_MISS_RATE * 100).toFixed(1)}%`,
    );
    verdict = 'NO-GO';
  }

  if (summary.testsPassedRate !== null && summary.testsPassedRate < MIN_TESTS_PASSED_RATE) {
    reasons.push(
      `tests-passed-rate-too-low: ${(summary.testsPassedRate * 100).toFixed(1)}% < ${(MIN_TESTS_PASSED_RATE * 100).toFixed(1)}%`,
    );
    verdict = 'NO-GO';
  }

  // Heuristic: compare fix attempts before/after routing when samples carry routePath distinction
  const routedFixAttempts = entries
    .filter((e) => e.routePath && Number.isFinite(e.fixAttempts))
    .map((e) => e.fixAttempts);
  const unroutedFixAttempts = entries
    .filter((e) => !e.routePath && Number.isFinite(e.fixAttempts))
    .map((e) => e.fixAttempts);
  const routedMean = routedFixAttempts.length > 0 ? mean(routedFixAttempts) : null;
  const unroutedMean = unroutedFixAttempts.length > 0 ? mean(unroutedFixAttempts) : null;
  if (routedMean !== null && unroutedMean !== null && unroutedMean > 0) {
    const ratio = routedMean / unroutedMean;
    if (ratio > MAX_FIX_ATTEMPTS_RATIO) {
      reasons.push(
        `fix-attempts-regression: routed=${routedMean.toFixed(1)} unrouted=${unroutedMean.toFixed(1)} ratio=${ratio.toFixed(2)}`,
      );
      verdict = 'NO-GO';
    }
  }

  const routedReviewFindings = entries
    .filter((e) => e.routePath && Number.isFinite(e.reviewFindings))
    .map((e) => e.reviewFindings);
  const unroutedReviewFindings = entries
    .filter((e) => !e.routePath && Number.isFinite(e.reviewFindings))
    .map((e) => e.reviewFindings);
  const routedReviewMean = routedReviewFindings.length > 0 ? mean(routedReviewFindings) : null;
  const unroutedReviewMean = unroutedReviewFindings.length > 0 ? mean(unroutedReviewFindings) : null;
  if (routedReviewMean !== null && unroutedReviewMean !== null && unroutedReviewMean > 0) {
    const ratio = routedReviewMean / unroutedReviewMean;
    if (ratio < MIN_REVIEW_FINDINGS_RATIO) {
      reasons.push(
        `review-findings-regression: routed=${routedReviewMean.toFixed(1)} unrouted=${unroutedReviewMean.toFixed(1)} ratio=${ratio.toFixed(2)}`,
      );
      verdict = 'NO-GO';
    }
  }

  if (reasons.length === 0) {
    reasons.push('all-criteria-met');
  }

  return {
    stage,
    verdict,
    reasons,
    summary,
    thresholds: {
      minSamples: MIN_SAMPLES,
      maxOmittedMissRate: MAX_OMITTED_MISS_RATE,
      minPromptReductionChars: MIN_PROMPT_REDUCTION_CHARS,
      maxFixAttemptsRatio: MAX_FIX_ATTEMPTS_RATIO,
      minReviewFindingsRatio: MIN_REVIEW_FINDINGS_RATIO,
      minTestsPassedRate: MIN_TESTS_PASSED_RATE,
    },
    generatedAt: new Date().toISOString(),
  };
}

function mean(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function reportAll(projectRoot) {
  const stages = new Set(
    readUsage(projectRoot)
      .map((e) => e.stage)
      .filter(Boolean),
  );
  const perStage = {};
  for (const s of stages) perStage[s] = recommend(projectRoot, { stage: s });
  const overall = recommend(projectRoot);
  return { overall, perStage };
}

// ── CLI ──────────────────────────────────────────────────────

function flagValue(args, flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : null;
}

function main(argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'report';

  if (cmd === '--help' || cmd === '-h') {
    console.log(`  CoBolt Context Route Promotion Recommender

  Usage:
    node tools/cobolt-context-route-promote.js check [--stage fix] [--json]
    node tools/cobolt-context-route-promote.js report [--json]

  Outputs GO / WAIT / NO-GO based on telemetry at
  _cobolt-output/audit/context-route-usage.jsonl. Never flips defaults.
`);
    process.exit(0);
  }

  if (cmd === 'check') {
    const verdict = recommend(process.cwd(), { stage: flagValue(args, '--stage') });
    if (args.includes('--json')) {
      console.log(JSON.stringify(verdict, null, 2));
    } else {
      console.log(`  Stage: ${verdict.stage || 'all'}  Verdict: ${verdict.verdict}`);
      for (const r of verdict.reasons) console.log(`    - ${r}`);
    }
    process.exit(verdict.verdict === 'NO-GO' ? 1 : 0);
  }

  if (cmd === 'report') {
    const report = reportAll(process.cwd());
    if (args.includes('--json')) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`  Overall: ${report.overall.verdict} (total samples: ${report.overall.summary.total})`);
      for (const [stage, v] of Object.entries(report.perStage)) {
        console.log(`  ${stage}: ${v.verdict}`);
        for (const r of v.reasons) console.log(`    - ${r}`);
      }
    }
    return;
  }

  console.error(`  Unknown command: ${cmd}`);
  process.exit(2);
}

module.exports = { recommend, reportAll };

if (require.main === module) main(process.argv);
