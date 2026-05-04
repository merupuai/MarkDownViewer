const fs = require('node:fs');
const path = require('node:path');

const {
  createFinding,
  dedupeFindings,
  jaccardSimilarity,
  listPlanningFiles,
  listRootPlanningFiles,
  loadArtifactDependencies,
  loadPlanPhaseArtifacts,
  normalizeContentForSimilarity,
  parseMarkdownSections,
  planningFlagsFromState,
  readText,
  relativeToPlanning,
  shannonEntropy,
} = require('./_shared');

// Strict placeholder patterns — any occurrence (even inside prose) indicates
// an unfilled scaffold. These are never policy vocabulary.
const STRICT_PLACEHOLDER_PATTERNS = [
  /\bTBD\b/i,
  /<placeholder>/i,
  /\[placeholder\]/i,
  /\blorem ipsum\b/i,
  /\bto be determined\b/i,
  /\boperational needs and business priorities\b/i,
  /\bfilled in during implementation\b/i,
];

// Contextual placeholder patterns — TODO/FIXME are legitimate POLICY vocabulary
// when documents discuss marker governance (e.g. "TODO/FIXME marker governance"
// in engineering-quality-standards.md). A bare word "TODO" only indicates a
// placeholder when it appears in a value position. Match these shapes only:
//   `Value: TODO`   (colon-then-TODO, possibly at end of line)
//   `- TODO`        (list item with only the marker)
//   `| TODO |`      (table cell)
//   `> TODO`        (blockquote where TODO is the whole citation)
//   bare line `TODO` at beginning or end of line
const CONTEXTUAL_PLACEHOLDER_PATTERNS = [
  /:\s*TODO\b(?!\s*[/-]\s*FIXME\b)/i, // "Description: TODO" but not "Policy: TODO/FIXME markers"
  /:\s*FIXME\b(?!\s*[/-]\s*TODO\b)/i,
  /^\s*[-*]\s+TODO\s*$/im, // bullet with only the marker
  /^\s*[-*]\s+FIXME\s*$/im,
  /^\s*TODO\s*$/im, // lone TODO on a line
  /^\s*FIXME\s*$/im,
  /\|\s*TODO\s*\|/i, // table cell
  /\|\s*FIXME\s*\|/i,
];

