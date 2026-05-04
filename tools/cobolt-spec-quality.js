#!/usr/bin/env node

// CoBolt Spec Quality Gate (v0.24+) — C-1 / M-1 fix
//
// Deterministic post-output gate that detects templated-boilerplate output
// from spec-architect and feature-dossier generation:
//   - identical Data Structures across stories
//   - identical Integration Points across stories
//   - Function Signatures that read as English prose (not concrete prototypes)
//   - File Map ↔ Implementation Order disagreement
//   - feature-dossier word-overlap similarity (cloned dossiers)
//
// Complements cobolt-spec-verify.js (disk-existence verification) with
// content-uniqueness verification. Run after Step 01A (story-spec generation)
// and Step 4 of cobolt-analyze-features.
//
// Exit codes:
//   0 = all specs clean
//   1 = usage error
//   2 = skipped (no specs found — valid when no planning stage has run)
//   3 = findings present (block)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_SKIPPED = 2;
const EXIT_FINDINGS = 3;

const DEFAULT_IDENTICAL_THRESHOLD = 3;

function hashText(s) {
  return crypto
    .createHash('sha256')
    .update(String(s || '').trim())
    .digest('hex')
    .slice(0, 16);
}

// Normalize for content-hash comparison: collapse whitespace, strip
// story-specific IDs so two truly-identical boilerplate dumps hash the same
// even when trivially decorated.
function normalize(s) {
  return String(s || '')
    .replace(/\bE\d+-S\d+\b/g, 'S_')
    .replace(/\bS\d+-S\d+\b/g, 'S_')
    .replace(/\bS\d+\.\d+\b/g, 'S_')
    .replace(/\bFR-\d+\b/g, 'FR_')
    .replace(/\bNFR-\d+\b/g, 'NFR_')
    .replace(/\bT\d+\b/g, 'T_')
    .replace(/^\s*[-*]\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractSection(md, heading) {
  // Find the heading line, capture everything up to the next ## / ### heading
  // or end-of-string. Note: JS regex has no \Z anchor — we pattern-match the
  // next heading, and if no later heading exists, we fall back to end-of-string
  // by taking the rest of the file after the heading match.
  const startRe = new RegExp(`^###\\s+${heading}\\s*$`, 'im');
  const m = startRe.exec(md);
  if (!m) return '';
  const after = md.slice(m.index + m[0].length);
  const nextRe = /^(?:##|###)\s+\S/m;
  const n = nextRe.exec(after);
  const body = n ? after.slice(0, n.index) : after;
  return body.trim();
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function normalizeMilestone(value) {
  const match = String(value || '')
    .trim()
    .match(/^M?(\d+)$/i);
  return match ? `M${Number.parseInt(match[1], 10)}` : null;
}

function findSpecDirs(cwd, opts = {}) {
  if (opts.specDir) {
    const dir = path.resolve(cwd, opts.specDir);
    return fs.existsSync(dir) ? [dir] : [];
  }

  const milestone = normalizeMilestone(opts.milestone);
  if (milestone) {
    const dir = path.join(cwd, '_cobolt-output', 'latest', 'build', milestone, `${milestone}-story-specs`);
    return fs.existsSync(dir) ? [dir] : [];
  }

  const candidates = [path.join(cwd, '_cobolt-output', 'latest', 'planning', 'story-specs')];
  const buildRoot = path.join(cwd, '_cobolt-output', 'latest', 'build');
  if (fs.existsSync(buildRoot)) {
    try {
      for (const m of fs.readdirSync(buildRoot)) {
        if (/^M\d+$/.test(m)) {
          const d = path.join(buildRoot, m, `${m}-story-specs`);
          if (fs.existsSync(d)) candidates.push(d);
        }
      }
    } catch {
      /* ignore */
    }
  }
  return candidates.filter((d) => fs.existsSync(d));
}

function listSpecs(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !/index\.md$/i.test(f));
  } catch {
    return [];
  }
}

function checkBoilerplate(dir, section, findings, threshold) {
  const specs = listSpecs(dir);
  if (specs.length < threshold) return;
  const hashes = {};
  for (const name of specs) {
    const md = readText(path.join(dir, name));
    if (!md) continue;
    const s = extractSection(md, section);
    if (!s) continue;
    const h = hashText(normalize(s));
    if (!hashes[h]) hashes[h] = [];
    hashes[h].push(name);
  }
  for (const [h, names] of Object.entries(hashes)) {
    if (names.length >= threshold) {
      findings.push({
        class: `boilerplate-${section.toLowerCase().replace(/\s+/g, '-')}`,
        severity: 'critical',
        section,
        hash: h,
        affected: names,
        message: `${section} content is IDENTICAL across ${names.length} story specs (${names.slice(0, 5).join(', ')}${names.length > 5 ? `, +${names.length - 5} more` : ''}) — indicates template-dump rather than story-scoped authoring`,
      });
    }
  }
}

// Template-guidance phrases — lines that match these are scaffold scaffolding,
// not supposed-to-be-signatures. Skip them. Keeps false-positive rate low on
// specs where the author copy-pasted the template's guidance bullets.
const TEMPLATE_GUIDANCE = [
  /^purpose[: ]/i,
  /^error\s*cases?[: ]/i,
  /^ac-\d/i,
  /^which\s+acceptance/i,
  /^one[-\s]line/i,
  /^full\s+signature/i,
  /^for each/i,
  /^include\s/i,
  /^returns?\b[^(]*$/i, // "Returns value" helper text, no parens
  /^\s*$/,
];

function isTemplateGuidance(line) {
  return TEMPLATE_GUIDANCE.some((re) => re.test(line));
}

function checkSignatures(dir, findings) {
  const specs = listSpecs(dir);
  for (const name of specs) {
    const md = readText(path.join(dir, name));
    if (!md) continue;
    const sec = extractSection(md, 'Function Signatures');
    if (!sec) continue;
    const rawLines = sec.split('\n').map((l) => l.replace(/^\s*[-*]\s*/, '').trim());
    // Candidate lines: anything that looks like it's ATTEMPTING to be a
    // signature. Exclude headings, table fences, code-fence markers, and
    // template guidance phrases. Exclude lines that are all-prose
    // descriptions (no special chars at all — those aren't attempted sigs).
    const candidateLines = rawLines.filter((l) => {
      if (l.length < 10) return false;
      if (l.startsWith('#') || l.startsWith('|') || l.startsWith('```')) return false;
      if (isTemplateGuidance(l)) return false;
      // Skip pure descriptive prose (no parens, no code punctuation).
      // A line without any code markers is not an attempted signature.
      const hasAnyCodeMarker = /[()[\]<>:=\->]/.test(l);
      if (!hasAnyCodeMarker) return false;
      return true;
    });
    if (candidateLines.length === 0) continue;
    const bad = [];
    for (const line of candidateLines) {
      const hasParen = /\([^)]*\)/.test(line);
      const hasReturnMarker = /->|=>|:\s*[A-Z]|\bResult<|\bPromise<|\bOption</.test(line);
      // Concrete = has parens AND (return-type marker OR starts with a callable name)
      const startsCallable =
        /^[A-Za-z_][\w:.]*\(/.test(line) ||
        /^(pub\s+)?(async\s+)?(unsafe\s+)?(fn|function|def|public|private|export\s+function)\b/.test(line);
      const concrete = hasParen && (hasReturnMarker || startsCallable);
      if (!concrete) bad.push(line.slice(0, 140));
    }
    // Flag when: at least 1 non-concrete candidate AND (all candidates are
    // non-concrete OR majority are). Catches the OmniTime failure mode
    // (every signature is English prose) without false-positiving on a
    // lone odd bullet in an otherwise-concrete section.
    const allBad = bad.length === candidateLines.length;
    const majorityBad = bad.length / candidateLines.length >= 0.5;
    if (bad.length >= 1 && (allBad || majorityBad)) {
      findings.push({
        class: 'non-concrete-signatures',
        severity: 'high',
        spec: name,
        total: candidateLines.length,
        nonConcrete: bad.length,
        examples: bad.slice(0, 5),
        message: `${name}: ${bad.length}/${candidateLines.length} Function Signature line(s) lack concrete prototype — English prose or task restatement (e.g., "tokio::interval tick" instead of "pub fn spawn_tick_loop(app: AppHandle, period: Duration) -> JoinHandle<()>")`,
      });
    }
  }
}

function checkFileMapOrderParity(dir, findings) {
  const specs = listSpecs(dir);
  for (const name of specs) {
    const md = readText(path.join(dir, name));
    if (!md) continue;
    const fileMap = extractSection(md, 'File Map');
    const implOrder = extractSection(md, 'Implementation Order');
    if (!fileMap || !implOrder) continue;

    const fileMapTaskIds = new Set();
    for (const row of fileMap.split('\n')) {
      if (!row.startsWith('|')) continue;
      if (/^\|[-\s|:]+\|$/.test(row)) continue; // separator row
      if (/Action\s*\|\s*File Path/i.test(row)) continue; // header
      const m = row.match(/\bT\d+\b/g);
      if (m) for (const t of m) fileMapTaskIds.add(t);
    }

    const orderTaskIds = new Set();
    for (const line of implOrder.split('\n')) {
      const m = line.match(/\bT\d+\b/g);
      if (m) for (const t of m) orderTaskIds.add(t);
    }

    if (fileMapTaskIds.size === 0 || orderTaskIds.size === 0) continue;

    const onlyInMap = [...fileMapTaskIds].filter((t) => !orderTaskIds.has(t)).sort();
    const onlyInOrder = [...orderTaskIds].filter((t) => !fileMapTaskIds.has(t)).sort();
    if (onlyInMap.length > 0 || onlyInOrder.length > 0) {
      findings.push({
        class: 'file-map-impl-order-drift',
        severity: 'high',
        spec: name,
        onlyInFileMap: onlyInMap,
        onlyInImplOrder: onlyInOrder,
        message: `${name}: File Map ↔ Implementation Order disagree — onlyInFileMap=[${onlyInMap.join(', ')}], onlyInImplOrder=[${onlyInOrder.join(', ')}]`,
      });
    }
  }
}

function runSpecChecks(cwd, opts = {}) {
  const dirs = findSpecDirs(cwd, opts);
  if (dirs.length === 0) {
    return { status: 'skipped', reason: 'no story-specs directory found', findings: [] };
  }
  const findings = [];
  const threshold = opts.threshold || DEFAULT_IDENTICAL_THRESHOLD;
  for (const dir of dirs) {
    checkBoilerplate(dir, 'Data Structures', findings, threshold);
    checkBoilerplate(dir, 'Integration Points', findings, threshold);
    checkSignatures(dir, findings);
    checkFileMapOrderParity(dir, findings);
  }
  return { status: findings.length === 0 ? 'pass' : 'fail', dirs, findings };
}

// ── Feature dossier uniqueness ───────────────────────────────
function listDossiers(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => /^FEAT-\d+.*\.md$/i.test(f));
  } catch {
    return [];
  }
}

function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4);
}

