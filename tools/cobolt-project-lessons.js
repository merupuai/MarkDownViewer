#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { atomicWrite: sharedAtomicWrite } = require('../lib/cobolt-atomic-write');

const { paths: getPaths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();

function projectRoot(projectDir) {
  return projectDir || process.cwd();
}

function pathsFor(projectDir) {
  return typeof getPaths === 'function' ? getPaths(projectDir) : null;
}

function outputPath(projectDir) {
  const root = projectRoot(projectDir);
  const pathHelper = pathsFor(root);
  if (pathHelper?.projectLessons) return pathHelper.projectLessons();
  return path.join(root, '_cobolt-output', 'reports', 'project', 'project-lessons-learned.md');
}

function readJsonSafe(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch {
    /* fail-open */
  }
  return null;
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const rows = [];
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* ignore invalid rows */
    }
  }
  return rows;
}

function listFilesRecursive(rootDir, predicate) {
  const results = [];
  if (!fs.existsSync(rootDir)) return results;

  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!predicate || predicate(fullPath, entry)) {
        results.push(fullPath);
      }
    }
  }

  return results.sort();
}

function cleanText(text) {
  return String(text || '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stableKey(text) {
  return cleanText(text).toLowerCase();
}

function dedupeEntries(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const text = cleanText(entry?.text);
    if (!text) continue;
    const key = `${entry.section || 'general'}::${stableKey(text)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      section: entry.section || 'general',
      text,
      source: entry.source || null,
      milestone: entry.milestone || null,
    });
  }
  return result;
}

function collectStateEntries(root) {
  const statePath = path.join(root, 'cobolt-state.json');
  const state = readJsonSafe(statePath);
  if (!state) {
    return {
      entries: [],
      state: null,
    };
  }

  const entries = [];
  const stageMap = state.pipeline?.stages || {};
  for (const [stageName, stageData] of Object.entries(stageMap)) {
    if (Array.isArray(stageData?.keyLearnings)) {
      for (const learning of stageData.keyLearnings) {
        entries.push({
          section: 'rules',
          text: learning,
          source: `cobolt-state.json pipeline.stages.${stageName}.keyLearnings`,
          milestone: state.pipeline?.currentMilestone || null,
        });
      }
    }

    if (stageData?.reviewerIntegrityNote) {
      entries.push({
        section: 'watchouts',
        text: stageData.reviewerIntegrityNote,
        source: `cobolt-state.json pipeline.stages.${stageName}.reviewerIntegrityNote`,
        milestone: state.pipeline?.currentMilestone || null,
      });
    }
  }

  return { entries, state };
}

function collectSessionEntries(root) {
  const rows = readJsonLines(path.join(root, '_cobolt-output', 'memory', 'session-extract.jsonl'));
  return rows.map((row) => ({
    section: row.type === 'feedback' ? 'watchouts' : 'rules',
    text: row.summary || row.detail,
    source: 'session-extract.jsonl',
    milestone: row.milestone || null,
  }));
}

function collectFixLessonEntries(root) {
  const files = listFilesRecursive(path.join(root, '_cobolt-output', 'memory'), (fullPath) =>
    path.basename(fullPath).match(/^fix-lesson-.*\.json$/i),
  );

  const entries = [];
  for (const filePath of files) {
    const data = readJsonSafe(filePath);
    const content = data?.content || {};
    const milestone = data?.milestone || null;

    for (const lesson of Array.isArray(content.lessonsLearned) ? content.lessonsLearned : []) {
      entries.push({
        section: 'watchouts',
        text: lesson,
        source: path.relative(root, filePath),
        milestone,
      });
    }

    for (const pattern of Array.isArray(content.systemicPatterns) ? content.systemicPatterns : []) {
      entries.push({
        section: 'rules',
        text: pattern,
        source: path.relative(root, filePath),
        milestone,
      });
    }
  }

  return entries;
}

function collectDeadEndEntries(root) {
  const candidates = [
    path.join(root, '_cobolt-output', 'latest', 'fix', 'dead-ends.jsonl'),
    ...listFilesRecursive(
      path.join(root, '_cobolt-output', 'runs'),
      (fullPath) => path.basename(fullPath) === 'dead-ends.jsonl',
    ),
  ];

  const entries = [];
  const seen = new Set();

  for (const filePath of candidates) {
    for (const row of readJsonLines(filePath)) {
      const key = `${row.id || ''}::${row.milestone || ''}::${row.approach || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        section: 'watchouts',
        text: `[Dead end${row.id ? ` ${row.id}` : ''}] ${row.approach}${row.reason ? ` — ${row.reason}` : ''}`,
        source: path.relative(root, filePath),
        milestone: row.milestone || null,
      });
    }
  }

  return entries;
}

