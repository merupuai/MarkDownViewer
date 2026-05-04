#!/usr/bin/env node

// cobolt-analysis-handoff.js
//
// Build analysis-handoff.json, analysis-decision-log.md, feature-health.json,
// the final analysis report, and the consolidated pipeline report from the
// analysis packet and (if present) analysis-findings.json.
//
// MVP scope: read-only pipeline. When no analysis-findings.json is present
// (because reviewer waves are deferred to Phase 2), this tool still produces
// a complete handoff with featureHealth.grade = "UNKNOWN" and
// recommendedNextStep.skill = "none". The consolidated pipeline report
// explicitly states that reviewer waves were not run.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function analysisDir(projectRoot, analysisId) {
  return path.join(projectRoot, '_cobolt-output', 'latest', 'analysis', analysisId);
}

function reportsDir(projectRoot) {
  return path.join(projectRoot, '_cobolt-output', 'reports', 'analysis');
}

function loadJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function sha256File(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath);
  return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, value, { mode: 0o600 });
}

function computeIntegrity({ scope, packet, featureMap, manifest }) {
  const checks = [
    { name: 'analysis-scope.json present', passed: Boolean(scope) },
    { name: 'analysis-packet.json present', passed: Boolean(packet) },
    { name: 'feature-map.json present', passed: Boolean(featureMap) },
    { name: 'analysis-manifest.json present', passed: Boolean(manifest) },
  ];
  if (scope) {
    checks.push({
      name: 'scope has at least one evidence entry per in-scope file',
      passed: (scope.files || []).every((f) => Array.isArray(f.scopeEvidence) && f.scopeEvidence.length > 0),
    });
  }
  const passed = checks.every((c) => c.passed);
  return { passed, checks };
}

function gradeFromFindings(findings) {
  // MVP: we only have a placeholder grade when findings are absent.
  // Real grading lands with Phase 2 reviewer waves.
  if (!findings)
    return {
      grade: 'UNKNOWN',
      notes: 'Reviewer waves not yet implemented (MVP). Run reviewer waves to compute a real grade.',
    };
  const counts = findings.summary?.bySeverity || {};
  const critical = counts.critical || 0;
  const high = counts.high || 0;
  const medium = counts.medium || 0;
  if (critical > 0) return { grade: 'F', notes: `${critical} critical finding(s)` };
  if (high >= 5) return { grade: 'D', notes: `${high} high findings` };
  if (high > 0) return { grade: 'C', notes: `${high} high findings` };
  if (medium > 5) return { grade: 'B-', notes: `${medium} medium findings` };
  if (medium > 0) return { grade: 'B', notes: `${medium} medium findings` };
  return { grade: 'A', notes: 'No verified actionable findings.' };
}

function recommendNextStep({ scope, findings, analysisId }) {
  // MVP: no findings → recommend none. Phase 2 will wire fix recommendations.
  if (!findings) {
    return {
      skill: 'none',
      args: '',
      reason:
        'Reviewer waves are not yet implemented in this MVP. Scope discovery, packet, and handoff are available, but no findings were generated. Re-run once reviewer waves are implemented (Phase 2).',
    };
  }
  const fixEligibleCount = findings.summary?.byFixEligibility?.['fix-now'] || 0;
  if (fixEligibleCount > 0) {
    return {
      skill: 'cobolt-fix',
      args: `--analysis ${analysisId}`,
      reason: `${fixEligibleCount} fix-now findings are eligible for automated remediation.`,
    };
  }
  const featCount = (findings.summary?.byPrefix?.FEAT || 0) + (findings.summary?.byPrefix?.ENH || 0);
  if (featCount > 0) {
    return {
      skill: 'cobolt-plan',
      args: `feature`,
      reason: `${featCount} FEAT/ENH findings require planning, not automated fix.`,
    };
  }
  if (scope?.confidence?.belowThreshold) {
    return {
      skill: 'none',
      args: '',
      reason: 'Scope confidence is below threshold. Refine with --include/--exclude/--from-prd.',
    };
  }
  return { skill: 'none', args: '', reason: 'No actionable findings detected.' };
}

