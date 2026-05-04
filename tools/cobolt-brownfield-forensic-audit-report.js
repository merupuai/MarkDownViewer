#!/usr/bin/env node

// CoBolt Brownfield Forensic Audit Report Synthesizer
//
// Closes DEFECT-03 (v0.40.12 audit): 16d-forensic-audit-report.md was
// referenced as a hard requirement in 8 places (P2.5→P3 gate, depth-census,
// evidence-index, readiness-gate, gap-review, exec-report, artifact-deps
// schema) but had NO deterministic producer. Every forensic-required run
// (--scan deep, --analysis-only, --scan full, --reverse-engineer) would
// block unless the orchestrator improvised an uncontracted synthesis step.
//
// This tool is the authoritative producer. It reads the four deterministic
// forensic inputs (16a findings, 16b illusion inventory, 16c verification,
// 16e phantom log) and emits the graded executive report at 16d.
//
// Inputs (_cobolt-output/latest/brownfield/):
//   16a-forensic-findings.json     — verified finding array (merged from all agents)
//   16b-illusion-inventory.json    — deterministic illusion-scan output
//   16c-illusion-verification.json — agent verification of illusion-scan
//   16e-phantom-rejection-log.json — per-agent phantom rate
//
// Output:
//   16d-forensic-audit-report.md   — graded executive report (≥500 bytes)
//
// Exit codes (per tools/CLAUDE.md):
//   0 — report written successfully
//   1 — hard error (unwritable, invalid JSON in inputs)
//   2 — usage error
//   3 — required input missing (16a is mandatory; others are optional)
//
// Usage:
//   node tools/cobolt-brownfield-forensic-audit-report.js build [--dir <bf-dir>] [--json]
//   node tools/cobolt-brownfield-forensic-audit-report.js --help

const fs = require('node:fs');
const path = require('node:path');

const OUTPUT_FILE = '16d-forensic-audit-report.md';
const REQUIRED = ['16a-forensic-findings.json'];
const OPTIONAL = ['16b-illusion-inventory.json', '16c-illusion-verification.json', '16e-phantom-rejection-log.json'];

function printHelp() {
  process.stdout.write(
    `cobolt-brownfield-forensic-audit-report — synthesize 16d from 16a/16b/16c/16e\n\n` +
      `USAGE\n` +
      `  node tools/cobolt-brownfield-forensic-audit-report.js build [--dir <bf-dir>] [--json]\n` +
      `  node tools/cobolt-brownfield-forensic-audit-report.js --help\n\n` +
      `EXIT CODES\n` +
      `  0 — report written successfully (16d-forensic-audit-report.md, >=500 bytes)\n` +
      `  1 — hard error (unwritable, invalid JSON in inputs)\n` +
      `  2 — usage error\n` +
      `  3 — required input (16a-forensic-findings.json) missing\n`,
  );
}

function readJson(p) {
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    const e = new Error(`invalid JSON at ${p}: ${err.message}`);
    e.code = 'EBADJSON';
    e.file = p;
    throw e;
  }
}

function normalizeFindings(findings) {
  if (!Array.isArray(findings)) return [];
  return findings.filter((f) => f && typeof f === 'object');
}

function bucketBySeverity(findings) {
  const buckets = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) {
    const sev = String(f.severity || f.priority || 'medium').toLowerCase();
    if (sev in buckets) buckets[sev] += 1;
    else buckets.medium += 1;
  }
  return buckets;
}

function bucketByPrefix(findings) {
  const out = new Map();
  for (const f of findings) {
    const id = String(f.id || '');
    const prefix = id.includes('-') ? id.split('-')[0] : 'MISC';
    out.set(prefix, (out.get(prefix) || 0) + 1);
  }
  return out;
}

function computeGrade(findings, illusionRate, phantomRate) {
  // v0.40.13 PROD-02 hardening: critical findings cap the achievable grade.
  // Previously 1 critical (e.g., CWE-798 hardcoded API key) + 1 medium
  // produced a B+ / 88 which was misleadingly favorable. Critical findings
  // are shipping-blockers by definition — the grade must reflect that.
  //
  // Rubric:
  //   - Each critical finding: 20 point penalty (was 10)
  //   - Each high: 7 (was 5)
  //   - Each medium: 2 (unchanged)
  //   - Each low: 1 (unchanged)
  //   - Illusion rate: up to 30 point penalty (unchanged)
  //   - Phantom rate: up to 20 point penalty (unchanged)
  //   - CAP: when any critical is present, achievable ceiling is 'C' (76)
  //   - CAP: when 3+ high findings, achievable ceiling is 'C+' (79)
  const sev = bucketBySeverity(findings);
  const weighted = sev.critical * 20 + sev.high * 7 + sev.medium * 2 + sev.low * 1;
  const illusionPenalty = (illusionRate || 0) * 30;
  const phantomPenalty = (phantomRate || 0) * 20;
  let score = Math.max(0, 100 - weighted - illusionPenalty - phantomPenalty);
  // Apply severity ceilings — the PRESENCE of critical/high findings matters
  // more than the arithmetic score. A lone CWE-798 is not a B+ project.
  if (sev.critical >= 1)
    score = Math.min(score, 76); // C ceiling
  else if (sev.high >= 3) score = Math.min(score, 79); // C+ ceiling
  let letter;
  if (score >= 93) letter = 'A';
  else if (score >= 90) letter = 'A-';
  else if (score >= 87) letter = 'B+';
  else if (score >= 83) letter = 'B';
  else if (score >= 80) letter = 'B-';
  else if (score >= 77) letter = 'C+';
  else if (score >= 73) letter = 'C';
  else if (score >= 70) letter = 'C-';
  else if (score >= 50) letter = 'D';
  else letter = 'F';
  return { score: Math.round(score), letter };
}

