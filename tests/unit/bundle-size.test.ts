// F5 (Path B delta): bundle-size guard.
//
// Asserts the rendered editor bundle stays under a calibrated ceiling.
// M3's textarea-based editor design intentionally keeps the bundle small;
// without this guard, a future contributor adding a heavyweight dep (e.g.
// CodeMirror, Monaco) to the eager bundle could blow the budget silently.
//
// Skip-when-missing semantics: the test is a no-op if no release artifact
// exists on disk yet. Run `bun run test:bundle` in CI (or locally) to do
// `build:release` first then assert. Plain `bun test` is unaffected.
//
// Calibrating the ceiling: the M3 textarea baseline is ~300-400 KB
// renderer JS (markdown-it + DOMPurify + KaTeX + highlight.js + mermaid
// lazy-loaded). 800 KB ceiling gives ~2x slack for normal evolution.
// Update CEILING when intentionally taking a budget hit; leave it strict.
import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "fs";
import { join } from "path";

const CEILING = 800_000; // 800 KB — tune to your measured POST_DELTA × 1.5

// All known build target paths. The test passes if at least one exists
// and is under the ceiling — covers macOS arm64/x64, Windows x64, plus
// dev builds.
const candidates = [
	"build/stable-macos-arm64/Markdown Viewer.app/Contents/Resources/app/views/mainview/index.js",
	"build/stable-macos-x64/Markdown Viewer.app/Contents/Resources/app/views/mainview/index.js",
	"build/stable-windows-x64/views/mainview/index.js",
	"build/dev-macos-arm64/Markdown Viewer-dev.app/Contents/Resources/app/views/mainview/index.js",
	"build/dev-macos-x64/Markdown Viewer-dev.app/Contents/Resources/app/views/mainview/index.js",
	"build/dev-windows-x64/views/mainview/index.js",
	// Canary builds also covered for completeness
	"build/canary-macos-arm64/Markdown Viewer-canary.app/Contents/Resources/app/views/mainview/index.js",
];

describe("bundle size (F5)", () => {
	test("renderer bundle is under ceiling", () => {
		const found = candidates
			.map((rel) => join(process.cwd(), rel))
			.filter((p) => existsSync(p))
			.map((p) => ({ path: p, size: statSync(p).size }));

		if (found.length === 0) {
			// No build artifact on disk yet. Skip with a clear hint —
			// running `bun run test:bundle` builds release first.
			console.warn("[bundle-size] no build artifact found; run `bun run test:bundle` to build release first. Skipping assertion.");
			return;
		}

		for (const { path, size } of found) {
			expect(size, `${path} is ${size} bytes; ceiling is ${CEILING}`).toBeLessThan(CEILING);
		}
	});
});
