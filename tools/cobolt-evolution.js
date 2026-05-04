#!/usr/bin/env node

// CoBolt Evolution Engine — Self-evolving pipeline intelligence
//
// Extracts lessons from pipeline failures, diagnoses recurring patterns,
// proposes targeted skill mutations, quality-gates them, and materializes
// passing proposals as SKILL.md files for future runs.
//
// Architecture: 5-step deterministic cycle (no LLM required):
//   1. Extract  — Scan run artifacts for failures, classify by category
//   2. Diagnose — Pattern-match against known failure archetypes
//   3. Propose  — Generate skill/rule proposals from recurring patterns
//   4. Gate     — Validate proposals (specificity, actionability, non-contradiction)
//   5. Materialize — Write passing proposals as SKILL.md or rules
//
// Usage:
//   node tools/cobolt-evolution.js extract [--run-dir <path>]        # Extract lessons from run
//   node tools/cobolt-evolution.js diagnose [--run-dir <path>]       # Diagnose failure patterns
//   node tools/cobolt-evolution.js propose [--run-dir <path>]        # Propose skill mutations
//   node tools/cobolt-evolution.js materialize [--run-dir <path>]    # Gate + write passing proposals
//   node tools/cobolt-evolution.js cycle [--run-dir <path>]          # Full extract→materialize cycle
//   node tools/cobolt-evolution.js history [--limit 20]              # Show evolution history
//   node tools/cobolt-evolution.js status                            # Current evolution state
//   node tools/cobolt-evolution.js prune [--max-age 90]              # Remove expired lessons
//
// Exit codes:
//   0 = success
//   1 = no lessons/proposals
//   2 = usage error

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWrite: sharedAtomicWrite } = require('../lib/cobolt-atomic-write');
// ── Path Resolution ────────────────────────────────────────

let _paths = null;
try {
  _paths = require('../lib/cobolt-paths').paths;
} catch {
  /* standalone */
}

function outputDir() {
  return path.join(process.cwd(), '_cobolt-output');
}

function evolutionDir() {
  return path.join(outputDir(), 'evolution');
}

function lessonsFile() {
  return path.join(evolutionDir(), 'lessons.jsonl');
}

function proposalsFile() {
  return path.join(evolutionDir(), 'proposals.json');
}

function historyFile() {
  return path.join(evolutionDir(), 'evolution-history.jsonl');
}

function learnedSkillsDir() {
  return path.join(evolutionDir(), 'learned-skills');
}

function latestRunDir() {
  const _p = typeof _paths === 'function' ? _paths() : null;
  if (_p) {
    try {
      return _p.latestRunDir();
    } catch {
      /* fall through */
    }
  }
  return path.join(outputDir(), 'latest');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function atomicWrite(filePath, data) {
  // Delegates to the shared helper; preserves the "string or object" input
  // contract used throughout this module.
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  sharedAtomicWrite(filePath, content, { mode: 0o600 });
}

function appendJsonl(filePath, entry) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
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
}

// ── Lesson Categories ──────────────────────────────────────

const LESSON_CATEGORIES = {
  BUILD_FAILURE: 'build-failure',
  TEST_FAILURE: 'test-failure',
  REVIEW_REJECTION: 'review-rejection',
  FIX_STALL: 'fix-stall',
  DEPLOY_FAILURE: 'deploy-failure',
  GATE_BLOCK: 'gate-block',
  TIMEOUT: 'timeout',
  PERMISSION: 'permission',
  DEPENDENCY: 'dependency',
  CONFIGURATION: 'configuration',
  ARCHITECTURE: 'architecture',
  SECURITY: 'security',
  PERFORMANCE: 'performance',
  UNKNOWN: 'unknown',
};

const _SEVERITY_LEVELS = ['critical', 'high', 'medium', 'low', 'info'];

// ── Failure Pattern Matchers ───────────────────────────────

