#!/usr/bin/env node
// CoBolt Framework Versions - citation gate and refresh tool.
//
// Reads source/data/security-frameworks-versions.json and provides:
//   list       -> print all framework citations (canonical reference)
//   citation   -> print the canonical citation string for a framework key
//   check      -> scan a target markdown file for stale framework citations
//   refresh    -> fetch official sources, parse current editions, and update
//                the checked-in registry safely when changes are machine-verifiable

const fs = require('node:fs');
const path = require('node:path');
const {
  assessFrameworkRegistryFreshness,
  getFrameworkCitation,
  loadFrameworkRegistry,
  loadFrameworkSourceManifest,
  refreshFrameworkRegistry,
} = require('../lib/cobolt-framework-versions');

const CONTEXT_HINTS = [
  'predecessor',
  'prior version',
  'previously',
  'retired',
  'superseded',
  'replaced',
  'deprecated',
  'transition',
];
const CONTEXT_WINDOW = 80;
const STALE_PATTERNS = {
  owaspAsvs: [
    {
      pattern: /OWASP ASVS\s*v?4\.0(\.\d+)?/gi,
      staleVersion: 'v4.0.x',
      reason: 'v5.0.0 is the current published ASVS release',
    },
    { pattern: /OWASP ASVS\s*v?3\./gi, staleVersion: 'v3.x', reason: 'v5.0.0 is the current published ASVS release' },
  ],
  owaspTop10: [
    {
      pattern: /OWASP Top(?: Ten| 10)\s*(?:\(?20(21|17|13)\)?|:20(21|17|13))/gi,
      staleVersion: '2021 / 2017 / 2013',
      reason: 'OWASP Top 10:2025 is the current released edition',
    },
  ],
  nistSsdf: [
    {
      pattern: /NIST SSDF\s*v?1\.0\b/gi,
      staleVersion: 'v1.0',
      reason: 'SP 800-218 SSDF v1.1 is the current final baseline',
    },
    {
      pattern: /SP 800-218\s*(?:v?1\.0\b|Version 1\.0\b)/gi,
      staleVersion: 'SP 800-218 v1.0',
      reason: 'SP 800-218 SSDF v1.1 is the current final baseline',
    },
  ],
  nistCsf: [
    {
      pattern: /NIST CSF\s*v?1\.[01]\b/gi,
      staleVersion: 'v1.x',
      reason: 'NIST CSF v2.0 is the current published release',
    },
  ],
  iso27001: [
    {
      pattern: /ISO\/IEC 27001:2013/gi,
      staleVersion: '2013',
      reason: 'ISO/IEC 27001:2022 is the current published edition',
    },
  ],
  iso27701: [
    {
      pattern: /ISO\/IEC 27701:2019/gi,
      staleVersion: '2019',
      reason: 'ISO/IEC 27701:2025 is the current published edition',
    },
  ],
  pciDss: [
    {
      pattern: /PCI(?:-|\s)DSS\s*v?3\.\d/gi,
      staleVersion: 'v3.x',
      reason: 'PCI DSS v4.0.1 is the current published release',
    },
  ],
  wcag: [
    { pattern: /WCAG\s*2\.[01]\b/gi, staleVersion: '2.0 / 2.1', reason: 'WCAG 2.2 is the current W3C Recommendation' },
  ],
};

function usage() {
  console.log(`CoBolt Framework Versions - security citation gate

Usage:
  node tools/cobolt-framework-versions.js list [--json] [--registry-root <path>]
  node tools/cobolt-framework-versions.js citation <framework-key> [--json] [--registry-root <path>]
  node tools/cobolt-framework-versions.js check <target-md-file> [--json] [--strict] [--registry-root <path>]
  node tools/cobolt-framework-versions.js refresh [--json] [--write] [--touch-review-date] [--only <k1,k2>] [--fixtures-dir <path>] [--registry-root <path>]

Commands:
  list       Print all registered frameworks and their canonical citations.
  citation   Print the canonical citation string for a single framework key.
  check      Scan a markdown file for stale or outdated framework citations.
  refresh    Fetch official sources, refresh machine-verifiable registry entries,
             and optionally write updates back to the checked-in registry.

Options:
  --json             Machine-readable output.
  --strict           Exit 1 on any stale citation (check only).
  --write            Persist refreshed framework entries to the registry.
  --touch-review-date Write review metadata even when no framework entry changed.
  --only             Comma-separated framework keys to refresh.
  --fixtures-dir     Directory of fixture files used instead of live network fetches.
  --registry-root    Alternate project root containing source/data and source/schemas.

Exit codes:
  0  Success
  1  Stale citation(s) detected with --strict, or refresh reported blocking failures
  2  Registry missing or unparseable
  3  Target file missing (for 'check' command)
`);
}

