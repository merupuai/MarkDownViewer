#!/usr/bin/env node

// CoBolt Readiness Render — machine-first readiness report generation.
//
// The Meru planning incident (2026-04-20) had one structural asymmetry we
// haven't yet fixed: downstream consumers read the human-readable
// readiness-report.md, but it was hand-authored and could polish a
// deterministic FAIL into a prose PASS-WITH-ADVISORIES. We closed that with
// cobolt-readiness-consistency-gate.js (blocks inconsistent writes).
//
// This tool flips the producer side: readiness-report.md is now a pure
// projection of readiness-deterministic.json. You don't author it; you
// render it. The banner makes that contract explicit:
//
//     <!-- Generated from readiness-deterministic.json — DO NOT EDIT -->
//     <!-- To change the verdict, fix the underlying dimensions and re-run -->
//     <!--   node tools/cobolt-readiness-check.js check --json               -->
//
// This removes the last prose-escape-hatch from the readiness layer.
//
// Usage:
//   node tools/cobolt-readiness-render.js render [--json]
//   node tools/cobolt-readiness-render.js check [--json]  # drift check only
//
// Exit codes:
//   0 = rendered (render) or no drift (check)
//   1 = usage
//   2 = readiness-deterministic.json missing
//   3 = drift detected between current .md and expected render (check mode)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_MISSING = 2;
const EXIT_DRIFT = 3;

const DETERMINISTIC = path.join('_cobolt-output', 'latest', 'planning', 'readiness-deterministic.json');
const REPORT_MD = path.join('_cobolt-output', 'latest', 'planning', 'readiness-report.md');
const REPORT_JSON = path.join('_cobolt-output', 'latest', 'planning', 'readiness-report.json');