function asRateFromLog(phantomLog) {
  // phantomLog may be {perAgent: [{agent,rate}]} or {agents: {...}} or
  // {phantomRateOverall: 0.2}. Accept any.
  if (!phantomLog || typeof phantomLog !== 'object') return 0;
  if (typeof phantomLog.phantomRateOverall === 'number') return phantomLog.phantomRateOverall;
  const entries = Array.isArray(phantomLog.perAgent)
    ? phantomLog.perAgent
    : Array.isArray(phantomLog.agents)
      ? phantomLog.agents
      : null;
  if (!entries || entries.length === 0) return 0;
  const sum = entries.reduce((acc, e) => acc + (typeof e.rate === 'number' ? e.rate : 0), 0);
  return sum / entries.length;
}

function asIllusionRate(illusionInventory, illusionVerification) {
  const inv =
    illusionInventory && Array.isArray(illusionInventory.illusions)
      ? illusionInventory.illusions
      : Array.isArray(illusionInventory)
        ? illusionInventory
        : [];
  if (inv.length === 0) return 0;
  const verified =
    illusionVerification && Array.isArray(illusionVerification.confirmed)
      ? illusionVerification.confirmed
      : Array.isArray(illusionVerification)
        ? illusionVerification
        : null;
  if (!verified) return 0;
  return Math.min(1, verified.length / inv.length);
}

