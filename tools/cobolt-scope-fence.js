#!/usr/bin/env node
/**
 * cobolt-scope-fence.js — Classify review/fix findings as in-scope or
 * out-of-scope for the current milestone, preventing unrelated P0s (e.g.
 * credential rotation) from derailing delivery.
 *
 * A finding is IN SCOPE if any of:
 *   - finding.location.file is in the milestone's touched-files set
 *   - finding.category matches a milestone FR tag (AUTHZ on an auth milestone)
 *   - finding.severity === 'critical' AND finding is a security vulnerability
 *     that was INTRODUCED by this milestone's diff (new code only)
 *
 * Out-of-scope findings are NOT dropped. They are routed to
 * `_cobolt-output/latest/fix/deferred-findings.json` and surfaced in the
 * milestone report. They do NOT block the milestone but DO block the
 * release-train until addressed in a subsequent milestone.
 *
 * Usage:
 *   node tools/cobolt-scope-fence.js classify <findings.json> <milestone>
 *   node tools/cobolt-scope-fence.js report <milestone>
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveReadablePlanningDir } = require('../lib/cobolt-planning-artifacts');

function projectRoot() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function latestOutputDir() {
  return path.join(projectRoot(), '_cobolt-output', 'latest');
}

function readJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function uniquePaths(paths) {
  const seen = new Set();
  const results = [];
  for (const candidate of paths) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(candidate);
  }
  return results;
}

function planningArtifactCandidates(fileNames) {
  const root = projectRoot();
  const names = Array.isArray(fileNames) ? fileNames : [fileNames];
  const readablePlanningDir = resolveReadablePlanningDir(root, { allowLatestFallback: true });
  const dirs = uniquePaths([
    readablePlanningDir,
    path.join(root, '_cobolt-output', 'latest', 'planning'),
    path.join(root, '_cobolt-output', 'planning'),
    // Backward-compatible read-only fallback for pre-standardization outputs.
    path.join(root, '_cobolt-output', 'latest', 'plan'),
  ]);

  return dirs.flatMap((dir) => names.map((name) => path.join(dir, name)));
}

function readFirstJson(paths, fallback = null) {
  for (const candidate of uniquePaths(paths)) {
    const payload = readJson(candidate, null);
    if (payload) return payload;
  }
  return fallback;
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function milestoneTouchedFiles(milestone) {
  // Derive from git diff against the milestone's baseline commit, if recorded.
  const root = projectRoot();
  const state = readJson(path.join(root, 'cobolt-state.json'), {});
  const base = state?.milestones?.[milestone]?.baselineCommit;
  if (!base) return null;
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return new Set(out.split('\n').filter(Boolean));
  } catch {
    return null;
  }
}

function milestoneTags(milestone) {
  // Read the milestone's FR categories from planning artifacts.
  const ms = readFirstJson(planningArtifactCandidates(['milestones.json', 'milestone-tracker.json']), {});
  const m = ms?.milestones?.find((x) => x.id === milestone);
  if (!m) return new Set();
  const tags = new Set();
  for (const fr of m.functionalRequirements || m.requirements || []) {
    const title = typeof fr === 'string' ? fr : fr.title || fr.id || fr.description || '';
    if (fr.category) tags.add(fr.category.toUpperCase());
    if (/auth|rbac|role|permission/i.test(title)) tags.add('AUTHZ');
    if (/credential|secret|token/i.test(title)) tags.add('SECRETS');
  }
  return tags;
}

function classifyFinding(finding, touched, tags) {
  const file = finding?.location?.file;
  const category = (finding?.category || finding?.prefix || '').toUpperCase().split('-')[0];
  const severity = (finding?.severity || '').toLowerCase();

  const reasons = [];

  if (touched && file && touched.has(file)) reasons.push('file-in-milestone-diff');
  if (tags.has(category)) reasons.push(`category-matches-milestone-tag:${category}`);
  if (severity === 'critical' && category === 'SEC' && touched && file && touched.has(file)) {
    reasons.push('critical-security-in-new-code');
  }

  // Heuristic: findings explicitly tagged as pre-existing are out-of-scope.
  if (finding?.preExisting === true) {
    return { inScope: false, reasons: ['marked-pre-existing'] };
  }

  return { inScope: reasons.length > 0, reasons };
}

function classify(findingsPath, milestone) {
  const findings = readJson(findingsPath, { findings: [] });
  const list = Array.isArray(findings) ? findings : findings.findings || [];
  const touched = milestoneTouchedFiles(milestone);
  const tags = milestoneTags(milestone);

  const inScope = [];
  const deferred = [];
  for (const f of list) {
    const verdict = classifyFinding(f, touched, tags);
    const annotated = { ...f, scopeFence: verdict };
    if (verdict.inScope) inScope.push(annotated);
    else deferred.push(annotated);
  }

  writeJson(path.join(latestOutputDir(), 'fix', 'in-scope-findings.json'), {
    milestone,
    count: inScope.length,
    findings: inScope,
  });
  writeJson(path.join(latestOutputDir(), 'fix', 'deferred-findings.json'), {
    milestone,
    count: deferred.length,
    findings: deferred,
  });

  console.log(`scope-fence: in-scope=${inScope.length} deferred=${deferred.length} milestone=${milestone}`);
  return { inScope: inScope.length, deferred: deferred.length };
}

function report(milestone) {
  const deferred = readJson(path.join(latestOutputDir(), 'fix', 'deferred-findings.json'), { findings: [] });
  console.log(`# Deferred findings for ${milestone}`);
  console.log(`Total: ${deferred.findings.length}`);
  for (const f of deferred.findings) {
    console.log(
      `- [${f.severity}] ${f.id || f.prefix}: ${f.title || f.description} (${f.scopeFence?.reasons?.join(', ') || 'no-reason'})`,
    );
  }
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'classify': {
      const [findingsPath, milestone] = args;
      if (!findingsPath || !milestone) {
        console.error('usage: classify <findings.json> <milestone>');
        process.exit(1);
      }
      classify(findingsPath, milestone);
      break;
    }
    case 'report': {
      const [milestone] = args;
      if (!milestone) {
        console.error('usage: report <milestone>');
        process.exit(1);
      }
      report(milestone);
      break;
    }
    default:
      console.log('cobolt-scope-fence.js — commands: classify, report');
      process.exit(cmd ? 1 : 0);
  }
}

if (require.main === module) main();
module.exports = { classifyFinding, classify, milestoneTags };