const FAILURE_PATTERNS = [
  {
    pattern: /compile|syntax|parse error|unexpected token/i,
    category: LESSON_CATEGORIES.BUILD_FAILURE,
    severity: 'high',
  },
  { pattern: /test fail|assertion|expect.*(?:to|not)/i, category: LESSON_CATEGORIES.TEST_FAILURE, severity: 'high' },
  {
    pattern: /phantom|false.?positive|reject.*finding/i,
    category: LESSON_CATEGORIES.REVIEW_REJECTION,
    severity: 'medium',
  },
  {
    pattern: /stall.*detect|same.*finding.*3.*iter|carry.?forward/i,
    category: LESSON_CATEGORIES.FIX_STALL,
    severity: 'high',
  },
  {
    pattern: /deploy|rollback|container|health.?check.*fail/i,
    category: LESSON_CATEGORIES.DEPLOY_FAILURE,
    severity: 'critical',
  },
  {
    pattern: /gate.*block|tier.*1|hard.*block|planning.*gate/i,
    category: LESSON_CATEGORIES.GATE_BLOCK,
    severity: 'medium',
  },
  { pattern: /timeout|timed?\s*out|deadline|exceeded/i, category: LESSON_CATEGORIES.TIMEOUT, severity: 'medium' },
  {
    pattern: /permission|denied|EACCES|forbidden|unauthorized/i,
    category: LESSON_CATEGORIES.PERMISSION,
    severity: 'high',
  },
  {
    pattern: /dependency|module not found|cannot find|npm.*err|package/i,
    category: LESSON_CATEGORIES.DEPENDENCY,
    severity: 'high',
  },
  {
    pattern: /config|env|\.env|missing.*key|invalid.*setting/i,
    category: LESSON_CATEGORIES.CONFIGURATION,
    severity: 'medium',
  },
  {
    pattern: /circular|coupling|layer.*violation|boundary/i,
    category: LESSON_CATEGORIES.ARCHITECTURE,
    severity: 'medium',
  },
  {
    pattern: /vulnerab|injection|XSS|CSRF|secret|credential/i,
    category: LESSON_CATEGORIES.SECURITY,
    severity: 'critical',
  },
  {
    pattern: /slow|latency|memory.*leak|OOM|performance/i,
    category: LESSON_CATEGORIES.PERFORMANCE,
    severity: 'medium',
  },
];

function classifyFailure(text) {
  for (const { pattern, category, severity } of FAILURE_PATTERNS) {
    if (pattern.test(text)) return { category, severity };
  }
  return { category: LESSON_CATEGORIES.UNKNOWN, severity: 'low' };
}

// ── Time Decay ─────────────────────────────────────────────

const HALF_LIFE_DAYS = 30;
const MAX_AGE_DAYS = 90;

function timeDecayWeight(createdAt) {
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays < 0) return 1.0;
  if (ageDays > MAX_AGE_DAYS) return 0.0;
  return Math.exp((-ageDays * Math.LN2) / HALF_LIFE_DAYS);
}

// ── Step 1: Extract Lessons ────────────────────────────────

function extractLessons(runDir) {
  const lessons = [];
  const runPath = runDir || latestRunDir();

  if (!fs.existsSync(runPath)) return lessons;

  // Scan stage subdirs for failure artifacts
  const stageDirs = ['build', 'review', 'fix', 'deploy', 'pentest', 'planning'];
  for (const stage of stageDirs) {
    const stageDir = path.join(runPath, stage);
    if (!fs.existsSync(stageDir)) continue;

    // Scan for finding trackers
    scanFindings(stageDir, stage, lessons);

    // Scan for error logs and failure markers
    scanErrorArtifacts(stageDir, stage, lessons);
  }

  // Scan escalation log
  scanEscalationLog(lessons);

  // Scan gate skip log
  scanGateSkipLog(lessons);

  // Scan fix verdicts
  scanFixVerdicts(runPath, lessons);

  // Deduplicate by content hash
  const seen = new Set();
  const unique = [];
  for (const lesson of lessons) {
    const hash = crypto.createHash('sha256').update(lesson.description).digest('hex').slice(0, 12);
    if (!seen.has(hash)) {
      seen.add(hash);
      lesson.id = `L-${hash}`;
      unique.push(lesson);
    }
  }

  return unique;
}

