// postwrap.ts — Electrobun postWrap hook (run as `bun postwrap.ts`).
//
// After Electrobun produces the .app bundle, install our Cocoa launcher
// wrapper so file double-clicks deliver the URL to Bun on every launch.
import { existsSync, statSync } from "fs";
import { join, resolve } from "path";

const PROJECT_ROOT = resolve(import.meta.dir, "..");

const candidates = [
	"build/stable-macos-arm64/Markdown Viewer.app",
	"build/canary-macos-arm64/Markdown Viewer-canary.app",
	"build/dev-macos-arm64/Markdown Viewer-dev.app",
	"build/stable-macos-x64/Markdown Viewer.app",
	"build/dev-macos-x64/Markdown Viewer-dev.app",
];

let app: string | null = null;
let bestMtime = 0;
for (const rel of candidates) {
	const full = join(PROJECT_ROOT, rel);
	if (!existsSync(full)) continue;
	const m = statSync(full).mtimeMs;
	if (m > bestMtime) { bestMtime = m; app = full; }
}

if (!app) {
	console.log("[postwrap] No macOS .app found — skipping");
	process.exit(0);
}

console.log(`[postwrap] Wrapping launcher in ${app}`);

const wrapScript = join(PROJECT_ROOT, "scripts/wrap-launcher.sh");
const proc = Bun.spawnSync(["sh", wrapScript, app], {
	stdout: "inherit",
	stderr: "inherit",
});
if (proc.exitCode !== 0) {
	console.error("[postwrap] wrap-launcher.sh failed");
	process.exit(1);
}
