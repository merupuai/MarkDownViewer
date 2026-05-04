#!/usr/bin/env node

// CoBolt RTM mapped-integrity - census check on rtm.json that verifies the
// canonical mapping fields (`stories`, `epics`/`epic`, `milestones`) are
// internally consistent and that traceability-matrix.md is regenerated from
// the current RTM.
//
// Legacy `mapped_to_stories` / `mapped_to_epics` aliases are tolerated for
// backward compatibility, but they are no longer authoritative. When present,
// they must agree with the canonical fields instead of replacing them.
//
// Invariants enforced:
//   1. Canonical story mappings must reach the coverage threshold
//      (default 85%).
//   2. Legacy mapped_to_* aliases, when present, must agree with the
//      canonical `stories` / `epics` data.
//   3. traceability-matrix.md, if present, must report a coverage number >0
//      whenever rtm.json has >0 requirements with mappings.
//   4. rtm.json integrity digest (if present) must match a freshly computed
//      canonical hash of the stable fields.
//
// Exit codes:
//   0 = integrity + coverage pass
//   1 = usage
//   2 = rtm.json missing (skip)
//   3 = integrity violations - Tier 1 block

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_MISSING = 2;
const EXIT_VIOLATION = 3;

function planningDir(cwd = process.cwd()) {
  const p = path.join(cwd, '_cobolt-output', 'latest', 'planning');
  return fs.existsSync(p) ? p : null;
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function readJsonSafe(filePath) {
  const raw = readFileSafe(filePath);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function uniqueSorted(values) {
  return [...new Set((values || []).filter(Boolean).map((value) => String(value)))].sort();
}

function storyLinks(requirement) {
  const canonical = uniqueSorted(requirement?.stories);
  if (canonical.length > 0) return canonical;
  return uniqueSorted(requirement?.mapped_to_stories);
}

function epicLinks(requirement) {
  const canonical = uniqueSorted(requirement?.epics);
  if (canonical.length > 0) return canonical;
  if (requirement?.epic) return uniqueSorted([requirement.epic]);
  return uniqueSorted(requirement?.mapped_to_epics);
}

function legacyStoryLinks(requirement) {
  return uniqueSorted(requirement?.mapped_to_stories);
}

function legacyEpicLinks(requirement) {
  return uniqueSorted(requirement?.mapped_to_epics);
}

function milestoneLinks(requirement) {
  const milestones = uniqueSorted(requirement?.milestones);
  if (milestones.length > 0) return milestones;
  if (requirement?.milestone) return uniqueSorted([requirement.milestone]);
  return [];
}

function canonicalRtmHash(rtm) {
  // Hash a stable subset of rtm.json using canonical fields. Legacy
  // mapped_to_* aliases collapse into the canonical story/epic view so the
  // digest does not fail solely because an artifact used alias fields.
  const reqs = rtm.requirements || rtm.entries || {};
  const rows = [];
  for (const id of Object.keys(reqs).sort()) {
    const requirement = reqs[id] || {};
    rows.push({
      id,
      stories: storyLinks(requirement),
      epics: epicLinks(requirement),
      milestones: milestoneLinks(requirement),
    });
  }
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function check({ threshold = 85 } = {}) {
  const pd = planningDir();
  if (!pd) return { exitCode: EXIT_MISSING, error: 'no planning directory' };
  const rtm = readJsonSafe(path.join(pd, 'rtm.json'));
  if (!rtm) return { exitCode: EXIT_MISSING, error: 'rtm.json missing', planningDir: pd };

  const requirements = rtm.requirements || rtm.entries || {};
  const reqIds = Object.keys(requirements);
  if (reqIds.length === 0) {
    return { exitCode: EXIT_MISSING, error: 'rtm.json has no requirements', planningDir: pd };
  }

  const violations = [];
  let withStoryLinks = 0;
  let withLegacyStoryAliases = 0;
  let withEpicLinks = 0;
  let withLegacyEpicAliases = 0;
  let total = 0;

  for (const id of reqIds) {
    total++;
    const requirement = requirements[id] || {};
    const stories = storyLinks(requirement);
    const mappedStories = legacyStoryLinks(requirement);
    const epics = epicLinks(requirement);
    const mappedEpics = legacyEpicLinks(requirement);

    if (stories.length > 0) withStoryLinks++;
    if (mappedStories.length > 0) withLegacyStoryAliases++;
    if (epics.length > 0) withEpicLinks++;
    if (mappedEpics.length > 0) withLegacyEpicAliases++;

    if (mappedStories.length > 0 && JSON.stringify(stories) !== JSON.stringify(mappedStories)) {
      violations.push({
        type: 'legacy-mapped_to_stories-drift',
        requirement: id,
        canonicalStories: stories,
        legacyMappedStories: mappedStories,
        hint: 'Legacy `mapped_to_stories` is present but does not match the canonical `stories` mapping.',
      });
    }

    if (mappedEpics.length > 0 && JSON.stringify(epics) !== JSON.stringify(mappedEpics)) {
      violations.push({
        type: 'legacy-mapped_to_epics-drift',
        requirement: id,
        canonicalEpics: epics,
        legacyMappedEpics: mappedEpics,
        hint: 'Legacy `mapped_to_epics` is present but does not match the canonical `epics`/`epic` mapping.',
      });
    }
  }

  const mappedCoveragePct = total > 0 ? Math.round((withStoryLinks / total) * 100) : 0;
  if (mappedCoveragePct < threshold) {
    violations.push({
      type: 'mapped-coverage-below-threshold',
      mappedCoveragePct,
      threshold,
      mappedRequirements: withStoryLinks,
      total,
      hint: `Only ${mappedCoveragePct}% of requirements have canonical story mappings (threshold ${threshold}%). Regenerate rtm.json from PRD + epics + stories.`,
    });
  }

  if (rtm.integrity) {
    const expectedDigest = rtm.integrity?.digest || rtm.integrity?.sha256 || rtm.integrity;
    if (typeof expectedDigest === 'string' && expectedDigest.length >= 16) {
      const actual = canonicalRtmHash(rtm);
      if (actual !== expectedDigest) {
        violations.push({
          type: 'integrity-digest-mismatch',
          expected: `${expectedDigest.slice(0, 16)}...`,
          actual: `${actual.slice(0, 16)}...`,
          hint: 'rtm.json integrity digest does not match a fresh canonical hash. Regenerate the digest after every RTM mutation.',
        });
      }
    }
  }

  const matrix = readFileSafe(path.join(pd, 'traceability-matrix.md'));
  if (matrix && withStoryLinks > 0) {
    const covMatches = [...matrix.matchAll(/coverage\s*[:=]?\s*(\d{1,3})\s*%/gi)].map((m) => Number(m[1]));
    if (covMatches.length > 0) {
      const maxCov = Math.max(...covMatches);
      if (maxCov === 0) {
        violations.push({
          type: 'traceability-matrix-reports-zero-coverage',
          rtmMappedCoveragePct: mappedCoveragePct,
          matrixReportedCoveragePct: 0,
          hint: 'rtm.json has mappings but traceability-matrix.md shows 0% coverage. Regenerate the matrix from rtm.json.',
        });
      }
    }
  }

  return {
    exitCode: violations.length > 0 ? EXIT_VIOLATION : EXIT_OK,
    planningDir: pd,
    summary: {
      totalRequirements: total,
      withStoryLinks,
      withLegacyStoryAliases,
      withEpicLinks,
      withLegacyEpicAliases,
      mappedCoveragePct,
      threshold,
      violations: violations.length,
    },
    violations,
  };
}

function formatText(result) {
  const lines = ['== RTM Mapped Integrity =='];
  lines.push(`  planningDir: ${result.planningDir || '(missing)'}`);
  if (result.summary) {
    for (const [key, value] of Object.entries(result.summary)) {
      lines.push(`  ${key}: ${value}`);
    }
  }
  if (result.violations?.length) {
    lines.push('  violations:');
    for (const violation of result.violations.slice(0, 30)) {
      lines.push(`    - [${violation.type}] ${violation.requirement || violation.type}`);
    }
  }
  lines.push(`verdict: ${result.exitCode === EXIT_OK ? 'PASS' : 'VIOLATION'}`);
  return lines.join('\n');
}

function main(argv = process.argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'check';
  const json = args.includes('--json');
  const thresholdIndex = args.indexOf('--threshold');
  const threshold = thresholdIndex >= 0 ? Number(args[thresholdIndex + 1]) : 85;

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('Usage: cobolt-rtm-mapped-integrity.js check [--json] [--threshold <pct>]');
    process.exit(EXIT_OK);
  }
  if (cmd !== 'check' && cmd !== 'report') {
    console.error('Usage: cobolt-rtm-mapped-integrity.js check [--json]');
    process.exit(EXIT_USAGE);
  }

  const result = check({ threshold });
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatText(result));
  process.exit(cmd === 'report' ? EXIT_OK : result.exitCode);
}

if (require.main === module) main();

module.exports = {
  check,
  canonicalRtmHash,
  EXIT_OK,
  EXIT_VIOLATION,
  EXIT_MISSING,
  storyLinks,
  epicLinks,
  legacyStoryLinks,
  legacyEpicLinks,
  milestoneLinks,
};