function buildReportMarkdown({ scope, packet: _packet, findings, handoff, featureHealth, mode }) {
  const lines = [];
  lines.push(`# Feature Analysis Report — ${scope.feature.query}`);
  lines.push('');
  lines.push(`- **Analysis ID**: ${scope.analysisId}`);
  lines.push(`- **Invocation mode**: ${mode}`);
  lines.push(`- **Feature health**: ${featureHealth.grade} — ${featureHealth.notes || ''}`);
  lines.push(`- **Scope confidence**: ${scope.confidence.overall}% (threshold ${scope.confidence.threshold ?? 70}%)`);
  lines.push(`- **Files in scope**: ${scope.files.length}`);
  lines.push(`- **Candidate files**: ${scope.candidateFiles.length}`);
  lines.push(`- **Surfaces**: ${scope.surfaces.join(', ') || '(none)'}`);
  lines.push('');

  lines.push('## Executive Summary');
  lines.push('');
  if (findings) {
    const s = findings.summary || {};
    lines.push(`- Total findings: ${s.total || 0}`);
    lines.push(`- Verified: ${findings.verification?.verified || 0}`);
    lines.push(`- Phantom rate estimate: ${findings.verification?.estimatedPhantomRate || 0}%`);
  } else {
    lines.push(
      '- Reviewer waves not yet implemented (MVP). This report covers scope discovery and packet generation only.',
    );
    lines.push('- See TRD Section 22 (Recommended First Implementation) and Phase 2 of the implementation plan.');
  }
  lines.push('');

  lines.push('## Scope Summary');
  lines.push('');
  lines.push(`- Seed terms: ${scope.seedTerms.join(', ')}`);
  if (scope.requirements.length > 0) {
    lines.push(`- Linked requirements: ${scope.requirements.map((r) => r.id).join(', ')}`);
  }
  lines.push('');

  lines.push('## Implemented (in scope, evidence present)');
  lines.push('');
  for (const file of scope.files.slice(0, 50)) {
    lines.push(`- \`${file.path}\` — ${file.surface} (${file.confidence}%)`);
  }
  if (scope.files.length > 50) {
    lines.push(`- … ${scope.files.length - 50} more (see analysis-scope.json)`);
  }
  lines.push('');

  if (scope.candidateFiles.length > 0) {
    lines.push('## Unverified (candidate files — below confidence threshold)');
    lines.push('');
    for (const file of scope.candidateFiles.slice(0, 25)) {
      lines.push(`- \`${file.path}\` — ${file.surface} (${file.confidence}%)`);
    }
    lines.push('');
  }

  lines.push('## Recommended Next Step');
  lines.push('');
  if (handoff.recommendedNextStep.skill === 'none') {
    lines.push(`- ${handoff.recommendedNextStep.reason}`);
  } else {
    lines.push(
      `- \`${handoff.recommendedNextStep.skill} ${handoff.recommendedNextStep.args}\` — ${handoff.recommendedNextStep.reason}`,
    );
  }
  lines.push('');

  lines.push('## Evidence Appendix');
  lines.push('');
  lines.push(
    `- Scope: \`${path.relative(process.cwd(), path.join(scope.sourceRoot, '_cobolt-output', 'latest', 'analysis', scope.analysisId, 'analysis-scope.json')).replace(/\\/g, '/')}\``,
  );
  lines.push(
    `- Packet: \`${path.relative(process.cwd(), path.join(scope.sourceRoot, '_cobolt-output', 'latest', 'analysis', scope.analysisId, `${scope.analysisId}-analysis-packet.md`)).replace(/\\/g, '/')}\``,
  );
  lines.push(
    `- Handoff: \`${path.relative(process.cwd(), path.join(scope.sourceRoot, '_cobolt-output', 'latest', 'analysis', scope.analysisId, 'analysis-handoff.json')).replace(/\\/g, '/')}\``,
  );
  lines.push('');

  return lines.join('\n');
}

