#!/usr/bin/env node

// CoBolt Evidence Impact Scoring — advisory-only per
// docs/cobolt-context-routing-plan.md Companion Improvement #1.
//
// Scores requirements, findings, failed checks, and carry-forward items with
// a deterministic 0–100 score combining:
//   - target priority (critical/high/medium/low)
//   - milestone criticality (current/future/past)
//   - user-facing surface area (linked stories)
//   - security/data-loss/deployment/compliance category
//   - linked stories, files, tests, findings
//   - recent failure count
//   - gate-blocking status
//   - repeat appearances across runs
//
// Advisory only: does NOT reorder any existing queue. Output is optional
// decoration for context route cells and a rollup at
// _cobolt-output/audit/evidence-impact.jsonl. Missing inputs reduce
// confidence but never crash the pipeline (plan acceptance criterion).
//
// Usage:
//   node tools/cobolt-evidence-impact.js score --kind requirement --id FR-001 [--json]
//   node tools/cobolt-evidence-impact.js score --kind finding --id SEC-001 [--write]
//   node tools/cobolt-evidence-impact.js rollup [--json]

const fs = require('node:fs');
const path = require('node:path');

const IMPACT_SCHEMA_VERSION = '1.0.0';

function safeRequire(modulePath) {
  try {
    return require(modulePath);
  } catch {
    return null;
  }
}
const pathsMod = safeRequire('../lib/cobolt-paths');

function latestDir(projectRoot) {
  const root = path.resolve(projectRoot);
  if (typeof pathsMod === 'function') {
    try {
      const p = pathsMod(root);
      if (p?.latestOutputDir) return p.latestOutputDir();
    } catch {
      /* fall through */
    }
  }
  return path.join(root, '_cobolt-output', 'latest');
}

function auditPath(projectRoot) {
  const root = path.resolve(projectRoot);
  return path.join(root, '_cobolt-output', 'audit', 'evidence-impact.jsonl');
}

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// ── Signal weights ─────────────────────────────────────────

const WEIGHTS = {
  priorityCritical: 25,
  priorityHigh: 18,
  priorityMedium: 10,
  priorityLow: 4,
  currentMilestone: 10,
  futureMilestone: 4,
  gateBlocking: 20,
  securityCategory: 12,
  dataLossCategory: 15,
  deploymentCategory: 8,
  complianceCategory: 10,
  userFacing: 6,
  linkedStoriesPer: 2, // up to 10
  linkedFilesPer: 1, // up to 8
  linkedTestsPer: 1, // up to 6
  recentFailurePer: 3, // up to 5
  repeatAppearance: 5,
};

const CATEGORY_HINTS = {
  security: /\b(sec|sql-?inj|xss|csrf|auth[nz]?|ssrf|idor|rce|cwe-\d+)\b/i,
  'data-loss': /\b(data-?loss|corrupt|truncat|drop-?table|destructive-?migration|orphan-?cascade)\b/i,
  deployment: /\b(deploy|release|rollback|canary|blue-?green)\b/i,
  compliance: /\b(gdpr|hipaa|sox|soc2|pci|dpdp|consent|audit-?log)\b/i,
  'user-facing': /\b(ui|ux|frontend|a11y|accessib|display|form|dashboard)\b/i,
};

// ── Scoring ───────────────────────────────────────────────

