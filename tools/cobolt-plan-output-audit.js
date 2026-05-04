#!/usr/bin/env node

// CoBolt Plan-Pipeline Output Audit (deep harness) --- complements
// cobolt-plan-pipeline-audit.js (which audits SOURCE CONTRACTS) by auditing
// the RUN OUTPUT produced by /cobolt-plan in a target project.
//
// Composes every planning-output auditor in a single pass and emits a
// unified typed-finding JSON + markdown report. Never mutates artifacts.
//
// Audit axes (each invokes an existing CoBolt tool, or runs a deterministic
// output-level check):
//   A1  planning-artifact-audit   (path-registry census)
//   A2  planning-census           (counts + sprint coverage + milestone floor/ceiling)
//   A3  planning-count-parity     (epic/story/milestone drift)
//   A4  planning-integrity        (cross-artifact contracts C1..C23)
//   A5  artifact-parity           (11 paired-artifact checks)
//   A6  source-coverage           (source doc traceability, 100% fail-closed)
//   A7  feature-coverage          (feature registry + dossier readiness, stage=final)
//   A8  capability-graph          (capability edges + proof, stage=final)
//   A9  rtm-census                (RTM source/AC/traceability)
//   A10 rtm-references            (phantom FR/NFR/TR/IR detection)
//   A11 readiness-check           (5 deterministic dimensions)
//   A12 promise-census            (deps cited vs installed)
//   A13 spec-quality              (clone/prose/map-drift)
//   A14 tautology-scan            (tautological-assertion regression)
//   A15 checkpoint-contradiction  (planning-progress.nextSkill vs phase5.planningComplete)
//   A16 state-artifact-registration (cobolt-state.planningArtifacts vs disk reality)
//   A17 design-diagram-duplication  (independent mermaid-node duplicate diff)
//   A18 ux-section-completeness     (independent UX spec section/depth check)
//   A19 capability-contracts        (final capability contract readiness)
//   A20 milestone-doc-consistency   (canonical milestone count vs synthesized docs)
//   A21 story-implementation-quality (story/spec implementation-quality prebuild gate)
//
// Exit codes (per tools/CLAUDE.md contract):
//   0 — all Tier 1 axes pass (Tier 2/3 findings reported but do not fail)
//   1 — hard error / usage / invariant failure
//   2 — missing optional dep (reserved; this harness has none today)
//   4 — at least one Tier 1 axis has a block finding
//
// Usage:
//   node tools/cobolt-plan-output-audit.js [--target <project-root>] [--out <dir>] [--json]
//   node tools/cobolt-plan-output-audit.js --help

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const COBOLT_ROOT = path.resolve(__dirname, '..');
const TOOLS_DIR = path.join(COBOLT_ROOT, 'tools');
const PLAN_REVIEW_TAXONOMY_PATH = path.join(COBOLT_ROOT, 'source', 'config', 'plan-review-taxonomy.json');

const AXIS_TAXONOMY_CLASS_MAP = {
  A1: ['A1', 'A5'],
  A2: ['B3', 'C3', 'F2'],
  A3: ['C3'],
  A4: ['C2', 'C5'],
  A5: ['B3', 'C3', 'C5'],
  A6: ['F2'],
  A7: ['F2'],
  A8: ['C5'],
  A9: ['B3'],
  A10: ['B3'],
  A11: ['C3', 'F2'],
  A12: ['C4', 'D5'],
  A13: ['A2', 'D3'],
  A14: ['D2'],
  A15: ['C2'],
  A16: ['A5', 'E2'],
  A17: ['A4'],
  A18: ['A2', 'F2'],
  A19: ['C5', 'F2'],
  A20: ['B1', 'C3'],
  A21: ['A2', 'F2'],
  // CB-OBS-22 — new axes reuse existing taxonomy classes where applicable
  // and cross-reference to the new H1..H4 classes introduced by CB-OBS-24
  // so plan-review's audit-bridge detector classifies each finding.
  A22: ['H1', 'C3'],
  A23: ['H1', 'C3'],
  A24: ['H2', 'F2'],
  A25: ['H3', 'B3'],
  A26: ['A2', 'F2'],
  A27: ['A2', 'F2'],
};

const AXES = [
  { id: 'A1', tier: 1, name: 'planning-artifact-audit', run: axisPlanningArtifactAudit },
  { id: 'A2', tier: 1, name: 'planning-census', run: axisPlanningCensus },
  { id: 'A3', tier: 1, name: 'planning-count-parity', run: axisCountParity },
  { id: 'A4', tier: 1, name: 'planning-integrity', run: axisPlanningIntegrity },
  { id: 'A5', tier: 1, name: 'artifact-parity', run: axisArtifactParity },
  { id: 'A6', tier: 1, name: 'source-coverage', run: axisSourceCoverage },
  { id: 'A7', tier: 1, name: 'feature-coverage', run: axisFeatureCoverage },
  { id: 'A8', tier: 2, name: 'capability-graph', run: axisCapabilityGraph },
  { id: 'A9', tier: 1, name: 'rtm-census', run: axisRtmCensus },
  { id: 'A10', tier: 1, name: 'rtm-references', run: axisRtmReferences },
  { id: 'A11', tier: 1, name: 'readiness-check', run: axisReadinessCheck },
  { id: 'A12', tier: 2, name: 'promise-census', run: axisPromiseCensus },
  { id: 'A13', tier: 1, name: 'spec-quality', run: axisSpecQuality },
  { id: 'A14', tier: 2, name: 'tautology-scan', run: axisTautologyScan },
  { id: 'A15', tier: 1, name: 'checkpoint-contradiction', run: axisCheckpointContradiction },
  { id: 'A16', tier: 2, name: 'state-artifact-registration', run: axisStateArtifactRegistration },
  { id: 'A17', tier: 1, name: 'design-diagram-duplication', run: axisDiagramDuplication },
  { id: 'A18', tier: 1, name: 'ux-section-completeness', run: axisUxSectionCompleteness },
  { id: 'A19', tier: 2, name: 'capability-contracts', run: axisCapabilityContracts },
  { id: 'A20', tier: 1, name: 'milestone-doc-consistency', run: axisMilestoneDocConsistency },
  { id: 'A21', tier: 1, name: 'story-implementation-quality', run: axisStoryImplementationQuality },
  // CB-OBS-22 — first-class axes for the drift classes surfaced during the
  // Rdrive101 greenfield run. Each of these was previously enforced only
  // inside readiness-check D3 or planning-integrity C5, which produced
  // vague score deductions instead of precise audit findings that a human
  // can read and fix.
  { id: 'A22', tier: 1, name: 'epic-density', run: axisEpicDensity },
  { id: 'A23', tier: 1, name: 'story-density', run: axisStoryDensity },
  { id: 'A24', tier: 1, name: 'bdd-syntax', run: axisBddSyntax },
  { id: 'A25', tier: 2, name: 'dependency-integrity', run: axisDependencyIntegrity },
  // CB-OBS-23 — surface build-ready-gate + production-evidence inside the
  // plan-output audit so cobolt-review-plan (which consumes the audit via
  // audit-bridge) sees them as first-class review items rather than
  // out-of-band gate runs.
  { id: 'A26', tier: 1, name: 'build-ready-gate', run: axisBuildReadyGate },
  { id: 'A27', tier: 1, name: 'production-evidence-prebuild', run: axisProductionEvidencePrebuild },
];

