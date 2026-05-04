import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createSessionStore } from "../../src/bun/session-store";

describe("SessionStore — Path B L5", () => {
	test("save+load round-trips a saved tab", () => {
		const dir = mkdtempSync(join(tmpdir(), "mdv-sess-"));
		const store = createSessionStore(dir);
		store.save({
			tabs: [
				{
					id: "t1",
					path: "/some/file.md",
					format: "markdown",
					mtimeMs: 1234567890,
				},
			],
			activeTabId: "t1",
		});
		const loaded = store.load();
		expect(loaded.tabs.length).toBe(1);
		expect(loaded.activeTabId).toBe("t1");
		expect(loaded.tabs[0].path).toBe("/some/file.md");
		expect(loaded.tabs[0].format).toBe("markdown");
		expect(loaded.tabs[0].mtimeMs).toBe(1234567890);
		rmSync(dir, { recursive: true, force: true });
	});

	test("save+load round-trips an untitled tab with inline content", () => {
		const dir = mkdtempSync(join(tmpdir(), "mdv-sess-"));
		const store = createSessionStore(dir);
		store.save({
			tabs: [
				{
					id: "u1",
					path: null,
					format: "plain-text",
					untitledContent: "hello\nworld\n",
				},
			],
			activeTabId: "u1",
		});
		const loaded = store.load();
		expect(loaded.tabs[0].path).toBeNull();
		expect(loaded.tabs[0].untitledContent).toBe("hello\nworld\n");
		rmSync(dir, { recursive: true, force: true });
	});

	test("load returns empty state when session.json is missing", () => {
		const dir = mkdtempSync(join(tmpdir(), "mdv-sess-"));
		const store = createSessionStore(dir);
		const loaded = store.load();
		expect(loaded.tabs).toEqual([]);
		expect(loaded.activeTabId).toBeNull();
		rmSync(dir, { recursive: true, force: true });
	});

	test("load returns empty state when session.json is corrupt JSON", () => {
		const dir = mkdtempSync(join(tmpdir(), "mdv-sess-"));
		// Pre-create a malformed session.json
		const malformed = "{ not valid json";
		require("fs").writeFileSync(join(dir, "session.json"), malformed, "utf8");
		const store = createSessionStore(dir);
		const loaded = store.load();
		expect(loaded.tabs).toEqual([]);
		expect(loaded.activeTabId).toBeNull();
		rmSync(dir, { recursive: true, force: true });
	});

	test("untitled content is capped at 1 MB on save", () => {
		const dir = mkdtempSync(join(tmpdir(), "mdv-sess-"));
		const store = createSessionStore(dir);
		const big = "x".repeat(2 * 1024 * 1024); // 2 MB
		store.save({
			tabs: [
				{
					id: "u1",
					path: null,
					format: "plain-text",
					untitledContent: big,
				},
			],
			activeTabId: "u1",
		});
		const loaded = store.load();
		const tab = loaded.tabs[0];
		expect(tab).toBeDefined();
		expect(tab.untitledContent?.length ?? 0).toBeLessThanOrEqual(1024 * 1024);
		rmSync(dir, { recursive: true, force: true });
	});

	test("save creates the directory if it doesn't exist", () => {
		const parent = mkdtempSync(join(tmpdir(), "mdv-sess-parent-"));
		const dir = join(parent, "nested", "session-dir");
		expect(existsSync(dir)).toBe(false);
		const store = createSessionStore(dir);
		store.save({ tabs: [], activeTabId: null });
		expect(existsSync(join(dir, "session.json"))).toBe(true);
		rmSync(parent, { recursive: true, force: true });
	});
});
