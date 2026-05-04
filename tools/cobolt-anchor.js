#!/usr/bin/env node

// CoBolt Milestone Anchor — CLI for per-milestone bounded-context memory file
//
// The anchor file is the single source of truth for "what are we doing and where are we"
// during a milestone build. It is read at the start of every round and after resume.
//
// Section model:
//   ## Goal                    — FROZEN at init (from milestone spec)
//   ## Architecture Decisions  — FROZEN at init (from master-plan + ADRs)
//   ## Open Risks              — updated per round (max 10)
//   ## Completed Rounds        — append-only, one line per round
//   ## Current Round           — overwritten each round
//
// Size budget: target 3K tokens, hard cap 5K tokens.
//
// Usage:
//   node tools/cobolt-anchor.js init --milestone M1 --build-packet <path> --out <path>
//   node tools/cobolt-anchor.js append-round --path <anchor> --round N --name core --status green_passing --tests 14/14 --checkpoint <ref>
//   node tools/cobolt-anchor.js set-current --path <anchor> --round N --name core --content <text-or-@file>
//   node tools/cobolt-anchor.js add-risk --path <anchor> --severity high --text "..." --round N
//   node tools/cobolt-anchor.js show --path <anchor>

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite, atomicWriteJSON } = require('../lib/cobolt-atomic-write');

const ANCHOR_VERSION = 1; // default for init (unchanged — v1 stays the default)
const ANCHOR_VERSION_V2 = 2; // opt-in via --v2 (bounded-context memory model)
const MAX_RISKS = 10;
// Size budget — user-configurable via env so projects can tune for their context budgets.
// CHARS_PER_TOKEN is a rough estimate used for token-equivalent reporting only.
const SOFT_TOKEN_CAP = parseInt(process.env.COBOLT_ANCHOR_SOFT_CAP || '3000', 10);
const HARD_TOKEN_CAP = parseInt(process.env.COBOLT_ANCHOR_HARD_CAP || '5000', 10);
const CHARS_PER_TOKEN = 4;
const LOCK_TTL_MS = 10000; // 10s — anchor operations complete in <100ms; generous for pathological cases

const SECTIONS = {
  goal: '## Goal',
  arch: '## Architecture Decisions',
  risks: '## Open Risks',
  completed: '## Completed Rounds',
  current: '## Current Round',
  ledger: '## Round Ledger', // v2 only — one-line verdict digest per completed round
};

// Read the COBOLT-ANCHOR-VERSION footer. Returns 1 if missing (legacy anchors).
function detectVersion(content) {
  const m = content.match(/<!--\s*COBOLT-ANCHOR-VERSION:\s*(\d+)\s*-->/);
  return m ? parseInt(m[1], 10) : 1;
}

// ── Anchor lock ──────────────────────────────────────────
// Cooperative file lock sibling to the anchor. Prevents concurrent flush-verdict
// calls from interleaving the Round Ledger edit and losing digests.
//
// Mechanism: try to create `<anchor>.lock` with O_EXCL; if it exists and is
// fresher than LOCK_TTL_MS, retry briefly; if stale, steal it.
// This is cooperative (tools honor it; nothing physically prevents a bypasser).
function acquireAnchorLock(anchorPath) {
  const lockPath = `${anchorPath}.lock`;
  const deadline = Date.now() + LOCK_TTL_MS;
  const fs = require('node:fs');
  // Single attempt loop — sync polling, short waits
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(fd, `${process.pid}\n${Date.now()}\n`);
      fs.closeSync(fd);
      return lockPath;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    // Existing lock — check staleness
    try {
      const st = fs.statSync(lockPath);
      if (Date.now() - st.mtimeMs > LOCK_TTL_MS) {
        // Stale: steal it
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* best effort */
        }
        continue;
      }
    } catch {
      /* lock vanished between EEXIST and stat — retry */
    }
    if (Date.now() > deadline) {
      throw new Error(`anchor lock timeout: ${lockPath} (another flush in progress)`);
    }
    // v0.29: replaced CPU-burning spin with Atomics.wait on a dummy buffer.
    // Sync-friendly (no async required in this CLI tool) but actually releases
    // the CPU instead of tight-looping for 50ms per retry.
    try {
      const buf = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(buf, 0, 0, 50);
    } catch {
      // Fallback — if SharedArrayBuffer is unavailable, minimal yield via immediate setImmediate-like no-op.
      const end = Date.now() + 50;
      while (Date.now() < end) {
        /* last-resort busy-wait */
      }
    }
  }
}