function failOnRegistryError(err) {
  console.error(`[cobolt-framework-versions] FAIL: ${err.message}`);
  process.exit(2);
}

function parseArgValue(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0 || index === args.length - 1) return null;
  return args[index + 1];
}

function parseCommonOptions(args) {
  return {
    json: args.includes('--json'),
    registryRoot: parseArgValue(args, '--registry-root'),
  };
}

function loadRegistry(options = {}) {
  return loadFrameworkRegistry(options);
}

function findMatches(content, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, flags);
  const matches = [];
  let match;

  while ((match = regex.exec(content)) !== null) {
    matches.push({ text: match[0], index: match.index });
    if (match[0].length === 0) regex.lastIndex += 1;
  }

  return matches;
}

function isHistoricalMention(content, match) {
  const before = content.slice(Math.max(0, match.index - CONTEXT_WINDOW), match.index).toLowerCase();
  const after = content
    .slice(match.index + match.text.length, match.index + match.text.length + CONTEXT_WINDOW)
    .toLowerCase();
  return CONTEXT_HINTS.some((hint) => before.includes(hint) || after.includes(hint));
}

function findStaleCitationsInContent(content, registry) {
  const findings = [];

  for (const [frameworkKey, patterns] of Object.entries(STALE_PATTERNS)) {
    const framework = registry.frameworks?.[frameworkKey];
    if (!framework) continue;

    for (const { pattern, staleVersion, reason } of patterns) {
      for (const match of findMatches(content, pattern)) {
        if (isHistoricalMention(content, match)) continue;
        findings.push({
          framework: frameworkKey,
          staleMatch: match.text,
          staleVersion,
          currentCitation: framework.citation,
          reason,
          suggestion: `Replace with: ${framework.citation}`,
        });
      }
    }
  }

  return findings;
}

function cmdList(args) {
  const options = parseCommonOptions(args);
  let registry;
  try {
    registry = loadRegistry({ registryRoot: options.registryRoot });
  } catch (err) {
    failOnRegistryError(err);
  }

  const freshness = assessFrameworkRegistryFreshness({ registry });
  const frameworks = Object.entries(registry.frameworks).map(([key, framework]) => ({
    key,
    name: framework.name,
    citation: framework.citation,
    status: framework.status,
  }));

  if (options.json) {
    console.log(JSON.stringify({ lastReviewed: registry.lastReviewed, freshness, frameworks }, null, 2));
    return;
  }

  console.log(`CoBolt Framework Versions Registry (last reviewed ${registry.lastReviewed})\n`);
  for (const framework of frameworks) {
    console.log(`  ${framework.key.padEnd(16)} ${framework.citation} [${framework.status}]`);
  }
  if (freshness.isStale) {
    console.log(`\nWARNING: registry review is stale (${freshness.ageDays} days old; max ${freshness.maxAgeDays}).`);
  }
}

function cmdCitation(args) {
  const options = parseCommonOptions(args);
  const key = args.find((arg) => !arg.startsWith('--'));
  if (!key) {
    console.error('[cobolt-framework-versions] usage: citation <framework-key>');
    process.exit(1);
  }

  let registry;
  try {
    registry = loadRegistry({ registryRoot: options.registryRoot });
  } catch (err) {
    failOnRegistryError(err);
  }

  if (!registry.frameworks?.[key]) {
    console.error(`[cobolt-framework-versions] FAIL: no framework keyed '${key}'. Run 'list' to see keys.`);
    process.exit(1);
  }

  if (options.json) {
    console.log(JSON.stringify({ key, ...registry.frameworks[key] }, null, 2));
    return;
  }

  console.log(getFrameworkCitation(key, { registry }));
}

