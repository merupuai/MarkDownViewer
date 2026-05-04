#!/usr/bin/env node

// CoBolt FR Coverage Verifier: deterministic requirement-to-code verification.
//
// Reads PRD to extract FRs, scans the codebase for implementations, and verifies
// that each FR has corresponding code and tests.

const fs = require('node:fs');
const path = require('node:path');
const {
  extractRequirementDefinitions,
  normalizeRequirementId,
  normalizeRequirementLookupId,
} = require('../lib/cobolt-requirements');
const { getMilestoneFRCounts } = require('../lib/cobolt-planning-artifacts');
const {
  collectRequirementCandidateFiles,
  DEFAULT_STUB_PATTERNS,
  findRequirementContentEvidence,
  findRequirementEvidence,
} = require('../lib/cobolt-requirement-evidence');
const { walkSourceFiles } = require('../lib/cobolt-source-scan');

const FR_PATTERN = /\bFR(?:(?:[-_.]?[A-Z0-9]+)+)\b/gi;

const STUB_PATTERNS = DEFAULT_STUB_PATTERNS;

function findPlanningDir() {
  const outputRoot = path.join(process.cwd(), '_cobolt-output');
  const candidates = [path.join(outputRoot, 'latest', 'planning'), path.join(outputRoot, 'planning')];

  const latestLink = path.join(outputRoot, 'latest');
  try {
    const target = fs.readlinkSync(latestLink);
    const resolved = path.isAbsolute(target) ? target : path.join(outputRoot, target);
    candidates.unshift(path.join(resolved, 'planning'));
  } catch {
    /* not a symlink */
  }

  try {
    const ptr = fs.readFileSync(`${latestLink}.ptr`, 'utf8').trim();
    candidates.unshift(path.join(ptr, 'planning'));
  } catch {
    /* no ptr */
  }

  return (
    candidates.find((dir) => {
      try {
        return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
      } catch {
        return false;
      }
    }) || candidates[0]
  );
}

function findBuildDir(milestone) {
  const outputRoot = path.join(process.cwd(), '_cobolt-output');
  const candidates = [path.join(outputRoot, 'latest', 'build', milestone), path.join(outputRoot, 'build', milestone)];
  return candidates.find((dir) => fs.existsSync(dir)) || candidates[0];
}

function extractFRsFromPRD(prdPath) {
  if (!fs.existsSync(prdPath)) return [];
  return extractRequirementDefinitions(fs.readFileSync(prdPath, 'utf8'), {
    types: ['functional'],
  }).map((definition) => ({
    id: normalizeRequirementId(definition.id),
    title: definition.title || '',
    description: definition.description || definition.title || '',
    acceptanceCriteria: definition.acceptanceCriteria || [],
  }));
}

function extractMilestoneFRs(frs, milestone, prdContent) {
  if (!milestone) return frs;

  const normalizedMilestone = String(milestone || '')
    .trim()
    .toUpperCase();
  const plannedMilestoneFRs = getMilestoneFRCounts(process.cwd());
  const plannedFRIds = Array.isArray(plannedMilestoneFRs[normalizedMilestone])
    ? new Set(plannedMilestoneFRs[normalizedMilestone].map((frId) => normalizeRequirementLookupId(frId)))
    : new Set();
  if (plannedFRIds.size > 0) {
    return frs.filter((fr) => plannedFRIds.has(normalizeRequirementLookupId(fr.id)));
  }

  const mNum = milestone.replace(/^M/i, '');
  const milestonePatterns = [
    new RegExp(`\\b${milestone}\\b`, 'i'),
    new RegExp(`Milestone\\s+${mNum}\\b`, 'i'),
    new RegExp(`\\[${milestone}\\]`, 'i'),
  ];

  const lines = prdContent.split('\n');
  const milestoneFRs = new Set();

  for (const line of lines) {
    if (!milestonePatterns.some((pattern) => pattern.test(line))) continue;
    const frMatch = line.match(FR_PATTERN);
    if (!frMatch) continue;
    for (const fr of frMatch) {
      milestoneFRs.add(normalizeRequirementLookupId(fr));
    }
  }

  return milestoneFRs.size > 0 ? frs.filter((fr) => milestoneFRs.has(normalizeRequirementLookupId(fr.id))) : frs;
}

