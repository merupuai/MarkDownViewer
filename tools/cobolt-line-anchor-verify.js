#!/usr/bin/env node

// cobolt-line-anchor-verify — v0.45.0 review→fix line-anchor verifier.
//
// Census-verifies every finding in review-findings.json by re-reading the
// cited file:line:codeSnippet tuple. Emits a per-finding verdict so fix
// agents receive corrected line numbers when legitimate drift occurred,
// and so fix-lead dispatch is blocked when the anchor is fabricated
// (file missing, or quoted code not present anywhere near the claimed line).
//
// Closes cascade #2 (reviewer hallucinates file:line; fix agents edit
// phantom lines).
//
// Anchor status semantics:
//   verified — file exists, quoted code appears at claimed line.
//   drifted  — file exists, quoted code appears within search window
//              but not at claimed line. fix agents self-correct.
//   missing  — file doesn't exist OR quoted code absent from search window.
//              Treated as fabricated anchor. Blocks fix-lead dispatch.
//
// Default: drifted is soft (pass); missing blocks fix-lead via
// phantom-rate-enforcer gate. Strict mode (COBOLT_LINE_ANCHOR_STRICT=on)
// elevates drifted to block.
//
// Commands:
//   verify [--json] [--strict]     — verify findings and write verdict
//   help | --help | -h             — show usage
//
// Exit codes (per tools/CLAUDE.md contract):
//   0 — all anchors verified (or drift-only in non-strict mode)
//   1 — usage error
//   2 — review-findings.json missing (Tier 2 skip)
//   4 — drift detected (soft; only exits 4 in --strict mode, else 0)
//   5 — missing/fabricated anchors (hard block)
//
// Bypass: COBOLT_LINE_ANCHOR_GATE=off — logged to gate-skip-log.jsonl by
// the integrating hook, not here.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_MISSING_INPUT = 2;
const EXIT_DRIFT = 4;
const EXIT_MISSING_ANCHORS = 5;