function scoreEvidence(projectRoot, target, options = {}) {
  const root = path.resolve(projectRoot || process.cwd());
  const reasons = [];
  let score = 0;
  let inputsMissing = 0;

  // Priority signal
  const priority = String(target.priority || '').toLowerCase();
  if (priority === 'critical') {
    score += WEIGHTS.priorityCritical;
    reasons.push({ code: 'priority-critical', value: 'critical', weight: WEIGHTS.priorityCritical });
  } else if (priority === 'high') {
    score += WEIGHTS.priorityHigh;
    reasons.push({ code: 'priority-high', value: 'high', weight: WEIGHTS.priorityHigh });
  } else if (priority === 'medium' || priority === '' || priority === 'normal') {
    score += WEIGHTS.priorityMedium;
    reasons.push({ code: 'priority-medium', value: priority || 'medium', weight: WEIGHTS.priorityMedium });
  } else if (priority === 'low') {
    score += WEIGHTS.priorityLow;
    reasons.push({ code: 'priority-low', value: 'low', weight: WEIGHTS.priorityLow });
  }
  if (!target.priority) inputsMissing += 1;

  // Milestone criticality
  if (target.milestone) {
    const current = options.currentMilestone || readCurrentMilestone(root);
    if (current && target.milestone === current) {
      score += WEIGHTS.currentMilestone;
      reasons.push({ code: 'current-milestone', value: target.milestone, weight: WEIGHTS.currentMilestone });
    } else if (current && target.milestone > current) {
      score += WEIGHTS.futureMilestone;
      reasons.push({ code: 'future-milestone', value: target.milestone, weight: WEIGHTS.futureMilestone });
    }
  } else {
    inputsMissing += 1;
  }

  // Gate-blocking status
  if (target.gateBlocking === true) {
    score += WEIGHTS.gateBlocking;
    reasons.push({ code: 'gate-blocking', value: true, weight: WEIGHTS.gateBlocking });
  }

  // Category detection
  const categoryText = `${target.id || ''} ${target.title || ''} ${target.category || ''} ${target.tags ? target.tags.join(' ') : ''}`;
  for (const [category, pattern] of Object.entries(CATEGORY_HINTS)) {
    if (pattern.test(categoryText)) {
      const key =
        category === 'security'
          ? 'securityCategory'
          : category === 'data-loss'
            ? 'dataLossCategory'
            : category === 'deployment'
              ? 'deploymentCategory'
              : category === 'compliance'
                ? 'complianceCategory'
                : 'userFacing';
      score += WEIGHTS[key];
      reasons.push({ code: `category-${category}`, value: category, weight: WEIGHTS[key] });
    }
  }

  // Linked stories / files / tests / findings
  const linkedStories = Number(target.linkedStories || 0);
  if (linkedStories > 0) {
    const delta = Math.min(linkedStories, 10) * WEIGHTS.linkedStoriesPer;
    score += delta;
    reasons.push({ code: 'linked-stories', value: linkedStories, weight: delta });
  }
  const linkedFiles = Number(target.linkedFiles || 0);
  if (linkedFiles > 0) {
    const delta = Math.min(linkedFiles, 8) * WEIGHTS.linkedFilesPer;
    score += delta;
    reasons.push({ code: 'linked-files', value: linkedFiles, weight: delta });
  }
  const linkedTests = Number(target.linkedTests || 0);
  if (linkedTests > 0) {
    const delta = Math.min(linkedTests, 6) * WEIGHTS.linkedTestsPer;
    score += delta;
    reasons.push({ code: 'linked-tests', value: linkedTests, weight: delta });
  }

  // Recent failures
  const recentFailures = Number(target.recentFailures || 0);
  if (recentFailures > 0) {
    const delta = Math.min(recentFailures, 5) * WEIGHTS.recentFailurePer;
    score += delta;
    reasons.push({ code: 'recent-failures', value: recentFailures, weight: delta });
  }

  // Repeat appearances
  if (target.repeatAppearance === true) {
    score += WEIGHTS.repeatAppearance;
    reasons.push({ code: 'repeat-appearance', value: true, weight: WEIGHTS.repeatAppearance });
  }

  // Cap at 100
  score = Math.min(100, Math.max(0, score));

  return {
    version: IMPACT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    target: {
      id: target.id || 'unknown',
      kind: target.kind || 'requirement',
      path: target.path || '',
      title: target.title || null,
      milestone: target.milestone || null,
    },
    score,
    band: bandOf(score),
    confidence: inputsMissing >= 3 ? 'low' : inputsMissing >= 1 ? 'medium' : 'high',
    reasons,
  };
}

function bandOf(score) {
  if (score >= 75) return 'critical';
  if (score >= 55) return 'high';
  if (score >= 30) return 'medium';
  if (score >= 10) return 'low';
  return 'info';
}

function readCurrentMilestone(projectRoot) {
  const statePath = path.join(projectRoot, 'cobolt-state.json');
  const state = safeReadJson(statePath);
  return state?.pipeline?.currentMilestone || state?.currentMilestone || null;
}

// ── Hydrators ──────────────────────────────────────────────

function hydrateFromRtm(projectRoot, id) {
  const rtm = safeReadJson(path.join(latestDir(projectRoot), 'planning', 'rtm.json'));
  if (!rtm?.requirements?.[id]) return { id, kind: 'requirement', path: '_cobolt-output/latest/planning/rtm.json' };
  const entry = rtm.requirements[id];
  const mils = Array.isArray(entry.milestones) ? entry.milestones : entry.milestone ? [entry.milestone] : [];
  return {
    id,
    kind: 'requirement',
    path: '_cobolt-output/latest/planning/rtm.json',
    title: entry.title || null,
    priority: entry.priority || null,
    milestone: mils[0] || null,
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    linkedStories: Array.isArray(entry.stories) ? entry.stories.length : 0,
    linkedFiles: Array.isArray(entry.files) ? entry.files.length : 0,
    linkedTests: Array.isArray(entry.tests) ? entry.tests.length : 0,
    category: entry.type || null,
  };
}