// ── axis implementations ─────────────────────────────────────────────────

function axisPlanningArtifactAudit(target) {
  const res = runTool(target, 'cobolt-planning-artifact-audit.js', []);
  return classifyPlainRunner(res, 'PLAN-REG');
}

function axisPlanningCensus(target) {
  const res = runTool(target, 'cobolt-planning-census.js', []);
  return classifyPlainRunner(res, 'PLAN-CENSUS');
}

function axisCountParity(target) {
  const res = runTool(target, 'cobolt-planning-count-parity.js', []);
  const text = (res.stdout || '') + (res.stderr || '');
  const drifts = Array.from(text.matchAll(/^\s*-\s*(.+?):\s+distinct=(.+)$/gm)).map((m) => ({
    metric: m[1].trim(),
    distinct: m[2].trim(),
  }));
  const findings = drifts.map((d) => ({
    id: `COUNT-DRIFT:${d.metric}`,
    severity: 'block',
    message: `count drift on ${d.metric}: distinct=${d.distinct}`,
    details: d,
  }));
  const verdict = /verdict:\s*(PASS|DRIFT|FAIL)/i.exec(text)?.[1] || (findings.length ? 'DRIFT' : 'PASS');
  return { status: verdict === 'PASS' ? 'pass' : 'block', findings };
}

function axisPlanningIntegrity(target) {
  return runToolJson(target, 'cobolt-planning-integrity.js', ['check', '--json'], (json) => {
    if (!json || !Array.isArray(json.findings)) return { status: 'error', findings: [] };
    const findings = json.findings.map((f, i) => ({
      id: `${f.contract?.id || f.contractId || 'C?'}(${f.contract?.defect || f.defect || 'D?'}):${f.contract?.name || f.name || i}`,
      severity: f.severity || 'warn',
      message: f.message || f.detail || `${f.contract?.name || f.name || 'planning-integrity'} finding`,
      details: {
        contract: f.contract || {
          id: f.contractId,
          defect: f.defect,
          name: f.name,
          tier: f.tier,
        },
        group: f.contract?.group || f.group,
      },
    }));
    const hasBlock = findings.some((f) => f.severity === 'block');
    const hasWarn = findings.some((f) => f.severity === 'warn');
    return { status: hasBlock ? 'block' : hasWarn ? 'warn' : 'pass', findings };
  });
}

function axisArtifactParity(target) {
  return runToolJson(target, 'cobolt-artifact-parity.js', ['check', 'all', '--json'], (json) => {
    if (!Array.isArray(json)) return { status: 'error', findings: [] };
    const findings = [];
    for (const entry of json) {
      if (entry.status === 'fail') {
        for (const f of entry.findings || [])
          findings.push({
            id: `${entry.check}:${f.class || 'unknown'}`,
            severity: f.severity === 'critical' ? 'block' : 'block',
            message: f.message || `${entry.check} parity failure`,
            details: f,
          });
      }
    }
    return { status: findings.length ? 'block' : 'pass', findings };
  });
}

function axisSourceCoverage(target) {
  return runToolJson(target, 'cobolt-source-coverage.js', ['check', '--threshold', '100', '--json'], (json) => {
    if (!json) return { status: 'error', findings: [] };
    if (json.skipped) return { status: 'skipped', findings: [] };
    if (json.passed) return { status: 'pass', findings: [] };
    return {
      status: 'block',
      findings: [
        {
          id: 'SRC-COV',
          severity: 'block',
          message: `Source coverage ${json.coverage}% < threshold ${json.threshold}%`,
          details: { unmatched: (json.unmatched || []).slice(0, 20) },
        },
      ],
    };
  });
}

function axisFeatureCoverage(target) {
  return runToolJson(target, 'cobolt-feature-coverage.js', ['check', '--stage', 'final', '--json'], (json) => {
    if (!json) return { status: 'error', findings: [] };
    const findings = [];
    for (const issue of json.issues || [])
      findings.push({
        id: `FEAT:${issue.class || 'issue'}`,
        severity: 'block',
        message: issue.message,
        details: issue,
      });
    for (const warn of json.warnings || [])
      findings.push({ id: `FEAT:${warn.class || 'warn'}`, severity: 'warn', message: warn.message, details: warn });
    // Packet-level issues from the upstream tool live at json.packetIssues.
    // Without this block, a feature-coverage failure whose only signal is a
    // packet-level problem collapses to an empty-findings block — the audit
    // reports "fail" with no citation. Surface every packet issue as a finding.
    for (const packetIssue of json.packetIssues || []) {
      const entry = typeof packetIssue === 'string' ? { message: packetIssue, class: 'packet' } : packetIssue || {};
      findings.push({
        id: `FEAT:packet-${entry.class || 'issue'}`,
        severity: 'block',
        message: entry.message || 'Unlabeled packet issue',
        details: entry,
      });
    }
    // Source-coverage unmapped entries indicate plan-packet drift from the
    // source docs; warn rather than block (source coverage is advisory during
    // final validation), but still cite each unmapped source so the operator
    // can act on it.
    const sourceCoverage = json.sourceCoverage || {};
    if (Array.isArray(sourceCoverage.unmapped)) {
      for (const entry of sourceCoverage.unmapped) {
        const descriptor = typeof entry === 'string' ? entry : entry?.path || JSON.stringify(entry);
        findings.push({
          id: 'FEAT:source-coverage',
          severity: 'warn',
          message: `Unmapped source: ${descriptor}`,
          details: { sourceCoverage, entry },
        });
      }
    }
    for (const feature of json.features || []) {
      if (feature?.status === 'READY') continue;
      const featureId = feature.featureId || feature.id || '(unknown feature)';
      for (const issue of feature.issues || []) {
        findings.push({
          id: `FEAT:${featureId}`,
          severity: 'block',
          message: `${featureId}: ${issue}`,
          details: {
            featureId,
            title: feature.title,
            status: feature.status,
            issue,
          },
        });
      }
      if ((!feature.issues || feature.issues.length === 0) && feature?.status && feature.status !== 'READY') {
        findings.push({
          id: `FEAT:${featureId}`,
          severity: 'block',
          message: `${featureId}: status ${feature.status}`,
          details: { featureId, title: feature.title, status: feature.status },
        });
      }
    }
    return { status: json.passed ? (findings.length ? 'warn' : 'pass') : 'block', findings };
  });
}