function buildPipelineReportMarkdown({ scope, handoff, featureHealth, mode, findings }) {
  const lines = [];
  lines.push(`# Consolidated Analysis Pipeline Report`);
  lines.push('');
  lines.push(`- **Feature**: ${scope.feature.query}`);
  lines.push(`- **Analysis ID**: ${scope.analysisId}`);
  lines.push(`- **Invocation mode**: ${mode}`);
  lines.push(`- **Feature health**: ${featureHealth.grade}`);
  lines.push(`- **Scope confidence**: ${scope.confidence.overall}%`);
  lines.push('');

  lines.push('## Scope Summary');
  lines.push('');
  lines.push(`- Files in scope: ${scope.files.length}`);
  lines.push(`- Candidate files: ${scope.candidateFiles.length}`);
  lines.push(`- Surfaces: ${scope.surfaces.join(', ') || '(none)'}`);
  lines.push(`- Seed source: ${scope.seedSource || 'text'}`);
  lines.push('');

  lines.push('## Deterministic Check Summary');
  lines.push('');
  lines.push('- Source file manifest: built');
  lines.push('- Feature scope: computed');
  lines.push('- Analysis packet: built');
  lines.push('- Feature map: built');
  lines.push('- Analysis handoff: built');
  lines.push('- Reviewer waves: **not yet implemented (Phase 2)**');
  lines.push('- API contract validation: **not yet implemented (Phase 2)**');
  lines.push('- Runtime proof collection: **not yet implemented (Phase 4)**');
  lines.push('');

  lines.push('## Reviewer Summary');
  lines.push('');
  lines.push(
    'Reviewer waves are not implemented in this MVP. See docs/FEATURE-ANALYSIS-TECHNICAL-REQUIREMENTS.md Section 22 and Phase 2 of the implementation plan.',
  );
  lines.push('');

  lines.push('## Verified Findings');
  lines.push('');
  if (findings?.findings && findings.findings.length > 0) {
    for (const f of findings.findings.slice(0, 20)) {
      lines.push(`- [${f.severity}] ${f.prefix}: ${f.title} — \`${f.file}\``);
    }
  } else {
    lines.push('None. Reviewer waves have not been implemented.');
  }
  lines.push('');

  lines.push('## Fix Handoff Summary');
  lines.push('');
  lines.push(
    `- Recommended next step: ${handoff.recommendedNextStep.skill === 'none' ? 'none' : `\`${handoff.recommendedNextStep.skill} ${handoff.recommendedNextStep.args}\``}`,
  );
  lines.push(`- Reason: ${handoff.recommendedNextStep.reason}`);
  lines.push('');

  lines.push('## Unresolved Risks and Carry-Forward Items');
  lines.push('');
  lines.push('- Reviewer waves: to be implemented in Phase 2.');
  lines.push('- Fix handoff chaining (`cobolt-fix --analysis`): to be implemented in Phase 3.');
  lines.push('- Autonomous `--auto` chaining: to be implemented in Phase 3.');
  lines.push('- SARIF export, background jobs, runtime proof: to be implemented in Phase 4.');
  lines.push('');

  lines.push('## Exact Next Command (if user action remains)');
  lines.push('');
  if (scope.confidence.belowThreshold) {
    lines.push('```');
    lines.push(`cobolt-cli analyse "${scope.feature.query}" --scope-preview --include <path> --exclude <path>`);
    lines.push('```');
    lines.push('Refine scope and try again.');
  } else {
    lines.push('Await Phase 2 (reviewer waves) for actionable next commands.');
  }
  lines.push('');

  lines.push('## Artifact Index');
  lines.push('');
  lines.push(`- \`_cobolt-output/latest/analysis/${scope.analysisId}/analysis-scope.json\``);
  lines.push(`- \`_cobolt-output/latest/analysis/${scope.analysisId}/${scope.analysisId}-analysis-packet.json\``);
  lines.push(`- \`_cobolt-output/latest/analysis/${scope.analysisId}/${scope.analysisId}-analysis-packet.md\``);
  lines.push(`- \`_cobolt-output/latest/analysis/${scope.analysisId}/feature-map.json\``);
  lines.push(`- \`_cobolt-output/latest/analysis/${scope.analysisId}/analysis-manifest.json\``);
  lines.push(`- \`_cobolt-output/latest/analysis/${scope.analysisId}/analysis-handoff.json\``);
  lines.push(`- \`_cobolt-output/latest/analysis/${scope.analysisId}/${scope.analysisId}-analysis-report.md\``);
  lines.push(`- \`_cobolt-output/reports/analysis/${scope.analysisId}-analysis-pipeline-report.md\``);
  lines.push('');

  return lines.join('\n');
}

/**
 * Build handoff + final report + consolidated pipeline report.
 * @param {object} options
 * @param {string} options.analysisId
 * @param {string} [options.projectRoot]
 * @param {'report-only'|'scope-preview'|'auto'} [options.mode='report-only']
 */