function scanFindings(stageDir, stage, lessons) {
  const trackerPath = path.join(stageDir, 'finding-tracker.json');
  if (!fs.existsSync(trackerPath)) return;

  try {
    const tracker = JSON.parse(fs.readFileSync(trackerPath, 'utf8'));
    const findings = tracker.findings || [];

    // Extract lessons from carry-forward and unresolved findings
    const unresolved = findings.filter((f) => ['open', 'carry-forward'].includes(f.status));
    if (unresolved.length > 0) {
      const { category, severity } = classifyFailure(unresolved.map((f) => f.message || '').join(' '));
      lessons.push({
        stage,
        category,
        severity,
        description: `${unresolved.length} unresolved findings in ${stage}: ${unresolved
          .slice(0, 3)
          .map((f) => f.message || f.id)
          .join('; ')}`,
        source: 'finding-tracker',
        metadata: { findingCount: unresolved.length, findingIds: unresolved.map((f) => f.id) },
        createdAt: new Date().toISOString(),
      });
    }

    // Extract per-severity patterns
    const bySeverity = {};
    for (const f of unresolved) {
      const sev = f.severity || 'medium';
      if (!bySeverity[sev]) bySeverity[sev] = [];
      bySeverity[sev].push(f);
    }
    for (const [sev, group] of Object.entries(bySeverity)) {
      if (group.length >= 3) {
        lessons.push({
          stage,
          category: classifyFailure(group.map((f) => f.message || '').join(' ')).category,
          severity: sev,
          description: `Recurring ${sev} pattern in ${stage}: ${group.length} findings of same severity — ${group[0].message || 'unspecified'}`,
          source: 'finding-cluster',
          metadata: { clusterSize: group.length },
          createdAt: new Date().toISOString(),
        });
      }
    }
  } catch {
    /* skip corrupt tracker */
  }
}

function scanErrorArtifacts(stageDir, stage, lessons) {
  try {
    const files = fs.readdirSync(stageDir);
    for (const file of files) {
      if (!/error|failure|crash|rca/i.test(file)) continue;
      if (!/\.json$|\.md$/.test(file)) continue;

      const fp = path.join(stageDir, file);
      try {
        const content = fs.readFileSync(fp, 'utf8').slice(0, 2000);
        const { category, severity } = classifyFailure(content);
        lessons.push({
          stage,
          category,
          severity,
          description: `Error artifact in ${stage}/${file}: ${content.slice(0, 200).replace(/\n/g, ' ')}`,
          source: `artifact:${file}`,
          metadata: { file },
          createdAt: new Date().toISOString(),
        });
      } catch {
        /* skip unreadable */
      }
    }
  } catch {
    /* skip unreadable dir */
  }
}

function scanEscalationLog(lessons) {
  const logPath = path.join(outputDir(), 'audit/escalation-log.jsonl');
  if (!fs.existsSync(logPath)) return;

  const entries = readJsonl(logPath);
  // Group by failed agent
  const byAgent = {};
  for (const e of entries) {
    const agent = e.failedAgent || 'unknown';
    if (!byAgent[agent]) byAgent[agent] = [];
    byAgent[agent].push(e);
  }

  for (const [agent, events] of Object.entries(byAgent)) {
    if (events.length >= 2) {
      const lastEvent = events[events.length - 1];
      const { category } = classifyFailure(lastEvent.description || lastEvent.failureSignal || '');
      lessons.push({
        stage: lastEvent.stage || 'unknown',
        category,
        severity: events.length >= 3 ? 'high' : 'medium',
        description: `Agent "${agent}" escalated ${events.length} times. Last: ${lastEvent.description || lastEvent.failureSignal || 'unknown'}`,
        source: 'escalation-log',
        metadata: { agent, escalationCount: events.length, lastSignal: lastEvent.failureSignal },
        createdAt: new Date().toISOString(),
      });
    }
  }
}

function scanGateSkipLog(lessons) {
  const logPath = path.join(outputDir(), 'audit/gate-skip-log.jsonl');
  if (!fs.existsSync(logPath)) return;

  const entries = readJsonl(logPath);
  const byGate = {};
  for (const e of entries) {
    const gate = e.gate || e.hook || 'unknown';
    if (!byGate[gate]) byGate[gate] = [];
    byGate[gate].push(e);
  }

  for (const [gate, events] of Object.entries(byGate)) {
    if (events.length >= 2) {
      lessons.push({
        stage: events[0].stage || 'unknown',
        category: LESSON_CATEGORIES.GATE_BLOCK,
        severity: 'medium',
        description: `Gate "${gate}" triggered ${events.length} times across runs. Pattern: ${events[0].reason || 'unknown'}`,
        source: 'gate-skip-log',
        metadata: { gate, triggerCount: events.length },
        createdAt: new Date().toISOString(),
      });
    }
  }
}

