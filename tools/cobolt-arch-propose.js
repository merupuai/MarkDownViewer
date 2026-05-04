#!/usr/bin/env node

// CoBolt Architecture Mutation Proposal Tool (v0.12.0 — WS3)
//
// The only pipeline component authorized to mutate architecture.md. All
// mutations flow through a written proposal that is gated behind:
//
//   - two-agent quorum (architecture-reviewer + security-reviewer both APPROVE), OR
//   - human verdict (user edits the proposal frontmatter: verdict: APPROVE)
//
// Commands:
//   new      — scaffold an arch-mutation-proposal.md skeleton
//   validate — check that a proposal meets hard-rule requirements before review
//   status   — print verdict / approver state of current proposal
//   apply    — apply APPROVED proposal to architecture.md + emit new ADR
//              (refuses if verdict != APPROVE)
//   list     — list all proposals across all iterations
//
// Storage:
//   _cobolt-output/latest/fix/arch-mutation-proposal.md   — current active
//   _cobolt-output/latest/planning/adrs/ADR-NNN.md        — emitted on apply
//   _cobolt-output/latest/planning/architecture.md        — mutated on apply
//   _cobolt-output/latest/planning/architecture-history/  — pre-mutation snapshot

const fs = require('node:fs');
const path = require('node:path');

function paths() {
  try {
    const mod = require('../lib/cobolt-paths');
    const p = typeof mod === 'function' ? mod() : typeof mod.paths === 'function' ? mod.paths() : mod;
    return p;
  } catch {
    const out = path.join(process.cwd(), '_cobolt-output');
    return {
      outputRoot: out,
      audit: () => path.join(out, 'audit'),
      latestPlanning: () => path.join(out, 'latest', 'planning'),
      latestFix: () => path.join(out, 'latest', 'fix'),
    };
  }
}

function planningDir() {
  const p = paths();
  return typeof p.latestPlanning === 'function'
    ? p.latestPlanning()
    : path.join(process.cwd(), '_cobolt-output', 'latest', 'planning');
}
function fixDir() {
  const p = paths();
  return typeof p.latestFix === 'function'
    ? p.latestFix()
    : path.join(process.cwd(), '_cobolt-output', 'latest', 'fix');
}
function proposalPath() {
  return path.join(fixDir(), 'arch-mutation-proposal.md');
}
function architecturePath() {
  return path.join(planningDir(), 'architecture.md');
}
function adrsDir() {
  return path.join(planningDir(), 'adrs');
}
function historyDir() {
  return path.join(planningDir(), 'architecture-history');
}

// ── Frontmatter parse (YAML-lite, just verdict block) ────────────────

function parseFrontmatter(text) {
  // Accept two formats:
  //   (1) Markdown frontmatter: ---\nverdict: APPROVE\n---\n
  //   (2) Embedded verdict code block inside proposal: ```yaml\nverdict: ...\n```
  const fm = { verdict: 'PENDING', approvedBy: [], appliedAt: null };
  const headerMatch = /^---\n([\s\S]*?)\n---/.exec(text);
  if (headerMatch) {
    for (const line of headerMatch[1].split(/\r?\n/)) {
      const m = /^(\w+):\s*(.+)$/.exec(line);
      if (m) fm[m[1]] = parseValue(m[2]);
    }
  }
  const verdictBlock = /```yaml\s*\n([\s\S]*?verdict:[\s\S]*?)\n```/m.exec(text);
  if (verdictBlock) {
    for (const line of verdictBlock[1].split(/\r?\n/)) {
      const m = /^(\w+):\s*(.+)$/.exec(line.trim());
      if (m) fm[m[1]] = parseValue(m[2]);
    }
  }
  return fm;
}

