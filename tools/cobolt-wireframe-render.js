#!/usr/bin/env node

// cobolt-wireframe-render — markdown wireframes -> reviewable HTML preview + approval workflow.
//
// Three subcommands form the user-review workflow:
//
//   render   Read _cobolt-output/latest/planning/wireframes-and-user-flows.md and emit a
//            single-page HTML preview at _cobolt-output/latest/planning/wireframes/preview.html
//            with sidebar navigation, ASCII art preserved as <pre>, design-token swatches.
//
//   approve  Write _cobolt-output/latest/planning/wireframes/WIREFRAMES-APPROVED.md sentinel
//            so cobolt-wireframe-review-gate.js unblocks /cobolt-build.
//
//   status   Report the current review state (awaiting | approved | skipped | n-a | missing).
//
// Exit codes (per tools/CLAUDE.md contract):
//   0 success
//   1 hard error (missing source artifact, malformed input, unhandled exception)
//   2 missing optional dependency  (n/a -- this tool has zero deps)
//   3 missing infrastructure       (n/a -- pure local file I/O)

const fs = require('node:fs');
const path = require('node:path');

const PLANNING_DIR = path.join('_cobolt-output', 'latest', 'planning');
const BROWNFIELD_DIR = path.join('_cobolt-output', 'latest', 'brownfield');
const WIREFRAMES_MD = path.join(PLANNING_DIR, 'wireframes-and-user-flows.md');
const PREVIEW_DIR = path.join(PLANNING_DIR, 'wireframes');
const PREVIEW_HTML = path.join(PREVIEW_DIR, 'preview.html');
const APPROVED_SENTINEL = path.join(PREVIEW_DIR, 'WIREFRAMES-APPROVED.md');
const SKIPPED_SENTINEL = path.join(PREVIEW_DIR, 'WIREFRAMES-SKIPPED.md');
const AWAITING_SENTINEL = path.join(PLANNING_DIR, 'WIREFRAMES-AWAITING-REVIEW.md');
const AUDIT_LOG = path.join('_cobolt-output', 'audit', 'wireframe-review.jsonl');

// v2.1+: per-surface fan-out. discoverSurfaces() returns the surface set for
// either greenfield or brownfield mode. When >= 1 NN-<slug>.md surface file is
// found, render() emits a multi-page preview; otherwise it falls back to the
// legacy merged-file rendering path.
const SURFACE_FILE_RE = /^(\d{2})-(.+)\.md$/;
function discoverSurfaces() {
  const candidates = [
    { mode: 'greenfield', root: PREVIEW_DIR, mergedPath: WIREFRAMES_MD },
    {
      mode: 'brownfield',
      root: path.join(BROWNFIELD_DIR, '31a-modernization-wireframes'),
      mergedPath: path.join(BROWNFIELD_DIR, '31a-modernization-wireframes-and-user-flows.md'),
    },
  ];
  for (const c of candidates) {
    if (!fs.existsSync(c.root)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(c.root, { withFileTypes: true });
    } catch {
      continue;
    }
    const files = entries.filter((e) => e.isFile() && SURFACE_FILE_RE.test(e.name)).map((e) => e.name);
    const hasFoundations = files.some((n) => n.startsWith('00-') && n.endsWith('.md'));
    const surfaceFiles = files.filter((n) => SURFACE_FILE_RE.test(n) && !n.startsWith('00-')).sort();
    const readmePath = path.join(c.root, 'README.md');
    const hasReadme = fs.existsSync(readmePath);
    if (hasFoundations || surfaceFiles.length > 0 || hasReadme) {
      return {
        mode: c.mode,
        root: c.root,
        mergedPath: c.mergedPath,
        foundations: hasFoundations
          ? path.join(
              c.root,
              files.find((n) => n.startsWith('00-')),
            )
          : null,
        readme: hasReadme ? readmePath : null,
        surfaces: surfaceFiles.map((n) => ({ name: n, path: path.join(c.root, n) })),
      };
    }
  }
  return null;
}

const USAGE = `cobolt-wireframe-render -- wireframe preview + review workflow

Usage:
  node tools/cobolt-wireframe-render.js render          [--out <path>]
  node tools/cobolt-wireframe-render.js approve         --reviewer "<name>" [--notes "<text>"]
  node tools/cobolt-wireframe-render.js skip            --reviewer "<name>" --reason "<text>"
  node tools/cobolt-wireframe-render.js status          [--json]
  node tools/cobolt-wireframe-render.js list-surfaces   [--json]
  node tools/cobolt-wireframe-render.js --help | -h
`;

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    /* best-effort */
  }
}