const DEFAULT_SEARCH_WINDOW = 5; // +/- lines around claimed location
const FINGERPRINT_VERSION = 'line-anchor-v1';

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function readJson(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

function findReviewFindings(root) {
  const candidates = [
    path.join(root, '_cobolt-output', 'latest', 'review', 'review-findings.json'),
    path.join(root, '_cobolt-output', 'review', 'review-findings.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// Normalize whitespace for fuzzy substring matching — reviewers often
// paraphrase whitespace even when citing code accurately. We match by
// collapsing runs of whitespace.
function normalizeForMatch(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Decide whether a file line "matches" the reviewer's quoted snippet.
// Guards against vacuous matches (empty-string includes every string) by
// requiring both sides to have >=3 non-whitespace characters before either
// direction of substring containment is allowed.
function matchesLine(lineContent, normalizedSnippet) {
  if (!lineContent || lineContent.length < 3) return false;
  if (!normalizedSnippet || normalizedSnippet.length < 3) return false;
  return lineContent.includes(normalizedSnippet) || normalizedSnippet.includes(lineContent);
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function lineContextFingerprint(lines, lineNumber, windowLines = DEFAULT_SEARCH_WINDOW) {
  const n = Number(lineNumber);
  if (!Array.isArray(lines) || !Number.isInteger(n) || n < 1 || n > lines.length) return null;
  const window = Number.isInteger(Number(windowLines)) ? Math.max(0, Number(windowLines)) : DEFAULT_SEARCH_WINDOW;
  const startLine = Math.max(1, n - window);
  const endLine = Math.min(lines.length, n + window);
  const line = lines[n - 1] || '';
  const contextLines = lines.slice(startLine - 1, endLine);
  const record = {
    version: FINGERPRINT_VERSION,
    algorithm: 'sha256',
    lineNumber: n,
    windowLines: window,
    startLine,
    endLine,
    lineHash: sha256(line),
    contextHash: sha256(contextLines.join('\n')),
  };
  record.digest = sha256(
    JSON.stringify({
      version: record.version,
      line: normalizeForMatch(line),
      context: contextLines.map((x) => normalizeForMatch(x)),
    }),
  );
  return record;
}

function sameFingerprint(a, b) {
  if (!a || !b) return false;
  if (a.digest && b.digest && a.digest === b.digest) return true;
  return Boolean(a.lineHash && b.lineHash && a.lineHash === b.lineHash);
}

function findFingerprintLine(lines, emissionFingerprint, originalLine, windowLines = DEFAULT_SEARCH_WINDOW) {
  if (!emissionFingerprint?.lineHash) return null;
  const n = Number(originalLine);
  const window = Number.isInteger(Number(windowLines)) ? Math.max(0, Number(windowLines)) : DEFAULT_SEARCH_WINDOW;
  const lo = Math.max(1, Number.isInteger(n) ? n - window : 1);
  const hi = Math.min(lines.length, Number.isInteger(n) ? n + window : lines.length);
  for (let i = lo; i <= hi; i++) {
    const current = lineContextFingerprint(lines, i, window);
    if (sameFingerprint(current, emissionFingerprint)) return { line: i, fingerprint: current };
  }
  return null;
}

function fingerprintFields(lines, lineNumber, windowLines = DEFAULT_SEARCH_WINDOW) {
  const fp = lineContextFingerprint(lines, lineNumber, windowLines);
  if (!fp) return {};
  return {
    emissionFingerprint: fp,
    currentFingerprint: fp,
  };
}

// Verify a single finding. Returns { anchorStatus, originalLine, actualLine?, drift?, reason? }.
function verifyFinding(finding, root, windowLines = DEFAULT_SEARCH_WINDOW) {
  const loc = finding.location || {};
  const relFile = loc.file;
  const origLine = loc.line;
  const snippet = finding.evidence?.codeSnippet;

  if (!relFile || !origLine) {
    return { anchorStatus: 'verified', reason: 'no file/line to verify' };
  }

  const fullPath = path.isAbsolute(relFile) ? relFile : path.join(root, relFile);
  if (!fs.existsSync(fullPath)) {
    return {
      anchorStatus: 'missing',
      originalLine: origLine,
      reason: 'file-not-found',
      file: relFile,
    };
  }

  // No codeSnippet → we can only verify file + line-in-range. If claimed
  // line is beyond file length, flag as drifted/missing; else accept.
  let lines;
  try {
    lines = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/);
  } catch (err) {
    return {
      anchorStatus: 'missing',
      originalLine: origLine,
      reason: `file-unreadable:${err.code || err.message}`,
      file: relFile,
    };
  }

  if (origLine > lines.length) {
    return {
      anchorStatus: 'missing',
      originalLine: origLine,
      actualLine: null,
      reason: `line-beyond-file-length:${lines.length}`,
      file: relFile,
    };
  }

  if (!snippet || snippet.length < 3) {
    // Schema requires codeSnippet.minLength=10, but be tolerant of older
    // findings without evidence.codeSnippet — verify by existence only.
    return {
      anchorStatus: 'verified',
      originalLine: origLine,
      actualLine: origLine,
      reason: 'no-snippet-to-verify',
      file: relFile,
      ...fingerprintFields(lines, origLine, windowLines),
    };
  }

  const normalizedSnippet = normalizeForMatch(snippet);
  // Check claimed line first for exact-match fast path.
  const claimedLineContent = normalizeForMatch(lines[origLine - 1] || '');
  if (matchesLine(claimedLineContent, normalizedSnippet)) {
    return {
      anchorStatus: 'verified',
      originalLine: origLine,
      actualLine: origLine,
      drift: 0,
      file: relFile,
      ...fingerprintFields(lines, origLine, windowLines),
    };
  }

  // Multi-line snippet: join window and search.
  const lo = Math.max(1, origLine - windowLines);
  const hi = Math.min(lines.length, origLine + windowLines);
  for (let i = lo; i <= hi; i++) {
    const lineContent = normalizeForMatch(lines[i - 1] || '');
    if (matchesLine(lineContent, normalizedSnippet)) {
      return {
        anchorStatus: 'drifted',
        originalLine: origLine,
        actualLine: i,
        drift: i - origLine,
        file: relFile,
        ...fingerprintFields(lines, i, windowLines),
      };
    }
  }
  return {
    anchorStatus: 'missing',
    originalLine: origLine,
    actualLine: null,
    reason: 'snippet-not-in-file',
    file: relFile,
  };
}

function verify(root, opts = {}) {
  const findingsPath = findReviewFindings(root);
  if (!findingsPath) {
    return {
      ok: false,
      exitCode: EXIT_MISSING_INPUT,
      reason: 'review-findings.json not found',
    };
  }

  const payload = readJson(findingsPath);
  if (!payload || !Array.isArray(payload.findings)) {
    return {
      ok: false,
      exitCode: EXIT_MISSING_INPUT,
      reason: 'review-findings.json unparseable or malformed',
    };
  }

  const perFinding = [];
  let verified = 0;
  let drifted = 0;
  let missing = 0;

  for (const finding of payload.findings) {
    const result = verifyFinding(finding, root, opts.windowLines);
    perFinding.push({
      id: finding.id,
      severity: finding.severity,
      prefix: finding.prefix,
      reviewerAgent: finding.reviewerAgent,
      ...result,
    });
    if (result.anchorStatus === 'verified') verified++;
    else if (result.anchorStatus === 'drifted') drifted++;
    else missing++;
  }

  const total = perFinding.length;
  const verdict = {
    milestone: payload.milestone,
    phase: payload.phase,
    sourceFindings: findingsPath,
    verifiedAt: new Date().toISOString(),
    windowLines: opts.windowLines || DEFAULT_SEARCH_WINDOW,
    strict: !!opts.strict,
    findings: perFinding,
    summary: { total, verified, drifted, missing },
  };

  // Exit-code policy: missing > drift > clean.
  let exitCode = EXIT_OK;
  if (missing > 0) exitCode = EXIT_MISSING_ANCHORS;
  else if (drifted > 0 && opts.strict) exitCode = EXIT_DRIFT;

  return { ok: true, verdict, exitCode, path: findingsPath };
}

function findingLocation(finding) {
  const loc = finding?.location || {};
  return {
    file: loc.file,
    line: loc.line,
  };
}

function reverifyVerdictFingerprints(root, verdict, sourceFindings = [], opts = {}) {
  const entries = Array.isArray(verdict?.findings) ? verdict.findings : [];
  const byId = new Map(sourceFindings.map((f) => [String(f.id || f.findingId || '').trim(), f]));
  const windowLines = Number.isInteger(Number(opts.windowLines || verdict?.windowLines))
    ? Number(opts.windowLines || verdict.windowLines)
    : DEFAULT_SEARCH_WINDOW;
  const missingFingerprint = [];
  const missing = [];
  const drifted = [];
  const verified = [];

  for (const entry of entries) {
    const id = String(entry.id || entry.findingId || '').trim();
    const source = byId.get(id) || {};
    const loc = findingLocation(source);
    const file = entry.file || loc.file;
    const originalLine = entry.originalLine || entry.line || loc.line;
    if (!file || !originalLine) continue;

    const emissionFingerprint = entry.emissionFingerprint || entry.citationFingerprint;
    if (!emissionFingerprint?.lineHash) {
      missingFingerprint.push(id || file);
      continue;
    }

    const fullPath = path.isAbsolute(file) ? file : path.join(root, file);
    let lines;
    try {
      lines = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/);
    } catch {
      missing.push({ id, file, reason: 'file-not-found-or-unreadable' });
      continue;
    }

    const current = lineContextFingerprint(lines, Number(originalLine), windowLines);
    if (sameFingerprint(current, emissionFingerprint)) {
      verified.push({ id, file, originalLine: Number(originalLine), currentFingerprint: current });
      continue;
    }

    const found = findFingerprintLine(lines, emissionFingerprint, Number(originalLine), windowLines);
    if (found) {
      drifted.push({
        id,
        file,
        originalLine: Number(originalLine),
        actualLine: found.line,
        drift: found.line - Number(originalLine),
        currentFingerprint: found.fingerprint,
      });
      continue;
    }

    missing.push({ id, file, originalLine: Number(originalLine), reason: 'fingerprint-not-found-in-window' });
  }

  return {
    ok: missingFingerprint.length === 0 && missing.length === 0,
    windowLines,
    missingFingerprint,
    missing,
    drifted,
    verified,
    summary: {
      checked: missingFingerprint.length + missing.length + drifted.length + verified.length,
      missingFingerprint: missingFingerprint.length,
      missing: missing.length,
      drifted: drifted.length,
      verified: verified.length,
    },
  };
}

function writeVerdict(root, verdict) {
  const outDir = path.join(root, '_cobolt-output', 'latest', 'review');
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'line-anchor-verdict.json'), JSON.stringify(verdict, null, 2));
  } catch {
    /* best-effort; caller may not have write perms in --json shell invocations */
  }
}

function writeCitationEmissionRecord(root, verdict) {
  const outDir = path.join(root, '_cobolt-output', 'latest', 'review');
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const payload = {
      milestone: verdict.milestone,
      phase: verdict.phase,
      generatedAt: verdict.verifiedAt,
      windowLines: verdict.windowLines,
      fingerprints: (verdict.findings || [])
        .filter((f) => f.emissionFingerprint)
        .map((f) => ({
          id: f.id,
          file: f.file,
          originalLine: f.originalLine,
          actualLine: f.actualLine,
          anchorStatus: f.anchorStatus,
          emissionFingerprint: f.emissionFingerprint,
        })),
    };
    fs.writeFileSync(path.join(outDir, 'citation-emission-record.json'), JSON.stringify(payload, null, 2));
  } catch {
    /* best-effort */
  }
}

