// Editor pane — the textarea-backed surface for editing the active tab.
// (M3.S3 — closes FR-13.)
//
// Owns:
//   - <textarea> element bound to the active tab's content
//   - Format-adapter shortcut handling (Cmd-B / Cmd-I / Cmd-K)
//   - Cursor + selection sync back to editor-state
//   - Debounced (250 ms) preview re-render trigger
//
// NOT owned here:
//   - Tab UI (tabs.ts)
//   - State management (editor-state.ts)
//   - Save persistence (RPC)
import type { EditorStateApi, EditorTab } from "./editor-state";
import { getAdapter } from "./format-adapters";

export type EditorPaneApi = {
	mount: (tab: EditorTab) => void;
	unmount: () => void;
	focus: () => void;
	getTextareaEl: () => HTMLTextAreaElement;
};

export const PREVIEW_DEBOUNCE_MS = 250;

export function createEditorPane(opts: {
	root: HTMLElement;
	state: EditorStateApi;
	onPreviewUpdate: (tab: EditorTab) => void;
}): EditorPaneApi {
	const { root, state, onPreviewUpdate } = opts;

	const textarea = document.createElement("textarea");
	textarea.className = "editor-textarea";
	textarea.spellcheck = false;
	textarea.autocapitalize = "off";
	textarea.autocomplete = "off";
	textarea.setAttribute("aria-label", "Document editor");
	root.replaceChildren();
	root.appendChild(textarea);

	let mountedTabId: string | null = null;
	let previewTimer: ReturnType<typeof setTimeout> | null = null;

	function schedulePreview(tab: EditorTab) {
		if (previewTimer) clearTimeout(previewTimer);
		previewTimer = setTimeout(() => {
			previewTimer = null;
			onPreviewUpdate(tab);
		}, PREVIEW_DEBOUNCE_MS);
	}

	textarea.addEventListener("input", () => {
		if (!mountedTabId) return;
		state.setContent(mountedTabId, textarea.value);
		const tab = state.getTab(mountedTabId);
		if (tab) schedulePreview(tab);
	});

	textarea.addEventListener("keydown", (e) => {
		if (!mountedTabId) return;
		const tab = state.getTab(mountedTabId);
		if (!tab) return;
		const cmd = e.metaKey || e.ctrlKey;
		if (!cmd) return;
		const adapter = getAdapter(tab.format);
		const shortcut = adapter.shortcuts.find((s) => s.cmdKey === e.key.toLowerCase());
		if (!shortcut) return;
		e.preventDefault();
		const start = textarea.selectionStart;
		const end = textarea.selectionEnd;
		const sel = textarea.value.slice(start, end);
		const result = shortcut.apply(sel, textarea.value, end);
		textarea.value = result.content;
		textarea.setSelectionRange(result.selectionStart, result.selectionEnd);
		state.setContent(mountedTabId, textarea.value);
		schedulePreview(tab);
	});

	function applyAdapterStyles(tab: EditorTab) {
		const adapter = getAdapter(tab.format);
		textarea.style.fontFamily = adapter.monospace ? "var(--font-mono)" : "var(--font-sans)";
		textarea.style.whiteSpace = adapter.wrapLines ? "pre-wrap" : "pre";
		textarea.style.tabSize = String(adapter.indentSpaces);
	}

	return {
		mount(tab) {
			mountedTabId = tab.id;
			textarea.value = tab.content;
			applyAdapterStyles(tab);
			schedulePreview(tab);
		},
		unmount() {
			if (previewTimer) {
				clearTimeout(previewTimer);
				previewTimer = null;
			}
			mountedTabId = null;
			textarea.value = "";
		},
		focus() {
			textarea.focus();
		},
		getTextareaEl() {
			return textarea;
		},
	};
}