function axisCapabilityGraph(target) {
  return runToolJson(target, 'cobolt-capability-graph.js', ['check', '--stage', 'final', '--json'], (json) => {
    if (!json) return { status: 'error', findings: [] };
    const findings = [];
    for (const i of json.issues || [])
      findings.push({ id: `CAP:${i.class || 'issue'}`, severity: 'block', message: i.message, details: i });
    for (const w of json.warnings || [])
      findings.push({ id: `CAP:${w.class || 'warn'}`, severity: 'warn', message: w.message, details: w });
    return { status: json.passed ? (findings.length ? 'warn' : 'pass') : 'block', findings };
  });
}

function axisCapabilityContracts(target) {
  return runToolJson(target, 'cobolt-capability-contract.js', ['check', '--stage', 'final', '--json'], (json) => {
    if (!json) return { status: 'error', findings: [] };
    const findings = [];
    for (const feature of json.findings || []) {
      const severity = feature.status === 'BLOCKED' || feature.status === 'MISSING' ? 'block' : 'warn';
      for (const gap of feature.gaps || []) {
        findings.push({
          id: `CAP-CONTRACT:${feature.featureId}`,
          severity: 'block',
          message: `${feature.featureId}: ${gap}`,
          details: feature,
        });
      }
      if (feature.status === 'DRAFT_ONLY') {
        findings.push({
          id: `CAP-CONTRACT:${feature.featureId}`,
          severity,
          message: `${feature.featureId}: final capability contract is DRAFT_ONLY`,
          details: {
            featureId: feature.featureId,
            warnings: (feature.warnings || []).slice(0, 10),
          },
        });
      }
    }
    const hasBlock = findings.some((finding) => finding.severity === 'block');
    const hasWarn = findings.some((finding) => finding.severity === 'warn');
    return { status: hasBlock ? 'block' : hasWarn ? 'warn' : 'pass', findings };
  });
}

function axisRtmCensus(target) {
  const res = runTool(target, 'cobolt-rtm.js', ['census']);
  const text = (res.stdout || '') + (res.stderr || '');
  const findings = [];
  const acMatch = text.match(/(\d+)\s+mapped requirement\(s\) have empty acceptance_criteria/i);
  if (acMatch)
    findings.push({
      id: 'RTM-AC-EMPTY',
      severity: 'block',
      message: `${acMatch[1]} mapped requirements have empty acceptance_criteria`,
      details: { rawExtract: acMatch[0] },
    });
  if (res.exitCode !== 0 && findings.length === 0)
    findings.push({
      id: 'RTM-CENSUS',
      severity: 'block',
      message: 'rtm census exited non-zero',
      details: { exitCode: res.exitCode },
    });
  return { status: findings.length ? 'block' : 'pass', findings };
}

function axisRtmReferences(target) {
  const res = runTool(target, 'cobolt-rtm.js', ['validate-references']);
  const text = (res.stdout || '') + (res.stderr || '');
  const phantomCount = Array.from(text.matchAll(/phantoms=\s*(\d+)/g)).reduce((acc, m) => acc + Number(m[1] || 0), 0);
  const findings = [];
  if (phantomCount > 0)
    findings.push({
      id: 'RTM-PHANTOM-REF',
      severity: 'block',
      message: `${phantomCount} phantom FR/NFR references across consumer artifacts`,
      details: { tailStdout: text.split('\n').slice(-20).join('\n') },
    });
  const status = phantomCount === 0 && res.exitCode === 0 ? 'pass' : 'block';
  return { status, findings };
}

function axisReadinessCheck(target) {
  return runToolJson(target, 'cobolt-readiness-check.js', ['check', '--json'], (json) => {
    if (!json) return { status: 'error', findings: [] };
    const findings = [];
    for (const dim of json.dimensions || []) {
      if (dim.hardFail)
        findings.push({
          id: `READY:${dim.dimension}`,
          severity: 'block',
          message: `${dim.dimension} ${dim.name}: hard fail (score ${dim.score})`,
          details: { findings: (dim.findings || []).slice(0, 20) },
        });
      else if (dim.score < 6)
        findings.push({
          id: `READY:${dim.dimension}`,
          severity: 'warn',
          message: `${dim.dimension} ${dim.name}: low score ${dim.score}`,
          details: { findings: (dim.findings || []).slice(0, 10) },
        });
    }
    return {
      status: json.verdict === 'PASS' ? 'pass' : findings.some((f) => f.severity === 'block') ? 'block' : 'warn',
      findings,
    };
  });
}

function axisPromiseCensus(target) {
  return runToolJson(target, 'cobolt-promise-census.js', ['census', '--json'], (json) => {
    if (!json) return { status: 'error', findings: [] };
    const findings = (json.findings || []).map((f) => ({
      id: `PROMISE:${f.class || 'issue'}`,
      severity: f.severity === 'high' ? 'block' : 'warn',
      message: f.message,
      details: f,
    }));
    const status =
      json.status === 'pass'
        ? 'pass'
        : findings.some((x) => x.severity === 'block')
          ? 'block'
          : findings.length
            ? 'warn'
            : 'pass';
    return { status, findings };
  });
}

function axisSpecQuality(target) {
  return runToolJson(target, 'cobolt-spec-quality.js', ['verify', '--json'], (json) => {
    if (!json) return { status: 'error', findings: [] };
    if (json.status === 'skipped') return { status: 'skipped', findings: [] };

    const findings = (json.findings || []).map((finding) => {
      const classId = finding.class || 'issue';
      const cloneRatio = Number(finding.cloneRatio || 0);
      const severity =
        classId === 'executable-prd-clone' && cloneRatio >= 0.8
          ? 'block'
          : finding.severity === 'critical'
            ? 'block'
            : 'warn';
      return {
        id: `SPEC-QUAL:${classId}`,
        severity,
        message: finding.message || 'spec-quality reported issues',
        details: finding,
      };
    });

    const status = findings.some((finding) => finding.severity === 'block')
      ? 'block'
      : findings.length > 0
        ? 'warn'
        : 'pass';

    return { status, findings };
  });
}

function axisTautologyScan(target) {
  const res = runTool(target, 'cobolt-tautology-scan.js', ['scan', '--json']);
  if (res.exitCode === 0) return { status: 'pass', findings: [] };
  if (res.exitCode === 2) return { status: 'skipped', findings: [] };
  return {
    status: 'warn',
    findings: [
      {
        id: 'TAUT',
        severity: 'warn',
        message: 'tautology-scan reported tautological assertions',
        details: { stdoutTail: (res.stdout || '').slice(-500) },
      },
    ],
  };
}