function appendAudit(record) {
  try {
    ensureDir(path.dirname(AUDIT_LOG));
    fs.appendFileSync(AUDIT_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}

function readMarkdown(srcPath) {
  if (!fs.existsSync(srcPath)) {
    throw new Error(`wireframes source not found at ${srcPath}. Run /cobolt-plan or /cobolt-create-wireframes first.`);
  }
  return fs.readFileSync(srcPath, 'utf8');
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

function inlineFmt(text) {
  let out = htmlEscape(text);
  out = out.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => `<a href="${href}">${label}</a>`);
  return out;
}

function renderTable(rows) {
  if (rows.length < 2) return '';
  const headerCells = rows[0]
    .slice(1, -1)
    .split('|')
    .map((c) => c.trim());
  const bodyRows = rows.slice(2).map((r) =>
    r
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim()),
  );
  let html = '<table><thead><tr>';
  for (const h of headerCells) html += `<th>${inlineFmt(h)}</th>`;
  html += '</tr></thead><tbody>';
  for (const row of bodyRows) {
    html += '<tr>';
    for (const cell of row) html += `<td>${inlineFmt(cell)}</td>`;
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

function mdToHtml(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let inFence = false;
  let fenceBuf = [];
  let listType = null;
  let listBuf = [];
  let tableBuf = [];
  let inTable = false;
  let paraBuf = [];

  function flushPara() {
    if (paraBuf.length) {
      out.push(`<p>${paraBuf.map(inlineFmt).join(' ')}</p>`);
      paraBuf = [];
    }
  }
  function flushList() {
    if (listType && listBuf.length) {
      out.push(`<${listType}>`);
      for (const item of listBuf) out.push(`<li>${inlineFmt(item)}</li>`);
      out.push(`</${listType}>`);
    }
    listType = null;
    listBuf = [];
  }
  function flushTable() {
    if (inTable && tableBuf.length) out.push(renderTable(tableBuf));
    inTable = false;
    tableBuf = [];
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.startsWith('```')) {
      if (!inFence) {
        flushPara();
        flushList();
        flushTable();
        inFence = true;
        fenceBuf = [];
      } else {
        out.push(`<pre class="wf-fence"><code>${htmlEscape(fenceBuf.join('\n'))}</code></pre>`);
        inFence = false;
        fenceBuf = [];
      }
      continue;
    }
    if (inFence) {
      fenceBuf.push(line);
      continue;
    }

    if (/^\|.*\|\s*$/.test(line)) {
      flushPara();
      flushList();
      inTable = true;
      tableBuf.push(line);
      continue;
    }
    if (inTable && line.trim() === '') {
      flushTable();
      continue;
    }
    if (inTable) {
      flushTable();
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      const level = heading[1].length;
      const text = heading[2].trim();
      const id = text
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .slice(0, 80);
      out.push(`<h${level} id="${id}">${inlineFmt(text)}</h${level}>`);
      continue;
    }

    const ulItem = /^[-*+]\s+(.*)$/.exec(line);
    const olItem = /^\d+\.\s+(.*)$/.exec(line);
    if (ulItem || olItem) {
      flushPara();
      const wantType = ulItem ? 'ul' : 'ol';
      if (listType && listType !== wantType) flushList();
      listType = wantType;
      listBuf.push((ulItem || olItem)[1]);
      continue;
    }
    if (listType && line.trim() === '') {
      flushList();
      continue;
    }

    if (line.startsWith('> ')) {
      flushPara();
      flushList();
      out.push(`<blockquote>${inlineFmt(line.slice(2))}</blockquote>`);
      continue;
    }

    if (line.trim() === '') {
      flushPara();
      flushList();
      continue;
    }

    paraBuf.push(line.trim());
  }
  flushPara();
  flushList();
  flushTable();
  if (inFence) out.push(`<pre class="wf-fence"><code>${htmlEscape(fenceBuf.join('\n'))}</code></pre>`);
  return out.join('\n');
}

function buildToc(html) {
  // Two passes (one per heading level) avoids backreferences which behave
  // inconsistently across Node releases when combined with the `g` flag and
  // alternation. Order is preserved by interleaving via index.
  const items = [];
  const re2 = /<h2\s+id="([^"]+)">([^<]+)<\/h2>/g;
  const re3 = /<h3\s+id="([^"]+)">([^<]+)<\/h3>/g;
  let m;
  while ((m = re2.exec(html)) !== null) items.push({ level: 2, id: m[1], text: m[2], at: m.index });
  while ((m = re3.exec(html)) !== null) items.push({ level: 3, id: m[1], text: m[2], at: m.index });
  items.sort((a, b) => a.at - b.at);
  if (!items.length) return '';
  const lis = items.map((it) => {
    const cls = it.level === 3 ? 'wf-toc-sub' : 'wf-toc-top';
    return `<li class="${cls}"><a href="#${it.id}">${it.text}</a></li>`;
  });
  return `<nav class="wf-toc"><h2>Contents</h2><ul>${lis.join('')}</ul></nav>`;
}