function jaccard(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  const inter = [...sa].filter((x) => sb.has(x)).length;
  const uni = new Set([...sa, ...sb]).size;
  return uni === 0 ? 0 : inter / uni;
}

function checkDossiers(cwd, findings) {
  const dossierDir = path.join(cwd, '_cobolt-output', 'latest', 'planning', 'feature-dossiers');
  if (!fs.existsSync(dossierDir)) return;
  const files = listDossiers(dossierDir);
  if (files.length < 2) return;
  const contents = files.map((f) => ({
    name: f,
    toks: tokens(normalize(readText(path.join(dossierDir, f)) || '')),
  }));
  for (let i = 0; i < contents.length; i += 1) {
    for (let j = i + 1; j < contents.length; j += 1) {
      const sim = jaccard(contents[i].toks, contents[j].toks);
      if (sim >= 0.85) {
        findings.push({
          class: 'dossier-boilerplate',
          severity: 'high',
          pair: [contents[i].name, contents[j].name],
          similarity: Number(sim.toFixed(3)),
          message: `Feature dossiers ${contents[i].name} and ${contents[j].name} are ${(sim * 100).toFixed(0)}% similar — likely template duplication`,
        });
      }
    }
  }
}

// v0.40.13 PROD-03: executable-prd.json clone detection.
// When the `cobolt-prd-execute` producer churns out per-FR records with
// identical negativeCases/edgeCases/apiContracts/e2eScenarios arrays (a
// for-loop over a template), every FR looks differentiated by id alone but
// shares behavior. Reject the artifact when ≥80% of requirement pairs exceed
// the Jaccard clone threshold on their narrative fields.
function checkExecutablePrdClones(cwd, findings) {
  const prdPath = path.join(cwd, '_cobolt-output', 'latest', 'planning', 'executable-prd.json');
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(prdPath, 'utf8'));
  } catch {
    return; // no executable-prd, or malformed — skip (other gates handle shape)
  }
  const reqs = Array.isArray(doc?.requirements)
    ? doc.requirements
    : Array.isArray(doc?.functionalRequirements)
      ? doc.functionalRequirements
      : Array.isArray(doc?.frs)
        ? doc.frs
        : null;
  if (!reqs || reqs.length < 3) return; // need ≥3 to detect pattern

  // Narrative fields to compare — these are the ones the skeleton producer
  // templates across every requirement. ID/title/description are legitimately
  // distinct per FR and excluded.
  const NARRATIVE_FIELDS = [
    'negativeCases',
    'edgeCases',
    'stateTransitions',
    'apiContracts',
    'e2eScenarios',
    'businessRules',
    'acceptanceCriteria',
    'examples',
  ];

  const fingerprints = reqs.map((r) => {
    const parts = [];
    for (const key of NARRATIVE_FIELDS) {
      const v = r?.[key];
      if (v == null) continue;
      parts.push(`${key}:${JSON.stringify(v)}`);
    }
    return { id: r.id || r.frId || `#${reqs.indexOf(r)}`, toks: tokens(parts.join(' ')) };
  });

  let matchedPairs = 0;
  let totalPairs = 0;
  const clonePairs = [];
  for (let i = 0; i < fingerprints.length; i += 1) {
    for (let j = i + 1; j < fingerprints.length; j += 1) {
      totalPairs += 1;
      const sim = jaccard(fingerprints[i].toks, fingerprints[j].toks);
      if (sim >= 0.85) {
        matchedPairs += 1;
        if (clonePairs.length < 5) {
          clonePairs.push({ a: fingerprints[i].id, b: fingerprints[j].id, similarity: Number(sim.toFixed(3)) });
        }
      }
    }
  }

  if (totalPairs === 0) return;
  const cloneRatio = matchedPairs / totalPairs;
  if (cloneRatio >= 0.5) {
    // 50%+ of pairs are clones → systemic template-loop, not occasional overlap
    findings.push({
      class: 'executable-prd-clone',
      severity: 'high',
      file: 'executable-prd.json',
      requirementsCount: reqs.length,
      clonePairs: clonePairs,
      clonedPairCount: matchedPairs,
      totalPairCount: totalPairs,
      cloneRatio: Number(cloneRatio.toFixed(3)),
      message: `executable-prd.json has ${matchedPairs}/${totalPairs} (${(cloneRatio * 100).toFixed(0)}%) requirement pairs with ≥85% narrative-field similarity — producer cobolt-prd-execute is emitting template clones instead of differentiated FR content`,
    });
  }
}