function releaseAnchorLock(lockPath) {
  if (!lockPath) return;
  try {
    require('node:fs').unlinkSync(lockPath);
  } catch {
    /* best effort — cleanup is for the next writer */
  }
}

function withAnchorLock(anchorPath, fn) {
  const lockPath = acquireAnchorLock(anchorPath);
  try {
    return fn();
  } finally {
    releaseAnchorLock(lockPath);
  }
}

// ── Argument parser ──────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

// ── Section helpers ──────────────────────────────────────
function readAnchor(anchorPath) {
  if (!fs.existsSync(anchorPath)) {
    throw new Error(`Anchor file not found: ${anchorPath}`);
  }
  return fs.readFileSync(anchorPath, 'utf8');
}

function writeAnchor(anchorPath, content) {
  atomicWrite(anchorPath, content, { mode: 0o600 });

  // Size warning — advisory only
  const estimatedTokens = Math.round(content.length / CHARS_PER_TOKEN);
  if (estimatedTokens > HARD_TOKEN_CAP) {
    process.stderr.write(
      `[anchor] WARNING: anchor is ~${estimatedTokens} tokens (hard cap ${HARD_TOKEN_CAP}). ` +
        'Trim "Completed Rounds" entries to one-line verdicts.\n',
    );
  } else if (estimatedTokens > SOFT_TOKEN_CAP) {
    process.stderr.write(`[anchor] NOTICE: anchor is ~${estimatedTokens} tokens (soft cap ${SOFT_TOKEN_CAP}).\n`);
  }
}

// Extract the body of a section (between its header and the next H2 or EOF)
function getSection(content, sectionHeader) {
  const lines = content.split('\n');
  const start = lines.findIndex((l) => l.trim() === sectionHeader);
  if (start === -1) return { start: -1, end: -1, body: '' };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ') || lines[i].startsWith('---')) {
      end = i;
      break;
    }
  }
  return { start, end, body: lines.slice(start + 1, end).join('\n') };
}

// Replace a section's body (keeps the header line)
function replaceSection(content, sectionHeader, newBody) {
  const lines = content.split('\n');
  const { start, end } = getSection(content, sectionHeader);
  if (start === -1) {
    throw new Error(`Section not found: ${sectionHeader}`);
  }
  const before = lines.slice(0, start + 1);
  const after = lines.slice(end);
  // Ensure the new body has exactly one trailing blank line for separation
  const trimmedBody = newBody.replace(/\n+$/, '');
  return [...before, '', trimmedBody, '', ...after].join('\n');
}

