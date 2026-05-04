// Editor application — composes editor-state + tabs + editor-pane + preview.
// (M3 integration — closes FR-13 + IR-13-01..05.)
//
// Public surface: `createEditorApp({ rpc, render })` returns an `app` API
// the renderer's index.ts can mount/unmount on demand. Edit mode is opt-in;
// when not mounted the app does nothing and adds zero overhead.
//
// Save flow:
//   user types → editor-pane → state.setContent → schedule preview
//   user Cmd-S → app.saveActive() → RPC.saveFile with expectedMtimeMs
//        → on conflict → confirmConflict() prompt → save-anyway / reload
//        → on ok → state.markSaved
//
// Preview pipeline:
//   When the active tab's content changes (debounced), call render(content,
//   format) to re-render the preview pane. The render function comes from
//   index.ts and is the SAME M1-hardened pipeline (parseDocument →
//   DOMPurify → mermaid → image resolver). IR-13-01: edit-mode preview
//   MUST share the boundary with view-mode.
import { createEditorState, type EditorTab, type EditorStateApi } from "./editor-state";
import { createEditorPane, type EditorPaneApi } from "./editor-pane";
import { createTabs, type TabsApi } from "./tabs";
import { getAdapter } from "./format-adapters";
// L1-L4 (Path B delta): import the canonical Encoding/EOL/LossyInfo types
// from the RPC schema so passthroughs in mainview/index.ts type-check.
import type { Encoding, EOL, LossyInfo as RpcLossyInfo } from "../../shared/rpc";

type RpcSaveResponse =
	| { ok: true; savedAt: number; mtimeMs: number; bytes: number; lossyChars?: number }
	| { ok: false; error: "conflict"; diskMtimeMs: number; expectedMtimeMs: number }
	| { ok: false; error: "io-failure"; message: string }
	| { ok: false; error: "unsafe-path"; message: string }
	| { ok: false; error: "too-large"; bytes: number }
	// L3: NEW
	| { ok: false; error: "lossy"; lossy: RpcLossyInfo };

// L4 (Path B delta): Save As response shape mirrored from rpc.ts
type RpcSaveAsResponse =
	| { ok: true; path: string; savedAt: number; mtimeMs: number; bytes: number; lossyChars?: number }
	| { ok: false; error: "user-cancelled" }
	| { ok: false; error: "lossy"; lossy: RpcLossyInfo }
	| { ok: false; error: "io-failure"; message: string };

export type EditorAppDeps = {
	tabsContainer: HTMLElement;
	editorContainer: HTMLElement;
	previewContainer: HTMLElement;
	rpc: {
		readFile: (params: { path: string; intent?: "view" | "edit" }) => Promise<{ path: string; content: string; error?: string; mtimeMs?: number }>;
		// L2/L3 (Path B delta): saveFile gains optional encoding/eol/bom/allowLossy params
		saveFile: (params: {
			path: string;
			content: string;
			expectedMtimeMs?: number;
			encoding?: Encoding;
			eol?: EOL;
			bom?: boolean;
			allowLossy?: boolean;
		}) => Promise<RpcSaveResponse>;
		// L4 (Path B delta): Save As for untitled buffers
		saveAsDialog: (params: {
			defaultName: string;
			content: string;
			encoding?: Encoding;
			eol?: EOL;
			bom?: boolean;
			allowLossy?: boolean;
		}) => Promise<RpcSaveAsResponse>;
		detectFormat: (params: { path: string }) => Promise<{ format: string; confidence: number }>;
	};
	renderPreview: (content: string, format: string) => void;
	confirmCloseDirty: (tab: EditorTab) => Promise<"save" | "discard" | "cancel">;
	confirmConflict: (tab: EditorTab, diskMtimeMs: number) => Promise<"save-anyway" | "reload" | "cancel">;
	// L3 (Path B delta): F2 lossy-encoding confirm before commit
	confirmLossy: (lossy: RpcLossyInfo) => Promise<boolean>;
	notify: (message: string, level: "info" | "warn" | "error") => void;
};

export type EditorAppApi = {
	openFile: (path: string) => Promise<EditorTab | null>;
	openUntitled: (format?: string) => EditorTab;
	saveActive: () => Promise<boolean>;
	closeActive: () => Promise<void>;
	mount: () => void;
	unmount: () => void;
	state: EditorStateApi;
};

