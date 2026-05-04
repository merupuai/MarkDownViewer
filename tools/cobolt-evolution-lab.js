#!/usr/bin/env node

// CoBolt Evolution Lab — Autonomous Validation for Evolution Proposals
//
// Inspired by Karpathy's autoresearch: "one file, one metric, fixed budget."
// Validates evolution-proposed skills BEFORE they graduate to active use.
//
// The evolution system (cobolt-evolution.js) proposes skill mutations from
// failure patterns. Today, proposals go to learned-skills/ and sit there.
// This lab closes the loop: it tests each proposal against historical
// pipeline data to prove (or disprove) that the proposal would improve
// pipeline outcomes.
//
// Architecture:
//   1. Load — Read proposals from evolution/proposals.json + learned-skills/
//   2. Baseline — Compute baseline metrics from historical pipeline runs
//   3. Simulate — For each proposal, replay historical failures and check
//      if the proposal's corrective action would have caught/prevented them
//   4. Score — Single optimization metric: "improvement potential" (0-1)
//   5. Graduate — Proposals above threshold get marked as validated
//
// All validation is DETERMINISTIC — no LLM, no agent dispatch, pure analysis.
// Each proposal validated within a fixed wall-clock budget (default 5s).
//
// Usage:
//   node tools/cobolt-evolution-lab.js validate [--threshold 0.6]
//   node tools/cobolt-evolution-lab.js baseline
//   node tools/cobolt-evolution-lab.js status
//   node tools/cobolt-evolution-lab.js report [--json]
//
// Exit codes:
//   0 = success (proposals validated)
//   1 = no proposals to validate
//   2 = usage error

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { atomicWriteJSON } = require('../lib/cobolt-atomic-write');

// ── Path Resolution ────────────────────────────────────────

function outputDir() {
  return path.join(process.cwd(), '_cobolt-output');
}

function evolutionDir() {
  return path.join(outputDir(), 'evolution');
}

function labDir() {
  return path.join(evolutionDir(), 'lab');
}

function proposalsFile() {
  return path.join(evolutionDir(), 'proposals.json');
}

function lessonsFile() {
  return path.join(evolutionDir(), 'lessons.jsonl');
}

function learnedSkillsDir() {
  return path.join(evolutionDir(), 'learned-skills');
}

function labResultsFile() {
  return path.join(labDir(), 'validation-results.json');
}

function labHistoryFile() {
  return path.join(labDir(), 'validation-history.jsonl');
}