function scanFixVerdicts(runPath, lessons) {
  const fixDir = path.join(runPath, 'fix');
  if (!fs.existsSync(fixDir)) return;

  try {
    const files = fs.readdirSync(fixDir).filter((f) => /fix-verdict.*\.json$/.test(f));
    for (const file of files) {
      try {
        const verdict = JSON.parse(fs.readFileSync(path.join(fixDir, file), 'utf8'));
        if (verdict.verdict === 'EXIT_ESCALATE') {
          lessons.push({
            stage: 'fix',
            category: verdict.stallDetected ? LESSON_CATEGORIES.FIX_STALL : LESSON_CATEGORIES.BUILD_FAILURE,
            severity: 'high',
            description: `Fix loop escalated at iteration ${verdict.iteration}: ${verdict.reason}. ${verdict.counts?.actionable || 0} unresolved findings.`,
            source: `fix-verdict:${file}`,
            metadata: { verdict: verdict.verdict, iteration: verdict.iteration, counts: verdict.counts },
            createdAt: verdict.timestamp || new Date().toISOString(),
          });
        }
      } catch {
        /* skip corrupt verdict */
      }
    }
  } catch {
    /* skip */
  }
}

// ── Step 2: Diagnose Patterns ──────────────────────────────

const FAILURE_ARCHETYPES = [
  {
    id: 'ARCH-001',
    name: 'Recurring Test Failures',
    match: (lessons) => lessons.filter((l) => l.category === LESSON_CATEGORIES.TEST_FAILURE).length >= 2,
    diagnosis:
      'Tests consistently fail — likely missing test infrastructure, incorrect test setup, or flawed TDD implementation.',
    suggestedAction: 'Add pre-build test environment validation step',
  },
  {
    id: 'ARCH-002',
    name: 'Fix Loop Stalls',
    match: (lessons) => lessons.filter((l) => l.category === LESSON_CATEGORIES.FIX_STALL).length >= 1,
    diagnosis: 'Fix loop stalls on same findings — agent may lack context or finding descriptions are ambiguous.',
    suggestedAction:
      'Improve finding descriptions with file paths and expected behavior, add stall-breaking heuristics',
  },
  {
    id: 'ARCH-003',
    name: 'Phantom Reviewer Pattern',
    match: (lessons) => lessons.filter((l) => l.category === LESSON_CATEGORIES.REVIEW_REJECTION).length >= 2,
    diagnosis: 'High phantom/false-positive rate — reviewer prompts may be too aggressive or lack codebase context.',
    suggestedAction: 'Calibrate reviewer agents with project-specific conventions and previous verified findings',
  },
  {
    id: 'ARCH-004',
    name: 'Dependency Resolution Failures',
    match: (lessons) => lessons.filter((l) => l.category === LESSON_CATEGORIES.DEPENDENCY).length >= 2,
    diagnosis:
      'Repeated dependency issues — lockfile not committed, incorrect versions, or missing system dependencies.',
    suggestedAction: 'Add dependency validation step before build, verify lockfile exists and is current',
  },
  {
    id: 'ARCH-005',
    name: 'Deploy Environment Mismatch',
    match: (lessons) => lessons.filter((l) => l.category === LESSON_CATEGORIES.DEPLOY_FAILURE).length >= 1,
    diagnosis: 'Deploy failures suggest environment mismatch between build and deploy targets.',
    suggestedAction: 'Add deploy-readiness pre-check with environment variable validation',
  },
  {
    id: 'ARCH-006',
    name: 'Security Finding Cluster',
    match: (lessons) => lessons.filter((l) => l.category === LESSON_CATEGORIES.SECURITY).length >= 2,
    diagnosis: 'Multiple security findings — likely systemic issue with input validation or auth patterns.',
    suggestedAction: 'Add security baseline checklist to build step, enforce input validation patterns',
  },
  {
    id: 'ARCH-007',
    name: 'Permission Cascades',
    match: (lessons) => lessons.filter((l) => l.category === LESSON_CATEGORIES.PERMISSION).length >= 2,
    diagnosis: 'Repeated permission errors — file permissions, API auth, or Docker access issues.',
    suggestedAction: 'Add permission pre-flight check before stage execution',
  },
  {
    id: 'ARCH-008',
    name: 'Configuration Drift',
    match: (lessons) => lessons.filter((l) => l.category === LESSON_CATEGORIES.CONFIGURATION).length >= 2,
    diagnosis: 'Configuration errors recurring — env vars missing or config files out of sync.',
    suggestedAction: 'Validate all required config before stage execution, add .env.cobolt completeness check',
  },
  {
    id: 'ARCH-009',
    name: 'Agent Escalation Cascade',
    match: (lessons) =>
      lessons.filter((l) => l.source === 'escalation-log' && (l.metadata?.escalationCount || 0) >= 3).length >= 1,
    diagnosis:
      'Agent repeatedly fails and escalates — may need different agent, different approach, or human intervention.',
    suggestedAction: 'Add agent effectiveness check before dispatch, prefer agents with higher success rates',
  },
  {
    id: 'ARCH-010',
    name: 'Gate Fatigue',
    match: (lessons) => lessons.filter((l) => l.category === LESSON_CATEGORIES.GATE_BLOCK).length >= 3,
    diagnosis: 'Multiple gates triggering frequently — artifacts may be consistently below quality thresholds.',
    suggestedAction: 'Add quality pre-check before gate-triggering stages, identify root cause of low quality',
  },
];