// ── init ─────────────────────────────────────────────────
function cmdInit(args) {
  const milestone = args.milestone;
  const buildPacket = args['build-packet'];
  const outPath = args.out;
  const useV2 = args.v2 === true || args.v2 === 'true';
  const version = useV2 ? ANCHOR_VERSION_V2 : ANCHOR_VERSION;

  if (!milestone || !outPath) {
    console.error('Usage: cobolt-anchor.js init --milestone M1 --out <path> [--build-packet <path>] [--v2]');
    process.exit(1);
  }

  let goal = '(seed from build packet — update manually if empty)';
  let decisions = '(seed from master-plan.md + ADRs — update manually if empty)';

  if (buildPacket && fs.existsSync(buildPacket)) {
    try {
      const packet = fs.readFileSync(buildPacket, 'utf8');
      // Try to extract milestone goal from the packet (heuristic)
      const goalMatch = packet.match(new RegExp(`##.*${milestone}[^#]*?\\n([\\s\\S]*?)(?=\\n##|$)`, 'i'));
      if (goalMatch) {
        const firstParagraph = goalMatch[1].split('\n\n').find((p) => p.trim().length > 0 && !p.trim().startsWith('-'));
        if (firstParagraph) goal = firstParagraph.trim().slice(0, 500);
      }

      // Heuristic: look for a decisions/ADR section
      const archMatch = packet.match(/##\s*(Architecture|Decisions|ADRs)[^\n]*\n([\s\S]*?)(?=\n##|$)/i);
      if (archMatch) {
        const bullets = archMatch[2]
          .split('\n')
          .filter((l) => l.trim().startsWith('-') || l.trim().startsWith('*'))
          .slice(0, 10)
          .join('\n');
        if (bullets) decisions = bullets;
      }
    } catch {
      /* fall through to defaults */
    }
  }

  const ledgerBlock = useV2
    ? `\n${SECTIONS.ledger}\n\n<!-- one-line verdict digest per completed round; full verdicts flushed to verdicts/round-N.json -->\n`
    : '';

  const content = `# Milestone Anchor — ${milestone}

> **Purpose**: Bounded-context memory for this milestone. Read at the start of every round
> and after resume. \`Goal\` and \`Architecture Decisions\` are frozen at Step 01; other
> sections update per round. Size budget: ~3K tokens target, 5K hard cap.

${SECTIONS.goal}

${goal}

${SECTIONS.arch}

${decisions}

${SECTIONS.risks}

${SECTIONS.completed}

${SECTIONS.current}
${ledgerBlock}
---

<!-- COBOLT-ANCHOR-VERSION: ${version} -->
`;

  writeAnchor(outPath, content);
  console.log(`Anchor initialized (v${version}): ${outPath}`);
}

// ── append-round ─────────────────────────────────────────
function cmdAppendRound(args) {
  const anchorPath = args.path;
  const round = args.round;
  const name = args.name || 'round';
  const status = args.status || 'unknown';
  const tests = args.tests || 'n/a';
  const checkpoint = args.checkpoint || '';

  if (!anchorPath || !round) {
    console.error(
      'Usage: cobolt-anchor.js append-round --path <anchor> --round N --name <name> --status <status> --tests <p/f> [--checkpoint <ref>]',
    );
    process.exit(1);
  }

  const content = readAnchor(anchorPath);
  const section = getSection(content, SECTIONS.completed);
  const existing = section.body.trim();
  const cpRef = checkpoint ? ` \`${checkpoint}\`` : '';
  const entry = `- Round ${round} (${name}): **${status}** | ${tests} tests${cpRef}`;
  const newBody = existing ? `${existing}\n${entry}` : entry;
  const updated = replaceSection(content, SECTIONS.completed, newBody);
  writeAnchor(anchorPath, updated);
  console.log(`Appended Round ${round} to anchor`);
}

// ── set-current ──────────────────────────────────────────
function cmdSetCurrent(args) {
  const anchorPath = args.path;
  const round = args.round;
  const name = args.name || '';
  let contentArg = args.content || '';

  if (!anchorPath || !round) {
    console.error(
      'Usage: cobolt-anchor.js set-current --path <anchor> --round N [--name <name>] [--content <text-or-@file>]',
    );
    process.exit(1);
  }

  if (contentArg.startsWith('@')) {
    const file = contentArg.slice(1);
    if (fs.existsSync(file)) contentArg = fs.readFileSync(file, 'utf8');
    else contentArg = '';
  }

  const header = `**Round ${round}${name ? ` — ${name}` : ''}**`;
  const body = contentArg.trim() ? `${header}\n\n${contentArg.trim().slice(0, 2000)}` : header;

  const content = readAnchor(anchorPath);
  const updated = replaceSection(content, SECTIONS.current, body);
  writeAnchor(anchorPath, updated);
  console.log(`Set Current Round to ${round}`);
}

// ── add-risk ─────────────────────────────────────────────
function cmdAddRisk(args) {
  const anchorPath = args.path;
  const severity = (args.severity || 'med').toLowerCase();
  const text = args.text || '';
  const round = args.round || '';

  if (!anchorPath || !text) {
    console.error(
      'Usage: cobolt-anchor.js add-risk --path <anchor> --text "..." [--severity low|med|high] [--round N]',
    );
    process.exit(1);
  }

  const validSeverity = ['low', 'med', 'high'].includes(severity) ? severity : 'med';
  const roundRef = round ? ` — round ${round}` : '';
  const entry = `- [${validSeverity}] ${text.slice(0, 200)}${roundRef}`;

  const content = readAnchor(anchorPath);
  const section = getSection(content, SECTIONS.risks);
  const existingLines = section.body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('-'));

  if (existingLines.length >= MAX_RISKS) {
    process.stderr.write(`[anchor] Open Risks is full (${MAX_RISKS}). Remove a resolved risk before adding.\n`);
    process.exit(2);
  }

  const newBody = [...existingLines, entry].join('\n');
  const updated = replaceSection(content, SECTIONS.risks, newBody);
  writeAnchor(anchorPath, updated);
  console.log(`Added risk [${validSeverity}]`);
}

