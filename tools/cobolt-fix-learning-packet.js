#!/usr/bin/env node

// CoBolt Fix Learning Packet
//
// Consolidates tracker, RCA, and memory evidence into fix-learning-packet.json
// so post-fix prevention work is explicit and testable.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_OUTPUT_DIR = path.join('_cobolt-output', 'latest', 'fix');

function readJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readText(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8');
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function parseArgs(argv) {
  const out = {
    outputDir: DEFAULT_OUTPUT_DIR,
    tracker: null,
    rca: null,
    memory: path.join('_cobolt-output', 'memory', 'lessons.jsonl'),
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output-dir') out.outputDir = argv[++index] || out.outputDir;
    else if (arg === '--tracker') out.tracker = argv[++index] || null;
    else if (arg === '--rca') out.rca = argv[++index] || null;
    else if (arg === '--memory') out.memory = argv[++index] || null;
    else if (arg === '--json') out.json = true;
    else if (arg.startsWith('--')) out.unknown = arg;
  }
  return out;
}

function defaultTrackerPath(outputDir) {
  return path.join(outputDir, 'finding-tracker.json');
}

function defaultRcaPath(outputDir) {
  return path.join(outputDir, 'rca-report.md');
}

function extractMarkdownList(text, headingPattern) {
  const match = String(text || '').match(new RegExp(`${headingPattern}\\s*\\n([\\s\\S]*?)(?:\\n##\\s|$)`, 'iu'));
  if (!match) return [];
  return match[1]
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+|^\d+\.\s+/u.test(line))
    .map((line) => line.replace(/^[-*]\s+|^\d+\.\s+/u, '').trim())
    .filter(Boolean);
}

function countJsonl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return 0;
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.trim()).length;
}

function prefixForFinding(finding) {
  return String(finding?.prefix || finding?.id || 'CODE').match(/^([A-Z]+)/u)?.[1] || 'CODE';
}

function buildLearningPacket(options = {}) {
  const outputDir = options.outputDir || DEFAULT_OUTPUT_DIR;
  const trackerPath = options.tracker || defaultTrackerPath(outputDir);
  const rcaPath = options.rca || defaultRcaPath(outputDir);
  const tracker = readJson(trackerPath);
  const findings = Array.isArray(tracker?.findings) ? tracker.findings : [];
  const rcaText = readText(rcaPath);
  const preventionRecommendations = extractMarkdownList(rcaText, '## Prevention Recommendations');
  const lessonsLearned = extractMarkdownList(rcaText, '## Lessons Learned');
  const regressionBacklog = preventionRecommendations.filter((entry) =>
    /test|regression|replay|smoke|uat/iu.test(entry),
  );
  const standardsFeedback = preventionRecommendations.filter((entry) =>
    /standard|gate|lint|review|policy|ADR|architecture/iu.test(entry),
  );
  const memoryLessonCount = countJsonl(options.memory);
  const cases = findings.map((finding, index) => ({
    caseId: finding.caseId || `FIXCASE-${String(index + 1).padStart(3, '0')}`,
    findingId: finding.id || `FIX-${String(index + 1).padStart(3, '0')}`,
    rootCauseCategory: finding.rootCauseCategory || prefixForFinding(finding),
    preventionAction:
      finding.preventionAction ||
      preventionRecommendations[index] ||
      'Record a concrete prevention action in RCA before release close.',
    standardsFeedback,
    regressionBacklog,
  }));
  const issues = [];
  for (const item of cases) {
    if (!String(item.preventionAction || '').trim()) issues.push(`missing-prevention:${item.findingId}`);
    if (item.regressionBacklog.length === 0) issues.push(`missing-regression-backlog:${item.findingId}`);
  }
  const status = cases.length === 0 ? 'not_applicable' : issues.length === 0 ? 'complete' : 'pending';
  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-fix-learning-packet',
    status,
    memoryUpdateRequired: cases.length > 0,
    trackerPath,
    rcaPath,
    memoryEvidence: {
      path: options.memory || null,
      present: Boolean(options.memory && fs.existsSync(options.memory)),
      lessonCount: memoryLessonCount,
    },
    rootCauseCategories: [...new Set(cases.map((item) => item.rootCauseCategory))],
    preventionRecommendations,
    lessonsLearned,
    cases,
    issues,
  };
}

function runGenerate(options = {}) {
  const packet = buildLearningPacket(options);
  writeJson(path.join(options.outputDir || DEFAULT_OUTPUT_DIR, 'fix-learning-packet.json'), packet);
  return packet;
}

function runCheck(options = {}) {
  const packet =
    readJson(path.join(options.outputDir || DEFAULT_OUTPUT_DIR, 'fix-learning-packet.json')) || runGenerate(options);
  const passed = packet.status === 'complete' || packet.status === 'not_applicable';
  return { ...packet, passed };
}

function printUsage() {
  console.log(`
CoBolt Fix Learning Packet

Usage:
  node tools/cobolt-fix-learning-packet.js generate [--tracker <path>] [--rca <path>] [--memory <path>] [--output-dir <dir>] [--json]
  node tools/cobolt-fix-learning-packet.js check [--output-dir <dir>] [--json]
`);
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseArgs(rest);
  if (command !== 'generate' && command !== 'check') {
    printUsage();
    return command ? 2 : 0;
  }
  const result = command === 'generate' ? runGenerate(options) : runCheck(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`[cobolt-fix-learning-packet] ${result.status}`);
  return command === 'check' && result.passed === false ? 1 : 0;
}

if (require.main === module) process.exit(main());

module.exports = {
  buildLearningPacket,
  extractMarkdownList,
  runCheck,
  runGenerate,
};