// Strip fenced code, inline code spans, and headings before scanning for
// contextual TODO/FIXME — those are code examples or section titles documenting
// the marker governance, not placeholder stubs.
function normalizeForPlaceholderScan(content) {
  return String(content || '')
    .replace(/```[\s\S]*?```/g, '') // fenced code blocks
    .replace(/`[^`\n]+`/g, '') // inline code spans
    .replace(/^#+\s+.*$/gm, ''); // markdown headings
}

function countPlaceholders(content) {
  const raw = String(content || '');
  const normalized = normalizeForPlaceholderScan(raw);
  let count = 0;
  for (const pattern of STRICT_PLACEHOLDER_PATTERNS) {
    if (pattern.test(raw)) count += 1;
  }
  for (const pattern of CONTEXTUAL_PLACEHOLDER_PATTERNS) {
    if (pattern.test(normalized)) count += 1;
  }
  return count;
}

function hasBddMarkers(content) {
  const text = String(content || '');
  return /\bGiven\b/i.test(text) && /\bWhen\b/i.test(text) && /\bThen\b/i.test(text);
}

function relativeFromContractPath(contractPath) {
  return String(contractPath || '')
    .replace(/^_cobolt-output[\\/]+latest[\\/]+planning[\\/]+/i, '')
    .replace(/^planning[\\/]+/i, '')
    .replace(/\\/g, '/');
}

function resolveExpectedArtifactPath(context, meta) {
  const relativePath = String(meta?.relativePath || '').replace(/\\/g, '/');
  if (relativePath.startsWith('_cobolt-output/')) {
    return path.join(context.projectRoot, ...relativePath.split('/'));
  }
  return path.join(context.planningDir, ...relativePath.split('/'));
}

function requiredWhenActive(requiredWhen, flags) {
  const text = String(requiredWhen || '').toLowerCase();
  if (!text) return false;
  const needsEnhance = text.includes('enhance');
  const needsAuto = text.includes('auto') || text.includes('autonomous');
  if (needsEnhance && flags.enhance) return true;
  if (needsAuto && flags.auto) return true;
  return false;
}

function buildExpectedArtifacts(context) {
  const phaseArtifacts = loadPlanPhaseArtifacts();
  const artifactDependencies = loadArtifactDependencies();
  const flags = planningFlagsFromState(context.state);
  const expected = new Map();

  for (const phase of Object.values(phaseArtifacts.phases || {})) {
    for (const artifact of phase.requiredArtifacts || []) {
      const relativePath = relativeFromContractPath(artifact.path);
      expected.set(relativePath, {
        relativePath,
        minBytes: artifact.minBytes || 0,
        required: true,
        emitWhenMissing: true,
      });
    }
    for (const artifact of phase.optionalArtifacts || []) {
      const relativePath = relativeFromContractPath(artifact.path);
      expected.set(relativePath, {
        relativePath,
        minBytes: artifact.minBytes || 0,
        required: false,
        emitWhenMissing: true,
      });
    }
  }

  for (const artifact of Object.values(artifactDependencies.artifacts || {})) {
    if (!String(artifact.path || '').includes('_cobolt-output/latest/planning/')) continue;
    const relativePath = relativeFromContractPath(artifact.path);
    if (!relativePath) continue;
    const existing = expected.get(relativePath) || {};
    const conditionalRequired = requiredWhenActive(artifact.requiredWhen, flags);
    expected.set(relativePath, {
      relativePath,
      minBytes: Math.max(existing.minBytes || 0, artifact.minBytes || 0),
      required: existing.required || conditionalRequired,
      emitWhenMissing: existing.emitWhenMissing || conditionalRequired,
      critical: Boolean(artifact.critical),
    });
  }

  return expected;
}

function looksTruncated(content) {
  const text = String(content || '').trimEnd();
  if (!text) return false;
  const lines = text.split(/\r?\n/u).map((line) => line.trimEnd());
  const lastNonEmpty = [...lines].reverse().find((line) => line.trim().length > 0) || '';
  if (/^##+\s+/u.test(lastNonEmpty)) return true;

  const sections = parseMarkdownSections(text);
  if (sections.some((section) => section.body.length === 0)) return true;
  return /[:>-]\s*$/.test(lastNonEmpty) && !/[.?!]$/.test(lastNonEmpty);
}

function analyzeMarkdownArtifact(relativePath, absolutePath, meta, findings) {
  const content = readText(absolutePath);
  if (!content.trim()) return;

  if (looksTruncated(content)) {
    findings.push(
      createFinding({
        classId: 'A3',
        severity: 'critical',
        artifact: relativePath,
        evidence: 'Document ends with an empty or unfinished section.',
        remediationHint: 'Regenerate the artifact and ensure every terminal section has substantive body content.',
        detectorId: 'presence-census',
      }),
    );
  }

  const placeholderLabels = countPlaceholders(content);
  const shortSections = parseMarkdownSections(content).filter(
    (section) => section.body.length > 0 && section.body.length < 80,
  );
  const entropy = shannonEntropy(content);
  if (placeholderLabels > 0 || shortSections.length >= 2) {
    findings.push(
      createFinding({
        classId: 'A2',
        severity: meta.required ? 'critical' : 'advisory',
        artifact: relativePath,
        evidence: {
          placeholders: placeholderLabels,
          shortSections: shortSections.map((section) => section.heading).slice(0, 6),
        },
        remediationHint: 'Replace placeholder or shallow sections with concrete planning content before build handoff.',
        detectorId: 'presence-census',
      }),
    );
  }
  if (placeholderLabels > 0 || entropy < 3.1) {
    findings.push(
      createFinding({
        classId: 'D4',
        severity: 'advisory',
        artifact: relativePath,
        evidence: {
          entropy: Number(entropy.toFixed(3)),
          placeholders: placeholderLabels,
        },
        remediationHint: 'Replace filler prose with concrete requirements, targets, or implementation constraints.',
        detectorId: 'presence-census',
      }),
    );
  }
}

function detectDuplicates(planningDir, findings) {
  const candidates = listRootPlanningFiles(planningDir).filter((filePath) => /\.(md|json)$/i.test(filePath));
  for (let index = 0; index < candidates.length; index += 1) {
    const leftPath = candidates[index];
    const leftRelative = relativeToPlanning(planningDir, leftPath);
    const leftContent = readText(leftPath);
    for (let offset = index + 1; offset < candidates.length; offset += 1) {
      const rightPath = candidates[offset];
      const rightRelative = relativeToPlanning(planningDir, rightPath);
      const rightContent = readText(rightPath);
      const similarity = jaccardSimilarity(
        normalizeContentForSimilarity(leftContent),
        normalizeContentForSimilarity(rightContent),
      );
      if (similarity >= 0.85) {
        findings.push(
          createFinding({
            classId: 'A4',
            severity: 'advisory',
            artifact: `${leftRelative} ↔ ${rightRelative}`,
            evidence: { similarity: Number(similarity.toFixed(3)) },
            remediationHint: 'Remove duplicated planning artifacts or consolidate the canonical document name.',
            detectorId: 'presence-census',
          }),
        );
      }
    }
  }
}

function detectOrphans(planningDir, expectedArtifacts, findings) {
  const known = new Set([...expectedArtifacts.keys()].map((entry) => entry.toLowerCase()));
  for (const filePath of listRootPlanningFiles(planningDir)) {
    const relativePath = relativeToPlanning(planningDir, filePath);
    if (known.has(relativePath.toLowerCase())) continue;
    findings.push(
      createFinding({
        classId: 'A5',
        severity: 'critical',
        artifact: relativePath,
        evidence: 'Root planning artifact is not declared in the current phase or dependency registries.',
        remediationHint: 'Rename the file to a canonical artifact path or register it in the planning contracts.',
        detectorId: 'presence-census',
      }),
    );
  }
}

function detectStaleness(context, expectedArtifacts, findings) {
  const trackedFiles = [];
  for (const meta of expectedArtifacts.values()) {
    const absolutePath = resolveExpectedArtifactPath(context, meta);
    if (!fs.existsSync(absolutePath)) continue;
    try {
      const stat = fs.statSync(absolutePath);
      trackedFiles.push({ relativePath: meta.relativePath, mtimeMs: stat.mtimeMs });
    } catch {
      /* ignore */
    }
  }
  const newest = trackedFiles.reduce((max, entry) => Math.max(max, entry.mtimeMs), 0);
  if (!newest) return;
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  for (const entry of trackedFiles) {
    if (newest - entry.mtimeMs <= sevenDaysMs) continue;
    findings.push(
      createFinding({
        classId: 'E4',
        severity: 'advisory',
        artifact: entry.relativePath,
        evidence: { staleByMs: newest - entry.mtimeMs },
        remediationHint: 'Refresh stale planning artifacts before build uses a mixed-era packet.',
        detectorId: 'presence-census',
      }),
    );
  }
}

function detectBddCoverage(context, findings) {
  const epicsPath = path.join(context.planningDir, 'epics.md');
  const epicsContent = readText(epicsPath);
  if (epicsContent && !hasBddMarkers(epicsContent)) {
    findings.push(
      createFinding({
        classId: 'F2',
        severity: 'advisory',
        artifact: 'epics.md',
        evidence: 'epics.md does not include Given/When/Then behavioral markers.',
        remediationHint: 'Add BDD-style behavioral acceptance criteria to epics before build handoff.',
        detectorId: 'presence-census',
      }),
    );
  }

  for (const storyFile of listPlanningFiles(path.join(context.planningDir, 'stories'), { maxDepth: 2 }).filter(
    (filePath) => /\.md$/i.test(filePath),
  )) {
    const relativePath = relativeToPlanning(context.planningDir, storyFile);
    const content = readText(storyFile);
    if (!content || hasBddMarkers(content)) continue;
    findings.push(
      createFinding({
        classId: 'F2',
        severity: 'critical',
        artifact: relativePath,
        evidence: 'Story file is missing Given/When/Then BDD markers.',
        remediationHint: 'Regenerate or repair the story acceptance criteria so each story carries BDD coverage.',
        detectorId: 'presence-census',
      }),
    );
  }
}

function run(context) {
  const expectedArtifacts = buildExpectedArtifacts(context);
  const findings = [];

  for (const meta of expectedArtifacts.values()) {
    const absolutePath = resolveExpectedArtifactPath(context, meta);
    if (!fs.existsSync(absolutePath)) {
      if (!meta.emitWhenMissing) continue;
      findings.push(
        createFinding({
          classId: 'A1',
          severity: meta.required ? 'critical' : 'advisory',
          artifact: meta.relativePath,
          evidence: 'Expected planning artifact is missing from disk.',
          remediationHint: 'Generate the missing artifact or adjust the planning mode/registry before build handoff.',
          detectorId: 'presence-census',
        }),
      );
      continue;
    }

    let stat = null;
    try {
      stat = fs.statSync(absolutePath);
    } catch {
      continue;
    }
    if ((meta.minBytes || 0) > 0 && stat.size < meta.minBytes) {
      findings.push(
        createFinding({
          classId: 'A2',
          severity: meta.required ? 'critical' : 'advisory',
          artifact: meta.relativePath,
          evidence: { bytes: stat.size, minBytes: meta.minBytes },
          remediationHint: 'Regenerate the artifact with full content; it is below the contract minimum size.',
          detectorId: 'presence-census',
        }),
      );
    }

    if (/\.md$/i.test(meta.relativePath)) {
      analyzeMarkdownArtifact(meta.relativePath, absolutePath, meta, findings);
    }
  }

  detectDuplicates(context.planningDir, findings);
  detectOrphans(context.planningDir, expectedArtifacts, findings);
  detectStaleness(context, expectedArtifacts, findings);
  detectBddCoverage(context, findings);

  return {
    detectorId: 'presence-census',
    findings: dedupeFindings(findings),
    metadata: {
      expectedArtifactCount: expectedArtifacts.size,
      planningFileCount: listPlanningFiles(context.planningDir, { maxDepth: 6 }).length,
    },
  };
}

module.exports = {
  id: 'presence-census',
  run,
  buildExpectedArtifacts,
  countPlaceholders,
  looksTruncated,
  STRICT_PLACEHOLDER_PATTERNS,
  CONTEXTUAL_PLACEHOLDER_PATTERNS,
};