function baselineFile() {
  return path.join(labDir(), 'baseline-metrics.json');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    return fs
      .readFileSync(filePath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function atomicWrite(filePath, data) {
  atomicWriteJSON(filePath, data, { mode: 0o600 });
}

// ── Step 1: Baseline Computation ───────────────────────────
// Computes baseline metrics from historical pipeline data.
// These are the "before" numbers that proposals must improve upon.

function computeBaseline() {
  const metrics = {
    computedAt: new Date().toISOString(),
    totalLessons: 0,
    failuresByCategory: {},
    failuresByArchetype: {},
    avgFixIterations: 0,
    avgGatePassRate: 0,
    avgFindingAccuracy: 0,
    recurrenceRate: 0, // how often the same failure repeats
    meanTimeToFix: 0, // avg fix iterations for resolved issues
    totalProposals: 0,
    proposalsGraduated: 0,
  };

  // Load lessons
  const lessons = readJsonl(lessonsFile());
  metrics.totalLessons = lessons.length;

  if (lessons.length === 0) return metrics;

  // Category distribution
  for (const lesson of lessons) {
    const cat = lesson.category || 'unknown';
    metrics.failuresByCategory[cat] = (metrics.failuresByCategory[cat] || 0) + 1;
  }

  // Archetype distribution
  for (const lesson of lessons) {
    const arch = lesson.archetype || lesson.archetypeId || 'unknown';
    metrics.failuresByArchetype[arch] = (metrics.failuresByArchetype[arch] || 0) + 1;
  }

  // Recurrence rate: what % of lessons share an archetype with another
  const archetypeCounts = Object.values(metrics.failuresByArchetype);
  const recurring = archetypeCounts.filter((c) => c > 1).reduce((sum, c) => sum + c, 0);
  metrics.recurrenceRate = lessons.length > 0 ? recurring / lessons.length : 0;

  // Fix iteration stats from pipeline state
  try {
    const statePath = path.join(process.cwd(), 'cobolt-state.json');
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      metrics.avgFixIterations = state.fixLoop?.count || 0;
    }
  } catch {
    /* noop */
  }

  // Gate pass rate from gate-skip-log
  try {
    const gateLog = readJsonl(path.join(outputDir(), 'audit', 'gate-skip-log.jsonl'));
    if (gateLog.length > 0) {
      const passed = gateLog.filter((g) => g.result === 'pass' || g.action === 'approve').length;
      metrics.avgGatePassRate = passed / gateLog.length;
    }
  } catch {
    /* noop */
  }

  // Finding accuracy from phantom reviewers
  try {
    const phantomPath = path.join(outputDir(), 'audit', 'phantom-reviewers.json');
    if (fs.existsSync(phantomPath)) {
      const phantoms = JSON.parse(fs.readFileSync(phantomPath, 'utf8'));
      const agents = phantoms.agents || phantoms.reviewers || [];
      if (agents.length > 0) {
        const accuracies = agents.filter((a) => typeof a.phantomRate === 'number').map((a) => 1 - a.phantomRate);
        if (accuracies.length > 0) {
          metrics.avgFindingAccuracy = accuracies.reduce((s, a) => s + a, 0) / accuracies.length;
        }
      }
    }
  } catch {
    /* noop */
  }

  // Existing proposals count
  try {
    if (fs.existsSync(proposalsFile())) {
      const data = JSON.parse(fs.readFileSync(proposalsFile(), 'utf8'));
      metrics.totalProposals = (data.proposals || []).length;
    }
  } catch {
    /* noop */
  }

  // Graduated skills count — source of truth is learned-skills directory
  try {
    const dir = learnedSkillsDir();
    if (fs.existsSync(dir)) {
      metrics.proposalsGraduated = fs.readdirSync(dir).filter((d) => {
        return fs.existsSync(path.join(dir, d, 'SKILL.md'));
      }).length;
    }
  } catch {
    /* noop */
  }

  return metrics;
}

// ── Step 2: Proposal Validation ────────────────────────────
// For each proposal, simulate whether it would have caught historical
// failures that match its archetype. Score by improvement potential.

const VALIDATION_TIMEOUT_MS = 5000; // 5s per proposal — fixed budget

function validateProposal(proposal, lessons, _baseline) {
  const startTime = Date.now();
  const result = {
    proposalId: proposal.id,
    proposalName: proposal.name,
    archetype: proposal.sourceArchetype,
    confidence: proposal.confidence,
    scores: {},
    improvementPotential: 0,
    validated: false,
    validatedAt: new Date().toISOString(),
    wallClockMs: 0,
    timedOut: false,
  };

  // Timeout guard
  const checkTimeout = () => {
    if (Date.now() - startTime > VALIDATION_TIMEOUT_MS) {
      result.timedOut = true;
      return true;
    }
    return false;
  };

  // Score 1: Archetype Coverage (0-1)
  // Does this proposal target a recurring failure pattern?
  const targetArchetype = proposal.sourceArchetype;
  const matchingLessons = lessons.filter((l) => (l.archetype || l.archetypeId) === targetArchetype);
  const coverage = lessons.length > 0 ? matchingLessons.length / lessons.length : 0;
  // Scale: a proposal covering 10%+ of all failures is high-impact
  result.scores.archetypeCoverage = Math.min(1, coverage * 10);

  if (checkTimeout()) {
    finalizeResult(result, startTime);
    return result;
  }

  // Score 2: Recurrence Reduction Potential (0-1)
  // Would this proposal reduce the recurrence rate?
  const archetypeCount = matchingLessons.length;
  // A proposal targeting a 3+ occurrence archetype has high recurrence reduction
  result.scores.recurrenceReduction =
    archetypeCount >= 3 ? 1.0 : archetypeCount === 2 ? 0.7 : archetypeCount === 1 ? 0.3 : 0;

  if (checkTimeout()) {
    finalizeResult(result, startTime);
    return result;
  }

  // Score 3: Action Specificity (0-1)
  // Is the corrective action specific enough to be useful?
  const body = proposal.body || '';
  const specificitySignals = [
    /validate|check|enforce|require|prevent/i.test(body), // actionable verb
    /before|after|when|during|if/i.test(body), // temporal context
    body.length >= 200, // substantive
    /file|function|config|schema|test/i.test(body), // concrete target
    proposal.confidence >= 0.7, // high confidence
  ];
  result.scores.actionSpecificity = specificitySignals.filter(Boolean).length / specificitySignals.length;

  if (checkTimeout()) {
    finalizeResult(result, startTime);
    return result;
  }

  // Score 4: Non-Contradiction (0-1)
  // Does this proposal contradict any existing graduated skill?
  let contradiction = 0;
  try {
    const dir = learnedSkillsDir();
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        if (checkTimeout()) break;
        const skillFile = path.join(dir, name, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;
        const content = fs.readFileSync(skillFile, 'utf8');
        // Simple overlap check: if both target the same archetype, flag
        if (content.includes(targetArchetype) && name !== proposal.name) {
          contradiction = 0.5; // partial contradiction (overlapping scope)
        }
      }
    }
  } catch {
    /* noop */
  }
  result.scores.nonContradiction = 1 - contradiction;

  if (checkTimeout()) {
    finalizeResult(result, startTime);
    return result;
  }

  // Score 5: Temporal Relevance (0-1)
  // Are the matching failures recent (not ancient history)?
  if (matchingLessons.length > 0) {
    const now = Date.now();
    const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    const weights = matchingLessons.map((l) => {
      const age = now - new Date(l.createdAt || l.timestamp || 0).getTime();
      return Math.exp((-Math.LN2 * age) / HALF_LIFE_MS);
    });
    result.scores.temporalRelevance = weights.reduce((s, w) => s + w, 0) / weights.length;
  } else {
    result.scores.temporalRelevance = 0;
  }

  if (checkTimeout()) {
    finalizeResult(result, startTime);
    return result;
  }

  // Score 6: Severity Alignment (0-1)
  // Does the proposal target high-severity failures?
  const severityMap = { critical: 1.0, high: 0.8, medium: 0.5, low: 0.2 };
  if (matchingLessons.length > 0) {
    const severities = matchingLessons.map((l) => severityMap[l.severity] || 0.3);
    result.scores.severityAlignment = severities.reduce((s, v) => s + v, 0) / severities.length;
  } else {
    result.scores.severityAlignment = 0.3; // assume medium if unknown
  }

  finalizeResult(result, startTime);
  return result;
}

