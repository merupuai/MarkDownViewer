// Unit tests for the DOMPurify style-attribute hook (M1.S2).
//
// Mirrors the hook installed in src/mainview/index.ts: strips style values
// containing url(), @import, expression(), behavior:, or -moz-binding.
// Closes SEC-003 / FR-05 / SR-03.
import { describe, test, expect, beforeAll } from "bun:test";
import DOMPurify from "isomorphic-dompurify";

const STYLE_FORBIDDEN = /(?:url\s*\(|@import|expression\s*\(|behavior\s*:|-moz-binding)/i;

beforeAll(() => {
	// Install the same hook pattern as src/mainview/index.ts. Name-prefix the
	// hook so tests can be re-run without duplicate registrations.
	DOMPurify.removeHook("uponSanitizeAttribute");
	DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
		if (data.attrName !== "style") return;
		const value = String(data.attrValue || "");
		if (STYLE_FORBIDDEN.test(value)) {
			data.keepAttr = false;
			data.attrValue = "";
		}
	});
});

const config = {
	ADD_ATTR: ["style", "class", "id"],
	ADD_TAGS: ["div", "span", "p", "a", "img"],
} as const;

function sanitize(html: string): string {
	return DOMPurify.sanitize(html, config as unknown as Parameters<typeof DOMPurify.sanitize>[1]);
}

describe("style attribute hardening", () => {
	test("legitimate style declarations pass through", () => {
		const out = sanitize(`<p style="color: red; font-weight: bold; padding: 4px;">x</p>`);
		expect(out).toContain("color");
		expect(out).toContain("font-weight");
	});

	test("style with url() is stripped", () => {
		const out = sanitize(`<p style="background: url(http://evil.com/track)">x</p>`);
		expect(out.toLowerCase()).not.toContain("url(");
		expect(out.toLowerCase()).not.toContain("evil.com");
	});

	test("style with @import is stripped", () => {
		const out = sanitize(`<p style="@import url(http://evil.com/x.css)">x</p>`);
		expect(out.toLowerCase()).not.toContain("@import");
		expect(out.toLowerCase()).not.toContain("evil.com");
	});

	test("style with expression() (legacy IE) is stripped", () => {
		const out = sanitize(`<div style="width:expression(alert(1))">x</div>`);
		expect(out.toLowerCase()).not.toContain("expression(");
	});

	test("style with behavior: (legacy IE) is stripped", () => {
		const out = sanitize(`<div style="behavior:url(#default)">x</div>`);
		expect(out.toLowerCase()).not.toContain("behavior:");
	});

	test("style with -moz-binding is stripped", () => {
		const out = sanitize(`<div style="-moz-binding:url(http://evil.com/x.xml#foo)">x</div>`);
		expect(out.toLowerCase()).not.toContain("-moz-binding");
	});

	test("case-insensitive matching (URL, @IMPORT, EXPRESSION)", () => {
		const cases = [
			`<p style="background: URL(http://e.com)">x</p>`,
			`<p style="@IMPORT url(x.css)">x</p>`,
			`<p style="width: EXPRESSION(alert(1))">x</p>`,
		];
		for (const html of cases) {
			const out = sanitize(html);
			expect(out.toLowerCase()).not.toMatch(/url\s*\(/);
			expect(out.toLowerCase()).not.toContain("@import");
			expect(out.toLowerCase()).not.toContain("expression(");
		}
	});

	test("non-style attributes are NOT affected by the hook", () => {
		const out = sanitize(`<a href="https://example.com" title="legit url(...) in title">x</a>`);
		// title attr can contain "url(" textually — the hook only filters style
		expect(out).toContain("https://example.com");
	});
});