function collectAgentHubEntries(root) {
  const pathHelper = pathsFor(root);
  const filePath = pathHelper?.agentHubNotes
    ? pathHelper.agentHubNotes()
    : path.join(root, '_cobolt-output', 'public', 'agent-hub', 'notes.jsonl');

  return readJsonLines(filePath).map((row) => ({
    section: String(row.kind || '').toLowerCase() === 'warning' ? 'watchouts' : 'rules',
    text: [row.title, row.body].filter(Boolean).join(': '),
    source: 'agent-hub notes',
    milestone: row.milestone || null,
  }));
}

function milestoneFromPath(filePath) {
  const match = filePath.match(/(M\d+)/i);
  return match ? match[1].toUpperCase() : null;
}

function sectionBody(markdown, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingRegex = new RegExp(`^##\\s+${escaped}\\s*$`, 'i');
  const lines = String(markdown || '').split(/\r?\n/);

  let startIndex = -1;
  for (let index = 0; index < lines.length; index++) {
    if (headingRegex.test(lines[index].trim())) {
      startIndex = index + 1;
      break;
    }
  }

  if (startIndex === -1) return '';

  let endIndex = lines.length;
  for (let index = startIndex; index < lines.length; index++) {
    if (/^##\s+/.test(lines[index].trim())) {
      endIndex = index;
      break;
    }
  }

  return lines.slice(startIndex, endIndex).join('\n');
}

function extractSectionItems(markdown, heading) {
  const body = sectionBody(markdown, heading);
  if (!body) return [];
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line))
    .map((line) => cleanText(line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '')))
    .filter(Boolean);
}

function collectDreamEntries(root) {
  const candidateDirs = [
    path.join(root, '_cobolt-output', 'archive'),
    path.join(root, '_cobolt-output', 'reports'),
    path.join(root, '_cobolt-output', 'runs'),
  ];

  const files = [];
  for (const dir of candidateDirs) {
    for (const filePath of listFilesRecursive(dir, (fullPath) => /-dream\.md$/i.test(path.basename(fullPath)))) {
      files.push(filePath);
    }
  }

  const entries = [];
  for (const filePath of [...new Set(files)]) {
    const markdown = fs.readFileSync(filePath, 'utf8');
    const relPath = path.relative(root, filePath);
    const milestone = milestoneFromPath(filePath);

    for (const item of extractSectionItems(markdown, 'What Worked')) {
      entries.push({ section: 'worked', text: item, source: relPath, milestone });
    }
    for (const item of extractSectionItems(markdown, "What Didn't Work")) {
      entries.push({ section: 'watchouts', text: item, source: relPath, milestone });
    }
    for (const item of extractSectionItems(markdown, 'What Could Be Better')) {
      entries.push({ section: 'watchouts', text: item, source: relPath, milestone });
    }
    for (const item of extractSectionItems(markdown, 'Synthesized Rules')) {
      entries.push({ section: 'rules', text: item, source: relPath, milestone });
    }
  }

  return entries;
}

function collectProjectLessons(projectDir) {
  const root = projectRoot(projectDir);
  const { entries: stateEntries, state } = collectStateEntries(root);
  const dreamEntries = collectDreamEntries(root);
  const sessionEntries = collectSessionEntries(root);
  const fixEntries = collectFixLessonEntries(root);
  const hubEntries = collectAgentHubEntries(root);
  const deadEndEntries = collectDeadEndEntries(root);
  const all = dedupeEntries([
    ...stateEntries,
    ...dreamEntries,
    ...sessionEntries,
    ...fixEntries,
    ...hubEntries,
    ...deadEndEntries,
  ]);

  return {
    root,
    state,
    generatedAt: new Date().toISOString(),
    worked: all.filter((entry) => entry.section === 'worked'),
    watchouts: all.filter((entry) => entry.section === 'watchouts'),
    rules: all.filter((entry) => entry.section === 'rules'),
    sources: {
      stateEntries: stateEntries.length,
      dreamEntries: dreamEntries.length,
      sessionEntries: sessionEntries.length,
      fixEntries: fixEntries.length,
      hubEntries: hubEntries.length,
      deadEndEntries: deadEndEntries.length,
    },
  };
}