function writeLineDriftHints(root, verdict) {
  // Drift-only side file injected into fix-agent context. Only drifted
  // findings get a hint (verified and missing are already resolved one way
  // or the other). Consumer: cobolt-fix skill step that prepends this file
  // into the fix-agent input bundle.
  const drifted = (verdict.findings || []).filter((f) => f.anchorStatus === 'drifted');
  if (!drifted.length) return;
  const outDir = path.join(root, '_cobolt-output', 'latest', 'fix');
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const payload = {
      milestone: verdict.milestone,
      phase: verdict.phase,
      generatedAt: verdict.verifiedAt,
      hints: drifted.map((d) => ({
        findingId: d.id,
        file: d.file,
        originalLine: d.originalLine,
        actualLine: d.actualLine,
        drift: d.drift,
        note: `Reviewer cited line ${d.originalLine}; the quoted code is now at line ${d.actualLine}.`,
      })),
    };
    fs.writeFileSync(path.join(outDir, 'line-drift-hints.json'), JSON.stringify(payload, null, 2));
  } catch {
    /* best-effort */
  }
}

function printHuman(verdict) {
  const { total, verified, drifted, missing } = verdict.summary;
  console.log('== Line-Anchor Verify ==');
  console.log(`  total:    ${total}`);
  console.log(`  verified: ${verified}`);
  console.log(`  drifted:  ${drifted}`);
  console.log(`  missing:  ${missing}`);
  if (missing > 0) {
    console.log('');
    console.log('Missing anchors (fabricated or file deleted):');
    for (const f of verdict.findings.filter((x) => x.anchorStatus === 'missing')) {
      console.log(`  - ${f.id} [${f.severity}] ${f.file || '(no file)'}: ${f.reason || '?'}`);
    }
  }
  if (drifted > 0) {
    console.log('');
    console.log('Drifted anchors (fix agents will self-correct):');
    for (const f of verdict.findings.filter((x) => x.anchorStatus === 'drifted')) {
      console.log(
        `  - ${f.id} [${f.severity}] ${f.file}: ${f.originalLine} → ${f.actualLine} (${f.drift >= 0 ? '+' : ''}${f.drift})`,
      );
    }
  }
}

