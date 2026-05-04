#!/usr/bin/env node
// cobolt-req-quality - ISO/IEC/IEEE 29148:2018 requirements quality audit.
// Extracts FRs/NFRs/IRs from planning artifacts and scores each against a
// deterministic 9-criterion rubric.
//
// Usage:
//   node tools/cobolt-req-quality.js audit [--prd path/to/prd.md] [--json]
//   node tools/cobolt-req-quality.js audit --strict

const fs = require('node:fs');
const path = require('node:path');
const { evaluateRequirement } = require('../lib/standards/iso29148-checks.js');

// GT-01: bypass routes through signed ledger; env-var auto-promotes during window.
function KILL() {
  const { isGateBypassed } = require('../lib/cobolt-bypass-resolver');
  return isGateBypassed('standards', { projectRoot: process.cwd() });
}

// Match lines like "- **FR-001**: ...", "FR-001: ...", "IR-003 - ...",
// and markdown requirement headings like "## FR-001 Login".
const REQ_LINE =
  /^\s*(?:[-*]\s*)?(?:#{1,6}\s*)?\*{0,2}((?:FR|NFR|IR|REQ|UC|US)-\d+)\*{0,2}(?:\s*[:\u2014\u2013-]\s*|\s+)(.*)$/i;

function isRequirementLine(line) {
  return REQ_LINE.test(line);
}

function extractRequirements(content, source) {
  const reqs = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(REQ_LINE);
    if (!match) continue;

    let text = (match[2] || '').trim();
    let j = i + 1;
    while (j < lines.length && lines[j].trim() && !isRequirementLine(lines[j]) && !lines[j].startsWith('#')) {
      text += ` ${lines[j].trim()}`;
      j++;
      if (j - i > 5) break;
    }

    reqs.push({
      id: match[1],
      text: text.replace(/\*\*/g, '').trim(),
      source,
    });
  }
  return reqs;
}

function findPrdFiles(projectRoot) {
  const candidates = [
    path.join(projectRoot, '_cobolt-output', 'latest', 'planning', 'prd.md'),
    path.join(projectRoot, '_cobolt-output', 'latest', 'planning', 'feature-prd.md'),
    path.join(projectRoot, '_cobolt-output', 'latest', 'planning', 'implicit-requirements.md'),
  ];
  return candidates.filter((p) => fs.existsSync(p));
}

function dedupContext(reqs) {
  const texts = new Map();
  for (const req of reqs) {
    const key = req.text.toLowerCase().slice(0, 80);
    texts.set(key, (texts.get(key) || 0) + 1);
  }
  return reqs.map((req) => ({
    ...req,
    duplicates: (texts.get(req.text.toLowerCase().slice(0, 80)) || 0) > 1,
  }));
}

function summarize(results, options = {}) {
  const total = results.length;
  const avg = total ? Math.round((results.reduce((acc, req) => acc + req.score, 0) / total) * 10) / 10 : 0;
  const failing = results.filter((req) => req.score < 70).length;
  const grades = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  const issueCounts = {};

  for (const req of results) {
    if (req.score >= 90) grades.A++;
    else if (req.score >= 80) grades.B++;
    else if (req.score >= 70) grades.C++;
    else if (req.score >= 60) grades.D++;
    else grades.F++;

    for (const failure of req.failed) {
      issueCounts[failure.name] = (issueCounts[failure.name] || 0) + 1;
    }
  }

  const topIssues = Object.entries(issueCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => `${name} (${count})`);

  const minAverageScore = Number(options.minAverageScore ?? 70);
  const maxFailing = Number.isFinite(Number(options.maxFailing)) ? Number(options.maxFailing) : null;
  const passed = total > 0 && avg >= minAverageScore && (maxFailing === null || failing <= maxFailing);

  return {
    total,
    averageScore: avg,
    failing,
    gradeDistribution: grades,
    topIssues,
    minAverageScore,
    maxFailing,
    passed,
  };
}

