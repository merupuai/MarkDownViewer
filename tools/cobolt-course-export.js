#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { ensureKnowledgeGraph } = require('./cobolt-knowledge-graph');
const { ReportGenerator } = require('./cobolt-report');
const { getMilestoneIds, getMilestoneStatus } = require('./cobolt-milestone-dashboard');

const AUDIENCES = Object.freeze({
  onboarding: {
    label: 'Onboarding',
    intro: 'A guided walkthrough for engineers or operators who need a fast, grounded mental model of this codebase.',
    outro: 'Use the linked artifacts as the source of truth whenever you move from orientation into implementation.',
  },
  product: {
    label: 'Product',
    intro: 'A stakeholder-facing walkthrough focused on workflow surface, delivery structure, and execution signal.',
    outro:
      'Use this walkthrough to align roadmap, delivery expectations, and review posture with the actual artifacts on disk.',
  },
  handoff: {
    label: 'Handoff',
    intro:
      'A delivery handoff that explains structure, milestones, review posture, and the most important operational artifacts.',
    outro:
      'Treat this course as the compressed handoff layer and drill into the referenced artifacts for final sign-off.',
  },
});

function latestDir(projectDir) {
  return path.join(path.resolve(projectDir), '_cobolt-output', 'latest');
}

function reportsDir(projectDir) {
  return path.join(latestDir(projectDir), 'reports');
}

function planningDir(projectDir) {
  return path.join(latestDir(projectDir), 'planning');
}