function loadDesignTokens() {
  try {
    const raw = fs.readFileSync('design-tokens.json', 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flatten(v, key));
    } else {
      out[key] = v;
    }
  }
  return out;
}

function renderTokenPanel(tokens) {
  if (!tokens) return '';
  const flat = flatten(tokens);
  const colorEntries = Object.entries(flat).filter(
    ([k, v]) => /color/i.test(k) && /^#[0-9a-fA-F]{3,8}$/.test(String(v)),
  );
  const fontEntries = Object.entries(flat)
    .filter(([k]) => /font|typography|text/i.test(k))
    .slice(0, 8);
  if (!colorEntries.length && !fontEntries.length) return '';
  let html = '<aside class="wf-tokens"><h2>Design tokens (live)</h2>';
  if (colorEntries.length) {
    html += '<h3>Colors</h3><div class="wf-swatches">';
    for (const [name, hex] of colorEntries) {
      html += `<div class="wf-swatch"><span class="wf-chip" style="background:${hex}"></span><code>${htmlEscape(name)}</code><small>${htmlEscape(String(hex))}</small></div>`;
    }
    html += '</div>';
  }
  if (fontEntries.length) {
    html += '<h3>Typography</h3><dl>';
    for (const [name, val] of fontEntries) {
      html += `<dt><code>${htmlEscape(name)}</code></dt><dd>${htmlEscape(String(val))}</dd>`;
    }
    html += '</dl>';
  }
  html += '</aside>';
  return html;
}

function isNonUiStub(md) {
  return /##\s+Non-UI Surface Map/i.test(md) && !/###\s+Screen:/i.test(md);
}

function statusFromDisk() {
  if (fs.existsSync(APPROVED_SENTINEL)) return 'approved';
  if (fs.existsSync(SKIPPED_SENTINEL)) return 'skipped';
  if (!fs.existsSync(WIREFRAMES_MD)) return 'missing';
  try {
    const md = fs.readFileSync(WIREFRAMES_MD, 'utf8');
    if (isNonUiStub(md)) return 'n-a';
  } catch {
    /* fall through */
  }
  return 'awaiting';
}

const PAGE_CSS = `
:root { --bg:#0f172a; --panel:#111827; --text:#e5e7eb; --muted:#9ca3af; --accent:#60a5fa; --border:#1f2937; --code:#0b1220; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font: 14px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.wf-shell { display: grid; grid-template-columns: 280px 1fr; min-height: 100vh; }
.wf-toc { background: var(--panel); border-right: 1px solid var(--border); padding: 16px; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
.wf-toc h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 0 0 8px; }
.wf-toc ul { list-style: none; padding: 0; margin: 0; }
.wf-toc li { padding: 2px 0; }
.wf-toc-sub { padding-left: 12px !important; font-size: 13px; }
.wf-toc a { color: var(--text); text-decoration: none; }
.wf-toc a:hover { color: var(--accent); }
.wf-main { padding: 24px 32px 64px; max-width: 1100px; }
.wf-banner { background: #1e293b; border: 1px solid var(--border); border-left: 3px solid var(--accent); padding: 12px 16px; border-radius: 4px; margin: 0 0 24px; }
.wf-banner code { background: var(--code); padding: 2px 6px; border-radius: 3px; }
h1 { font-size: 28px; margin: 0 0 16px; }
h2 { font-size: 22px; margin: 32px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
h3 { font-size: 18px; margin: 24px 0 8px; color: var(--accent); }
h4 { font-size: 15px; margin: 16px 0 6px; }
table { border-collapse: collapse; margin: 12px 0; width: 100%; }
th, td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: var(--panel); }
pre.wf-fence { background: var(--code); border: 1px solid var(--border); border-radius: 4px; padding: 12px 14px; overflow-x: auto; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 13px; line-height: 1.5; }
code { background: var(--code); padding: 1px 5px; border-radius: 3px; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 13px; }
blockquote { border-left: 3px solid var(--accent); padding: 4px 14px; color: var(--muted); margin: 12px 0; }
.wf-tokens { margin: 24px 0; padding: 16px; background: var(--panel); border-radius: 4px; border: 1px solid var(--border); }
.wf-swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; }
.wf-swatch { display: flex; align-items: center; gap: 8px; padding: 6px; border: 1px solid var(--border); border-radius: 3px; }
.wf-chip { width: 24px; height: 24px; border-radius: 3px; border: 1px solid rgba(255,255,255,0.1); flex-shrink: 0; }
.wf-actions { background: var(--panel); border: 1px solid var(--border); border-radius: 4px; padding: 12px 16px; margin-top: 32px; }
.wf-actions h2 { border: 0; margin: 0 0 8px; font-size: 16px; }
.wf-actions code { display: block; background: var(--code); padding: 8px 12px; margin: 4px 0; border-radius: 3px; }
@media print { .wf-shell { grid-template-columns: 1fr; } .wf-toc { display: none; } .wf-main { max-width: none; } }
`;

