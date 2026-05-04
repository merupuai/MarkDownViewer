// Mermaid renderer with mandatory SVG sanitization (M1.S3 — closes SEC-001 / FR-03 / SR-01).
// Lazy-loads the mermaid bundle on first call (M4.S1 — closes ENH-011 / PERF-001).
//
// Why this module exists: mermaid is configured with `securityLevel: "loose"`
// because users embed HTML in diagram labels. Loose mode lets mermaid emit
// <foreignObject> + arbitrary HTML inside diagrams. The markdown-it stage
// base64-encodes the source into a data attribute, so DOMPurify never sees the
// raw mermaid output — it only sees the placeholder div. The SVG produced
// later by `mermaid.render()` was therefore landing in the DOM unsanitized,
// which is the exact attack vector behind SEC-001. This module forces every
// SVG returned by mermaid through DOMPurify with the SVG profile enabled
// before the caller can inject it.
//
// IMPORTANT: callers MUST inject `result.safeSvg`, never `result.rawSvg`.
//
// M4.S1: the mermaid bundle (~1 MB) is loaded only when actually needed —
// either the first `renderMermaidBlocks` call (document contains diagrams)
// or the first `configureMermaid` call (theme toggle while a document is
// already open). Documents with no diagrams never pay the import cost.
import DOMPurify from "isomorphic-dompurify";

// Type-only import — the actual mermaid bundle is dynamic-imported below.
type MermaidApi = typeof import("mermaid").default;

let mermaidPromise: Promise<MermaidApi> | null = null;
let mermaidConfigured = false;
let pendingConfig: Parameters<MermaidApi["initialize"]>[0] | null = null;

// Public surface: get-or-load the mermaid module exactly once. Subsequent
// calls return the cached promise, so concurrent renders do not race on
// duplicate imports.
export async function loadMermaid(): Promise<MermaidApi> {
	if (!mermaidPromise) {
		mermaidPromise = import("mermaid").then((mod) => mod.default || mod as unknown as MermaidApi);
	}
	const mermaid = await mermaidPromise;
	if (pendingConfig && !mermaidConfigured) {
		mermaid.initialize(pendingConfig);
		mermaidConfigured = true;
	}
	return mermaid;
}

// Allow callers to queue an initialize() that's applied as soon as mermaid
// loads. Idempotent: subsequent calls overwrite the queued config and, if
// mermaid is already loaded, apply immediately.
export async function configureMermaidLazy(config: Parameters<MermaidApi["initialize"]>[0]): Promise<void> {
	pendingConfig = config;
	if (mermaidPromise) {
		const mermaid = await mermaidPromise;
		mermaid.initialize(config);
		mermaidConfigured = true;
	}
}

export type MermaidRenderResult =
	| { ok: true; safeSvg: string; rawBytes: number; safeBytes: number; stripped: number }
	| { ok: false; error: string; firstSourceLine: string };

export async function renderSafe(id: string, src: string): Promise<MermaidRenderResult> {
	try {
		const mermaid = await loadMermaid();
		const { svg } = await mermaid.render(id, src);
		const safeSvg = DOMPurify.sanitize(svg, {
			USE_PROFILES: { svg: true, svgFilters: true, html: false },
			// Mermaid emits <foreignObject> for HTML labels. We allow it, but
			// nested content goes through DOMPurify's HTML rules anyway.
			ADD_TAGS: ["foreignObject"],
			FORBID_TAGS: ["script", "iframe", "object", "embed", "link"],
			FORBID_ATTR: ["onload", "onerror", "onclick", "onmouseover", "onfocus", "formaction"],
		});
		return {
			ok: true,
			safeSvg,
			rawBytes: svg.length,
			safeBytes: safeSvg.length,
			stripped: svg.length - safeSvg.length,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const firstSourceLine = src.split("\n").find((l) => l.trim() && !l.trim().startsWith("%%")) || "(empty)";
		return { ok: false, error: message, firstSourceLine };
	}
}