function cmdCheck(args) {
  const options = parseCommonOptions(args);
  const strict = args.includes('--strict');
  const target = args.find((arg) => !arg.startsWith('--'));
  if (!target) {
    console.error('[cobolt-framework-versions] usage: check <target-md-file>');
    process.exit(1);
  }

  const absTarget = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
  if (!fs.existsSync(absTarget)) {
    console.error(`[cobolt-framework-versions] target file missing: ${absTarget}`);
    process.exit(3);
  }

  let registry;
  try {
    registry = loadRegistry({ registryRoot: options.registryRoot });
  } catch (err) {
    failOnRegistryError(err);
  }

  const freshness = assessFrameworkRegistryFreshness({ registry });
  const content = fs.readFileSync(absTarget, 'utf8');
  const findings = findStaleCitationsInContent(content, registry);
  const result = {
    target: absTarget,
    registryLastReviewed: registry.lastReviewed,
    registryFreshness: freshness,
    findings,
    findingCount: findings.length,
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (findings.length === 0) {
    console.log(`PASS: no stale framework citations in ${path.relative(process.cwd(), absTarget)}`);
  } else {
    console.log(`FAIL: ${findings.length} stale framework citation(s) in ${path.relative(process.cwd(), absTarget)}:`);
    for (const finding of findings) {
      console.log(`  [${finding.framework}] "${finding.staleMatch}" - ${finding.reason}`);
      console.log(`    suggestion: ${finding.suggestion}`);
    }
  }

  if (!options.json && freshness.isStale) {
    console.log(
      `WARNING: registry review is stale (${freshness.ageDays} days old; update source/data/security-frameworks-versions.json).`,
    );
  }

  if (strict && findings.length > 0) process.exit(1);
}

async function cmdRefresh(args) {
  const options = parseCommonOptions(args);
  const write = args.includes('--write');
  const touchReviewDate = args.includes('--touch-review-date');
  const fixturesDir = parseArgValue(args, '--fixtures-dir');
  const onlyKeys = parseArgValue(args, '--only');

  try {
    loadFrameworkSourceManifest({ registryRoot: options.registryRoot });
  } catch (err) {
    failOnRegistryError(err);
  }

  let report;
  try {
    report = await refreshFrameworkRegistry({
      registryRoot: options.registryRoot,
      fixturesDir,
      onlyKeys,
      touchReviewDate,
      write,
    });
  } catch (err) {
    console.error(`[cobolt-framework-versions] FAIL: ${err.message}`);
    process.exit(1);
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Framework registry refresh checked ${report.summary.total} source(s).`);
    console.log(
      `Updated: ${report.summary.updated} | Unchanged: ${report.summary.unchanged} | Manual: ${report.summary.skippedManual} | Review required: ${report.summary.reviewRequired} | Failed: ${report.summary.failed}`,
    );

    for (const result of report.results) {
      const label = `[${result.key}] ${result.status}`;
      if (result.status === 'updated') {
        console.log(`${label}: ${result.currentVersionBefore} -> ${result.currentVersionAfter}`);
      } else if (result.status === 'review-required' || result.status === 'failed') {
        console.log(`${label}: ${result.error}`);
      } else if (result.status === 'skipped-manual') {
        console.log(`${label}: ${result.reason}`);
      }
    }

    if (report.wroteRegistry) {
      console.log(`\nWrote refreshed registry to ${report.registryPath}`);
    } else if (write && !report.changed && !touchReviewDate) {
      console.log('\nNo framework entry changes detected; registry file left untouched.');
    }
  }

  if (!report.ok) process.exit(1);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'list':
      return cmdList(args);
    case 'citation':
      return cmdCitation(args);
    case 'check':
      return cmdCheck(args);
    case 'refresh':
      return cmdRefresh(args);
    case '--help':
    case '-h':
    case undefined:
      usage();
      return process.exit(0);
    default:
      console.error(`[cobolt-framework-versions] unknown command: ${command}`);
      usage();
      process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[cobolt-framework-versions] FAIL: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  assessRegistryFreshness: assessFrameworkRegistryFreshness,
  findStaleCitationsInContent,
  getFrameworkCitation,
  loadRegistry,
  refreshRegistry: refreshFrameworkRegistry,
};