function reviewActionsBlock(status) {
  return `
<section class="wf-actions" id="review-actions">
  <h2>Review actions</h2>
  <p>Current status: <strong>${status}</strong></p>
  <p>Approve and unblock build:</p>
  <code>node tools/cobolt-wireframe-render.js approve --reviewer "Your Name" --notes "Looks good"</code>
  <p>Skip review (recorded as planning debt):</p>
  <code>node tools/cobolt-wireframe-render.js skip --reviewer "Your Name" --reason "Spike, will revisit"</code>
  <p>Re-render after editing the markdown:</p>
  <code>node tools/cobolt-wireframe-render.js render</code>
</section>`;
}

function buildHtml({ md, mtime }) {
  const status = statusFromDisk();
  const body = mdToHtml(md);
  const toc = buildToc(body);
  const tokenPanel = renderTokenPanel(loadDesignTokens());
  const generatedAt = new Date().toISOString();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Wireframes Preview -- CoBolt</title>
<meta name="generator" content="cobolt-wireframe-render">
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="wf-shell">
  ${toc || '<aside class="wf-toc"><h2>Contents</h2><p>(no headings)</p></aside>'}
  <main class="wf-main">
    <div class="wf-banner">
      Generated <code>${generatedAt}</code> from <code>${WIREFRAMES_MD.replace(/\\/g, '/')}</code>
      (source modified <code>${mtime}</code>). Status: <strong>${status}</strong>.
      Run <code>node tools/cobolt-wireframe-render.js render</code> after editing the source.
    </div>
    ${tokenPanel}
    ${body}
    ${reviewActionsBlock(status)}
  </main>
</div>
</body>
</html>`;
}

function buildMultiPageHtml(plan) {
  const status = statusFromDisk();
  const generatedAt = new Date().toISOString();
  const tokenPanel = renderTokenPanel(loadDesignTokens());
  const ordered = [];
  if (plan.readme) ordered.push({ id: 'README', label: 'README · Index', file: plan.readme });
  if (plan.foundations) ordered.push({ id: '00-foundations', label: '00 · Foundations', file: plan.foundations });
  for (const s of plan.surfaces) {
    const m = SURFACE_FILE_RE.exec(s.name);
    const seq = m ? m[1] : '';
    const slug = m ? m[2] : s.name;
    ordered.push({ id: `${seq}-${slug}`, label: `${seq} · ${slug.replace(/-/g, ' ')}`, file: s.path });
  }
  const surfaceNav = ordered.map((s) => `<li><a href="#surface-${s.id}">${htmlEscape(s.label)}</a></li>`).join('');
  const articleHtmls = [];
  for (const s of ordered) {
    let md = '';
    let mtime = '';
    try {
      md = fs.readFileSync(s.file, 'utf8');
      mtime = fs.statSync(s.file).mtime.toISOString();
    } catch {
      md = `# ${s.label}\n\n_(could not read ${s.file})_`;
    }
    const body = mdToHtml(md);
    const subToc = buildToc(body);
    articleHtmls.push(`<article class="wf-surface" id="surface-${s.id}">
  <div class="wf-surface-meta">Source: <code>${s.file.replace(/\\/g, '/')}</code> · modified <code>${mtime}</code></div>
  ${subToc}
  ${body}
</article>`);
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Wireframes Preview -- CoBolt (multi-surface)</title>
<meta name="generator" content="cobolt-wireframe-render">
<style>${PAGE_CSS}
.wf-surface { padding: 24px 0 48px; border-bottom: 2px solid var(--border); }
.wf-surface:last-child { border-bottom: 0; }
.wf-surface-meta { font-size: 12px; color: var(--muted); margin-bottom: 12px; }
nav.wf-toc { background: transparent; border-right: 0; position: relative; height: auto; }
</style>
</head>
<body>
<div class="wf-shell">
  <aside class="wf-toc">
    <h2>Surfaces</h2>
    <ul>${surfaceNav}</ul>
  </aside>
  <main class="wf-main">
    <div class="wf-banner">
      Generated <code>${generatedAt}</code> · Mode: <strong>${plan.mode}</strong> · ${ordered.length} surface(s) · Status: <strong>${status}</strong>.
    </div>
    ${tokenPanel}
    ${articleHtmls.join('\n')}
    ${reviewActionsBlock(status)}
  </main>
