#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { collectStageTrust } = require('./cobolt-trust');

const AUDIENCES = {
  engineer: {
    label: 'Engineer',
    headline: 'Technical state and execution signal for the current stage.',
    highlightsLabel: 'Technical Highlights',
    risksLabel: 'Technical Watch Items',
    nextLabel: 'Next Move',
  },
  product: {
    label: 'Product',
    headline: 'Outcome, delivery risk, and scope signal for the current stage.',
    highlightsLabel: 'What Landed',
    risksLabel: 'What Needs Attention',
    nextLabel: 'Product Next Step',
  },
  leadership: {
    label: 'Leadership',
    headline: 'Delivery confidence and escalation signal for the current stage.',
    highlightsLabel: 'Delivery Signal',
    risksLabel: 'Exposure',
    nextLabel: 'Leadership Next Step',
  },
  governance: {
    label: 'Governance',
    headline: 'Evidence, traceability, and review posture for the current stage.',
    highlightsLabel: 'Evidence Signal',
    risksLabel: 'Control Gaps',
    nextLabel: 'Required Review',
  },
};

function defaultAudience() {
  return 'product';
}

function normalizeAudience(audience) {
  const value = String(audience || defaultAudience())
    .trim()
    .toLowerCase();
  return AUDIENCES[value] ? value : null;
}

function buildHeadline(trustReport, audienceKey) {
  const audience = AUDIENCES[audienceKey];
  const fileCount = trustReport.files.length;
  return `${trustReport.stageLabel} has ${fileCount} artifact(s) in the latest run. Trust verdict: ${trustReport.verdict}. ${audience.headline}`;
}

function formatEntry(entry) {
  return `${entry.title}: ${entry.detail}`;
}

function pickHighlights(entries) {
  return entries
    .filter((entry) => entry.band === 'proven' || entry.band === 'computed' || entry.band === 'signaled')
    .slice(0, 3)
    .map(formatEntry);
}

function pickRisks(entries) {
  return entries
    .filter((entry) => entry.band === 'conflicted' || entry.band === 'pending')
    .slice(0, 3)
    .map(formatEntry);
}

function defaultNextStep(trustReport, audienceKey) {
  if (audienceKey === 'product') {
    return trustReport.verdict === 'grounded'
      ? 'Use this stage output for backlog or milestone decisions.'
      : 'Hold the next handoff until the trust report clears the flagged items.';
  }

  if (audienceKey === 'leadership') {
    return trustReport.verdict === 'grounded'
      ? 'Keep momentum and track the next pipeline checkpoint.'
      : 'Escalate the flagged items before committing to downstream delivery dates.';
  }

  if (audienceKey === 'governance') {
    return trustReport.verdict === 'grounded'
      ? 'Attach this brief and trust report to the review record.'
      : 'Require evidence cleanup before signing off on this stage.';
  }

  return trustReport.verdict === 'grounded'
    ? 'Proceed to the next gate with the current evidence set.'
    : 'Resolve the trust conflicts before moving this stage forward.';
}

function buildBriefFromTrustReport(trustReport, requestedAudience) {
  const audienceKey = normalizeAudience(requestedAudience);
  if (!audienceKey) {
    throw new Error(`Unknown audience: ${requestedAudience}`);
  }

  const highlights = pickHighlights(trustReport.entries);
  const risks = pickRisks(trustReport.entries);

  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    audience: audienceKey,
    audienceLabel: AUDIENCES[audienceKey].label,
    stage: trustReport.stage,
    stageLabel: trustReport.stageLabel,
    stageDir: trustReport.stageDir,
    headline: buildHeadline(trustReport, audienceKey),
    highlights:
      highlights.length > 0
        ? highlights
        : ['Structured artifacts exist, but this stage has not produced strong positive signals yet.'],
    risks: risks.length > 0 ? risks : ['No active risk was detected in the current structured signals.'],
    next: trustReport.nextChecks.length > 0 ? trustReport.nextChecks : [defaultNextStep(trustReport, audienceKey)],
    trust: {
      score: trustReport.trustScore,
      verdict: trustReport.verdict,
      bands: trustReport.bands,
    },
    files: trustReport.files,
  };
}

function buildBrief(projectDir = process.cwd(), requestedStage, requestedAudience) {
  const trustReport = collectStageTrust(projectDir, requestedStage);
  return buildBriefFromTrustReport(trustReport, requestedAudience);
}

function renderBriefMarkdown(brief) {
  const audience = AUDIENCES[brief.audience];
  const lines = [
    `# CoBolt Brief - ${brief.audienceLabel}`,
    '',
    `**Stage:** ${brief.stageLabel}`,
    `**Trust:** ${brief.trust.score}/100 (${brief.trust.verdict})`,
    brief.stageDir ? `**Stage Directory:** ${brief.stageDir}` : '',
    '',
    brief.headline,
    '',
    `## ${audience.highlightsLabel}`,
    '',
    ...brief.highlights.map((line) => `- ${line}`),
    '',
    `## ${audience.risksLabel}`,
    '',
    ...brief.risks.map((line) => `- ${line}`),
    '',
    `## ${audience.nextLabel}`,
    '',
    ...brief.next.map((line) => `- ${line}`),
    '',
  ];

  return lines.filter(Boolean).join('\n');
}

function writeBriefArtifacts(brief) {
  if (!brief.stageDir) {
    return { json: null, md: null };
  }

  fs.mkdirSync(brief.stageDir, { recursive: true });
  const jsonPath = path.join(brief.stageDir, `brief-${brief.audience}.json`);
  const mdPath = path.join(brief.stageDir, `brief-${brief.audience}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(brief, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, `${renderBriefMarkdown(brief)}\n`, 'utf8');
  return { json: jsonPath, md: mdPath };
}

function generateBrief(projectDir = process.cwd(), requestedStage, requestedAudience) {
  const brief = buildBrief(projectDir, requestedStage, requestedAudience);
  const paths = writeBriefArtifacts(brief);
  return { brief, paths };
}

function printUsage() {
  console.log('Usage: node tools/cobolt-brief.js <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  generate [--stage <name>] [--audience engineer|product|leadership|governance] [--json]');
  console.log('  show [--stage <name>] [--audience engineer|product|leadership|governance] [--json]');
  console.log('');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0] || 'generate';
  const jsonMode = args.includes('--json');
  const stageIndex = args.indexOf('--stage');
  const audienceIndex = args.indexOf('--audience');
  const stage = stageIndex >= 0 ? args[stageIndex + 1] : null;
  const audience = audienceIndex >= 0 ? args[audienceIndex + 1] : defaultAudience();

  if (command === '--help' || command === '-h' || command === 'help') {
    printUsage();
    process.exit(0);
  }

  if (command === 'generate') {
    const result = generateBrief(process.cwd(), stage, audience);
    console.log(
      jsonMode
        ? JSON.stringify(result.brief, null, 2)
        : `Brief saved to ${result.paths.json || '(not written)'} and ${result.paths.md || '(not written)'}`,
    );
    process.exit(0);
  }

  if (command === 'show') {
    const brief = buildBrief(process.cwd(), stage, audience);
    console.log(jsonMode ? JSON.stringify(brief, null, 2) : renderBriefMarkdown(brief));
    process.exit(0);
  }

  printUsage();
  process.exit(2);
}

module.exports = {
  AUDIENCES,
  defaultAudience,
  normalizeAudience,
  buildBriefFromTrustReport,
  buildBrief,
  renderBriefMarkdown,
  writeBriefArtifacts,
  generateBrief,
};
