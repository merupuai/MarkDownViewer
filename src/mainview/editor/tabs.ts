// Tab bar component (M3.S4 + M3.S11 — closes FR-13 + ENH-002).
//
// Renders one tab button per open EditorTab; click activates, middle-click
// or × button closes (with unsaved-changes prompt per M3.S11). Re-renders on
// every editor-state event.
import type { EditorStateApi, EditorTab } from "./editor-state";

export type TabsApi = {
	mount: () => void;
	unmount: () => void;
};

export function createTabs(opts: {
	root: HTMLElement;
	state: EditorStateApi;
	confirmCloseDirty: (tab: EditorTab) => Promise<"save" | "discard" | "cancel">;
	saveTab: (tab: EditorTab) => Promise<boolean>;
}): TabsApi {
	const { root, state, confirmCloseDirty, saveTab } = opts;

	const bar = document.createElement("div");
	bar.className = "editor-tab-bar";
	bar.setAttribute("role", "tablist");
	bar.setAttribute("aria-label", "Open documents");
	root.replaceChildren();
	root.appendChild(bar);

	function render() {
		bar.replaceChildren();
		const tabs = state.allTabs();
		const active = state.getActive();
		for (const tab of tabs) {
			const btn = document.createElement("div");
			btn.className = "editor-tab" + (active && active.id === tab.id ? " active" : "") + (tab.dirty ? " dirty" : "");
			btn.setAttribute("role", "tab");
			btn.setAttribute("aria-selected", active && active.id === tab.id ? "true" : "false");
			btn.title = tab.path || "(unsaved)";

			const label = document.createElement("span");
			label.className = "editor-tab-label";
			label.textContent = tab.path ? tab.path.split(/[\\/]/).pop() || tab.path : "Untitled";

			const dirtyDot = document.createElement("span");
			dirtyDot.className = "editor-tab-dirty";
			dirtyDot.textContent = "•";
			dirtyDot.setAttribute("aria-label", "Unsaved changes");

			const closeBtn = document.createElement("button");
			closeBtn.className = "editor-tab-close";
			closeBtn.type = "button";
			closeBtn.textContent = "×";
			closeBtn.setAttribute("aria-label", "Close tab");
			closeBtn.addEventListener("click", async (e) => {
				e.stopPropagation();
				await tryCloseTab(tab);
			});

			btn.addEventListener("click", () => state.activate(tab.id));
			btn.addEventListener("auxclick", async (e) => {
				if (e.button === 1) {
					e.preventDefault();
					await tryCloseTab(tab);
				}
			});

			btn.append(dirtyDot, label, closeBtn);
			bar.appendChild(btn);
		}
	}

	async function tryCloseTab(tab: EditorTab): Promise<void> {
		// M3.S11 (closes IR-13-04): confirm-discard prompt on dirty close
		if (tab.dirty) {
			const choice = await confirmCloseDirty(tab);
			if (choice === "cancel") return;
			if (choice === "save") {
				const ok = await saveTab(tab);
				if (!ok) return; // save failed → don't close
			}
			// "discard" → fall through to close
		}
		state.close(tab.id);
	}

	const unsubscribe = state.subscribe(() => render());

	return {
		mount() { render(); },
		unmount() {
			unsubscribe();
			bar.replaceChildren();
		},
	};
}