</div>
</body>
</html>`;
}

function cmdRender(args) {
  const outFlag = args.indexOf('--out');
  const plan = discoverSurfaces();
  if (plan && (plan.foundations || plan.surfaces.length > 0 || plan.readme)) {
    const outPath = outFlag > -1 && args[outFlag + 1] ? args[outFlag + 1] : path.join(plan.root, 'preview.html');
    const html = buildMultiPageHtml(plan);
    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, html, { mode: 0o600 });
    appendAudit({
      event: 'render',
      mode: plan.mode,
      multiPage: true,
      surfaces: plan.surfaces.map((s) => s.name),
      outPath,
      status: statusFromDisk(),
      bytes: html.length,
    });
    process.stdout.write(
      `[wireframe-render] wrote ${outPath} (${html.length} bytes, mode=${plan.mode}, surfaces=${plan.surfaces.length}, status=${statusFromDisk()})\n`,
    );
    return 0;
  }
  const outPath = outFlag > -1 && args[outFlag + 1] ? args[outFlag + 1] : PREVIEW_HTML;
  const md = readMarkdown(WIREFRAMES_MD);
  const mtime = fs.statSync(WIREFRAMES_MD).mtime.toISOString();
  const html = buildHtml({ md, mtime });
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, html, { mode: 0o600 });
  appendAudit({
    event: 'render',
    mode: 'legacy-merged',
    multiPage: false,
    outPath,
    status: statusFromDisk(),
    bytes: html.length,
  });
  process.stdout.write(
    `[wireframe-render] wrote ${outPath} (${html.length} bytes, mode=legacy-merged, status=${statusFromDisk()})\n`,
  );
  return 0;
}

function cmdListSurfaces(args) {
  const plan = discoverSurfaces();
  const wantJson = args.includes('--json');
  const payload = plan
    ? {
        mode: plan.mode,
        root: plan.root.replace(/\\/g, '/'),
        foundations: plan.foundations ? plan.foundations.replace(/\\/g, '/') : null,
        readme: plan.readme ? plan.readme.replace(/\\/g, '/') : null,
        surfaces: plan.surfaces.map((s) => ({
          name: s.name,
          path: s.path.replace(/\\/g, '/'),
        })),
      }
    : { mode: null, root: null, foundations: null, readme: null, surfaces: [] };
  if (wantJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (!plan) {
    process.stdout.write('[wireframe-render] no per-surface wireframes found (legacy merged-file mode active)\n');
  } else {
    process.stdout.write(
      `[wireframe-render] mode=${plan.mode} surfaces=${plan.surfaces.length} foundations=${plan.foundations ? 'yes' : 'no'} readme=${plan.readme ? 'yes' : 'no'}\n`,
    );
    for (const s of plan.surfaces) process.stdout.write(`  - ${s.name}\n`);
  }
  return 0;
}

function flagValue(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  if (!v || v.startsWith('--')) return null;
  return v;
}

function cmdApprove(args) {
  const reviewer = flagValue(args, '--reviewer');
  const notes = flagValue(args, '--notes') || '';
  if (!reviewer) {
    process.stderr.write('error: --reviewer "<name>" is required for approve\n');
    return 1;
  }
  if (!fs.existsSync(WIREFRAMES_MD)) {
    process.stderr.write(`error: cannot approve -- ${WIREFRAMES_MD} does not exist\n`);
    return 1;
  }
  ensureDir(PREVIEW_DIR);
  const at = new Date().toISOString();
  const body = `# Wireframes Approved

