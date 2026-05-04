#!/usr/bin/env node

// CoBolt Brownfield Evidence Index — Deterministic evidence linking
//
// Builds 19-evidence-index.json by scanning brownfield output artifacts
// and linking findings to their source tools, agents, and artifacts.
// Replaces P3 Step 3.5 LLM synthesis.
//
// Usage:
//   node tools/cobolt-brownfield-evidence-index.js build [--dir <path>]
//   node tools/cobolt-brownfield-evidence-index.js build --json
//
// Exit codes:
//   0 = success
//   1 = no artifacts found

const fs = require('node:fs');
const path = require('node:path');
const { buildProvenance } = require('./_brownfield-provenance');
const { loadOrBuildToolReliabilityReport } = require('./_brownfield-tool-reliability');
const { getBrownfieldArtifactApplicability, loadJson } = require('./_brownfield-readiness-utils');

const { paths: _paths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();

function brownfieldDir() {
  const p = typeof _paths === 'function' ? _paths() : null;
  if (p) return path.join(p.outputRoot, 'latest', 'brownfield');
  return path.join(process.cwd(), '_cobolt-output/latest/brownfield');
}

// ── Artifact Registry ───────────────────────────────────────

const ARTIFACT_SOURCES = [
  // Tool-produced (deterministic)
  { pattern: 'tech-scan.json', source: 'cobolt-legacy-scan', type: 'tool', phase: 'P0' },
  { pattern: 'health-scan.json', source: 'cobolt-health', type: 'tool', phase: 'P0' },
  { pattern: 'security-scan.json', source: 'cobolt-scan', type: 'tool', phase: 'P0' },
  { pattern: 'sbom.json', source: 'cobolt-sbom', type: 'tool', phase: 'P0' },
  { pattern: 'health-score.json', source: 'cobolt-brownfield-health-score', type: 'tool', phase: 'P0' },
  { pattern: 'runtime-truth.json', source: 'cobolt-runtime-truth', type: 'tool', phase: 'P0' },

  // Agent-produced (LLM)
  { pattern: '01-intake-and-classification.md', source: 'orchestrator', type: 'synthesis', phase: 'P0' },
  { pattern: '02-baseline-health-and-scan-summary.md', source: 'orchestrator', type: 'synthesis', phase: 'P0' },
  { pattern: '03-project-context.md', source: 'cobolt-generate-project-context', type: 'agent', phase: 'P0' },
  { pattern: '03a-domain-knowledge-base.md', source: 'orchestrator', type: 'synthesis', phase: 'P0' },
  { pattern: '03b-project-knowledge-base.md', source: 'orchestrator', type: 'synthesis', phase: 'P0' },
  { pattern: '03c-project-skills-manifest.md', source: 'orchestrator', type: 'synthesis', phase: 'P0' },
  { pattern: '04-feature-and-module-inventory.md', source: 'code-archaeologist-agent', type: 'agent', phase: 'P1' },
  { pattern: '05-database-and-data-store-report.md', source: 'db-archaeologist-agent', type: 'agent', phase: 'P1' },
  { pattern: '06-integration-map.md', source: 'integration-discovery-agent', type: 'agent', phase: 'P1' },
  { pattern: '07-configuration-and-access-audit.md', source: 'config-archaeologist-agent', type: 'agent', phase: 'P1' },
  {
    pattern: '08a-visual-route-inventory.json',
    source: 'cobolt-playwright',
    type: 'tool',
    phase: 'P1',
    condition: 'ui',
  },
  {
    pattern: '08b-design-token-candidates.json',
    source: 'cobolt-design-token-extract',
    type: 'tool',
    phase: 'P1',
    condition: 'ui',
  },
  {
    pattern: '08c-visual-system-brief.md',
    source: 'orchestrator',
    type: 'synthesis',
    phase: 'P1',
    condition: 'ui',
  },
  {
    pattern: '08-ui-and-workflow-catalog.md',
    source: 'ui-archaeologist-agent',
    type: 'agent',
    phase: 'P1',
    condition: 'ui',
  },
  {
    pattern: '09-supply-chain-and-vulnerability-review.md',
    source: 'supply-chain-auditor',
    type: 'agent',
    phase: 'P1',
  },
  { pattern: '10-discovery-tracker.json', source: 'orchestrator', type: 'tracker', phase: 'P1' },
  { pattern: '11-dependency-tracker.json', source: 'orchestrator', type: 'tracker', phase: 'P1' },
  { pattern: '12-security-and-quality-assessment.md', source: 'security-reviewer', type: 'agent', phase: 'P1' },
  { pattern: 'domain-liveness.json', source: 'cobolt-route-wiring-check', type: 'tool', phase: 'P1' },
  {
    pattern: 'query-migration-contract.json',
    source: 'cobolt-query-migration-contract',
    type: 'tool',
    phase: 'P1',
  },
  { pattern: 'semantic-stub-findings.json', source: 'cobolt-semantic-stub-check', type: 'tool', phase: 'P1' },
  {
    pattern: 'ui-placeholder-mock-scan.json',
    source: 'cobolt-ui-placeholder-check',
    type: 'tool',
    phase: 'P1',
    condition: 'ui',
  },
  {
    pattern: '16a-forensic-findings.json',
    source: 'orchestrator',
    type: 'tracker',
    phase: 'P2.5',
    condition: 'forensicAudit',
  },
  {
    pattern: '16b-illusion-inventory.json',
    source: 'cobolt-illusion-scan',
    type: 'tool',
    phase: 'P2.5',
    condition: 'forensicAudit',
  },
  {
    pattern: '16c-illusion-verification.json',
    source: 'illusion-detector',
    type: 'agent',
    phase: 'P2.5',
    condition: 'forensicAudit',
  },
  {
    pattern: '16d-forensic-audit-report.md',
    source: 'orchestrator',
    type: 'synthesis',
    phase: 'P2.5',
    condition: 'forensicAudit',
  },
  {
    pattern: '16e-phantom-rejection-log.json',
    source: 'finding-verifier',
    type: 'tracker',
    phase: 'P2.5',
    condition: 'forensicAudit',
  },
  {
    pattern: '16f-dead-code-inventory.md',
    source: 'cobolt-code-reviewer',
    type: 'agent',
    phase: 'P2.5',
    condition: 'forensicAudit',
  },
  {
    pattern: '16g-architecture-quality-review.md',
    source: 'architecture-reviewer',
    type: 'agent',
    phase: 'P2.5',
    condition: 'forensicAudit',
  },
  {
    pattern: '16h-design-quality-assessment.md',
    source: 'design-orchestrator',
    type: 'agent',
    phase: 'P2.5',
    condition: 'ui+forensicAudit',
  },
  { pattern: '13-architecture-recovery.md', source: 'code-archaeologist-agent', type: 'agent', phase: 'P2' },
  { pattern: '14-business-rules-and-validation.md', source: 'rule-extractor-agent', type: 'agent', phase: 'P2' },
  { pattern: '15-feature-triage-matrix.md', source: 'feature-triage-agent', type: 'agent', phase: 'P2' },
  { pattern: '16-issues-registry.json', source: 'orchestrator', type: 'registry', phase: 'P3' },
  { pattern: '17-enhancement-advisory.md', source: 'enhancement-advisor', type: 'agent', phase: 'P3' },
  { pattern: '18-modernization-roadmap.md', source: 'orchestrator', type: 'synthesis', phase: 'P3' },
  { pattern: 'phase-P3-gap-report.json', source: 'cobolt-brownfield-gap-review', type: 'tracker', phase: 'P3' },
  { pattern: '23-master-assessment.md', source: 'orchestrator', type: 'synthesis', phase: 'P3' },
  {
    pattern: 'phase-P3-accuracy-report.json',
    source: 'cobolt-brownfield-accuracy-review',
    type: 'tracker',
    phase: 'P3',
  },
  {
    pattern: 'brownfield-tool-health.json',
    source: 'cobolt-brownfield-tool-health',
    type: 'tracker',
    phase: 'P3',
  },
];

// ── Builder ─────────────────────────────────────────────────

function buildEvidenceIndex(bfDir) {
  const issuesData = loadJson(path.join(bfDir, '16-issues-registry.json'));
  const accuracyData =
    loadJson(path.join(bfDir, 'phase-P3-accuracy-report.json')) || loadJson(path.join(bfDir, 'phase-P3-accuracy.json'));
  const toolReliability = loadOrBuildToolReliabilityReport(bfDir, { write: true });
  const reliabilityByArtifact = new Map(
    (Array.isArray(toolReliability.artifacts) ? toolReliability.artifacts : []).map((entry) => [entry.artifact, entry]),
  );
  const applicability = getBrownfieldArtifactApplicability(bfDir, issuesData, accuracyData);
  const applicableArtifacts = ARTIFACT_SOURCES.filter((artifact) => applicability.shouldCount(artifact.condition));
  const ignoredArtifacts = ARTIFACT_SOURCES.filter((artifact) => !applicability.shouldCount(artifact.condition)).map(
    (artifact) => artifact.pattern,
  );
  const entries = [];
  let found = 0;
  const integrity = { valid: true, invalidEntries: 0, issues: [] };

  for (const artifact of applicableArtifacts) {
    const fp = path.join(bfDir, artifact.pattern);
    if (!fs.existsSync(fp)) continue;

    found++;
    const stat = fs.statSync(fp);
    const entry = {
      artifact: artifact.pattern,
      path: fp,
      source: artifact.source,
      sourceType: artifact.type,
      phase: artifact.phase,
      sizeBytes: stat.size,
      size: stat.size,
      lastModified: stat.mtime.toISOString(),
      relatedDocs: [],
      relatedIssues: [],
      confidence: artifact.type === 'tool' ? 1.0 : 0.85,
    };

    const reliability = reliabilityByArtifact.get(artifact.pattern);
    if (reliability) {
      entry.reliabilityStatus = reliability.status;
      entry.trustScore = reliability.trustScore;
      entry.reliabilityWarnings = reliability.warnings || [];
      entry.reliabilityIssues = reliability.issues || [];
    }

    // Cross-reference: if it's a JSON file, try to extract finding counts
    if (artifact.pattern.endsWith('.json') && stat.size < 5 * 1024 * 1024) {
      try {
        const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (data.findings) entry.findingCount = data.findings.length;
        if (data.components) entry.componentCount = data.components.length;
        if (data.requirements) entry.requirementCount = Object.keys(data.requirements).length;
        if (data.issues) entry.issueCount = data.issues.length;
      } catch {
        /* not parseable */
      }
    }

    // Cross-reference: if it's markdown, count prefixed findings
    if (artifact.pattern.endsWith('.md') && stat.size < 2 * 1024 * 1024) {
      try {
        const content = fs.readFileSync(fp, 'utf8');
        const prefixes = [
          'FEAT-',
          'DATA-',
          'INTG-',
          'CONF-',
          'AUTH-',
          'UI-',
          'SCA-',
          'SEC-',
          'SCAN-',
          'ARCH-',
          'DEBT-',
          'ENH-',
          'PERF-',
        ];
        let findingCount = 0;
        for (const prefix of prefixes) {
          const matches = content.match(new RegExp(`${prefix}\\d+`, 'g'));
          if (matches) findingCount += new Set(matches).size;
        }
        if (findingCount > 0) entry.findingCount = findingCount;
      } catch {
        /* ignore */
      }
    }

    entries.push(entry);
  }

  for (const entry of entries) {
    if (entry.sizeBytes <= 0) {
      integrity.valid = false;
      integrity.invalidEntries++;
      integrity.issues.push({ artifact: entry.artifact, issue: 'empty-artifact-size' });
    }
  }

  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-brownfield-evidence-index',
    ...buildProvenance(
      bfDir,
      entries.map((entry) => path.join(bfDir, entry.artifact)),
    ),
    artifactCount: found,
    totalExpected: applicableArtifacts.length,
    completeness:
      found > 0 && applicableArtifacts.length > 0 ? Math.round((found / applicableArtifacts.length) * 100) : 0,
    context: {
      analysisMode: applicability.assessmentMode,
      forensicAuditRequired: applicability.forensicAuditRequired,
      uiRelevant: applicability.uiRelevant,
      toolReliability: {
        status: toolReliability.status,
        trustScore: toolReliability.trustScore,
        degradedArtifacts: toolReliability.degradedArtifacts,
      },
      ignoredArtifacts,
    },
    integrity,
    entries,
  };
}