function mergeEvidenceFiles(matches = []) {
  return [...new Set(matches.map((match) => match.file))].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );
}

function findFRImplementation(frId, options = {}) {
  const result = {
    hasCode: false,
    hasTest: false,
    codeFiles: [],
    testFiles: [],
    isStub: false,
    evidenceSources: [],
  };
  const evidence = findRequirementEvidence(process.cwd(), frId, {
    includeExtensions: ['.go', '.js', '.ts', '.tsx', '.jsx', '.py', '.ex', '.exs', '.rs', '.java', '.cs', '.xaml'],
  });
  const candidateFiles = collectRequirementCandidateFiles(process.cwd(), frId, {
    planningDir: options.planningDir,
    requirementRecord: options.requirementRecord,
  });
  const contentEvidence = options.requirement
    ? findRequirementContentEvidence(process.cwd(), options.requirement, {
        candidateFiles,
      })
    : { codeMatches: [], testMatches: [], ignoredMatches: [] };
  const mergedCodeMatches = [...evidence.codeMatches, ...contentEvidence.codeMatches];
  const mergedTestMatches = [...evidence.testMatches, ...contentEvidence.testMatches];

  result.codeFiles = mergeEvidenceFiles(mergedCodeMatches);
  result.testFiles = mergeEvidenceFiles(mergedTestMatches);
  result.hasCode = result.codeFiles.length > 0;
  result.hasTest = result.testFiles.length > 0;
  result.isStub = mergedCodeMatches.some((match) => match.hasStubSignals);
  result.evidenceSources = [
    ...(evidence.codeMatches.length > 0 || evidence.testMatches.length > 0 ? ['marker'] : []),
    ...(contentEvidence.codeMatches.length > 0 || contentEvidence.testMatches.length > 0 ? ['content'] : []),
  ];

  if (!result.isStub && result.hasCode) {
    for (const file of result.codeFiles) {
      try {
        const content = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
        const stubCount = STUB_PATTERNS.reduce((count, pattern) => count + (pattern.test(content) ? 1 : 0), 0);
        // F-30 fix: single stub marker is enough to flag — previously required 2+,
        // allowing partially-implemented functions with one TODO to slip through.
        if (stubCount >= 1) {
          result.isStub = true;
          break;
        }
      } catch {
        /* file read error */
      }
    }
  }

  return result;
}

function findMissingRepositories() {
  const missing = [];
  const goFiles = walkSourceFiles(process.cwd(), { includeExtensions: ['.go'] });

  for (const file of goFiles) {
    if (/(?:^|\/)(?:testdata|fixtures?|mocks?)(?:\/|$)|_test\.go$/i.test(file.relativePath)) {
      continue;
    }

    const lines = fs.readFileSync(file.path, 'utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!/\bnil\b/.test(line)) continue;

      const trimmed = line.trim();
      if (
        /(?:==|!=)\s*nil\b/.test(trimmed) ||
        /\bif\b.*\bnil\b/.test(trimmed) ||
        /\breturn\b.*\bnil\b/.test(trimmed) ||
        /\(\s*nil(?:\s*[,)\]])/.test(trimmed)
      ) {
        continue;
      }

      if (/\b\w*(?:repo|repository)\w*\s*(?::|=)\s*nil\b/i.test(trimmed)) {
        missing.push({ file: file.relativePath, line: index + 1, pattern: 'nil-repository' });
      }

      if (/\b\w*(?:service|svc)\w*\s*(?::|=)\s*nil\b/i.test(trimmed)) {
        missing.push({ file: file.relativePath, line: index + 1, pattern: 'nil-service' });
      }
    }
  }

  return missing;
}