// v0.40.13 PROD-09: IR boilerplate detection.
// Scans implicit-requirements.md "Given/When/Then" acceptance lines across
// all IR-NNN entries. When ≥50% of the lines are token-identical to their
// peers (Jaccard ≥0.85 on the acceptance phrase only, not the IR title),
// flags systemic boilerplate — the producer agent is emitting template
// clones with noun substitution. Test5 emitted identical
//   "Given FR-N when the edge case occurs then state, accessibility, and
//    local-only privacy are preserved."
// across all 10 IRs. That pattern must be blocked.
function checkImplicitReqBoilerplate(cwd, findings) {
  const irPath = path.join(cwd, '_cobolt-output', 'latest', 'planning', 'implicit-requirements.md');
  const body = readText(irPath);
  if (!body) return;
  // IR-NNN heading, then 1+ "- Given ... When ... Then ..." lines underneath.
  const irBlockRe = /^###\s+IR-\d+[:\s][^\n]*\n([\s\S]*?)(?=^###\s+IR-\d+|Z)/gm;
  const blocks = [];
  let m;
  while ((m = irBlockRe.exec(body)) !== null) {
    const given = m[1].match(/-\s*Given[\s\S]*?(?=\n\s*-\s|\n\s*\*\*|\n\n|$)/i);
    if (given) blocks.push({ text: given[0], idx: blocks.length + 1 });
  }
  if (blocks.length < 3) return; // need ≥3 IRs to detect systemic boilerplate

  let matchedPairs = 0;
  let totalPairs = 0;
  const clonePairs = [];
  for (let i = 0; i < blocks.length; i += 1) {
    for (let j = i + 1; j < blocks.length; j += 1) {
      totalPairs += 1;
      const sim = jaccard(tokens(blocks[i].text), tokens(blocks[j].text));
      if (sim >= 0.85) {
        matchedPairs += 1;
        if (clonePairs.length < 5) {
          clonePairs.push({ a: `IR#${blocks[i].idx}`, b: `IR#${blocks[j].idx}`, similarity: Number(sim.toFixed(3)) });
        }
      }
    }
  }

  if (totalPairs === 0) return;
  const cloneRatio = matchedPairs / totalPairs;
  if (cloneRatio >= 0.5) {
    findings.push({
      class: 'ir-boilerplate',
      severity: 'high',
      file: 'implicit-requirements.md',
      irCount: blocks.length,
      clonePairs: clonePairs,
      clonedPairCount: matchedPairs,
      totalPairCount: totalPairs,
      cloneRatio: Number(cloneRatio.toFixed(3)),
      message: `implicit-requirements.md has ${matchedPairs}/${totalPairs} (${(cloneRatio * 100).toFixed(0)}%) IR acceptance-criteria pairs with ≥85% similarity — implicit-req-extractor emitted template clones instead of per-IR specific evidence`,
    });
  }
}