function hydrateFromFinding(projectRoot, id, milestone) {
  const trackerPath = milestone
    ? path.join(latestDir(projectRoot), 'fix', milestone, 'finding-tracker.json')
    : path.join(latestDir(projectRoot), 'review', 'finding-tracker.json');
  const tracker = safeReadJson(trackerPath);
  const findings = Array.isArray(tracker?.findings) ? tracker.findings : [];
  const entry = findings.find((f) => f.id === id);
  if (!entry)
    return {
      id,
      kind: 'finding',
      path: trackerPath.replace(path.resolve(projectRoot) + path.sep, '').replace(/\\/g, '/'),
    };
  const severityPriority = {
    critical: 'critical',
    high: 'high',
    medium: 'medium',
    low: 'low',
    info: 'low',
  };
  return {
    id,
    kind: 'finding',
    path: trackerPath.replace(path.resolve(projectRoot) + path.sep, '').replace(/\\/g, '/'),
    title: entry.title || null,
    priority: severityPriority[String(entry.severity || '').toLowerCase()] || 'medium',
    milestone: entry.milestone || milestone || null,
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    category: entry.category || entry.prefix || null,
    gateBlocking: entry.blocking === true || entry.severity === 'critical',
    recentFailures: Number(entry.fixAttempts || 0),
    repeatAppearance: Number(entry.fixAttempts || 0) >= 2,
  };
}

// ── Rollup ─────────────────────────────────────────────────

function writeImpact(projectRoot, impact) {
  const outPath = auditPath(projectRoot);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.appendFileSync(outPath, `${JSON.stringify(impact)}\n`, { mode: 0o600 });
  return outPath;
}

function readImpacts(projectRoot) {
  const p = auditPath(projectRoot);
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  return out;
}

function rollup(projectRoot) {
  const entries = readImpacts(projectRoot);
  const byBand = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const byKind = { requirement: 0, finding: 0, story: 0, 'failed-check': 0, 'carry-forward': 0 };
  let sum = 0;
  for (const e of entries) {
    if (byBand[e.band] !== undefined) byBand[e.band] += 1;
    if (byKind[e.target?.kind] !== undefined) byKind[e.target.kind] += 1;
    sum += Number(e.score) || 0;
  }
  return {
    total: entries.length,
    meanScore: entries.length > 0 ? sum / entries.length : null,
    byBand,
    byKind,
  };
}

// ── CLI ───────────────────────────────────────────────────

function flagValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

function main(argv) {
  const args = argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(`  CoBolt Evidence Impact Scoring (advisory)

  Usage:
    node tools/cobolt-evidence-impact.js score --kind requirement --id FR-001 [--milestone M1] [--write] [--json]
    node tools/cobolt-evidence-impact.js score --kind finding --id SEC-001 [--milestone M1] [--write] [--json]
    node tools/cobolt-evidence-impact.js rollup [--json]

  Scoring is advisory only — never reorders pipeline queues.
`);
    process.exit(0);
  }

  if (cmd === 'score') {
    const kind = flagValue(args, '--kind') || 'requirement';
    const id = flagValue(args, '--id');
    const milestone = flagValue(args, '--milestone');
    if (!id) {
      console.error('  --id is required');
      process.exit(2);
    }
    let target;
    if (kind === 'requirement') target = hydrateFromRtm(process.cwd(), id);
    else if (kind === 'finding') target = hydrateFromFinding(process.cwd(), id, milestone);
    else target = { id, kind, path: '' };
    if (milestone) target.milestone = milestone;
    const impact = scoreEvidence(process.cwd(), target, { currentMilestone: milestone });
    if (args.includes('--write')) writeImpact(process.cwd(), impact);
    if (args.includes('--json')) {
      console.log(JSON.stringify(impact, null, 2));
    } else {
      console.log(
        `  ${impact.target.kind}:${impact.target.id}  score=${impact.score}/${100}  band=${impact.band}  confidence=${impact.confidence}`,
      );
      for (const r of impact.reasons) console.log(`    + ${r.code} = ${r.weight}`);
    }
    return;
  }

  if (cmd === 'rollup') {
    const r = rollup(process.cwd());
    if (args.includes('--json')) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`  Total scored: ${r.total}`);
      console.log(`  Mean score:   ${r.meanScore ?? 'n/a'}`);
      console.log(`  By band:      ${JSON.stringify(r.byBand)}`);
      console.log(`  By kind:      ${JSON.stringify(r.byKind)}`);
    }
    return;
  }

  console.error(`  Unknown command: ${cmd}`);
  process.exit(2);
}

module.exports = {
  scoreEvidence,
  bandOf,
  hydrateFromRtm,
  hydrateFromFinding,
  writeImpact,
  readImpacts,
  rollup,
  auditPath,
  IMPACT_SCHEMA_VERSION,
  WEIGHTS,
};

if (require.main === module) main(process.argv);
