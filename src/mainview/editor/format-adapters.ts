// Format adapters (M3.S8 — markdown / M3.S9 — plain-text).
//
// Each adapter declares: textarea behavior (line wrap, monospace), preview
// renderer (markdown gets the M1-hardened pipeline; plain-text gets escaped
// pre-block), and shortcut bindings (Cmd-B bold, Cmd-K link for markdown).
//
// IR-13-05: format adapters MUST NOT execute user content as code. No eval,
// no dynamic imports, no Function constructor.
import type { EditorFormat } from "./editor-state";

export type FormatShortcut = {
	cmdKey: string;     // "b", "k", "i", etc.
	apply: (selection: string, fullContent: string, cursor: number) => { content: string; selectionStart: number; selectionEnd: number };
};

export type FormatAdapter = {
	id: EditorFormat;
	displayName: string;
	monospace: boolean;
	wrapLines: boolean;
	indentSpaces: number;
	shortcuts: FormatShortcut[];
};

const MARKDOWN: FormatAdapter = {
	id: "markdown",
	displayName: "Markdown",
	monospace: true,
	wrapLines: true,
	indentSpaces: 2,
	shortcuts: [
		{
			cmdKey: "b",
			apply: (sel, full, cursor) => {
				if (sel) {
					const wrapped = `**${sel}**`;
					return { content: full.slice(0, cursor - sel.length) + wrapped + full.slice(cursor), selectionStart: cursor - sel.length, selectionEnd: cursor - sel.length + wrapped.length };
				}
				const insert = "**bold**";
				return { content: full.slice(0, cursor) + insert + full.slice(cursor), selectionStart: cursor + 2, selectionEnd: cursor + 6 };
			},
		},
		{
			cmdKey: "i",
			apply: (sel, full, cursor) => {
				const wrapped = sel ? `*${sel}*` : "*italic*";
				const start = sel ? cursor - sel.length : cursor;
				return { content: full.slice(0, start) + wrapped + full.slice(start + sel.length), selectionStart: start + 1, selectionEnd: start + 1 + (sel || "italic").length };
			},
		},
		{
			cmdKey: "k",
			apply: (sel, full, cursor) => {
				const text = sel || "link text";
				const insert = `[${text}](url)`;
				const start = sel ? cursor - sel.length : cursor;
				return { content: full.slice(0, start) + insert + full.slice(start + sel.length), selectionStart: start + insert.length - 4, selectionEnd: start + insert.length - 1 };
			},
		},
	],
};

const PLAIN_TEXT: FormatAdapter = {
	id: "plain-text",
	displayName: "Plain text",
	monospace: true,
	wrapLines: true,
	indentSpaces: 4,
	shortcuts: [],
};

const ADAPTERS: Record<string, FormatAdapter> = {
	"markdown": MARKDOWN,
	"plain-text": PLAIN_TEXT,
	// json/yaml/toml: degrade to plain-text adapter behavior for now.
	// Their preview pane shows escaped <pre>; M4 can add proper formatters.
	"json": { ...PLAIN_TEXT, id: "json", displayName: "JSON" },
	"yaml": { ...PLAIN_TEXT, id: "yaml", displayName: "YAML" },
	"toml": { ...PLAIN_TEXT, id: "toml", displayName: "TOML" },
};

export function getAdapter(format: EditorFormat): FormatAdapter {
	return ADAPTERS[format] || PLAIN_TEXT;
}

export function listAdapters(): FormatAdapter[] {
	return Object.values(ADAPTERS);
}
