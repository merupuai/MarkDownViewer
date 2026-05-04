#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const {
  detectBrownfieldAssessmentMode,
  extractIssueIds,
  getBrownfieldArtifactApplicability,
  isForensicAuditRequired,
  loadJson,
  loadText,
  validateEvidenceIndex,
} = require('./_brownfield-readiness-utils');

const PLACEHOLDER_PATTERNS = [
  { label: '\\bTODO\\b', pattern: /\bTODO\b/i },
  { label: '\\bTBD\\b', pattern: /\bTBD\b/i },
  { label: '\\bFIXME\\b', pattern: /\bFIXME\b/i },
  { label: '<placeholder>', pattern: /<placeholder>/i },
  { label: '\\[placeholder\\]', pattern: /\[placeholder\]/i },
  {
    label: 'placeholder content marker',
    pattern: /\bplaceholder\s+(?:content|copy|data|field|section|stub|text|todo|value)\b/i,
  },
  { label: '\\blorem ipsum\\b', pattern: /\blorem ipsum\b/i },
  { label: '\\bcoming soon\\b', pattern: /\bcoming soon\b/i },
];

const PHASE_ARTIFACTS = {
  P0: [
    { file: '01-intake-and-classification.md', minBytes: 300 },
    { file: '02-baseline-health-and-scan-summary.md', minBytes: 300 },
    { file: '03-project-context.md', minBytes: 300, optional: true },
    { file: 'tech-scan.json', minBytes: 20, optional: true, type: 'json' },
    { file: 'health-scan.json', minBytes: 20, optional: true, type: 'json' },
    { file: 'security-scan.json', minBytes: 20, optional: true, type: 'json' },
    { file: 'sbom.json', minBytes: 20, optional: true, type: 'json' },
  ],
  P1: [
    { file: '04-feature-and-module-inventory.md', minBytes: 300 },
    { file: '05-database-and-data-store-report.md', minBytes: 200, optional: true },
    { file: '06-integration-map.md', minBytes: 200, optional: true },
    { file: '07-configuration-and-access-audit.md', minBytes: 200, optional: true },
    { file: '08-ui-and-workflow-catalog.md', minBytes: 200, optional: true, condition: 'ui' },
    { file: '09-supply-chain-and-vulnerability-review.md', minBytes: 200, optional: true },
    { file: '10-discovery-tracker.json', minBytes: 20, optional: true, type: 'json' },
    { file: '11-dependency-tracker.json', minBytes: 20, optional: true, type: 'json' },
    { file: '12-security-and-quality-assessment.md', minBytes: 300 },
    { file: 'domain-liveness.json', minBytes: 20, optional: true, type: 'json' },
    { file: 'query-migration-contract.json', minBytes: 20, optional: true, type: 'json' },
    { file: 'semantic-stub-findings.json', minBytes: 20, optional: true, type: 'json' },
    { file: 'ui-placeholder-mock-scan.json', minBytes: 20, optional: true, type: 'json', condition: 'ui' },
  ],
  P2: [
    { file: '13-architecture-recovery.md', minBytes: 200, optional: true },
    { file: '14-business-rules-and-validation.md', minBytes: 200, optional: true },
    { file: '15-feature-triage-matrix.md', minBytes: 200, optional: true },
  ],
  'P2.5': [
    { file: '16d-forensic-audit-report.md', minBytes: 500 },
    { file: '16a-forensic-findings.json', minBytes: 20, optional: true, type: 'json' },
    { file: '16b-illusion-inventory.json', minBytes: 20, optional: true, type: 'json' },
    { file: '16c-illusion-verification.json', minBytes: 20, optional: true, type: 'json' },
    { file: '16e-phantom-rejection-log.json', minBytes: 20, optional: true, type: 'json' },
  ],
  P3: [
    { file: '16-issues-registry.json', minBytes: 100, type: 'json' },
    { file: '17-enhancement-advisory.md', minBytes: 200 },
    { file: '18-modernization-roadmap.md', minBytes: 500, condition: 'deepPlus' },
    { file: '19-evidence-index.json', minBytes: 50, type: 'json' },
    { file: '20-modernization-decision-log.md', minBytes: 300, condition: 'deepPlus' },
    { file: '21-modernization-handoff.json', minBytes: 200, type: 'json', condition: 'planningMode' },
    { file: '22-modernization-milestone-tracker.json', minBytes: 100, type: 'json', condition: 'planningMode' },
    { file: '23-master-assessment.md', minBytes: 1200 },
    { file: 'brownfield-intake-profile.json', minBytes: 100, type: 'json' },
    { file: 'brownfield-assessment-verdict.json', minBytes: 100, type: 'json' },
    { file: 'legacy-data-classification.json', minBytes: 100, type: 'json' },
    { file: 'brownfield-evidence-confidence.json', minBytes: 100, type: 'json' },
    { file: 'legacy-risk-register.json', minBytes: 100, type: 'json' },
    { file: 'standards-version-baseline.json', minBytes: 100, type: 'json' },
    { file: 'brownfield-lifecycle-map.json', minBytes: 100, type: 'json' },
    { file: 'ai-system-inventory.json', minBytes: 100, type: 'json' },
  ],
  P4: [
    { file: '24-modernization-prd.md', minBytes: 1000 },
    { file: '25-modernization-trd.md', minBytes: 500 },
    { file: '26-modernization-security-requirements.md', minBytes: 500 },
    { file: '26a-modernization-secure-coding-standard.md', minBytes: 300 },
    { file: '26b-modernization-engineering-quality-standards.md', minBytes: 300 },
    { file: '26b-standards-validation.json', minBytes: 100, type: 'json' },
    { file: '26c-modernization-compliance-architecture.md', minBytes: 500 },
    { file: '26c-validation.json', minBytes: 100, type: 'json' },
  ],
  P5: [
    { file: '27-modernization-system-architecture.md', minBytes: 500, aliases: ['27-system-architecture.md'] },
    { file: '27-architect-review.json', minBytes: 100, type: 'json', mustNotBlock: true },
    { file: '28-modernization-architecture-decisions.md', minBytes: 500 },
    { file: '29-modernization-data-model-spec.md', minBytes: 500 },
    { file: '30-modernization-api-contracts.md', minBytes: 500 },
    { file: '31-modernization-ux-design-specification.md', minBytes: 500, optional: true, condition: 'ui' },
    { file: '31a-modernization-wireframes-and-user-flows.md', minBytes: 500, optional: true, condition: 'ui' },
    {
      file: '31-design-token-audit.json',
      minBytes: 100,
      optional: true,
      type: 'json',
      condition: 'ui',
      mustNotBlock: true,
    },
    {
      file: '31-ui-design-audit.json',
      minBytes: 100,
      optional: true,
      type: 'json',
      condition: 'ui',
      mustNotBlock: true,
    },
    { file: '32-modernization-implicit-requirements.md', minBytes: 500 },
    { file: '33-modernization-dependency-and-integration-register.md', minBytes: 500 },
    { file: '34-modernization-dependency-tracker.json', minBytes: 100, type: 'json' },
    { file: '34a-modernization-ux-tracker.json', minBytes: 100, optional: true, type: 'json', condition: 'ui' },
  ],
  P6: [
    { file: '35-modernization-milestones.md', minBytes: 300, aliases: ['35-milestones.md'] },
    { file: '36-modernization-epics-and-stories.md', minBytes: 400 },
    { file: '37-modernization-traceability-matrix.md', minBytes: 300 },
    { file: '38-modernization-test-strategy.md', minBytes: 300 },
    {
      file: '38a-modernization-deterministic-quality-gates.json',
      minBytes: 50,
      optional: true,
      type: 'json',
    },
    {
      file: '38b-modernization-agent-grounding-and-anti-hallucination.md',
      minBytes: 200,
      condition: 'agentDispatch',
    },
    { file: '39-modernization-delivery-plan.md', minBytes: 300 },
    { file: '40-modernization-milestone-tracker.json', minBytes: 50, type: 'json' },
    { file: '41-modernization-story-tracker.json', minBytes: 50, type: 'json' },
    { file: '42-modernization-issue-and-blocker-tracker.json', minBytes: 50, type: 'json' },
    { file: '43-modernization-validation-report.md', minBytes: 300 },
    { file: '44-modernization-release-readiness-checklist.md', minBytes: 300 },
    { file: '45-modernization-master-plan.md', minBytes: 400 },
    { file: 'legacy-data-lifecycle.json', minBytes: 100, type: 'json', condition: 'planningMode' },
    { file: 'brownfield-parity-contract.json', minBytes: 100, type: 'json', condition: 'planningMode' },
    { file: 'migration-safety-plan.json', minBytes: 100, type: 'json', condition: 'planningMode' },
    { file: 'brownfield-supply-chain-policy.json', minBytes: 100, type: 'json', condition: 'planningMode' },
    { file: 'legacy-ops-inventory.json', minBytes: 100, type: 'json', condition: 'planningMode' },
    { file: 'modernization-ops-gap-report.json', minBytes: 100, type: 'json', condition: 'planningMode' },
    { file: 'observability-semantics-contract.json', minBytes: 100, type: 'json', condition: 'planningMode' },
    { file: 'brownfield-modernization-readiness.json', minBytes: 100, type: 'json', condition: 'planningMode' },
  ],
};