export function createEditorApp(deps: EditorAppDeps): EditorAppApi {
	const { tabsContainer, editorContainer, previewContainer, rpc, renderPreview, confirmCloseDirty, confirmConflict, confirmLossy, notify } = deps;

	const state = createEditorState({
		onAutosave: async (tab) => {
			if (!tab.path || !tab.dirty) return;
			const result = await rpc.saveFile({ path: tab.path, content: tab.content, expectedMtimeMs: tab.mtimeMs });
			if (result.ok) {
				state.markSaved(tab.id, result.mtimeMs);
			} else if (result.error === "conflict") {
				state.markConflict(tab.id, result.diskMtimeMs);
				notify(`${tab.path}: changed on disk during edit — review before saving`, "warn");
			} else {
				notify(`Autosave failed for ${tab.path}: ${result.error}`, "error");
			}
		},
	});

	let editorPane: EditorPaneApi | null = null;
	let tabs: TabsApi | null = null;

	function rerenderPreview(tab: EditorTab) {
		previewContainer.replaceChildren();
		try {
			renderPreview(tab.content, tab.format);
		} catch (err) {
			notify(`Preview render failed: ${err instanceof Error ? err.message : String(err)}`, "error");
		}
	}

	function bindStateEvents() {
		return state.subscribe((event) => {
			if (event.type === "tab-activated") {
				if (!event.tabId) return;
				const tab = state.getTab(event.tabId);
				if (!tab) return;
				editorPane?.mount(tab);
				rerenderPreview(tab);
				editorPane?.focus();
			}
			if (event.type === "tab-changed") {
				const tab = state.getTab(event.tabId);
				if (tab) rerenderPreview(tab);
			}
			if (event.type === "tab-saved") {
				notify(`Saved at ${new Date(event.mtimeMs).toLocaleTimeString()}`, "info");
			}
		});
	}

	let unbindEvents: (() => void) | null = null;

	async function saveActiveImpl(): Promise<boolean> {
		const tab = state.getActive();
		if (!tab) return false;

		// L4 (Path B delta): Save As for untitled tabs. Two-attempt loop allows
		// the user to confirm-and-retry a lossy encoding choice once.
		if (!tab.path) {
			const defaultName = `untitled-${tab.format === "markdown" ? "md" : "txt"}`;
			let allowLossy = false;
			for (let attempt = 0; attempt < 2; attempt++) {
				const result = await rpc.saveAsDialog({
					defaultName,
					content: tab.content,
					allowLossy,
				});
				if (result.ok) {
					state.setPathAndMtime(tab.id, result.path, result.mtimeMs);
					state.markSaved(tab.id, result.mtimeMs);
					notify(
						result.lossyChars
							? `Saved as ${result.path} (${result.lossyChars} char(s) lost)`
							: `Saved as ${result.path}`,
						"info",
					);
					return true;
				}
				if (result.error === "user-cancelled") return false;
				if (result.error === "lossy") {
					const proceed = await confirmLossy(result.lossy);
					if (!proceed) return false;
					allowLossy = true;
					continue;
				}
				notify(`Save As failed: ${result.error}`, "error");
				return false;
			}
			return false;
		}

		// Two-attempt loop for the regular save path: first attempt may refuse
		// lossy save; user can confirm + retry with allowLossy.
		let allowLossy = false;
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await rpc.saveFile({
				path: tab.path,
				content: tab.content,
				expectedMtimeMs: tab.mtimeMs,
				allowLossy,
			});
			if (result.ok) {
				state.markSaved(tab.id, result.mtimeMs);
				if (result.lossyChars) {
					notify(`Saved (${result.lossyChars} char(s) lost in target encoding)`, "info");
				}
				return true;
			}
			if (result.error === "conflict") {
				const choice = await confirmConflict(tab, result.diskMtimeMs);
				if (choice === "save-anyway") {
					// Re-attempt without expectedMtimeMs — overwrite the disk
					const force = await rpc.saveFile({ path: tab.path, content: tab.content, allowLossy });
					if (force.ok) {
						state.markSaved(tab.id, force.mtimeMs);
						return true;
					}
					notify(`Force-save failed: ${force.error}`, "error");
					return false;
				}
				if (choice === "reload") {
					const fresh = await rpc.readFile({ path: tab.path, intent: "edit" });
					if (!fresh.error) {
						state.setContent(tab.id, fresh.content);
						state.markSaved(tab.id, fresh.mtimeMs ?? Date.now());
					}
					return false;
				}
				return false;  // cancel
			}
			if (result.error === "lossy") {
				// L3 (Path B delta): F2 confirm-and-retry
				const proceed = await confirmLossy(result.lossy);
				if (!proceed) {
					notify(`Save cancelled — would have lost ${result.lossy.lossyCharCount} character(s)`, "warn");
					return false;
				}
				allowLossy = true;
				continue;
			}
			notify(`Save failed: ${result.error}`, "error");
			return false;
		}
		return false;
	}

	return {
		state,
		mount() {
			editorPane = createEditorPane({
				root: editorContainer,
				state,
				onPreviewUpdate: (tab) => rerenderPreview(tab),
			});
			tabs = createTabs({
				root: tabsContainer,
				state,
				confirmCloseDirty,
				saveTab: async (tab) => {
					if (!tab.path) return false;
					const r = await rpc.saveFile({ path: tab.path, content: tab.content, expectedMtimeMs: tab.mtimeMs });
					if (r.ok) state.markSaved(tab.id, r.mtimeMs);
					return r.ok;
				},
			});
			tabs.mount();
			unbindEvents = bindStateEvents();
		},
		unmount() {
			unbindEvents?.();
			unbindEvents = null;
			editorPane?.unmount();
			tabs?.unmount();
			editorPane = null;
			tabs = null;
		},
		async openFile(path) {
			const payload = await rpc.readFile({ path, intent: "edit" });
			if (payload.error) {
				notify(`Open failed: ${payload.error}`, "error");
				return null;
			}
			const fmt = await rpc.detectFormat({ path });
			const tab = state.open(path, payload.content, fmt.format, payload.mtimeMs);
			return tab;
		},
		openUntitled(format = "markdown") {
			return state.open(null, "", format);
		},
		saveActive: saveActiveImpl,
		async closeActive() {
			const tab = state.getActive();
			if (!tab) return;
			if (tab.dirty) {
				const choice = await confirmCloseDirty(tab);
				if (choice === "cancel") return;
				if (choice === "save") {
					const ok = await saveActiveImpl();
					if (!ok) return;
				}
			}
			state.close(tab.id);
		},
	};
}
