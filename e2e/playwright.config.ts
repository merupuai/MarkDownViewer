// Playwright configuration for MarkDownViewer.
//
// This is a DESKTOP APP — there is no HTTP web server. The renderer runs in
// an Electrobun WebKit/WebView2 view that loads `views://mainview/index.html`
// inside the .app bundle. For tests we drive a static fixture
// (e2e/harness/renderer-harness.html) loaded via file:// in headless
// Chromium, with the SAME CSP and the SAME DOMPurify config the shipping
// renderer uses. This proves the security-critical M1 mitigations under a
// real browser security model without needing the full Electrobun runtime.
//
// CI matrix: macOS-latest + windows-latest. The harness is OS-agnostic, so
// we only run chromium projects (no Pixel 5 mobile profile — desktop app).
import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const harnessPath = resolve(__dirname, "harness", "renderer-harness.html");

export default defineConfig({
	testDir: "./tests",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 1 : undefined,

	reporter: [
		["html", { open: "never", outputFolder: "../_cobolt-output/latest/test-suite/playwright-report" }],
		["json", { outputFile: "../_cobolt-output/latest/test-suite/playwright-results.json" }],
		["list"],
	],

	outputDir: "../_cobolt-output/latest/test-suite/playwright-artifacts",

	use: {
		// Tests load the harness via file:// — we don't set baseURL here.
		// Each test calls page.goto(`file://${harnessPath}`) explicitly so it
		// can override path during fixture-driven tests.
		trace: "on-first-retry",
		screenshot: "only-on-failure",
		video: "retain-on-failure",
		actionTimeout: 5000,
		navigationTimeout: 10000,
	},

	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],

	// No webServer — desktop app, no HTTP. Tests load file:// directly.
	metadata: {
		harnessPath,
		appType: "desktop-electrobun",
		mitigationsTested: [
			"M1.S1 CSP meta tag",
			"M1.S2 DOMPurify style url() filter",
			"M1.S3 mermaid SVG sanitize (config-only — full mermaid render is in unit tests)",
			"M1.S6 front-matter parse error visibility",
			"M1.S8 lightbox focus restore (covered by harness when extended)",
		],
	},
});
