import MarkdownIt from "markdown-it";
import markdownItAnchor from "markdown-it-anchor";
// @ts-expect-error - no types
import { full as markdownItEmoji } from "markdown-it-emoji";
// @ts-expect-error - no types
import markdownItFootnote from "markdown-it-footnote";
// @ts-expect-error - no types
import markdownItTaskLists from "markdown-it-task-lists";
// @ts-expect-error - no types
import markdownItAttrs from "markdown-it-attrs";
// @ts-expect-error - no types
import texmath from "markdown-it-texmath";
import katex from "katex";
import hljs from "highlight.js";
import matter from "gray-matter";

export type FrontMatter = Record<string, unknown> | null;

export type ParsedDoc = {
	html: string;
	frontMatter: FrontMatter;
	body: string;
	// M1.S6 (closes SEC-004 / FR-07): when gray-matter fails to parse a
	// malformed YAML/TOML/JSON front-matter block, surface the message so the
	// renderer can show a dismissible warning. The body still renders;
	// previous behavior silently dropped the front-matter without feedback.
	frontMatterError?: string;
};

function escAttr(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#39;");
}
function escHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildMarkdown(): MarkdownIt {
	const md = new MarkdownIt({
		html: true,
		linkify: true,
		typographer: true,
		breaks: false,
		highlight(code, lang) {
			if (lang === "mermaid") {
				// Base64-encode the source to survive HTML attribute round-trips
				// (DOMPurify, browser parser whitespace normalization, etc.).
				const b64 = typeof btoa === "function"
					? btoa(unescape(encodeURIComponent(code)))
					: Buffer.from(code, "utf8").toString("base64");
				return `<div class="mermaid-pending" data-mermaid-src-b64="${b64}"></div>`;
			}
			const language = lang && hljs.getLanguage(lang) ? lang : "";
			let highlighted: string;
			try {
				highlighted = language
					? hljs.highlight(code, { language, ignoreIllegals: true }).value
					: escHtml(code);
			} catch {
				highlighted = escHtml(code);
			}
			const langLabel = language ? `<span class="code-lang">${language}</span>` : "";
			return `<div class="code-block-wrap"><div class="code-block-tools">${langLabel}<button class="code-copy-btn" type="button" aria-label="Copy code">Copy</button></div><pre class="hljs"><code class="${language ? `language-${language}` : ""}">${highlighted}</code></pre></div>`;
		},
	});

	md.use(markdownItAnchor, {
		permalink: markdownItAnchor.permalink.linkInsideHeader({
			symbol: "#",
			placement: "after",
			ariaHidden: false,
		}),
		slugify: (s: string) =>
			s.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-"),
	});
	md.use(markdownItEmoji);
	md.use(markdownItFootnote);
	md.use(markdownItTaskLists, { enabled: false, label: false });
	md.use(markdownItAttrs);

	// KaTeX math via texmath
	md.use(texmath, {
		engine: katex,
		delimiters: "dollars",
		katexOptions: { throwOnError: false, strict: false, output: "html" },
	});

	// GitHub-style alerts: > [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION]
	registerAlertsPlugin(md);

	// Wikilinks: [[Page]] or [[Page|alias]]
	registerWikilinksPlugin(md);

	// M4.S10: Bibtex-style inline citations [@key] or [@key1; @key2]
	registerCitationsPlugin(md);

	// Mark external links
	const defaultLinkOpen =
		md.renderer.rules.link_open ||
		((tokens: any, idx: any, options: any, _env: any, self: any) => self.renderToken(tokens, idx, options));
	md.renderer.rules.link_open = (tokens: any, idx: any, options: any, env: any, self: any) => {
		const href = tokens[idx].attrGet("href") || "";
		if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
			tokens[idx].attrSet("data-external", "true");
			tokens[idx].attrSet("target", "_blank");
		} else if (/\.(md|markdown|mdown|mkd|mkdn|mdx)(#.*)?$/i.test(href) && !href.startsWith("#")) {
			tokens[idx].attrSet("data-internal-md", href);
		}
		return defaultLinkOpen(tokens, idx, options, env, self);
	};

	// Mark images so we can resolve relative paths post-render
	const defaultImage =
		md.renderer.rules.image ||
		((tokens: any, idx: any, options: any, _env: any, self: any) => self.renderToken(tokens, idx, options));
	md.renderer.rules.image = (tokens: any, idx: any, options: any, env: any, self: any) => {
		const src = tokens[idx].attrGet("src") || "";
		if (src && !/^(https?:|data:|file:)/i.test(src)) {
			tokens[idx].attrSet("data-rel-src", src);
		}
		return defaultImage(tokens, idx, options, env, self);
	};

	return md;
}

export function parseDocument(md: MarkdownIt, raw: string): ParsedDoc {
	let frontMatter: FrontMatter = null;
	let body = raw;
	let frontMatterError: string | undefined;
	// Detect a front-matter block first so we can distinguish "no front-matter"
	// (legitimate, no error) from "malformed front-matter" (M1.S6 user-visible).
	const hasFrontMatterDelim = /^\s*---\s*\n[\s\S]*?\n\s*---\s*(?:\n|$)/.test(raw);
	try {
		const parsed = matter(raw);
		if (parsed.data && Object.keys(parsed.data).length > 0) frontMatter = parsed.data as Record<string, unknown>;
		body = parsed.content;
	} catch (err) {
		// Only surface as user error if the user clearly intended front-matter
		// (delimiters present). Otherwise this is a benign edge case in matter().
		if (hasFrontMatterDelim) {
			frontMatterError = err instanceof Error ? err.message : String(err);
		}
	}
	const html = md.render(body);
	return { html, frontMatter, body, frontMatterError };
}