function diagnosePatterns(lessons) {
  const diagnoses = [];
  for (const archetype of FAILURE_ARCHETYPES) {
    if (archetype.match(lessons)) {
      const matchingLessons = lessons.filter((l) => {
        // Re-run the category check for each archetype
        for (const { pattern, category } of FAILURE_PATTERNS) {
          if (pattern.test(l.description) || l.category === category) {
            return true;
          }
        }
        return false;
      });

      diagnoses.push({
        archetypeId: archetype.id,
        name: archetype.name,
        diagnosis: archetype.diagnosis,
        suggestedAction: archetype.suggestedAction,
        matchingLessonCount: matchingLessons.length,
        lessonIds: matchingLessons.slice(0, 5).map((l) => l.id),
        confidence: Math.min(1.0, 0.4 + matchingLessons.length * 0.15),
        timestamp: new Date().toISOString(),
      });
    }
  }

  return diagnoses.sort((a, b) => b.confidence - a.confidence);
}

// ── Step 3: Propose Mutations ──────────────────────────────

const PROPOSAL_TYPES = {
  SKILL: 'skill', // New SKILL.md for learned-skills/
  RULE: 'rule', // Rule for project rules file
  PROMPT_PATCH: 'prompt-patch', // Addendum to stage prompts
};

function proposeFromDiagnoses(diagnoses, existingSkills) {
  const proposals = [];
  const existingNames = new Set(existingSkills.map((s) => s.name || s));

  for (const diag of diagnoses) {
    if (diag.confidence < 0.5) continue; // Skip low-confidence diagnoses

    const skillName = `evo-${diag.archetypeId.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;

    // Skip if skill already exists
    if (existingNames.has(skillName)) continue;

    const proposal = {
      id: `P-${crypto
        .createHash('sha256')
        .update(skillName + diag.name)
        .digest('hex')
        .slice(0, 8)}`,
      type: PROPOSAL_TYPES.SKILL,
      name: skillName,
      description: diag.suggestedAction,
      body: generateSkillBody(diag),
      sourceArchetype: diag.archetypeId,
      sourceDiagnosis: diag.name,
      confidence: diag.confidence,
      createdAt: new Date().toISOString(),
      gateResult: null,
    };

    proposals.push(proposal);
  }

  return proposals;
}

function generateSkillBody(diagnosis) {
  return [
    `## Problem Pattern`,
    ``,
    `**${diagnosis.name}**: ${diagnosis.diagnosis}`,
    ``,
    `## Corrective Action`,
    ``,
    diagnosis.suggestedAction,
    ``,
    `## When to Apply`,
    ``,
    `Apply this skill when the pipeline encounters the "${diagnosis.name}" pattern.`,
    `This was learned from ${diagnosis.matchingLessonCount} failure(s) with ${(diagnosis.confidence * 100).toFixed(0)}% confidence.`,
    ``,
    `## Evidence`,
    ``,
    `- Archetype: ${diagnosis.archetypeId}`,
    `- Matching lessons: ${diagnosis.lessonIds.join(', ')}`,
    `- First detected: ${diagnosis.timestamp}`,
  ].join('\n');
}

// ── Step 4: Quality Gate ───────────────────────────────────

const GATE_CHECKS = [
  {
    name: 'specificity',
    check: (p) => p.description.length >= 20 && !/generic|general|improve/i.test(p.description),
    reason: 'Proposal must be specific and actionable, not generic',
  },
  {
    name: 'actionability',
    check: (p) => /add|validate|check|enforce|require|prevent|ensure/i.test(p.description),
    reason: 'Proposal must describe a concrete action',
  },
  {
    name: 'confidence',
    check: (p) => p.confidence >= 0.55,
    reason: 'Proposal confidence must be at least 55%',
  },
  {
    name: 'non-duplicate',
    check: (p, existing) => !existing.some((e) => e.sourceArchetype === p.sourceArchetype),
    reason: 'Proposal must not duplicate an existing learned skill',
  },
  {
    name: 'body-quality',
    check: (p) => p.body && p.body.length >= 100,
    reason: 'Skill body must be substantive (100+ chars)',
  },
];