// ── show ─────────────────────────────────────────────────
function cmdShow(args) {
  const anchorPath = args.path;
  if (!anchorPath) {
    console.error('Usage: cobolt-anchor.js show --path <anchor>');
    process.exit(1);
  }
  const content = readAnchor(anchorPath);
  const estimatedTokens = Math.round(content.length / CHARS_PER_TOKEN);
  process.stderr.write(`[anchor] ${content.length} chars, ~${estimatedTokens} tokens\n`);
  process.stdout.write(content);
}

// ── validator (shared by flush-verdict) ──────────────────
// Minimal validator mirroring source/schemas/builder-return.schema.json.
// No external deps. Returns array of error strings (empty when valid).
function validateBuilderReturn(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return ['verdict is not an object'];
  }
  const allowed = new Set([
    'round',
    'status',
    'files_written',
    'tests_passing',
    'tests_failing',
    'blockers',
    'capability_proofs',
    'notes',
  ]);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) errors.push(`unexpected field: ${k}`);
  }
  if (!Number.isInteger(obj.round) || obj.round < 1 || obj.round > 20) {
    errors.push('round must be integer 1-20');
  }
  const validStatus = ['green_passing', 'red_failing', 'partial', 'blocked'];
  if (!validStatus.includes(obj.status)) {
    errors.push(`status must be one of ${validStatus.join('|')}`);
  }
  if (!Array.isArray(obj.files_written)) {
    errors.push('files_written must be array');
  } else if (obj.files_written.length > 50) {
    errors.push(`files_written has ${obj.files_written.length} entries — max 50`);
  } else {
    for (const f of obj.files_written) {
      if (typeof f !== 'string' || f.length > 300) {
        errors.push('files_written entries must be strings <=300 chars');
        break;
      }
    }
  }
  if (!Number.isInteger(obj.tests_passing) || obj.tests_passing < 0) {
    errors.push('tests_passing must be non-negative integer');
  }
  if (!Number.isInteger(obj.tests_failing) || obj.tests_failing < 0) {
    errors.push('tests_failing must be non-negative integer');
  }
  if (obj.blockers !== undefined) {
    if (!Array.isArray(obj.blockers)) errors.push('blockers must be array');
    else if (obj.blockers.length > 10) errors.push(`blockers has ${obj.blockers.length} entries — max 10`);
  }
  if (obj.notes !== undefined && (typeof obj.notes !== 'string' || obj.notes.length > 200)) {
    errors.push('notes must be string <=200 chars');
  }
  return errors;
}

