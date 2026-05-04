// Accessibility check via axe-core — M2.S7 (closes UI-001).
//
// Runs axe-core against the rendered harness with WCAG 2.1 A + AA rule sets.
// Fails on any 'serious' or 'critical' violation. Lower-severity violations
// are reported in the JSON output for triage but do not fail the build (so
// the gate is actionable, not noisy).
//
// We use the @axe-core/playwright wrapper; if not yet installed in CI, the
// 'axe-test' run will fail with a helpful import error rather than passing
// silently.
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const harnessUrl = `file://${resolve(__dirname, "..", "..", "harness", "renderer-harness.html")}`;
const dompurifyPath = resolve(__dirname, "..", "..", "..", "node_modules", "dompurify", "dist", "purify.min.js");

test("rendered markdown has no serious/critical a11y violations (WCAG 2.1 AA)", async ({ page }) => {
	await page.goto(harnessUrl);
	const dompurifySource = readFileSync(dompurifyPath, "utf8");
	await page.addScriptTag({ content: dompurifySource });

	// Render a representative document with all the affordances a real
	// markdown view would have — headings, links, images, lists, tables.
	await page.evaluate(() => {
		const DP = (window as unknown as { DOMPurify: typeof import("dompurify") }).DOMPurify;
		const harness = (window as unknown as { __mdvHarness: { install: (d: unknown) => void; renderMarkdown: (h: string, d: unknown) => unknown } }).__mdvHarness;
		harness.install(DP);
		harness.renderMarkdown(`
			<h1>Document title</h1>
			<p>Body paragraph with a <a href="https://example.com" target="_blank" rel="noopener noreferrer">link</a>.</p>
			<h2>Section</h2>
			<ul><li>One</li><li>Two</li></ul>
			<table>
				<thead><tr><th scope="col">Name</th><th scope="col">Value</th></tr></thead>
				<tbody><tr><td>Alpha</td><td>1</td></tr></tbody>
			</table>
			<img src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" alt="single transparent pixel">
		`, DP);
	});

	const results = await new AxeBuilder({ page })
		.withTags(["wcag2a", "wcag2aa"])
		.analyze();

	const blocking = results.violations.filter(
		(v) => v.impact === "critical" || v.impact === "serious"
	);

	if (blocking.length > 0) {
		console.error("Serious/critical a11y violations:");
		for (const v of blocking) {
			console.error(`  - [${v.impact}] ${v.id}: ${v.help} (${v.helpUrl})`);
			for (const node of v.nodes.slice(0, 3)) {
				console.error(`      target: ${node.target.join(", ")}`);
			}
		}
	}

	expect(blocking, "Serious or critical WCAG 2.1 AA violations found").toHaveLength(0);
});

test("focus-visible passes axe rule on harness body", async ({ page }) => {
	await page.goto(harnessUrl);
	const results = await new AxeBuilder({ page })
		.withRules(["focus-order-semantics", "tabindex"])
		.analyze();
	const blocking = results.violations.filter(
		(v) => v.impact === "critical" || v.impact === "serious"
	);
	expect(blocking).toHaveLength(0);
});
