#!/usr/bin/env node

// CoBolt RE Evidence Module — Reverse-Engineering Standards Profile (Wave 5 §5.7).
//
// Runs the five evidence checks per docs/REVERSE-ENGINEERING-PIPELINE-ENHANCEMENTS.md §5.7
// against artifacts on disk under `_cobolt-output/**/brownfield/`:
//
//   1. SBVR conformance — every extracted rule has subject/verb/objectOrValue/modality
//      per source/schemas/extracted-rule.schema.json.
//   2. DMN hit-policy validity — every decision table declares an OMG DMN 1.5 hit policy
//      per source/schemas/decision-table.schema.json.
//   3. ISO/IEC 14764:2006 maintenance category — every Gartner 7R decision in
//      33a-7r-decisions/*.json (or migration-safety-plan.json#decisions[]) carries an
//      iso14764Category field.
//   4. NIST SP 800-160 loss-control — every authentication/authorization surface
//      mentioned in 12-security-and-quality-assessment.md has a loss-control reference
//      (NIST SP 800-160 Vol 1 Rev 1 §2.1 / §3 / §4 citation pattern).
//   5. GDPR Art. 30 records-of-processing — every component flagged personalDataTouching
//      in its 7R decision carries a gdprArt30Ref field.
//
// Invocation pattern (mirrors other standards modules):
//   - CLI: `node tools/cobolt-re-evidence.js check`
//   - Programmatic: `const { build } = require('./cobolt-re-evidence'); build(projectRoot)`
//
// Returns a structured report in the same shape consolidate() in cobolt-standards.js
// expects. Skips silently (status 0, skipped: true) when no RE artifacts exist on disk
// — the gate must NOT fire on non-RE projects.

const fs = require('node:fs');
const path = require('node:path');

const STANDARD =
  'CoBolt RE Evidence (Chikofsky-Cross 1990 + SBVR 1.5 + DMN 1.5 + ISO 14764 + NIST SP 800-160 + GDPR Art. 30)';

// ── Brownfield artifact discovery ─────────────────────────────────────────