// ── flush-verdict ────────────────────────────────────────
// Persists a builder return verdict to disk and appends a one-line digest
// to the Round Ledger (v2 anchors). v1 anchors: prints notice and exits 0
// (no-op for backward compatibility).
//
// Usage:
//   flush-verdict --path <anchor> --round N --verdict <json-string>
//   flush-verdict --path <anchor> --round N --verdict-file <path-to-json>
//
// Writes:
//   <anchor-dir>/verdicts/round-<N>.json   (full verdict, 0o600)
//   <anchor-dir>/verdicts/                  (dir, 0o700)
//   Appends digest to ## Round Ledger      (v2 only)
function cmdFlushVerdict(args) {
  const anchorPath = args.path;
  const round = args.round;
  let verdictRaw = args.verdict;
  const verdictFile = args['verdict-file'];

  if (!anchorPath || !round) {
    console.error(
      'Usage: cobolt-anchor.js flush-verdict --path <anchor> --round N (--verdict <json>|--verdict-file <path>)',
    );
    process.exit(1);
  }
  if (!verdictRaw && !verdictFile) {
    console.error('flush-verdict requires --verdict <json-string> or --verdict-file <path>');
    process.exit(1);
  }
  if (verdictFile) {
    if (!fs.existsSync(verdictFile)) {
      console.error(`verdict file not found: ${verdictFile}`);
      process.exit(1);
    }
    verdictRaw = fs.readFileSync(verdictFile, 'utf8');
  }

  let verdict;
  try {
    verdict = JSON.parse(verdictRaw);
  } catch (e) {
    console.error(`verdict is not valid JSON: ${e.message}`);
    process.exit(1);
  }

  const roundNum = parseInt(round, 10);
  if (!Number.isInteger(roundNum) || roundNum < 1) {
    console.error('--round must be a positive integer');
    process.exit(1);
  }
  // If verdict.round omitted, default to CLI arg. If present, must match.
  if (verdict.round === undefined) verdict.round = roundNum;
  if (verdict.round !== roundNum) {
    console.error(`--round ${roundNum} does not match verdict.round ${verdict.round}`);
    process.exit(1);
  }

  const errors = validateBuilderReturn(verdict);
  if (errors.length) {
    console.error(`verdict failed validation:\n  - ${errors.join('\n  - ')}`);
    process.exit(2);
  }

  // Always persist the full verdict to disk (v1 and v2)
  const anchorDir = path.dirname(anchorPath);
  const verdictsDir = path.join(anchorDir, 'verdicts');
  const verdictPath = path.join(verdictsDir, `round-${roundNum}.json`);
  atomicWriteJSON(verdictPath, verdict, { mode: 0o600 });

  // For v1 anchors, persistence is the whole story — no ledger to update.
  const initialContent = readAnchor(anchorPath);
  const initialVersion = detectVersion(initialContent);
  if (initialVersion < ANCHOR_VERSION_V2) {
    console.log(
      `Verdict flushed: ${verdictPath} (anchor v${initialVersion} — Round Ledger not updated; upgrade to v2 for digest)`,
    );
    return;
  }

  // v2: append one-line digest to Round Ledger under anchor lock
  // so concurrent flush-verdict calls don't lose each other's digests.
  withAnchorLock(anchorPath, () => {
    cmdFlushVerdictLocked(anchorPath, verdictPath, roundNum, verdict);
  });
}

function cmdFlushVerdictLocked(anchorPath, verdictPath, roundNum, verdict) {
  // Re-read after lock acquisition — another writer may have updated content.
  const content = readAnchor(anchorPath);
  const filesCount = verdict.files_written.length;
  const blockersCount = Array.isArray(verdict.blockers) ? verdict.blockers.length : 0;
  const digest =
    `- Round ${roundNum}: **${verdict.status}** | files=${filesCount} | tests=${verdict.tests_passing}/${verdict.tests_failing}` +
    (blockersCount ? ` | blockers=${blockersCount}` : '');

  const section = getSection(content, SECTIONS.ledger);
  if (section.start === -1) {
    console.error(`v2 anchor missing Round Ledger section — run 'cobolt-anchor upgrade --path ${anchorPath}'`);
    process.exit(2);
  }
  const existingLines = section.body
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().startsWith('-'));

  // Idempotency: if a digest for this round already exists, replace it
  const kept = existingLines.filter((l) => !new RegExp(`^- Round ${roundNum}:`).test(l));
  const newBody = [...kept, digest].join('\n');

  // Preserve the HTML comment marker at top of the ledger body (if present)
  const ledgerMarker = section.body
    .split('\n')
    .find((l) => l.trim().startsWith('<!--') && l.includes('verdict digest'));
  const finalBody = ledgerMarker ? `${ledgerMarker}\n${newBody}` : newBody;

  const updated = replaceSection(content, SECTIONS.ledger, finalBody);
  writeAnchor(anchorPath, updated);
  console.log(`Verdict flushed: ${verdictPath} + Round Ledger updated`);
}