function buildCoverageReportForMilestone(milestone = 'M1', threshold = 80) {
  const planDir = findPlanningDir();
  const prdPath = path.join(planDir, 'prd.md');

  if (!fs.existsSync(prdPath)) {
    throw new Error(`PRD not found at ${prdPath}`);
  }

  const prdContent = fs.readFileSync(prdPath, 'utf8');
  const allFRs = extractFRsFromPRD(prdPath);
  const frs = extractMilestoneFRs(allFRs, milestone, prdContent);

  if (frs.length === 0) {
    return {
      milestone,
      totalFRs: 0,
      implemented: 0,
      verified: 0,
      coded: 0,
      tested: 0,
      codeOnly: 0,
      stubbed: 0,
      missing: 0,
      implementedCoverage: 0,
      verifiedCoverage: 0,
      coverage: 0,
      testCoverage: 0,
      threshold,
      passed: false,
      status: 'NO_FRS_FOUND',
      missingRepositories: 0,
      details: [],
      missingRepoDetails: [],
      checkedAt: new Date().toISOString(),
    };
  }

  let implemented = 0;
  let verified = 0;
  let stubbed = 0;
  const details = [];

  for (const fr of frs) {
    const impl = findFRImplementation(fr.id, { requirement: fr });
    const status = impl.isStub ? 'stub' : impl.hasCode ? (impl.hasTest ? 'verified' : 'implemented') : 'missing';

    if (impl.hasCode && !impl.isStub) implemented++;
    if (impl.hasCode && impl.hasTest && !impl.isStub) verified++;
    if (impl.isStub) stubbed++;

    details.push({
      id: fr.id,
      description: fr.description,
      status,
      codeFiles: impl.codeFiles.slice(0, 3),
      testFiles: impl.testFiles.slice(0, 3),
      isStub: impl.isStub,
      evidenceSources: impl.evidenceSources,
    });
  }

  const missingRepos = findMissingRepositories();
  const implementedCoverage = Math.round((implemented / frs.length) * 100);
  const verifiedCoverage = Math.round((verified / frs.length) * 100);
  const passed = verifiedCoverage >= threshold;

  const report = {
    milestone,
    totalFRs: frs.length,
    implemented,
    verified,
    coded: implemented,
    tested: verified,
    codeOnly: Math.max(0, implemented - verified),
    stubbed,
    missing: frs.length - implemented - stubbed,
    implementedCoverage,
    verifiedCoverage,
    coverage: verifiedCoverage,
    testCoverage: verifiedCoverage,
    threshold,
    passed,
    missingRepositories: missingRepos.length,
    details: details.filter((detail) => detail.status !== 'verified'),
    missingRepoDetails: missingRepos.slice(0, 20),
    checkedAt: new Date().toISOString(),
  };

  try {
    const buildDir = findBuildDir(milestone);
    fs.mkdirSync(buildDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(buildDir, `${milestone}-fr-coverage.json`), JSON.stringify(report, null, 2), {
      mode: 0o600,
    });
  } catch {
    /* best-effort save */
  }

  return report;
}