// v0.40.13 PROD-10: Epic-AC boilerplate detection.
// epics.md is authored by the cobolt-create-epics-and-stories skill (no
// dedicated agent). Test5 produced 12 stories all sharing the AC template
//   "Given the planned X workflow / When the user completes it on Windows
//    desktop / Then [FR-list] are satisfied with local-only persistence,
//    accessibility, and tests."
// That is not behavioral AC — it's a shape-correct filler. Reject when
// ≥50% of story AC pairs are token-identical (Jaccard ≥0.85).
function checkEpicsAcBoilerplate(cwd, findings) {
  const epicsPath = path.join(cwd, '_cobolt-output', 'latest', 'planning', 'epics.md');
  const body = readText(epicsPath);
  if (!body) return;
  // Match each "### Story" or "#### Story" heading followed by its
  // "Acceptance Criteria" block (stopping at next story header or end).
  const storyRe =
    /^#{3,4}\s+(?:Story\s+)?(?:E\d+-)?S\d+[^\n]*\n([\s\S]*?)(?=^#{3,4}\s+(?:Story\s+)?(?:E\d+-)?S\d+|^##\s+|Z)/gm;
  const acBlocks = [];
  let m;
  while ((m = storyRe.exec(body)) !== null) {
    // Extract the Acceptance Criteria block (first Given/When/Then group).
    const acMatch = m[1].match(/Given[\s\S]*?Then[^\n]+/i);
    if (acMatch) acBlocks.push({ text: acMatch[0], idx: acBlocks.length + 1 });
  }
  if (acBlocks.length < 3) return;

  let matchedPairs = 0;
  let totalPairs = 0;
  const clonePairs = [];
  for (let i = 0; i < acBlocks.length; i += 1) {
    for (let j = i + 1; j < acBlocks.length; j += 1) {
      totalPairs += 1;
      const sim = jaccard(tokens(acBlocks[i].text), tokens(acBlocks[j].text));
      if (sim >= 0.85) {
        matchedPairs += 1;
        if (clonePairs.length < 5) {
          clonePairs.push({
            a: `Story#${acBlocks[i].idx}`,
            b: `Story#${acBlocks[j].idx}`,
            similarity: Number(sim.toFixed(3)),
          });
        }
      }
    }
  }
  if (totalPairs === 0) return;
  const cloneRatio = matchedPairs / totalPairs;
  if (cloneRatio >= 0.5) {
    findings.push({
      class: 'epic-ac-boilerplate',
      severity: 'high',
      file: 'epics.md',
      storyCount: acBlocks.length,
      clonePairs: clonePairs,
      clonedPairCount: matchedPairs,
      totalPairCount: totalPairs,
      cloneRatio: Number(cloneRatio.toFixed(3)),
      message: `epics.md has ${matchedPairs}/${totalPairs} (${(cloneRatio * 100).toFixed(0)}%) story AC pairs with ≥85% similarity — cobolt-create-epics-and-stories emitted template clones instead of behavioral Given/When/Then`,
    });
  }
}

