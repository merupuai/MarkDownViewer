import Electrobun, { Electroview } from "electrobun/view";
import mermaid from "mermaid";
import DOMPurify from "isomorphic-dompurify";
import type { AppRPC, FilePayload, FolderPayload, TreeNode, RecentEntry, SearchResults } from "../../src/shared/rpc";
import { buildMarkdown, parseDocument, renderFrontMatterCard } from "./markdown";
import { createFindController } from "./find-in-doc";
import { createLightbox } from "./lightbox";
import { renderSafe as renderSafeMermaid } from "./mermaid-render";

// ============== RPC ==============
const rpc = Electroview.defineRPC<AppRPC>({
	maxRequestTime: 15000,
	handlers: {
		requests: {},
		messages: {
			fileOpened: (data) => renderFile(data),
			fileChanged: (data) => renderFile(data, { preserveScroll: true }),
			folderOpened: (data) => renderFolder(data, true),
			folderUpdated: (data) => renderFolder(data, false),
			menuAction: ({ action }) => handleMenuAction(action),
			windowStateChanged: ({ maximized }) => {
				const bar = document.getElementById("titlebar");
				if (bar) bar.dataset.maximized = maximized ? "true" : "false";
			},
		},
	},
});
const electroview = new Electrobun.Electroview({ rpc });

// ============== Pipe view logs/errors to bun log file ==============
function rlog(level: "info" | "warn" | "error", ...args: unknown[]) {
	const msg = args.map((a) => { try { return typeof a === "string" ? a : JSON.stringify(a); } catch { return String(a); } }).join(" ");
	try { electroview.rpc?.send.log({ level, msg }); } catch {}
}
const _origLog = console.log; const _origWarn = console.warn; const _origError = console.error;
console.log = (...a: unknown[]) => { rlog("info", ...a); _origLog(...a); };
console.warn = (...a: unknown[]) => { rlog("warn", ...a); _origWarn(...a); };
console.error = (...a: unknown[]) => { rlog("error", ...a); _origError(...a); };
window.addEventListener("error", (e) => rlog("error", "window.error:", e.message, e.filename, e.lineno));
window.addEventListener("unhandledrejection", (e) => rlog("error", "unhandledrejection:", String((e as any).reason)));

// ============== Theme ==============
type ThemeMode = "auto" | "light" | "dark";
let currentTheme: ThemeMode = "auto";

function effectiveTheme(): "light" | "dark" {
	if (currentTheme === "auto") return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
	return currentTheme;
}
function applyTheme(mode: ThemeMode) {
	currentTheme = mode;
	document.body.classList.remove("theme-auto");
	if (mode === "auto") { document.body.classList.add("theme-auto"); document.body.removeAttribute("data-theme"); }
	else document.body.setAttribute("data-theme", mode);
	configureMermaid();
	if (lastPayload) renderFile(lastPayload, { preserveScroll: true });
}
function toggleTheme() {
	applyTheme(effectiveTheme() === "dark" ? "light" : "dark");
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
	if (currentTheme === "auto") {
		configureMermaid();
		if (lastPayload) renderFile(lastPayload, { preserveScroll: true });
	}
});

// ============== Mermaid ==============
function configureMermaid() {
	mermaid.initialize({
		startOnLoad: false,
		theme: effectiveTheme() === "dark" ? "dark" : "default",
		securityLevel: "loose",
		fontFamily: "var(--font-sans)",
	});
}
configureMermaid();

// ============== DOMPurify hardening (M1.S2 — closes SEC-003 / FR-05) ==============
// The ADD_ATTR allowlist below permits the `style` attribute, which by itself
// would let a hostile markdown file ship `style="background:url(http://evil)"`
// or `style="@import url(...)"` to phone home. CSP (M1.S1) blocks the network
// fetch, but defense-in-depth: strip url() / @import / expression() / behavior:
// from style values before the attribute reaches the DOM.
const STYLE_FORBIDDEN = /(?:url\s*\(|@import|expression\s*\(|behavior\s*:|-moz-binding)/i;
DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
	if (data.attrName !== "style") return;
	const value = String(data.attrValue || "");
	if (STYLE_FORBIDDEN.test(value)) {
		// Drop the attribute entirely rather than try to surgically remove
		// only the offending declarations — easier to audit, no parser bugs.
		data.keepAttr = false;
		data.attrValue = "";
	}
});

// ============== Markdown pipeline ==============
const md = buildMarkdown();