function gateProposals(proposals, existingProposals) {
  const results = [];

  for (const proposal of proposals) {
    const checks = GATE_CHECKS.map((gate) => ({
      name: gate.name,
      passed: gate.check(proposal, existingProposals || []),
      reason: gate.reason,
    }));

    const allPassed = checks.every((c) => c.passed);
    proposal.gateResult = {
      passed: allPassed,
      checks,
      gatedAt: new Date().toISOString(),
    };

    results.push(proposal);
  }

  return results;
}

// ── Step 5: Materialize ────────────────────────────────────

function materializeProposals(proposals) {
  const materialized = [];
  const skillsDir = learnedSkillsDir();

  for (const proposal of proposals) {
    if (!proposal.gateResult?.passed) continue;

    if (proposal.type === PROPOSAL_TYPES.SKILL) {
      const skillDir = path.join(skillsDir, proposal.name);
      ensureDir(skillDir);

      const skillContent = [
        `---`,
        `name: ${proposal.name}`,
        `description: "${proposal.description.replace(/"/g, '\\"')}"`,
        `metadata:`,
        `  category: evolved`,
        `  source: cobolt-evolution`,
        `  archetype: ${proposal.sourceArchetype}`,
        `  confidence: ${proposal.confidence.toFixed(2)}`,
        `  generated-at: ${proposal.createdAt}`,
        `enabled: true`,
        `---`,
        ``,
        proposal.body,
      ].join('\n');

      atomicWrite(path.join(skillDir, 'SKILL.md'), skillContent);
      materialized.push({
        type: 'skill',
        name: proposal.name,
        path: path.join(skillDir, 'SKILL.md'),
      });
    }
  }

  return materialized;
}

// ── Full Cycle ─────────────────────────────────────────────

function runCycle(runDir) {
  // Step 1: Extract
  const lessons = extractLessons(runDir);
  if (lessons.length === 0) {
    return { lessons: 0, diagnoses: 0, proposals: 0, materialized: 0, message: 'No lessons found' };
  }

  // Persist lessons
  for (const lesson of lessons) {
    appendJsonl(lessonsFile(), lesson);
  }

  // Load all lessons (including historical with time-decay)
  const allLessons = readJsonl(lessonsFile())
    .filter((l) => timeDecayWeight(l.createdAt) > 0.05)
    .map((l) => ({ ...l, weight: timeDecayWeight(l.createdAt) }))
    .sort((a, b) => b.weight - a.weight);

  // Step 2: Diagnose
  const diagnoses = diagnosePatterns(allLessons);
  if (diagnoses.length === 0) {
    return { lessons: lessons.length, diagnoses: 0, proposals: 0, materialized: 0, message: 'No patterns detected' };
  }

  // Step 3: Propose
  const existingSkills = loadExistingLearnedSkills();
  const proposals = proposeFromDiagnoses(diagnoses, existingSkills);

  // Step 4: Gate
  const gatedProposals = gateProposals(proposals, existingSkills);

  // Step 5: Materialize
  const materialized = materializeProposals(gatedProposals);

  // Log to history
  const historyEntry = {
    timestamp: new Date().toISOString(),
    lessonsExtracted: lessons.length,
    totalLessonsActive: allLessons.length,
    diagnosesFound: diagnoses.length,
    proposalsMade: proposals.length,
    proposalsPassed: gatedProposals.filter((p) => p.gateResult?.passed).length,
    proposalsRejected: gatedProposals.filter((p) => !p.gateResult?.passed).length,
    materialized: materialized.map((m) => m.name),
    generatedBy: 'cobolt-evolution',
  };
  appendJsonl(historyFile(), historyEntry);

  // Persist proposals
  atomicWrite(proposalsFile(), {
    proposals: gatedProposals,
    lastUpdated: new Date().toISOString(),
  });

  return {
    lessons: lessons.length,
    totalActive: allLessons.length,
    diagnoses: diagnoses.length,
    proposals: proposals.length,
    passed: gatedProposals.filter((p) => p.gateResult?.passed).length,
    rejected: gatedProposals.filter((p) => !p.gateResult?.passed).length,
    materialized: materialized.length,
    skills: materialized.map((m) => m.name),
    diagnosisNames: diagnoses.map((d) => d.name),
    message:
      materialized.length > 0
        ? `Evolved ${materialized.length} new skill(s): ${materialized.map((m) => m.name).join(', ')}`
        : diagnoses.length > 0
          ? `${diagnoses.length} pattern(s) detected but no new skills needed`
          : 'No actionable patterns found',
  };
}