function main(argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'verify';
  const json = hasFlag(args, '--json');
  const strict = hasFlag(args, '--strict') || process.env.COBOLT_LINE_ANCHOR_STRICT === 'on';

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('Usage: cobolt-line-anchor-verify.js verify [--json] [--strict]');
    console.log('');
    console.log('Verifies review-findings.json citations against source files.');
    console.log('Writes: _cobolt-output/latest/review/line-anchor-verdict.json');
    console.log('Writes: _cobolt-output/latest/fix/line-drift-hints.json (if drift detected)');
    console.log('');
    console.log('Exit codes: 0=clean, 1=usage, 2=missing-input, 4=drift (strict), 5=missing-anchors');
    process.exit(EXIT_OK);
  }

  if (cmd !== 'verify') {
    console.error(`Unknown command: ${cmd}`);
    process.exit(EXIT_USAGE);
  }

  const root = process.cwd();
  const result = verify(root, { strict });

  if (!result.ok) {
    if (json) console.log(JSON.stringify({ ok: false, reason: result.reason }, null, 2));
    else console.error(`line-anchor-verify: ${result.reason}`);
    process.exit(result.exitCode);
  }

  writeVerdict(root, result.verdict);
  writeCitationEmissionRecord(root, result.verdict);
  writeLineDriftHints(root, result.verdict);

  if (json) console.log(JSON.stringify(result.verdict, null, 2));
  else printHuman(result.verdict);

  process.exit(result.exitCode);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = {
  verify,
  verifyFinding,
  writeVerdict,
  writeCitationEmissionRecord,
  writeLineDriftHints,
  lineContextFingerprint,
  reverifyVerdictFingerprints,
  DEFAULT_SEARCH_WINDOW,
};