// ============== DOM refs ==============
const contentEl = document.getElementById("content") as HTMLElement;
const tocEl = document.getElementById("toc") as HTMLElement;
const openBtn = document.getElementById("open-btn") as HTMLButtonElement;
const openFolderBtn = document.getElementById("open-folder-btn") as HTMLButtonElement;
const filesEmptyOpen = document.getElementById("files-empty-open") as HTMLButtonElement;
const themeBtn = document.getElementById("theme-btn") as HTMLButtonElement;
const dropzoneEl = document.getElementById("dropzone") as HTMLElement;
const contentPane = document.getElementById("content-pane") as HTMLElement;
const statusPath = document.getElementById("status-path") as HTMLElement;
const statusStats = document.getElementById("status-stats") as HTMLElement;
const statusZoom = document.getElementById("status-zoom") as HTMLElement;
const appEl = document.querySelector(".app") as HTMLElement;
const folderSection = document.getElementById("folder-section") as HTMLElement;
const folderLabel = document.getElementById("folder-label") as HTMLElement;
const folderTruncated = document.getElementById("folder-truncated") as HTMLElement;
const fileTreeEl = document.getElementById("file-tree") as HTMLElement;
const filesEmpty = document.getElementById("files-empty") as HTMLElement;
const treeFilter = document.getElementById("tree-filter") as HTMLInputElement;
const tabs = Array.from(document.querySelectorAll<HTMLElement>(".tab-btn"));
const panes = Array.from(document.querySelectorAll<HTMLElement>(".tab-pane"));
const folderSearchInput = document.getElementById("folder-search-input") as HTMLInputElement;
const folderSearchCase = document.getElementById("search-case") as HTMLInputElement;
const folderSearchWord = document.getElementById("search-word") as HTMLInputElement;
const folderSearchStatus = document.getElementById("folder-search-status") as HTMLElement;
const folderSearchResults = document.getElementById("folder-search-results") as HTMLElement;
const recentList = document.getElementById("recent-list") as HTMLElement;
const clearRecentBtn = document.getElementById("clear-recent") as HTMLButtonElement;
const welcomeRecent = document.getElementById("welcome-recent") as HTMLElement;
const welcomeRecentList = document.getElementById("welcome-recent-list") as HTMLElement;
const findBar = document.getElementById("find-bar") as HTMLElement;
const findInput = document.getElementById("find-input") as HTMLInputElement;
const findCount = document.getElementById("find-count") as HTMLElement;
const findPrev = document.getElementById("find-prev") as HTMLButtonElement;
const findNext = document.getElementById("find-next") as HTMLButtonElement;
const findClose = document.getElementById("find-close") as HTMLButtonElement;
const lightboxEl = document.getElementById("lightbox") as HTMLElement;
const lightboxClose = document.getElementById("lightbox-close") as HTMLButtonElement;
const lightboxTitle = document.getElementById("lightbox-title") as HTMLElement;
const lightboxStage = document.getElementById("lightbox-stage") as HTMLElement;
const resizeHandle = document.getElementById("resize-handle") as HTMLElement;

// ============== State ==============
let lastPayload: FilePayload | null = null;
let currentFolder: FolderPayload | null = null;
let zoom = 1;
let activeFilePath: string | null = null;

const find = createFindController({
	contentEl,
	contentScroller: contentPane,
	barEl: findBar,
	inputEl: findInput,
	countEl: findCount,
	prevBtn: findPrev,
	nextBtn: findNext,
	closeBtn: findClose,
});

const lightbox = createLightbox({
	rootEl: lightboxEl,
	closeBtn: lightboxClose,
	titleEl: lightboxTitle,
	stageEl: lightboxStage,
});

function setZoom(z: number) {
	zoom = Math.max(0.6, Math.min(2.5, z));
	contentEl.style.fontSize = `${15 * zoom}px`;
	statusZoom.textContent = `${Math.round(zoom * 100)}%`;
}

// ============== Sidebar tabs ==============
function selectTab(name: string) {
	tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
	panes.forEach((p) => { p.hidden = p.dataset.pane !== name; });
	if (name === "recent") refreshRecent();
}
tabs.forEach((t) => t.addEventListener("click", () => selectTab(t.dataset.tab || "files")));

// ============== Sidebar resize ==============
let resizing = false;
resizeHandle.addEventListener("mousedown", (e) => {
	resizing = true;
	resizeHandle.classList.add("dragging");
	e.preventDefault();
});
window.addEventListener("mousemove", (e) => {
	if (!resizing) return;
	const w = Math.max(180, Math.min(560, e.clientX));
	document.documentElement.style.setProperty("--sidebar-w", `${w}px`);
});
window.addEventListener("mouseup", () => {
	if (resizing) {
		resizing = false;
		resizeHandle.classList.remove("dragging");
		try { localStorage.setItem("sidebar-w", document.documentElement.style.getPropertyValue("--sidebar-w")); } catch {}
	}
});
// M1.S8: keyboard control for the resize handle. ←/→ nudge by 16 px,
// Home/End jump to the min/max so keyboard-only users can adjust the sidebar.
resizeHandle.addEventListener("keydown", (e) => {
	const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w"), 10) || 260;
	let next = current;
	if (e.key === "ArrowLeft") next = current - 16;
	else if (e.key === "ArrowRight") next = current + 16;
	else if (e.key === "Home") next = 180;
	else if (e.key === "End") next = 560;
	else return;
	e.preventDefault();
	const clamped = Math.max(180, Math.min(560, next));
	document.documentElement.style.setProperty("--sidebar-w", `${clamped}px`);
	try { localStorage.setItem("sidebar-w", `${clamped}px`); } catch {}
});
const savedW = (() => { try { return localStorage.getItem("sidebar-w"); } catch { return null; } })();
if (savedW) document.documentElement.style.setProperty("--sidebar-w", savedW);