function loadExistingLearnedSkills() {
  const dir = learnedSkillsDir();
  if (!fs.existsSync(dir)) return [];

  const skills = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      const skillFile = path.join(dir, name, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        skills.push({ name, path: skillFile });
      }
    }
  } catch {
    /* empty */
  }
  return skills;
}

// ── Prune ──────────────────────────────────────────────────

function pruneLessons(maxAgeDays) {
  const maxAge = maxAgeDays || MAX_AGE_DAYS;
  const lessons = readJsonl(lessonsFile());
  const now = Date.now();
  const kept = lessons.filter((l) => {
    const ageDays = (now - new Date(l.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    return ageDays <= maxAge;
  });

  const pruned = lessons.length - kept.length;
  if (pruned > 0) {
    atomicWrite(lessonsFile(), `${kept.map((l) => JSON.stringify(l)).join('\n')}\n`);
  }
  return { total: lessons.length, kept: kept.length, pruned };
}

// ── CLI ────────────────────────────────────────────────────

function parseRunDir(args) {
  const idx = args.indexOf('--run-dir');
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

function cmdExtract(args) {
  const runDir = parseRunDir(args);
  const lessons = extractLessons(runDir);

  if (args.includes('--json')) {
    console.log(JSON.stringify({ lessons, count: lessons.length, timestamp: new Date().toISOString() }, null, 2));
  } else {
    console.log(`[cobolt-evolution] Extracted ${lessons.length} lesson(s)`);
    for (const l of lessons.slice(0, 10)) {
      console.log(`  [${l.severity}] ${l.category}: ${l.description.slice(0, 120)}`);
    }
    if (lessons.length > 10) console.log(`  ... and ${lessons.length - 10} more`);
  }

  // Persist
  for (const lesson of lessons) appendJsonl(lessonsFile(), lesson);
  process.exit(lessons.length > 0 ? 0 : 1);
}

function cmdDiagnose(args) {
  const runDir = parseRunDir(args);
  const lessons = extractLessons(runDir);
  const allLessons = [...readJsonl(lessonsFile()), ...lessons].filter((l) => timeDecayWeight(l.createdAt) > 0.05);

  const diagnoses = diagnosePatterns(allLessons);

  if (args.includes('--json')) {
    console.log(JSON.stringify({ diagnoses, lessonCount: allLessons.length }, null, 2));
  } else {
    console.log(`[cobolt-evolution] ${diagnoses.length} pattern(s) from ${allLessons.length} lesson(s)`);
    for (const d of diagnoses) {
      console.log(`  [${d.archetypeId}] ${d.name} (${(d.confidence * 100).toFixed(0)}%): ${d.diagnosis.slice(0, 100)}`);
    }
  }
  process.exit(diagnoses.length > 0 ? 0 : 1);
}

function cmdPropose(args) {
  const runDir = parseRunDir(args);
  const lessons = extractLessons(runDir);
  const allLessons = [...readJsonl(lessonsFile()), ...lessons].filter((l) => timeDecayWeight(l.createdAt) > 0.05);

  const diagnoses = diagnosePatterns(allLessons);
  const existing = loadExistingLearnedSkills();
  const proposals = proposeFromDiagnoses(diagnoses, existing);

  if (args.includes('--json')) {
    console.log(JSON.stringify({ proposals, count: proposals.length }, null, 2));
  } else {
    console.log(`[cobolt-evolution] ${proposals.length} proposal(s)`);
    for (const p of proposals) {
      console.log(`  [${p.id}] ${p.name}: ${p.description.slice(0, 100)} (${(p.confidence * 100).toFixed(0)}%)`);
    }
  }
  process.exit(proposals.length > 0 ? 0 : 1);
}

function cmdMaterialize(args) {
  const runDir = parseRunDir(args);
  const result = runCycle(runDir);

  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[cobolt-evolution] ${result.message}`);
    console.log(`  Lessons: ${result.lessons} extracted, ${result.totalActive || 0} active`);
    console.log(`  Diagnoses: ${result.diagnoses}`);
    console.log(
      `  Proposals: ${result.proposals || 0} made, ${result.passed || 0} passed, ${result.rejected || 0} rejected`,
    );
    console.log(`  Materialized: ${result.materialized}`);
    if (result.skills?.length > 0) {
      console.log(`  New skills: ${result.skills.join(', ')}`);
    }
  }
  process.exit(result.materialized > 0 ? 0 : 1);
}

function cmdHistory(args) {
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) || 20 : 20;

  const history = readJsonl(historyFile()).slice(-limit);
  if (args.includes('--json')) {
    console.log(JSON.stringify(history, null, 2));
  } else {
    console.log(`[cobolt-evolution] Last ${history.length} evolution cycle(s)`);
    for (const h of history) {
      console.log(
        `  ${h.timestamp}: ${h.lessonsExtracted} lessons → ${h.diagnosesFound} diagnoses → ${h.materialized?.length || 0} skills`,
      );
    }
  }
  process.exit(0);
}

function cmdStatus() {
  const lessons = readJsonl(lessonsFile());
  const active = lessons.filter((l) => timeDecayWeight(l.createdAt) > 0.05);
  const skills = loadExistingLearnedSkills();
  const history = readJsonl(historyFile());

  const status = {
    totalLessons: lessons.length,
    activeLessons: active.length,
    expiredLessons: lessons.length - active.length,
    learnedSkills: skills.length,
    skillNames: skills.map((s) => s.name),
    evolutionCycles: history.length,
    lastCycle: history.length > 0 ? history[history.length - 1].timestamp : null,
    halfLifeDays: HALF_LIFE_DAYS,
    maxAgeDays: MAX_AGE_DAYS,
  };

  console.log(JSON.stringify(status, null, 2));
  process.exit(0);
}

function cmdPrune(args) {
  const ageIdx = args.indexOf('--max-age');
  const maxAge = ageIdx !== -1 ? parseInt(args[ageIdx + 1], 10) : MAX_AGE_DAYS;
  const result = pruneLessons(maxAge);

  console.log(`[cobolt-evolution] Pruned ${result.pruned} expired lesson(s) (kept ${result.kept}/${result.total})`);
  process.exit(0);
}

// ── Main ───────────────────────────────────────────────────

if (require.main === module) {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case 'extract':
      cmdExtract(args);
      break;
    case 'diagnose':
      cmdDiagnose(args);
      break;
    case 'propose':
      cmdPropose(args);
      break;
    case 'materialize':
      cmdMaterialize(args);
      break;
    case 'cycle':
      cmdMaterialize(args);
      break; // alias
    case 'history':
      cmdHistory(args);
      break;
    case 'status':
      cmdStatus();
      break;
    case 'prune':
      cmdPrune(args);
      break;
    case 'validate':
      // Delegate to evolution lab — full table output, consistent with direct lab invocation
      try {
        const lab = require('./cobolt-evolution-lab');
        lab.cmdValidate(args);
      } catch (e) {
        console.error(`Evolution lab not available: ${e.message}`);
        process.exit(2);
      }
      break;
    default:
      console.log('CoBolt Evolution Engine — Self-evolving pipeline intelligence');
      console.log('');
      console.log('Usage:');
      console.log('  node tools/cobolt-evolution.js extract [--run-dir <path>] [--json]');
      console.log('  node tools/cobolt-evolution.js diagnose [--run-dir <path>] [--json]');
      console.log('  node tools/cobolt-evolution.js propose [--run-dir <path>] [--json]');
      console.log('  node tools/cobolt-evolution.js materialize [--run-dir <path>] [--json]');
      console.log('  node tools/cobolt-evolution.js cycle [--run-dir <path>] [--json]');
      console.log('  node tools/cobolt-evolution.js history [--limit 20] [--json]');
      console.log('  node tools/cobolt-evolution.js status');
      console.log('  node tools/cobolt-evolution.js prune [--max-age 90]');
      console.log('  node tools/cobolt-evolution.js validate [--threshold 0.6] [--json]');
      console.log('');
      console.log('6-step cycle: extract → diagnose → propose → gate → materialize → validate');
      process.exit(command ? 2 : 0);
  }
}

module.exports = {
  extractLessons,
  diagnosePatterns,
  proposeFromDiagnoses,
  gateProposals,
  materializeProposals,
  runCycle,
  pruneLessons,
  timeDecayWeight,
  classifyFailure,
  LESSON_CATEGORIES,
  FAILURE_ARCHETYPES,
};