// Banner embedded at the top + bottom of the rendered .md. The gate hook
// recognizes this marker and refuses edits that strip it.
const BANNER_TOP = [
  '<!-- =============================================================== -->',
  '<!-- GENERATED from readiness-deterministic.json — DO NOT EDIT BY HAND -->',
  '<!-- =============================================================== -->',
  '<!--                                                                   -->',
  '<!-- This file is a pure projection of the deterministic JSON truth.   -->',
  '<!-- To change the verdict, fix the underlying dimensions and re-run:  -->',
  '<!--   node tools/cobolt-readiness-check.js check --json               -->',
  '<!--   node tools/cobolt-readiness-aggregate.js check --rewrite --json -->',
  '<!--   node tools/cobolt-readiness-render.js render                    -->',
  '<!--                                                                   -->',
  '<!-- Hand-edits will be overwritten on the next render and will be     -->',
  '<!-- blocked by cobolt-readiness-consistency-gate.js.                  -->',
  '<!-- =============================================================== -->',
  '',
].join('\n');

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function readJsonSafe(p) {
  const raw = readFileSafe(p);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function render(deterministic) {
  const d = deterministic || {};
  const verdict = String(d.verdict || 'UNKNOWN').toUpperCase();
  const grade = d.grade || '(none)';
  const avgScore = typeof d.avgScore === 'number' ? d.avgScore.toFixed(2) : '(none)';
  const hardFailedDims = Array.isArray(d.hardFailedDims) ? d.hardFailedDims : [];
  const failedDims = Array.isArray(d.failedDimensions) ? d.failedDimensions : [];
  const dimensions = d.dimensions || d.dims || {};
  const generatedAt = new Date().toISOString();

  const lines = [];
  lines.push(BANNER_TOP);
  lines.push('# Implementation Readiness Report');
  lines.push('');
  lines.push(`_Generated: ${generatedAt}_`);
  lines.push(`_Source: readiness-deterministic.json_`);
  lines.push('');
  lines.push('## Verdict');
  lines.push('');
  lines.push(verdict);
  lines.push('');
  if (verdict === 'FAIL' || hardFailedDims.length > 0) {
    lines.push('> **Build is NOT authorized.** Remediate the hard-failed dimensions before');
    lines.push('> retrying. plan-readiness-gate and readiness-consistency-gate will both');
    lines.push('> block cobolt-build while this verdict stands.');
    lines.push('');
  }

  lines.push('## Summary');
  lines.push('');
  lines.push(`- Grade: ${grade}`);
  lines.push(`- Average score: ${avgScore}`);
  if (hardFailedDims.length > 0) {
    lines.push(`- Hard-failed dimensions: ${hardFailedDims.join(', ')}`);
  }
  if (failedDims.length > 0 && failedDims.join(',') !== hardFailedDims.join(',')) {
    lines.push(`- Soft-failed dimensions: ${failedDims.filter((f) => !hardFailedDims.includes(f)).join(', ')}`);
  }
  lines.push('');

  if (Object.keys(dimensions).length > 0) {
    lines.push('## Dimensions');
    lines.push('');
    lines.push('| Dim | Name | Score | Status |');
    lines.push('|-----|------|-------|--------|');
    for (const [dim, data] of Object.entries(dimensions)) {
      const name = data?.name || '(unnamed)';
      const score = typeof data?.score === 'number' ? data.score.toFixed(1) : '?';
      const status = data?.status || data?.hardFail ? 'HARD FAIL' : data?.passed ? 'PASS' : 'SOFT FAIL';
      lines.push(`| ${dim} | ${name} | ${score} | ${status} |`);
    }
    lines.push('');
  }

  if (Array.isArray(d.remediationActions) && d.remediationActions.length > 0) {
    lines.push('## Remediation');
    lines.push('');
    for (const action of d.remediationActions) {
      lines.push(`- ${action}`);
    }
    lines.push('');
  }

  // Content hash so drift-check can detect hand-edits deterministically
  const body = lines.join('\n');
  const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
  lines.push('');
  lines.push(`<!-- content-hash: ${hash} -->`);
  lines.push(`<!-- deterministic-verdict: ${verdict} -->`);
  lines.push(`<!-- deterministic-source: ${DETERMINISTIC} -->`);
  lines.push('');

  return lines.join('\n');
}

function doRender() {
  const d = readJsonSafe(DETERMINISTIC);
  if (!d) {
    return { exitCode: EXIT_MISSING, error: `readiness-deterministic.json missing at ${DETERMINISTIC}` };
  }
  const md = render(d);
  try {
    fs.mkdirSync(path.dirname(REPORT_MD), { recursive: true });
    fs.writeFileSync(REPORT_MD, md);
    // Also sync readiness-report.json verdict to match deterministic
    const reportJson = {
      verdict: d.verdict,
      grade: d.grade,
      score: d.avgScore,
      failedDimensions: d.hardFailedDims || d.failedDimensions || [],
      generatedAt: new Date().toISOString(),
      source: 'readiness-deterministic.json (via cobolt-readiness-render)',
      synthetic: false,
    };
    fs.writeFileSync(REPORT_JSON, `${JSON.stringify(reportJson, null, 2)}\n`);
  } catch (e) {
    return { exitCode: 1, error: `write failed: ${e.message}` };
  }
  return {
    exitCode: EXIT_OK,
    rendered: true,
    verdict: d.verdict,
    grade: d.grade,
    pathMd: REPORT_MD,
    pathJson: REPORT_JSON,
  };
}

function doCheck() {
  const d = readJsonSafe(DETERMINISTIC);
  if (!d) {
    return { exitCode: EXIT_MISSING, error: `readiness-deterministic.json missing at ${DETERMINISTIC}` };
  }
  const expected = render(d);
  const current = readFileSafe(REPORT_MD);
  if (!current) {
    return {
      exitCode: EXIT_DRIFT,
      error: 'readiness-report.md does not exist — run render first',
    };
  }
  // Drift = content differs ignoring trailing whitespace. Hand-edits always
  // change content.
  const norm = (s) => s.replace(/\s+$/gm, '').trim();
  if (norm(current) !== norm(expected)) {
    return {
      exitCode: EXIT_DRIFT,
      drift: true,
      error: 'readiness-report.md has drifted from readiness-deterministic.json. Re-run render.',
    };
  }
  return { exitCode: EXIT_OK, drift: false, verdict: d.verdict };
}

function main(argv = process.argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'render';
  const json = args.includes('--json');
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('Usage: cobolt-readiness-render.js <render|check> [--json]');
    process.exit(EXIT_OK);
  }
  let r;
  if (cmd === 'render') r = doRender();
  else if (cmd === 'check') r = doCheck();
  else {
    console.error('Usage: cobolt-readiness-render.js <render|check> [--json]');
    process.exit(EXIT_USAGE);
  }
  if (json) console.log(JSON.stringify(r, null, 2));
  else {
    if (r.error) console.error(r.error);
    console.log(`verdict: ${r.exitCode === EXIT_OK ? 'OK' : r.exitCode === EXIT_DRIFT ? 'DRIFT' : 'MISSING'}`);
  }
  process.exit(r.exitCode);
}

if (require.main === module) main();

module.exports = { render, doRender, doCheck, EXIT_OK, EXIT_DRIFT, EXIT_MISSING };
