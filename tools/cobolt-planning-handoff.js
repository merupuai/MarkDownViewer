#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { resolveReadablePlanningDir, safeReadJson } = require('../lib/cobolt-planning-artifacts');

let buildWorkspaceIndexDirect = null;
let buildClarificationReportDirect = null;
try {
  ({ buildReport: buildWorkspaceIndexDirect } = require('./cobolt-planning-workspace-index'));
} catch {
  buildWorkspaceIndexDirect = null;
}
try {
  ({ buildReport: buildClarificationReportDirect } = require('./cobolt-clarification-report'));
} catch {
  buildClarificationReportDirect = null;
}

function usage() {
  return [
    'CoBolt Planning Handoff',
    '',
    'Usage:',
    '  node tools/cobolt-planning-handoff.js generate [--json] [--planning-dir <path>] [--cwd <path>]',
    '  node tools/cobolt-planning-handoff.js --help',
    '',
    'Generates planning-handoff.md and planning-handoff.json to summarize',
    'source intake, readiness signals, contradictions, and the next',
    'resume or build command for the current planning packet.',
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

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
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

function readWorkspaceIndex(planningDir) {
  const filePath = path.join(planningDir, 'planning-workspace-index.json');
  const payload = safeReadJson(filePath);
  if (payload) return payload;
  if (typeof buildWorkspaceIndexDirect === 'function') {
    return buildWorkspaceIndexDirect(planningDir);
  }
  return {
    status: 'INCOMPLETE',
    summary: {
      buildAuthorized: false,
      featureCount: 0,
      storyCount: 0,
      readinessVerdict: 'UNKNOWN',
      planningQualityStatus: 'UNKNOWN',
      clarificationStatus: 'UNKNOWN',
      nextMilestone: null,
      nextAction: 'Planning workspace index is unavailable.',
    },
    issues: [
      {
        severity: 'block',
        source: 'planning-workspace-index',
        message: 'planning-workspace-index.json is missing and no fallback builder is available.',
      },
    ],
  };
}

function readClarification(planningDir) {
  const filePath = path.join(planningDir, 'clarification-report.json');
  const payload = safeReadJson(filePath);
  if (payload) return payload;
  if (typeof buildClarificationReportDirect === 'function') {
    return buildClarificationReportDirect(planningDir);
  }
  return {
    status: 'MISSING',
    summary: {
      nextAction: 'Clarification report is unavailable.',
    },
  };
}

function readSourceIntake(planningDir) {
  const payload = safeReadJson(path.join(planningDir, 'source-intake.json'));
  const inputDocuments = Array.isArray(payload?.inputDocuments)
    ? payload.inputDocuments.map((value) => String(value)).filter(Boolean)
    : [];
  return {
    exists: Boolean(payload),
    planningMode: String(payload?.planningMode || 'project').trim() || 'project',
    sourceMode: String(payload?.sourceMode || 'unknown').trim() || 'unknown',
    primaryInputDocument: String(payload?.primaryInputDocument || '').trim() || null,
    inputDocuments,
    documentCount:
      typeof payload?.documentCount === 'number' && payload.documentCount >= 0
        ? payload.documentCount
        : inputDocuments.length,
    requiresConsolidation: payload?.requiresConsolidation === true,
  };
}

function readPlanningProgress(planningDir) {
  const payload = safeReadJson(path.join(planningDir, 'checkpoints', 'planning-progress.json'));
  return {
    exists: Boolean(payload),
    currentPhase: Number(payload?.currentPhase || 0),
    lastCompletedSkill: String(payload?.lastCompletedSkill || '').trim() || null,
    nextSkill: String(payload?.nextSkill || '').trim() || null,
    planningComplete: payload?.planningComplete === true,
  };
}

function readPhase5Checkpoint(planningDir) {
  const payload = safeReadJson(path.join(planningDir, 'checkpoints', 'phase5-build-authorization.json'));
  return {
    exists: Boolean(payload),
    planningComplete: payload?.planningComplete === true,
    recordedAt: String(payload?.completedAt || payload?.recordedAt || '').trim() || null,
    gates: payload?.gates || {},
  };
}

function extractMilestoneIds(planningDir, workspaceIndex) {
  const ids = [];
  const nextMilestone = String(workspaceIndex?.summary?.nextMilestone || '').trim();
  if (/^M\d+$/i.test(nextMilestone)) ids.push(nextMilestone.toUpperCase());

  const storyTracker = safeReadJson(path.join(planningDir, 'story-tracker.json'));
  const stories = Array.isArray(storyTracker?.stories) ? storyTracker.stories : [];
  for (const story of stories) {
    const milestoneId = String(story?.milestoneId || '').trim();
    if (/^M\d+$/i.test(milestoneId)) ids.push(milestoneId.toUpperCase());
  }

  const milestonesText = readText(path.join(planningDir, 'milestones.md'));
  for (const match of milestonesText.matchAll(/^##\s+(M\d+)\b/gi)) {
    ids.push(String(match[1]).toUpperCase());
  }

  return sortMilestoneIds(ids);
}

function uniqueItems(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const key = `${item.severity}:${item.source}:${item.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function collectBlockers(_planningDir, workspaceIndex, clarification, progress, phase5) {
  const blockers = [];

  if (!phase5.exists) {
    blockers.push({
      severity: 'block',
      source: 'phase5-checkpoint',
      message:
        'phase5-build-authorization.json is missing, so the planning packet is not ready for a trusted build handoff.',
    });
  }

  const workspaceIssues = Array.isArray(workspaceIndex?.issues) ? workspaceIndex.issues : [];
  for (const issue of workspaceIssues) {
    const severity = String(issue?.severity || 'warn').toLowerCase();
    if (severity !== 'block' && severity !== 'warn') continue;
    blockers.push({
      severity,
      source: String(issue?.source || 'planning-workspace-index'),
      message: String(issue?.message || 'Planning workspace index reported an issue.'),
    });
  }

  if (clarification?.status === 'BLOCKED') {
    blockers.push({
      severity: 'block',
      source: 'clarification',
      message:
        String(clarification?.summary?.nextAction || '').trim() ||
        'Clarification report still contains blocking ambiguity or source conflicts.',
    });
  }

  if (progress.exists && progress.planningComplete !== true && phase5.planningComplete !== true) {
    blockers.push({
      severity: 'block',
      source: 'planning-progress',
      message: 'planning-progress.json does not yet record planningComplete=true.',
    });
  }

  if (
    workspaceIndex?.summary &&
    workspaceIndex.summary.buildAuthorized !== true &&
    blockers.filter((item) => item.severity === 'block').length === 0
  ) {
    blockers.push({
      severity: 'block',
      source: 'planning-workspace-index',
      message:
        String(workspaceIndex.summary.nextAction || '').trim() ||
        'Planning workspace index does not authorize build yet.',
    });
  }

  if (
    phase5.planningComplete === true &&
    workspaceIndex?.summary?.buildAuthorized !== true &&
    blockers.filter((item) => item.severity === 'block').length === 0
  ) {
    blockers.push({
      severity: 'warn',
      source: 'phase5-checkpoint',
      message: 'Phase 5 is marked complete, but the current planning packet still needs follow-up before build.',
    });
  }

  return uniqueItems(blockers);
}

function collectContradictions(workspaceIndex, progress, phase5) {
  const contradictions = [];

  if (phase5.planningComplete === true && workspaceIndex?.summary?.buildAuthorized !== true) {
    contradictions.push({
      severity: 'warn',
      source: 'phase5-vs-workspace',
      message:
        'phase5-build-authorization.json says planningComplete=true, but planning-workspace-index.json does not authorize build.',
    });
  }

  if (workspaceIndex?.status === 'READY' && phase5.planningComplete !== true) {
    contradictions.push({
      severity: 'warn',
      source: 'workspace-vs-phase5',
      message:
        'planning-workspace-index.json is READY, but phase5-build-authorization.json is missing or does not declare planningComplete=true.',
    });
  }

  if (progress.planningComplete === true && progress.nextSkill) {
    contradictions.push({
      severity: 'warn',
      source: 'planning-progress',
      message: `planning-progress.json declares planningComplete=true but still points to nextSkill=${progress.nextSkill}.`,
    });
  }

  if (phase5.planningComplete === true && progress.exists && progress.currentPhase > 0 && progress.currentPhase < 5) {
    contradictions.push({
      severity: 'warn',
      source: 'planning-progress',
      message: `planning-progress.json reports currentPhase=${progress.currentPhase} while phase5-build-authorization.json already marks planning complete.`,
    });
  }

  return uniqueItems(contradictions);
}

function buildCommandFor(nextMilestone) {
  if (!nextMilestone) return null;
  return `cobolt-cli build ${nextMilestone} --auto`;
}

function resumeCommandFor(planningMode) {
  return `cobolt-cli plan ${planningMode === 'feature' ? 'feature' : 'project'} --resume`;
}

function deriveNextAction(inputs) {
  const { buildAuthorized, contradictions, blockers, clarification, workspaceIndex, buildCommand, resumeCommand } =
    inputs;

  if (buildAuthorized && buildCommand) {
    return `Planning packet is ready for the next session. Run ${buildCommand}.`;
  }

  if (contradictions.length > 0) {
    return `Resume planning with ${resumeCommand} and resolve the handoff contradictions before starting build.`;
  }

  if (clarification?.status === 'BLOCKED') {
    return (
      String(clarification?.summary?.nextAction || '').trim() ||
      `Resume planning with ${resumeCommand} and clear the blocking clarification items.`
    );
  }

  const blockingIssue = blockers.find((item) => item.severity === 'block');
  if (blockingIssue) {
    return String(workspaceIndex?.summary?.nextAction || '').trim() || blockingIssue.message;
  }

  return String(workspaceIndex?.summary?.nextAction || '').trim() || `Resume planning with ${resumeCommand}.`;
}

function statusFrom(inputs) {
  const { workspaceIndex, phase5, buildAuthorized, blockers, contradictions } = inputs;

  if (workspaceIndex?.status === 'INCOMPLETE') return 'INCOMPLETE';
  if (!phase5.exists) return 'INCOMPLETE';
  if (buildAuthorized) return 'READY';
  if (blockers.length > 0 || contradictions.length > 0 || workspaceIndex?.status === 'ATTENTION') return 'ATTENTION';
  return 'ATTENTION';
}

function referenceIfExists(planningDir, relativePath) {
  const absolutePath = path.join(planningDir, relativePath);
  return fs.existsSync(absolutePath) ? toPosix(relativePath) : null;
}

function buildReport(planningDir) {
  const workspaceIndex = readWorkspaceIndex(planningDir);
  const clarification = readClarification(planningDir);
  const sourceIntake = readSourceIntake(planningDir);
  const progress = readPlanningProgress(planningDir);
  const phase5 = readPhase5Checkpoint(planningDir);
  const milestoneIds = extractMilestoneIds(planningDir, workspaceIndex);
  const nextMilestone = workspaceIndex?.summary?.nextMilestone || milestoneIds[0] || null;
  const buildCommand = buildCommandFor(nextMilestone);
  const resumeCommand = resumeCommandFor(sourceIntake.planningMode);
  const blockers = collectBlockers(planningDir, workspaceIndex, clarification, progress, phase5);
  const contradictions = collectContradictions(workspaceIndex, progress, phase5);
  const buildAuthorized =
    workspaceIndex?.summary?.buildAuthorized === true &&
    phase5.planningComplete === true &&
    blockers.every((item) => item.severity !== 'block') &&
    contradictions.length === 0;
  const status = statusFrom({
    workspaceIndex,
    phase5,
    buildAuthorized,
    blockers,
    contradictions,
  });

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    planningDir: toPosix(planningDir),
    status,
    summary: {
      planningMode: sourceIntake.planningMode,
      sourceMode: sourceIntake.sourceMode,
      inputDocumentCount: sourceIntake.documentCount,
      featureCount: Number(workspaceIndex?.summary?.featureCount || 0),
      storyCount: Number(workspaceIndex?.summary?.storyCount || 0),
      nextMilestone,
      workspaceStatus: String(workspaceIndex?.status || 'UNKNOWN'),
      clarificationStatus: normalizeToken(
        clarification?.status || workspaceIndex?.summary?.clarificationStatus || 'UNKNOWN',
      ),
      readinessVerdict: normalizeToken(workspaceIndex?.summary?.readinessVerdict || 'UNKNOWN'),
      planningQualityStatus: normalizeToken(workspaceIndex?.summary?.planningQualityStatus || 'UNKNOWN'),
      phase5Recorded: phase5.exists,
      planningComplete: phase5.planningComplete === true,
      buildAuthorized,
      recommendedCommand: buildAuthorized && buildCommand ? buildCommand : resumeCommand,
      nextAction: deriveNextAction({
        buildAuthorized,
        contradictions,
        blockers,
        clarification,
        workspaceIndex,
        buildCommand,
        resumeCommand,
      }),
    },
    commands: {
      resume: resumeCommand,
      build: buildCommand,
      inspectWorkspace: 'node tools/cobolt-planning-workspace-index.js generate',
      inspectClarifications: 'node tools/cobolt-clarification-report.js generate',
    },
    sourceIntake,
    readinessSignals: {
      workspaceStatus: String(workspaceIndex?.status || 'UNKNOWN'),
      clarificationStatus: normalizeToken(clarification?.status || 'UNKNOWN'),
      readinessVerdict: normalizeToken(workspaceIndex?.summary?.readinessVerdict || 'UNKNOWN'),
      planningQualityStatus: normalizeToken(workspaceIndex?.summary?.planningQualityStatus || 'UNKNOWN'),
      planningProgress: progress,
      phase5,
    },
    blockers,
    contradictions,
    inputReferences: {
      prd: referenceIfExists(planningDir, 'prd.md'),
      sourceDocumentPacket: referenceIfExists(planningDir, 'source-document-consolidation.md'),
      featureRegistry: referenceIfExists(planningDir, 'feature-registry.json'),
      featureReadiness: referenceIfExists(planningDir, 'feature-readiness-report.json'),
      readinessReport: referenceIfExists(planningDir, 'readiness-report.json'),
      clarificationReport: referenceIfExists(planningDir, 'clarification-report.json'),
      planningWorkspaceIndex: referenceIfExists(planningDir, 'planning-workspace-index.json'),
      sourceIntake: referenceIfExists(planningDir, 'source-intake.json'),
      planningProgress: referenceIfExists(planningDir, 'checkpoints/planning-progress.json'),
      phase5Checkpoint: referenceIfExists(planningDir, 'checkpoints/phase5-build-authorization.json'),
    },
  };
}

function renderList(lines, items, formatter, emptyText = '- None.') {
  if (!items || items.length === 0) {
    lines.push(emptyText);
    lines.push('');
    return;
  }
  for (const item of items) {
    lines.push(formatter(item));
  }
  lines.push('');
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Planning Handoff');
  lines.push('');
  lines.push(`> Auto-generated by \`node tools/cobolt-planning-handoff.js generate\` - ${report.generatedAt}`);
  lines.push('');
  lines.push(`Status: **${report.status}**`);
  lines.push(`Build authorization: **${report.summary.buildAuthorized ? 'YES' : 'NO'}**`);
  lines.push(`Recommended command: \`${report.summary.recommendedCommand}\``);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Planning mode: ${report.summary.planningMode}`);
  lines.push(`- Source mode: ${report.summary.sourceMode}`);
  lines.push(`- Input documents: ${report.summary.inputDocumentCount}`);
  lines.push(`- Features: ${report.summary.featureCount}`);
  lines.push(`- Stories: ${report.summary.storyCount}`);
  lines.push(`- Next milestone: ${report.summary.nextMilestone || '(not detected)'}`);
  lines.push(`- Workspace status: ${report.summary.workspaceStatus}`);
  lines.push(`- Clarification status: ${report.summary.clarificationStatus}`);
  lines.push(`- Readiness verdict: ${report.summary.readinessVerdict}`);
  lines.push(`- Planning quality: ${report.summary.planningQualityStatus}`);
  lines.push(`- Phase 5 recorded: ${report.summary.phase5Recorded ? 'yes' : 'no'}`);
  lines.push(`- Planning complete: ${report.summary.planningComplete ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('## Recommended Next Action');
  lines.push('');
  lines.push(`- ${report.summary.nextAction}`);
  lines.push(`- Resume command: \`${report.commands.resume}\``);
  if (report.commands.build) {
    lines.push(`- Build command: \`${report.commands.build}\``);
  } else {
    lines.push('- Build command: (not available yet)');
  }
  lines.push('');
  lines.push('## Source Intake');
  lines.push('');
  lines.push(`- Primary input: ${report.sourceIntake.primaryInputDocument || '(not recorded)'}`);
  lines.push(`- Requires consolidation: ${report.sourceIntake.requiresConsolidation ? 'yes' : 'no'}`);
  renderList(
    lines,
    report.sourceIntake.inputDocuments,
    (value) => `- \`${value}\``,
    '- No inputDocuments were recorded.',
  );
  lines.push('## Blockers');
  lines.push('');
  renderList(lines, report.blockers, (item) => `- [${item.severity.toUpperCase()}] ${item.message}`);
  lines.push('## Contradictions');
  lines.push('');
  renderList(lines, report.contradictions, (item) => `- [${item.severity.toUpperCase()}] ${item.message}`);
  lines.push('## Canonical Inputs');
  lines.push('');
  const references = Object.entries(report.inputReferences)
    .filter(([, value]) => value)
    .map(([key, value]) => `- ${key}: \`${value}\``);
  renderList(lines, references, (value) => value, '- No canonical input references were found.');
  return `${lines.join('\n')}\n`;
}

function writeOutputs(planningDir, report, markdown) {
  const jsonPath = path.join(planningDir, 'planning-handoff.json');
  const mdPath = path.join(planningDir, 'planning-handoff.md');
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
      `[cobolt-planning-handoff] ${payload.status}`,
      `  json: ${payload.outputs.json}`,
      `  markdown: ${payload.outputs.markdown}`,
      `  recommended command: ${payload.summary.recommendedCommand}`,
      `  build authorization: ${payload.summary.buildAuthorized ? 'YES' : 'NO'}`,
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