function resolveArtifactPath(bfDir, spec) {
  const candidates = [spec.file, ...(spec.aliases || [])].map((file) => path.join(bfDir, file));
  return candidates.find((candidate) => fs.existsSync(candidate)) || path.join(bfDir, spec.file);
}

function placeholderMatches(content) {
  return PLACEHOLDER_PATTERNS.filter(({ pattern }) => pattern.test(content || '')).map(({ label }) => label);
}

function reviewSidecarBlocks(parsed) {
  return (
    parsed.blocking === true ||
    parsed.status === 'blocked' ||
    (Array.isArray(parsed.blockingFindings) && parsed.blockingFindings.length > 0) ||
    (Array.isArray(parsed.blockers) && parsed.blockers.length > 0)
  );
}

function reviewSidecarDeclaresNonBlocking(parsed) {
  if (parsed.blocking === false) return true;
  const status = String(parsed.status || parsed.verdict || '')
    .trim()
    .toLowerCase();
  return ['approved', 'accepted', 'existing', 'pass', 'passed', 'ok', 'clean'].includes(status);
}

function addGap(gaps, artifact, severity, type, description) {
  gaps.push({
    type,
    artifact,
    severity,
    description,
    fixed: false,
    fixMethod: null,
  });
}

function validateArtifact(bfDir, spec, gaps, stats) {
  const artifactPath = resolveArtifactPath(bfDir, spec);
  const artifactName = path.basename(artifactPath);

  if (!fs.existsSync(artifactPath)) {
    if (!spec.optional) addGap(gaps, spec.file, 'critical', 'missing', 'Required artifact is missing');
    return;
  }

  stats.present++;
  const size = fs.statSync(artifactPath).size;
  if (size <= 0) {
    addGap(gaps, artifactName, 'critical', 'empty', 'Artifact exists but is empty');
    return;
  }

  if (size < spec.minBytes) {
    addGap(
      gaps,
      artifactName,
      spec.optional ? 'medium' : 'high',
      'undersized',
      `${size} bytes is below the ${spec.minBytes}-byte minimum`,
    );
  } else {
    stats.complete++;
  }

  if ((spec.type || '').toLowerCase() === 'json') {
    const parsed = loadJson(artifactPath);
    if (!parsed) {
      addGap(gaps, artifactName, 'critical', 'invalid-json', 'Artifact is not valid JSON');
      return;
    }
    if (spec.mustNotBlock) {
      const blocking = reviewSidecarBlocks(parsed);
      if (blocking || !reviewSidecarDeclaresNonBlocking(parsed)) {
        addGap(
          gaps,
          artifactName,
          'high',
          'blocking-review',
          'Review/audit sidecar must declare an approved/pass/non-blocking status and contain no blockers',
        );
      }
    }
    return;
  }

  const content = loadText(artifactPath);
  if (content === null) {
    addGap(gaps, artifactName, 'critical', 'unreadable', 'Artifact could not be read');
    return;
  }

  const placeholders = placeholderMatches(content);
  if (placeholders.length > 0) {
    addGap(
      gaps,
      artifactName,
      spec.optional ? 'low' : 'high',
      'placeholder',
      `Placeholder markers detected: ${placeholders.slice(0, 3).join(', ')}`,
    );
  }
}