// ── verify ───────────────────────────────────────────────
// Reads an anchor, parses required sections, reports version + size.
// Exit 0 = healthy, 2 = missing required section, 1 = other error.
function cmdVerify(args) {
  const anchorPath = args.path;
  if (!anchorPath) {
    console.error('Usage: cobolt-anchor.js verify --path <anchor>');
    process.exit(1);
  }
  const content = readAnchor(anchorPath);
  const version = detectVersion(content);
  const required = [SECTIONS.goal, SECTIONS.arch, SECTIONS.risks, SECTIONS.completed, SECTIONS.current];
  if (version >= 2) required.push(SECTIONS.ledger);

  const missing = required.filter((h) => getSection(content, h).start === -1);
  const estimatedTokens = Math.round(content.length / CHARS_PER_TOKEN);

  const report = {
    path: anchorPath,
    version,
    bytes: content.length,
    estimatedTokens,
    softCap: SOFT_TOKEN_CAP,
    hardCap: HARD_TOKEN_CAP,
    missingSections: missing,
    healthy: missing.length === 0,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.healthy) process.exit(2);
}

// ── health ───────────────────────────────────────────────
// Advisory diagnostic — parses the anchor, surfaces anomalies, and returns a
// JSON report. Exit 0 always (advisory only; verify is the enforcing cousin).
//
// Anomalies flagged:
//   - anchor exceeds soft cap (approaching context pressure)
//   - Open Risks has high-severity entries
//   - Completed Rounds has regressions (green_passing → partial/blocked transitions)
//   - Round Ledger digests count differs from Completed Rounds count (drift)
function cmdHealth(args) {
  const anchorPath = args.path;
  if (!anchorPath) {
    console.error('Usage: cobolt-anchor.js health --path <anchor>');
    process.exit(1);
  }
  const content = readAnchor(anchorPath);
  const version = detectVersion(content);
  const bytes = content.length;
  const estimatedTokens = Math.round(bytes / CHARS_PER_TOKEN);

  const completed = getSection(content, SECTIONS.completed)
    .body.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('-'));

  const risks = getSection(content, SECTIONS.risks)
    .body.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('-'));

  const ledger =
    version >= 2
      ? getSection(content, SECTIONS.ledger)
          .body.split('\n')
          .map((l) => l.trim())
          .filter((l) => l.startsWith('- Round'))
      : [];

  const warnings = [];
  if (bytes > HARD_TOKEN_CAP * CHARS_PER_TOKEN) {
    warnings.push(`anchor exceeds hard cap (~${estimatedTokens} tokens > ${HARD_TOKEN_CAP}) — trim Completed Rounds`);
  } else if (bytes > SOFT_TOKEN_CAP * CHARS_PER_TOKEN) {
    warnings.push(
      `anchor exceeds soft cap (~${estimatedTokens} tokens > ${SOFT_TOKEN_CAP}) — context pressure building`,
    );
  }

  const highRisks = risks.filter((r) => r.includes('[high]')).length;
  if (highRisks > 0) warnings.push(`${highRisks} high-severity risk(s) open`);

  const regressions = completed.filter((l) => /partial|blocked|red_failing/i.test(l)).length;
  if (regressions > 0) warnings.push(`${regressions} round(s) completed with non-passing status`);

  if (version >= 2 && ledger.length !== completed.length) {
    warnings.push(
      `Round Ledger count (${ledger.length}) differs from Completed Rounds count (${completed.length}) — flush discipline drift`,
    );
  }

  const report = {
    path: anchorPath,
    version,
    bytes,
    estimatedTokens,
    softCap: SOFT_TOKEN_CAP,
    hardCap: HARD_TOKEN_CAP,
    roundsCompleted: completed.length,
    ledgerEntries: ledger.length,
    openRisks: risks.length,
    highSeverityRisks: highRisks,
    warnings,
    healthy: warnings.length === 0,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

// ── upgrade ──────────────────────────────────────────────
// Upgrade a v1 anchor in-place to v2 by inserting the Round Ledger section
// and bumping the footer. Idempotent: no-op on v2+ anchors. No content loss.
function cmdUpgrade(args) {
  const anchorPath = args.path;
  if (!anchorPath) {
    console.error('Usage: cobolt-anchor.js upgrade --path <anchor>');
    process.exit(1);
  }
  const content = readAnchor(anchorPath);
  const version = detectVersion(content);
  if (version >= ANCHOR_VERSION_V2) {
    console.log(`Anchor already v${version} — no upgrade needed`);
    return;
  }

  // Insert Round Ledger after Current Round. If Current Round missing, append before footer.
  const current = getSection(content, SECTIONS.current);
  const lines = content.split('\n');
  const ledgerLines = [
    '',
    SECTIONS.ledger,
    '',
    '<!-- one-line verdict digest per completed round; full verdicts flushed to verdicts/round-N.json -->',
    '',
  ];

  let insertAt;
  if (current.start !== -1) {
    insertAt = current.end;
  } else {
    // find footer line or end
    insertAt = lines.findIndex((l) => l.startsWith('<!-- COBOLT-ANCHOR-VERSION:'));
    if (insertAt === -1) insertAt = lines.length;
  }

  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  let upgraded = [...before, ...ledgerLines, ...after].join('\n');

  // Bump version footer
  upgraded = upgraded.replace(
    /<!--\s*COBOLT-ANCHOR-VERSION:\s*\d+\s*-->/,
    `<!-- COBOLT-ANCHOR-VERSION: ${ANCHOR_VERSION_V2} -->`,
  );
  // If no footer existed, append one
  if (!/<!--\s*COBOLT-ANCHOR-VERSION:/.test(upgraded)) {
    upgraded = `${upgraded.replace(/\n+$/, '')}\n\n---\n\n<!-- COBOLT-ANCHOR-VERSION: ${ANCHOR_VERSION_V2} -->\n`;
  }

  writeAnchor(anchorPath, upgraded);
  console.log(`Anchor upgraded: v${version} → v${ANCHOR_VERSION_V2}`);
}

// ── Main ─────────────────────────────────────────────────
function main() {
  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);
  const isHelp = command === '--help' || command === '-h' || command === 'help';

  switch (command) {
    case 'init':
      return cmdInit(args);
    case 'append-round':
      return cmdAppendRound(args);
    case 'set-current':
      return cmdSetCurrent(args);
    case 'add-risk':
      return cmdAddRisk(args);
    case 'show':
      return cmdShow(args);
    case 'verify':
      return cmdVerify(args);
    case 'upgrade':
      return cmdUpgrade(args);
    case 'flush-verdict':
      return cmdFlushVerdict(args);
    case 'health':
      return cmdHealth(args);
    default: {
      const usage =
        'Usage: cobolt-anchor.js <init|append-round|set-current|add-risk|show|verify|upgrade|flush-verdict> [args]\n' +
        '  init            --milestone M1 --out <path> [--build-packet <path>] [--v2]\n' +
        '  append-round    --path <anchor> --round N --name <name> --status <status> --tests <p/f> [--checkpoint <ref>]\n' +
        '  set-current     --path <anchor> --round N [--name <name>] [--content <text-or-@file>]\n' +
        '  add-risk        --path <anchor> --text "..." [--severity low|med|high] [--round N]\n' +
        '  show            --path <anchor>\n' +
        '  verify          --path <anchor>         (emits JSON report; exit 2 on missing sections)\n' +
        '  upgrade         --path <anchor>         (v1 → v2 in-place; idempotent)\n' +
        '  flush-verdict   --path <anchor> --round N (--verdict <json>|--verdict-file <path>)\n' +
        '  health          --path <anchor>         (advisory diagnostic — JSON report with warnings)';
      // --help / -h / help / no-args → stdout + exit 0. Unknown command → stderr + exit 1.
      if (isHelp || !command) {
        process.stdout.write(`${usage}\n`);
        process.exit(0);
      }
      process.stderr.write(`${usage}\n`);
      process.exit(1);
    }
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`[anchor] ERROR: ${e.message}`);
    process.exit(1);
  }
}

module.exports = {
  getSection,
  replaceSection,
  detectVersion,
  validateBuilderReturn,
  SECTIONS,
  ANCHOR_VERSION,
  ANCHOR_VERSION_V2,
};