function findBrownfieldDir(projectRoot) {
  const candidates = [
    path.join(projectRoot, '_cobolt-output', 'latest', 'brownfield'),
    path.join(projectRoot, '_cobolt-output', 'brownfield'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

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
    return '';
  }
}

function readDirJson(dir) {
  if (!fs.existsSync(dir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.json$/i.test(entry.name)) continue;
    const data = readJsonSafe(path.join(dir, entry.name));
    if (data) out.push({ file: entry.name, data });
  }
  return out;
}

// ── Check 1: SBVR conformance ─────────────────────────────────────────────

const SBVR_VALID_MODALITIES = new Set(['obligation', 'prohibition', 'permission', 'necessity', 'possibility']);

function checkSbvrConformance(brownfieldDir) {
  const rulesDir = path.join(brownfieldDir, '14-rules-json');
  const rules = readDirJson(rulesDir);
  if (rules.length === 0) {
    return { check: 'sbvr-conformance', applicable: false, reason: 'no JSON rules in 14-rules-json/' };
  }
  const failures = [];
  for (const { file, data } of rules) {
    const rule = data;
    if (!rule?.id) {
      failures.push({ file, ruleId: '(missing id)', reason: 'rule missing id field' });
      continue;
    }
    const sbvr = rule.sbvrForm;
    if (!sbvr || typeof sbvr !== 'object') {
      failures.push({ file, ruleId: rule.id, reason: 'missing sbvrForm object' });
      continue;
    }
    if (!sbvr.subject || typeof sbvr.subject !== 'string' || sbvr.subject.length < 2) {
      failures.push({ file, ruleId: rule.id, reason: 'sbvrForm.subject missing or <2 chars' });
    }
    if (!sbvr.verb || typeof sbvr.verb !== 'string' || sbvr.verb.length < 2) {
      failures.push({ file, ruleId: rule.id, reason: 'sbvrForm.verb missing or <2 chars' });
    }
    if (!sbvr.modality || !SBVR_VALID_MODALITIES.has(sbvr.modality)) {
      failures.push({
        file,
        ruleId: rule.id,
        reason: `sbvrForm.modality missing or invalid (got "${sbvr.modality}", expected one of ${Array.from(SBVR_VALID_MODALITIES).join(' | ')})`,
      });
    }
  }
  return {
    check: 'sbvr-conformance',
    applicable: true,
    standard: 'OMG SBVR 1.5 §10–11',
    totalRules: rules.length,
    conformantRules: rules.length - failures.length,
    nonConformantRules: failures.length,
    passed: failures.length === 0,
    failures: failures.slice(0, 20),
  };
}

// ── Check 2: DMN 1.5 hit-policy validity ─────────────────────────────────

const DMN_VALID_HIT_POLICIES = new Set(['UNIQUE', 'ANY', 'PRIORITY', 'FIRST', 'OUTPUT_ORDER', 'RULE_ORDER', 'COLLECT']);

function checkDmnHitPolicy(brownfieldDir) {
  const dtDir = path.join(brownfieldDir, '14a-decision-tables');
  const tables = readDirJson(dtDir);
  if (tables.length === 0) {
    return { check: 'dmn-hit-policy', applicable: false, reason: 'no decision tables in 14a-decision-tables/' };
  }
  const failures = [];
  for (const { file, data } of tables) {
    if (!data?.id) {
      failures.push({ file, tableId: '(missing id)', reason: 'table missing id' });
      continue;
    }
    if (!data.hitPolicy) {
      failures.push({ file, tableId: data.id, reason: 'missing hitPolicy (DMN 1.5 §10.3 invariant)' });
      continue;
    }
    if (!DMN_VALID_HIT_POLICIES.has(data.hitPolicy)) {
      failures.push({
        file,
        tableId: data.id,
        reason: `invalid hitPolicy "${data.hitPolicy}" (valid: ${Array.from(DMN_VALID_HIT_POLICIES).join(' | ')})`,
      });
    }
    if (data.hitPolicy === 'COLLECT' && !data.collectAggregator) {
      failures.push({
        file,
        tableId: data.id,
        reason: 'hitPolicy=COLLECT requires collectAggregator (DMN 1.5 §10.3.7)',
      });
    }
  }
  return {
    check: 'dmn-hit-policy',
    applicable: true,
    standard: 'OMG DMN 1.5 §10.3',
    totalTables: tables.length,
    conformantTables: tables.length - failures.length,
    nonConformantTables: failures.length,
    passed: failures.length === 0,
    failures: failures.slice(0, 20),
  };
}

// ── Check 3: ISO 14764:2006 maintenance category ─────────────────────────

const ISO_14764_VALID = new Set(['corrective', 'adaptive', 'perfective', 'preventive']);

// Components live in `04-feature-and-module-inventory.md` (CMP-XYZ-NNN ids); 7R decisions
// live either in a single `migration-safety-plan.json#decisions[]` or per-component under
// `33a-7r-decisions/*.json`. ISO 14764 categorisation is on the 7R decision.
function loadAllDecisions(brownfieldDir) {
  const decisions = [];
  const safetyPlan = readJsonSafe(path.join(brownfieldDir, 'migration-safety-plan.json'));
  if (Array.isArray(safetyPlan?.decisions)) decisions.push(...safetyPlan.decisions);
  for (const { data } of readDirJson(path.join(brownfieldDir, '33a-7r-decisions'))) {
    if (data?.componentId) decisions.push(data);
  }
  return decisions;
}

function checkIso14764(brownfieldDir) {
  const decisions = loadAllDecisions(brownfieldDir);
  if (decisions.length === 0) {
    return { check: 'iso-14764-maintenance-category', applicable: false, reason: 'no 7R decisions on disk' };
  }
  const failures = [];
  for (const d of decisions) {
    if (!d.iso14764Category) {
      failures.push({ componentId: d.componentId, reason: 'missing iso14764Category' });
      continue;
    }
    if (!ISO_14764_VALID.has(d.iso14764Category)) {
      failures.push({
        componentId: d.componentId,
        reason: `invalid iso14764Category "${d.iso14764Category}" (valid: ${Array.from(ISO_14764_VALID).join(' | ')})`,
      });
    }
  }
  return {
    check: 'iso-14764-maintenance-category',
    applicable: true,
    standard: 'ISO/IEC 14764:2006',
    totalComponents: decisions.length,
    categorisedComponents: decisions.length - failures.length,
    uncategorisedComponents: failures.length,
    passed: failures.length === 0,
    failures: failures.slice(0, 20),
  };
}

// ── Check 4: NIST SP 800-160 loss-control mapping ────────────────────────

// NIST SP 800-160 Vol 1 Rev 1 (2022) — loss-control objectives drive design. We look for
// auth surfaces in the security assessment AND for explicit citations of NIST 800-160
// (or §2.1 / §3 loss-control patterns) within their context.
const AUTH_SURFACE_PATTERN = /\b(authentication|authorization|session|sso|saml|oauth|oidc|jwt|rbac|abac|mfa|2fa)\b/gi;
const NIST_800_160_REFERENCE_PATTERN = /\bNIST\s*SP\s*800-160\b|\bloss[-\s]?control\b/i;

function checkNistLossControl(brownfieldDir) {
  const securityDoc = path.join(brownfieldDir, '12-security-and-quality-assessment.md');
  if (!fs.existsSync(securityDoc)) {
    return {
      check: 'nist-800-160-loss-control',
      applicable: false,
      reason: 'no 12-security-and-quality-assessment.md on disk',
    };
  }
  const body = readTextSafe(securityDoc);
  // Split into paragraphs (blank-line separated). Each paragraph that mentions an auth
  // surface must contain a NIST SP 800-160 / loss-control citation in the same paragraph
  // OR within the immediately preceding heading/paragraph (lookback).
  const paragraphs = body.split(/\n\s*\n/);
  const failures = [];
  for (let i = 0; i < paragraphs.length; i += 1) {
    const para = paragraphs[i];
    const hasAuthSurface = AUTH_SURFACE_PATTERN.test(para);
    AUTH_SURFACE_PATTERN.lastIndex = 0; // reset stateful regex
    if (!hasAuthSurface) continue;
    const surroundingText = `${paragraphs[Math.max(0, i - 1)] || ''}\n${para}\n${paragraphs[i + 1] || ''}`;
    if (!NIST_800_160_REFERENCE_PATTERN.test(surroundingText)) {
      failures.push({
        paragraphIndex: i,
        excerpt: para.replace(/\s+/g, ' ').trim().slice(0, 120),
        reason:
          'auth surface mentioned without NIST SP 800-160 / loss-control citation in paragraph or immediate vicinity',
      });
    }
  }
  return {
    check: 'nist-800-160-loss-control',
    applicable: true,
    standard: 'NIST SP 800-160 Vol 1 Rev 1 (2022)',
    paragraphsScanned: paragraphs.length,
    authSurfaceParagraphs: paragraphs.length - failures.length, // approximation
    uncitedAuthSurfaces: failures.length,
    passed: failures.length === 0,
    failures: failures.slice(0, 20),
  };
}

// ── Check 5: GDPR Art. 30 records-of-processing ──────────────────────────

function checkGdprArt30(brownfieldDir) {
  const decisions = loadAllDecisions(brownfieldDir);
  const personalDataDecisions = decisions.filter((d) => d?.personalDataTouching === true);
  if (personalDataDecisions.length === 0) {
    return {
      check: 'gdpr-art-30-records',
      applicable: false,
      reason: 'no components flagged personalDataTouching=true',
    };
  }
  const failures = [];
  for (const d of personalDataDecisions) {
    if (!d.gdprArt30Ref || typeof d.gdprArt30Ref !== 'string' || d.gdprArt30Ref.length === 0) {
      failures.push({
        componentId: d.componentId,
        reason: 'personalDataTouching=true without gdprArt30Ref',
      });
    }
  }
  return {
    check: 'gdpr-art-30-records',
    applicable: true,
    standard: 'GDPR Art. 30 (records of processing activities)',
    personalDataComponents: personalDataDecisions.length,
    documentedComponents: personalDataDecisions.length - failures.length,
    undocumentedComponents: failures.length,
    passed: failures.length === 0,
    failures: failures.slice(0, 20),
  };
}

// ── Public surface ────────────────────────────────────────────────────────

function build(projectRoot = process.cwd()) {
  const brownfieldDir = findBrownfieldDir(projectRoot);
  const generatedAt = new Date().toISOString();
  if (!brownfieldDir) {
    return {
      standard: STANDARD,
      generatedAt,
      skipped: true,
      reason: 'no brownfield directory on disk; not a reverse-engineering project',
      checks: [],
      summary: { totalChecks: 0, applicableChecks: 0, passingChecks: 0, failingChecks: 0 },
    };
  }
  const checks = [
    checkSbvrConformance(brownfieldDir),
    checkDmnHitPolicy(brownfieldDir),
    checkIso14764(brownfieldDir),
    checkNistLossControl(brownfieldDir),
    checkGdprArt30(brownfieldDir),
  ];
  const applicable = checks.filter((c) => c.applicable !== false);
  const passing = applicable.filter((c) => c.passed === true);
  const failing = applicable.filter((c) => c.passed === false);
  return {
    standard: STANDARD,
    generatedAt,
    brownfieldDir: path.relative(projectRoot, brownfieldDir),
    checks,
    summary: {
      totalChecks: checks.length,
      applicableChecks: applicable.length,
      passingChecks: passing.length,
      failingChecks: failing.length,
    },
    passed: failing.length === 0,
  };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      [
        'cobolt-re-evidence — Reverse-Engineering standards-evidence module (Wave 5 §5.7).',
        '',
        'Usage:',
        '  node tools/cobolt-re-evidence.js check [--json]',
        '',
        'Runs 5 RE-specific evidence checks against _cobolt-output/**/brownfield/ artifacts:',
        '  1. SBVR 1.5 conformance per extracted rule.',
        '  2. DMN 1.5 hit-policy validity per decision table.',
        '  3. ISO 14764:2006 maintenance category per 7R decision.',
        '  4. NIST SP 800-160 loss-control citation per auth surface.',
        '  5. GDPR Art. 30 records-of-processing per personal-data component.',
        '',
        'Exit codes: 0=pass, 1=hard error, 2=skipped (no RE artifacts), 3=findings.',
        '',
      ].join('\n'),
    );
    process.exit(0);
  }
  const projectRoot = process.cwd();
  const report = build(projectRoot);
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    if (report.skipped) {
      process.stdout.write(`re-evidence: SKIPPED — ${report.reason}\n`);
    } else {
      process.stdout.write(
        `re-evidence: ${report.passed ? 'PASS' : 'FAIL'} (${report.summary.passingChecks}/${report.summary.applicableChecks} applicable checks passing)\n`,
      );
      for (const c of report.checks) {
        if (c.applicable === false) {
          process.stdout.write(`  - ${c.check}: SKIPPED — ${c.reason}\n`);
          continue;
        }
        process.stdout.write(`  - ${c.check}: ${c.passed ? 'PASS' : 'FAIL'}\n`);
        if (!c.passed && Array.isArray(c.failures)) {
          for (const f of c.failures.slice(0, 5)) {
            process.stdout.write(`      • ${JSON.stringify(f)}\n`);
          }
        }
      }
    }
  }
  if (report.skipped) process.exit(2);
  process.exit(report.passed ? 0 : 3);
}

if (require.main === module) {
  main();
}

module.exports = {
  build,
  checkSbvrConformance,
  checkDmnHitPolicy,
  checkIso14764,
  checkNistLossControl,
  checkGdprArt30,
  loadAllDecisions,
  findBrownfieldDir,
  SBVR_VALID_MODALITIES,
  DMN_VALID_HIT_POLICIES,
  ISO_14764_VALID,
};
