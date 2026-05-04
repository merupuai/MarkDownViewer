// Golden render fixture — verifies the harness loads cleanly with no
// CSP violations and no console errors when rendering legitimate content.
import { test, expect } from "@playwright/test";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const harnessUrl = `file://${resolve(__dirname, "..", "..", "harness", "renderer-harness.html")}`;
const dompurifyPath = resolve(__dirname, "..", "..", "..", "node_modules", "dompurify", "dist", "purify.min.js");

test("legitimate markdown content renders without CSP violations or errors", async ({ page }) => {
	const consoleErrors: string[] = [];
	page.on("console", (msg) => {
		if (msg.type() === "error") consoleErrors.push(msg.text());
	});

	await page.goto(harnessUrl);
	const dompurifySource = readFileSync(dompurifyPath, "utf8");
	await page.addScriptTag({ content: dompurifySource });

	const snapshot = await page.evaluate(() => {
		const DP = (window as unknown as { DOMPurify: typeof import("dompurify") }).DOMPurify;
		const harness = (window as unknown as { __mdvHarness: { install: (d: unknown) => void; renderMarkdown: (h: string, d: unknown) => unknown; snapshot: () => unknown } }).__mdvHarness;
		harness.install(DP);
		harness.renderMarkdown(`
			<h1>Document Title</h1>
			<p>A paragraph with <strong>bold</strong>, <em>italic</em>, and <code>code</code>.</p>
			<p style="color: blue; font-weight: bold;">Styled paragraph (legit styles).</p>
			<a href="https://example.com" target="_blank">External link</a>
			<img src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" alt="dot">
			<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>
		`, DP);
		return harness.snapshot();
	}) as { contentHTML: string; cspViolations: unknown[]; networkAttempts: { url: string }[] };

	expect(snapshot.contentHTML).toContain("<h1");
	expect(snapshot.contentHTML).toContain("<strong>");
	expect(snapshot.contentHTML).toContain("color: blue");  // legit style preserved
	expect(snapshot.contentHTML).toContain('href="https://example.com"');
	expect(snapshot.contentHTML).toContain("data:image/gif;base64");
	expect(consoleErrors).toEqual([]);
});

test("CSP meta tag is present and well-formed", async ({ page }) => {
	await page.goto(harnessUrl);
	const cspContent = await page.evaluate(() => {
		const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
		return meta?.getAttribute("content") || "";
	});
	expect(cspContent).toContain("connect-src 'none'");
	expect(cspContent).toContain("frame-src 'none'");
	expect(cspContent).toContain("object-src 'none'");
	expect(cspContent).toContain("base-uri 'none'");
});
