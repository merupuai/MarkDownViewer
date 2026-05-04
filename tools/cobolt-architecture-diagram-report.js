#!/usr/bin/env node

// CoBolt Architecture Diagram Report (v0.21.0).
//
// Assembles a self-contained HTML packet (Mermaid.js inlined, offline openable)
// plus a printable PDF. Matches the visual family of
// tools/cobolt-brownfield-exec-report.js so the two reports look like one set.
//
// Usage:
//   node tools/cobolt-architecture-diagram-report.js build --pipeline greenfield [--dir <project>] [--no-pdf] [--no-inline-mermaid]
//   node tools/cobolt-architecture-diagram-report.js html  --pipeline greenfield
//
// Exit codes:
//   0 — HTML + PDF (or HTML only if PDF skipped) generated
//   1 — manifest missing
//   2 — usage error
//   3 — HTML render failure

const fs = require('node:fs');
const path = require('node:path');
const { archRoot } = require('./cobolt-architecture-graph');

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, content, { mode: 0o600 });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inlineSvgDocument(svgText) {
  if (!svgText) return null;
  const text = String(svgText)
    .replace(/^\uFEFF/, '')
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .trim();
  const start = text.search(/<svg\b/i);
  const end = text.toLowerCase().lastIndexOf('</svg>');
  if (start === -1 || end === -1 || end < start) return text;
  return text.slice(start, end + '</svg>'.length);
}

function confidenceBadge(conf) {
  const c = String(conf || 'unknown').toLowerCase();
  const colors = {
    confirmed: '#059669',
    inferred: '#2563eb',
    weak: '#d97706',
    unknown: '#dc2626',
  };
  return `<span class="badge" style="background:${colors[c] || '#6b7280'}">${escapeHtml(c)}</span>`;
}

function stateBadge(state) {
  const s = String(state || '').toLowerCase();
  const colors = { current: '#2563eb', target: '#059669', delta: '#d97706', composite: '#6b7280' };
  return `<span class="badge" style="background:${colors[s] || '#6b7280'}">${escapeHtml(s)}</span>`;
}

function taxonomyIcon(area) {
  const map = {
    'Enterprise Architecture': 'EA',
    'Business Architecture': 'BA',
    'Solution Architecture': 'SA',
    'Application Architecture': 'APP',
    'Data Architecture': 'DATA',
    'Integration Architecture': 'INT',
    'Platform Architecture': 'PLAT',
    'Infrastructure Architecture': 'INFRA',
    'Security Architecture': 'SEC',
    'Governance / Compliance Architecture': 'GOV',
    'Operational Architecture': 'OPS',
    'Brownfield only': 'BF',
  };
  return map[area] || 'ARCH';
}

const TAXONOMY_ORDER = [
  'Enterprise Architecture',
  'Business Architecture',
  'Solution Architecture',
  'Application Architecture',
  'Data Architecture',
  'Integration Architecture',
  'Platform Architecture',
  'Infrastructure Architecture',
  'Security Architecture',
  'Governance / Compliance Architecture',
  'Operational Architecture',
  'Brownfield only',
];

function taxonomyRank(area) {
  const idx = TAXONOMY_ORDER.indexOf(area);
  return idx === -1 ? 999 : idx;
}

function sortedDiagrams(manifest) {
  return (manifest.diagrams || [])
    .slice()
    .sort(
      (a, b) =>
        taxonomyRank(a.taxonomyArea) - taxonomyRank(b.taxonomyArea) ||
        String(a.state || '').localeCompare(String(b.state || '')) ||
        String(a.id || '').localeCompare(String(b.id || '')),
    );
}

function resolveArtifactPath(outDir, filePath) {
  if (!filePath) return null;
  return path.isAbsolute(filePath) ? filePath : path.join(outDir, filePath);
}

function artifactHref(outDir, reportsDir, filePath) {
  const abs = resolveArtifactPath(outDir, filePath);
  if (!abs) return null;
  return path.relative(reportsDir, abs).replace(/\\/g, '/');
}

function readArtifactText(outDir, filePath) {
  const abs = resolveArtifactPath(outDir, filePath);
  return abs ? readText(abs) : null;
}

const MERMAID_CDN_FALLBACK = 'https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js';