function reviewDir(projectDir) {
  return path.join(latestDir(projectDir), 'review');
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function excerptMarkdown(filePath, maxLength = 420) {
  const content = readText(filePath);
  if (!content) return null;
  const normalized = content
    .replace(/\r/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^#+\s+/gm, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3).trim()}...`;
}

function relativePath(projectDir, filePath) {
  return path.relative(path.resolve(projectDir), filePath).replace(/\\/g, '/');
}

function pickFirstExisting(projectDir, relativePaths) {
  for (const relativeFile of relativePaths) {
    const absolute = path.join(projectDir, relativeFile);
    if (fs.existsSync(absolute)) return absolute;
  }
  return null;
}

function summarizeStageStatus(projectDir) {
  const summary = new ReportGenerator(projectDir).summary();
  return Object.entries(summary.stages || {})
    .filter(([, info]) => info.status === 'completed')
    .map(([stage]) => stage)
    .slice(0, 8);
}

function summarizeMilestones(projectDir) {
  return getMilestoneIds(projectDir)
    .map((milestoneId) => getMilestoneStatus(milestoneId))
    .map((status) => ({
      id: status.id,
      status: status.status,
      percentComplete: status.percentComplete,
      tasks: `${status.tasks.complete}/${status.tasks.total}`,
      deferred: status.tasks.deferred,
    }))
    .slice(0, 8);
}

function readFindingsSummary(projectDir) {
  const tracker = readJson(path.join(reviewDir(projectDir), 'finding-tracker.json'));
  const findings = Array.isArray(tracker?.findings) ? tracker.findings : [];
  const open = findings.filter((finding) => !finding.status || finding.status === 'open');
  return {
    total: findings.length,
    open: open.length,
    top: open.slice(0, 5).map((finding) => ({
      id: finding.id || 'unknown',
      severity: finding.severity || 'unknown',
      title: finding.title || finding.summary || finding.message || 'Untitled finding',
    })),
  };
}

function normalizeAudience(audience) {
  const value = String(audience || 'onboarding')
    .trim()
    .toLowerCase();
  return AUDIENCES[value] ? value : 'onboarding';
}

function buildCourse(projectDir = process.cwd(), audience = 'onboarding') {
  const resolvedRoot = path.resolve(projectDir);
  const audienceKey = normalizeAudience(audience);
  const audienceProfile = AUDIENCES[audienceKey];
  const graph = ensureKnowledgeGraph(resolvedRoot);
  const reportSummary = new ReportGenerator(resolvedRoot).summary();
  const completedStages = summarizeStageStatus(resolvedRoot);
  const findings = readFindingsSummary(resolvedRoot);
  const milestones = summarizeMilestones(resolvedRoot);

  const prdPath = pickFirstExisting(resolvedRoot, [
    '_cobolt-output/latest/planning/prd.md',
    '_cobolt-output/latest/brownfield/24-modernization-prd.md',
  ]);
  const architecturePath = pickFirstExisting(resolvedRoot, [
    '_cobolt-output/latest/planning/architecture.md',
    '_cobolt-output/latest/brownfield/27-modernization-system-architecture.md',
  ]);
  const deliveryPath = pickFirstExisting(resolvedRoot, [
    '_cobolt-output/latest/planning/master-plan.md',
    '_cobolt-output/latest/brownfield/39-modernization-delivery-plan.md',
  ]);

  const modules = [
    {
      id: 'module-1',
      title: 'Repo Orientation',
      summary: `The current knowledge graph sees ${graph.graph.counts.nodes} nodes and ${graph.graph.counts.edges} typed relationships across code, docs, and run artifacts.`,
      bullets: [
        `Project root: ${resolvedRoot}`,
        `Latest run directory: ${latestDir(resolvedRoot)}`,
        `Completed stages with artifacts: ${completedStages.length ? completedStages.join(', ') : 'none yet'}`,
      ],
      artifacts: [{ label: 'Knowledge Graph Summary', path: relativePath(resolvedRoot, graph.summaryPath) }],
    },
    {
      id: 'module-2',
      title: 'Workflow Surface',
      summary:
        'CoBolt keeps a small public workflow surface and pushes orchestration depth into deterministic tools, source-backed skills, and stage artifacts.',
      bullets: [
        'Public workflows cover init, plan, brownfield, build, review, fix, and version visibility.',
        `Stage directories with outputs: ${
          Object.entries(reportSummary.stages || {})
            .filter(([, info]) => info.fileCount > 0)
            .map(([stage, info]) => `${stage}(${info.fileCount})`)
            .slice(0, 10)
            .join(', ') || 'none yet'
        }`,
      ],
      artifacts: [
        {
          label: 'Pipeline Report',
          path: relativePath(resolvedRoot, path.join(latestDir(resolvedRoot), 'pipeline-report.md')),
        },
      ],
    },
    {
      id: 'module-3',
      title: 'Architecture and Requirements',
      summary:
        'Planning and design artifacts define the intended system shape and should be the first stop when reading implementation decisions.',
      bullets: [
        prdPath ? excerptMarkdown(prdPath) : 'No PRD artifact detected in the latest outputs.',
        architecturePath
          ? excerptMarkdown(architecturePath)
          : 'No architecture artifact detected in the latest outputs.',
      ],
      artifacts: [
        ...(prdPath ? [{ label: 'PRD', path: relativePath(resolvedRoot, prdPath) }] : []),
        ...(architecturePath ? [{ label: 'Architecture', path: relativePath(resolvedRoot, architecturePath) }] : []),
      ],
    },
    {
      id: 'module-4',
      title: 'Milestones and Delivery Map',
      summary: milestones.length
        ? `The current plan exposes ${milestones.length} milestone(s) with explicit completion and deferred-work signals.`
        : 'No milestone tracker is currently available in the latest outputs.',
      bullets: milestones.length
        ? milestones.map(
            (milestone) =>
              `${milestone.id}: ${milestone.status}, ${milestone.percentComplete}% complete, ${milestone.tasks} tasks complete${milestone.deferred ? `, ${milestone.deferred} deferred` : ''}`,
          )
        : ['Run planning or brownfield planning-sync to materialize milestone trackers.'],
      artifacts: [{ label: 'Planning Directory', path: relativePath(resolvedRoot, planningDir(resolvedRoot)) }],
    },
    {
      id: 'module-5',
      title: 'Review and Risk Posture',
      summary:
        findings.total > 0
          ? `Review outputs currently track ${findings.total} finding(s), with ${findings.open} still open.`
          : 'No current finding tracker was detected in the latest review outputs.',
      bullets: findings.top.length
        ? findings.top.map((finding) => `${finding.id} [${finding.severity}] ${finding.title}`)
        : ['Run `cobolt-cli review` to produce the latest review handoff and findings tracker.'],
      artifacts: [{ label: 'Review Directory', path: relativePath(resolvedRoot, reviewDir(resolvedRoot)) }],
    },
    {
      id: 'module-6',
      title: 'Handoff Pack',
      summary: deliveryPath
        ? excerptMarkdown(deliveryPath)
        : 'The delivery plan or master plan is the best handoff artifact once planning is complete.',
      bullets: [audienceProfile.outro],
      artifacts: [
        ...(deliveryPath ? [{ label: 'Delivery Plan', path: relativePath(resolvedRoot, deliveryPath) }] : []),
      ],
    },
  ];

  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-course-export',
    audience: audienceKey,
    audienceLabel: audienceProfile.label,
    title: `CoBolt Codebase Course - ${audienceProfile.label}`,
    intro: audienceProfile.intro,
    projectRoot: resolvedRoot,
    modules,
  };
}

function renderCourseMarkdown(course) {
  const lines = [`# ${course.title}`, '', `Generated at: ${course.generatedAt}`, '', course.intro, ''];

  for (const module of course.modules) {
    lines.push(`## ${module.title}`);
    lines.push('');
    lines.push(module.summary);
    lines.push('');
    if (module.bullets?.length) {
      lines.push(...module.bullets.map((bullet) => `- ${bullet}`));
      lines.push('');
    }
    if (module.artifacts?.length) {
      lines.push('Artifacts:');
      lines.push(...module.artifacts.map((artifact) => `- ${artifact.label}: ${artifact.path}`));
      lines.push('');
    }
  }

  return lines.join('\n').trim();
}

function writeCourseArtifacts(course, projectDir = process.cwd()) {
  const outDir = reportsDir(projectDir);
  const slug = course.audience;
  const jsonPath = path.join(outDir, `codebase-course-${slug}.json`);
  const mdPath = path.join(outDir, `codebase-course-${slug}.md`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(course, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, `${renderCourseMarkdown(course)}\n`, 'utf8');
  return { jsonPath, mdPath };
}

function generateCourse(projectDir = process.cwd(), audience = 'onboarding') {
  const course = buildCourse(projectDir, audience);
  const written = writeCourseArtifacts(course, projectDir);
  return { course, ...written };
}

function printUsage() {
  console.log('Usage: node tools/cobolt-course-export.js <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  generate [--audience onboarding|product|handoff] [--json]');
  console.log('  show [--audience onboarding|product|handoff] [--json]');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0] || 'generate';
  const jsonMode = args.includes('--json');
  const audienceIndex = args.indexOf('--audience');
  const audience = audienceIndex >= 0 ? args[audienceIndex + 1] : 'onboarding';

  if (command === '--help' || command === '-h' || command === 'help') {
    printUsage();
    process.exit(0);
  }

  if (command === 'show') {
    const course = buildCourse(process.cwd(), audience);
    console.log(jsonMode ? JSON.stringify(course, null, 2) : renderCourseMarkdown(course));
    process.exit(0);
  }

  if (command === 'generate') {
    const result = generateCourse(process.cwd(), audience);
    console.log(
      jsonMode ? JSON.stringify(result.course, null, 2) : `Course saved to ${result.jsonPath} and ${result.mdPath}`,
    );
    process.exit(0);
  }

  printUsage();
  process.exit(2);
}

module.exports = {
  AUDIENCES,
  buildCourse,
  generateCourse,
  normalizeAudience,
  renderCourseMarkdown,
  writeCourseArtifacts,
};