function axisCheckpointContradiction(target) {
  const planningDir = path.join(target, '_cobolt-output', 'latest', 'planning');
  const progressPath = path.join(planningDir, 'checkpoints', 'planning-progress.json');
  const phase5Path = path.join(planningDir, 'checkpoints', 'phase5-build-authorization.json');
  if (!fs.existsSync(progressPath) || !fs.existsSync(phase5Path)) return { status: 'skipped', findings: [] };
  const progress = safeJson(progressPath);
  const phase5 = safeJson(phase5Path);
  const findings = [];
  if (progress?.nextSkill && phase5?.planningComplete === true) {
    findings.push({
      id: 'CHECKPOINT-CONTRADICTION',
      severity: 'block',
      message: `planning-progress.json says nextSkill=${JSON.stringify(progress.nextSkill)} but phase5-build-authorization.json says planningComplete=true`,
      details: { progressNextSkill: progress.nextSkill, phase5Complete: phase5.planningComplete },
    });
  }
  if (phase5?.planningComplete === true && !phase5?.gates) {
    findings.push({
      id: 'PHASE5-GATE-AUDIT',
      severity: 'warn',
      message: 'phase5-build-authorization.json declares planningComplete but carries no gates audit trail',
      details: { phase5Keys: Object.keys(phase5 || {}) },
    });
  }
  return {
    status: findings.some((f) => f.severity === 'block') ? 'block' : findings.length ? 'warn' : 'pass',
    findings,
  };
}

function axisStateArtifactRegistration(target) {
  const statePath = path.join(target, 'cobolt-state.json');
  const planningDir = path.join(target, '_cobolt-output', 'latest', 'planning');
  if (!fs.existsSync(statePath) || !fs.existsSync(planningDir)) return { status: 'skipped', findings: [] };
  const state = safeJson(statePath);
  const registered = Object.keys(state?.planningArtifacts || {}).length;
  const diskFiles = countRegistryRelevantPlanningFiles(planningDir);
  const findings = [];
  if (diskFiles >= 10 && registered < Math.ceil(diskFiles * 0.25))
    findings.push({
      id: 'STATE-REG-DRIFT',
      severity: 'warn',
      message: `cobolt-state.planningArtifacts registered=${registered} but planning/ has ${diskFiles} files (ratio < 25%)`,
      details: { registered, diskFiles, threshold: '25%' },
    });
  return { status: findings.length ? 'warn' : 'pass', findings };
}