// Confidence donut — inline SVG, no external deps. Deterministic for a given
// count vector: segments in fixed order, percentages computed as integer
// ratios so re-rendering produces identical markup.
function renderConfidenceDonut(counts, total) {
  const order = [
    { key: 'confirmed', color: '#059669' },
    { key: 'inferred', color: '#2563EB' },
    { key: 'weak', color: '#D97706' },
    { key: 'unknown', color: '#DC2626' },
  ];
  const cx = 90;
  const cy = 90;
  const r = 72;
  const thickness = 22;
  const parts = [];
  parts.push(`<svg viewBox="0 0 180 180" xmlns="http://www.w3.org/2000/svg">`);
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#E5E7EB" stroke-width="${thickness}"/>`);
  let offset = 0;
  const circumference = 2 * Math.PI * r;
  for (const seg of order) {
    const v = counts[seg.key] || 0;
    if (v <= 0) continue;
    const frac = v / Math.max(1, total);
    const len = frac * circumference;
    // Use stroke-dasharray to draw an arc of the given length starting at offset.
    parts.push(
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${seg.color}" stroke-width="${thickness}" stroke-dasharray="${len.toFixed(2)} ${(circumference - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`,
    );
    offset += len;
  }
  parts.push(
    `<text x="${cx}" y="${cy + 6}" text-anchor="middle" font-family="-apple-system,'Segoe UI',sans-serif" font-size="28" font-weight="700" fill="#0F172A">${total}</text>`,
  );
  parts.push(
    `<text x="${cx}" y="${cy + 26}" text-anchor="middle" font-family="-apple-system,'Segoe UI',sans-serif" font-size="11" fill="#64748B">diagrams</text>`,
  );
  parts.push('</svg>');
  return parts.join('');
}

function tryReadBundledMermaid() {
  // Prefer the playwright-installed mermaid if available (for offline HTML).
  const candidates = [
    path.join(process.cwd(), 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'),
    path.join(__dirname, '..', 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'),
  ];
  for (const c of candidates) {
    const t = readText(c);
    if (t) return { content: t, source: c };
  }
  return null;
}

function buildHtml({ manifest, outDir, graph, inlineMermaid = true }) {
  const reportsDir = path.join(outDir, 'reports');
  const diagrams = sortedDiagrams(manifest);
  const parts = [];
  parts.push('<!doctype html>');
  parts.push('<html lang="en">');
  parts.push('<head>');
  parts.push('<meta charset="utf-8">');
  parts.push(
    `<title>Architecture Diagrams — ${escapeHtml(manifest.pipeline)} (${escapeHtml(manifest.profile)}/${escapeHtml(manifest.state)})</title>`,
  );
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  parts.push('<style>');
  parts.push(`
    :root { --fg:#0f172a; --muted:#475569; --line:#e2e8f0; --bg:#f8fafc; --accent:#1e3a8a; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; color: var(--fg); background: #fff; margin: 0; line-height: 1.55; }
    header { background: linear-gradient(135deg,#1e3a8a,#4f46e5); color: #fff; padding: 32px 48px; border-bottom: 4px solid #0ea5e9; }
    header h1 { margin: 0 0 8px; font-weight: 700; font-size: 28px; letter-spacing: -0.01em; }
    header .meta { font-size: 14px; opacity: .9; }
    main { max-width: 1200px; margin: 0 auto; padding: 32px 48px; }
    nav.toc { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 16px 20px; margin-bottom: 28px; }
    nav.toc h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 0 0 8px; }
    nav.toc ul { list-style: none; padding: 0; margin: 0; columns: 2; column-gap: 32px; }
    nav.toc li { padding: 4px 0; font-size: 14px; break-inside: avoid; }
    nav.toc a { color: var(--accent); text-decoration: none; }
    nav.toc a:hover { text-decoration: underline; }
    section { margin-bottom: 48px; page-break-inside: avoid; }
    section h2 { font-size: 20px; font-weight: 700; border-bottom: 2px solid var(--line); padding-bottom: 8px; margin: 0 0 16px; }
    .diagram-card { border: 1px solid var(--line); border-radius: 10px; padding: 20px 24px; margin-bottom: 24px; background: #fff; page-break-inside: avoid; }
    .diagram-header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
    .diagram-header h3 { font-size: 16px; margin: 0; flex: 1; }
    .id-chip { font-family: 'SFMono-Regular', ui-monospace, monospace; font-size: 11px; background: #eef2ff; color: #3730a3; padding: 3px 8px; border-radius: 4px; }
    .badge { color:#fff; font-size:10px; padding: 3px 8px; border-radius: 12px; letter-spacing: .04em; text-transform: uppercase; font-weight: 600; }
    .diagram-meta { font-size: 13px; color: var(--muted); margin-bottom: 12px; }
    .mermaid-host { background: #fff; border: 1px dashed var(--line); border-radius: 6px; padding: 16px; overflow: auto; min-height: 140px; }
    .evidence { margin-top: 16px; font-size: 13px; color: var(--muted); }
    .evidence ul { margin: 4px 0 0 18px; padding: 0; }
    .exec-summary { background: var(--bg); border-left: 4px solid var(--accent); padding: 20px 24px; border-radius: 6px; }
    .degraded-banner { background: #fef2f2; border: 2px solid #dc2626; border-radius: 8px; padding: 16px 20px; margin: 0 0 24px; color: #7f1d1d; font-size: 14px; line-height: 1.55; }
    .degraded-banner strong { color: #991b1b; }
    .degraded-banner code { background: #fee2e2; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
    .cover-card { margin-bottom: 40px; border: 1px solid var(--line); border-radius: 12px; padding: 28px 32px; background: linear-gradient(180deg,#fff,#f8fafc); page-break-after: avoid; }
    .cover-grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 32px; align-items: center; }
    .confidence-donut { display: flex; flex-direction: column; align-items: center; gap: 16px; }
    .confidence-donut svg { width: 180px; height: 180px; }
    .confidence-legend { font-size: 13px; color: var(--fg); display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
    .confidence-legend .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; vertical-align: middle; }
    .confidence-legend em { color: var(--muted); font-style: normal; margin-left: 4px; }
    .stack-chips { margin-top: 14px; display: flex; flex-wrap: wrap; gap: 6px; }
    .chip { background: #eef2ff; color: #3730a3; border-radius: 999px; padding: 3px 10px; font-size: 11px; font-weight: 500; }
    @media (max-width: 900px) { .cover-grid { grid-template-columns: 1fr; } }
    .cover-card { margin-bottom: 40px; border: 1px solid var(--line); border-radius: 12px; padding: 28px 32px; background: linear-gradient(180deg,#fff,#f8fafc); }
    .cover-grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 32px; align-items: center; }
    .confidence-donut { display: flex; flex-direction: column; align-items: center; gap: 16px; }
    .confidence-donut svg { width: 180px; height: 180px; }
    .confidence-legend { font-size: 13px; color: var(--fg); display: flex; flex-direction: column; gap: 4px; }
    .confidence-legend .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; vertical-align: middle; }
    .confidence-legend em { color: var(--muted); font-style: normal; }
    .stack-chips { margin-top: 14px; display: flex; flex-wrap: wrap; gap: 6px; }
    .chip { background: #eef2ff; color: #3730a3; border-radius: 999px; padding: 3px 10px; font-size: 11px; font-weight: 500; }
    @media (max-width: 900px) { .cover-grid { grid-template-columns: 1fr; } }
    .catalog-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .catalog-table th, .catalog-table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }
    .catalog-table th { background: var(--bg); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
    .gap-card { border: 1px solid #fcd34d; background: #fffbeb; border-radius: 6px; padding: 12px 16px; margin-bottom: 8px; font-size: 13px; }
    .plantuml-svg-host { background: #fff; border: 1px dashed var(--line); border-radius: 6px; padding: 16px; overflow: auto; min-height: 140px; text-align: center; }
    .plantuml-svg-host svg { max-width: 100%; height: auto; }
    .d2-svg-host { background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 20px; overflow: auto; min-height: 180px; text-align: center; }
    .d2-svg-host svg { max-width: 100%; height: auto; }
    .svg-iconic-host { background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 8px; overflow: hidden; text-align: center; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
    .svg-iconic-host svg { max-width: 100%; height: auto; display: block; }
    .format-links { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
    .format-links a { color:var(--accent); background:#eff6ff; border:1px solid #bfdbfe; border-radius:999px; padding:4px 10px; font-size:12px; text-decoration:none; font-weight:600; }
    .icon-attribution { font-size: 11px; color: var(--muted); margin-top: 24px; padding-top: 12px; border-top: 1px solid var(--line); }
    .plantuml-source { font-family: 'SFMono-Regular', ui-monospace, monospace; }
    .plantuml-source-details summary { user-select: none; }
    footer { text-align: center; padding: 32px; color: var(--muted); font-size: 12px; border-top: 1px solid var(--line); }
    @media print {
      header { background: #1e3a8a !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      main { padding: 16px 24px; max-width: 100%; }
      .diagram-card { break-inside: avoid; }
      nav.toc { break-after: page; }
    }
  `);
  parts.push('</style>');
  parts.push('</head>');
  parts.push('<body>');
  parts.push(
    `<header><h1>Architecture Diagrams</h1><div class="meta">Pipeline: <strong>${escapeHtml(manifest.pipeline)}</strong> &middot; Profile: <strong>${escapeHtml(manifest.profile)}</strong> &middot; State: <strong>${escapeHtml(manifest.state)}</strong>${manifest.theme ? ` &middot; Theme: <strong>${escapeHtml(manifest.theme)}</strong>` : ''} &middot; Generated: ${escapeHtml(manifest.generatedAt)}</div></header>`,
  );
  parts.push('<main>');

  // Degraded-graph banner — production-readiness signal. When the graph
  // builder ran every fallback (planning extractors → tech-stack → source
  // manifest) and still produced fewer than 5 real nodes, the resulting
  // diagrams cannot reflect the system. Surface this loudly above the cover
  // card so stakeholders never receive an "empty diagram" packet silently.
  if (graph?.degraded === true) {
    const reason = escapeHtml(
      graph.degradedReason || 'The architecture graph contains too few nodes to produce meaningful diagrams.',
    );
    parts.push(
      `<section class="degraded-banner">
        <strong>⚠ Degraded architecture graph.</strong> ${reason}
        <br><br>
        <strong>What to do:</strong> run the upstream pipeline to generate documentation artifacts that feed the graph
        — for greenfield projects use <code>/cobolt-plan project .</code>, for brownfield use
        <code>/cobolt-brownfield --scan deep</code>. After the run, re-execute <code>/cobolt-arch</code>.
        Without those artifacts, the diagrams below will only show the tech-stack inference layer.
      </section>`,
    );
  }

  // Cover block: confidence donut + stack chips + exec summary
  const confidenceCounts = { confirmed: 0, inferred: 0, weak: 0, unknown: 0 };
  for (const d of diagrams || []) {
    const c = String(d.confidence || 'unknown').toLowerCase();
    if (confidenceCounts[c] != null) confidenceCounts[c] += 1;
  }
  const totalForPct = Math.max(1, (diagrams || []).length);
  const pct = (n) => Math.round((n / totalForPct) * 100);
  const techSlugs =
    manifest.techStack && Array.isArray(manifest.techStack.slugs) ? manifest.techStack.slugs.slice(0, 18) : [];

  parts.push('<section class="cover-card">');
  parts.push('<div class="cover-grid">');
  parts.push('<div class="exec-summary">');
  parts.push(
    `<p><strong>${diagrams.length}</strong> architecture diagram${diagrams.length === 1 ? '' : 's'} derived from <strong>${graph?.sourceEvidence?.length || 0}</strong> evidence source${(graph?.sourceEvidence?.length) === 1 ? '' : 's'}.</p>`,
  );
  parts.push(
    '<p style="color:var(--muted);font-size:13px;margin-top:8px">Every diagram is graph-derived, schema-validated, and carries an explicit confidence level. No generative model draws diagrams directly.</p>',
  );
  if (techSlugs.length) {
    parts.push('<div class="stack-chips">');
    for (const slug of techSlugs) parts.push(`<span class="chip">${escapeHtml(slug)}</span>`);
    parts.push('</div>');
  }
  parts.push('</div>');
  parts.push('<div class="confidence-donut">');
  parts.push(renderConfidenceDonut(confidenceCounts, totalForPct));
  parts.push('<div class="confidence-legend">');
  parts.push(
    `<div><span class="dot" style="background:#059669"></span>Confirmed <strong>${confidenceCounts.confirmed}</strong> <em>(${pct(confidenceCounts.confirmed)}%)</em></div>`,
  );
  parts.push(
    `<div><span class="dot" style="background:#2563EB"></span>Inferred <strong>${confidenceCounts.inferred}</strong> <em>(${pct(confidenceCounts.inferred)}%)</em></div>`,
  );
  parts.push(
    `<div><span class="dot" style="background:#D97706"></span>Weak <strong>${confidenceCounts.weak}</strong> <em>(${pct(confidenceCounts.weak)}%)</em></div>`,
  );
  parts.push(
    `<div><span class="dot" style="background:#DC2626"></span>Unknown <strong>${confidenceCounts.unknown}</strong> <em>(${pct(confidenceCounts.unknown)}%)</em></div>`,
  );
  parts.push('</div></div>');
  parts.push('</div></section>');

  // TOC
  parts.push('<nav class="toc"><h2>Contents</h2><ul>');
  parts.push('<li><a href="#catalog">Diagram Catalog</a></li>');
  const byArea = new Map();
  for (const d of diagrams) {
    if (!byArea.has(d.taxonomyArea)) byArea.set(d.taxonomyArea, []);
    byArea.get(d.taxonomyArea).push(d);
  }
  for (const area of byArea.keys()) {
    parts.push(
      `<li><a href="#area-${escapeHtml(taxonomyIcon(area))}">${escapeHtml(area)} (${byArea.get(area).length})</a></li>`,
    );
  }
  parts.push('<li><a href="#gaps">Gap Report</a></li>');
  parts.push('</ul></nav>');

  // Catalog
  parts.push('<section id="catalog"><h2>Diagram Catalog</h2>');
  parts.push(
    '<table class="catalog-table"><thead><tr><th>ID</th><th>Title</th><th>Area</th><th>State</th><th>Conf.</th><th>Nodes</th><th>Status</th></tr></thead><tbody>',
  );
  for (const d of diagrams) {
    parts.push(
      `<tr><td><span class="id-chip">${escapeHtml(d.id)}</span></td><td>${escapeHtml(d.title)}</td><td>${escapeHtml(d.taxonomyArea)}</td><td>${stateBadge(d.state)}</td><td>${confidenceBadge(d.confidence)}</td><td>${d.nodeCount || 0}</td><td>${escapeHtml(d.status)}</td></tr>`,
    );
  }
  parts.push('</tbody></table></section>');

  // Per-area diagram sections
  for (const [area, diagrams] of byArea.entries()) {
    parts.push(`<section id="area-${escapeHtml(taxonomyIcon(area))}"><h2>${escapeHtml(area)}</h2>`);
    for (const d of diagrams) {
      parts.push('<div class="diagram-card">');
      parts.push(
        `<div class="diagram-header"><span class="id-chip">${escapeHtml(d.id)}</span><h3>${escapeHtml(d.title)}</h3>${stateBadge(d.state)}${confidenceBadge(d.confidence)}</div>`,
      );
      parts.push(
        `<div class="diagram-meta">Nodes: ${d.nodeCount || 0} &middot; Edges: ${d.edgeCount || 0} &middot; Evidence refs: ${d.evidenceCount || 0}${d.skipReason ? ` &middot; Note: ${escapeHtml(d.skipReason)}` : ''}</div>`,
      );

      const mmd = readArtifactText(outDir, d.files?.mermaid);
      const puml = readArtifactText(outDir, d.files?.plantuml);
      const pumlSvg = readArtifactText(outDir, d.files?.plantumlSvg);
      const d2Svg = readArtifactText(outDir, d.files?.d2Svg);
      const d2Source = readArtifactText(outDir, d.files?.d2);
      const svgIconic = readArtifactText(outDir, d.files?.svgIconic);
      const renderedSvg = readArtifactText(outDir, d.files?.svg);
      const pngHref = artifactHref(outDir, reportsDir, d.files?.png);

      // Primary render surface: svg-iconic (handcrafted) -> rendered SVG -> D2 SVG -> client-side Mermaid -> PlantUML SVG/source -> D2 source -> PNG link.
      if (svgIconic) {
        parts.push('<div class="svg-iconic-host">');
        parts.push(inlineSvgDocument(svgIconic));
        parts.push('</div>');
      } else if (renderedSvg) {
        parts.push('<div class="rendered-svg-host">');
        parts.push(inlineSvgDocument(renderedSvg));
        parts.push('</div>');
      } else if (d2Svg) {
        parts.push('<div class="d2-svg-host">');
        parts.push(inlineSvgDocument(d2Svg));
        parts.push('</div>');
      } else if (mmd) {
        parts.push('<div class="mermaid-host"><pre class="mermaid">');
        parts.push(escapeHtml(mmd));
        parts.push('</pre></div>');
      } else if (pumlSvg) {
        parts.push('<div class="plantuml-svg-host">');
        parts.push(inlineSvgDocument(pumlSvg));
        parts.push('</div>');
      } else if (d2Source) {
        parts.push('<div class="mermaid-host"><pre class="d2-source">');
        parts.push(escapeHtml(d2Source));
        parts.push('</pre></div>');
      } else if (puml) {
        parts.push('<div class="mermaid-host"><pre class="plantuml-source">');
        parts.push(escapeHtml(puml));
        parts.push(
          '</pre><p style="color:var(--muted);font-size:12px;margin-top:8px">PlantUML source above; render with <code>plantuml</code> CLI or set <code>PLANTUML_JAR</code> env var for inline SVG.</p></div>',
        );
      } else if (pngHref) {
        parts.push(`<div class="png-host"><img src="${escapeHtml(pngHref)}" alt="${escapeHtml(d.title)}" /></div>`);
      } else {
        parts.push('<div class="mermaid-host"><em>Diagram source unavailable.</em></div>');
      }

      // Separate format projections.
      // Keep alternate formats as links; each renderer owns a separate file.
      const formatLinks = [
        d.files?.spec ? ['Master spec', d.files.spec] : null,
        d.files?.mermaid ? ['Mermaid', d.files.mermaid] : null,
        d.files?.plantuml ? ['C4 / PlantUML', d.files.plantuml] : null,
        d.files?.d2 ? ['D2', d.files.d2] : null,
        d.files?.svgIconic ? ['SVG iconic', d.files.svgIconic] : null,
        d.files?.svg ? ['Rendered SVG', d.files.svg] : null,
        d.files?.png ? ['Rendered PNG', d.files.png] : null,
        d.files?.plantumlSvg ? ['PlantUML SVG', d.files.plantumlSvg] : null,
        d.files?.plantumlPng ? ['PlantUML PNG', d.files.plantumlPng] : null,
        d.files?.d2Svg ? ['D2 SVG', d.files.d2Svg] : null,
        d.files?.d2Png ? ['D2 PNG', d.files.d2Png] : null,
      ].filter(Boolean);
      if (formatLinks.length) {
        parts.push('<div class="format-links">');
        for (const [label, rel] of formatLinks) {
          const href = artifactHref(outDir, reportsDir, rel);
          if (href) parts.push(`<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`);
        }
        parts.push('</div>');
      }

      if (d.evidence?.length) {
        parts.push('<div class="evidence"><strong>Evidence</strong><ul>');
        for (const e of d.evidence.slice(0, 6)) {
          parts.push(
            `<li><code>${escapeHtml(e.path || '')}</code>${e.summary ? ` — ${escapeHtml(e.summary)}` : ''}</li>`,
          );
        }
        parts.push('</ul></div>');
      }

      parts.push('</div>');
    }
    parts.push('</section>');
  }

  // Gap report
  parts.push('<section id="gaps"><h2>Gap Report</h2>');
  const gapReport = readJson(path.join(outDir, 'gap-report.json'));
  if (gapReport?.confidenceSummary) {
    const cs = gapReport.confidenceSummary;
    parts.push(
      `<p style="font-size:13px;color:var(--muted)">Confidence summary — confirmed: <strong>${cs.confirmed}</strong>, inferred: <strong>${cs.inferred}</strong>, weak: <strong>${cs.weak}</strong>, unknown: <strong>${cs.unknown}</strong></p>`,
    );
  }
  if (gapReport?.gaps?.length) {
    for (const g of gapReport.gaps)
      parts.push(`<div class="gap-card"><strong>${escapeHtml(g.area)}</strong> — ${escapeHtml(g.reason)}</div>`);
  } else {
    parts.push('<p>No structural gaps recorded.</p>');
  }
  parts.push('</section>');

  parts.push('</main>');
  // Icon attribution footer — legally required for AWS/Azure/GCP icons + good
  // practice for simple-icons / devicon. Data comes from manifest.icons.attributions.
  const attributions = manifest.icons && Array.isArray(manifest.icons.attributions) ? manifest.icons.attributions : [];
  if (attributions.length) {
    parts.push('<div class="icon-attribution">');
    const attrLines = attributions
      .map((a) => `${escapeHtml(a.source)} (${a.count}, ${escapeHtml(a.license)})`)
      .join(' · ');
    parts.push(
      `Icons: ${attrLines} — sourced from Iconify / simple-icons / devicon under their respective licenses. Cloud architecture icons used under AWS / Azure / Google Cloud icon toolkit terms.`,
    );
    parts.push('</div>');
  }
  parts.push('<footer>Generated by CoBolt · architecture-diagrams pipeline</footer>');

  // Mermaid runtime
  const bundled = inlineMermaid ? tryReadBundledMermaid() : null;
  if (bundled) {
    parts.push('<script>');
    parts.push(bundled.content);
    parts.push('</script>');
  } else {
    parts.push(`<script src="${MERMAID_CDN_FALLBACK}"></script>`);
  }
  // securityLevel "strict" is the safest default for inlined labels:
  // disables raw HTML, iframes, scripts in diagrams; htmlLabels false keeps
  // labels text-only. This closes the XSS path that "loose" would open when
  // label content carries untrusted markdown from upstream evidence.
  parts.push(
    '<script>try{mermaid.initialize({startOnLoad:true,securityLevel:"strict",theme:"base",flowchart:{htmlLabels:false,curve:"basis"}});}catch(e){document.body.insertAdjacentHTML("afterbegin","<p style=\\"background:#fee;padding:8px\\">Mermaid failed to initialize: "+String(e.message||e)+"</p>");}</script>',
  );
  parts.push('</body></html>');
  return parts.join('\n');
}

// ── Milestone report integration ───────────────────────────────────────────
//
// When `cobolt-state.json` declares `pipeline.currentMilestone` (e.g. 'M1'),
// the report tool also writes a concise milestone-scoped pointer into
// `_cobolt-output/reports/M{n}/architecture-diagrams.md`. The pointer is NOT
// a copy of the full HTML/PDF packet — it links to the canonical location so
// re-running the sidecar updates the pointer in-place without drift.
//
// Silently skipped when no current milestone is declared.

function detectCurrentMilestone(projectRoot) {
  try {
    const statePath = path.join(projectRoot, 'cobolt-state.json');
    if (!fs.existsSync(statePath)) return null;
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const raw = state?.pipeline?.currentMilestone || state?.build?.currentMilestone || null;
    if (!raw) return null;
    const m = String(raw).match(/^M\d+$/i);
    return m ? m[0].toUpperCase() : null;
  } catch {
    return null;
  }
}

function writeMilestoneSummary({
  projectRoot,
  pipeline: _pipeline,
  manifest,
  htmlPath,
  pdfPath,
  pdfStatus,
  pdfReason,
}) {
  const diagrams = sortedDiagrams(manifest);
  const milestone = detectCurrentMilestone(projectRoot);
  if (!milestone) return { ok: false, reason: 'no-current-milestone' };

  const reportsRoot = path.join(projectRoot, '_cobolt-output', 'reports', milestone);
  fs.mkdirSync(reportsRoot, { recursive: true, mode: 0o700 });
  const summaryPath = path.join(reportsRoot, 'architecture-diagrams.md');

  // Resolve relative paths from the milestone report dir back to the canonical
  // HTML/PDF packet in architecture-diagrams/reports/.
  const htmlRel = htmlPath ? path.relative(reportsRoot, htmlPath).replace(/\\/g, '/') : null;
  const pdfRel = pdfPath ? path.relative(reportsRoot, pdfPath).replace(/\\/g, '/') : null;
  // manifest.graphPath is relative to outDir (architecture-diagrams/). htmlPath
  // lives at outDir/reports/architecture-packet.html — so outDir = dirname(dirname(htmlPath)).
  let graphRel = null;
  if (htmlPath && manifest.graphPath) {
    const outDir = path.dirname(path.dirname(htmlPath));
    const graphAbs = path.join(outDir, manifest.graphPath);
    graphRel = path.relative(reportsRoot, graphAbs).replace(/\\/g, '/');
  }

  const byArea = new Map();
  for (const d of diagrams) {
    if (!byArea.has(d.taxonomyArea)) byArea.set(d.taxonomyArea, []);
    byArea.get(d.taxonomyArea).push(d);
  }

  const confidenceCounts = { confirmed: 0, inferred: 0, weak: 0, unknown: 0 };
  for (const d of diagrams) {
    const c = String(d.confidence || 'unknown').toLowerCase();
    if (confidenceCounts[c] != null) confidenceCounts[c] += 1;
  }

  const lines = [];
  lines.push(`# Architecture Diagrams — ${milestone}`);
  lines.push('');
  lines.push(`Generated: ${manifest.generatedAt}`);
  lines.push(`Pipeline: **${manifest.pipeline}** · Profile: **${manifest.profile}** · State: **${manifest.state}**`);
  lines.push('');
  lines.push('## Deliverables');
  lines.push('');
  if (htmlRel) lines.push(`- HTML (offline, Mermaid-inlined): [${path.basename(htmlPath)}](${htmlRel})`);
  if (pdfRel && pdfStatus === 'generated') lines.push(`- PDF (A4 printable): [${path.basename(pdfPath)}](${pdfRel})`);
  else lines.push(`- PDF: **${pdfStatus || 'skipped'}**${pdfReason ? ` — ${pdfReason}` : ''}`);
  if (graphRel) lines.push(`- Evidence graph: \`${graphRel}\``);
  lines.push('');
  lines.push('## Confidence summary');
  lines.push('');
  lines.push(
    `- confirmed: ${confidenceCounts.confirmed} · inferred: ${confidenceCounts.inferred} · weak: ${confidenceCounts.weak} · unknown: ${confidenceCounts.unknown}`,
  );
  lines.push('');
  lines.push('## Diagram catalog');
  lines.push('');
  lines.push('| ID | Title | Area | State | Confidence | Nodes | Status |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const d of diagrams) {
    lines.push(
      `| ${d.id} | ${d.title} | ${d.taxonomyArea} | ${d.state} | ${d.confidence || 'unknown'} | ${d.nodeCount || 0} | ${d.status} |`,
    );
  }
  lines.push('');
  lines.push(
    '_This file is regenerated on every architecture-diagrams run. Edits here are ephemeral — change the upstream artifacts or the diagram specs to affect the next render._',
  );

  fs.writeFileSync(summaryPath, lines.join('\n'), { mode: 0o600 });
  return { ok: true, milestone, summaryPath };
}

function tryPlaywrightPdf(htmlPath, pdfPath) {
  try {
    const playwright = require('playwright');
    return (async () => {
      const browser = await playwright.chromium.launch();
      const page = await browser.newPage();
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`file:///${htmlPath.replace(/\\/g, '/')}`, { waitUntil: 'networkidle', timeout: 45_000 });
      // Give Mermaid time to render.
      await page.waitForTimeout(5000);
      await page.pdf({
        path: pdfPath,
        format: 'A4',
        printBackground: true,
        margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' },
        scale: 0.82,
      });
      await browser.close();
      return { ok: true };
    })();
  } catch (err) {
    return Promise.resolve({ ok: false, reason: String(err.message || err).slice(0, 200) });
  }
}

async function build({
  projectRoot = process.cwd(),
  pipeline = 'greenfield',
  noPdf = false,
  inlineMermaid = true,
} = {}) {
  const outDir = archRoot(projectRoot, pipeline);
  const manifestPath = path.join(outDir, 'diagram-manifest.json');
  const manifest = readJson(manifestPath);
  if (!manifest) return { ok: false, code: 1, error: `manifest missing at ${manifestPath}` };

  // Graph path resolution
  const graphAbs =
    resolveArtifactPath(outDir, manifest.graphPath) || path.join(outDir, 'graph', 'architecture-graph.json');
  const graph = readJson(graphAbs) || { sourceEvidence: [] };

  const html = buildHtml({ manifest, outDir, graph, inlineMermaid });
  const reportsDir = path.join(outDir, 'reports');
  const htmlPath = path.join(reportsDir, 'architecture-packet.html');
  writeFile(htmlPath, html);

  let pdfStatus = 'skipped';
  let pdfPath = null;
  let pdfReason = '';
  if (!noPdf) {
    const pdfTarget = path.join(reportsDir, 'architecture-packet.pdf');
    const res = await tryPlaywrightPdf(htmlPath, pdfTarget);
    if (res?.ok) {
      pdfStatus = 'generated';
      pdfPath = pdfTarget;
    } else {
      pdfStatus = 'skipped';
      pdfReason = res?.reason || 'playwright-unavailable';
    }
  } else {
    pdfReason = 'no-pdf-flag';
  }

  // Milestone-scoped summary (non-disruptive — silent skip when no milestone
  // context is declared in cobolt-state.json).
  let milestoneSummary = null;
  try {
    const res = writeMilestoneSummary({
      projectRoot,
      pipeline,
      manifest,
      htmlPath,
      pdfPath,
      pdfStatus,
      pdfReason,
    });
    if (res.ok) milestoneSummary = res;
  } catch (err) {
    // Best-effort; never fail the packet build because of milestone export.
    try {
      process.stderr.write(
        `[architecture-report] milestone summary write skipped: ${String(err.message || err).slice(0, 200)}\n`,
      );
    } catch {
      /* noop */
    }
  }

  // Update manifest with report paths
  manifest.reports = {
    html: path.relative(outDir, htmlPath).replace(/\\/g, '/'),
    pdf: pdfPath ? path.relative(outDir, pdfPath).replace(/\\/g, '/') : null,
    pdfStatus,
    pdfReason,
    milestoneSummary: milestoneSummary
      ? {
          milestone: milestoneSummary.milestone,
          path: path.relative(outDir, milestoneSummary.summaryPath).replace(/\\/g, '/'),
        }
      : null,
  };
  writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  return { ok: true, code: 0, htmlPath, pdfPath, pdfStatus, pdfReason, milestoneSummary };
}

function parseCliArgs(argv) {
  const out = { pipeline: 'greenfield', dir: null, noPdf: false, inlineMermaid: true, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--pipeline') out.pipeline = argv[++i];
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--no-pdf') out.noPdf = true;
    else if (a === '--no-inline-mermaid') out.inlineMermaid = false;
    else if (a === '--json') out.json = true;
  }
  return out;
}

async function cli(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'build' && cmd !== 'html') {
    process.stderr.write(
      'usage: cobolt-architecture-diagram-report <build|html> --pipeline greenfield|brownfield [--dir <path>] [--no-pdf] [--no-inline-mermaid]\n',
    );
    process.exit(2);
  }
  const opts = parseCliArgs(rest);
  const res = await build({
    projectRoot: opts.dir || process.cwd(),
    pipeline: opts.pipeline,
    noPdf: cmd === 'html' || opts.noPdf,
    inlineMermaid: opts.inlineMermaid,
  });
  if (!res.ok) {
    process.stderr.write(`[architecture-report] ${res.error}\n`);
    process.exit(res.code || 3);
  }
  if (opts.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  else
    process.stdout.write(
      `[architecture-report] html=${res.htmlPath} pdf=${res.pdfStatus}${res.pdfReason ? ` (${res.pdfReason})` : ''}\n`,
    );
  process.exit(0);
}

if (require.main === module) {
  cli(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`[architecture-report] error: ${e.message || e}\n`);
    process.exit(3);
  });
}

module.exports = { build, buildHtml, inlineSvgDocument, writeMilestoneSummary, detectCurrentMilestone };