export function renderFrontMatterCard(fm: FrontMatter): string {
	if (!fm) return "";
	const entries = Object.entries(fm);
	if (entries.length === 0) return "";
	const rows = entries
		.map(([key, value]) => {
			const v = formatFmValue(value);
			return `<div class="fm-row"><div class="fm-key">${escHtml(key)}</div><div class="fm-val">${v}</div></div>`;
		})
		.join("");
	return `<aside class="fm-card"><div class="fm-card-title">Front matter</div>${rows}</aside>`;
}

function formatFmValue(v: unknown): string {
	if (v === null || v === undefined) return `<span class="fm-null">∅</span>`;
	if (Array.isArray(v)) {
		return v
			.map((x) => `<span class="fm-tag">${escHtml(String(x))}</span>`)
			.join(" ");
	}
	if (typeof v === "object") return `<code>${escHtml(JSON.stringify(v))}</code>`;
	if (typeof v === "boolean") return v ? "✓" : "✗";
	const str = String(v);
	if (/^https?:\/\//.test(str)) return `<a href="${escAttr(str)}" data-external="true">${escHtml(str)}</a>`;
	return escHtml(str);
}

// =================== Plugins ===================

const ALERT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i;

function registerAlertsPlugin(md: MarkdownIt) {
	md.core.ruler.after("block", "github_alerts", (state) => {
		const tokens = state.tokens;
		for (let i = 0; i < tokens.length; i++) {
			if (tokens[i].type !== "blockquote_open") continue;
			// find the first inline token inside the blockquote
			let j = i + 1;
			while (j < tokens.length && tokens[j].type !== "blockquote_close") {
				if (tokens[j].type === "inline" && tokens[j].content) {
					const firstLine = tokens[j].content.split("\n")[0];
					const m = ALERT_RE.exec(firstLine.trim());
					if (m) {
						const kind = m[1].toUpperCase();
						const blockquoteOpen = tokens[i];
						blockquoteOpen.attrJoin("class", `gfm-alert gfm-alert-${kind.toLowerCase()}`);
						blockquoteOpen.attrSet("data-alert", kind);

						// Replace first inline content with title
						const inlineToken = tokens[j];
						inlineToken.content = inlineToken.content.replace(/^\[![A-Z]+\][ \t]*\n?/i, "");
						const children = inlineToken.children;
						if (children && children.length > 0) {
							const child = children[0];
							if (child && child.type === "text") {
								child.content = child.content.replace(/^\[![A-Z]+\][ \t]*\n?/i, "");
							}
							// Also drop a leading softbreak if present
							while (
								children.length > 0 &&
								(children[0]!.type === "softbreak" || children[0]!.type === "hardbreak" ||
									(children[0]!.type === "text" && children[0]!.content === ""))
							) {
								children.shift();
							}
						}
						// Insert title node
						const titleHtml = `<div class="gfm-alert-title"><span class="gfm-alert-icon" data-alert-icon="${kind}"></span>${kind.charAt(0) + kind.slice(1).toLowerCase()}</div>`;
						const titleToken = new state.Token("html_inline", "", 0);
						titleToken.content = titleHtml;
						if (inlineToken.children) inlineToken.children.unshift(titleToken);
						break;
					}
				}
				j++;
			}
		}
		return false;
	});
}

// M4.S10: inline citation rule. Matches [@key] or [@key1; @key2] and emits
// a <span class="citation" data-cite-keys="key1;key2">[?]</span> placeholder.
// Resolution to author-year text and bibliography is done by the renderer
// AFTER markdown parse — this keeps the markdown-it stage pure and lets the
// renderer pull the .bib file via RPC just-in-time.
function registerCitationsPlugin(md: MarkdownIt) {
	md.inline.ruler.before("link", "citation", (state, silent) => {
		const start = state.pos;
		if (state.src.charCodeAt(start) !== 0x5b /* [ */) return false;
		if (state.src.charCodeAt(start + 1) !== 0x40 /* @ */) return false;
		const end = state.src.indexOf("]", start + 1);
		if (end < 0) return false;
		const inner = state.src.slice(start + 1, end);
		// Verify EVERY token starts with @ (rejects `[@key not-a-cite]`)
		const tokens = inner.split(";").map((s) => s.trim());
		if (!tokens.every((t) => t.startsWith("@"))) return false;
		const keys = tokens.map((t) => t.slice(1).trim()).filter(Boolean);
		if (!keys.length) return false;
		if (silent) return true;
		const tok = state.push("html_inline", "", 0);
		tok.content = `<span class="citation" data-cite-keys="${keys.map((k) => k.replace(/[<>"&]/g, "")).join(";")}">[?]</span>`;
		state.pos = end + 1;
		return true;
	});
}

function registerWikilinksPlugin(md: MarkdownIt) {
	md.inline.ruler.before("link", "wikilink", (state, silent) => {
		const start = state.pos;
		if (state.src.charCodeAt(start) !== 0x5b /* [ */) return false;
		if (state.src.charCodeAt(start + 1) !== 0x5b) return false;
		const end = state.src.indexOf("]]", start + 2);
		if (end < 0) return false;
		const inner = state.src.slice(start + 2, end);
		if (!inner || inner.includes("\n")) return false;
		if (silent) return true;

		const [target, alias] = inner.split("|").map((s) => s.trim());
		const display = alias || target;
		const tokenOpen = state.push("link_open", "a", 1);
		tokenOpen.attrSet("href", target);
		tokenOpen.attrSet("data-wikilink", "true");
		tokenOpen.attrSet("class", "wikilink");
		const tokenText = state.push("text", "", 0);
		tokenText.content = display;
		state.push("link_close", "a", -1);
		state.pos = end + 2;
		return true;
	});
}