function parseValue(raw) {
  const s = raw.trim();
  if (/^\[.*\]$/.test(s)) {
    return s
      .slice(1, -1)
      .split(',')
      .map((x) => x.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  if (s === 'null' || s === '') return null;
  if (/^['"].*['"]$/.test(s)) return s.slice(1, -1);
  return s;
}

// ── new: scaffold a proposal ─────────────────────────────────────────

function newProposal(opts = {}) {
  const iteration = opts.iteration || 'X';
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const id = `AMP-${iteration}-${date}`;
  const skeleton = `# Architecture Mutation Proposal

**Proposal ID:** ${id}
**Generated:** ${new Date().toISOString()}
**Trigger:** LOOP_ARCH_MUTATE at iteration ${iteration}
**Findings addressed:** [fill in]

## Problem Statement

[fill in — what constraint can unit fixes not satisfy?]

## Root Cause (Architectural)

[fill in — named architectural constraint]

## Proposed Mutation

\`\`\`diff
- [old architecture.md text]
+ [new architecture.md text]
\`\`\`

## Blast Radius

| Scope | Affected | Notes |
|-------|---------|-------|
| Milestones | | |
| FRs | | |
| Files | | |
| Database | | |
| Interface contracts | | |

## Migration Path

1. [ordered, independently verifiable steps]

## New ADR Draft

\`\`\`markdown
# ADR-NNN: [title]

**Status:** Proposed
**Date:** ${new Date().toISOString().slice(0, 10)}
**Context:** [why]
**Decision:** [what changes]
**Consequences:** [pros, cons, neutrals]
**Alternatives Considered:** [options rejected]
\`\`\`

## Risk Assessment

- Likelihood of breaking working features: [low|medium|high] — [reason]
- Reversibility: [easy|moderate|hard] — [reason]
- Test coverage: [tests to add/modify]
- Rollback plan: [how to revert]

## Verdict

\`\`\`yaml
verdict: PENDING
approvedBy: []
appliedAt: null
\`\`\`
`;
  fs.mkdirSync(fixDir(), { recursive: true });
  fs.writeFileSync(proposalPath(), skeleton);
  return { ok: true, path: proposalPath(), id };
}

// ── validate: check hard rules ───────────────────────────────────────

function validate() {
  if (!fs.existsSync(proposalPath())) return { ok: false, reason: 'no proposal found', path: proposalPath() };
  const text = fs.readFileSync(proposalPath(), 'utf8');
  const issues = [];

  // Rule 1 — required sections
  const requiredSections = [
    '## Problem Statement',
    '## Root Cause',
    '## Proposed Mutation',
    '## Blast Radius',
    '## Migration Path',
    '## New ADR Draft',
    '## Risk Assessment',
    '## Verdict',
  ];
  for (const sec of requiredSections) {
    if (!text.includes(sec)) issues.push(`missing section: ${sec}`);
  }

  // Rule 2 — must have a proposed diff
  if (!/```diff[\s\S]*?```/.test(text))
    issues.push('no diff block in Proposed Mutation — must show explicit before/after');

  // Rule 3 — must cite ≥3 findings
  const findingsMatch = /\*\*Findings addressed:\*\*\s*(.+?)\n/.exec(text);
  const findings = findingsMatch ? findingsMatch[1].split(/[,\s]+/).filter((f) => /^[A-Z]+-\d+/.test(f)) : [];
  if (findings.length < 3) issues.push(`cites ${findings.length} findings — hard rule requires ≥3`);

  // Rule 4 — ADR draft included
  if (!/ADR-\w+:/.test(text)) issues.push('no ADR ID in ADR draft — format: ADR-NNN: Title');

  // Rule 5 — verdict block parses
  const fm = parseFrontmatter(text);
  if (!['PENDING', 'APPROVE', 'DECLINE', 'DECLINE_TO_PROPOSE'].includes(fm.verdict)) {
    issues.push(`verdict has unknown value: ${fm.verdict}`);
  }

  return { ok: issues.length === 0, issues, verdict: fm.verdict, approvedBy: fm.approvedBy, findings };
}

// ── status ───────────────────────────────────────────────────────────

function status() {
  if (!fs.existsSync(proposalPath())) return { present: false };
  const text = fs.readFileSync(proposalPath(), 'utf8');
  const fm = parseFrontmatter(text);
  const idMatch = /\*\*Proposal ID:\*\*\s*(AMP-[\w-]+)/.exec(text);
  const v = validate();
  return {
    present: true,
    id: idMatch ? idMatch[1] : null,
    verdict: fm.verdict,
    approvedBy: fm.approvedBy,
    appliedAt: fm.appliedAt,
    validationOk: v.ok,
    issues: v.issues,
  };
}

// ── apply: mutate architecture.md ────────────────────────────────────

function nextAdrId() {
  if (!fs.existsSync(adrsDir())) return 'ADR-001';
  const existing = fs.readdirSync(adrsDir()).filter((f) => /^ADR-\d+/.test(f));
  const max = existing.reduce((acc, f) => Math.max(acc, parseInt(f.match(/ADR-(\d+)/)[1], 10)), 0);
  return `ADR-${String(max + 1).padStart(3, '0')}`;
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

function extractDiffBlock(text) {
  const m = /```diff\s*\n([\s\S]*?)\n```/.exec(text);
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => l.slice(1).trimStart());
  const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1).trimStart());
  return { removed: removed.join('\n'), added: added.join('\n') };
}

function extractAdrDraft(text) {
  const m = /```markdown\s*\n(# ADR-[\s\S]*?)\n```/.exec(text);
  return m ? m[1] : null;
}

function apply(opts = {}) {
  const s = status();
  if (!s.present) return { ok: false, reason: 'no proposal found' };
  if (s.verdict !== 'APPROVE')
    return { ok: false, reason: `verdict is ${s.verdict} — only APPROVE applies`, status: s };
  if (!s.validationOk && !opts.force) return { ok: false, reason: 'proposal fails validation', issues: s.issues };

  const text = fs.readFileSync(proposalPath(), 'utf8');
  const diff = extractDiffBlock(text);
  if (!diff) return { ok: false, reason: 'cannot extract diff block from proposal' };

  const adrDraft = extractAdrDraft(text);
  if (!adrDraft) return { ok: false, reason: 'cannot extract ADR draft from proposal' };

  // 1. Snapshot current architecture.md
  const archPath = architecturePath();
  if (!fs.existsSync(archPath)) return { ok: false, reason: 'architecture.md not found; nothing to mutate' };

  fs.mkdirSync(historyDir(), { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotPath = path.join(historyDir(), `architecture-${ts}.md`);
  fs.copyFileSync(archPath, snapshotPath);

  // 2. Apply diff — deterministic with ambiguity guard (v0.12.0 WS3 fix H1).
  //    If the removed block appears in >1 location, string-replace would
  //    silently corrupt unrelated sections. Reject and require an anchor
  //    (extra context line) in the proposal diff.
  const current = fs.readFileSync(archPath, 'utf8');
  let mutated;
  if (diff.removed) {
    const occurrences = countOccurrences(current, diff.removed);
    if (occurrences === 0) {
      return {
        ok: false,
        reason: `proposed diff "- removed" block not found in architecture.md — rebase the proposal onto the current file`,
        occurrences: 0,
      };
    }
    if (occurrences > 1 && !opts.force) {
      return {
        ok: false,
        reason: `proposed diff matches ${occurrences} locations in architecture.md — ambiguous replacement would corrupt the file. Add more context (surrounding lines) to the diff block so it uniquely identifies ONE site, or pass --force to accept first-match (dangerous).`,
        occurrences,
      };
    }
    mutated = current.replace(diff.removed, diff.added);
  } else if (diff.added) {
    // Pure addition mode (no removal) — append at end with a marker
    mutated = `${current.replace(/\n*$/, '')}\n\n<!-- Applied ${s.id} -->\n${diff.added}\n`;
  } else {
    return { ok: false, reason: 'diff has no additions; nothing to apply' };
  }
  fs.writeFileSync(archPath, mutated);

  // 3. Emit ADR
  fs.mkdirSync(adrsDir(), { recursive: true });
  const adrId = nextAdrId();
  const adrBody = adrDraft
    .replace(/ADR-\w+/, adrId)
    .replace(/\*\*Status:\*\*\s*Proposed\b/i, `**Status:** Accepted — via ${s.id}`);
  const adrPath = path.join(adrsDir(), `${adrId}.md`);
  fs.writeFileSync(adrPath, adrBody);

  // 4. Update proposal frontmatter — appliedAt timestamp
  const appliedText = text.replace(/appliedAt:\s*null/, `appliedAt: ${new Date().toISOString()}`);
  fs.writeFileSync(proposalPath(), appliedText);

  // 5. Audit log
  try {
    const auditDir = path.join(process.cwd(), '_cobolt-output', 'audit');
    fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      path.join(auditDir, 'arch-mutations.jsonl'),
      `${JSON.stringify({
        ts: new Date().toISOString(),
        proposalId: s.id,
        adrId,
        approvedBy: s.approvedBy,
        snapshot: snapshotPath,
      })}\n`,
    );
  } catch {}

  return {
    ok: true,
    proposalId: s.id,
    adrId,
    adrPath,
    architectureSnapshot: snapshotPath,
    architecturePath: archPath,
  };
}

// v0.12.0 fix M6: history + revert

function listHistory() {
  if (!fs.existsSync(historyDir())) return { count: 0, snapshots: [] };
  const snapshots = fs
    .readdirSync(historyDir())
    .filter((f) => /^architecture-.*\.md$/.test(f))
    .map((f) => {
      const full = path.join(historyDir(), f);
      const stat = fs.statSync(full);
      return { file: f, path: full, size: stat.size, mtime: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
  return { count: snapshots.length, snapshots };
}

function revert(target) {
  const history = listHistory();
  if (history.count === 0) return { ok: false, reason: 'no snapshots found in architecture-history/' };
  // Resolve target: either a snapshot filename, an AMP-ID (via audit log), or "latest"
  let snap = null;
  if (!target || target === 'latest') {
    snap = history.snapshots[0];
  } else if (/^AMP-/.test(target)) {
    // Look up via audit log to find the snapshot path tied to this proposal ID
    const auditFile = path.join(process.cwd(), '_cobolt-output', 'audit', 'arch-mutations.jsonl');
    if (fs.existsSync(auditFile)) {
      const lines = fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const rec = JSON.parse(line);
          if (rec.proposalId === target && rec.snapshot && fs.existsSync(rec.snapshot)) {
            snap = { file: path.basename(rec.snapshot), path: rec.snapshot };
            break;
          }
        } catch {}
      }
    }
    if (!snap) return { ok: false, reason: `no snapshot found for ${target}` };
  } else {
    snap = history.snapshots.find((s) => s.file === target || s.path === target);
    if (!snap) return { ok: false, reason: `snapshot not found: ${target}` };
  }
  const archPath = architecturePath();
  if (!fs.existsSync(archPath)) return { ok: false, reason: 'architecture.md missing — nothing to revert over' };
  // Snapshot CURRENT architecture before reverting (so revert is itself reversible)
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(archPath, path.join(historyDir(), `architecture-pre-revert-${ts}.md`));
  fs.copyFileSync(snap.path, archPath);
  try {
    const auditDir = path.join(process.cwd(), '_cobolt-output', 'audit');
    fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      path.join(auditDir, 'arch-mutations.jsonl'),
      `${JSON.stringify({
        ts: new Date().toISOString(),
        action: 'revert',
        restored: snap.file,
        preRevert: `architecture-pre-revert-${ts}.md`,
      })}\n`,
    );
  } catch {}
  return { ok: true, restored: snap.file, architecturePath: archPath };
}

function list() {
  const dir = fixDir();
  if (!fs.existsSync(dir)) return { count: 0, proposals: [] };
  const proposals = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && /arch-mutation-proposal.*\.md$/.test(entry.name)) {
      const full = path.join(dir, entry.name);
      const text = fs.readFileSync(full, 'utf8');
      const fm = parseFrontmatter(text);
      const idMatch = /\*\*Proposal ID:\*\*\s*(AMP-[\w-]+)/.exec(text);
      proposals.push({
        file: entry.name,
        id: idMatch ? idMatch[1] : null,
        verdict: fm.verdict,
        appliedAt: fm.appliedAt,
      });
    }
  }
  return { count: proposals.length, proposals };
}

// ── CLI ─────────────────────────────────────────────────────────────

function parseFlags(args) {
  const out = { _: [], iteration: null, force: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--iteration') out.iteration = args[++i];
    else if (args[i] === '--force') out.force = true;
    else out._.push(args[i]);
  }
  return out;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (cmd) {
    case 'new': {
      const r = newProposal(flags);
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    case 'validate': {
      const r = validate();
      console.log(JSON.stringify(r, null, 2));
      return r.ok ? 0 : 1;
    }
    case 'status': {
      const r = status();
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    case 'apply': {
      const r = apply(flags);
      console.log(JSON.stringify(r, null, 2));
      return r.ok ? 0 : 1;
    }
    case 'list': {
      console.log(JSON.stringify(list(), null, 2));
      return 0;
    }
    case 'list-history': {
      console.log(JSON.stringify(listHistory(), null, 2));
      return 0;
    }
    case 'revert': {
      const r = revert(flags._[0] || 'latest');
      console.log(JSON.stringify(r, null, 2));
      return r.ok ? 0 : 1;
    }
    default:
      console.error(
        'Usage: cobolt-arch-propose.js {new|validate|status|apply|list|list-history|revert [AMP-ID|filename|latest]} [--iteration N] [--force]',
      );
      return 1;
  }
}

if (require.main === module) process.exit(main());

module.exports = { newProposal, validate, status, apply, list, listHistory, revert, parseFrontmatter };
