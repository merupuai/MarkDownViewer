// Per-tab editor state (M3.S5 — closes FR-13 / IR-13-01).
//
// Owns:
//   - Tab[] array (each has id, path, format, content, dirty, cursor, mtimeMs)
//   - activeTabId pointer
//   - autosave scheduling (250ms debounce on edit; 5s heartbeat tick → bun)
//
// NOT owned here:
//   - DOM / view rendering (editor-pane.ts)
//   - Tab UI (tabs.ts)
//   - Save persistence (RPC.saveFile in bun process)
//
// State changes emit a typed `EditorEvent` so the view can subscribe without
// touching the state shape directly.
export type EditorFormat = "markdown" | "plain-text" | "json" | "yaml" | "toml" | string;

export type EditorTab = {
	id: string;
	path: string | null;          // null for unsaved-new
	format: EditorFormat;
	content: string;
	dirty: boolean;
	cursor: { line: number; col: number };
	selection?: { start: number; end: number };
	lastSavedAt?: number;
	mtimeMs?: number;             // server-recorded mtime at last read/save
	autosaveTimer?: ReturnType<typeof setTimeout> | null;
};

export type EditorEvent =
	| { type: "tab-opened"; tab: EditorTab }
	| { type: "tab-closed"; tabId: string }
	| { type: "tab-activated"; tabId: string | null }
	| { type: "tab-changed"; tabId: string }   // content or cursor mutated
	| { type: "tab-saved"; tabId: string; mtimeMs: number }
	| { type: "tab-conflict"; tabId: string; diskMtimeMs: number; expectedMtimeMs: number }
	| { type: "format-changed"; tabId: string; format: EditorFormat };

export type EditorListener = (e: EditorEvent) => void;

export type EditorStateApi = {
	open: (path: string | null, content: string, format: EditorFormat, mtimeMs?: number) => EditorTab;
	close: (tabId: string) => void;
	activate: (tabId: string | null) => void;
	setContent: (tabId: string, content: string) => void;
	setCursor: (tabId: string, cursor: { line: number; col: number }) => void;
	setFormat: (tabId: string, format: EditorFormat) => void;
	markSaved: (tabId: string, mtimeMs: number) => void;
	markConflict: (tabId: string, diskMtimeMs: number) => void;
	// L4 (Path B delta): assign a path + mtime to a previously-untitled tab
	// after a successful Save As, before calling markSaved.
	setPathAndMtime: (tabId: string, path: string, mtimeMs: number) => void;
	getTab: (tabId: string) => EditorTab | null;
	getActive: () => EditorTab | null;
	allTabs: () => ReadonlyArray<EditorTab>;
	subscribe: (listener: EditorListener) => () => void;
};

export const AUTOSAVE_DEBOUNCE_MS = 5000;

let nextTabSeq = 0;
function newId(): string {
	nextTabSeq++;
	return `tab-${Date.now()}-${nextTabSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createEditorState(opts: {
	onAutosave: (tab: EditorTab) => void;
}): EditorStateApi {
	const tabs: EditorTab[] = [];
	let activeTabId: string | null = null;
	const listeners = new Set<EditorListener>();

	function emit(e: EditorEvent) {
		for (const fn of listeners) {
			try { fn(e); } catch (err) { console.warn("editor listener threw", err); }
		}
	}

	function findTab(tabId: string): EditorTab | null {
		return tabs.find((t) => t.id === tabId) || null;
	}

	function scheduleAutosave(tabId: string) {
		const tab = findTab(tabId);
		if (!tab) return;
		if (tab.autosaveTimer) clearTimeout(tab.autosaveTimer);
		// Don't autosave new (unsaved) buffers — no path to save to.
		if (!tab.path) return;
		tab.autosaveTimer = setTimeout(() => {
			tab.autosaveTimer = null;
			if (tab.dirty && tab.path) opts.onAutosave(tab);
		}, AUTOSAVE_DEBOUNCE_MS);
	}

	return {
		open(path, content, format, mtimeMs) {
			// Reuse existing tab if path already open
			if (path) {
				const existing = tabs.find((t) => t.path === path);
				if (existing) {
					activeTabId = existing.id;
					emit({ type: "tab-activated", tabId: activeTabId });
					return existing;
				}
			}
			const tab: EditorTab = {
				id: newId(),
				path,
				format,
				content,
				dirty: false,
				cursor: { line: 1, col: 1 },
				lastSavedAt: path ? Date.now() : undefined,
				mtimeMs,
				autosaveTimer: null,
			};
			tabs.push(tab);
			activeTabId = tab.id;
			emit({ type: "tab-opened", tab });
			emit({ type: "tab-activated", tabId: tab.id });
			return tab;
		},
		close(tabId) {
			const idx = tabs.findIndex((t) => t.id === tabId);
			if (idx < 0) return;
			const tab = tabs[idx];
			if (tab.autosaveTimer) clearTimeout(tab.autosaveTimer);
			tabs.splice(idx, 1);
			if (activeTabId === tabId) {
				activeTabId = tabs.length ? tabs[Math.min(idx, tabs.length - 1)].id : null;
				emit({ type: "tab-activated", tabId: activeTabId });
			}
			emit({ type: "tab-closed", tabId });
		},
		activate(tabId) {
			activeTabId = tabId;
			emit({ type: "tab-activated", tabId });
		},
		setContent(tabId, content) {
			const tab = findTab(tabId);
			if (!tab) return;
			if (tab.content === content) return;
			tab.content = content;
			tab.dirty = true;
			emit({ type: "tab-changed", tabId });
			scheduleAutosave(tabId);
		},
		setCursor(tabId, cursor) {
			const tab = findTab(tabId);
			if (!tab) return;
			tab.cursor = cursor;
		},
		setFormat(tabId, format) {
			const tab = findTab(tabId);
			if (!tab) return;
			if (tab.format === format) return;
			tab.format = format;
			emit({ type: "format-changed", tabId, format });
		},
		markSaved(tabId, mtimeMs) {
			const tab = findTab(tabId);
			if (!tab) return;
			tab.dirty = false;
			tab.lastSavedAt = Date.now();
			tab.mtimeMs = mtimeMs;
			if (tab.autosaveTimer) {
				clearTimeout(tab.autosaveTimer);
				tab.autosaveTimer = null;
			}
			emit({ type: "tab-saved", tabId, mtimeMs });
		},
		markConflict(tabId, diskMtimeMs) {
			const tab = findTab(tabId);
			if (!tab) return;
			emit({ type: "tab-conflict", tabId, diskMtimeMs, expectedMtimeMs: tab.mtimeMs ?? 0 });
		},
		setPathAndMtime(tabId, path, mtimeMs) {
			const tab = findTab(tabId);
			if (!tab) return;
			tab.path = path;
			tab.mtimeMs = mtimeMs;
			tab.lastSavedAt = Date.now();
			emit({ type: "tab-changed", tabId });
		},
		getTab(tabId) {
			return findTab(tabId);
		},
		getActive() {
			return activeTabId ? findTab(activeTabId) : null;
		},
		allTabs() {
			return tabs.slice();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
	};
}