// ============== Rendering ==============
async function renderFile(payload: FilePayload, opts: { preserveScroll?: boolean } = {}) {
	lastPayload = payload;

	if (payload.error) {
		contentEl.classList.remove("welcome");
		contentEl.innerHTML = `<h1>Cannot open file</h1><p>${escAttr(payload.error)}</p><p><code>${escAttr(payload.path)}</code></p>`;
		statusPath.textContent = payload.path;
		statusStats.textContent = "";
		buildTOC();
		return;
	}

	const prevScroll = opts.preserveScroll ? contentPane.scrollTop : 0;
	contentEl.classList.remove("welcome");

	rlog("info", `renderFile: ${payload.path} (${payload.content.length} bytes)`);
	const t0 = performance.now();
	const parsed = parseDocument(md, payload.content);
	const t1 = performance.now();
	rlog("info", `parsed in ${(t1 - t0).toFixed(1)}ms; html=${parsed.html.length}b; frontmatter=${parsed.frontMatter ? Object.keys(parsed.frontMatter).length + " keys" : "none"}`);
	const fmHtml = renderFrontMatterCard(parsed.frontMatter);
	// M1.S6 (closes SEC-004 / FR-07): user-visible error banner when the YAML
	// front-matter block is malformed. We DO NOT include the offending body
	// (IR-07-02 — could leak secrets the user accidentally typed). The body
	// still renders below.
	const fmErrorHtml = parsed.frontMatterError
		? `<aside class="fm-error" role="status" aria-live="polite">⚠ Front-matter parse error: ${escAttr(parsed.frontMatterError)}<br><span class="fm-error-hint">The file is rendered without front-matter.</span></aside>`
		: "";
	const safeBody = DOMPurify.sanitize(parsed.html, {
		ADD_ATTR: ["target", "data-external", "data-mermaid-src-b64", "data-rel-src", "data-internal-md", "data-wikilink", "data-alert", "data-alert-icon", "class", "id", "style", "align", "width", "height", "valign", "src", "alt", "title", "href", "rel"],
		ADD_TAGS: ["div", "span", "section", "aside", "details", "summary", "img", "a", "p", "br", "table", "thead", "tbody", "tr", "td", "th", "picture", "source"],
		FORBID_TAGS: ["script", "iframe", "object", "embed"],
		ALLOW_DATA_ATTR: true,
	});
	const stripped = parsed.html.length - safeBody.length;
	if (stripped > 0) {
		// Find which tags/attrs got stripped — diff sample
		const rawTags = (parsed.html.match(/<[a-z][a-z0-9-]*/gi) || []).length;
		const safeTags = (safeBody.match(/<[a-z][a-z0-9-]*/gi) || []).length;
		rlog("warn", `DOMPurify stripped ${stripped} chars (raw tags=${rawTags}, safe tags=${safeTags})`);
	}
	contentEl.innerHTML = fmErrorHtml + fmHtml + safeBody;

	statusPath.textContent = payload.path;
	statusStats.textContent = computeStats(parsed.body);
	document.title = payload.path.split("/").pop() || "Markdown Viewer";
	highlightActiveFile(payload.path);

	wireCodeCopyButtons();
	wireWikilinks();
	await resolveImages(payload.path);
	await renderMermaidBlocks();
	buildTOC();

	// Final render report
	const counts = {
		headings: contentEl.querySelectorAll("h1, h2, h3, h4, h5, h6").length,
		paragraphs: contentEl.querySelectorAll("p").length,
		links: contentEl.querySelectorAll("a").length,
		images: contentEl.querySelectorAll("img").length,
		brokenImages: contentEl.querySelectorAll("img.broken").length,
		codeBlocks: contentEl.querySelectorAll(".code-block-wrap").length,
		mermaidBlocks: contentEl.querySelectorAll(".mermaid-wrap").length,
		mermaidErrors: contentEl.querySelectorAll(".mermaid-error").length,
		tables: contentEl.querySelectorAll("table").length,
		alerts: contentEl.querySelectorAll(".gfm-alert").length,
		mathInline: contentEl.querySelectorAll(".katex").length,
		mathDisplay: contentEl.querySelectorAll(".katex-display").length,
		wikilinks: contentEl.querySelectorAll("a.wikilink").length,
	};
	rlog("info", "render report:", counts);

	contentPane.scrollTop = opts.preserveScroll ? prevScroll : 0;
}