function buildAnalysisHandoff(options) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const analysisId = options.analysisId;
  if (!analysisId) throw new Error('buildAnalysisHandoff requires options.analysisId');
  const mode = options.mode || 'report-only';

  const dir = analysisDir(projectRoot, analysisId);
  const scopePath = path.join(dir, 'analysis-scope.json');
  const packetPath = path.join(dir, `${analysisId}-analysis-packet.json`);
  const featureMapPath = path.join(dir, 'feature-map.json');
  const manifestPath = path.join(dir, 'analysis-manifest.json');
  const findingsPath = path.join(dir, 'analysis-findings.json');

  const scope = loadJson(scopePath);
  const packet = loadJson(packetPath);
  const featureMap = loadJson(featureMapPath);
  const manifest = loadJson(manifestPath);
  const findings = loadJson(findingsPath); // may be null in MVP

  if (!scope || !packet || !featureMap || !manifest) {
    throw new Error(`Missing analysis artifacts for ${analysisId}. Run scope discovery and packet build first.`);
  }

  const integrity = computeIntegrity({ scope, packet, featureMap, manifest });
  const featureHealth = gradeFromFindings(findings);
  const nextStep = recommendNextStep({ scope, findings, analysisId });

  const handoff = {
    version: '1.0.0',
    analysisId,
    feature: scope.feature,
    generatedAt: new Date().toISOString(),
    sourceRoot: projectRoot,
    analysisDir: path.relative(projectRoot, dir).replace(/\\/g, '/'),
    integrity,
    summary: {
      filesInScope: scope.files.length,
      candidateFiles: scope.candidateFiles.length,
      confidence: scope.confidence.overall,
      surfaces: scope.surfaces,
      totalFindings: findings?.summary?.total || 0,
      blockingFindings: (findings?.summary?.bySeverity?.critical || 0) + (findings?.summary?.bySeverity?.high || 0),
      deferredGaps: findings?.summary?.byFixEligibility?.['defer-to-plan'] || 0,
    },
    findings: {
      path: findings ? path.relative(projectRoot, findingsPath).replace(/\\/g, '/') : '',
      hash: findings ? sha256File(findingsPath) : undefined,
      fixEligibleCount: findings?.summary?.byFixEligibility?.['fix-now'] || 0,
    },
    featureHealth,
    inputReferences: {
      scopePath: path.relative(projectRoot, scopePath).replace(/\\/g, '/'),
      packetPath: path.relative(projectRoot, packetPath).replace(/\\/g, '/'),
      featureMapPath: path.relative(projectRoot, featureMapPath).replace(/\\/g, '/'),
      manifestPath: path.relative(projectRoot, manifestPath).replace(/\\/g, '/'),
    },
    recommendedNextStep: nextStep,
    autoMode: mode === 'auto',
    fixInvocation: {
      enabled: nextStep.skill === 'cobolt-fix',
      // FIX (#5): clean up the nested ternary. When nextStep.skill is
      // cobolt-fix, the CLI command is always `cobolt-cli fix <args>`.
      command: nextStep.skill === 'cobolt-fix' ? `cobolt-cli fix ${nextStep.args}`.trim() : '',
    },
  };

  // Remove `hash` key if it's undefined (schema tolerates absence but not undefined in JSON)
  if (!handoff.findings.hash) delete handoff.findings.hash;

  const handoffPath = path.join(dir, 'analysis-handoff.json');
  writeJson(handoffPath, handoff);

  const featureHealthPath = path.join(dir, 'feature-health.json');
  writeJson(featureHealthPath, {
    version: '1.0.0',
    analysisId,
    generatedAt: new Date().toISOString(),
    grade: featureHealth.grade,
    notes: featureHealth.notes,
  });

  const reportMd = buildReportMarkdown({ scope, packet, findings, handoff, featureHealth, mode });
  const reportPath = path.join(dir, `${analysisId}-analysis-report.md`);
  writeText(reportPath, reportMd);

  const pipelineMd = buildPipelineReportMarkdown({ scope, handoff, featureHealth, mode, findings });
  const pipelinePath = path.join(reportsDir(projectRoot), `${analysisId}-analysis-pipeline-report.md`);
  writeText(pipelinePath, pipelineMd);

  // Decision log
  const decisionLogPath = path.join(dir, 'analysis-decision-log.md');
  const decisionLogLines = [
    `# Analysis Decision Log — ${analysisId}`,
    '',
    `- **Feature**: ${scope.feature.query}`,
    `- **Mode**: ${mode}`,
    `- **Integrity**: ${integrity.passed ? 'PASS' : 'FAIL'}`,
    `- **Grade**: ${featureHealth.grade}`,
    `- **Next step**: ${nextStep.skill}${nextStep.args ? ` ${nextStep.args}` : ''}`,
    `- **Reason**: ${nextStep.reason}`,
    '',
  ];
  writeText(decisionLogPath, decisionLogLines.join('\n'));

  return {
    analysisId,
    handoffPath,
    reportPath,
    pipelinePath,
    featureHealthPath,
    decisionLogPath,
    integrityPassed: integrity.passed,
    grade: featureHealth.grade,
    recommendedNextStep: nextStep,
  };
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('--help')) {
    process.stdout.write(
      'cobolt-analysis-handoff --analysis-id <id> [--path <dir>] [--mode report-only|scope-preview|auto]\n',
    );
    return 0;
  }
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--analysis-id' && args[i + 1]) options.analysisId = args[++i];
    else if (args[i] === '--path' && args[i + 1]) options.projectRoot = args[++i];
    else if (args[i] === '--mode' && args[i + 1]) options.mode = args[++i];
  }
  try {
    const result = buildAnalysisHandoff(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`cobolt-analysis-handoff failed: ${err.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = {
  buildAnalysisHandoff,
  computeIntegrity,
  gradeFromFindings,
  recommendNextStep,
  _main: main,
};
