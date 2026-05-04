#!/usr/bin/env node

// CoBolt PRD Validator — Deterministic 8-dimension PRD validation
//
// Handles 8 of 13 validation dimensions deterministically (no LLM needed).
// Remaining 5 dimensions (measurability, SMART, holistic quality, etc.) stay LLM.
//
// Dimensions:
//   V1  Format detection — heading structure, required sections
//   V3  Density — word counts per section, min thresholds
//   V6  Traceability — FR/NFR ID counting, sequencing, duplicates
//   V7  Implementation leakage — tech keywords in requirements prose
//   V8  Domain compliance — cross-ref domain-complexity.csv
//   V9  Project type validation — cross-ref project-types.csv
//   V12 Completeness — section presence with min word counts
//   V13 Acceptance Criteria Testability — vague vs measurable criteria
//
// Usage:
//   node tools/cobolt-validate-prd.js check [--prd <path>]  # Run all 7 checks
//   node tools/cobolt-validate-prd.js check --json           # Machine-readable output
//   node tools/cobolt-validate-prd.js score [--prd <path>]   # Partial score only
//
// Exit codes:
//   0 = all dimensions pass (score >= 7.0 average)
//   1 = one or more dimensions fail (score < 5.0)
//   2 = usage error or file not found

const fs = require('node:fs');
const path = require('node:path');
const { getPlanningDir } = require('../lib/cobolt-planning-artifacts');
const { runCheck: runSourceCoverageCheck } = require('./cobolt-source-coverage');

// ── Path Resolution ─────────────────────────────────────────

function planningDir() {
  return getPlanningDir(process.cwd(), { create: true });
}