function escAttr(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function computeStats(text: string): string {
	const words = (text.match(/\S+/g) || []).length;
	const minutes = Math.max(1, Math.round(words / 200));
	const lines = text.split(/\r?\n/).length;
	return `${words.toLocaleString()} words · ${lines.toLocaleString()} lines · ${minutes} min read`;
}

async function renderMermaidBlocks() {
	const blocks = Array.from(contentEl.querySelectorAll<HTMLElement>(".mermaid-pending"));
	rlog("info", `mermaid: ${blocks.length} blocks to render`);
	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
		const b64 = block.getAttribute("data-mermaid-src-b64") || "";
		let src = "";
		try { src = decodeURIComponent(escape(atob(b64))); } catch { src = ""; }
		const id = `mermaid-${Date.now()}-${i}`;
		// M1.S3 (closes SEC-001): route through renderSafeMermaid so the SVG
		// is re-sanitized via DOMPurify (SVG profile) BEFORE it touches the DOM.
		// We then parse the sanitized string with DOMParser and append the
		// resulting <svg> node — never assigning innerHTML — so no fresh HTML
		// parsing ever runs against attacker-derivable text.
		const result = await renderSafeMermaid(id, src);
		if (result.ok) {
			const wrap = document.createElement("div");
			wrap.className = "mermaid-wrap";
			const parsed = new DOMParser().parseFromString(result.safeSvg, "image/svg+xml");
			const svgRoot = parsed.documentElement;
			if (svgRoot && svgRoot.nodeName.toLowerCase() === "svg") {
				wrap.appendChild(svgRoot);
			} else {
				rlog("error", `mermaid #${i} produced non-SVG root after sanitize`);
			}
			wrap.addEventListener("click", () => {
				const inner = wrap.querySelector("svg");
				if (inner) lightbox.open(inner, "Diagram");
			});
			wrap.setAttribute("data-mermaid-src-b64", b64);
			block.replaceWith(wrap);
			rlog("info", `mermaid #${i} OK (${src.length} chars; sanitizer stripped ${result.stripped})`);
		} else {
			rlog("error", `mermaid #${i} FAILED: ${result.error.split("\n")[0]} | first line: ${result.firstSourceLine}`);
			const errBox = document.createElement("div");
			errBox.className = "mermaid-error";
			errBox.textContent = `Mermaid render error:\n${result.error}\n\nSource:\n${src}`;
			block.replaceWith(errBox);
		}
	}
}

function decodeAttr(s: string): string {
	return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function wireCodeCopyButtons() {
	const buttons = contentEl.querySelectorAll<HTMLButtonElement>(".code-copy-btn");
	buttons.forEach((btn) => {
		btn.addEventListener("click", async (e) => {
			e.preventDefault();
			const wrap = btn.closest(".code-block-wrap");
			const code = wrap?.querySelector("code");
			if (!code) return;
			try {
				await navigator.clipboard.writeText(code.textContent || "");
				const orig = btn.textContent;
				btn.textContent = "Copied";
				btn.classList.add("copied");
				setTimeout(() => { btn.textContent = orig || "Copy"; btn.classList.remove("copied"); }, 1500);
			} catch {}
		});
	});
}

function wireWikilinks() {
	const links = contentEl.querySelectorAll<HTMLAnchorElement>("a.wikilink");
	if (!currentFolder) {
		links.forEach((a) => a.classList.add("broken"));
		return;
	}
	const allFiles = collectFiles(currentFolder.tree);
	links.forEach((a) => {
		const target = (a.getAttribute("href") || "").trim();
		if (!target) return;
		const lower = target.toLowerCase();
		const match = allFiles.find((f) =>
			f.name.toLowerCase() === lower ||
			f.name.toLowerCase() === `${lower}.md` ||
			f.name.toLowerCase().replace(/\.[^.]+$/, "") === lower
		);
		if (match) {
			a.dataset.wikilinkResolved = match.path;
		} else {
			a.classList.add("broken");
			a.title = `No file matches: ${target}`;
		}
	});
}

function collectFiles(tree: TreeNode[]): { name: string; path: string }[] {
	const result: { name: string; path: string }[] = [];
	function walk(nodes: TreeNode[]) {
		for (const n of nodes) {
			if (n.type === "file") result.push({ name: n.name, path: n.path });
			else walk(n.children);
		}
	}
	walk(tree);
	return result;
}

async function resolveImages(docPath: string) {
	// Walk ALL <img> tags (markdown-emitted AND inline HTML).
	// Resolve any src that isn't already absolute (http/https/data/file/views).
	const imgs = Array.from(contentEl.querySelectorAll<HTMLImageElement>("img"));
	rlog("info", `resolveImages: ${imgs.length} <img> tags found in ${docPath}`);
	let resolved = 0, skipped = 0, failed = 0;
	for (const img of imgs) {
		const rawSrc = img.getAttribute("src") || "";
		if (!rawSrc) { skipped++; continue; }
		if (/^(https?:|data:|file:|views:|blob:)/i.test(rawSrc)) { skipped++; continue; }
		try {
			const result = await electroview.rpc!.request.resolveImage({ docPath, src: rawSrc });
			if ("dataUrl" in result) {
				img.src = result.dataUrl;
				resolved++;
			} else {
				img.classList.add("broken");
				img.title = result.error;
				img.alt = img.alt || `[image not found: ${rawSrc}]`;
				failed++;
				rlog("warn", `image resolve failed: ${rawSrc} -> ${result.error}`);
			}
		} catch (err) {
			img.classList.add("broken");
			failed++;
			rlog("error", `image resolve threw: ${rawSrc}`, String(err));
		}
	}
	rlog("info", `resolveImages done: resolved=${resolved} skipped=${skipped} failed=${failed}`);
	// Click image to enlarge (skip when wrapped in a link)
	contentEl.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
		if (img.closest("a")) return; // links handle their own click
		img.addEventListener("click", () => {
			if (!img.src) return;
			const wrap = document.createElement("div");
			wrap.style.cssText = "background:var(--bg);width:100%;height:100%;display:flex;align-items:center;justify-content:center;padding:24px;";
			const big = document.createElement("img");
			big.src = img.src;
			big.style.cssText = "max-width:100%;max-height:100%;cursor:zoom-out;";
			wrap.appendChild(big);
			lightboxStage.innerHTML = "";
			lightboxStage.appendChild(wrap);
			lightboxTitle.textContent = img.alt || "Image";
			lightboxEl.hidden = false;
		});
	});
}

