#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { resolveReadablePlanningDir, safeReadJson } = require('../lib/cobolt-planning-artifacts');

const SECTIONS = Object.freeze([
  {
    id: 'foundation',
    title: 'Foundation',
    artifacts: [
      { id: 'prd', label: 'PRD', kind: 'file', path: 'prd.md', core: true },
      {
        id: 'source-document-consolidation',
        label: 'Source Document Consolidation',
        kind: 'file',
        path: 'source-document-consolidation.md',
        core: true,
      },
      { id: 'project-knowledge', label: 'Project Knowledge Base', kind: 'file', path: 'project-knowledge-base.md' },
      { id: 'domain-knowledge', label: 'Domain Knowledge Base', kind: 'file', path: 'domain-knowledge-base.md' },
    ],
  },
  {
    id: 'feature-packet',
    title: 'Feature Packet',
    artifacts: [
      { id: 'feature-registry', label: 'Feature Registry', kind: 'file', path: 'feature-registry.json', core: true },
      {
        id: 'feature-dossiers',
        label: 'Feature Dossiers',
        kind: 'dir',
        path: 'feature-dossiers',
        core: true,
        pattern: /\.md$/i,
      },
      {
        id: 'feature-service-blueprints',
        label: 'Feature Service Blueprints',
        kind: 'file',
        path: 'feature-service-blueprints.md',
        core: true,
      },
      {
        id: 'feature-coverage-matrix',
        label: 'Feature Coverage Matrix',
        kind: 'file',
        path: 'feature-coverage-matrix.json',
      },
      {
        id: 'feature-readiness',
        label: 'Feature Readiness Report',
        kind: 'file',
        path: 'feature-readiness-report.json',
        core: true,
      },
      { id: 'capability-graph', label: 'Capability Graph', kind: 'file', path: 'capability-graph.json' },
      { id: 'surface-impact-matrix', label: 'Surface Impact Matrix', kind: 'file', path: 'surface-impact-matrix.md' },
      {
        id: 'capability-edge-proof-report',
        label: 'Capability Edge Proof Report',
        kind: 'file',
        path: 'capability-edge-proof-report.json',
      },
    ],
  },
  {
    id: 'design-and-contracts',
    title: 'Design And Contracts',
    artifacts: [
      { id: 'architecture', label: 'Architecture Overview', kind: 'file', path: 'architecture.md', core: true },
      { id: 'api-contracts', label: 'API Contracts', kind: 'file', path: 'api-contracts.md' },
      { id: 'data-model', label: 'Data Model Spec', kind: 'file', path: 'data-model-spec.md' },
      { id: 'security-requirements', label: 'Security Requirements', kind: 'file', path: 'security-requirements.md' },
      { id: 'delivery-plan', label: 'Delivery Plan', kind: 'file', path: 'delivery-plan.md' },
    ],
  },
  {
    id: 'delivery-and-readiness',
    title: 'Delivery And Readiness',
    artifacts: [
      { id: 'epics', label: 'Epics', kind: 'file', path: 'epics.md' },
      { id: 'milestones', label: 'Milestones', kind: 'file', path: 'milestones.md', core: true },
      { id: 'story-tracker', label: 'Story Tracker', kind: 'file', path: 'story-tracker.json', core: true },
      { id: 'traceability-matrix', label: 'Traceability Matrix', kind: 'file', path: 'traceability-matrix.md' },
      {
        id: 'cross-milestone-analysis',
        label: 'Cross-Milestone Analysis',
        kind: 'file',
        path: 'cross-milestone-analysis.md',
      },
      { id: 'test-strategy', label: 'Test Strategy', kind: 'file', path: 'test-strategy.md' },
      { id: 'readiness-report', label: 'Readiness Report', kind: 'file', path: 'readiness-report.json', core: true },
      {
        id: 'planning-quality-summary',
        label: 'Planning Quality Summary',
        kind: 'file',
        path: 'planning-quality-summary.json',
      },
      { id: 'quality-artifacts', label: 'Quality Artifacts', kind: 'dir', path: 'quality', pattern: /\.json$/i },
      { id: 'checkpoints', label: 'Planning Checkpoints', kind: 'dir', path: 'checkpoints', pattern: /\.json$/i },
    ],
  },
  {
    id: 'clarification',
    title: 'Clarification',
    artifacts: [
      { id: 'clarification-report', label: 'Clarification Report', kind: 'file', path: 'clarification-report.json' },
      { id: 'source-conflicts', label: 'Source Conflicts', kind: 'file', path: 'source-conflicts.json' },
      { id: 'fr-ambiguity', label: 'FR Ambiguity', kind: 'file', path: 'fr-ambiguity.json' },
      { id: 'ambiguity-ledger', label: 'Ambiguity Ledger', kind: 'file', path: 'ambiguity-ledger.jsonl' },
      { id: 'assumptions-log', label: 'Assumptions Log', kind: 'file', path: 'assumptions-log.md' },
    ],
  },
]);