function renderReport({ findings, illusion, verification, phantomLog, bfDir }) {
  const sev = bucketBySeverity(findings);
  const prefixCounts = bucketByPrefix(findings);
  const illusionRate = asIllusionRate(illusion, verification);
  const phantomRate = asRateFromLog(phantomLog);
  const grade = computeGrade(findings, illusionRate, phantomRate);

  const stamp = new Date().toISOString();
  const lines = [];
  lines.push('# 16d — Forensic Audit Report (Graded Executive Summary)');
  lines.push('');
  lines.push(`_Generated_: ${stamp}`);
  lines.push(`_Source dir_: ${bfDir}`);
  lines.push(`_Producer_: cobolt-brownfield-forensic-audit-report.js`);
  lines.push('');
  lines.push('## Audit Grade');
  lines.push('');
  lines.push(`**Overall grade**: ${grade.letter} (${grade.score}/100)`);
  lines.push(`**Illusion rate**: ${(illusionRate * 100).toFixed(1)}%`);
  lines.push(`**Phantom rate (across agents)**: ${(phantomRate * 100).toFixed(1)}%`);
  lines.push('');
  lines.push('## Findings Summary');
  lines.push('');
  lines.push(`Total findings (post-verification): **${findings.length}**`);
  lines.push('');
  lines.push('| Severity | Count |');
  lines.push('|---|---|');
  for (const k of ['critical', 'high', 'medium', 'low', 'info']) {
    lines.push(`| ${k} | ${sev[k]} |`);
  }
  lines.push('');
  if (prefixCounts.size > 0) {
    lines.push('## Category Breakdown (by finding-id prefix)');
    lines.push('');
    lines.push('| Category | Count |');
    lines.push('|---|---|');
    const sorted = [...prefixCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [k, v] of sorted) lines.push(`| ${k} | ${v} |`);
    lines.push('');
  }
  lines.push('## Confirmed Illusions');
  lines.push('');
  // v0.40.13 PROD-06: distinguish three states explicitly — absent / empty /
  // refuted. Previous rendering conflated "no 16b" with "16b present but
  // every entry refuted" which have very different operational meanings.
  const illusionInvEntries =
    illusion && Array.isArray(illusion.illusions) ? illusion.illusions : Array.isArray(illusion) ? illusion : null;
  const confirmed = verification && Array.isArray(verification.confirmed) ? verification.confirmed : [];
  if (illusionInvEntries === null) {
    lines.push('_`16b-illusion-inventory.json` is **absent** — deterministic illusion-scan did not produce input._');
  } else if (illusionInvEntries.length === 0) {
    lines.push(
      '_`16b-illusion-inventory.json` present but **empty** — illusion scanner ran and found no candidates to verify._',
    );
  } else if (confirmed.length === 0) {
    lines.push(
      `_${illusionInvEntries.length} illusion candidate(s) inventoried in 16b; agent verification confirmed **none** (all refuted)._`,
    );
  } else {
    lines.push(
      `_${confirmed.length} of ${illusionInvEntries.length} inventoried illusions confirmed by verification:_`,
    );
    lines.push('');
    for (const c of confirmed.slice(0, 20)) {
      const file = c.file || c.path || '(unknown)';
      const line = c.line != null ? `:${c.line}` : '';
      const note = c.reason || c.issue || c.description || '';
      lines.push(`- \`${file}${line}\` — ${note}`);
    }
    if (confirmed.length > 20) lines.push(`- _…and ${confirmed.length - 20} more_`);
  }
  lines.push('');
  lines.push('## Top Findings (first 15, sorted by severity)');
  lines.push('');
  const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const sorted = [...findings].sort(
    (a, b) =>
      (order[String(a.severity || 'medium').toLowerCase()] ?? 9) -
      (order[String(b.severity || 'medium').toLowerCase()] ?? 9),
  );
  for (const f of sorted.slice(0, 15)) {
    const fid = f.id || '(no-id)';
    const s = String(f.severity || 'medium').toLowerCase();
    const title = f.title || f.summary || f.message || '(no title)';
    const file = f.file || f.path || '';
    const line = f.line != null ? `:${f.line}` : '';
    lines.push(`- **[${s}] ${fid}** ${title}${file ? ` — \`${file}${line}\`` : ''}`);
  }
  if (sorted.length > 15) lines.push(`- _…and ${sorted.length - 15} more_`);
  lines.push('');
  lines.push('## Reviewer Reliability');
  lines.push('');
  if (phantomLog && Array.isArray(phantomLog.perAgent) && phantomLog.perAgent.length > 0) {
    lines.push('| Agent | Phantom rate | Raw findings | Kept |');
    lines.push('|---|---|---|---|');
    for (const e of phantomLog.perAgent) {
      const agent = e.agent || '(unknown)';
      const rate = typeof e.rate === 'number' ? `${(e.rate * 100).toFixed(1)}%` : 'n/a';
      const raw = e.raw != null ? e.raw : 'n/a';
      const kept = e.kept != null ? e.kept : 'n/a';
      lines.push(`| ${agent} | ${rate} | ${raw} | ${kept} |`);
    }
  } else {
    lines.push('_Phantom-rejection log not populated._');
  }
  lines.push('');
  lines.push('## Inputs Consumed');
  lines.push('');
  lines.push('| Input | Present | Size (bytes) |');
  lines.push('|---|---|---|');
  for (const f of [...REQUIRED, ...OPTIONAL]) {
    const p = path.join(bfDir, f);
    const present = fs.existsSync(p);
    const size = present ? fs.statSync(p).size : 0;
    lines.push(`| \`${f}\` | ${present ? 'yes' : 'no'} | ${size} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('_This report is produced deterministically from Phase 2.5 forensic artifacts._');
  lines.push('_Non-null inputs → graded summary; null inputs → section marked accordingly._');
  lines.push('');
  return lines.join('\n');
}

function build(bfDir, _options = {}) {
  if (!fs.existsSync(bfDir)) {
    return { ok: false, reason: 'brownfield-dir-missing', path: bfDir, exit: 3 };
  }
  const findingsPath = path.join(bfDir, '16a-forensic-findings.json');
  if (!fs.existsSync(findingsPath)) {
    return { ok: false, reason: 'forensic-findings-missing', path: findingsPath, exit: 3 };
  }
  let findings;
  let illusion;
  let verification;
  let phantomLog;
  try {
    findings = normalizeFindings(readJson(findingsPath));
    illusion = readJson(path.join(bfDir, '16b-illusion-inventory.json'));
    verification = readJson(path.join(bfDir, '16c-illusion-verification.json'));
    phantomLog = readJson(path.join(bfDir, '16e-phantom-rejection-log.json'));
  } catch (err) {
    return { ok: false, reason: 'invalid-input-json', detail: err.message, exit: 1 };
  }

  const body = renderReport({ findings, illusion, verification, phantomLog, bfDir });
  const outPath = path.join(bfDir, OUTPUT_FILE);
  try {
    fs.writeFileSync(outPath, body);
  } catch (err) {
    return { ok: false, reason: 'write-failed', detail: err.message, path: outPath, exit: 1 };
  }
  const size = fs.statSync(outPath).size;
  return {
    ok: true,
    path: outPath,
    size,
    findings: findings.length,
    exit: 0,
  };
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }
  if (args[0] !== 'build') {
    process.stderr.write(`Unknown command: ${args[0]}\n`);
    printHelp();
    return 2;
  }
  const dirIdx = args.indexOf('--dir');
  const bfDir =
    dirIdx !== -1 && args[dirIdx + 1]
      ? path.resolve(args[dirIdx + 1])
      : path.join(process.cwd(), '_cobolt-output', 'latest', 'brownfield');
  const wantJson = args.includes('--json');

  const result = build(bfDir, { wantJson });

  if (wantJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(`wrote ${result.path} (${result.size} bytes, ${result.findings} findings)\n`);
  } else {
    process.stderr.write(`FAIL: ${result.reason}${result.detail ? `: ${result.detail}` : ''}\n`);
  }
  return result.exit;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { build, renderReport, computeGrade, bucketBySeverity };