function cmdCheck(args) {
  const milestone = args.milestone || 'M1';
  const threshold = parseInt(args.threshold || '80', 10);
  const jsonOutput = args.json || false;
  let report;

  try {
    report = buildCoverageReportForMilestone(milestone, threshold);
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }

  if (report.totalFRs === 0) {
    console.error(`WARNING: No FRs found in PRD for ${milestone}. Check PRD format (expected FR-001 pattern).`);
    if (jsonOutput) console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const passed = report.passed;
  const details = report.details || [];

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\nFR Coverage Report - ${milestone}`);
    console.log('-'.repeat(50));
    console.log(`Total FRs:        ${report.totalFRs}`);
    console.log(`Implemented:      ${report.implemented} (${report.implementedCoverage}%)`);
    console.log(`Verified:         ${report.verified} (${report.verifiedCoverage}%)`);
    console.log(`Code-only:        ${report.codeOnly}`);
    console.log(`Stubbed:          ${report.stubbed}`);
    console.log(`Missing:          ${report.missing}`);
    console.log(`Nil repos:        ${report.missingRepositories}`);
    console.log(`Threshold:        ${threshold}%`);
    console.log(`Status:           ${passed ? 'PASS' : 'FAIL'}`);

    if (details.some((detail) => detail.status === 'missing')) {
      console.log('\nMissing implementations:');
      for (const detail of details.filter((item) => item.status === 'missing')) {
        console.log(`  ${detail.id}: ${detail.description || '(no description)'}`);
      }
    }

    if (details.some((detail) => detail.status === 'stub')) {
      console.log('\nStubbed implementations:');
      for (const detail of details.filter((item) => item.status === 'stub')) {
        console.log(`  ${detail.id}: ${detail.codeFiles[0] || '?'}`);
      }
    }

    if (details.some((detail) => detail.status === 'implemented')) {
      console.log('\nImplemented without validating tests:');
      for (const detail of details.filter((item) => item.status === 'implemented')) {
        console.log(`  ${detail.id}: ${detail.codeFiles[0] || '?'}`);
      }
    }
  }

  process.exit(passed ? 0 : 1);
}

function cmdReport(args) {
  args.json = false;
  cmdCheck(args);
}

function cmdStubs(args) {
  const milestone = args.milestone || 'M1';
  const planDir = findPlanningDir();
  const prdPath = path.join(planDir, 'prd.md');

  if (!fs.existsSync(prdPath)) {
    console.error(`ERROR: PRD not found at ${prdPath}`);
    process.exit(1);
  }

  const prdContent = fs.readFileSync(prdPath, 'utf8');
  const allFRs = extractFRsFromPRD(prdPath);
  const frs = extractMilestoneFRs(allFRs, milestone, prdContent);

  console.log(`Scanning ${frs.length} FRs for stubs in ${milestone}...`);
  let stubCount = 0;

  for (const fr of frs) {
    const impl = findFRImplementation(fr.id, { requirement: fr });
    if (!impl.isStub) continue;
    stubCount++;
    console.log(`  STUB: ${fr.id} - ${impl.codeFiles[0]}`);
  }

  console.log(`\n${stubCount} stub(s) found out of ${frs.length} FRs.`);
  process.exit(stubCount > 0 ? 1 : 0);
}

function parseArgs(argv) {
  const args = { _cmd: argv[0] };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--milestone' && argv[i + 1]) {
      args.milestone = argv[++i];
    } else if (argv[i] === '--threshold' && argv[i + 1]) {
      args.threshold = argv[++i];
    } else if (argv[i] === '--json') {
      args.json = true;
    }
  }
  return args;
}

function showHelp() {
  console.log(`CoBolt FR Coverage Verifier: deterministic requirement-to-code verification.

Usage:
  node tools/cobolt-fr-coverage.js check --milestone M1 [--threshold 80] [--json]
  node tools/cobolt-fr-coverage.js report --milestone M1
  node tools/cobolt-fr-coverage.js stubs --milestone M1

Commands:
  check    Verify FR coverage meets threshold (default 80%)
  report   Human-readable FR coverage report
  stubs    List stubbed/placeholder FR implementations

Options:
  --milestone M1   Milestone to check (default: M1)
  --threshold 80   Minimum coverage percentage (default: 80)
  --json           Output as JSON

Exit codes:
  0 = coverage >= threshold (PASS)
  1 = coverage < threshold (FAIL) or error`);
}

if (require.main === module) {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === 'help') {
    showHelp();
    process.exit(0);
  }

  const args = parseArgs(argv);

  switch (args._cmd) {
    case 'check':
      cmdCheck(args);
      break;
    case 'report':
      cmdReport(args);
      break;
    case 'stubs':
      cmdStubs(args);
      break;
    default:
      console.error(`Unknown command: ${args._cmd}`);
      showHelp();
      process.exit(1);
  }
}

module.exports = {
  buildCoverageReportForMilestone,
  extractFRsFromPRD,
  extractMilestoneFRs,
  findFRImplementation,
  findMissingRepositories,
};