function axisDiagramDuplication(target) {
  const root = path.join(target, '_cobolt-output', 'latest', 'architecture-diagrams');
  const candidates = [
    path.join(root, 'target', 'mermaid'),
    path.join(root, 'current', 'mermaid'),
    path.join(root, 'mermaid'),
  ];
  const mermaidDir = candidates.find((p) => fs.existsSync(p));
  if (!mermaidDir) return { status: 'skipped', findings: [] };
  const byNodes = new Map();
  for (const f of fs.readdirSync(mermaidDir).filter((x) => x.endsWith('.mmd'))) {
    const text = fs.readFileSync(path.join(mermaidDir, f), 'utf8');
    const nodes = new Set(Array.from(text.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*[[(<{"]/gm)).map((m) => m[1]));
    const key = [...nodes].sort().join('|');
    if (!byNodes.has(key)) byNodes.set(key, []);
    byNodes.get(key).push(f);
  }
  const findings = [];
  for (const [, files] of byNodes) {
    if (files.length < 2) continue;
    findings.push({
      id: 'DIAGRAM-DUP',
      severity: 'block',
      message: `${files.length} diagrams share identical node set`,
      details: { files },
    });
  }
  return { status: findings.length ? 'block' : 'pass', findings };
}

function axisUxSectionCompleteness(target) {
  return runToolJson(target, 'cobolt-ux-completeness.js', ['check', '--json'], (json) => {
    if (!json) return { status: 'error', findings: [] };
    if (json.verdict === 'SKIP') return { status: 'skipped', findings: [] };
    const findings = (json.findings || []).map((finding) => ({
      id: `UX:${finding.key || finding.class || 'finding'}`,
      severity: 'block',
      message: finding.message || `${finding.label || 'UX section'} is missing or shallow`,
      details: finding,
    }));
    return { status: json.verdict === 'PASS' ? 'pass' : 'block', findings };
  });
}

function axisMilestoneDocConsistency(target) {
  const planning = path.join(target, '_cobolt-output', 'latest', 'planning');
  if (!fs.existsSync(planning)) return { status: 'skipped', findings: [] };
  const milestoneIds = canonicalMilestoneIds(planning);
  if (milestoneIds.length === 0) return { status: 'skipped', findings: [] };
  const canonicalCount = milestoneIds.length;
  const docs = ['master-plan.md', 'cross-milestone-analysis.md', 'milestones.md', 'traceability-matrix.md'];
  const findings = [];

  for (const file of docs) {
    const filePath = path.join(planning, file);
    if (!fs.existsSync(filePath)) continue;
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const claims = milestoneCountClaims(line);
      for (const claim of claims) {
        if (claim.count === canonicalCount) continue;
        findings.push({
          id: `MILESTONE-COUNT:${file}:${index + 1}`,
          severity: 'block',
          message: `${file}:${index + 1} claims ${claim.count} milestone(s), but canonical planning has ${canonicalCount} (${milestoneIds.join(', ')})`,
          details: {
            file,
            line: index + 1,
            text: line.trim(),
            claimedCount: claim.count,
            canonicalCount,
            canonicalMilestones: milestoneIds,
            reason: claim.reason,
          },
        });
      }
    }
  }

  return { status: findings.length ? 'block' : 'pass', findings };
}

function axisStoryImplementationQuality(target) {
  return runToolJson(target, 'cobolt-prebuild-validate.js', ['--check', 'v2', '--json'], (json) => {
    if (!json) return { status: 'error', findings: [] };
    const result = (json.results || []).find((entry) => entry.check === 'v2') || {};
    const failures = result.failures || [];
    const findings = failures
      .filter((failure) => failure.severity === 'critical' || failure.severity === 'high')
      .map((failure) => ({
        id: `STORY-QUALITY:${failure.id || 'failure'}`,
        severity: 'block',
        message: failure.message || 'Story/spec implementation-quality gate failed',
        details: failure,
      }));
    return { status: findings.length ? 'block' : 'pass', findings };
  });
}

// ── CB-OBS-22 new axes ───────────────────────────────────────────────────

function axisEpicDensity(target) {
  try {
    const { PreflightChecker } = require('./cobolt-preflight');
    const checker = new PreflightChecker(target);
    const result = checker.validateEpicDensity();
    const findings = [];
    const warnings = [];
    for (const epic of result.epics || []) {
      if (epic.status === 'failed') {
        findings.push({
          id: `EPIC-DENSITY:${epic.id}`,
          severity: 'block',
          message: `Epic ${epic.id} density FAILED — ${epic.storyCount} stories x ${epic.frCount} FRs (avg ${epic.avgFrPerStory ?? 'n/a'}/story)`,
          details: epic,
        });
      } else if (epic.status === 'warning') {
        warnings.push({
          id: `EPIC-DENSITY-WARN:${epic.id}`,
          severity: 'warn',
          message: `Epic ${epic.id} density WARNING — ${epic.storyCount} stories x ${epic.frCount} FRs (avg ${epic.avgFrPerStory ?? 'n/a'}/story)`,
          details: epic,
        });
      }
    }
    if (result.passed && findings.length === 0) return { status: 'pass', findings: [], warnings };
    return { status: findings.length ? 'block' : 'pass', findings, warnings };
  } catch (err) {
    return {
      status: 'error',
      findings: [{ id: 'EPIC-DENSITY', severity: 'warn', message: err.message }],
      warnings: [],
    };
  }
}

function axisStoryDensity(target) {
  try {
    const { PreflightChecker } = require('./cobolt-preflight');
    const checker = new PreflightChecker(target);
    const result = checker.validateMilestoneStoryDensity();
    const findings = (result.milestones || [])
      .filter((m) => m.status === 'failed')
      .map((m) => ({
        id: `STORY-DENSITY:${m.id}`,
        severity: 'block',
        message: `Milestone ${m.id} story density FAILED — ${m.frCount} FRs x ${m.storyCount} stories (avg ${m.avgFrPerStory ?? 'n/a'}/story)`,
        details: m,
      }));
    const warnings = (result.milestones || [])
      .filter((m) => m.status === 'warning')
      .map((m) => ({
        id: `STORY-DENSITY-WARN:${m.id}`,
        severity: 'warn',
        message: `Milestone ${m.id} story density WARNING — ${m.frCount} FRs x ${m.storyCount} stories (avg ${m.avgFrPerStory ?? 'n/a'}/story)`,
        details: m,
      }));
    // v0.61 (D02): surface evidence: 'absent' / 'partial' as a block finding
    // instead of treating an empty milestones array as a pass. Pre-fix, when
    // validateMilestoneStoryDensity returned passed:false + milestones:[] +
    // evidence:'absent' (no planning dir, missing story-tracker, or no
    // milestone assignments), the .filter(status==='failed') produced an
    // empty findings array and the next branch returned status:'pass' — the
    // canonical vacuous-pass anti-pattern. Now: missing evidence is its own
    // STORY-DENSITY-EVIDENCE finding so the audit caller does not silently
    // green the axis.
    if (result.passed === false && (result.milestones || []).length === 0) {
      const evidenceLabel = result.evidence || 'absent';
      findings.push({
        id: 'STORY-DENSITY-EVIDENCE',
        severity: 'block',
        message: `Story density check produced no milestone evidence (${evidenceLabel}) — ${result.message || 'no detail'}`,
        details: { evidence: evidenceLabel, message: result.message },
      });
    }
    if (result.passed && result.failing.length === 0 && findings.length === 0) {
      return { status: 'pass', findings: [], warnings };
    }
    return { status: findings.length ? 'block' : 'pass', findings, warnings };
  } catch (err) {
    return {
      status: 'error',
      findings: [{ id: 'STORY-DENSITY', severity: 'warn', message: err.message }],
      warnings: [],
    };
  }
}

function axisBddSyntax(target) {
  // CB-OBS-22 — every story must carry a Given/When/Then block in epics.md
  // OR its per-story spec file, otherwise the BDD contract is missing and
  // acceptance-criteria gates cannot validate behaviour.
  try {
    const pd = path.join(target, '_cobolt-output', 'latest', 'planning');
    const epicsPath = path.join(pd, 'epics.md');
    const trackerPath = path.join(pd, 'story-tracker.json');
    if (!fs.existsSync(epicsPath) || !fs.existsSync(trackerPath)) return { status: 'skipped', findings: [] };
    const tracker = safeJson(trackerPath) || {};
    const epics = fs.readFileSync(epicsPath, 'utf8');
    const gherkinStories = new Set();
    const blocks = Array.from(
      epics.matchAll(/^###\s+(E\d+[A-Z]*-S\d+|LANDING-S\d+)\b([\s\S]*?)(?=^###\s+|^##\s+|^---\s*$)/gim),
    );
    for (const b of blocks) {
      if (/\b(Given|When|Then)\b/i.test(b[0])) gherkinStories.add(b[1].toUpperCase());
    }
    const storiesDir = path.join(pd, 'stories');
    if (fs.existsSync(storiesDir)) {
      for (const file of fs.readdirSync(storiesDir)) {
        if (!file.endsWith('.md')) continue;
        const content = fs.readFileSync(path.join(storiesDir, file), 'utf8');
        if (/\b(Given|When|Then)\b/i.test(content)) {
          const match = file.match(/^([A-Za-z0-9_]+-S\d+)/i);
          if (match) gherkinStories.add(match[1].toUpperCase());
        }
      }
    }
    const missing = [];
    for (const s of tracker.stories || []) {
      const id = String(s.id || '').toUpperCase();
      if (!id) continue;
      if (!gherkinStories.has(id)) missing.push(id);
    }
    if (missing.length === 0) return { status: 'pass', findings: [] };
    return {
      status: 'block',
      findings: [
        {
          id: 'BDD-MISSING',
          severity: 'block',
          message: `${missing.length} stor${missing.length === 1 ? 'y' : 'ies'} lack Given/When/Then acceptance blocks`,
          details: { missing: missing.slice(0, 10), total: missing.length },
        },
      ],
    };
  } catch (err) {
    return { status: 'error', findings: [{ id: 'BDD-SYNTAX', severity: 'warn', message: err.message }] };
  }
}

function axisDependencyIntegrity(target) {
  // CB-OBS-22 — story dependencies must be bidirectional. If A depends on B,
  // B must list A in dependents/blocks. Unilateral declarations cause the
  // build scheduler to sequence work out of order.
  try {
    const pd = path.join(target, '_cobolt-output', 'latest', 'planning');
    const trackerPath = path.join(pd, 'story-tracker.json');
    if (!fs.existsSync(trackerPath)) return { status: 'skipped', findings: [] };
    const tracker = safeJson(trackerPath) || {};
    const ids = new Set((tracker.stories || []).map((s) => String(s.id || '').toUpperCase()).filter(Boolean));
    const findings = [];
    for (const s of tracker.stories || []) {
      const sid = String(s.id || '').toUpperCase();
      const dependsOn = (s.dependsOn || []).map((x) => String(x).toUpperCase());
      const blockedBy = (s.blockedBy || []).map((x) => String(x).toUpperCase());
      const dependents = (s.dependents || []).map((x) => String(x).toUpperCase());
      const blocks = (s.blocks || []).map((x) => String(x).toUpperCase());

      for (const dep of dependsOn) {
        if (!ids.has(dep)) {
          findings.push({
            id: `DEP-PHANTOM:${sid}->${dep}`,
            severity: 'warn',
            message: `${sid}.dependsOn references unknown story ${dep}`,
          });
          continue;
        }
        const depStory = (tracker.stories || []).find((x) => String(x.id || '').toUpperCase() === dep);
        const reverse = [...(depStory?.dependents || []), ...(depStory?.blocks || [])].map((x) =>
          String(x).toUpperCase(),
        );
        if (!reverse.includes(sid)) {
          findings.push({
            id: `DEP-UNILATERAL:${sid}->${dep}`,
            severity: 'warn',
            message: `${sid}.dependsOn ${dep} but ${dep}.dependents/blocks does not mention ${sid}`,
          });
        }
      }
      for (const dep of blockedBy) {
        if (!ids.has(dep)) {
          findings.push({
            id: `DEP-PHANTOM:${sid}->${dep}`,
            severity: 'warn',
            message: `${sid}.blockedBy references unknown story ${dep}`,
          });
        }
      }
      for (const dep of dependents) {
        if (!ids.has(dep)) {
          findings.push({
            id: `DEP-PHANTOM:${sid}->${dep}`,
            severity: 'warn',
            message: `${sid}.dependents references unknown story ${dep}`,
          });
        }
      }
      for (const dep of blocks) {
        if (!ids.has(dep)) {
          findings.push({
            id: `DEP-PHANTOM:${sid}->${dep}`,
            severity: 'warn',
            message: `${sid}.blocks references unknown story ${dep}`,
          });
        }
      }
    }
    return { status: findings.length ? 'warn' : 'pass', findings };
  } catch (err) {
    return { status: 'error', findings: [{ id: 'DEPENDENCY-INTEGRITY', severity: 'warn', message: err.message }] };
  }
}

// CB-OBS-23 — plan-review should see build-ready-gate + production-evidence

function axisBuildReadyGate(target) {
  return runToolJson(target, 'cobolt-build-ready-gate.js', ['--autonomous', '--json'], (json) => {
    if (!json) return { status: 'error', findings: [] };
    if (json.verdict === 'READY') return { status: 'pass', findings: [] };
    const findings = [];
    for (const missing of json.stillMissing || []) {
      findings.push({
        id: `BUILD-READY-MISSING:${missing.id || missing.path || 'artifact'}`,
        severity: 'block',
        message: `build-ready-gate: missing required artifact ${missing.id || missing.path}`,
        details: missing,
      });
    }
    for (const problem of json.contentDepthProblems || []) {
      findings.push({
        id: `BUILD-READY-DEPTH:${problem.check || 'depth'}`,
        severity: problem.severity === 'critical' ? 'block' : 'warn',
        message: `build-ready-gate: ${problem.check} score ${problem.score}/${problem.minScore}`,
        details: problem,
      });
    }
    if (findings.length === 0) {
      findings.push({
        id: 'BUILD-READY-VERDICT',
        severity: 'warn',
        message: `build-ready-gate verdict=${json.verdict}`,
        details: { verdict: json.verdict, cycles: json.cycles },
      });
    }
    const blocked = findings.some((f) => f.severity === 'block');
    return { status: blocked ? 'block' : 'warn', findings };
  });
}

function axisProductionEvidencePrebuild(target) {
  // production-evidence requires a milestone — pick the first milestone
  // from milestone-tracker.json. Skip gracefully if no milestones exist yet.
  let milestone = null;
  try {
    const pd = path.join(target, '_cobolt-output', 'latest', 'planning');
    const mtree = safeJson(path.join(pd, 'milestone-tracker.json'));
    const first = Array.isArray(mtree?.milestones) ? mtree.milestones[0] : null;
    milestone = first?.id || first?.milestoneId || null;
  } catch {
    milestone = null;
  }
  if (!milestone) return { status: 'skipped', findings: [] };

  return runToolJson(
    target,
    'cobolt-production-evidence.js',
    ['check', '--phase', 'prebuild', '--milestone', milestone, '--json'],
    (json) => {
      if (!json) return { status: 'error', findings: [] };
      const score = Number(json.score || 0);
      const minScore = Number(json.minScore || 90);
      if (score >= minScore) return { status: 'pass', findings: [] };
      const findings = (json.blockers || []).slice(0, 20).map((b, i) => ({
        id: `PROD-EVIDENCE-BLOCKER:${b.id || b.dimension || i}`,
        severity: 'block',
        message: `production-evidence prebuild: ${b.label || b.message || b.id || 'blocker'}`,
        details: b,
      }));
      if (findings.length === 0 && score < minScore) {
        findings.push({
          id: 'PROD-EVIDENCE-SCORE',
          severity: 'block',
          message: `production-evidence prebuild score ${score}/${minScore}`,
          details: { score, minScore, milestone },
        });
      }
      return { status: 'block', findings };
    },
  );
}

// ── shared helpers ───────────────────────────────────────────────────────

function canonicalMilestoneIds(planningDir) {
  const ids = new Set();
  const tracker = safeJson(path.join(planningDir, 'milestone-tracker.json'));
  const trackerMilestones = Array.isArray(tracker?.milestones)
    ? tracker.milestones
    : tracker?.milestones && typeof tracker.milestones === 'object'
      ? Object.values(tracker.milestones)
      : [];
  for (const milestone of trackerMilestones) {
    const id = normalizeMilestoneId(milestone?.id || milestone?.milestoneId || milestone?.milestone);
    if (id) ids.add(id);
  }

  const milestonesMd = path.join(planningDir, 'milestones.md');
  if (fs.existsSync(milestonesMd)) {
    const text = fs.readFileSync(milestonesMd, 'utf8');
    for (const match of text.matchAll(/^#{1,4}\s+(?:Milestone\s+)?(M\d+)\b/gim)) {
      const id = normalizeMilestoneId(match[1]);
      if (id) ids.add(id);
    }
  }

  return [...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

function normalizeMilestoneId(value) {
  const match = String(value || '').match(/^M?(\d+)$/i);
  return match ? `M${Number.parseInt(match[1], 10)}` : null;
}

function milestoneCountClaims(line) {
  const claims = [];
  const text = String(line || '');
  if (/critical\s+path|parallel\s+wave|parallel\s+group/i.test(text)) return claims;

  for (const match of text.matchAll(/\b(\d+)\s+(?:total\s+)?milestones?\b/gi)) {
    claims.push({ count: Number.parseInt(match[1], 10), reason: 'numeric milestone prose claim' });
  }

  for (const match of text.matchAll(/\b(\d+)\s+phases?\s*=\s*(\d+)\s+milestones?\b/gi)) {
    claims.push({ count: Number.parseInt(match[2], 10), reason: 'phase-to-milestone equivalence claim' });
  }

  const frontmatter = text.match(/^\s*milestoneCount:\s*(\d+)\s*$/i);
  if (frontmatter) {
    claims.push({ count: Number.parseInt(frontmatter[1], 10), reason: 'frontmatter milestoneCount' });
  }

  return claims.filter((claim) => Number.isFinite(claim.count));
}

function classifyPlainRunner(res, idPrefix) {
  if (res.exitCode === 0) return { status: 'pass', findings: [] };
  return {
    status: 'block',
    findings: [
      {
        id: `${idPrefix}-FAIL`,
        severity: 'block',
        message: `tool exited ${res.exitCode}`,
        details: { stdoutTail: (res.stdout || '').slice(-500), stderrTail: (res.stderr || '').slice(-500) },
      },
    ],
  };
}

function runTool(cwd, toolName, args) {
  const toolPath = path.join(TOOLS_DIR, toolName);
  try {
    const stdout = execFileSync(process.execPath, [toolPath, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 90_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout?.toString?.() || '',
      stderr: err.stderr?.toString?.() || err.message || '',
    };
  }
}

function extractFirstJson(raw) {
  const text = raw || '';
  const firstBrace = text.search(/[[{]/);
  if (firstBrace < 0) return null;
  const candidate = text.slice(firstBrace);
  try {
    return JSON.parse(candidate);
  } catch {
    try {
      // strip shell-reset trailer that some wrappers emit
      return JSON.parse(candidate.split('Shell cwd was reset')[0]);
    } catch {
      return null;
    }
  }
}

function processToolResult(res, parse, toolLabel) {
  // Some CoBolt tools violate the exit-code contract by writing structured
  // failure JSON to stderr instead of stdout (e.g., cobolt-capability-contract
  // before the stdout-fail fix). Parse stdout first, fall back to stderr so
  // their findings are not dropped in the meantime.
  let json = extractFirstJson(res.stdout);
  if (json === null) json = extractFirstJson(res.stderr);
  try {
    const parsed = parse(json);
    // If the subprocess failed AND we surfaced no findings, include the raw
    // stderr as a finding so the axis never collapses to a silent "block" or
    // "error" status with zero citations.
    if (res.exitCode !== 0 && parsed && Array.isArray(parsed.findings) && parsed.findings.length === 0) {
      const stderrTail = (res.stderr || '').slice(0, 4096);
      if (stderrTail.trim().length > 0) {
        parsed.findings.push({
          id: 'TOOL:raw-stderr',
          severity: 'block',
          message: `${toolLabel} exited ${res.exitCode} with stderr but no structured findings`,
          details: { stderr: stderrTail },
        });
      }
    }
    return { ...parsed, exitCode: res.exitCode };
  } catch (err) {
    return {
      status: 'error',
      findings: [
        {
          id: 'PARSE',
          severity: 'block',
          message: `parse error: ${err.message}`,
          details: { stderr: (res.stderr || '').slice(0, 500) },
        },
      ],
      exitCode: res.exitCode,
    };
  }
}

function runToolJson(cwd, toolName, args, parse) {
  const res = runTool(cwd, toolName, args);
  return processToolResult(res, parse, toolName);
}

function safeJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function _countFiles(dir, depth) {
  let n = 0;
  const walk = (d, left) => {
    if (left < 0) return;
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, e.name);
        if (e.isDirectory()) walk(fp, left - 1);
        else n += 1;
      }
    } catch {
      /* ignore */
    }
  };
  walk(dir, depth);
  return n;
}

function countRegistryRelevantPlanningFiles(planningDir) {
  const excludedDirs = new Set([
    '_versions',
    'bc-deltas',
    'capability-contracts',
    'feature-dossiers',
    'quality',
    'self-critique',
    'stories',
    'story-specs',
  ]);
  let count = 0;
  const walk = (dir, depth) => {
    if (depth < 0) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (excludedDirs.has(entry.name)) continue;
        walk(full, depth - 1);
      } else {
        count += 1;
      }
    }
  };
  walk(planningDir, 2);
  return count;
}

// ── main ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { target: process.cwd(), outDir: null, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--target') out.target = path.resolve(argv[++i]);
    else if (a === '--out') out.outDir = path.resolve(argv[++i]);
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  if (!out.outDir) out.outDir = path.join(out.target, '_cobolt-output', 'audit', 'plan-output-audit');
  return out;
}

function printHelp() {
  console.log('CoBolt Plan-Pipeline Output Audit (deep harness)');
  console.log('');
  console.log('Usage:');
  console.log('  node tools/cobolt-plan-output-audit.js [--target <dir>] [--out <dir>] [--json]');
  console.log('');
  console.log('Exit codes:');
  console.log('  0  all Tier 1 axes pass');
  console.log('  1  hard error / usage');
  console.log('  2  missing optional dependency');
  console.log('  4  at least one Tier 1 axis has a block finding');
}

function normalizePlanReviewSeverity(severity) {
  return severity === 'block' ? 'critical' : severity === 'warn' ? 'advisory' : 'info';
}

function loadPlanReviewTaxonomyMetadata() {
  const fallback = { taxonomyVersion: '1.0.0', classIds: new Set() };
  try {
    const parsed = JSON.parse(fs.readFileSync(PLAN_REVIEW_TAXONOMY_PATH, 'utf8'));
    return {
      taxonomyVersion: parsed?.taxonomyVersion || fallback.taxonomyVersion,
      classIds: new Set((parsed?.classes || []).map((entry) => entry.id).filter(Boolean)),
    };
  } catch {
    return fallback;
  }
}

function inferTaxonomyClassIds(result, finding, knownClassIds) {
  const inferred = new Set(AXIS_TAXONOMY_CLASS_MAP[result.id] || []);
  const text = `${finding?.id || ''} ${finding?.message || ''}`.toLowerCase();

  if (/placeholder|stub|shallow|thin|minimum|missing section/i.test(text)) {
    inferred.add('A2');
  }
  if (/phantom|missing reference|not in prd|unknown requirement|unknown feature/i.test(text)) {
    inferred.add('B3');
  }
  if (/count drift|story count|milestone count|distinct=/i.test(text)) {
    inferred.add('C3');
  }
  if (/sprint|story density|epic density|milestone tracker|story-tracker/i.test(text)) {
    inferred.add('C3');
    inferred.add('F2');
  }
  if (/sprint plan|planning census|planning-count-parity|planning-counts/i.test(text)) {
    inferred.add('C3');
    inferred.add('F2');
  }
  if (/promise|dependency|package\.json|library/i.test(text)) {
    inferred.add('C4');
  }
  if (/reverse dependenc|downstream dependenc|upstream dependenc/i.test(text)) {
    inferred.add('C4');
    inferred.add('A5');
  }
  if (/trace|coverage|rtm|source coverage/i.test(text)) {
    inferred.add('B3');
    inferred.add('F2');
  }
  if (/traceability|trackability|single source of truth|canonical source|registry of record/i.test(text)) {
    inferred.add('B2');
    inferred.add('C1');
    inferred.add('C3');
  }
  if (/tautolog/i.test(text)) {
    inferred.add('D2');
  }
  if (/clone|boilerplate|template|duplicat|spec[- ]?quality|spec-kite|spec kite/i.test(text)) {
    inferred.add('D3');
  }
  if (/bdd|given\/when\/then/i.test(text)) {
    inferred.add('F2');
    inferred.add('A2');
  }
  if (/design document|design spec|ux design|wireframe/i.test(text)) {
    inferred.add('A2');
    inferred.add('F2');
  }
  if (/config|configuration|env var|settings drift/i.test(text)) {
    inferred.add('C2');
    inferred.add('C5');
  }
  if (/coverage|missing source|unmatched|dimension/i.test(text)) {
    inferred.add('F2');
  }

  return [...inferred].filter((classId) => knownClassIds.size === 0 || knownClassIds.has(classId));
}

function collectAuditTaxonomyFindings(results) {
  const taxonomy = loadPlanReviewTaxonomyMetadata();
  const findings = [];

  for (const result of results) {
    for (const finding of result.findings || []) {
      for (const classId of inferTaxonomyClassIds(result, finding, taxonomy.classIds)) {
        findings.push({
          classId,
          severity: normalizePlanReviewSeverity(finding.severity),
          artifact: `plan-output-audit/${result.id}`,
          evidence: {
            axisId: result.id,
            axisName: result.name,
            findingId: finding.id,
            message: finding.message,
            details: finding.details || {},
          },
          remediationHint: `Resolve the ${result.name} audit finding before build handoff.`,
          detectorId: 'plan-output-audit',
          title: finding.id || result.name,
          details: {
            axisTier: result.tier,
            axisStatus: result.status,
            durationMs: result.durationMs,
          },
        });
      }
    }
  }

  const byClass = {};
  for (const finding of findings) {
    byClass[finding.classId] = (byClass[finding.classId] || 0) + 1;
  }

  return {
    taxonomyVersion: taxonomy.taxonomyVersion,
    findingCount: findings.length,
    byClass,
    findings,
  };
}

function buildAuditReport(options = {}) {
  const opts = {
    target: path.resolve(options.target || process.cwd()),
    outDir: options.outDir ? path.resolve(options.outDir) : null,
    json: options.json === true,
  };
  const planningDir = path.join(opts.target, '_cobolt-output', 'latest', 'planning');
  if (!fs.existsSync(planningDir)) {
    throw new Error(`[plan-output-audit] no planning dir at ${planningDir}`);
  }
  const results = [];
  for (const axis of AXES) {
    const start = Date.now();
    let out;
    try {
      out = axis.run(opts.target, opts);
    } catch (err) {
      out = {
        status: 'error',
        findings: [{ id: axis.id, severity: 'block', message: err.message, details: { stack: err.stack } }],
      };
    }
    out.id = axis.id;
    out.name = axis.name;
    out.tier = axis.tier;
    out.durationMs = Date.now() - start;
    results.push(out);
    console.error(
      `[${axis.id}] ${axis.name} — ${out.status} (${out.findings?.length || 0} findings, ${out.durationMs}ms)`,
    );
  }

  const tier1Blocks = results.filter((r) => r.tier === 1 && r.status === 'block');
  const tier2Issues = results.filter((r) => r.tier === 2 && (r.status === 'warn' || r.status === 'block'));
  const errors = results.filter((r) => r.status === 'error');

  const report = {
    generatedAt: new Date().toISOString(),
    target: opts.target,
    summary: {
      axes: results.length,
      pass: results.filter((r) => r.status === 'pass').length,
      warn: results.filter((r) => r.status === 'warn').length,
      block: results.filter((r) => r.status === 'block').length,
      error: errors.length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      tier1Blocks: tier1Blocks.length,
      tier2Issues: tier2Issues.length,
    },
    verdict: tier1Blocks.length > 0 ? 'FAIL' : errors.length > 0 ? 'ERROR' : 'PASS',
    results,
  };
  report.taxonomy = collectAuditTaxonomyFindings(results);
  return report;
}

function writeAuditReport(report, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, 'audit-report.json');
  const mdPath = path.join(outDir, 'audit-report.md');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdPath, renderMarkdown(report));
  return { jsonPath, mdPath };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return 0;
  }
  let report;
  let paths;
  try {
    report = buildAuditReport(opts);
    paths = writeAuditReport(report, opts.outDir);
  } catch (err) {
    console.error(String(err.message || err));
    return 1;
  }

  if (opts.json) process.stdout.write(JSON.stringify(report, null, 2));
  else {
    console.log('');
    console.log(`verdict: ${report.verdict}`);
    console.log(`tier-1 blocks: ${report.summary.tier1Blocks}`);
    console.log(`tier-2 issues: ${report.summary.tier2Issues}`);
    console.log(`report json:   ${paths.jsonPath}`);
    console.log(`report md:     ${paths.mdPath}`);
  }

  if (report.verdict === 'FAIL') return 4;
  if (report.verdict === 'ERROR') return 1;
  return 0;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Plan-Pipeline Deep Audit Report');
  lines.push('');
  lines.push(`- Target: \`${report.target}\``);
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Verdict: **${report.verdict}**`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| metric | count |');
  lines.push('|---|---|');
  for (const [k, v] of Object.entries(report.summary)) lines.push(`| ${k} | ${v} |`);
  lines.push('');
  lines.push('## Axes');
  lines.push('');
  for (const r of report.results) {
    lines.push(`### ${r.id} — ${r.name} (tier ${r.tier}) — ${r.status}`);
    lines.push('');
    if (!r.findings || r.findings.length === 0) {
      lines.push('_no findings_');
    } else {
      for (const f of r.findings) {
        lines.push(`- **${f.severity}** \`${f.id}\`: ${f.message}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

if (require.main === module) process.exitCode = main();

module.exports = {
  AXES,
  runTool,
  runToolJson,
  processToolResult,
  extractFirstJson,
  parseArgs,
  main,
  buildAuditReport,
  writeAuditReport,
  collectAuditTaxonomyFindings,
  countRegistryRelevantPlanningFiles,
  canonicalMilestoneIds,
  milestoneCountClaims,
};