// ============== TOC ==============
function buildTOC() {
	tocEl.innerHTML = "";
	const headings = Array.from(contentEl.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"));
	if (headings.length === 0) {
		const empty = document.createElement("div");
		empty.className = "toc-item";
		empty.style.color = "var(--text-faint)";
		empty.style.fontStyle = "italic";
		empty.textContent = "No headings";
		tocEl.appendChild(empty);
		return;
	}
	for (const h of headings) {
		const level = Number(h.tagName.substring(1));
		const link = document.createElement("a");
		link.className = `toc-item level-${level}`;
		link.textContent = h.textContent || "";
		link.href = `#${h.id}`;
		link.addEventListener("click", (e) => {
			e.preventDefault();
			h.scrollIntoView({ behavior: "smooth", block: "start" });
		});
		tocEl.appendChild(link);
	}
	updateActiveTOC();
}

function updateActiveTOC() {
	const headings = Array.from(contentEl.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"));
	const tocItems = Array.from(tocEl.querySelectorAll(".toc-item")) as HTMLElement[];
	const scrollTop = contentPane.scrollTop;
	let active = -1;
	for (let i = 0; i < headings.length; i++) {
		const top = headings[i].offsetTop - 40;
		if (top <= scrollTop) active = i;
		else break;
	}
	tocItems.forEach((el, i) => el.classList.toggle("active", i === active));
}
contentPane.addEventListener("scroll", () => requestAnimationFrame(updateActiveTOC));

// ============== File tree ==============
const FILE_ICON_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
const FOLDER_ICON_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
const CHEV_SVG = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

function renderFolder(payload: FolderPayload, switchTab: boolean) {
	currentFolder = payload;
	folderSection.hidden = false;
	filesEmpty.hidden = true;
	const rootName = payload.root.split("/").filter(Boolean).pop() || payload.root;
	folderLabel.textContent = rootName;
	folderLabel.title = payload.root;
	folderTruncated.hidden = !payload.truncated;
	folderTruncated.title = payload.truncated ? `Showing first ${payload.count} files; some omitted` : "";
	fileTreeEl.innerHTML = "";
	if (payload.tree.length === 0) {
		const empty = document.createElement("div");
		empty.className = "tree-empty";
		empty.textContent = "No markdown files found";
		fileTreeEl.appendChild(empty);
	} else {
		for (const node of payload.tree) fileTreeEl.appendChild(renderTreeNode(node, 0));
	}
	if (switchTab) selectTab("files");
	if (lastPayload) wireWikilinks();
	applyTreeFilter(treeFilter.value);
}

function renderTreeNode(node: TreeNode, depth: number): HTMLElement {
	const wrap = document.createElement("div");
	wrap.className = "tree-node";
	const row = document.createElement("div");
	row.className = "tree-row";
	row.title = node.path;
	row.dataset.nodePath = node.path;
	row.dataset.nodeName = node.name.toLowerCase();

	if (node.type === "dir") {
		const chev = document.createElement("span");
		chev.className = "chev collapsed";
		chev.innerHTML = CHEV_SVG;
		const icon = document.createElement("span");
		icon.className = "icon";
		icon.innerHTML = FOLDER_ICON_SVG;
		const name = document.createElement("span");
		name.className = "name";
		name.textContent = node.name;
		row.append(chev, icon, name);
		const children = document.createElement("div");
		children.className = "tree-children collapsed";
		for (const child of node.children) children.appendChild(renderTreeNode(child, depth + 1));
		row.addEventListener("click", () => {
			const collapsed = children.classList.toggle("collapsed");
			chev.classList.toggle("collapsed", collapsed);
		});
		row.addEventListener("contextmenu", (e) => { e.preventDefault(); revealInFinder(node.path); });
		wrap.append(row, children);
	} else {
		const spacer = document.createElement("span");
		spacer.className = "chev";
		const icon = document.createElement("span");
		icon.className = "icon";
		icon.innerHTML = FILE_ICON_SVG;
		const name = document.createElement("span");
		name.className = "name";
		name.textContent = node.name;
		row.append(spacer, icon, name);
		row.dataset.filePath = node.path;
		if (activeFilePath === node.path) row.classList.add("active");
		row.addEventListener("click", async () => {
			const result = await electroview.rpc!.request.readFile({ path: node.path });
			renderFile(result);
		});
		row.addEventListener("contextmenu", (e) => { e.preventDefault(); revealInFinder(node.path); });
		wrap.append(row);
	}
	return wrap;
}

function highlightActiveFile(path: string | null) {
	activeFilePath = path;
	const rows = fileTreeEl.querySelectorAll<HTMLElement>(".tree-row[data-file-path]");
	rows.forEach((r) => r.classList.toggle("active", r.dataset.filePath === path));
}

function applyTreeFilter(query: string) {
	const q = query.trim().toLowerCase();
	const allRows = fileTreeEl.querySelectorAll<HTMLElement>(".tree-row");
	if (!q) { allRows.forEach((r) => r.classList.remove("hidden")); return; }
	// Hide rows that don't match; expand parents to keep matches visible.
	allRows.forEach((r) => r.classList.add("hidden"));
	const fileRows = fileTreeEl.querySelectorAll<HTMLElement>(".tree-row[data-file-path]");
	fileRows.forEach((r) => {
		if ((r.dataset.nodeName || "").includes(q)) {
			r.classList.remove("hidden");
			let parent = r.parentElement;
			while (parent && parent !== fileTreeEl) {
				if (parent.classList.contains("tree-children")) parent.classList.remove("collapsed");
				if (parent.classList.contains("tree-node")) {
					const head = parent.querySelector(":scope > .tree-row");
					if (head) {
						head.classList.remove("hidden");
						const chev = head.querySelector(".chev");
						chev?.classList.remove("collapsed");
					}
				}
				parent = parent.parentElement;
			}
		}
	});
}
treeFilter.addEventListener("input", () => applyTreeFilter(treeFilter.value));

// ============== Folder search ==============
let searchDebounce: ReturnType<typeof setTimeout> | null = null;
function scheduleFolderSearch() {
	if (searchDebounce) clearTimeout(searchDebounce);
	searchDebounce = setTimeout(runFolderSearch, 250);
}
async function runFolderSearch() {
	const q = folderSearchInput.value.trim();
	folderSearchResults.innerHTML = "";
	if (!q) { folderSearchStatus.textContent = ""; return; }
	if (!currentFolder) { folderSearchStatus.textContent = "Open a folder first"; return; }
	folderSearchStatus.textContent = "Searching…";
	const result: SearchResults = await electroview.rpc!.request.searchFolder({
		root: currentFolder.root,
		query: q,
		caseSensitive: folderSearchCase.checked,
		wholeWord: folderSearchWord.checked,
	});
	const totalMatches = result.hits.reduce((a, h) => a + h.matches.length, 0);
	folderSearchStatus.textContent = `${totalMatches.toLocaleString()} matches in ${result.matched.toLocaleString()} files${result.truncated ? " (truncated)" : ""}`;
	for (const file of result.hits) {
		const card = document.createElement("div");
		card.className = "search-file";
		const head = document.createElement("div");
		head.className = "search-file-head";
		const name = document.createElement("span");
		name.className = "search-file-name";
		name.textContent = file.name;
		name.title = file.path;
		const cnt = document.createElement("span");
		cnt.className = "search-file-count";
		cnt.textContent = String(file.matches.length);
		head.append(name, cnt);
		head.addEventListener("click", async () => {
			const r = await electroview.rpc!.request.readFile({ path: file.path });
			renderFile(r);
			setTimeout(() => find.setQuery(q), 100);
			find.open();
		});
		card.appendChild(head);
		for (const m of file.matches.slice(0, 12)) {
			const matchEl = document.createElement("div");
			matchEl.className = "search-match";
			const lineEl = document.createElement("span");
			lineEl.className = "search-match-line";
			lineEl.textContent = `${m.line}:`;
			const textEl = document.createElement("span");
			textEl.className = "search-match-text";
			textEl.innerHTML = highlightInPreview(m.preview, q, !!folderSearchCase.checked);
			matchEl.append(lineEl, textEl);
			matchEl.addEventListener("click", async () => {
				const r = await electroview.rpc!.request.readFile({ path: file.path });
				renderFile(r);
				setTimeout(() => find.setQuery(q), 100);
				find.open();
			});
			card.appendChild(matchEl);
		}
		folderSearchResults.appendChild(card);
	}
}
folderSearchInput.addEventListener("input", scheduleFolderSearch);
folderSearchCase.addEventListener("change", scheduleFolderSearch);
folderSearchWord.addEventListener("change", scheduleFolderSearch);

function highlightInPreview(s: string, q: string, caseSensitive: boolean): string {
	const escapedHtml = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	if (!q) return escapedHtml;
	const escapedQuery = q.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
	const re = new RegExp(escapedQuery, caseSensitive ? "g" : "gi");
	return escapedHtml.replace(re, (m) => `<mark>${m}</mark>`);
}

// ============== Recent files ==============
async function refreshRecent() {
	const entries = await electroview.rpc!.request.getRecent({});
	renderRecentInto(recentList, entries, true);
	if (entries.length > 0) {
		welcomeRecent.hidden = false;
		renderRecentInto(welcomeRecentList, entries.slice(0, 5), false);
	} else {
		welcomeRecent.hidden = true;
	}
}
function renderRecentInto(target: HTMLElement, entries: RecentEntry[], showClearEmpty: boolean) {
	target.innerHTML = "";
	if (entries.length === 0) {
		if (showClearEmpty) {
			const empty = document.createElement("div");
			empty.className = "recent-empty";
			empty.textContent = "No recent files";
			target.appendChild(empty);
		}
		return;
	}
	for (const e of entries) {
		const item = document.createElement("div");
		item.className = "recent-item";
		item.title = e.path;
		const name = document.createElement("div");
		name.className = "recent-item-name";
		name.textContent = e.name;
		const path = document.createElement("div");
		path.className = "recent-item-path";
		path.textContent = e.path;
		item.append(name, path);
		item.addEventListener("click", async () => {
			const r = await electroview.rpc!.request.readFile({ path: e.path });
			renderFile(r);
		});
		item.addEventListener("contextmenu", (ev) => { ev.preventDefault(); revealInFinder(e.path); });
		target.appendChild(item);
	}
}
clearRecentBtn.addEventListener("click", async () => {
	await electroview.rpc!.request.clearRecent({});
	refreshRecent();
});

// ============== Click handling: external links, internal MD links, wikilinks ==============
contentEl.addEventListener("click", async (e) => {
	const target = e.target as HTMLElement;
	const a = target.closest("a") as HTMLAnchorElement | null;
	if (!a) return;
	const href = a.getAttribute("href") || "";
	if (a.dataset.external === "true" || /^https?:/.test(href) || /^mailto:/.test(href)) {
		e.preventDefault();
		electroview.rpc!.request.openExternal({ url: href });
		return;
	}
	if (a.dataset.wikilink === "true") {
		e.preventDefault();
		const resolved = a.dataset.wikilinkResolved;
		if (resolved) {
			const r = await electroview.rpc!.request.readFile({ path: resolved });
			renderFile(r);
		}
		return;
	}
	if (a.dataset.internalMd && lastPayload) {
		e.preventDefault();
		const docDir = lastPayload.path.replace(/\/[^/]*$/, "");
		const cleaned = a.dataset.internalMd.split("#")[0];
		const target2 = cleaned.startsWith("/") ? cleaned : `${docDir}/${cleaned}`;
		const r = await electroview.rpc!.request.readFile({ path: target2 });
		renderFile(r);
		return;
	}
	if (href.startsWith("#")) {
		e.preventDefault();
		const id = href.slice(1);
		const el = document.getElementById(id);
		if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
	}
});

function toggleSidebar() { appEl.classList.toggle("sidebar-collapsed"); }

// ============== Open / Reveal / Print / Export ==============
async function pickFile() {
	const result = await electroview.rpc!.request.openDialog({});
	if (result) renderFile(result);
}
async function pickFolder() {
	const result = await electroview.rpc!.request.openFolderDialog({});
	if (result) renderFolder(result, true);
}
async function revealInFinder(path: string) {
	await electroview.rpc!.request.revealInFinder({ path });
}
function doPrint() { window.print(); }
async function exportHtml() {
	if (!lastPayload) return;
	const fmHtml = renderFrontMatterCard(parseDocument(md, lastPayload.content).frontMatter);
	const bodyHtml = contentEl.innerHTML;
	const css = Array.from(document.styleSheets)
		.map((s) => { try { return Array.from(s.cssRules).map((r) => r.cssText).join("\n"); } catch { return ""; } })
		.join("\n");
	const title = (lastPayload.path.split("/").pop() || "document").replace(/\.[^.]+$/, "");
	const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escAttr(title)}</title><style>${css}</style></head><body class="${document.body.className}" data-theme="${document.body.getAttribute("data-theme") || ""}"><article class="markdown-body">${bodyHtml}</article></body></html>`;
	const r = await electroview.rpc!.request.exportHtml({ html, title, defaultName: title });
	if (r.ok) {
		// brief feedback
		statusStats.textContent = `Exported to ${r.path}`;
		setTimeout(() => { if (lastPayload) statusStats.textContent = computeStats(parseDocument(md, lastPayload.content).body); }, 4000);
	}
}

openBtn.addEventListener("click", pickFile);
openFolderBtn.addEventListener("click", pickFolder);
filesEmptyOpen.addEventListener("click", pickFolder);
themeBtn.addEventListener("click", toggleTheme);

// ============== Drag & drop ==============
let dragDepth = 0;
window.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; dropzoneEl.classList.add("active"); });
window.addEventListener("dragleave", (e) => { e.preventDefault(); dragDepth--; if (dragDepth <= 0) { dragDepth = 0; dropzoneEl.classList.remove("active"); } });
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", async (e) => {
	e.preventDefault();
	dragDepth = 0;
	dropzoneEl.classList.remove("active");
	const file = e.dataTransfer?.files?.[0];
	if (!file) return;
	const path = (file as any).path as string | undefined;
	if (path) {
		const payload = await electroview.rpc!.request.readFile({ path });
		renderFile(payload);
	} else {
		const text = await file.text();
		renderFile({ path: file.name, content: text });
	}
});

// ============== Menu actions ==============
function handleMenuAction(action: string) {
	switch (action) {
		case "open-file": pickFile(); break;
		case "open-folder": pickFolder(); break;
		case "reload": if (lastPayload) renderFile(lastPayload, { preserveScroll: true }); break;
		case "toggle-theme": toggleTheme(); break;
		case "toggle-sidebar": toggleSidebar(); break;
		case "zoom-in": setZoom(zoom + 0.1); break;
		case "zoom-out": setZoom(zoom - 0.1); break;
		case "zoom-reset": setZoom(1); break;
		case "find": find.toggle(); break;
		case "find-in-folder": selectTab("search"); folderSearchInput.focus(); break;
		case "reveal-in-finder": if (lastPayload?.path) revealInFinder(lastPayload.path); break;
		case "print": doPrint(); break;
		case "export-html": exportHtml(); break;
	}
}

// ============== Keyboard shortcuts ==============
window.addEventListener("keydown", (e) => {
	const cmd = e.metaKey || e.ctrlKey;
	if (!cmd) {
		if (e.key === "Escape" && !lightboxEl.hidden) { e.preventDefault(); lightbox.close(); }
		return;
	}
	const k = e.key.toLowerCase();
	if (k === "o") { e.preventDefault(); e.shiftKey ? pickFolder() : pickFile(); }
	else if (k === "d") { e.preventDefault(); toggleTheme(); }
	else if (k === "\\") { e.preventDefault(); toggleSidebar(); }
	else if (e.key === "=" || e.key === "+") { e.preventDefault(); setZoom(zoom + 0.1); }
	else if (e.key === "-") { e.preventDefault(); setZoom(zoom - 0.1); }
	else if (e.key === "0") { e.preventDefault(); setZoom(1); }
	else if (k === "f") { e.preventDefault(); if (e.shiftKey) { selectTab("search"); folderSearchInput.focus(); } else { find.toggle(); } }
	else if (k === "p") { e.preventDefault(); doPrint(); }
	else if (k === "r" && e.shiftKey && lastPayload?.path) { e.preventDefault(); revealInFinder(lastPayload.path); }
});

// ============== Titlebar (custom window controls) ==============
// macOS uses native traffic lights (titleBarStyle: "hiddenInset") so we hide
// our buttons there. Windows/Linux render in-window controls that proxy to
// Electrobun's BrowserWindow API via RPC.
async function initTitlebar() {
	const bar = document.getElementById("titlebar") as HTMLElement | null;
	const controls = document.getElementById("titlebar-controls") as HTMLElement | null;
	const minBtn = document.getElementById("win-min");
	const maxBtn = document.getElementById("win-max");
	const closeBtn = document.getElementById("win-close");
	const dragRegion = bar?.querySelector<HTMLElement>(".titlebar-drag");
	const titleEl = document.getElementById("titlebar-title");
	if (!bar || !controls || !minBtn || !maxBtn || !closeBtn) return;

	// Platform-aware control visibility.
	try {
		const { platform, isMac } = await electroview.rpc!.request.getPlatform({});
		bar.dataset.platform = platform;
		controls.hidden = isMac;
	} catch {
		// If RPC fails, default to showing controls — better to have them than not.
		bar.dataset.platform = "win32";
		controls.hidden = false;
	}

	minBtn.addEventListener("click", () => {
		electroview.rpc!.request.windowMinimize({}).catch(() => {});
	});
	maxBtn.addEventListener("click", async () => {
		try {
			const r = await electroview.rpc!.request.windowMaximizeToggle({});
			if (r.ok) bar.dataset.maximized = r.maximized ? "true" : "false";
		} catch {}
	});
	closeBtn.addEventListener("click", () => {
		electroview.rpc!.request.windowClose({}).catch(() => {});
	});

	// Windows convention: double-click on the drag area toggles maximise.
	dragRegion?.addEventListener("dblclick", async () => {
		try {
			const r = await electroview.rpc!.request.windowMaximizeToggle({});
			if (r.ok) bar.dataset.maximized = r.maximized ? "true" : "false";
		} catch {}
	});

	// Mirror document.title into the titlebar text. Many code paths update
	// document.title (e.g. file-opened renders); this picks them all up.
	if (titleEl) {
		const sync = () => { titleEl.textContent = document.title || "Markdown Viewer"; };
		sync();
		const titleNode = document.querySelector("title");
		if (titleNode) new MutationObserver(sync).observe(titleNode, { childList: true, characterData: true, subtree: true });
	}
}

// ============== Boot ==============
(async () => {
	// Initialise titlebar BEFORE send.ready so the windowStateChanged broadcast
	// (which the bun side emits in response to ready) lands with DOM elements
	// already wired up.
	await initTitlebar();
	electroview.rpc!.send.ready({});
	await refreshRecent();
	const initial = await electroview.rpc!.request.getInitialFile({});
	if (initial) renderFile(initial);
})();