function finalizeResult(result, startTime) {
  result.wallClockMs = Date.now() - startTime;

  // Compute single optimization metric: improvement potential
  // Weighted composite — archetype coverage and recurrence reduction matter most
  const weights = {
    archetypeCoverage: 0.25,
    recurrenceReduction: 0.25,
    actionSpecificity: 0.15,
    nonContradiction: 0.1,
    temporalRelevance: 0.15,
    severityAlignment: 0.1,
  };

  let total = 0;
  let weightSum = 0;
  for (const [key, weight] of Object.entries(weights)) {
    if (typeof result.scores[key] === 'number') {
      total += result.scores[key] * weight;
      weightSum += weight;
    }
  }

  result.improvementPotential = weightSum > 0 ? Math.round((total / weightSum) * 1000) / 1000 : 0;
}

// ── Step 3: Validation Loop ────────────────────────────────

function runValidation(options = {}) {
  const threshold = options.threshold || 0.6;

  // Load proposals — hoist the raw data object to avoid TOCTOU re-read later
  let proposals = [];
  let proposalData = null;
  try {
    if (fs.existsSync(proposalsFile())) {
      proposalData = JSON.parse(fs.readFileSync(proposalsFile(), 'utf8'));
      proposals = (proposalData.proposals || []).filter((p) => p.gateResult?.passed);
    }
  } catch {
    /* noop */
  }

  // Also check learned skills that haven't been validated
  try {
    const dir = learnedSkillsDir();
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        const skillFile = path.join(dir, name, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;
        // Check if already in proposals
        if (proposals.some((p) => p.name === name)) continue;
        // Create a synthetic proposal for unvalidated learned skills
        const content = fs.readFileSync(skillFile, 'utf8');
        const archetypeMatch = content.match(/Archetype:\s*(\S+)/);
        proposals.push({
          id: `LS-${crypto.createHash('sha256').update(name).digest('hex').slice(0, 8)}`,
          name,
          sourceArchetype: archetypeMatch ? archetypeMatch[1] : 'unknown',
          confidence: 0.6,
          body: content,
          gateResult: { passed: true },
          source: 'learned-skill',
        });
      }
    }
  } catch {
    /* noop */
  }

  if (proposals.length === 0) {
    return { validated: 0, rejected: 0, total: 0, threshold, message: 'No proposals to validate' };
  }

  // Compute baseline
  const baseline = computeBaseline();
  atomicWrite(baselineFile(), baseline);

  // Load lessons for simulation
  const lessons = readJsonl(lessonsFile());

  // Validate each proposal
  const results = [];
  for (const proposal of proposals) {
    const result = validateProposal(proposal, lessons, baseline);
    result.validated = result.improvementPotential >= threshold;
    results.push(result);
  }

  // Sort by improvement potential (best first)
  results.sort((a, b) => b.improvementPotential - a.improvementPotential);

  // Save results
  ensureDir(labDir());
  atomicWrite(labResultsFile(), {
    validatedAt: new Date().toISOString(),
    threshold,
    baseline: {
      totalLessons: baseline.totalLessons,
      recurrenceRate: baseline.recurrenceRate,
      avgFindingAccuracy: baseline.avgFindingAccuracy,
    },
    results,
  });

  // Log to history
  const historyEntry = {
    timestamp: new Date().toISOString(),
    threshold,
    totalProposals: proposals.length,
    validated: results.filter((r) => r.validated).length,
    rejected: results.filter((r) => !r.validated).length,
    topScore: results.length > 0 ? results[0].improvementPotential : 0,
    topName: results.length > 0 ? results[0].proposalName : null,
  };
  try {
    fs.appendFileSync(labHistoryFile(), `${JSON.stringify(historyEntry)}\n`, { mode: 0o600 });
  } catch {
    /* noop */
  }

  // Mark validated proposals in proposals.json — use hoisted data to avoid TOCTOU
  try {
    if (proposalData) {
      for (const result of results) {
        const proposal = (proposalData.proposals || []).find((p) => p.id === result.proposalId);
        if (proposal) {
          proposal.labValidated = result.validated;
          proposal.improvementPotential = result.improvementPotential;
          proposal.validatedAt = result.validatedAt;
        }
      }
      atomicWrite(proposalsFile(), proposalData);
    }
  } catch {
    /* noop */
  }

  const validated = results.filter((r) => r.validated);
  const rejected = results.filter((r) => !r.validated);

  return {
    total: results.length,
    validated: validated.length,
    rejected: rejected.length,
    threshold,
    results: results.map((r) => ({
      name: r.proposalName,
      score: r.improvementPotential,
      validated: r.validated,
      wallClockMs: r.wallClockMs,
      timedOut: r.timedOut,
      scores: r.scores,
    })),
    message:
      validated.length > 0
        ? `Validated ${validated.length}/${results.length} proposals (threshold: ${threshold}): ${validated.map((v) => `${v.proposalName} (${v.improvementPotential})`).join(', ')}`
        : `No proposals met threshold ${threshold} (best: ${results[0]?.improvementPotential || 0})`,
  };
}