function validateP3CrossReferences(bfDir, gaps) {
  const issuesData = loadJson(path.join(bfDir, '16-issues-registry.json'));
  const assessment = loadText(path.join(bfDir, '23-master-assessment.md'));
  const registryIds = new Set((issuesData?.issues || []).map((issue) => String(issue.id || '').trim()).filter(Boolean));
  const assessmentIds = extractIssueIds(assessment);

  if (assessmentIds.length > 0) {
    const missing = assessmentIds.filter((id) => !registryIds.has(id));
    if (missing.length > 0) {
      addGap(
        gaps,
        '23-master-assessment.md',
        'high',
        'cross-ref',
        `Assessment references issue IDs not present in 16-issues-registry.json: ${missing.slice(0, 5).join(', ')}`,
      );
    }
  }

  const evidence = validateEvidenceIndex(bfDir);
  if (!evidence.pass) {
    addGap(gaps, '19-evidence-index.json', 'high', 'integrity', evidence.detail);
  }
}

function buildReport(bfDir, phase) {
  const specs = PHASE_ARTIFACTS[phase];
  if (!specs) {
    return {
      phase,
      pipeline: 'brownfield',
      analyzedAt: new Date().toISOString(),
      artifactsExpected: 0,
      artifactsPresent: 0,
      artifactsComplete: 0,
      gaps: [
        {
          type: 'unknown-phase',
          artifact: phase,
          severity: 'critical',
          description: `Unknown brownfield phase: ${phase}`,
          fixed: false,
          fixMethod: null,
        },
      ],
      fixIterations: 0,
      result: 'fail',
    };
  }

  const issuesData = loadJson(path.join(bfDir, '16-issues-registry.json'));
  const accuracyData = loadJson(path.join(bfDir, 'phase-P3-accuracy-report.json'));
  const assessmentMode = detectBrownfieldAssessmentMode(bfDir, issuesData, accuracyData);
  const applicability = getBrownfieldArtifactApplicability(bfDir, issuesData, accuracyData);
  const applicableSpecs = specs.filter((spec) => applicability.shouldCount(spec.condition));

  if (phase === 'P2.5' && !isForensicAuditRequired(bfDir, issuesData, accuracyData)) {
    return {
      phase,
      pipeline: 'brownfield',
      analyzedAt: new Date().toISOString(),
      artifactsExpected: 0,
      artifactsPresent: 0,
      artifactsComplete: 0,
      gaps: [],
      fixIterations: 0,
      result: 'pass',
      context: {
        analysisMode: assessmentMode,
        forensicAuditRequired: false,
        uiRelevant: applicability.uiRelevant,
        skipReason: `P2.5 is optional in ${assessmentMode} mode`,
      },
    };
  }

  const report = {
    phase,
    pipeline: 'brownfield',
    analyzedAt: new Date().toISOString(),
    artifactsExpected: applicableSpecs.filter((spec) => !spec.optional).length,
    artifactsPresent: 0,
    artifactsComplete: 0,
    gaps: [],
    fixIterations: 0,
    result: 'pass',
    context: {
      analysisMode: assessmentMode,
      forensicAuditRequired: isForensicAuditRequired(bfDir, issuesData, accuracyData),
      uiRelevant: applicability.uiRelevant,
    },
  };

  const stats = { present: 0, complete: 0 };
  for (const spec of applicableSpecs) {
    validateArtifact(bfDir, spec, report.gaps, stats);
  }

  report.artifactsPresent = stats.present;
  report.artifactsComplete = stats.complete;

  if (phase === 'P3') {
    validateP3CrossReferences(bfDir, report.gaps);
  }

  const severities = new Set(report.gaps.map((gap) => gap.severity));
  if (severities.has('critical') || severities.has('high')) {
    report.result = 'fail';
  } else if (report.gaps.length > 0) {
    report.result = 'pass-with-warnings';
  }

  return report;
}