function runAll(cwd, opts = {}) {
  const specResult = runSpecChecks(cwd, opts);
  const findings = specResult.findings.slice();
  const milestoneScoped = Boolean(normalizeMilestone(opts.milestone) || opts.specDir);
  if (!milestoneScoped || opts.includePlanning === true) {
    checkDossiers(cwd, findings);
    checkExecutablePrdClones(cwd, findings);
    checkImplicitReqBoilerplate(cwd, findings);
    checkEpicsAcBoilerplate(cwd, findings);
  }
  let status;
  if (findings.length > 0) status = 'fail';
  else if (specResult.status === 'skipped') status = 'skipped';
  else status = 'pass';
  return {
    status,
    scope: milestoneScoped && !opts.includePlanning ? 'milestone-story-specs' : 'all',
    milestone: normalizeMilestone(opts.milestone) || null,
    dirs: specResult.dirs || [],
    findings,
  };
}

function emit(result, opts) {
  if (opts.out) {
    fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
    fs.writeFileSync(path.resolve(opts.out), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const badge = result.status === 'pass' ? 'PASS' : result.status === 'skipped' ? 'SKIP' : 'FAIL';
  process.stdout.write(`[${badge}] cobolt-spec-quality — ${result.findings.length} finding(s)\n`);
  for (const f of result.findings.slice(0, 10)) {
    process.stdout.write(`  • [${f.severity}] ${f.message}\n`);
  }
  if (result.findings.length > 10) {
    process.stdout.write(`  … ${result.findings.length - 10} more (use --json for full output)\n`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const opts = {
    json: args.includes('--json'),
    milestone: (() => {
      const i = args.indexOf('--milestone');
      return i >= 0 ? normalizeMilestone(args[i + 1]) : null;
    })(),
    specDir: (() => {
      const i = args.indexOf('--spec-dir');
      return i >= 0 ? args[i + 1] : null;
    })(),
    includePlanning: args.includes('--include-planning'),
    out: (() => {
      const i = args.indexOf('--out');
      return i >= 0 ? args[i + 1] : null;
    })(),
    threshold: (() => {
      const i = args.indexOf('--threshold');
      if (i < 0) return DEFAULT_IDENTICAL_THRESHOLD;
      const v = parseInt(args[i + 1], 10);
      return Number.isFinite(v) && v > 0 ? v : DEFAULT_IDENTICAL_THRESHOLD;
    })(),
  };
  // v0.65.3 (audit S3-D, restoring v0.40.2 exit-code contract):
  // --help / -h / help / no-args  → stdout + exit 0 (success).
  // unknown command                → stderr + exit 1 (usage error).
  const helpText = `${[
    'Usage: cobolt-spec-quality verify [--json] [--threshold N]',
    '       cobolt-spec-quality verify --out <path> [--json]',
    '       cobolt-spec-quality verify --milestone M1 [--out <path>] [--json]',
    '       cobolt-spec-quality verify --spec-dir <path> [--include-planning] [--json]',
    '',
    'Checks:',
    '  - boilerplate Data Structures (N+ specs with identical content)',
    '  - boilerplate Integration Points (N+ specs with identical content)',
    '  - non-concrete function signatures (English prose / task restatement)',
    '  - File Map ↔ Implementation Order parity',
    '  - feature-dossier word-overlap similarity (FEAT-NNN.md pairs)',
    '',
    'Exit codes: 0 OK | 1 usage | 2 skipped | 3 findings',
  ].join('\n')}\n`;
  if (cmd === 'help' || cmd === '-h' || cmd === '--help' || !cmd) {
    process.stdout.write(helpText);
    process.exit(0);
  }
  if (cmd !== 'verify') {
    process.stderr.write(`Unknown command: ${cmd}\n${helpText}`);
    process.exit(EXIT_USAGE);
  }
  try {
    if (opts.out === undefined) {
      process.stderr.write('--out requires a path\n');
      process.exit(EXIT_USAGE);
    }
    const result = runAll(process.cwd(), opts);
    emit(result, opts);
    if (result.status === 'pass') process.exit(EXIT_OK);
    if (result.status === 'skipped') process.exit(EXIT_SKIPPED);
    process.exit(EXIT_FINDINGS);
  } catch (err) {
    process.stderr.write(`[cobolt-spec-quality] ERROR: ${err.message}\n`);
    process.exit(EXIT_USAGE);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  runAll,
  runSpecChecks,
  checkDossiers,
  checkExecutablePrdClones,
  checkImplicitReqBoilerplate,
  checkEpicsAcBoilerplate,
  checkBoilerplate,
  checkSignatures,
  checkFileMapOrderParity,
  findSpecDirs,
  extractSection,
  normalize,
  normalizeMilestone,
  hashText,
  isTemplateGuidance,
  TEMPLATE_GUIDANCE,
};
