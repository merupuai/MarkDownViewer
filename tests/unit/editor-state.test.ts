// Unit tests for editor-state (M3.S5).
//
// Validates:
//   - open / close / activate
//   - dirty bit on setContent
//   - autosave debounce (5s schedule)
//   - close clears autosave timer
//   - saveTab marks not-dirty
//   - reopening same path returns existing tab
//   - markConflict emits event
import { describe, test, expect } from "bun:test";
import { createEditorState, type EditorEvent, AUTOSAVE_DEBOUNCE_MS } from "../../src/mainview/editor/editor-state";

function captureEvents(state: ReturnType<typeof createEditorState>): EditorEvent[] {
	const events: EditorEvent[] = [];
	state.subscribe((e) => events.push(e));
	return events;
}

describe("editor-state lifecycle", () => {
	test("open creates a tab and activates it", () => {
		const state = createEditorState({ onAutosave: () => {} });
		const events = captureEvents(state);
		const tab = state.open("/path/to/doc.md", "# Hello", "markdown", 1000);
		expect(tab.id).toMatch(/^tab-/);
		expect(tab.path).toBe("/path/to/doc.md");
		expect(tab.content).toBe("# Hello");
		expect(tab.dirty).toBe(false);
		expect(state.getActive()?.id).toBe(tab.id);
		expect(events.some((e) => e.type === "tab-opened" && e.tab.id === tab.id)).toBe(true);
		expect(events.some((e) => e.type === "tab-activated" && e.tabId === tab.id)).toBe(true);
	});

	test("setContent marks dirty and emits tab-changed", () => {
		const state = createEditorState({ onAutosave: () => {} });
		const tab = state.open("/x.md", "old", "markdown");
		const events = captureEvents(state);
		state.setContent(tab.id, "new content");
		expect(state.getTab(tab.id)?.dirty).toBe(true);
		expect(state.getTab(tab.id)?.content).toBe("new content");
		expect(events.some((e) => e.type === "tab-changed" && e.tabId === tab.id)).toBe(true);
	});

	test("setContent identical content does NOT emit tab-changed", () => {
		const state = createEditorState({ onAutosave: () => {} });
		const tab = state.open("/x.md", "same", "markdown");
		const events = captureEvents(state);
		state.setContent(tab.id, "same");
		expect(events.some((e) => e.type === "tab-changed")).toBe(false);
		expect(state.getTab(tab.id)?.dirty).toBe(false);
	});

	test("opening same path reuses existing tab", () => {
		const state = createEditorState({ onAutosave: () => {} });
		const a = state.open("/a.md", "1", "markdown");
		const b = state.open("/a.md", "2", "markdown");
		expect(a.id).toBe(b.id);
		// content NOT overwritten on reopen
		expect(state.getTab(a.id)?.content).toBe("1");
	});

	test("markSaved clears dirty + updates mtime", () => {
		const state = createEditorState({ onAutosave: () => {} });
		const tab = state.open("/x.md", "x", "markdown", 1000);
		state.setContent(tab.id, "y");
		expect(state.getTab(tab.id)?.dirty).toBe(true);
		state.markSaved(tab.id, 2000);
		expect(state.getTab(tab.id)?.dirty).toBe(false);
		expect(state.getTab(tab.id)?.mtimeMs).toBe(2000);
	});

	test("close removes tab and re-activates a sibling", () => {
		const state = createEditorState({ onAutosave: () => {} });
		const a = state.open("/a.md", "a", "markdown");
		const b = state.open("/b.md", "b", "markdown");
		expect(state.getActive()?.id).toBe(b.id);
		state.close(b.id);
		expect(state.allTabs().length).toBe(1);
		expect(state.getActive()?.id).toBe(a.id);
	});

	test("close on last tab leaves activeTabId null", () => {
		const state = createEditorState({ onAutosave: () => {} });
		const a = state.open("/a.md", "a", "markdown");
		state.close(a.id);
		expect(state.allTabs().length).toBe(0);
		expect(state.getActive()).toBeNull();
	});

	test("markConflict emits tab-conflict with both mtimes", () => {
		const state = createEditorState({ onAutosave: () => {} });
		const tab = state.open("/x.md", "x", "markdown", 1000);
		const events = captureEvents(state);
		state.markConflict(tab.id, 5000);
		const conflict = events.find((e) => e.type === "tab-conflict");
		expect(conflict).toBeDefined();
		if (conflict?.type === "tab-conflict") {
			expect(conflict.diskMtimeMs).toBe(5000);
			expect(conflict.expectedMtimeMs).toBe(1000);
		}
	});
});

describe("autosave scheduling", () => {
	test("setContent on path-bound tab triggers autosave callback after debounce", async () => {
		let saveCount = 0;
		const state = createEditorState({
			onAutosave: () => { saveCount++; },
		});
		const tab = state.open("/x.md", "x", "markdown");
		state.setContent(tab.id, "edit 1");
		// Multiple edits within debounce window collapse into one save
		state.setContent(tab.id, "edit 2");
		state.setContent(tab.id, "edit 3");
		expect(saveCount).toBe(0);
		// Wait just over the debounce
		await new Promise((r) => setTimeout(r, AUTOSAVE_DEBOUNCE_MS + 100));
		expect(saveCount).toBe(1);
	}, AUTOSAVE_DEBOUNCE_MS + 2000);

	test("setContent on UNTITLED tab does NOT trigger autosave", async () => {
		let saveCount = 0;
		const state = createEditorState({ onAutosave: () => { saveCount++; } });
		const tab = state.open(null, "", "markdown");
		state.setContent(tab.id, "typed something");
		await new Promise((r) => setTimeout(r, AUTOSAVE_DEBOUNCE_MS + 100));
		expect(saveCount).toBe(0);
	}, AUTOSAVE_DEBOUNCE_MS + 2000);

	test("close clears pending autosave (no callback fires)", async () => {
		let saveCount = 0;
		const state = createEditorState({ onAutosave: () => { saveCount++; } });
		const tab = state.open("/x.md", "x", "markdown");
		state.setContent(tab.id, "edit");
		state.close(tab.id);
		await new Promise((r) => setTimeout(r, AUTOSAVE_DEBOUNCE_MS + 100));
		expect(saveCount).toBe(0);
	}, AUTOSAVE_DEBOUNCE_MS + 2000);

	test("markSaved clears the pending autosave", async () => {
		let saveCount = 0;
		const state = createEditorState({ onAutosave: () => { saveCount++; } });
		const tab = state.open("/x.md", "x", "markdown");
		state.setContent(tab.id, "edit");
		state.markSaved(tab.id, 9999);
		await new Promise((r) => setTimeout(r, AUTOSAVE_DEBOUNCE_MS + 100));
		expect(saveCount).toBe(0);
	}, AUTOSAVE_DEBOUNCE_MS + 2000);
});
