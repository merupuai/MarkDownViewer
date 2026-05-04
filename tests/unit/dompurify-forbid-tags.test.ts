// Unit regression for the SANITIZE_OPTIONS.FORBID_TAGS contract
// (mirror of src/mainview/index.ts:148 — keep in sync if that const changes).
//
// Why this exists: the original <style>@import exfiltration defect (May 2026)
// was caught only by the e2e harness. When the harness was unrunnable the
// vuln sat undetected. A bun-test layer assertion is a tighter regression
// loop — runs on every `bun test`, no Playwright dependency.
//
// Closes: SEC-003 / FR-05 / SR-03 (element-level coverage; the existing
// dompurify-style-hook.test.ts covers the style ATTRIBUTE hook only).
import { describe, test, expect, beforeAll } from "bun:test";
import DOMPurify from "isomorphic-dompurify";

// MUST match src/mainview/index.ts SANITIZE_OPTIONS.FORBID_TAGS verbatim.
// If you change one, change the other — there is no shared module because
// index.ts has top-level side effects that prevent test-time import.
const FORBID_TAGS = ["script", "iframe", "object", "embed", "style", "link", "base", "meta"];

const config = {
	ADD_TAGS: ["div", "span", "p"],
	FORBID_TAGS,
	ALLOW_DATA_ATTR: true,
} as unknown as Parameters<typeof DOMPurify.sanitize>[1];

function sanitize(html: string): string {
	return DOMPurify.sanitize(html, config);
}

beforeAll(() => {
	// Ensure no leaking style-attribute hook from a sibling test affects us.
	// (dompurify-style-hook.test.ts adds a global hook; remove it for isolation.)
	DOMPurify.removeHook("uponSanitizeAttribute");
});

describe("DOMPurify FORBID_TAGS — element-level stripping", () => {
	for (const tag of FORBID_TAGS) {
		test(`<${tag}> element is stripped`, () => {
			const html = `<p>before</p><${tag}></${tag}><p>after</p>`;
			const out = sanitize(html);
			expect(out.toLowerCase()).not.toContain(`<${tag}`);
			// Surrounding legit content must survive (proof we're stripping the
			// forbidden tag, not nuking the whole tree).
			expect(out).toContain("before");
			expect(out).toContain("after");
		});
	}
});

describe("DOMPurify FORBID_TAGS — hostile-content regressions", () => {
	test("hostile <style>@import url(...) is stripped (closes May-2026 defect)", () => {
		const out = sanitize(`<p>x</p><style>@import url(http://evil.example.com/x.css);</style><p>y</p>`);
		expect(out.toLowerCase()).not.toContain("@import");
		expect(out.toLowerCase()).not.toContain("evil.example.com");
		expect(out).toContain("x");
		expect(out).toContain("y");
	});

	test("hostile <link rel=stylesheet href=...> is stripped", () => {
		const out = sanitize(`<p>x</p><link rel="stylesheet" href="http://evil.example.com/x.css"><p>y</p>`);
		expect(out.toLowerCase()).not.toContain("<link");
		expect(out.toLowerCase()).not.toContain("evil.example.com");
	});

	test("hostile <base href> is stripped (relative-URL hijack)", () => {
		const out = sanitize(`<p>x</p><base href="http://evil.example.com/"><a href="img.png">link</a>`);
		expect(out.toLowerCase()).not.toContain("<base");
		expect(out.toLowerCase()).not.toContain("evil.example.com");
		// Legitimate relative <a href> survives untouched.
		expect(out).toContain('href="img.png"');
	});

	test("hostile <meta http-equiv=refresh> is stripped", () => {
		const out = sanitize(`<p>x</p><meta http-equiv="refresh" content="0;url=http://evil.example.com"><p>y</p>`);
		expect(out.toLowerCase()).not.toContain("<meta");
		expect(out.toLowerCase()).not.toContain("evil.example.com");
	});

	test("hostile <iframe src> is stripped (existing contract — guard against regression)", () => {
		const out = sanitize(`<p>x</p><iframe src="http://evil.example.com"></iframe><p>y</p>`);
		expect(out.toLowerCase()).not.toContain("<iframe");
		expect(out.toLowerCase()).not.toContain("evil.example.com");
	});

	test("hostile <script> is stripped (existing contract — guard against regression)", () => {
		const out = sanitize(`<p>x</p><script>fetch('http://evil.example.com')</script><p>y</p>`);
		expect(out.toLowerCase()).not.toContain("<script");
		expect(out.toLowerCase()).not.toContain("evil.example.com");
	});
});