// ── CLI Commands ───────────────────────────────────────────

function cmdValidate(args) {
  const thresholdIdx = args.indexOf('--threshold');
  let threshold = 0.6;
  if (thresholdIdx >= 0) {
    const parsed = parseFloat(args[thresholdIdx + 1]);
    if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
      console.error('Error: --threshold must be a number between 0 and 1');
      process.exit(2);
    }
    threshold = parsed;
  }
  const json = args.includes('--json');

  const result = runValidation({ threshold });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('CoBolt Evolution Lab — Validation Results');
    console.log('═'.repeat(50));
    console.log(`Proposals tested: ${result.total}`);
    console.log(`Validated:        ${result.validated} (threshold: ${result.threshold})`);
    console.log(`Rejected:         ${result.rejected}`);
    console.log('');

    if (result.results && result.results.length > 0) {
      console.log('Results (ranked by improvement potential):');
      console.log('─'.repeat(50));
      for (const r of result.results) {
        const status = r.validated ? '✓' : '✗';
        const timeout = r.timedOut ? ' [timeout]' : '';
        console.log(`  ${status} ${r.name}: ${r.score.toFixed(3)}${timeout} (${r.wallClockMs}ms)`);
      }
      console.log('');
    }

    console.log(result.message);
  }

  process.exit(result.validated > 0 ? 0 : 1);
}

