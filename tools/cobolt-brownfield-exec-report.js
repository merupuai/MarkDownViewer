#!/usr/bin/env node

// CoBolt Brownfield Executive Report — Data-driven HTML + PDF generator
//
// Reads deterministic brownfield artifacts under `_cobolt-output/latest/brownfield/`
// and renders an executive-ready report: HTML (interactive) and PDF (print).
//
// Usage:
//   node tools/cobolt-brownfield-exec-report.js build [--dir <project>] [--no-pdf]
//   node tools/cobolt-brownfield-exec-report.js build --json
//   node tools/cobolt-brownfield-exec-report.js html [--dir <project>]
//   node tools/cobolt-brownfield-exec-report.js manifest [--dir <project>]
//   node tools/cobolt-brownfield-exec-report.js --help
//
// Outputs (under _cobolt-output/latest/brownfield/reports/):
//   - executive-report.html
//   - executive-report.pdf            (omitted if --no-pdf or Playwright unavailable)
//   - executive-report.manifest.json  (traceability: which inputs produced which sections)
//
// Exit codes:
//   0 = report generated
//   1 = required input artifact missing
//   2 = usage error
//   3 = render failure

const fs = require('node:fs');
const path = require('node:path');

// ── Path resolution ─────────────────────────────────────────

const { paths: _paths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();

function brownfieldDir(projectDir) {
  if (projectDir) return path.join(projectDir, '_cobolt-output', 'latest', 'brownfield');
  const p = typeof _paths === 'function' ? _paths() : null;
  if (p) return path.join(p.outputRoot, 'latest', 'brownfield');
  return path.join(process.cwd(), '_cobolt-output/latest/brownfield');
}

function reportsDir(bfDir) {
  return path.join(bfDir, 'reports');
}

// ── IO helpers ──────────────────────────────────────────────

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function loadMd(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
}

function fileExists(fp) {
  return fs.existsSync(fp);
}

// ── Markdown extraction ─────────────────────────────────────

function stripMd(text) {
  if (!text) return '';
  return text
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
}

function escapeHtml(raw) {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function extractSection(md, headingPattern) {
  if (!md) return null;
  const lines = md.split('\n');
  const rx = new RegExp(`^#{1,6}\\s+.*(?:${headingPattern}).*$`, 'i');
  let start = -1;
  let startLevel = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (rx.test(lines[i])) {
      start = i + 1;
      startLevel = (lines[i].match(/^#+/) || [''])[0].length;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let j = start; j < lines.length; j += 1) {
    const m = lines[j].match(/^(#{1,6})\s+/);
    if (m && m[1].length <= startLevel) {
      end = j;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

function firstParagraph(section) {
  if (!section) return '';
  for (const chunk of section.split(/\n\s*\n/)) {
    const cleaned = chunk.trim();
    if (cleaned && !cleaned.startsWith('|') && !cleaned.startsWith('#')) {
      return stripMd(cleaned).replace(/\s+/g, ' ');
    }
  }
  return '';
}

function bulletsFromSection(section, limit = 8) {
  if (!section) return [];
  const out = [];
  for (const line of section.split('\n')) {
    const m = line.match(/^\s*[-*]\s+(.+)$/);
    if (m) out.push(stripMd(m[1]));
    if (out.length >= limit) break;
  }
  return out;
}

// ── Issues registry aggregation ─────────────────────────────

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
const PRIORITY_ORDER = ['P0', 'P1', 'P2', 'P3', 'P4'];

function normalizeIssue(raw, idx) {
  const severity = String(raw.severity || raw.level || 'MEDIUM').toUpperCase();
  const priority = String(raw.priority || '').toUpperCase();
  const id = String(raw.id || raw.issue_id || raw.findingId || `ISSUE-${idx + 1}`);
  const category = String(raw.category || raw.domain || raw.area || 'General');
  return {
    id,
    title: String(raw.title || raw.summary || raw.description || 'Untitled finding'),
    severity: SEVERITY_ORDER.includes(severity) ? severity : 'MEDIUM',
    priority: PRIORITY_ORDER.includes(priority) ? priority : priorityFromSeverity(severity, category),
    category,
    evidence: String(raw.evidence || raw.location || raw.file || ''),
    impact: String(raw.impact || raw.businessImpact || raw.consequence || ''),
    remediation: String(raw.remediation || raw.fix || raw.recommendation || ''),
    source: String(raw.source || raw.document || raw.ref || ''),
  };
}

function priorityFromSeverity(sev, category) {
  const c = String(category).toUpperCase();
  if (sev === 'CRITICAL') return c.includes('SECURITY') || c.includes('COMPLIANCE') ? 'P0' : 'P1';
  if (sev === 'HIGH') return 'P1';
  if (sev === 'MEDIUM') return 'P2';
  if (sev === 'LOW') return 'P3';
  return 'P4';
}

function extractIssuesList(registry) {
  if (!registry) return [];
  let arr = [];
  if (Array.isArray(registry.issues)) arr = registry.issues;
  else if (Array.isArray(registry.findings)) arr = registry.findings;
  else if (Array.isArray(registry)) arr = registry;
  else if (registry && typeof registry === 'object') {
    arr = Object.values(registry).filter((v) => v && typeof v === 'object' && (v.severity || v.priority || v.title));
  }
  return arr.map((raw, idx) => normalizeIssue(raw, idx));
}

function aggregateBySeverity(issues) {
  const counts = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0]));
  for (const i of issues) counts[i.severity] = (counts[i.severity] || 0) + 1;
  return counts;
}

function aggregateByPriority(issues) {
  const counts = Object.fromEntries(PRIORITY_ORDER.map((p) => [p, 0]));
  for (const i of issues) counts[i.priority] = (counts[i.priority] || 0) + 1;
  return counts;
}

const DOMAIN_BUCKETS = {
  Auth: /auth|login|jwt|token|session|sso|oauth/i,
  Crypto: /crypto|encrypt|hash|fernet|bcrypt|tls|ssl|cert/i,
  'Ops/Resilience': /ops|operat|observ|logg|monitor|health|resilien|timeout|retry|circuit/i,
  'Data & PII': /data|pii|database|schema|migration|privacy|gdpr|consent/i,
  'Supply Chain': /supply|depend|sbom|cve|package|version|outdated/i,
  'UI/Email': /ui|frontend|email|template|swagger|openapi|docs/i,
  Other: /.*/, // default bucket
};

function bucketDomain(issue) {
  // Prefer explicit category → bucket match first (issue authors' own classification).
  const categoryOnly = String(issue.category || '');
  for (const [name, rx] of Object.entries(DOMAIN_BUCKETS)) {
    if (name === 'Other') continue;
    if (rx.test(categoryOnly)) return name;
  }
  // Fallback: keyword-scan title + evidence.
  const haystack = `${issue.title} ${issue.evidence}`;
  for (const [name, rx] of Object.entries(DOMAIN_BUCKETS)) {
    if (name === 'Other') continue;
    if (rx.test(haystack)) return name;
  }
  return 'Other';
}

function buildHeatmap(issues) {
  const buckets = Object.keys(DOMAIN_BUCKETS);
  const matrix = {};
  for (const d of buckets) matrix[d] = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const i of issues) {
    const d = bucketDomain(i);
    const s = i.severity === 'INFO' ? 'LOW' : i.severity;
    if (matrix[d] && matrix[d][s] !== undefined) matrix[d][s] += 1;
  }
  return matrix;
}

function topN(issues, n, filter) {
  const ranked = issues.filter(filter || (() => true)).sort((a, b) => {
    const pa = PRIORITY_ORDER.indexOf(a.priority);
    const pb = PRIORITY_ORDER.indexOf(b.priority);
    if (pa !== pb) return pa - pb;
    const sa = SEVERITY_ORDER.indexOf(a.severity);
    const sb = SEVERITY_ORDER.indexOf(b.severity);
    return sa - sb;
  });
  return ranked.slice(0, n);
}

// ── Project + stack discovery ───────────────────────────────

function loadProjectMeta(projectRoot, bfDir) {
  const cwdName = path.basename(projectRoot);
  const state = loadJson(path.join(projectRoot, 'cobolt-state.json')) || {};
  const classify = loadJson(path.join(bfDir, 'classification.json')) || {};
  const health = loadJson(path.join(bfDir, 'health-score.json')) || {};
  const manifest = loadJson(path.join(bfDir, 'file-manifest.json')) || {};
  const meta = loadJson(path.join(path.dirname(bfDir), 'meta.json')) || {};

  const projectName = state.projectName || classify.projectName || meta.projectName || cwdName;
  const projectId = state.projectId || classify.projectId || meta.projectId || '';
  const reportDate = meta.completedAt || meta.generatedAt || health.timestamp || new Date().toISOString();

  const stack = classify.stack || classify.techStack || meta.stack || null;

  const totalFiles = manifest.total || (Array.isArray(manifest.files) ? manifest.files.length : null);

  return {
    projectName,
    projectId,
    reportDate: reportDate.slice(0, 10),
    reportTimestamp: reportDate,
    stack,
    fileCount: totalFiles,
    classification: classify.classification || classify.type || null,
  };
}

// ── Design tokens (brand) ───────────────────────────────────

const DEFAULT_TOKENS = {
  brand: {
    primary: '#9B1C1C',
    accent: '#B45309',
    ink: '#0F172A',
    muted: '#475569',
    border: '#CBD5E1',
    background: '#FFFFFF',
    surface: '#F8FAFC',
    bandText: '#FECACA',
  },
  severity: {
    CRITICAL: '#B91C1C',
    HIGH: '#D97706',
    MEDIUM: '#2563EB',
    LOW: '#475569',
    INFO: '#94A3B8',
  },
  grade: {
    good: '#047857',
    ok: '#B45309',
    bad: '#B91C1C',
  },
};

function loadBrand(projectRoot) {
  const candidates = [
    path.join(projectRoot, 'design-tokens.json'),
    path.join(projectRoot, '_cobolt-output', 'latest', 'planning', 'design-tokens.json'),
  ];
  for (const cand of candidates) {
    const tokens = loadJson(cand);
    if (!tokens) continue;
    const colors = tokens.colors || tokens.brand || {};
    return {
      ...DEFAULT_TOKENS,
      brand: {
        ...DEFAULT_TOKENS.brand,
        primary: colors.primary || colors.brand || DEFAULT_TOKENS.brand.primary,
        accent: colors.accent || colors.secondary || DEFAULT_TOKENS.brand.accent,
      },
    };
  }
  return DEFAULT_TOKENS;
}

// ── Data assembly ───────────────────────────────────────────

const REQUIRED_ARTIFACTS = [
  { key: 'masterAssessment', file: '23-master-assessment.md' },
  { key: 'issuesRegistry', file: '16-issues-registry.json' },
];

const OPTIONAL_ARTIFACTS = [
  { key: 'healthScore', file: 'health-score.json' },
  { key: 'featureInventory', file: '04-feature-and-module-inventory.md' },
  { key: 'databaseReport', file: '05-database-and-data-store-report.md' },
  { key: 'integrationMap', file: '06-integration-map.md' },
  { key: 'configAudit', file: '07-configuration-and-access-audit.md' },
  { key: 'uiAssessment', file: '08a-current-ui-ux-assessment.md' },
  { key: 'supplyChain', file: '09-supply-chain-and-vulnerability-review.md' },
  { key: 'securityAssessment', file: '12-security-and-quality-assessment.md' },
  { key: 'deepAnalysis', file: '13-deep-analysis.md' },
  { key: 'businessRules', file: '14-business-rules-and-validation.md' },
  { key: 'featureTriage', file: '15-feature-triage-matrix.md' },
  { key: 'forensicAudit', file: '16d-forensic-audit-report.md' },
  { key: 'enhancementAdvisory', file: '17-enhancement-advisory.md' },
  { key: 'modernizationRoadmap', file: '18-modernization-roadmap.md' },
  { key: 'evidenceIndex', file: '19-evidence-index.json' },
  { key: 'projectContext', file: '03-project-context.md' },
  { key: 'sbom', file: 'sbom.json' },
  { key: 'forensicFindings', file: '16a-forensic-findings.json' },
];

function loadArtifact(bfDir, entry) {
  const fp = path.join(bfDir, entry.file);
  if (!fileExists(fp)) return { ...entry, present: false, path: fp };
  const isJson = entry.file.endsWith('.json');
  const content = isJson ? loadJson(fp) : loadMd(fp);
  return {
    ...entry,
    present: content !== null,
    path: fp,
    content,
    bytes: fs.statSync(fp).size,
  };
}

function loadAllArtifacts(bfDir) {
  const required = REQUIRED_ARTIFACTS.map((e) => loadArtifact(bfDir, e));
  const optional = OPTIONAL_ARTIFACTS.map((e) => loadArtifact(bfDir, e));
  const index = {};
  for (const a of [...required, ...optional]) index[a.key] = a;
  return { required, optional, index };
}

// ── HTML rendering ──────────────────────────────────────────

function renderCss(tokens) {
  const t = tokens.brand;
  const s = tokens.severity;
  return `
:root {
  --brand: ${t.primary};
  --accent: ${t.accent};
  --ink: ${t.ink};
  --muted: ${t.muted};
  --border: ${t.border};
  --bg: ${t.background};
  --surface: ${t.surface};
  --band-text: ${t.bandText};
  --sev-crit: ${s.CRITICAL};
  --sev-high: ${s.HIGH};
  --sev-med: ${s.MEDIUM};
  --sev-low: ${s.LOW};
  --sev-info: ${s.INFO};
  --grade-good: ${tokens.grade.good};
  --grade-ok: ${tokens.grade.ok};
  --grade-bad: ${tokens.grade.bad};
}
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  font-size: 10.5pt; line-height: 1.45; color: var(--ink); background: var(--bg);
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
main { max-width: 920px; margin: 0 auto; padding: 24px 32px 48px; }
h1, h2, h3, h4 { color: var(--ink); line-height: 1.25; }
h1 { font-size: 22pt; color: var(--brand); margin: 0 0 6pt; }
h2 { font-size: 15pt; color: var(--brand); margin: 28pt 0 8pt; border-bottom: 1.5pt solid var(--brand); padding-bottom: 4pt; }
h3 { font-size: 11.5pt; color: var(--ink); margin: 14pt 0 4pt; }
p { margin: 0 0 6pt; text-align: justify; }
ul { margin: 0 0 8pt 18pt; padding: 0; }
li { margin-bottom: 3pt; }
code { font-family: "SF Mono", Consolas, "Courier New", monospace; font-size: 9pt; background: var(--surface); padding: 1px 4px; border-radius: 3px; }
.muted { color: var(--muted); font-size: 9.5pt; }
.small { font-size: 9pt; }
.kbd { font-family: "SF Mono", Consolas, monospace; font-size: 9.5pt; }

/* Cover */
.cover { position: relative; height: 297mm; page-break-after: always; padding: 0; margin: 0; max-width: none; }
.cover-band { background: var(--brand); color: var(--band-text); padding: 40pt 48pt 36pt; height: 240pt; position: relative; }
.cover-band::after { content: ""; position: absolute; bottom: 0; left: 0; right: 0; height: 8pt; background: var(--accent); }
.cover-eyebrow { font-size: 12pt; letter-spacing: 2pt; text-transform: uppercase; opacity: 0.9; margin-bottom: 4pt; }
.cover-title { font-size: 34pt; font-weight: 800; color: #fff; line-height: 1.1; margin: 0 0 6pt; }
.cover-sub { font-size: 15pt; color: var(--band-text); margin: 0; }
.cover-body { padding: 32pt 48pt; }
.cover-footer { position: absolute; bottom: 0; left: 0; right: 0; padding: 16pt 48pt; background: var(--surface); border-top: 1pt solid var(--border); font-size: 9pt; color: var(--muted); display: flex; justify-content: space-between; }

/* Metadata card */
.meta-card { border: 1pt solid var(--border); border-radius: 4pt; overflow: hidden; }
.meta-card table { width: 100%; border-collapse: collapse; }
.meta-card th, .meta-card td { padding: 7pt 10pt; font-size: 10pt; text-align: left; border-bottom: 1pt solid var(--border); }
.meta-card tr:last-child th, .meta-card tr:last-child td { border-bottom: none; }
.meta-card th { width: 38%; background: var(--surface); font-weight: 600; color: var(--muted); }

/* Scorecard */
table.score { width: 100%; border-collapse: collapse; margin: 6pt 0 10pt; }
table.score th { background: var(--brand); color: #fff; text-align: left; padding: 7pt 8pt; font-size: 9.5pt; }
table.score td { padding: 6pt 8pt; font-size: 9.5pt; border-bottom: 1pt solid var(--border); vertical-align: top; }
table.score tr:nth-child(even) td { background: var(--surface); }
.grade { display: inline-block; padding: 2pt 8pt; border-radius: 3pt; font-weight: 700; color: #fff; font-size: 9.5pt; min-width: 28pt; text-align: center; }
.grade-A, .grade-Ap, .grade-Am { background: var(--grade-good); }
.grade-B, .grade-Bp, .grade-Bm { background: #059669; }
.grade-C, .grade-Cp, .grade-Cm { background: var(--grade-ok); }
.grade-D, .grade-Dp, .grade-Dm { background: var(--grade-bad); }
.grade-F { background: #7F1D1D; }

/* Severity badges */
.sev-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4pt; margin: 6pt 0 12pt; }
.sev-card { padding: 10pt; text-align: center; border-radius: 4pt; color: #fff; }
.sev-card .n { font-size: 24pt; font-weight: 800; line-height: 1; }
.sev-card .lbl { font-size: 9pt; letter-spacing: 1pt; text-transform: uppercase; margin-top: 4pt; display: block; opacity: 0.95; }
.sev-card.crit { background: var(--sev-crit); }
.sev-card.high { background: var(--sev-high); }
.sev-card.med  { background: var(--sev-med); }
.sev-card.low  { background: var(--sev-low); }
.sev-card.total { background: var(--ink); }

/* Finding table */
table.findings { width: 100%; border-collapse: collapse; margin: 6pt 0 10pt; font-size: 9pt; }
table.findings th { background: var(--sev-crit); color: #fff; padding: 6pt; text-align: left; }
table.findings td { padding: 6pt; border-bottom: 1pt solid var(--border); vertical-align: top; }
table.findings tr:nth-child(even) td { background: var(--surface); }
.pill { display: inline-block; padding: 1pt 6pt; border-radius: 10pt; font-size: 8pt; font-weight: 700; color: #fff; }
.pill-p0 { background: var(--sev-crit); }
.pill-p1 { background: var(--sev-high); }
.pill-p2 { background: var(--sev-med); }
.pill-p3, .pill-p4 { background: var(--sev-low); }
.pill-CRITICAL { background: var(--sev-crit); }
.pill-HIGH { background: var(--sev-high); }
.pill-MEDIUM { background: var(--sev-med); }
.pill-LOW { background: var(--sev-low); }
.pill-INFO { background: var(--sev-info); }

/* Heatmap */
table.heatmap { width: 100%; border-collapse: collapse; margin: 6pt 0 10pt; font-size: 9.5pt; }
table.heatmap th { background: var(--brand); color: #fff; padding: 6pt; }
table.heatmap td { padding: 6pt; border: 1pt solid var(--border); text-align: center; vertical-align: middle; }
table.heatmap td.label { text-align: left; font-weight: 600; background: var(--surface); }
table.heatmap td.total { font-weight: 700; background: var(--surface); }

/* Roadmap */
.milestone { border: 1pt solid var(--border); border-radius: 4pt; margin: 6pt 0; display: grid; grid-template-columns: 64pt 1fr; overflow: hidden; }
.milestone .mid { background: var(--brand); color: #fff; font-weight: 800; font-size: 14pt; display: flex; align-items: center; justify-content: center; }
.milestone .mbody { padding: 10pt 12pt; background: #FAFAFA; }
.milestone .mtitle { font-size: 11pt; font-weight: 700; }
.milestone .mscope { font-size: 9.5pt; color: var(--ink); margin: 3pt 0; }
.milestone .moutcome { font-size: 9.5pt; color: var(--grade-good); font-weight: 600; }

/* Charts */
.gauge { display: flex; align-items: center; gap: 12pt; margin: 6pt 0 14pt; padding: 10pt; background: var(--surface); border-radius: 6pt; }
.gauge-ring { width: 88pt; height: 88pt; flex: none; }
.gauge-label { font-size: 24pt; font-weight: 800; color: var(--ink); line-height: 1; }
.gauge-sub { font-size: 9.5pt; color: var(--muted); }

/* TOC */
.toc { background: var(--surface); border: 1pt solid var(--border); border-radius: 4pt; padding: 12pt 18pt; margin: 12pt 0 18pt; }
.toc h3 { margin-top: 0; color: var(--brand); }
.toc ol { columns: 2; margin: 0; padding-left: 18pt; font-size: 10pt; }
.toc a { color: var(--ink); text-decoration: none; }
.toc a:hover { color: var(--brand); text-decoration: underline; }

/* Print */
@media print {
  @page { size: A4; margin: 18mm 16mm 20mm; }
  main { max-width: none; padding: 0; }
  section { break-inside: avoid-page; }
  table { break-inside: auto; }
  tr { break-inside: avoid; }
  h2 { break-before: page; }
  h2.no-break { break-before: auto; }
  .cover h2 { break-before: auto; }
  a { color: inherit; text-decoration: none; }
}

/* Screen niceties */
@media screen {
  body { padding: 12px; }
  a { color: var(--brand); }
  .print-only { display: none; }
}

footer.report-footer { margin-top: 32pt; padding-top: 10pt; border-top: 1pt solid var(--border); color: var(--muted); font-size: 8.5pt; }
.callout { border-left: 3pt solid var(--accent); padding: 6pt 10pt; background: #FFFBEB; margin: 6pt 0; font-size: 10pt; }
.callout.good { border-color: var(--grade-good); background: #ECFDF5; }
.callout.bad { border-color: var(--sev-crit); background: #FEF2F2; }
`;
}

function gradeClass(grade) {
  const g = String(grade || '').trim();
  const normalized = g.replace('+', 'p').replace('-', 'm');
  return `grade grade-${normalized || 'F'}`;
}

function gradeFromScore(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return '—';
  if (n >= 98) return 'A+';
  if (n >= 93) return 'A';
  if (n >= 90) return 'A-';
  if (n >= 87) return 'B+';
  if (n >= 83) return 'B';
  if (n >= 80) return 'B-';
  if (n >= 77) return 'C+';
  if (n >= 73) return 'C';
  if (n >= 70) return 'C-';
  if (n >= 50) return 'D';
  return 'F';
}

function renderGaugeSvg(score, tokens) {
  const n = Math.max(0, Math.min(100, Number(score) || 0));
  const circumference = 2 * Math.PI * 40;
  const offset = circumference - (n / 100) * circumference;
  let color = tokens.grade.bad;
  if (n >= 80) color = tokens.grade.good;
  else if (n >= 60) color = tokens.grade.ok;
  return `<svg class="gauge-ring" viewBox="0 0 100 100" aria-label="Health score gauge">
    <circle cx="50" cy="50" r="40" fill="none" stroke="${tokens.brand.border}" stroke-width="10"/>
    <circle cx="50" cy="50" r="40" fill="none" stroke="${color}" stroke-width="10"
            stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"
            stroke-linecap="round" transform="rotate(-90 50 50)"/>
    <text x="50" y="54" text-anchor="middle" font-size="22" font-weight="800" fill="${tokens.brand.ink}">${n}</text>
  </svg>`;
}

function heatmapCell(count, severity, tokens) {
  if (!count) return '<td>—</td>';
  const color = tokens.severity[severity] || tokens.severity.LOW;
  const intensity = Math.min(1, 0.35 + count * 0.15);
  const alpha = Math.round(intensity * 255)
    .toString(16)
    .padStart(2, '0');
  const fg = intensity > 0.65 ? '#fff' : tokens.brand.ink;
  return `<td style="background:${color}${alpha};color:${fg};font-weight:700">${count}</td>`;
}

// ── Section renderers ───────────────────────────────────────

function renderCover(meta, health, issueCounts, _tokens) {
  const score = health?.healthScore ?? null;
  const grade = health?.grade || (score !== null ? gradeFromScore(score) : '—');
  const verdict = health?.verdict || '—';
  const totalIssues = Object.values(issueCounts).reduce((a, b) => a + b, 0);
  const rows = [
    ['Project', meta.projectName],
    ['Project ID', meta.projectId || '—'],
    ['Report date', meta.reportDate],
    ['Classification', meta.classification || 'brownfield'],
    ['Source files analysed', meta.fileCount != null ? String(meta.fileCount) : '—'],
    ['Tech stack', formatStack(meta.stack) || '—'],
    ['Overall health score', score !== null ? `${score} / 100` : '—'],
    ['Health grade', grade],
    ['Modernization verdict', verdict],
    ['Total issues catalogued', String(totalIssues)],
    ['Critical findings', String(issueCounts.CRITICAL || 0)],
  ];
  return `
<section class="cover">
  <div class="cover-band">
    <div class="cover-eyebrow">Brownfield Assessment</div>
    <h1 class="cover-title">Executive Report</h1>
    <p class="cover-sub">${escapeHtml(meta.projectName)}</p>
  </div>
  <div class="cover-body">
    <div class="meta-card">
      <table>
        ${rows.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('')}
      </table>
    </div>
    <p class="muted" style="margin-top:18pt">
      Decision-ready consolidation of the CoBolt brownfield pipeline analysis.
      All figures are derived deterministically from artifacts under
      <code>_cobolt-output/latest/brownfield/</code>. See the appendix for the
      complete list of source documents and their byte counts.
    </p>
  </div>
  <div class="cover-footer">
    <span>Confidential — Internal Distribution Only</span>
    <span>Generated ${escapeHtml(meta.reportDate)} · CoBolt Brownfield Pipeline</span>
  </div>
</section>`;
}

function formatStack(stack) {
  if (!stack) return '';
  if (typeof stack === 'string') return stack;
  const parts = [];
  if (stack.languages) parts.push(Array.isArray(stack.languages) ? stack.languages.join(', ') : stack.languages);
  if (stack.frameworks) parts.push(Array.isArray(stack.frameworks) ? stack.frameworks.join(', ') : stack.frameworks);
  if (stack.primary) parts.push(stack.primary);
  return parts.filter(Boolean).join(' · ');
}

function renderToc() {
  const items = [
    ['exec-summary', '1. Executive Summary'],
    ['scorecard', '2. Assessment Scorecard'],
    ['critical', '3. Top Critical Findings'],
    ['security', '4. Security Posture'],
    ['architecture', '5. Architecture & Data'],
    ['integrations', '6. Integrations & Supply Chain'],
    ['heatmap', '7. Risk Heatmap'],
    ['roadmap', '8. Modernization Roadmap'],
    ['actions', '9. Prioritized Next Actions'],
    ['appendix', '10. Source Documents'],
  ];
  return `
<div class="toc">
  <h3>Contents</h3>
  <ol>${items.map(([id, label]) => `<li><a href="#${id}">${escapeHtml(label)}</a></li>`).join('')}</ol>
</div>`;
}

function renderExecSummary(_meta, health, issues, artifacts, tokens) {
  const master = artifacts.index.masterAssessment?.content;
  const execSection = extractSection(master, 'executive\\s+summary|overall|highlights|synopsis');
  const intro = firstParagraph(execSection) || firstParagraph(master) || '';
  const score = health?.healthScore ?? null;
  const grade = health?.grade || (score !== null ? gradeFromScore(score) : '—');
  const counts = aggregateBySeverity(issues);
  const critical = issues.filter((i) => i.severity === 'CRITICAL');
  const high = issues.filter((i) => i.severity === 'HIGH');
  const verdict = health?.verdict || 'MODERNIZE';

  const risks = topN(issues, 3, (i) => i.severity === 'CRITICAL' || i.priority === 'P0')
    .map(
      (r) => `<li><strong>${escapeHtml(r.title)}</strong> <span class="muted">— ${escapeHtml(r.category)}</span></li>`,
    )
    .join('');

  return `
<section id="exec-summary">
  <h2 class="no-break">1. Executive Summary</h2>
  <div class="gauge">
    ${renderGaugeSvg(score, tokens)}
    <div>
      <div class="gauge-label">${score !== null ? `${score}/100` : '—'} · <span class="${gradeClass(grade)}">${escapeHtml(grade)}</span></div>
      <div class="gauge-sub">Modernization verdict: <strong>${escapeHtml(verdict)}</strong></div>
      <div class="gauge-sub">${counts.CRITICAL} critical · ${counts.HIGH} high · ${counts.MEDIUM} medium · ${counts.LOW} low</div>
    </div>
  </div>
  ${intro ? `<p>${escapeHtml(intro)}</p>` : ''}
  ${
    risks
      ? `<h3>Top adverse findings</h3>
         <ul>${risks}</ul>`
      : ''
  }
  <div class="callout ${critical.length > 0 ? 'bad' : 'good'}">
    <strong>Recommended next action.</strong>
    ${
      critical.length > 0
        ? `Close <strong>${critical.length} critical</strong> and <strong>${high.length} high</strong> findings before advancing to the next milestone.`
        : `No critical findings open. Proceed to the next milestone with the high-severity backlog scheduled.`
    }
  </div>
</section>`;
}

function renderScorecard(health, issues, _tokens) {
  const counts = aggregateBySeverity(issues);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const dimensions = health?.dimensions || {};
  const rows = Object.entries(dimensions)
    .map(([name, dim]) => {
      const score = Number(dim.score ?? 0);
      const grade = gradeFromScore(score);
      const weight = dim.weight ? `${Math.round(dim.weight * 100)}%` : '—';
      return `<tr>
      <td><strong>${escapeHtml(humanize(name))}</strong></td>
      <td><span class="${gradeClass(grade)}">${escapeHtml(grade)}</span></td>
      <td>${score.toFixed(0)}/100</td>
      <td>${escapeHtml(weight)}</td>
      <td>${escapeHtml(dim.detail || '—')}</td>
    </tr>`;
    })
    .join('');

  return `
<section id="scorecard">
  <h2>2. Assessment Scorecard</h2>
  <p>Deterministic domain-by-domain scoring from the CoBolt health score engine. Weights reflect the active project profile.</p>
  <table class="score">
    <thead><tr><th>Dimension</th><th>Grade</th><th>Score</th><th>Weight</th><th>Headline observation</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5" class="muted">No health-score.json available — run <code>cobolt bf-health-score compute</code>.</td></tr>'}</tbody>
  </table>

  <h3>Issue distribution</h3>
  <div class="sev-grid">
    <div class="sev-card crit"><span class="n">${counts.CRITICAL}</span><span class="lbl">Critical</span></div>
    <div class="sev-card high"><span class="n">${counts.HIGH}</span><span class="lbl">High</span></div>
    <div class="sev-card med"><span class="n">${counts.MEDIUM}</span><span class="lbl">Medium</span></div>
    <div class="sev-card low"><span class="n">${counts.LOW + (counts.INFO || 0)}</span><span class="lbl">Low/Info</span></div>
    <div class="sev-card total"><span class="n">${total}</span><span class="lbl">Total</span></div>
  </div>
</section>`;
}

function humanize(str) {
  return String(str)
    .replace(/([A-Z])/g, ' $1')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
}

function renderCriticalFindings(issues) {
  const tops = topN(issues, 10, (i) => i.severity === 'CRITICAL' || i.priority === 'P0');
  if (!tops.length) {
    return `<section id="critical"><h2>3. Top Critical Findings</h2>
      <div class="callout good">No critical findings in the issues registry. Review P1/high-severity findings in the full registry.</div>
    </section>`;
  }
  const rows = tops
    .map(
      (i) => `<tr>
      <td><strong>${escapeHtml(i.id)}</strong><br/><span class="pill pill-${i.priority}">${escapeHtml(i.priority)}</span> <span class="pill pill-${i.severity}">${escapeHtml(i.severity)}</span></td>
      <td><strong>${escapeHtml(i.title)}</strong><br/><span class="muted small">${escapeHtml(i.category)}</span></td>
      <td><code class="small">${escapeHtml(i.evidence || '—')}</code></td>
      <td>${escapeHtml(i.impact || '—')}</td>
      <td>${escapeHtml(i.remediation || '—')}</td>
    </tr>`,
    )
    .join('');
  return `
<section id="critical">
  <h2>3. Top Critical Findings</h2>
  <p>Findings ranked P0/Critical from the deterministic issues registry. Each is independently sufficient to block production growth.</p>
  <table class="findings">
    <thead><tr><th>ID</th><th>Finding</th><th>Evidence</th><th>Business impact</th><th>Remediation</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function renderSecurityPosture(artifacts) {
  const sec = artifacts.index.securityAssessment?.content;
  const forensic = artifacts.index.forensicAudit?.content;
  if (!sec && !forensic) {
    return `<section id="security"><h2>4. Security Posture</h2>
      <div class="callout">Security assessment artifacts not found. Run the synthesis phase to regenerate.</div></section>`;
  }
  const headlines = [
    ['Authentication', extractSection(sec, 'authentication|auth(?!or)|jwt|session')],
    ['Authorization', extractSection(sec, 'authorization|rbac|access\\s+control')],
    ['Data protection (PII)', extractSection(sec, 'pii|data\\s+protection|encryption')],
    ['Secrets management', extractSection(sec, 'secret|credential|vault|env')],
    ['Transport & CSRF', extractSection(sec, 'transport|cors|csrf|tls')],
    ['Audit & logging', extractSection(sec, 'audit|logging|telemetry')],
  ].filter(([, v]) => v);
  const blocks = headlines
    .map(
      ([label, body]) => `
    <h3>${escapeHtml(label)}</h3>
    <p>${escapeHtml(firstParagraph(body).slice(0, 900))}</p>`,
    )
    .join('');
  const forensicGrade = forensic ? firstParagraph(extractSection(forensic, 'audit\\s+grade|grade|verdict')) : '';
  return `
<section id="security">
  <h2>4. Security Posture</h2>
  ${forensicGrade ? `<div class="callout"><strong>Forensic audit:</strong> ${escapeHtml(forensicGrade)}</div>` : ''}
  ${blocks || `<p>${escapeHtml(firstParagraph(sec).slice(0, 1400))}</p>`}
</section>`;
}

function renderArchitectureData(artifacts, meta) {
  const db = artifacts.index.databaseReport?.content;
  const deep = artifacts.index.deepAnalysis?.content;
  const intro = firstParagraph(extractSection(deep, 'architecture|overview')) || firstParagraph(deep) || '';
  const dbGaps = bulletsFromSection(extractSection(db, 'gap|risk|issue|finding'), 8);
  const stackRows = [
    ['Runtime', formatStack(meta.stack) || '—'],
    ['Analysed files', meta.fileCount != null ? String(meta.fileCount) : '—'],
    ['Source root', meta.projectName],
  ];
  return `
<section id="architecture">
  <h2>5. Architecture &amp; Data</h2>
  ${intro ? `<p>${escapeHtml(intro.slice(0, 900))}</p>` : ''}
  <div class="meta-card">
    <table>${stackRows.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('')}</table>
  </div>
  ${
    dbGaps.length
      ? `<h3>Database &amp; data integrity observations</h3><ul>${dbGaps.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`
      : ''
  }
</section>`;
}

function renderIntegrationsSupply(artifacts) {
  const integ = artifacts.index.integrationMap?.content;
  const supply = artifacts.index.supplyChain?.content;
  const sbom = artifacts.index.sbom?.content;
  const integBullets = bulletsFromSection(integ, 10);
  const supplyBullets = bulletsFromSection(supply, 8);
  const sbomCount =
    sbom && Array.isArray(sbom.components)
      ? sbom.components.length
      : sbom && Array.isArray(sbom.dependencies)
        ? sbom.dependencies.length
        : null;
  return `
<section id="integrations">
  <h2>6. Integrations &amp; Supply Chain</h2>
  ${
    integ
      ? `<h3>External integrations</h3>
    <p>${escapeHtml(firstParagraph(integ).slice(0, 700))}</p>
    ${integBullets.length ? `<ul>${integBullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>` : ''}`
      : ''
  }
  <h3>Supply chain posture</h3>
  ${sbomCount !== null ? `<p class="muted">SBOM reports <strong>${sbomCount}</strong> components.</p>` : ''}
  ${supplyBullets.length ? `<ul>${supplyBullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>` : supply ? `<p>${escapeHtml(firstParagraph(supply).slice(0, 700))}</p>` : '<p class="muted">Supply-chain review artifact not present.</p>'}
</section>`;
}

function renderHeatmap(issues, tokens) {
  const matrix = buildHeatmap(issues);
  const domains = Object.keys(matrix);
  const colTotals = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  const rows = domains
    .map((d) => {
      const r = matrix[d];
      const total = r.CRITICAL + r.HIGH + r.MEDIUM + r.LOW;
      colTotals.CRITICAL += r.CRITICAL;
      colTotals.HIGH += r.HIGH;
      colTotals.MEDIUM += r.MEDIUM;
      colTotals.LOW += r.LOW;
      return `<tr>
      <td class="label">${escapeHtml(d)}</td>
      ${heatmapCell(r.CRITICAL, 'CRITICAL', tokens)}
      ${heatmapCell(r.HIGH, 'HIGH', tokens)}
      ${heatmapCell(r.MEDIUM, 'MEDIUM', tokens)}
      ${heatmapCell(r.LOW, 'LOW', tokens)}
      <td class="total">${total}</td>
    </tr>`;
    })
    .join('');
  const grand = colTotals.CRITICAL + colTotals.HIGH + colTotals.MEDIUM + colTotals.LOW;
  return `
<section id="heatmap">
  <h2>7. Risk Heatmap</h2>
  <p>Distribution of issues across risk domains and severity levels. Hotspots indicate where remediation capacity should concentrate first.</p>
  <table class="heatmap">
    <thead><tr><th>Domain</th><th>Critical</th><th>High</th><th>Medium</th><th>Low</th><th>Total</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr>
      <td class="label">Column total</td>
      <td class="total">${colTotals.CRITICAL}</td>
      <td class="total">${colTotals.HIGH}</td>
      <td class="total">${colTotals.MEDIUM}</td>
      <td class="total">${colTotals.LOW}</td>
      <td class="total">${grand}</td>
    </tr></tfoot>
  </table>
</section>`;
}

function renderRoadmap(artifacts) {
  const enhancement = artifacts.index.enhancementAdvisory?.content;
  const roadmap = artifacts.index.modernizationRoadmap?.content;
  const source = enhancement || roadmap;
  if (!source) {
    return `<section id="roadmap"><h2>8. Modernization Roadmap</h2>
      <p class="muted">No enhancement advisory or modernization roadmap artifact present.</p></section>`;
  }
  const milestones = parseMilestones(source);
  if (!milestones.length) {
    return `<section id="roadmap"><h2>8. Modernization Roadmap</h2>
      <p>${escapeHtml(firstParagraph(source).slice(0, 700))}</p></section>`;
  }
  const blocks = milestones
    .slice(0, 8)
    .map(
      (m) => `
    <div class="milestone">
      <div class="mid">${escapeHtml(m.id)}</div>
      <div class="mbody">
        <div class="mtitle">${escapeHtml(m.title)}${m.estimate ? ` <span class="muted small">(${escapeHtml(m.estimate)})</span>` : ''}</div>
        ${m.scope ? `<div class="mscope">${escapeHtml(m.scope)}</div>` : ''}
        ${m.outcome ? `<div class="moutcome">▸ ${escapeHtml(m.outcome)}</div>` : ''}
      </div>
    </div>`,
    )
    .join('');
  return `
<section id="roadmap">
  <h2>8. Modernization Roadmap</h2>
  <p>Milestones derived from the enhancement advisory. Order reflects risk reduction per engineering-hour.</p>
  ${blocks}
</section>`;
}

function parseMilestones(md) {
  if (!md) return [];
  const out = [];
  const rx = /^#{1,3}\s+(M\d+)[\s:.\-—]*\s*(.+)$/gm;
  let match;
  const matches = [];
  while ((match = rx.exec(md)) !== null) {
    matches.push({ idx: match.index, id: match[1], title: match[2].trim() });
  }
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].idx;
    const end = i + 1 < matches.length ? matches[i + 1].idx : md.length;
    const body = md.slice(start, end);
    const scope = firstParagraph(body.split('\n').slice(1).join('\n'));
    const estimate = (body.match(/(~?\d+[\s-]*\d*\s*(?:weeks?|days?|months?))/i) || [])[1] || '';
    const outcomeLine = (body.match(/outcome[:\s]*([^\n]{0,280})/i) || [])[1] || '';
    out.push({
      id: matches[i].id,
      title: matches[i].title.replace(/^[–—-]\s*/, '').slice(0, 120),
      scope: scope.slice(0, 400),
      outcome: outcomeLine.trim(),
      estimate,
    });
  }
  return out;
}

function renderNextActions(issues) {
  const actions = topN(issues, 10)
    .map(
      (i, idx) => `<tr>
    <td style="text-align:center"><strong>${idx + 1}</strong></td>
    <td><strong>${escapeHtml(i.title)}</strong><br/><span class="muted small">${escapeHtml(i.category)}</span></td>
    <td><code class="small">${escapeHtml(i.evidence || '—')}</code></td>
    <td><span class="pill pill-${i.priority}">${escapeHtml(i.priority)}</span></td>
  </tr>`,
    )
    .join('');
  if (!actions) {
    return `<section id="actions"><h2>9. Prioritized Next Actions</h2>
      <p class="muted">No actionable findings in the registry.</p></section>`;
  }
  return `
<section id="actions">
  <h2>9. Prioritized Next Actions</h2>
  <p>Top ten items ordered by priority. Close these to move the milestone forward.</p>
  <table class="findings">
    <thead><tr><th>#</th><th>Action</th><th>Evidence</th><th>Priority</th></tr></thead>
    <tbody>${actions}</tbody>
  </table>
</section>`;
}

function renderAppendix(artifacts, bfDir) {
  const all = [...artifacts.required, ...artifacts.optional];
  const rows = all
    .map((a) => {
      const rel = path.relative(bfDir, a.path).replace(/\\/g, '/');
      const status = a.present
        ? '<span class="pill pill-MEDIUM">present</span>'
        : '<span class="pill pill-LOW">missing</span>';
      const size = a.present ? `${Math.max(1, Math.round((a.bytes || 0) / 1024))} KB` : '—';
      return `<tr><td><code>${escapeHtml(rel)}</code></td><td>${status}</td><td>${escapeHtml(size)}</td></tr>`;
    })
    .join('');
  return `
<section id="appendix">
  <h2>10. Source Documents</h2>
  <p>All figures in this report are traceable to these deterministic brownfield artifacts under <code>_cobolt-output/latest/brownfield/</code>. File sizes are captured at report-generation time.</p>
  <table class="score">
    <thead><tr><th>Artifact</th><th>Status</th><th>Size</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <footer class="report-footer">
    Generated by <code>tools/cobolt-brownfield-exec-report.js</code>. All findings are derived
    deterministically from the source artifacts listed above — same inputs produce identical output.
  </footer>
</section>`;
}

// ── Manifest ────────────────────────────────────────────────

function buildManifest(meta, issues, artifacts, health, opts) {
  return {
    version: '1.0.0',
    generator: 'cobolt-brownfield-exec-report',
    generatedAt: new Date().toISOString(),
    deterministic: true,
    project: {
      name: meta.projectName,
      id: meta.projectId || null,
      classification: meta.classification || 'brownfield',
      fileCount: meta.fileCount || null,
    },
    assessment: {
      healthScore: health?.healthScore ?? null,
      grade: health?.grade ?? null,
      verdict: health?.verdict ?? null,
      issueTotals: {
        bySeverity: aggregateBySeverity(issues),
        byPriority: aggregateByPriority(issues),
        total: issues.length,
      },
    },
    inputs: Object.fromEntries(
      Object.entries(artifacts.index).map(([key, a]) => [
        key,
        { file: a.file, present: a.present, bytes: a.bytes || 0 },
      ]),
    ),
    outputs: {
      html: opts.htmlPath,
      pdf: opts.pdfPath || null,
    },
  };
}

// ── Orchestration ───────────────────────────────────────────

function assembleReport(projectDir, opts = {}) {
  const bfDir = brownfieldDir(projectDir);
  if (!fs.existsSync(bfDir)) {
    return { ok: false, error: `Brownfield output directory not found: ${bfDir}` };
  }
  const projectRoot = projectDir || detectProjectRoot(bfDir);
  const tokens = loadBrand(projectRoot);
  const artifacts = loadAllArtifacts(bfDir);

  const missingRequired = artifacts.required.filter((a) => !a.present);
  if (missingRequired.length > 0 && !opts.allowPartial) {
    return {
      ok: false,
      error: `Required artifacts missing: ${missingRequired.map((a) => a.file).join(', ')}`,
      missing: missingRequired.map((a) => a.file),
    };
  }

  const meta = loadProjectMeta(projectRoot, bfDir);
  const health = artifacts.index.healthScore?.content || null;
  const issues = extractIssuesList(artifacts.index.issuesRegistry?.content);
  const issueCounts = aggregateBySeverity(issues);

  const css = renderCss(tokens);
  const body = [
    renderCover(meta, health, issueCounts, tokens),
    `<main>`,
    renderToc(),
    renderExecSummary(meta, health, issues, artifacts, tokens),
    renderScorecard(health, issues, tokens),
    renderCriticalFindings(issues),
    renderSecurityPosture(artifacts),
    renderArchitectureData(artifacts, meta),
    renderIntegrationsSupply(artifacts),
    renderHeatmap(issues, tokens),
    renderRoadmap(artifacts),
    renderNextActions(issues),
    renderAppendix(artifacts, bfDir),
    `</main>`,
  ].join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(meta.projectName)} — Brownfield Executive Report</title>
<meta name="generator" content="cobolt-brownfield-exec-report"/>
<meta name="report-date" content="${escapeHtml(meta.reportDate)}"/>
<style>${css}</style>
</head>
<body>
${body}
</body>
</html>`;

  return { ok: true, html, meta, health, issues, artifacts, tokens };
}

function detectProjectRoot(bfDir) {
  const absolute = path.resolve(bfDir);
  const parts = absolute.split(path.sep);
  if (parts.length >= 3) {
    const tail = parts.slice(-3);
    if (tail[0] === '_cobolt-output' && tail[1] === 'latest' && tail[2] === 'brownfield') {
      return path.dirname(path.dirname(path.dirname(absolute)));
    }
  }
  return process.cwd();
}

async function renderPdfFromHtml(html, pdfPath) {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    return { ok: false, error: 'playwright not installed — rerun with --no-pdf or install playwright' };
  }
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', right: '16mm', bottom: '20mm', left: '16mm' },
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate:
        '<div style="font-size:8pt;color:#475569;width:100%;padding:0 16mm;display:flex;justify-content:space-between"><span>Brownfield Executive Report</span><span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function build(projectDir, opts = {}) {
  const assembled = assembleReport(projectDir, opts);
  if (!assembled.ok) return assembled;

  const bfDir = brownfieldDir(projectDir);
  const outDir = reportsDir(bfDir);
  fs.mkdirSync(outDir, { recursive: true });

  const baseName = 'executive-report';
  const htmlPath = path.join(outDir, `${baseName}.html`);
  const pdfPath = path.join(outDir, `${baseName}.pdf`);
  const manifestPath = path.join(outDir, `${baseName}.manifest.json`);

  fs.writeFileSync(htmlPath, assembled.html, 'utf8');

  let pdfResult = { ok: false, error: 'skipped' };
  if (!opts.noPdf) {
    pdfResult = await renderPdfFromHtml(assembled.html, pdfPath);
  }

  const manifest = buildManifest(assembled.meta, assembled.issues, assembled.artifacts, assembled.health, {
    htmlPath: path.relative(bfDir, htmlPath).replace(/\\/g, '/'),
    pdfPath: pdfResult.ok ? path.relative(bfDir, pdfPath).replace(/\\/g, '/') : null,
  });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return {
    ok: true,
    htmlPath,
    pdfPath: pdfResult.ok ? pdfPath : null,
    pdfError: pdfResult.ok ? null : pdfResult.error,
    manifestPath,
    manifest,
  };
}

// ── CLI ─────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { cmd: argv[0], dir: undefined, noPdf: false, json: false, allowPartial: false };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dir' && argv[i + 1]) {
      args.dir = path.resolve(argv[++i]);
    } else if (a === '--no-pdf') args.noPdf = true;
    else if (a === '--json') args.json = true;
    else if (a === '--allow-partial') args.allowPartial = true;
    else if (a === '--help' || a === '-h') args.cmd = 'help';
  }
  return args;
}

function printHelp() {
  console.log(`CoBolt Brownfield Executive Report — HTML + PDF generator

Usage:
  cobolt-tools brownfield-exec-report build [--dir <project>] [--no-pdf] [--allow-partial]
  cobolt-tools brownfield-exec-report html  [--dir <project>]
  cobolt-tools brownfield-exec-report manifest [--dir <project>]

Reads from: <project>/_cobolt-output/latest/brownfield/
Writes to:  <project>/_cobolt-output/latest/brownfield/reports/
  - executive-report.html
  - executive-report.pdf            (requires playwright; skipped if --no-pdf)
  - executive-report.manifest.json

Required inputs (hard fail without --allow-partial):
  - 23-master-assessment.md
  - 16-issues-registry.json

Optional inputs enrich sections when present (see manifest for full list).
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.cmd || args.cmd === 'help') {
    printHelp();
    process.exit(args.cmd ? 0 : 2);
  }

  if (args.cmd === 'build') {
    const result = await build(args.dir, { noPdf: args.noPdf, allowPartial: args.allowPartial });
    if (!result.ok) {
      if (args.json) console.log(JSON.stringify(result));
      else console.error(`[brownfield-exec-report] ${result.error}`);
      process.exit(1);
    }
    if (args.json) {
      console.log(JSON.stringify(result.manifest, null, 2));
    } else {
      console.log(`[brownfield-exec-report] HTML: ${result.htmlPath}`);
      if (result.pdfPath) console.log(`[brownfield-exec-report] PDF:  ${result.pdfPath}`);
      else console.log(`[brownfield-exec-report] PDF skipped (${result.pdfError || 'disabled'})`);
      console.log(`[brownfield-exec-report] Manifest: ${result.manifestPath}`);
    }
    process.exit(0);
  }

  if (args.cmd === 'html') {
    const assembled = assembleReport(args.dir, { allowPartial: args.allowPartial });
    if (!assembled.ok) {
      console.error(assembled.error);
      process.exit(1);
    }
    process.stdout.write(assembled.html);
    process.exit(0);
  }

  if (args.cmd === 'manifest') {
    const assembled = assembleReport(args.dir, { allowPartial: true });
    if (!assembled.ok) {
      console.error(assembled.error);
      process.exit(1);
    }
    const manifest = buildManifest(assembled.meta, assembled.issues, assembled.artifacts, assembled.health, {
      htmlPath: null,
      pdfPath: null,
    });
    console.log(JSON.stringify(manifest, null, 2));
    process.exit(0);
  }

  printHelp();
  process.exit(2);
}

module.exports = {
  build,
  assembleReport,
  extractIssuesList,
  aggregateBySeverity,
  aggregateByPriority,
  buildHeatmap,
  parseMilestones,
  loadAllArtifacts,
  REQUIRED_ARTIFACTS,
  OPTIONAL_ARTIFACTS,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`[brownfield-exec-report] fatal: ${err.message}`);
    process.exit(3);
  });
}