- Reviewer: ${reviewer}
- Approved at: ${at}
- Source: ${WIREFRAMES_MD.replace(/\\/g, '/')}
- Source mtime: ${fs.statSync(WIREFRAMES_MD).mtime.toISOString()}
- Notes: ${notes || '(none)'}

This sentinel unblocks the cobolt-wireframe-review-gate. To re-trigger review,
delete this file and re-run /cobolt-plan or edit the wireframes source.
`;
  fs.writeFileSync(APPROVED_SENTINEL, body, { mode: 0o600 });
  try {
    if (fs.existsSync(SKIPPED_SENTINEL)) fs.unlinkSync(SKIPPED_SENTINEL);
  } catch {
    /* best-effort */
  }
  try {
    if (fs.existsSync(AWAITING_SENTINEL)) fs.unlinkSync(AWAITING_SENTINEL);
  } catch {
    /* best-effort */
  }
  appendAudit({ event: 'approve', reviewer, notes });
  process.stdout.write(`[wireframe-render] approved by ${reviewer} -> ${APPROVED_SENTINEL}\n`);
  return 0;
}

function cmdSkip(args) {
  const reviewer = flagValue(args, '--reviewer');
  const reason = flagValue(args, '--reason');
  if (!reviewer || !reason) {
    process.stderr.write('error: --reviewer "<name>" and --reason "<text>" are both required for skip\n');
    return 1;
  }
  ensureDir(PREVIEW_DIR);
  const at = new Date().toISOString();
  const body = `# Wireframes Review Skipped (planning debt)

- Reviewer: ${reviewer}
- Skipped at: ${at}
- Reason: ${reason}

This sentinel unblocks the cobolt-wireframe-review-gate but records the skip
as planning debt. Replace with WIREFRAMES-APPROVED.md once a real review is performed.
`;
  fs.writeFileSync(SKIPPED_SENTINEL, body, { mode: 0o600 });
  const debtPath = path.join('_cobolt-output', 'audit', 'planning-debt.jsonl');
  try {
    ensureDir(path.dirname(debtPath));
    fs.appendFileSync(debtPath, `${JSON.stringify({ at, kind: 'wireframe-review-skipped', reviewer, reason })}\n`, {
      mode: 0o600,
    });
  } catch {
    /* best-effort */
  }
  appendAudit({ event: 'skip', reviewer, reason });
  process.stdout.write(`[wireframe-render] skipped by ${reviewer} (debt recorded) -> ${SKIPPED_SENTINEL}\n`);
  return 0;
}

function cmdStatus(args) {
  const status = statusFromDisk();
  const wantJson = args.includes('--json');
  const payload = {
    status,
    source: WIREFRAMES_MD.replace(/\\/g, '/'),
    sourceExists: fs.existsSync(WIREFRAMES_MD),
    preview: PREVIEW_HTML.replace(/\\/g, '/'),
    previewExists: fs.existsSync(PREVIEW_HTML),
    approvedSentinel: APPROVED_SENTINEL.replace(/\\/g, '/'),
    skippedSentinel: SKIPPED_SENTINEL.replace(/\\/g, '/'),
    awaitingSentinel: AWAITING_SENTINEL.replace(/\\/g, '/'),
  };
  if (wantJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(
      `[wireframe-render] status=${status} source=${payload.source} preview=${payload.previewExists ? payload.preview : '(not rendered)'}\n`,
    );
  }
  return 0;
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  const sub = args[0];
  const rest = args.slice(1);
  try {
    switch (sub) {
      case 'render':
        return cmdRender(rest);
      case 'approve':
        return cmdApprove(rest);
      case 'skip':
        return cmdSkip(rest);
      case 'status':
        return cmdStatus(rest);
      case 'list-surfaces':
        return cmdListSurfaces(rest);
      default:
        process.stderr.write(`unknown subcommand: ${sub}\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    process.stderr.write(`[wireframe-render] error: ${err.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = {
  main,
  mdToHtml,
  buildToc,
  isNonUiStub,
  statusFromDisk,
  discoverSurfaces,
  buildMultiPageHtml,
  PLANNING_DIR,
  BROWNFIELD_DIR,
  WIREFRAMES_MD,
  PREVIEW_DIR,
  PREVIEW_HTML,
  APPROVED_SENTINEL,
  SKIPPED_SENTINEL,
  AWAITING_SENTINEL,
};