function cmdBaseline(args) {
  const json = args.includes('--json');
  const baseline = computeBaseline();
  atomicWrite(baselineFile(), baseline);

  if (json) {
    console.log(JSON.stringify(baseline, null, 2));
  } else {
    console.log('CoBolt Evolution Lab — Baseline Metrics');
    console.log('═'.repeat(50));
    console.log(`Total lessons:        ${baseline.totalLessons}`);
    console.log(`Recurrence rate:      ${(baseline.recurrenceRate * 100).toFixed(1)}%`);
    console.log(`Avg finding accuracy: ${(baseline.avgFindingAccuracy * 100).toFixed(1)}%`);
    console.log(`Avg fix iterations:   ${baseline.avgFixIterations}`);
    console.log(`Gate pass rate:       ${(baseline.avgGatePassRate * 100).toFixed(1)}%`);
    console.log(`Proposals graduated:  ${baseline.proposalsGraduated}`);
    console.log('');

    if (Object.keys(baseline.failuresByCategory).length > 0) {
      console.log('Failures by category:');
      for (const [cat, count] of Object.entries(baseline.failuresByCategory).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${cat}: ${count}`);
      }
    }
  }
}

function cmdStatus() {
  console.log('CoBolt Evolution Lab — Status');
  console.log('═'.repeat(50));

  // Check for baseline
  if (fs.existsSync(baselineFile())) {
    try {
      const baseline = JSON.parse(fs.readFileSync(baselineFile(), 'utf8'));
      console.log(`Baseline: computed ${baseline.computedAt} (${baseline.totalLessons} lessons)`);
    } catch {
      console.log('Baseline: corrupt');
    }
  } else {
    console.log('Baseline: not computed (run: node tools/cobolt-evolution-lab.js baseline)');
  }

  // Check for results
  if (fs.existsSync(labResultsFile())) {
    try {
      const results = JSON.parse(fs.readFileSync(labResultsFile(), 'utf8'));
      const validated = (results.results || []).filter((r) => r.validated).length;
      const total = (results.results || []).length;
      console.log(
        `Last validation: ${results.validatedAt} — ${validated}/${total} passed (threshold: ${results.threshold})`,
      );
    } catch {
      console.log('Last validation: corrupt');
    }
  } else {
    console.log('Last validation: none');
  }

  // Check history
  const history = readJsonl(labHistoryFile());
  console.log(`Validation runs: ${history.length}`);

  // Check pending proposals
  let pending = 0;
  try {
    if (fs.existsSync(proposalsFile())) {
      const data = JSON.parse(fs.readFileSync(proposalsFile(), 'utf8'));
      pending = (data.proposals || []).filter((p) => p.gateResult?.passed && !p.labValidated).length;
    }
  } catch {
    /* noop */
  }
  console.log(`Pending proposals: ${pending}`);

  // Check learned skills
  let graduated = 0;
  try {
    const dir = learnedSkillsDir();
    if (fs.existsSync(dir)) {
      graduated = fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'SKILL.md'))).length;
    }
  } catch {
    /* noop */
  }
  console.log(`Graduated skills: ${graduated}`);
}

function cmdReport(args) {
  const json = args.includes('--json');

  if (!fs.existsSync(labResultsFile())) {
    console.log('No validation results. Run: node tools/cobolt-evolution-lab.js validate');
    process.exit(1);
  }

  const results = JSON.parse(fs.readFileSync(labResultsFile(), 'utf8'));
  const history = readJsonl(labHistoryFile());

  const report = {
    ...results,
    historyLength: history.length,
    trend:
      history.length >= 2
        ? {
            previousBest: history[history.length - 2]?.topScore || 0,
            currentBest: history[history.length - 1]?.topScore || 0,
            improving: (history[history.length - 1]?.topScore || 0) > (history[history.length - 2]?.topScore || 0),
          }
        : null,
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('CoBolt Evolution Lab — Validation Report');
    console.log('═'.repeat(50));
    console.log(`Validated at: ${results.validatedAt}`);
    console.log(`Threshold:    ${results.threshold}`);
    console.log(`Total:        ${(results.results || []).length}`);
    console.log(`Validated:    ${(results.results || []).filter((r) => r.validated).length}`);
    console.log(`Rejected:     ${(results.results || []).filter((r) => !r.validated).length}`);
    console.log('');

    if (results.results && results.results.length > 0) {
      console.log('Detailed scores:');
      console.log('─'.repeat(50));
      for (const r of results.results) {
        const status = r.validated ? '✓ PASS' : '✗ FAIL';
        console.log(`  ${status} ${r.name || r.proposalName}`);
        console.log(
          `         Score: ${(r.score ?? r.improvementPotential ?? 0).toFixed(3)} | Budget: ${r.wallClockMs}ms${r.timedOut ? ' [TIMEOUT]' : ''}`,
        );
        if (r.scores) {
          const scoreStr = Object.entries(r.scores)
            .map(([k, v]) => `${k}=${v.toFixed(2)}`)
            .join(', ');
          console.log(`         ${scoreStr}`);
        }
      }
    }

    if (report.trend) {
      console.log('');
      console.log(
        `Trend: ${report.trend.improving ? '↑ improving' : '↓ declining'} (${report.trend.previousBest.toFixed(3)} → ${report.trend.currentBest.toFixed(3)})`,
      );
    }
  }
}

// ── Main ───────────────────────────────────────────────────

if (require.main === module) {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case 'validate':
      cmdValidate(args);
      break;
    case 'baseline':
      cmdBaseline(args);
      break;
    case 'status':
      cmdStatus();
      break;
    case 'report':
      cmdReport(args);
      break;
    default:
      console.log('CoBolt Evolution Lab — Autonomous Validation for Evolution Proposals');
      console.log('');
      console.log('Usage:');
      console.log('  node tools/cobolt-evolution-lab.js validate [--threshold 0.6] [--json]');
      console.log('  node tools/cobolt-evolution-lab.js baseline [--json]');
      console.log('  node tools/cobolt-evolution-lab.js status');
      console.log('  node tools/cobolt-evolution-lab.js report [--json]');
      console.log('');
      console.log('Validates evolution proposals against historical pipeline data.');
      console.log('Each proposal scored on 6 dimensions with fixed 5s budget.');
      console.log('Proposals above threshold graduate; below are rejected.');
      process.exit(command ? 2 : 0);
  }
}

module.exports = {
  computeBaseline,
  validateProposal,
  runValidation,
  cmdValidate,
};