// ── CLI ─────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === 'build') {
    const dirIdx = args.indexOf('--dir');
    const bfDir = dirIdx !== -1 && args[dirIdx + 1] ? args[dirIdx + 1] : brownfieldDir();
    const jsonMode = args.includes('--json');

    const index = buildEvidenceIndex(bfDir);

    if (jsonMode) {
      console.log(JSON.stringify(index, null, 2));
    } else {
      console.log('[cobolt-brownfield-evidence-index] Evidence Index');
      console.log(`  Artifacts found: ${index.artifactCount}/${index.totalExpected} (${index.completeness}%)`);
      console.log('');
      for (const e of index.entries) {
        const extra = e.findingCount ? ` (${e.findingCount} findings)` : '';
        console.log(`  [${e.phase}] ${e.artifact} — ${e.source} (${e.sourceType})${extra}`);
      }
    }

    // Write output
    const outPath = path.join(bfDir, '19-evidence-index.json');
    const outDir = path.dirname(outPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
    if (!jsonMode) console.log(`\n  Written: ${outPath}`);

    process.exit(index.artifactCount > 0 ? 0 : 1);
  } else {
    console.log('CoBolt Brownfield Evidence Index — Deterministic evidence linking');
    console.log('');
    console.log('Usage:');
    console.log('  node tools/cobolt-brownfield-evidence-index.js build [--dir <path>] [--json]');
    console.log('');
    console.log('Scans brownfield output artifacts and builds 19-evidence-index.json.');
    process.exit(cmd ? 2 : 0);
  }
}

module.exports = { buildEvidenceIndex };