function formatEntry(entry) {
  const parts = [entry.text];
  const meta = [entry.milestone, entry.source].filter(Boolean).join(' - ');
  if (meta) parts.push(`Source: ${meta}`);
  return `- ${parts.join(' ')}`;
}

function renderProjectLessons(summary) {
  const state = summary.state || {};
  const projectId = state.projectId || path.basename(summary.root);
  const currentStage = state.pipeline?.currentStage || state.currentStage || 'unknown';
  const currentMilestone = state.pipeline?.currentMilestone || state.currentMilestone || 'unknown';

  const lines = [
    '# Project Lessons Learned',
    '',
    `- Generated: ${summary.generatedAt}`,
    `- Project: ${projectId}`,
    `- Current Milestone: ${currentMilestone}`,
    `- Current Stage: ${currentStage}`,
    '',
    '## Summary',
    '',
    `- What Worked: ${summary.worked.length}`,
    `- Watchouts: ${summary.watchouts.length}`,
    `- Rules To Carry Forward: ${summary.rules.length}`,
    '',
    '## What Worked',
    '',
  ];

  const worked = summary.worked.length > 0 ? summary.worked : [{ text: 'No documented success patterns found yet.' }];
  for (const entry of worked) lines.push(formatEntry(entry));

  lines.push('', '## What To Watch', '');
  const watchouts = summary.watchouts.length > 0 ? summary.watchouts : [{ text: 'No documented watchouts found yet.' }];
  for (const entry of watchouts) lines.push(formatEntry(entry));

  lines.push('', '## Rules To Carry Forward', '');
  const rules = summary.rules.length > 0 ? summary.rules : [{ text: 'No synthesized rules found yet.' }];
  for (const entry of rules) lines.push(formatEntry(entry));

  lines.push('', '## Source Inventory', '', `- cobolt-state.json learnings: ${summary.sources.stateEntries}`);
  lines.push(`- Dream reports parsed: ${summary.sources.dreamEntries}`);
  lines.push(`- Session memory entries: ${summary.sources.sessionEntries}`);
  lines.push(`- Fix lesson entries: ${summary.sources.fixEntries}`);
  lines.push(`- Agent hub notes: ${summary.sources.hubEntries}`);
  lines.push(`- Dead end entries: ${summary.sources.deadEndEntries}`);
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function atomicWrite(filePath, content) {
  sharedAtomicWrite(filePath, content, { encoding: 'utf8' });
}

function generateProjectLessons(projectDir, options = {}) {
  const summary = collectProjectLessons(projectDir);
  const markdown = renderProjectLessons(summary);
  const filePath = options.output || outputPath(projectDir);
  atomicWrite(filePath, markdown);
  return { filePath, markdown, summary };
}

function printUsage() {
  console.log(`
  CoBolt Project Lessons

  Usage:
    node tools/cobolt-project-lessons.js generate [--output <path>]
    node tools/cobolt-project-lessons.js print
`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'generate';

  if (command === '--help' || command === '-h' || command === 'help') {
    printUsage();
    process.exit(0);
  }

  if (command === 'print') {
    const summary = collectProjectLessons(process.cwd());
    process.stdout.write(renderProjectLessons(summary));
    return;
  }

  if (command === 'generate') {
    const result = generateProjectLessons(process.cwd(), { output: args.output });
    console.log(`Project lessons written: ${result.filePath}`);
    return;
  }

  console.error(`Unknown command: ${command}`);
  printUsage();
  process.exit(1);
}

module.exports = {
  outputPath,
  collectProjectLessons,
  renderProjectLessons,
  generateProjectLessons,
  _testOnly: {
    collectAgentHubEntries,
    collectDeadEndEntries,
    collectDreamEntries,
    extractSectionItems,
    dedupeEntries,
  },
};

if (require.main === module) {
  main();
}
