// Unit tests for format adapters (M3.S7 / M3.S8 / M3.S9).
import { describe, test, expect } from "bun:test";
import { getAdapter, listAdapters } from "../../src/mainview/editor/format-adapters";

describe("format adapter registry", () => {
	test("markdown adapter registered with shortcuts", () => {
		const a = getAdapter("markdown");
		expect(a.id).toBe("markdown");
		expect(a.monospace).toBe(true);
		expect(a.shortcuts.length).toBeGreaterThan(0);
	});

	test("plain-text adapter registered, no shortcuts", () => {
		const a = getAdapter("plain-text");
		expect(a.id).toBe("plain-text");
		expect(a.shortcuts).toHaveLength(0);
	});

	test("unknown format degrades to plain-text", () => {
		const a = getAdapter("rust" as any);
		expect(a.id).toBe("plain-text");
	});

	test("listAdapters returns at least 5 (markdown, plain-text, json, yaml, toml)", () => {
		const ids = listAdapters().map((a) => a.id);
		expect(ids).toContain("markdown");
		expect(ids).toContain("plain-text");
		expect(ids).toContain("json");
		expect(ids).toContain("yaml");
		expect(ids).toContain("toml");
	});
});

describe("markdown shortcuts (IR-13-05: no eval, just text munging)", () => {
	const md = getAdapter("markdown");

	test("Cmd-B wraps selection in **", () => {
		const bold = md.shortcuts.find((s) => s.cmdKey === "b");
		expect(bold).toBeDefined();
		const result = bold!.apply("hello", "say hello world", 9);
		expect(result.content).toContain("**hello**");
	});

	test("Cmd-I wraps selection in *", () => {
		const italic = md.shortcuts.find((s) => s.cmdKey === "i");
		expect(italic).toBeDefined();
		const result = italic!.apply("emph", "see emph here", 8);
		expect(result.content).toContain("*emph*");
	});

	test("Cmd-K builds a link with placeholder url", () => {
		const link = md.shortcuts.find((s) => s.cmdKey === "k");
		expect(link).toBeDefined();
		const result = link!.apply("anchor", "text anchor end", 11);
		expect(result.content).toContain("[anchor](url)");
	});
});
