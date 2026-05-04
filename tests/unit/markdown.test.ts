// Unit tests for src/mainview/markdown.ts (M1.S6 + verifies M1.S2-friendly output).
//
// Validates:
//  - parseDocument extracts well-formed YAML front-matter
//  - parseDocument records frontMatterError when delimiters are present but
//    YAML is malformed (closes SEC-004 / FR-07)
//  - parseDocument does NOT report an error when delimiters are absent
//  - parseDocument does NOT echo the offending body in the error (IR-07-02)
//  - markdown-it `html: true` is preserved (so DOMPurify remains the gate)
import { describe, test, expect } from "bun:test";
import { buildMarkdown, parseDocument } from "../../src/mainview/markdown";

describe("parseDocument — well-formed front-matter", () => {
	const md = buildMarkdown();

	test("extracts YAML front-matter when delimiters are well-formed", () => {
		const raw = `---\ntitle: Hello\ntags: [a, b]\n---\n\n# Body\n`;
		const out = parseDocument(md, raw);
		expect(out.frontMatter).not.toBeNull();
		expect(out.frontMatter?.title).toBe("Hello");
		expect(out.frontMatterError).toBeUndefined();
		expect(out.body).toContain("# Body");
		expect(out.html).toMatch(/<h1[\s>]/);
	});

	test("no front-matter delimiters → frontMatter null, no error", () => {
		const raw = `# Just a body\n\nNo front-matter here.\n`;
		const out = parseDocument(md, raw);
		expect(out.frontMatter).toBeNull();
		expect(out.frontMatterError).toBeUndefined();
	});
});

describe("parseDocument — malformed front-matter (M1.S6)", () => {
	const md = buildMarkdown();

	test("malformed YAML with valid delimiters surfaces frontMatterError", () => {
		// Tab+colon+unquoted-string-with-colon-and-newline pattern that
		// js-yaml SAFE_SCHEMA rejects.
		const raw = `---\nbroken: [unclosed\nbroken2: [\n---\n\n# Body still renders\n`;
		const out = parseDocument(md, raw);
		expect(out.frontMatterError).toBeDefined();
		expect(typeof out.frontMatterError).toBe("string");
		// Body still renders (M1.S6 acceptance: graceful degradation)
		expect(out.html).toMatch(/<h1[\s>]/);
		expect(out.html).toContain("Body still renders");
	});

	test("error message does NOT echo the offending body (IR-07-02)", () => {
		// User accidentally pastes something secret into front-matter.
		const secret = "AKIA1234567890SECRETLOOKINGSTRING";
		const raw = `---\nthis: is { malformed because: of [unbalanced ${secret} brackets\n---\n\n# Body\n`;
		const out = parseDocument(md, raw);
		expect(out.frontMatterError).toBeDefined();
		// The error message should NOT contain the user's accidentally-leaked
		// content. js-yaml's typical messages reference line/column, not body.
		expect(out.frontMatterError).not.toContain(secret);
	});
});

describe("parseDocument — html:true is preserved", () => {
	const md = buildMarkdown();

	test("inline HTML passes through (DOMPurify is the gate, not markdown-it)", () => {
		const raw = `<div class="custom">hello</div>`;
		const out = parseDocument(md, raw);
		// markdown-it should preserve the inline HTML; sanitization happens
		// downstream via DOMPurify in the renderer.
		expect(out.html).toContain('<div class="custom">');
	});
});