function build(projectRoot, options = {}) {
  const files = options.files || (options.prd ? [path.resolve(projectRoot, options.prd)] : findPrdFiles(projectRoot));
  let allReqs = [];

  for (const file of files) {
    try {
      allReqs = allReqs.concat(
        extractRequirements(fs.readFileSync(file, 'utf8'), path.relative(projectRoot, file).replace(/\\/g, '/')),
      );
    } catch {
      // Ignore unreadable optional files; missing primary PRD is handled by the caller.
    }
  }

  allReqs = dedupContext(allReqs);
  const results = allReqs.map((req) => ({
    ...evaluateRequirement(req.id, req.text, { duplicates: req.duplicates }),
    text: req.text,
    source: req.source,
  }));

  return {
    standard: 'ISO/IEC/IEEE 29148:2018',
    generatedAt: new Date().toISOString(),
    source: files.map((file) => path.relative(projectRoot, file).replace(/\\/g, '/')).join(', '),
    requirements: results,
    summary: summarize(results, options),
  };
}

function parseArgs(args) {
  const getOpt = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : null;
  };
  const strict = args.includes('--strict');
  return {
    command: args[0] || 'audit',
    prd: getOpt('--prd'),
    out: getOpt('--out'),
    json: args.includes('--json') || args.includes('--quiet-json'),
    quietJson: args.includes('--quiet-json'),
    minAverageScore: Number(getOpt('--min-score')) || 70,
    maxFailing: strict ? 0 : getOpt('--max-failing') === null ? null : Number(getOpt('--max-failing')),
    strict,
  };
}

function printUsage() {
  console.log(
    [
      'cobolt-req-quality - ISO/IEC/IEEE 29148:2018 requirements-quality audit.',
      '',
      'Usage:',
      '  node tools/cobolt-req-quality.js [audit] [--prd <path>] [--out <path>] [--json]',
      '',
      'If no --prd is given, scans _cobolt-output/latest/planning/*.md. Use `--help` or `-h` to print this usage without side effects.',
    ].join('\n'),
  );
}

function main() {
  if (KILL()) {
    console.log('COBOLT_STANDARDS=off - skipping');
    process.exit(0);
  }

  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }
  const options = parseArgs(argv);
  const projectRoot = process.cwd();
  const files = options.prd ? [path.resolve(projectRoot, options.prd)] : findPrdFiles(projectRoot);

  if (!files.length) {
    const skipped = {
      standard: 'ISO/IEC/IEEE 29148:2018',
      generatedAt: new Date().toISOString(),
      source: '',
      requirements: [],
      summary: summarize([], options),
      skipped: true,
      reason: 'no PRD artifacts found',
    };
    const outDir = path.join(projectRoot, '_cobolt-output', 'standards');
    fs.mkdirSync(outDir, { recursive: true });
    const out = options.out ? path.resolve(projectRoot, options.out) : path.join(outDir, 'iso29148-req-quality.json');
    fs.writeFileSync(out, JSON.stringify(skipped, null, 2));
    if (options.json) console.log(JSON.stringify(skipped, null, 2));
    else console.log('req-quality: no PRD artifacts found (expected _cobolt-output/latest/planning/prd.md)');
    process.exit(0);
  }

  const data = build(projectRoot, { ...options, files });
  const outDir = path.join(projectRoot, '_cobolt-output', 'standards');
  fs.mkdirSync(outDir, { recursive: true });
  const out = options.out ? path.resolve(projectRoot, options.out) : path.join(outDir, 'iso29148-req-quality.json');
  fs.writeFileSync(out, JSON.stringify(data, null, 2));

  if (options.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(
      `req-quality: total=${data.summary.total}  avg=${data.summary.averageScore}  failing=${data.summary.failing}`,
    );
    if (data.summary.topIssues.length) console.log(`  top issues: ${data.summary.topIssues.join(', ')}`);
    console.log(`  written: ${out}`);
  }

  process.exit(data.summary.passed || !options.strict ? 0 : 1);
}

if (require.main === module) main();
module.exports = { build, extractRequirements, findPrdFiles, parseArgs, summarize };