function usage() {
  return [
    'CoBolt Planning Workspace Index',
    '',
    'Usage:',
    '  node tools/cobolt-planning-workspace-index.js generate [--json] [--planning-dir <path>] [--cwd <path>]',
    '  node tools/cobolt-planning-workspace-index.js --help',
    '',
    'Generates planning-workspace-index.md and planning-workspace-index.json',
    'to summarize the active planning packet, build-readiness signals, and',
    'the recommended next action.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = Array.from(argv);
  const options = {
    command: 'generate',
    json: false,
    cwd: process.cwd(),
    planningDir: null,
    help: false,
  };

  if (args[0] && !args[0].startsWith('-')) {
    options.command = args.shift();
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--cwd') {
      options.cwd = args[++i];
    } else if (arg === '--planning-dir') {
      options.planningDir = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function resolvePlanningDir(options) {
  if (options.planningDir) return path.resolve(options.cwd, options.planningDir);
  return resolveReadablePlanningDir(path.resolve(options.cwd), { allowLatestFallback: true });
}

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/');
}

function relPath(planningDir, filePath) {
  return toPosix(path.relative(planningDir, filePath));
}

function normalizeToken(value, fallback = 'UNKNOWN') {
  const normalized = String(value || fallback)
    .trim()
    .toUpperCase()
    .replace(/[_\s]+/g, '-');
  return normalized || fallback;
}

function sortMilestoneIds(values) {
  return Array.from(new Set((values || []).filter(Boolean))).sort((left, right) => {
    const leftNumber = Number(String(left).replace(/^M/i, ''));
    const rightNumber = Number(String(right).replace(/^M/i, ''));
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
      return leftNumber - rightNumber;
    }
    return String(left).localeCompare(String(right), undefined, { numeric: true });
  });
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function inspectEntry(planningDir, sectionId, definition) {
  const absolutePath = path.join(planningDir, definition.path);
  const stat = safeStat(absolutePath);

  if (definition.kind === 'dir') {
    const files = stat?.isDirectory()
      ? fs
          .readdirSync(absolutePath, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name)
          .filter((name) => !definition.pattern || definition.pattern.test(name))
          .sort()
      : [];

    const sizeBytes = files.reduce((total, name) => {
      const fileStat = safeStat(path.join(absolutePath, name));
      return total + (fileStat ? fileStat.size : 0);
    }, 0);

    return {
      id: definition.id,
      label: definition.label,
      section: sectionId,
      kind: definition.kind,
      path: definition.path,
      required: definition.core === true,
      exists: Boolean(stat?.isDirectory()),
      fileCount: files.length,
      sampleFiles: files.slice(0, 5),
      sizeBytes,
      modifiedAt: stat ? stat.mtime.toISOString() : null,
    };
  }

  return {
    id: definition.id,
    label: definition.label,
    section: sectionId,
    kind: definition.kind,
    path: definition.path,
    required: definition.core === true,
    exists: Boolean(stat?.isFile()),
    sizeBytes: stat ? stat.size : 0,
    modifiedAt: stat ? stat.mtime.toISOString() : null,
  };
}

function collectTrackedArtifacts(planningDir) {
  const sections = [];
  for (const section of SECTIONS) {
    sections.push({
      id: section.id,
      title: section.title,
      artifacts: section.artifacts.map((definition) => inspectEntry(planningDir, section.id, definition)),
    });
  }
  return sections;
}

function readFeatureRegistry(planningDir) {
  const payload = safeReadJson(path.join(planningDir, 'feature-registry.json'));
  const features = Array.isArray(payload?.features) ? payload.features : [];
  const totalFeatures =
    typeof payload?.totalFeatures === 'number' && payload.totalFeatures >= 0 ? payload.totalFeatures : features.length;
  return {
    totalFeatures,
    featureIds: features.map((feature) => String(feature?.featureId || feature?.id || '').trim()).filter(Boolean),
  };
}

function readFeatureReadiness(planningDir) {
  const payload = safeReadJson(path.join(planningDir, 'feature-readiness-report.json'));
  const summary = payload?.summary || {};
  return {
    exists: Boolean(payload),
    passed: payload?.passed === true,
    totalFeatures: Number(summary.totalFeatures || 0),
    readyFeatures: Number(summary.readyFeatures || 0),
    draftOnlyFeatures: Number(summary.draftOnlyFeatures || 0),
    blockedFeatures: Number(summary.blockedFeatures || 0),
  };
}

function readReadinessReport(planningDir) {
  const primary = safeReadJson(path.join(planningDir, 'readiness-report.json'));
  const fallback = safeReadJson(path.join(planningDir, 'readiness-deterministic.json'));
  const payload = primary || fallback;
  return {
    exists: Boolean(payload),
    verdict: normalizeToken(payload?.verdict || 'MISSING'),
    grade: String(payload?.grade || 'unknown'),
  };
}

function readPlanningQualitySummary(planningDir) {
  const payload = safeReadJson(path.join(planningDir, 'planning-quality-summary.json'));
  return {
    exists: Boolean(payload),
    overallStatus: normalizeToken(payload?.overallStatus || 'MISSING'),
    buildAuthorization: normalizeToken(payload?.buildAuthorization || 'UNKNOWN'),
  };
}

function readClarificationReport(planningDir) {
  const payload = safeReadJson(path.join(planningDir, 'clarification-report.json'));
  return {
    exists: Boolean(payload),
    status: normalizeToken(payload?.status || 'MISSING'),
    nextAction: String(payload?.summary?.nextAction || '').trim(),
  };
}

function readStoryTracker(planningDir) {
  const payload = safeReadJson(path.join(planningDir, 'story-tracker.json'));
  const stories = Array.isArray(payload?.stories) ? payload.stories : [];
  return {
    stories,
    storyCount: stories.length,
    milestoneIds: stories.map((story) => String(story?.milestoneId || '').trim()).filter(Boolean),
  };
}

function extractMilestoneIds(planningDir, storyTracker) {
  const ids = [];
  const milestonesText = readText(path.join(planningDir, 'milestones.md'));
  for (const match of milestonesText.matchAll(/^##\s+(M\d+)\b/gi)) {
    ids.push(String(match[1]).toUpperCase());
  }
  ids.push(...(storyTracker?.milestoneIds || []).map((value) => String(value).toUpperCase()));
  return sortMilestoneIds(ids);
}

function collectIssues(inputs) {
  const issues = [];
  const {
    missingCoreArtifacts,
    clarification,
    featureReadiness,
    readiness,
    planningQuality,
    featureRegistry,
    dossierCount,
  } = inputs;

  if (missingCoreArtifacts.length > 0) {
    issues.push({
      severity: 'block',
      source: 'core-packet',
      message: `Missing core planning artifacts: ${missingCoreArtifacts.map((artifact) => artifact.path).join(', ')}`,
    });
  }

  if (featureRegistry.totalFeatures > 0 && dossierCount > 0 && dossierCount < featureRegistry.totalFeatures) {
    issues.push({
      severity: 'warn',
      source: 'feature-dossiers',
      message: `Feature registry declares ${featureRegistry.totalFeatures} feature(s), but only ${dossierCount} dossier file(s) were found.`,
    });
  }

  if (clarification.status === 'BLOCKED') {
    issues.push({
      severity: 'block',
      source: 'clarification',
      message:
        clarification.nextAction || 'Clarification report still contains blocking ambiguity or source conflicts.',
    });
  } else if (clarification.status === 'ATTENTION') {
    issues.push({
      severity: 'warn',
      source: 'clarification',
      message: clarification.nextAction || 'Clarification report requests follow-up before implementation starts.',
    });
  }

  if (
    featureReadiness.exists &&
    (!featureReadiness.passed || featureReadiness.blockedFeatures > 0 || featureReadiness.draftOnlyFeatures > 0)
  ) {
    issues.push({
      severity: 'block',
      source: 'feature-readiness',
      message: `Feature readiness is not clean: ${featureReadiness.readyFeatures} READY, ${featureReadiness.draftOnlyFeatures} DRAFT_ONLY, ${featureReadiness.blockedFeatures} BLOCKED.`,
    });
  }

  if (readiness.exists && readiness.verdict === 'FAIL') {
    issues.push({
      severity: 'block',
      source: 'readiness',
      message: `Readiness report verdict is FAIL (${readiness.grade}).`,
    });
  } else if (readiness.exists && readiness.verdict === 'CONDITIONAL') {
    issues.push({
      severity: 'warn',
      source: 'readiness',
      message: `Readiness report verdict is CONDITIONAL (${readiness.grade}).`,
    });
  }

  if (planningQuality.exists && planningQuality.overallStatus === 'FAIL') {
    issues.push({
      severity: 'block',
      source: 'planning-quality',
      message: 'Planning quality summary contains failing deterministic checks.',
    });
  } else if (planningQuality.exists && planningQuality.overallStatus === 'WARN') {
    issues.push({
      severity: 'warn',
      source: 'planning-quality',
      message: 'Planning quality summary contains warnings or unknown checks.',
    });
  }

  return issues;
}

function deriveNextAction(inputs) {
  const { missingCoreArtifacts, clarification, featureReadiness, readiness, planningQuality, nextMilestone } = inputs;

  if (missingCoreArtifacts.length > 0) {
    return `Re-run planning or resume until the canonical packet is complete. Missing: ${missingCoreArtifacts
      .map((artifact) => artifact.path)
      .join(', ')}.`;
  }

  if (clarification.status === 'BLOCKED') {
    return clarification.nextAction || 'Resolve the clarification report before starting build.';
  }

  if (
    featureReadiness.exists &&
    (!featureReadiness.passed || featureReadiness.blockedFeatures > 0 || featureReadiness.draftOnlyFeatures > 0)
  ) {
    return 'Re-run feature analysis and feature coverage until every feature is READY with no DRAFT_ONLY or BLOCKED entries.';
  }

  if (readiness.exists && readiness.verdict === 'FAIL') {
    return 'Resolve readiness report failures before starting build.';
  }

  if (planningQuality.exists && planningQuality.overallStatus === 'WARN') {
    return 'Review planning-quality-summary.json and tighten the packet before autonomous build.';
  }

  if (nextMilestone) {
    return `Planning packet is ready. Run cobolt-cli build ${nextMilestone} --auto.`;
  }

  return 'Planning packet is ready. Start the first planned milestone build.';
}

function buildReport(planningDir) {
  const sections = collectTrackedArtifacts(planningDir);
  const artifacts = sections.flatMap((section) => section.artifacts);
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const coreArtifacts = artifacts.filter((artifact) => artifact.required);
  const missingCoreArtifacts = coreArtifacts.filter((artifact) => !artifact.exists);

  const featureRegistry = readFeatureRegistry(planningDir);
  const featureReadiness = readFeatureReadiness(planningDir);
  const readiness = readReadinessReport(planningDir);
  const planningQuality = readPlanningQualitySummary(planningDir);
  const clarification = readClarificationReport(planningDir);
  const storyTracker = readStoryTracker(planningDir);
  const milestoneIds = extractMilestoneIds(planningDir, storyTracker);
  const nextMilestone = milestoneIds[0] || null;
  const dossierCount = artifactById.get('feature-dossiers')?.fileCount || 0;
  const qualityArtifactCount = artifactById.get('quality-artifacts')?.fileCount || 0;
  const checkpointCount = artifactById.get('checkpoints')?.fileCount || 0;

  const issues = collectIssues({
    missingCoreArtifacts,
    clarification,
    featureReadiness,
    readiness,
    planningQuality,
    featureRegistry,
    dossierCount,
  });

  const buildAuthorized = missingCoreArtifacts.length === 0 && !issues.some((issue) => issue.severity === 'block');
  const status =
    missingCoreArtifacts.length > 0 ? 'INCOMPLETE' : buildAuthorized && issues.length === 0 ? 'READY' : 'ATTENTION';

  const summary = {
    coreArtifactsPresent: coreArtifacts.length - missingCoreArtifacts.length,
    coreArtifactsExpected: coreArtifacts.length,
    missingCoreArtifacts: missingCoreArtifacts.length,
    featureCount: featureRegistry.totalFeatures,
    dossierCount,
    readyFeatures: featureReadiness.readyFeatures,
    draftOnlyFeatures: featureReadiness.draftOnlyFeatures,
    blockedFeatures: featureReadiness.blockedFeatures,
    milestoneCount: milestoneIds.length,
    storyCount: storyTracker.storyCount,
    clarificationStatus: clarification.status,
    readinessVerdict: readiness.verdict,
    readinessGrade: readiness.grade,
    planningQualityStatus: planningQuality.overallStatus,
    qualityArtifactCount,
    checkpointCount,
    buildAuthorized,
    nextMilestone,
    nextAction: deriveNextAction({
      missingCoreArtifacts,
      clarification,
      featureReadiness,
      readiness,
      planningQuality,
      nextMilestone,
    }),
  };

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    planningDir: toPosix(planningDir),
    status,
    summary,
    issues,
    sections,
  };
}

function renderArtifactLine(artifact) {
  if (!artifact.exists) {
    return `- \`${artifact.path}\` - missing${artifact.required ? ' [core]' : ''}`;
  }

  if (artifact.kind === 'dir') {
    const sample = artifact.sampleFiles.length ? `; sample: ${artifact.sampleFiles.join(', ')}` : '';
    return `- \`${artifact.path}/\` - found (${artifact.fileCount} file(s), ${artifact.sizeBytes} bytes${sample})${
      artifact.required ? ' [core]' : ''
    }`;
  }

  return `- \`${artifact.path}\` - found (${artifact.sizeBytes} bytes)${artifact.required ? ' [core]' : ''}`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Planning Workspace Index');
  lines.push('');
  lines.push(`> Auto-generated by \`node tools/cobolt-planning-workspace-index.js generate\` - ${report.generatedAt}`);
  lines.push('');
  lines.push(`Status: **${report.status}**`);
  lines.push(`Build authorization: **${report.summary.buildAuthorized ? 'YES' : 'NO'}**`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(
    `- Core artifacts present: ${report.summary.coreArtifactsPresent}/${report.summary.coreArtifactsExpected}`,
  );
  lines.push(`- Features: ${report.summary.featureCount}`);
  lines.push(`- Feature dossiers: ${report.summary.dossierCount}`);
  lines.push(
    `- Feature readiness: ${report.summary.readyFeatures} READY, ${report.summary.draftOnlyFeatures} DRAFT_ONLY, ${report.summary.blockedFeatures} BLOCKED`,
  );
  lines.push(`- Milestones: ${report.summary.milestoneCount}`);
  lines.push(`- Stories: ${report.summary.storyCount}`);
  lines.push(`- Clarification status: ${report.summary.clarificationStatus}`);
  lines.push(`- Readiness verdict: ${report.summary.readinessVerdict} (${report.summary.readinessGrade})`);
  lines.push(`- Planning quality: ${report.summary.planningQualityStatus}`);
  lines.push(`- Quality artifacts: ${report.summary.qualityArtifactCount}`);
  lines.push(`- Checkpoints: ${report.summary.checkpointCount}`);
  lines.push('');
  lines.push('## Recommended Next Action');
  lines.push('');
  lines.push(`- ${report.summary.nextAction}`);
  lines.push('');
  lines.push('## Attention Items');
  lines.push('');
  if (report.issues.length === 0) {
    lines.push('- None.');
    lines.push('');
  } else {
    for (const issue of report.issues) {
      lines.push(`- [${issue.severity.toUpperCase()}] ${issue.message}`);
    }
    lines.push('');
  }

  for (const section of report.sections) {
    lines.push(`## ${section.title}`);
    lines.push('');
    for (const artifact of section.artifacts) {
      lines.push(renderArtifactLine(artifact));
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function writeOutputs(planningDir, report, markdown) {
  const jsonPath = path.join(planningDir, 'planning-workspace-index.json');
  const mdPath = path.join(planningDir, 'planning-workspace-index.md');
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, markdown, 'utf8');
  return { jsonPath, mdPath };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${usage()}\n`);
    process.exit(1);
  }

  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  if (options.command !== 'generate') {
    process.stderr.write(`Unknown command: ${options.command}\n\n${usage()}\n`);
    process.exit(1);
  }

  const planningDir = resolvePlanningDir(options);
  if (!planningDir || !fs.existsSync(planningDir)) {
    process.stderr.write('Planning directory not found.\n');
    process.exit(1);
  }

  const report = buildReport(planningDir);
  const markdown = renderMarkdown(report);
  const outputs = writeOutputs(planningDir, report, markdown);
  const payload = {
    ...report,
    outputs: {
      json: relPath(planningDir, outputs.jsonPath),
      markdown: relPath(planningDir, outputs.mdPath),
    },
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    [
      `[cobolt-planning-workspace-index] ${payload.status}`,
      `  json: ${payload.outputs.json}`,
      `  markdown: ${payload.outputs.markdown}`,
      `  build authorization: ${payload.summary.buildAuthorized ? 'YES' : 'NO'}`,
      `  features: ${payload.summary.featureCount}`,
      `  milestones: ${payload.summary.milestoneCount}`,
      `  stories: ${payload.summary.storyCount}`,
    ].join('\n'),
  );
  process.stdout.write('\n');
}

if (require.main === module) {
  main();
}

module.exports = {
  buildReport,
  renderMarkdown,
};