function reportPathForPhase(bfDir, phase) {
  return path.join(bfDir, `phase-${phase}-gap-report.json`);
}

function checkPhaseGap(bfDir, phase, options = {}) {
  const report = buildReport(bfDir, phase);
  if (options.write !== false) {
    fs.mkdirSync(bfDir, { recursive: true });
    fs.writeFileSync(reportPathForPhase(bfDir, phase), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  return report;
}

function checkAllPhaseGaps(bfDir, options = {}) {
  const results = {};
  for (const phase of Object.keys(PHASE_ARTIFACTS)) {
    results[phase] = checkPhaseGap(bfDir, phase, options);
  }
  return results;
}

const USAGE = `Usage:
  node tools/cobolt-brownfield-gap-review.js check --phase P3 [--dir <path>] [--json]
  node tools/cobolt-brownfield-gap-review.js check-all [--dir <path>] [--json]

Commands:
  check       Check gap status for a single brownfield phase (default --phase P3)
  check-all   Check gap status across all brownfield phases

Flags:
  --dir <path>      Brownfield artifact dir (default: _cobolt-output/latest/brownfield)
  --phase <id>      Phase id (P1..P6); only used by 'check'
  --json            Emit machine-readable JSON
  --help, -h        Show this help and exit
`;

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  const command = args[0] || 'check';
  const dirIdx = args.indexOf('--dir');
  const bfDir =
    dirIdx !== -1 && args[dirIdx + 1]
      ? path.resolve(args[dirIdx + 1])
      : path.join(process.cwd(), '_cobolt-output', 'latest', 'brownfield');
  const jsonMode = args.includes('--json');

  if (command === 'check') {
    const phaseIdx = args.indexOf('--phase');
    const phase = phaseIdx !== -1 && args[phaseIdx + 1] ? args[phaseIdx + 1] : 'P3';
    const result = checkPhaseGap(bfDir, phase);
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`[cobolt-brownfield-gap-review] ${phase}`);
      console.log(`  Verdict: ${result.result}`);
      console.log(`  Artifacts: ${result.artifactsPresent} present, ${result.artifactsComplete} complete`);
      for (const gap of result.gaps) {
        console.log(`  [${gap.severity.toUpperCase()}] ${gap.artifact}: ${gap.description}`);
      }
    }
    process.exit(result.result === 'fail' ? 1 : 0);
  }

  if (command === 'check-all') {
    const results = checkAllPhaseGaps(bfDir);
    const failed = Object.values(results).some((result) => result.result === 'fail');
    if (jsonMode) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      for (const [phase, result] of Object.entries(results)) {
        console.log(`${phase}: ${result.result}`);
      }
    }
    process.exit(failed ? 1 : 0);
  }

  console.log('CoBolt Brownfield Gap Review');
  console.log('');
  console.log(USAGE);
  process.exit(command ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = {
  PHASE_ARTIFACTS,
  checkAllPhaseGaps,
  checkPhaseGap,
  reportPathForPhase,
};