function readJsonIfExists(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readTextIfExists(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function planningDirForPrd(prdPath) {
  if (prdPath) {
    const dir = path.dirname(path.resolve(prdPath));
    if (path.basename(dir).toLowerCase() === 'planning') return dir;
  }
  return planningDir();
}

function normalizeRequirementId(value) {
  return String(value || '')
    .trim()
    .replace(/\*\*/g, '')
    .toUpperCase();
}

function normalizeRequirementLookupId(value) {
  const normalized = normalizeRequirementId(value).replace(/_/g, '-');
  return normalized
    .split('-')
    .filter(Boolean)
    .map((part, index) => {
      if (index === 0) return part;
      if (/^\d+$/.test(part)) return String(parseInt(part, 10));
      return part;
    })
    .join('-');
}

// ── Data Loading ────────────────────────────────────────────

function loadCsv(filename) {
  const candidates = [
    path.join(__dirname, '..', 'source', 'skills', 'cobolt-create-prd', 'data', filename),
    path.join(__dirname, '..', '.claude', 'cobolt', 'skills', 'cobolt-create-prd', 'data', filename),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      const lines = fs.readFileSync(c, 'utf8').trim().split('\n');
      const headers = lines[0].split(',').map((h) => h.trim());
      return lines
        .slice(1)
        .filter((l) => l.trim())
        .map((line) => {
          const vals = [];
          let current = '';
          let inQuote = false;
          for (const ch of line) {
            if (ch === '"') {
              inQuote = !inQuote;
              continue;
            }
            if (ch === ',' && !inQuote) {
              vals.push(current.trim());
              current = '';
              continue;
            }
            current += ch;
          }
          vals.push(current.trim());
          const row = {};
          headers.forEach((h, i) => {
            row[h] = vals[i] || '';
          });
          return row;
        });
    }
  }
  return [];
}

// ── Section Parser ──────────────────────────────────────────

const NAMED_COMPLIANCE_FRAMEWORK_RE =
  /\b(soc\s*2|soc2|gdpr|dpdp|hipaa|pci(?:[-\s]?dss)?|iso\s*27001|fedramp|ccpa|cpra)\b/i;
const REGULATED_DATA_SIGNAL_RE =
  /\b(eu personal data|personal data|data subject|protected health information|phi\b|payment card|cardholder data|financial records?|children|minor users?|government data|biometric data)\b/i;

function addSecurityScopeFindings(content, findings) {
  if (NAMED_COMPLIANCE_FRAMEWORK_RE.test(content)) {
    findings.push(
      'Named compliance framework detected - treat related controls as strict planning/build/release scope',
    );
    return 0;
  }
  if (REGULATED_DATA_SIGNAL_RE.test(content)) {
    findings.push(
      'Regulated-data signal detected but no named compliance framework is captured - clarify scope before build authorization',
    );
    return 1.5;
  }
  findings.push('No named compliance framework captured - baseline security and coding standards still apply');
  return 0;
}

function parseSections(content) {
  const sections = [];
  const lines = content.split('\n');
  let current = null;

  for (const line of lines) {
    const heading = line.match(/^(#{1,4})\s+(.+)/);
    if (heading) {
      if (current) sections.push(current);
      current = {
        level: heading[1].length,
        title: heading[2].trim(),
        content: '',
        wordCount: 0,
      };
      continue;
    }
    if (current) {
      current.content += `${line}\n`;
    }
  }
  if (current) sections.push(current);

  // Compute word counts
  for (const s of sections) {
    s.wordCount = s.content.split(/\s+/).filter((w) => w.length > 0).length;
  }
  return sections;
}

// ── V1: Format Detection ────────────────────────────────────

const REQUIRED_SECTIONS = [
  { pattern: /functional\s+requirements/i, name: 'Functional Requirements', minLevel: 2 },
  { pattern: /non[- ]?functional\s+requirements/i, name: 'Non-Functional Requirements', minLevel: 2 },
  { pattern: /user\s+(stories|journeys|personas)/i, name: 'User Stories/Journeys', minLevel: 2 },
  { pattern: /scope/i, name: 'Scope', minLevel: 2 },
  { pattern: /overview|introduction|summary|vision/i, name: 'Overview/Introduction', minLevel: 1 },
];

const RECOMMENDED_SECTIONS = [
  { pattern: /constraints|assumptions/i, name: 'Constraints/Assumptions' },
  { pattern: /success\s+(metrics|criteria)/i, name: 'Success Metrics' },
  { pattern: /glossary|definitions/i, name: 'Glossary' },
  { pattern: /out\s+of\s+scope|exclusions/i, name: 'Out of Scope' },
];

function v1FormatDetection(sections) {
  const findings = [];
  let score = 10;

  // Check required sections
  for (const req of REQUIRED_SECTIONS) {
    const found = sections.find((s) => req.pattern.test(s.title) && s.level <= req.minLevel + 1);
    if (!found) {
      findings.push(`MISSING required section: ${req.name}`);
      score -= 2;
    }
  }

  // Check recommended sections (minor deductions)
  for (const rec of RECOMMENDED_SECTIONS) {
    const found = sections.find((s) => rec.pattern.test(s.title));
    if (!found) {
      findings.push(`RECOMMENDED section missing: ${rec.name}`);
      score -= 0.5;
    }
  }

  // Check heading hierarchy (no h4 without h3 parent, etc.)
  let prevLevel = 0;
  for (const s of sections) {
    if (s.level > prevLevel + 1) {
      findings.push(`Heading skip: "${s.title}" is h${s.level} after h${prevLevel}`);
      score -= 0.5;
    }
    prevLevel = s.level;
  }

  return { dimension: 'V1', name: 'Format Detection', score: Math.max(0, score), findings };
}

// ── V3: Density ─────────────────────────────────────────────

const DENSITY_THRESHOLDS = {
  'Functional Requirements': 200,
  'Non-Functional Requirements': 100,
  'User Stories/Journeys': 150,
  Scope: 50,
  'Overview/Introduction': 50,
};

function v3Density(sections, totalWords) {
  const findings = [];
  let score = 10;

  // v0.18+ hard bounds (symmetric): v3 previously only penalized sparse docs;
  // over-sprawling 20K+ word PRDs slipped through as passed with trivial score
  // hit. Both directions now fail the dimension.
  const DENSITY_CATASTROPHIC_MIN = 300;
  const DENSITY_SPRAWL_WARN = 15000;
  const DENSITY_SPRAWL_HARD = 25000;

  // Total document density
  if (totalWords < DENSITY_CATASTROPHIC_MIN) {
    findings.push(
      `HARD FAIL: Document critically sparse: ${totalWords} words (<${DENSITY_CATASTROPHIC_MIN}). Treat as no PRD.`,
    );
    score = 0;
  } else if (totalWords < 500) {
    findings.push(`Document too sparse: ${totalWords} words (min 500)`);
    score -= 4;
  } else if (totalWords < 1000) {
    findings.push(`Document light: ${totalWords} words (recommended 1000+)`);
    score -= 2;
  }
  if (totalWords > DENSITY_SPRAWL_HARD) {
    findings.push(
      `HARD FAIL: Document sprawl: ${totalWords} words (>${DENSITY_SPRAWL_HARD}). Split the PRD or move detail to TRD/architecture.`,
    );
    score = 0;
  } else if (totalWords > DENSITY_SPRAWL_WARN) {
    findings.push(`Document sprawl: ${totalWords} words (>${DENSITY_SPRAWL_WARN} suggests scope creep)`);
    score -= 3;
  }

  // Per-section density
  for (const [sectionPattern, minWords] of Object.entries(DENSITY_THRESHOLDS)) {
    const sectionIdx = sections.findIndex((s) => {
      const pat = sectionPattern.replace(/\//g, '|').replace(/\s+/g, '\\s+');
      return new RegExp(pat, 'i').test(s.title);
    });
    if (sectionIdx === -1) continue;
    const section = sections[sectionIdx];
    if (section.wordCount >= minWords) continue;

    // v0.40.1 — density check must consider subsections. A "Functional
    // Requirements" h2 can legitimately have a short intro paragraph followed
    // by 40+ h3 FR subsections that each carry substantive content. Previously
    // this triggered a density warning against the section's 46-word intro
    // even though the FR payload summed to 10K+ words. Now we roll up
    // descendant subsection words and only flag the section as sparse if the
    // aggregate is below threshold.
    let aggregate = section.wordCount;
    let descendantCount = 0;
    for (let i = sectionIdx + 1; i < sections.length; i++) {
      const peer = sections[i];
      if (peer.level <= section.level) break;
      aggregate += peer.wordCount;
      descendantCount += 1;
    }
    if (aggregate >= minWords) continue; // content lives in subsections — pass
    if (descendantCount >= 3) {
      // Has substantive subsection tree but aggregate still below threshold
      findings.push(
        `Section "${section.title}" aggregate ${aggregate} words across ${descendantCount} subsections (min ${minWords})`,
      );
    } else {
      findings.push(`Section "${section.title}" has ${section.wordCount} words (min ${minWords})`);
    }
    score -= 1;
  }

  // Check for stub sections (< 10 words)
  const stubs = sections.filter((s) => s.level >= 2 && s.wordCount < 10 && s.wordCount > 0);
  if (stubs.length > 0) {
    findings.push(`${stubs.length} stub sections with < 10 words: ${stubs.map((s) => s.title).join(', ')}`);
    score -= stubs.length * 0.5;
  }

  return { dimension: 'V3', name: 'Density', score: Math.max(0, score), findings };
}

// ── V6: Traceability ────────────────────────────────────────

function collectDeclaredFrIds(content) {
  const declarationPattern = /^(?:#{2,4}\s+|\s*[-*]\s+)(?:\*\*)?(FR-(?:[A-Z]{2,5}-)?\d{1,4})(?:\*\*)?\b/gm;
  return [...content.matchAll(declarationPattern)].map((match) => normalizeRequirementId(match[1]));
}

function hasLargeScopeDecomposition(prdPath, prdFrIdsOrCount) {
  const dir = planningDirForPrd(prdPath);
  const bounded = readJsonIfExists(path.join(dir, 'bounded-contexts.json'));
  const milestones = readJsonIfExists(path.join(dir, 'milestone-tracker.json'));
  const storyTracker = readJsonIfExists(path.join(dir, 'story-tracker.json'));
  const prdFrIds =
    prdFrIdsOrCount instanceof Set
      ? new Set([...prdFrIdsOrCount].map(normalizeRequirementLookupId))
      : Array.isArray(prdFrIdsOrCount)
        ? new Set(prdFrIdsOrCount.map(normalizeRequirementLookupId))
        : null;
  const frCount = prdFrIds ? prdFrIds.size : Number(prdFrIdsOrCount || 0);

  const boundedContexts = Array.isArray(bounded?.boundedContexts)
    ? bounded.boundedContexts
    : Array.isArray(bounded?.contexts)
      ? bounded.contexts
      : [];
  const milestoneList = Array.isArray(milestones?.milestones) ? milestones.milestones : [];
  const stories = Array.isArray(storyTracker?.stories) ? storyTracker.stories : [];
  const storyFrIds = new Set();
  for (const story of stories) {
    for (const id of [...(story.frIds || []), ...(story.requirementIds || [])]) {
      const normalized = normalizeRequirementId(id);
      if (/^FR-/.test(normalized)) storyFrIds.add(normalizeRequirementLookupId(normalized));
    }
  }
  const matchingStoryFrIds = prdFrIds ? new Set([...storyFrIds].filter((id) => prdFrIds.has(id))) : storyFrIds;
  const coverage = frCount > 0 ? matchingStoryFrIds.size / frCount : 0;

  return {
    ok: boundedContexts.length > 0 && milestoneList.length > 1 && coverage >= 0.85,
    boundedContextCount: boundedContexts.length,
    milestoneCount: milestoneList.length,
    storyFrCount: matchingStoryFrIds.size,
    totalStoryFrCount: storyFrIds.size,
    coverage,
  };
}

function v6Traceability(content, options = {}) {
  const findings = [];
  let score = 10;

  // Extract all requirement IDs (canonical FR-001 and domain-prefixed FR-IM-01).
  // Any-occurrence match is used only for "does the ID appear anywhere" checks.
  const frRawIds = [...content.matchAll(/\bFR-(?:[A-Z]{2,5}-)?\d{1,4}\b/g)].map((m) => m[0]);
  const nfrRawIds = [...content.matchAll(/\bNFR-(?:[A-Z]{2,5}-)?\d{1,4}\b/g)].map((m) => m[0]);
  const trailingNum = (id) => parseInt(id.match(/(\d+)$/)?.[1] || '0', 10);
  const frIds = frRawIds.map(trailingNum);
  const nfrIds = nfrRawIds.map(trailingNum);

  // Heading-level IDs only: FRs and NFRs declared as ## / ### / #### headings.
  // Duplicate detection must run against these — cross-references in acceptance
  // criteria and success metrics (e.g. "see FR-001") legitimately reuse the ID
  // many times in body text and must not be flagged as duplicate declarations.
  const frHeadingIds = [...content.matchAll(/^#{2,4}\s+(FR-(?:[A-Z]{2,5}-)?\d{1,4})\b/gm)].map((m) => m[1]);
  const nfrHeadingIds = [...content.matchAll(/^#{2,4}\s+(NFR-(?:[A-Z]{2,5}-)?\d{1,4})\b/gm)].map((m) => m[1]);

  if (frIds.length === 0) {
    findings.push('No FR-NNN identifiers found');
    score -= 5;
  }
  if (nfrIds.length === 0) {
    findings.push('No NFR-NNN identifiers found');
    score -= 3;
  }

  // Check for duplicates against heading-level declarations only.
  const frUniqueHeading = [...new Set(frHeadingIds)];
  if (frUniqueHeading.length < frHeadingIds.length) {
    const dupes = frHeadingIds.filter((id, i) => frHeadingIds.indexOf(id) !== i);
    findings.push(`Duplicate FR IDs: ${[...new Set(dupes)].join(', ')}`);
    score -= 1;
  }
  const nfrUniqueHeading = [...new Set(nfrHeadingIds)];
  if (nfrUniqueHeading.length < nfrHeadingIds.length) {
    const dupes = nfrHeadingIds.filter((id, i) => nfrHeadingIds.indexOf(id) !== i);
    findings.push(`Duplicate NFR IDs: ${[...new Set(dupes)].join(', ')}`);
    score -= 1;
  }
  // Sequential-numbering and hard-bound checks key off heading declarations so
  // they match authorial intent; fall back to any-occurrence counts if no
  // headings are detected (older PRDs written as flat tables).
  const frDeclaredIds = collectDeclaredFrIds(content);
  const frTraceIds =
    frHeadingIds.length > 0
      ? frHeadingIds.map(normalizeRequirementId)
      : frDeclaredIds.length > 0
        ? frDeclaredIds
        : frRawIds;
  const frUnique = [...new Set(frTraceIds.map(trailingNum))];
  const frUniqueIdSet = new Set(frTraceIds.map(normalizeRequirementId));
  const nfrUnique = nfrHeadingIds.length > 0 ? [...new Set(nfrHeadingIds.map(trailingNum))] : [...new Set(nfrIds)];

  // Check sequential numbering (gaps are warnings, not errors)
  if (frUnique.length > 0) {
    const sorted = frUnique.sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] !== sorted[i - 1] + 1) {
        for (let g = sorted[i - 1] + 1; g < sorted[i]; g++) gaps.push(g);
      }
    }
    if (gaps.length > 0) {
      findings.push(`FR numbering gaps: FR-${gaps.join(', FR-')}`);
      score -= 0.5;
    }
    // Check starts from 001
    if (sorted[0] !== 1) {
      findings.push(`FR numbering doesn't start at 1 (starts at ${sorted[0]})`);
      score -= 0.5;
    }
  }

  // v0.18+ hard bound: requirement-count explosion is a PRD smell.
  // 100+ FRs means the scope is unplanned or the PRD is a feature dump.
  const FR_HARD_MAX = 100;
  const NFR_HARD_MAX = 50;
  const largeScopeDecomposition =
    frUnique.length > FR_HARD_MAX ? hasLargeScopeDecomposition(options.prdPath, frUniqueIdSet) : null;
  if (frUnique.length > FR_HARD_MAX && !largeScopeDecomposition?.ok) {
    findings.push(
      `HARD FAIL: ${frUnique.length} FRs (>${FR_HARD_MAX}). Requirement explosion — split the PRD per bounded context or per release tier.`,
    );
    score = 0;
  }
  if (frUnique.length > FR_HARD_MAX && largeScopeDecomposition?.ok) {
    findings.push(
      `Large scope (${frUnique.length} FRs) is decomposed into ${largeScopeDecomposition.boundedContextCount} bounded context(s), ${largeScopeDecomposition.milestoneCount} milestone(s), and story coverage for ${largeScopeDecomposition.storyFrCount}/${frUnique.length} FRs.`,
    );
    score -= 0.5;
  }
  if (nfrUnique.length > NFR_HARD_MAX) {
    findings.push(
      `HARD FAIL: ${nfrUnique.length} NFRs (>${NFR_HARD_MAX}). Consolidate NFRs into TRD or per-milestone quality gates.`,
    );
    score = 0;
  }

  // Summary
  findings.unshift(`Found ${frUnique.length} FRs and ${nfrUnique.length} NFRs`);

  return { dimension: 'V6', name: 'Traceability', score: Math.max(0, score), findings };
}

// ── V7: Implementation Leakage ──────────────────────────────

const LEAKAGE_KEYWORDS = [
  // Frameworks/libraries (should not appear in requirements)
  /\b(React|Vue|Angular|Next\.js|Express|Django|Flask|Spring Boot|Rails|Laravel)\b/g,
  // Databases
  /\b(PostgreSQL|MySQL|MongoDB|Redis|SQLite|DynamoDB|Supabase)\b/g,
  // Infrastructure
  /\b(Docker|Kubernetes|AWS|GCP|Azure|Vercel|Netlify|Heroku)\b/g,
  // Implementation details
  /\b(REST API|GraphQL|gRPC|WebSocket|MQTT)\b/g,
  // Code patterns
  /\b(class|function|import|require|module|interface|endpoint|middleware)\b/g,
  // File extensions
  /\.(tsx?|jsx?|py|go|rs|ex|rb)\b/g,
];

// Sections where tech terms are expected (excluded from scan)
const LEAKAGE_EXCLUDED_SECTIONS =
  /tech(nical)?\s+(stack|requirements|constraints)|architecture|implementation\s+notes/i;

function v7ImplementationLeakage(sections) {
  const findings = [];
  let score = 10;
  let totalLeaks = 0;

  for (const section of sections) {
    // Skip sections where tech terms are expected
    if (LEAKAGE_EXCLUDED_SECTIONS.test(section.title)) continue;
    // Only check requirement-prose sections
    if (!/requirements|stories|journeys|scope|overview|features/i.test(section.title)) continue;

    for (const pattern of LEAKAGE_KEYWORDS) {
      pattern.lastIndex = 0;
      const matches = [...section.content.matchAll(pattern)];
      if (matches.length > 0) {
        const unique = [...new Set(matches.map((m) => m[0]))];
        findings.push(`Section "${section.title}": tech leakage — ${unique.join(', ')}`);
        totalLeaks += unique.length;
      }
    }
  }

  // v0.18+ hard bound: previously max penalty was -4, so v7 could never score
  // below 6 regardless of leakage volume. With 50+ leaked tech terms the PRD
  // passed as WARN. Add catastrophic-leakage hard fail.
  const LEAKAGE_HARD_LIMIT = 20;
  if (totalLeaks > LEAKAGE_HARD_LIMIT) {
    findings.push(
      `HARD FAIL: ${totalLeaks} tech-leakage references (>${LEAKAGE_HARD_LIMIT}). PRD is describing an implementation, not a product.`,
    );
    score = 0;
  } else if (totalLeaks > 10) score -= 4;
  else if (totalLeaks > 5) score -= 2;
  else if (totalLeaks > 0) score -= 1;

  if (totalLeaks === 0) findings.push('No implementation leakage detected');

  return { dimension: 'V7', name: 'Implementation Leakage', score: Math.max(0, score), findings };
}

// ── V8: Domain Compliance ───────────────────────────────────

function v8DomainCompliance(content) {
  const findings = [];
  let score = 10;
  score -= addSecurityScopeFindings(content, findings);

  const domains = loadCsv('domain-complexity.csv');
  if (domains.length === 0) {
    findings.push('domain-complexity.csv not found — skipping domain validation');
    return { dimension: 'V8', name: 'Domain Compliance', score: 8, findings };
  }

  // Detect which domain(s) the PRD falls into
  const contentLower = content.toLowerCase();
  const detected = [];
  for (const d of domains) {
    const signals = (d.detection_signals || d.signals || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const matchCount = signals.filter((s) => contentLower.includes(s)).length;
    if (matchCount >= 2) {
      detected.push({ ...d, matchCount });
    }
  }

  if (detected.length === 0) {
    findings.push('No specific domain detected — generic PRD');
    score -= 1;
  } else {
    for (const d of detected) {
      const concerns = (d.typical_concerns || d.concerns || '')
        .split(',')
        .map((c) => c.trim().toLowerCase())
        .filter(Boolean);
      const addressed = concerns.filter((c) => contentLower.includes(c));
      const missing = concerns.filter((c) => !contentLower.includes(c));
      const coverage = concerns.length > 0 ? ((addressed.length / concerns.length) * 100).toFixed(0) : 100;
      findings.push(
        `Domain "${d.domain_type || d.project_type}": ${coverage}% concern coverage (${addressed.length}/${concerns.length})`,
      );
      if (missing.length > 0) {
        findings.push(`  Missing concerns: ${missing.join(', ')}`);
        score -= Math.min(3, missing.length * 0.5);
      }
    }
  }

  return { dimension: 'V8', name: 'Domain Compliance', score: Math.max(0, score), findings };
}

// ── V9: Project Type Validation ─────────────────────────────

function v9ProjectType(content) {
  const findings = [];
  let score = 10;

  const types = loadCsv('project-types.csv');
  if (types.length === 0) {
    findings.push('project-types.csv not found — skipping project type validation');
    return { dimension: 'V9', name: 'Project Type', score: 8, findings };
  }

  const contentLower = content.toLowerCase();
  const detected = [];
  for (const t of types) {
    const signals = (t.detection_signals || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const matchCount = signals.filter((s) => contentLower.includes(s)).length;
    if (matchCount >= 2) {
      detected.push({ type: t.project_type, matchCount, concerns: t.typical_concerns || '' });
    }
  }

  if (detected.length === 0) {
    findings.push('No standard project type detected');
    score -= 1;
  } else {
    const primary = detected.sort((a, b) => b.matchCount - a.matchCount)[0];
    findings.push(`Detected project type: ${primary.type} (${primary.matchCount} signals)`);

    // Check if typical concerns are addressed
    const concerns = primary.concerns
      .split(',')
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean);
    const missing = concerns.filter((c) => !contentLower.includes(c));

    if (missing.length > 0) {
      findings.push(`Missing typical concerns for ${primary.type}: ${missing.join(', ')}`);
      score -= Math.min(3, missing.length * 0.5);
    }
    if (detected.length > 1) {
      findings.push(
        `Also detected: ${detected
          .slice(1)
          .map((d) => d.type)
          .join(', ')}`,
      );
    }
  }

  return { dimension: 'V9', name: 'Project Type', score: Math.max(0, score), findings };
}

// ── V12: Completeness ───────────────────────────────────────

const COMPLETENESS_CHECKS = [
  { pattern: /functional\s+requirements/i, minWords: 200, required: true },
  { pattern: /non[- ]?functional/i, minWords: 100, required: true },
  { pattern: /user\s+(stories|journeys)/i, minWords: 100, required: true },
  { pattern: /scope/i, minWords: 50, required: true },
  { pattern: /success\s+(metrics|criteria)/i, minWords: 30, required: false },
  { pattern: /constraints|assumptions/i, minWords: 30, required: false },
  { pattern: /glossary/i, minWords: 20, required: false },
];

function v12Completeness(sections) {
  const findings = [];
  let score = 10;
  let requiredPresent = 0;
  let requiredTotal = 0;

  for (const check of COMPLETENESS_CHECKS) {
    const sectionIdx = sections.findIndex((s) => check.pattern.test(s.title));
    const section = sectionIdx === -1 ? null : sections[sectionIdx];
    if (check.required) requiredTotal++;

    if (!section) {
      if (check.required) {
        findings.push(`MISSING required section matching: ${check.pattern}`);
        score -= 2;
      }
      continue;
    }

    // v0.40.1 — roll up descendant subsection word counts so a section
    // composed of many h3 subsections (e.g. FR-001..FR-044) is measured by
    // its aggregate content, not its short intro paragraph.
    let aggregateWords = section.wordCount;
    for (let i = sectionIdx + 1; i < sections.length; i++) {
      const peer = sections[i];
      if (peer.level <= section.level) break;
      aggregateWords += peer.wordCount;
    }

    if (aggregateWords < check.minWords) {
      findings.push(`Section "${section.title}" incomplete: ${aggregateWords}/${check.minWords} words`);
      score -= 1;
      if (check.required) requiredPresent++; // Present but thin
    } else {
      if (check.required) requiredPresent++;
    }
  }

  findings.unshift(`Required sections: ${requiredPresent}/${requiredTotal} present`);

  return { dimension: 'V12', name: 'Completeness', score: Math.max(0, score), findings };
}

// ── V13: Acceptance Criteria Testability ────────────────────

const VAGUE_PATTERNS = [
  { pattern: /\bworks?\b/i, issue: 'VAGUE_WORKS' },
  { pattern: /\bsecure\b/i, issue: 'VAGUE_SECURE' },
  { pattern: /\bfast\b/i, issue: 'VAGUE_FAST' },
  { pattern: /\breliable\b/i, issue: 'VAGUE_RELIABLE' },
  { pattern: /\buser[- ]friendly\b/i, issue: 'VAGUE_UX' },
  { pattern: /\bappropriate\b/i, issue: 'VAGUE_APPROPRIATE' },
  { pattern: /\bproperly\b/i, issue: 'VAGUE_PROPERLY' },
];

const MEASURABLE_PATTERNS = [
  /\b\d+\s*(ms|seconds?|minutes?|%|MB|KB|req\/s)\b/i,
  /\bgiven\b.*\bwhen\b.*\bthen\b/is,
  /\bstatus\s*(code\s*)?\d{3}\b/i,
  /\b(returns?|responds?|displays?|shows?|renders?)\b/i,
  /\berror\s*(message|code|response)\b/i,
];

function extractAcceptanceCriteriaSection(markdown) {
  const match = String(markdown || '').match(/^#{2,4}\s*Acceptance\s*Criteria\b.*$/im);
  if (!match) return [];
  const after = String(markdown).slice(match.index + match[0].length);
  const section = after.split(/\n#{1,4}\s+/)[0] || '';
  return section
    .split('\n')
    .filter((line) => /^\s*[-*]\s+/.test(line))
    .map((line) => line.replace(/^\s*[-*]\s+/, '').trim())
    .filter(Boolean);
}

function criterionReferencesRequirement(criterion, requirementId) {
  const normalizedRequirementId = normalizeRequirementLookupId(requirementId);
  const references = String(criterion || '').match(/\bFR-(?:[A-Z]{2,5}-)?\d{1,4}\b/gi) || [];
  return references.some((reference) => normalizeRequirementLookupId(reference) === normalizedRequirementId);
}

function collectSidecarAcceptanceCriteria(prdPath, allowedRequirementIds = null) {
  const dir = planningDirForPrd(prdPath);
  const storyTracker = readJsonIfExists(path.join(dir, 'story-tracker.json'));
  const stories = Array.isArray(storyTracker?.stories) ? storyTracker.stories : [];
  const byRequirement = new Map();
  const allowed =
    allowedRequirementIds instanceof Set
      ? new Set([...allowedRequirementIds].map(normalizeRequirementLookupId))
      : Array.isArray(allowedRequirementIds)
        ? new Set(allowedRequirementIds.map(normalizeRequirementLookupId))
        : null;

  for (const story of stories) {
    const storyFile = story.storyFile ? path.join(dir, story.storyFile) : null;
    const criteria = extractAcceptanceCriteriaSection(readTextIfExists(storyFile));
    if (criteria.length === 0) continue;

    for (const id of [...(story.frIds || []), ...(story.requirementIds || [])]) {
      const normalized = normalizeRequirementId(id);
      const lookupId = normalizeRequirementLookupId(normalized);
      if (!/^FR-/.test(normalized)) continue;
      if (allowed && !allowed.has(lookupId)) continue;
      const directCriteria = criteria.filter((criterion) => criterionReferencesRequirement(criterion, lookupId));
      if (directCriteria.length === 0) continue;
      const existing = byRequirement.get(lookupId) || [];
      byRequirement.set(lookupId, [...existing, ...directCriteria]);
    }
  }

  return byRequirement;
}

function validateAcceptanceCriteria(prdContent, options = {}) {
  // Extract FR blocks by finding markdown FR headings across common heading levels.
  const frPattern =
    /^(?:#{2,4}\s+(?:\*\*)?(FR-?(?:[A-Z]{2,5}-)?\d{1,4})(?:\*\*)?[^\n]*|\s*[-*]\s+(?:\*\*)?(FR-?(?:[A-Z]{2,5}-)?\d{1,4})(?:\*\*)?\s*(?::|[-–—])\s*[^\n]*)/gm;
  const frBlocks = [];
  const frBlocksByLookup = new Map();
  let match;
  while ((match = frPattern.exec(prdContent)) !== null) {
    const id = normalizeRequirementId(match[1] || match[2]);
    const lookupId = normalizeRequirementLookupId(id);
    const block = { id, lookupId, index: match.index };
    if (!frBlocksByLookup.has(lookupId)) frBlocksByLookup.set(lookupId, block);
    frBlocks.push(block);
  }
  const frBlockIds = new Set(frBlocks.map((block) => block.id));
  const sidecarScope = options.prdPath ? hasLargeScopeDecomposition(options.prdPath, frBlockIds) : { ok: false };
  const sidecarCriteria = sidecarScope.ok ? collectSidecarAcceptanceCriteria(options.prdPath, frBlockIds) : new Map();
  const criteriaByRequirement = new Map([...frBlocksByLookup.values()].map((block) => [block.lookupId, []]));

  let untestable = 0;
  let noCriteria = 0;
  let totalCriteria = 0;

  function addCriteria(requirementId, criteria) {
    if (!requirementId || !Array.isArray(criteria) || criteria.length === 0) return;
    const lookupId = normalizeRequirementLookupId(requirementId);
    const existing = criteriaByRequirement.get(lookupId) || [];
    criteriaByRequirement.set(lookupId, [...existing, ...criteria]);
  }

  for (let i = 0; i < frBlocks.length; i++) {
    const blockStart = frBlocks[i].index;
    const blockEnd = i < frBlocks.length - 1 ? frBlocks[i + 1].index : prdContent.length;
    const block = prdContent.substring(blockStart, blockEnd);

    // Accept both canonical and inline AC formats:
    //   1. Heading: `### Acceptance Criteria` followed by bulleted list
    //   2. Inline bullet: `- **Acceptance Criteria**: (a) ... (b) ... (c) ...`
    //   3. Inline bullet: `- **Acceptance Criteria**:` followed by sub-bullets
    let criteria = [];

    const headingMatch = block.match(/###\s*Acceptance\s*Criteria/i);
    if (headingMatch) {
      const acSection = block.substring(headingMatch.index + headingMatch[0].length);
      criteria = acSection
        .split('\n')
        .filter((l) => /^\s*[-*]\s+/.test(l))
        .map((l) => l.replace(/^\s*[-*]\s+/, '').trim())
        .filter(Boolean);
    } else {
      // Inline bullet format — `- **Acceptance Criteria**:` or `* Acceptance Criteria:`
      const inlineMatch = block.match(/^\s*[-*]\s+\*{0,2}Acceptance\s*Criteria\*{0,2}\s*:?\s*(.*)$/im);
      if (inlineMatch) {
        const rest = inlineMatch[1] || '';
        // Parse lettered items `(a) ... (b) ... (c) ...` or numbered `(1) ... (2) ...`
        const lettered = rest.match(/\([a-z0-9]+\)\s+[^()]+/gi);
        if (lettered && lettered.length > 0) {
          criteria = lettered.map((c) => c.replace(/^\([a-z0-9]+\)\s+/i, '').trim()).filter(Boolean);
        } else if (rest.trim().length > 10) {
          // Single inline sentence — count as one criterion.
          criteria = [rest.trim()];
        }
        // If no inline content, look for sub-bullets after the line.
        if (criteria.length === 0) {
          const afterIdx = block.indexOf(inlineMatch[0]) + inlineMatch[0].length;
          const subSection = block.substring(afterIdx);
          criteria = subSection
            .split('\n')
            .slice(0, 20) // cap scan
            .filter((l) => /^\s{2,}[-*]\s+/.test(l))
            .map((l) => l.replace(/^\s+[-*]\s+/, '').trim())
            .filter(Boolean);
        }
      }
    }

    if (criteria.length === 0) {
      const sidecar = sidecarCriteria.get(frBlocks[i].lookupId);
      if (sidecar?.length > 0) {
        criteria = sidecar;
      }
    }

    addCriteria(frBlocks[i].id, criteria);
  }

  for (const id of criteriaByRequirement.keys()) {
    const criteria = [
      ...new Set((criteriaByRequirement.get(id) || []).map((criterion) => criterion.trim()).filter(Boolean)),
    ];
    if (criteria.length === 0) {
      noCriteria++;
      continue;
    }
    totalCriteria += criteria.length;

    for (const criterion of criteria) {
      const vagueMatches = VAGUE_PATTERNS.filter((p) => p.pattern.test(criterion));
      const measurableMatches = MEASURABLE_PATTERNS.filter((p) => p.test(criterion));
      if (vagueMatches.length > 0 && measurableMatches.length === 0) {
        untestable++;
      }
    }
  }

  // v0.29: close the vacuous-pass bug. Previous branch returned score=10 when
  // frBlocks.length===0, treating "no FRs parsed" as "comprehensive requirements".
  // Meru PRD shipped with 0 FR identifiers detected AND V13 scored 10 — that is
  // not a pass, it's a detector miss. Zero FRs is a content-quality failure.
  const score = totalCriteria > 0 ? Math.max(0, 10 - untestable * 2 - noCriteria * 4) : 0; // both "FRs without criteria" and "no FRs detected" fail V13
  const findings = [
    `FRs reviewed: ${criteriaByRequirement.size}`,
    `Acceptance criteria bullets: ${totalCriteria}`,
    `Untestable criteria: ${untestable}`,
    `Requirements missing acceptance criteria: ${noCriteria}`,
  ];

  return {
    dimension: 'V13',
    name: 'Acceptance Criteria Testability',
    score,
    findings,
    totalFRs: criteriaByRequirement.size,
    totalCriteria,
    untestable,
    noCriteria,
  };
}

// ── Main Check ──────────────────────────────────────────────

function v14SourceDocumentCoverage(prdPath) {
  const { result, error } = runSourceCoverageCheck({ threshold: 95, targetFile: prdPath });
  if (error) {
    return {
      dimension: 'V14',
      name: 'Source Document Coverage',
      score: 0,
      findings: [error],
      skipped: false,
    };
  }

  if (!result || result.skipped) {
    return {
      dimension: 'V14',
      name: 'Source Document Coverage',
      score: 10,
      findings: [`Skipped - ${result?.reason || 'no source document packet was required'}`],
      skipped: true,
    };
  }

  let score = 0;
  if (result.coverage >= 100) score = 10;
  else if (result.coverage >= 95) score = 8;
  else if (result.coverage >= 90) score = 6;
  else if (result.coverage >= 80) score = 4;

  const findings = [
    `Coverage: ${result.coverage}% (threshold ${result.threshold}%)`,
    `Matched requirements: ${result.matchedRequirements}/${result.includedRequirements}`,
  ];
  if (result.reason) {
    findings.push(result.reason);
  }
  if (Array.isArray(result.issues)) {
    for (const issue of result.issues) {
      findings.push(issue);
    }
  }
  for (const entry of (result.unmatched || []).slice(0, 5)) {
    findings.push(`Missing source requirement: ${entry.id} ${entry.summary}`);
  }
  if ((result.unmatched || []).length > 5) {
    findings.push(`... ${(result.unmatched || []).length - 5} additional source requirements are missing`);
  }

  return {
    dimension: 'V14',
    name: 'Source Document Coverage',
    score,
    findings,
    skipped: false,
    coverage: result.coverage,
    threshold: result.threshold,
    unmatchedRequirements: result.unmatchedRequirements,
  };
}

function runChecks(prdPath) {
  if (!fs.existsSync(prdPath)) {
    console.error(`[cobolt-validate-prd] File not found: ${prdPath}`);
    process.exit(2);
  }

  const content = fs.readFileSync(prdPath, 'utf8');
  const sections = parseSections(content);
  const totalWords = content.split(/\s+/).filter((w) => w.length > 0).length;

  const results = [
    v1FormatDetection(sections),
    v3Density(sections, totalWords),
    v6Traceability(content, { prdPath }),
    v7ImplementationLeakage(sections),
    v8DomainCompliance(content),
    v9ProjectType(content),
    v12Completeness(sections),
    validateAcceptanceCriteria(content, { prdPath }),
    v14SourceDocumentCoverage(prdPath),
  ];

  const activeResults = results.filter((result) => result.skipped !== true);
  const avgScore =
    activeResults.length > 0 ? activeResults.reduce((sum, result) => sum + result.score, 0) / activeResults.length : 0;
  const failedDims = activeResults.filter((result) => result.score < 5);

  return {
    prdPath,
    totalWords,
    sectionCount: sections.length,
    dimensions: results,
    averageScore: Math.round(avgScore * 10) / 10,
    passed: failedDims.length === 0 && avgScore >= 7.0,
    failedDimensions: failedDims.map((r) => r.dimension),
    note: `Deterministic dimensions only (${activeResults.length} active checks including conditional V14 source coverage). Remaining dimensions require LLM evaluation.`,
  };
}

// ── CLI ─────────────────────────────────────────────────────

function cmdCheck(args) {
  const prdIdx = args.indexOf('--prd');
  const prdPath = prdIdx !== -1 && args[prdIdx + 1] ? args[prdIdx + 1] : path.join(planningDir(), 'prd.md');

  const jsonMode = args.includes('--json');

  const result = runChecks(prdPath);

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('[cobolt-validate-prd] Deterministic PRD Validation (8 core dimensions + conditional V14)');
    console.log(`  File: ${result.prdPath}`);
    console.log(`  Words: ${result.totalWords} | Sections: ${result.sectionCount}`);
    console.log('');
    for (const d of result.dimensions) {
      const status = d.skipped ? 'SKIP' : d.score >= 7 ? 'PASS' : d.score >= 5 ? 'WARN' : 'FAIL';
      console.log(`  ${d.dimension} ${d.name}: ${d.score.toFixed(1)}/10 [${status}]`);
      for (const f of d.findings || []) {
        console.log(`    ${f}`);
      }
    }
    console.log('');
    console.log(`  Average: ${result.averageScore}/10 — ${result.passed ? 'PASS' : 'NEEDS ATTENTION'}`);
    if (!result.passed) {
      console.log(`  Failed dimensions: ${result.failedDimensions.join(', ')}`);
    }
  }

  // Write report
  const reportPath = path.join(planningDir(), 'prd-deterministic-validation.json');
  const dir = path.dirname(reportPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  process.exit(result.passed ? 0 : 1);
}

function cmdScore(args) {
  const prdIdx = args.indexOf('--prd');
  const prdPath = prdIdx !== -1 && args[prdIdx + 1] ? args[prdIdx + 1] : path.join(planningDir(), 'prd.md');

  const result = runChecks(prdPath);
  console.log(`${result.averageScore}`);
  process.exit(result.passed ? 0 : 1);
}

if (require.main === module) {
  const [, , command, ...args] = process.argv;

  const printUsage = () => {
    console.log('CoBolt PRD Validator — Deterministic 8-dimension validation');
    console.log('');
    console.log('Usage:');
    console.log('  node tools/cobolt-validate-prd.js check [--prd <path>] [--json]');
    console.log('  node tools/cobolt-validate-prd.js score [--prd <path>]');
    console.log('');
    console.log('Dimensions: V1 Format, V3 Density, V6 Traceability, V7 Leakage,');
    console.log('            V8 Domain, V9 Project Type, V12 Completeness, V13 AC Testability');
    console.log('');
    console.log('Remaining 5 dimensions (V2,V4,V5,V10,V11) require LLM evaluation.');
  };

  switch (command) {
    case 'check':
      cmdCheck(args);
      break;
    case 'score':
      cmdScore(args);
      break;
    case '--help':
    case '-h':
      printUsage();
      process.exit(0);
      break;
    default:
      printUsage();
      // Tool-exit-contract: no-args → 0 (printed usage as intended). Unknown
      // command → 1 (hard usage error, NOT missing-dep=2). See tools/CLAUDE.md.
      process.exit(command ? 1 : 0);
  }
}

module.exports = {
  runChecks,
  _testOnly: {
    validateAcceptanceCriteria,
    v1FormatDetection,
    v3Density,
    v6Traceability,
    v7ImplementationLeakage,
    v8DomainCompliance,
    v9ProjectType,
    v12Completeness,
    v14SourceDocumentCoverage,
  },
};
