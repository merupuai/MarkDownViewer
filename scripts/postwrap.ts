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

// Install bundle icon. Electrobun's beta does not yet reliably honor
// `app.icon` in the config, so we copy icon.icns into Contents/Resources
// and patch CFBundleIconFile in Info.plist ourselves. Idempotent.
const icnsSrc = join(PROJECT_ROOT, "assets/brand/icon.icns");
if (existsSync(icnsSrc)) {
	const resources = join(app, "Contents/Resources");
	const icnsDst = join(resources, "AppIcon.icns");
	const plist = join(app, "Contents/Info.plist");

	console.log(`[postwrap] Installing bundle icon -> ${icnsDst}`);
	const cp = Bun.spawnSync(["cp", "-f", icnsSrc, icnsDst], {
		stdout: "inherit", stderr: "inherit",
	});
	if (cp.exitCode !== 0) {
		console.warn("[postwrap] icon copy failed (non-fatal)");
	} else if (existsSync(plist)) {
		// `plutil -replace` adds the key if missing, replaces if present.
		const pl = Bun.spawnSync(
			["plutil", "-replace", "CFBundleIconFile", "-string", "AppIcon", plist],
			{ stdout: "inherit", stderr: "inherit" },
		);
		if (pl.exitCode !== 0) {
			console.warn("[postwrap] plutil patch failed (non-fatal)");
		} else {
			console.log("[postwrap] CFBundleIconFile = AppIcon");
		}
	}
} else {
	console.log("[postwrap] No assets/brand/icon.icns yet (run `bun run gen:icons`)");
}
