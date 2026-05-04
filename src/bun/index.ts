import {
	BrowserView,
	BrowserWindow,
	Utils,
	ApplicationMenu,
} from "electrobun/bun";
import Electrobun from "electrobun/bun";
import { watch, readdirSync, statSync, mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, realpathSync, chmodSync, type FSWatcher } from "fs";
import { fileURLToPath } from "url";
import { basename, join, dirname, resolve, extname, sep as pathSep } from "path";
import type { AppRPC, FilePayload, FolderPayload, TreeNode, RecentEntry, SearchResults, SearchHit } from "../shared/rpc";
import { append as logAppend, logPath as resolvedLogPath } from "./log";

// Resolve the typed rpc object that BrowserView.defineRPC<AppRPC>(...) returns,
// so mainWindow.webview.rpc.send.* is fully typed against AppRPC.webview.messages
// instead of falling back to the loose RPCWithTransport default.
type AppBunRPC = ReturnType<typeof BrowserView.defineRPC<AppRPC>>;

const APP_NAME = "MarkdownViewer";
const PLATFORM_HOME = Bun.env["HOME"] || Bun.env["USERPROFILE"] || "/";

// ============== License gate ==============
// MIT (Non-Resale Variant) — © 2026 MFTLabs · Developed by CoBolt.
// EULA_VERSION is bumped if license terms materially change so users must
// re-accept. The marker file lives in the OS-canonical user-data dir and is
// also pre-populated by the Windows Inno Setup installer (which collects
// click-through acceptance at install time).
const EULA_VERSION = "v1";
function eulaUserDataDir(): string {
	if (process.platform === "darwin") {
		return join(PLATFORM_HOME, "Library", "Application Support", "com.local.markdownviewer");
	}
	if (process.platform === "win32") {
		return join(Bun.env["APPDATA"] || PLATFORM_HOME, "MarkdownViewer");
	}
	return join(Bun.env["XDG_CONFIG_HOME"] || join(PLATFORM_HOME, ".config"), "markdown-viewer");
}
const EULA_MARKER = join(eulaUserDataDir(), `eula-accepted-${EULA_VERSION}`);

let mainWindow: BrowserWindow<AppBunRPC> | null = null;
let pendingInitialFile: FilePayload | null = null;
let viewReady = false;
let currentFileWatcher: FSWatcher | null = null;
let currentFolderWatcher: FSWatcher | null = null;
let currentWatchedPath: string | null = null;
let currentFolderRoot: string | null = null;

// ============== Utilities ==============
function urlToPath(url: string): string {
	if (url.startsWith("file://")) return fileURLToPath(url);
	return url;
}

// ============== License acceptance gate ==============
// Returns true if the user has already accepted (marker present), or if they
// accept the dialog now. Returns false on decline → caller should exit.
// On Linux without zenity available, defaults to permissive (CLI / headless).
function ensureEulaAccepted(): boolean {
	if (existsSync(EULA_MARKER)) return true;

	const accepted = showEulaDialog();
	if (!accepted) return false;

	try {
		mkdirSync(eulaUserDataDir(), { recursive: true });
		writeFileSync(EULA_MARKER, `${new Date().toISOString()} (accepted at first run)\n`);
		// M1.S9 (closes 26c § 4): make the marker non-world-writable on POSIX.
		// chmodSync is a no-op for the bits it ignores on Windows, so it's safe.
		if (process.platform !== "win32") {
			try { chmodSync(EULA_MARKER, 0o644); } catch (err) { logAppend(`[mv] WARN: chmod 0644 on EULA marker failed: ${String(err)}\n`); }
		}
	} catch (err) {
		logAppend(`[mv] WARN: failed to persist EULA marker at ${EULA_MARKER}: ${String(err)}\n`);
	}
	return true;
}

// Plain license summary — used both by the first-run accept gate and the
// re-displayable "License…" menu item. Full legal text lives in LICENSE.
const LICENSE_SUMMARY_LINES = [
	"Markdown Viewer",
	"© 2026 MFTLabs · Developed by CoBolt",
	"",
	"This software is FREE for personal, educational, and internal business",
	"use under the MIT (Non-Resale Variant) license.",
	"",
	"You MAY: use, copy, modify, and redistribute it freely.",
	"You MAY NOT: sell, resell, sublicense for a fee, or bundle it inside a",
	"paid commercial product without prior written permission from MFTLabs.",
];

// Re-displayable license info dialog (no acceptance, just OK).
function showLicenseInfo(): void {
	const lines = [...LICENSE_SUMMARY_LINES, "",
		"For full legal text see the LICENSE file shipped with this app.",
		"For commercial / resale licensing inquiries, contact MFTLabs."];

	if (process.platform === "darwin") {
		const text = lines.join("\\n").replace(/"/g, '\\"');
		const script = `display dialog "${text}" with title "About Markdown Viewer — License" `
			+ `buttons {"OK"} default button 1 with icon note`;
		try { Bun.spawnSync(["osascript", "-e", script]); } catch {}
		return;
	}
	if (process.platform === "win32") {
		const text = lines.join("`n").replace(/'/g, "''");
		const script = "Add-Type -AssemblyName System.Windows.Forms;"
			+ ` [System.Windows.Forms.MessageBox]::Show('${text}',`
			+ " 'About Markdown Viewer - License',"
			+ " [System.Windows.Forms.MessageBoxButtons]::OK,"
			+ " [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null";
		try { Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", script]); } catch {}
		return;
	}
	for (const cmd of [
		["zenity", "--info", "--title=About Markdown Viewer — License", `--text=${lines.join("\n")}`],
		["kdialog", "--title", "About Markdown Viewer — License", "--msgbox", lines.join("\n")],
	]) {
		try {
			const proc = Bun.spawnSync(cmd);
			if (proc.exitCode === 0) return;
		} catch {}
	}
}

function showEulaDialog(): boolean {
	const lines = [...LICENSE_SUMMARY_LINES, "",
		"By clicking \"I Agree\" you accept these terms."];

	if (process.platform === "darwin") {
		// osascript: cancel button → non-zero exit; default = "I Agree".
		const text = lines.join("\\n").replace(/"/g, '\\"');
		const script = `display dialog "${text}" with title "License Agreement — Markdown Viewer" `
			+ `buttons {"Decline & Quit", "I Agree"} `
			+ `default button 2 cancel button 1 with icon caution`;
		try {
			const proc = Bun.spawnSync(["osascript", "-e", script]);
			return proc.exitCode === 0;
		} catch { return false; }
	}

	if (process.platform === "win32") {
		// Used only when the Inno Setup installer didn't pre-drop the marker
		// (e.g. manual registry-import install or dev build). MessageBox Yes=6.
		const text = lines.join("`n").replace(/'/g, "''");
		const script = "Add-Type -AssemblyName System.Windows.Forms;"
			+ ` $r = [System.Windows.Forms.MessageBox]::Show('${text}',`
			+ " 'License Agreement - Markdown Viewer',"
			+ " [System.Windows.Forms.MessageBoxButtons]::YesNo,"
			+ " [System.Windows.Forms.MessageBoxIcon]::Information,"
			+ " [System.Windows.Forms.MessageBoxDefaultButton]::Button1);"
			+ " if ($r -eq 'Yes') { exit 0 } else { exit 1 }";
		try {
			const proc = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", script]);
			return proc.exitCode === 0;
		} catch { return false; }
	}

	// Linux: try zenity, then kdialog. If neither exists, allow (CLI/headless).
	const text = lines.join("\n");
	for (const cmd of [
		["zenity", "--question", "--title=License Agreement — Markdown Viewer",
			`--text=${text}`, "--ok-label=I Agree", "--cancel-label=Decline & Quit"],
		["kdialog", "--title", "License Agreement — Markdown Viewer",
			"--yesno", text, "--yes-label", "I Agree", "--no-label", "Decline & Quit"],
	]) {
		try {
			const proc = Bun.spawnSync(cmd);
			if (proc.exitCode === 0) return true;
			if (proc.exitCode === 1) return false;
			// any other code → tool not found / error → try next
		} catch { /* try next */ }
	}
	// No GUI dialog tool available — permissive fallback.
	return true;
}

const MD_EXT_RE = /\.(md|markdown|mdown|mkd|mkdn|mdx)$/i;
const SKIP_DIRS = new Set([
	"node_modules", ".git", ".svn", ".hg", "dist", "build", ".next",
	".cache", ".idea", ".vscode", "target", "Pods", ".DS_Store",
	"vendor", "bower_components", ".turbo", "out", ".electrobun-cache",
]);
const MAX_TREE_ENTRIES = 5000;
const MAX_TREE_DEPTH = 8;
const MAX_SEARCH_HITS_PER_FILE = 20;
const MAX_SEARCH_TOTAL_HITS = 500;
const MAX_SEARCH_FILES = 5000;
const MAX_SEARCH_FILE_SIZE = 2 * 1024 * 1024; // 2MB

// ============== File ops ==============
async function readMarkdownFile(path: string): Promise<FilePayload> {
	try {
		const file = Bun.file(path);
		if (!(await file.exists())) {
			return { path, content: "", error: `File not found: ${path}` };
		}
		const content = await file.text();
		return { path, content };
	} catch (err) {
		return { path, content: "", error: err instanceof Error ? err.message : String(err) };
	}
}

function watchFile(path: string) {
	if (currentFileWatcher) {
		try { currentFileWatcher.close(); } catch {}
		currentFileWatcher = null;
	}
	currentWatchedPath = path;
	try {
		let debounce: ReturnType<typeof setTimeout> | null = null;
		currentFileWatcher = watch(path, { persistent: false }, (eventType) => {
			if (eventType !== "change") return;
			if (debounce) clearTimeout(debounce);
			debounce = setTimeout(async () => {
				if (path !== currentWatchedPath) return;
				const payload = await readMarkdownFile(path);
				if (mainWindow) mainWindow.webview.rpc?.send.fileChanged(payload);
			}, 80);
		});
	} catch (err) {
		console.error("[markdown-viewer] failed to watch file:", path, err);
	}
}

// ============== Folder ops ==============
function walkFolder(root: string): FolderPayload {
	let count = 0;
	let truncated = false;
	function walk(dir: string, depth: number): TreeNode[] {
		if (depth > MAX_TREE_DEPTH || truncated) return [];
		let entries: string[];
		try { entries = readdirSync(dir); } catch { return []; }
		const nodes: TreeNode[] = [];
		entries.sort((a, b) => a.localeCompare(b));
		for (const name of entries) {
			if (truncated) break;
			if (name.startsWith(".")) continue;
			if (SKIP_DIRS.has(name)) continue;
			const full = join(dir, name);
			let st: ReturnType<typeof statSync>;
			try { st = statSync(full); } catch { continue; }
			if (st.isDirectory()) {
				const children = walk(full, depth + 1);
				if (children.length > 0) nodes.push({ type: "dir", name, path: full, children });
			} else if (st.isFile() && MD_EXT_RE.test(name)) {
				count++;
				if (count > MAX_TREE_ENTRIES) { truncated = true; break; }
				nodes.push({ type: "file", name, path: full });
			}
		}
		nodes.sort((a, b) => {
			if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
		return nodes;
	}
	const tree = walk(root, 0);
	return { root, tree, truncated, count };
}

function watchFolder(root: string) {
	if (currentFolderWatcher) {
		try { currentFolderWatcher.close(); } catch {}
		currentFolderWatcher = null;
	}
	currentFolderRoot = root;
	try {
		let debounce: ReturnType<typeof setTimeout> | null = null;
		currentFolderWatcher = watch(root, { recursive: true, persistent: false }, () => {
			if (debounce) clearTimeout(debounce);
			debounce = setTimeout(() => {
				if (root !== currentFolderRoot) return;
				try {
					const updated = walkFolder(root);
					if (mainWindow) mainWindow.webview.rpc?.send.folderUpdated(updated);
				} catch {}
			}, 250);
		});
	} catch (err) {
		console.error("[markdown-viewer] failed to watch folder:", root, err);
	}
}

// ============== Search in folder ==============
function searchInFolder(root: string, query: string, caseSensitive: boolean, wholeWord: boolean): SearchResults {
	const hits: SearchHit[] = [];
	let scanned = 0;
	let matched = 0;
	let truncated = false;
	if (!query) return { query, hits, truncated, scanned, matched };

	const flags = caseSensitive ? "g" : "gi";
	const escaped = query.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
	const pattern = wholeWord ? `\\b${escaped}\\b` : escaped;
	let regex: RegExp;
	try { regex = new RegExp(pattern, flags); } catch { return { query, hits, truncated, scanned, matched }; }

	function walk(dir: string, depth: number) {
		if (depth > MAX_TREE_DEPTH || truncated) return;
		let entries: string[];
		try { entries = readdirSync(dir); } catch { return; }
		for (const name of entries) {
			if (truncated) break;
			if (name.startsWith(".")) continue;
			if (SKIP_DIRS.has(name)) continue;
			const full = join(dir, name);
			let st: ReturnType<typeof statSync>;
			try { st = statSync(full); } catch { continue; }
			if (st.isDirectory()) walk(full, depth + 1);
			else if (st.isFile() && MD_EXT_RE.test(name) && st.size <= MAX_SEARCH_FILE_SIZE) {
				scanned++;
				if (scanned > MAX_SEARCH_FILES) { truncated = true; break; }
				let content: string;
				try { content = readFileSync(full, "utf8"); } catch { continue; }
				const matches: SearchHit["matches"] = [];
				const lines = content.split(/\r?\n/);
				for (let i = 0; i < lines.length && matches.length < MAX_SEARCH_HITS_PER_FILE; i++) {
					regex.lastIndex = 0;
					const m = regex.exec(lines[i]);
					if (!m) continue;
					matches.push({
						line: i + 1,
						column: m.index,
						length: m[0].length,
						preview: lines[i].length > 200 ? lines[i].slice(0, 200) + "…" : lines[i],
					});
					if (hits.length === 0 && matches.length === 1) matched++;
				}
				if (matches.length > 0) {
					if (hits.length === 0) {} else matched++;
					hits.push({ path: full, name, matches });
					const total = hits.reduce((a, h) => a + h.matches.length, 0);
					if (total >= MAX_SEARCH_TOTAL_HITS) { truncated = true; break; }
				}
			}
		}
	}
	matched = 0;
	walk(root, 0);
	matched = hits.length;
	return { query, hits, truncated, scanned, matched };
}

// ============== Recent files ==============
function recentFilePath(): string {
	const dir = (Utils as any).paths?.userData || join(PLATFORM_HOME, `.${APP_NAME}`);
	try { mkdirSync(dir, { recursive: true }); } catch {}
	return join(dir, "recent.json");
}

function loadRecent(): RecentEntry[] {
	try {
		const raw = readFileSync(recentFilePath(), "utf8");
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) return parsed.filter((e) => e && typeof e.path === "string");
	} catch {}
	return [];
}

function saveRecent(entries: RecentEntry[]) {
	try { writeFileSync(recentFilePath(), JSON.stringify(entries.slice(0, 20), null, 2), "utf8"); } catch {}
}

function pushRecent(path: string) {
	const list = loadRecent().filter((e) => e.path !== path);
	list.unshift({ path, name: basename(path), openedAt: Date.now() });
	saveRecent(list);
}

// ============== Image path resolution ==============
//
// M1.S4 (closes SEC-002 / FR-04): every src is resolved against the document
// directory, then realpath-normalized to follow symlinks/junctions, then
// rejected unless the resulting absolute path is contained inside the
// allowlist (the doc dir itself, OR — when a folder is open — the open folder
// root). A hostile <img src="../../.ssh/id_rsa"> resolves outside docDir and
// returns {error: "out-of-bounds"}.
//
// M1.S5 (closes SR-05): the extension must be one of the IMAGE_MIME keys.
// The previous "application/octet-stream" fallthrough — which let any file
// type be returned as a base64 data URL — is removed.
const IMAGE_MIME: Record<string, string> = {
	png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
	gif: "image/gif", svg: "image/svg+xml", webp: "image/webp",
	bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif",
};
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB sanity cap

function realCanonical(p: string): string {
	try { return realpathSync(p); } catch { return resolve(p); }
}

function isContainedIn(candidate: string, baseDir: string): boolean {
	const normalizedBase = realCanonical(baseDir);
	const normalizedCand = realCanonical(candidate);
	const baseWithSep = normalizedBase.endsWith(pathSep) ? normalizedBase : normalizedBase + pathSep;
	return normalizedCand === normalizedBase || normalizedCand.startsWith(baseWithSep);
}

function resolveImage(docPath: string, src: string): { dataUrl: string } | { error: string } {
	try {
		if (/^(https?:|data:|file:)/.test(src)) return { error: "external" };
		const docDir = dirname(docPath);
		const resolved = resolve(docDir, src);

		// MIME enforcement BEFORE filesystem access — keep the rejection
		// purely textual until we know we're allowed to read the file.
		const ext = extname(resolved).toLowerCase().slice(1);
		const mt = IMAGE_MIME[ext];
		if (!mt) return { error: `unsupported-type:${ext || "(none)"}` };

		// Path containment: resolved path must be under docDir, OR under the
		// currently open folder root if any. A hostile relative path like
		// `../../.ssh/id_rsa` resolves outside both and is rejected.
		const allowedRoots = [docDir];
		if (currentFolderRoot) allowedRoots.push(currentFolderRoot);
		const inBounds = allowedRoots.some((root) => isContainedIn(resolved, root));
		if (!inBounds) return { error: `out-of-bounds:${resolved}` };

		if (!existsSync(resolved)) return { error: `not-found:${resolved}` };
		const stat = statSync(resolved);
		if (!stat.isFile()) return { error: `not-a-file:${resolved}` };
		if (stat.size > MAX_IMAGE_BYTES) return { error: `too-large:${stat.size}` };

		const buf = readFileSync(resolved);
		return { dataUrl: `data:${mt};base64,${buf.toString("base64")}` };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

// ============== Dispatch helpers ==============
async function dispatchFile(path: string) {
	const payload = await readMarkdownFile(path);
	if (!payload.error) pushRecent(path);
	if (mainWindow) {
		mainWindow.setTitle(basename(path));
		try { (mainWindow as any).setRepresentedFilename?.(path); } catch {}
	}
	if (viewReady && mainWindow) {
		mainWindow.webview.rpc?.send.fileOpened(payload);
		watchFile(path);
	} else {
		pendingInitialFile = payload;
	}
}

// ============== RPC ==============
const rpc = BrowserView.defineRPC<AppRPC>({
	maxRequestTime: 15000,
	handlers: {
		requests: {
			openDialog: async () => {
				const paths = await Utils.openFileDialog({
					startingFolder: PLATFORM_HOME,
					canChooseFiles: true,
					canChooseDirectory: false,
					allowsMultipleSelection: false,
				});
				const chosen = paths?.[0];
				if (!chosen) return null;
				const payload = await readMarkdownFile(chosen);
				if (!payload.error) pushRecent(chosen);
				if (mainWindow) {
					mainWindow.setTitle(basename(chosen));
					try { (mainWindow as any).setRepresentedFilename?.(chosen); } catch {}
				}
				watchFile(chosen);
				return payload;
			},
			openFolderDialog: async () => {
				const paths = await Utils.openFileDialog({
					startingFolder: PLATFORM_HOME,
					canChooseFiles: false,
					canChooseDirectory: true,
					allowsMultipleSelection: false,
				});
				const chosen = paths?.[0];
				if (!chosen) return null;
				const payload = walkFolder(chosen);
				watchFolder(chosen);
				return payload;
			},
			readFile: async ({ path }) => {
				const real = urlToPath(path);
				const payload = await readMarkdownFile(real);
				if (!payload.error) pushRecent(real);
				if (mainWindow && !payload.error) mainWindow.setTitle(basename(real));
				watchFile(real);
				return payload;
			},
			resolveImage: async ({ docPath, src }) => resolveImage(docPath, src),
			getInitialFile: async () => {
				const f = pendingInitialFile;
				pendingInitialFile = null;
				if (f && !f.error) watchFile(f.path);
				return f;
			},
			openExternal: async ({ url }) => {
				try {
					const isWin = process.platform === "win32";
					const cmd = isWin ? ["cmd", "/c", "start", "", url] : ["open", url];
					const proc = Bun.spawn(cmd);
					await proc.exited;
					return { ok: true };
				} catch { return { ok: false }; }
			},
			revealInFinder: async ({ path }) => {
				try {
					const isWin = process.platform === "win32";
					const cmd = isWin
						? ["explorer", "/select,", path]
						: ["open", "-R", path];
					Bun.spawn(cmd);
					return { ok: true };
				} catch { return { ok: false }; }
			},
			getRecent: async () => loadRecent(),
			clearRecent: async () => { saveRecent([]); return { ok: true }; },
			searchFolder: async ({ root, query, caseSensitive, wholeWord }) => {
				const r = root || currentFolderRoot;
				if (!r) return { query, hits: [], truncated: false, scanned: 0, matched: 0 };
				return searchInFolder(r, query, !!caseSensitive, !!wholeWord);
			},
			exportHtml: async ({ html, title, defaultName }) => {
				try {
					const folder = await Utils.openFileDialog({
						startingFolder: PLATFORM_HOME,
						canChooseFiles: false,
						canChooseDirectory: true,
						allowsMultipleSelection: false,
					});
					const dir = folder?.[0];
					if (!dir) return { ok: false };
					const safeName = (defaultName || title || "document").replace(/[^A-Za-z0-9._-]/g, "_");
					const target = join(dir, `${safeName}.html`);
					await Bun.write(target, html);
					return { ok: true, path: target };
				} catch { return { ok: false }; }
			},
			// ============== Window controls ==============
			// Required because the main window uses a custom (non-native) titlebar
			// on Windows/Linux — the renderer draws min/max/close buttons that
			// proxy here. macOS continues to use the OS traffic-light buttons via
			// titleBarStyle: "hiddenInset" and never calls these RPCs.
			windowMinimize: async () => {
				try { mainWindow?.minimize(); return { ok: true }; }
				catch { return { ok: false }; }
			},
			windowMaximizeToggle: async () => {
				try {
					if (!mainWindow) return { ok: false, maximized: false };
					if (mainWindow.isMaximized()) {
						mainWindow.unmaximize();
						return { ok: true, maximized: false };
					}
					mainWindow.maximize();
					return { ok: true, maximized: true };
				} catch { return { ok: false, maximized: false }; }
			},
			windowClose: async () => {
				try { mainWindow?.close(); return { ok: true }; }
				catch { return { ok: false }; }
			},
			getPlatform: async () => ({
				platform: process.platform as "darwin" | "win32" | "linux",
				isMac: process.platform === "darwin",
			}),
		},
		messages: {
			ready: () => {
				viewReady = true;
				if (pendingInitialFile && mainWindow) {
					mainWindow.webview.rpc?.send.fileOpened(pendingInitialFile);
					if (!pendingInitialFile.error) watchFile(pendingInitialFile.path);
					pendingInitialFile = null;
				}
				// Push initial maximised state so the renderer's titlebar shows the
				// correct maximize-vs-restore icon on first paint.
				try {
					if (mainWindow) {
						mainWindow.webview.rpc?.send.windowStateChanged({
							maximized: mainWindow.isMaximized(),
						});
					}
				} catch {}
			},
			print: () => {
				try { (mainWindow as any)?.webview?.print?.(); } catch {}
			},
			log: ({ level, msg }) => {
				logAppend(`[view ${level}] ${msg}\n`);
			},
		},
	},
});

// ============== Boot ==============
function dbg(...args: unknown[]) {
	const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
	// M1.S7 (closes SEC-005 / FR-08): portable rotating log via src/bun/log.ts.
	logAppend(line);
	console.log(...args);
}
dbg("[mv] log file:", resolvedLogPath());
dbg("[mv] boot — Bun.argv =", JSON.stringify(Bun.argv), "ppid=", process.ppid);

// ============== License gate (must run before window creation) ==============
// On first run, show a native license-acceptance dialog. The marker file is
// pre-populated by the Windows Inno Setup installer so this is a no-op there
// for installer-based installs.
if (!ensureEulaAccepted()) {
	dbg("[mv] EULA declined — quitting");
	process.exit(0);
}
dbg("[mv] EULA", EULA_VERSION, "accepted (marker:", EULA_MARKER + ")");

// Workaround: Electrobun's launcher (Zig binary) does not forward argv to Bun
// (see launcher/main.zig — it hardcodes ["./bun", resources_path]).
// Read the parent (launcher) process's argv via `ps` to recover the file path
// passed by LaunchServices when the user double-clicks a .md file in Finder.
// Sources for the file to open at launch (in priority order):
//   1) Bun.argv (only when launcher invoked directly with file)
//   2) MV_PENDING_URL env var (Cocoa launcher wrapper sets this)
//   3) /tmp/mdv-pending-url-<pid> file (also written by Cocoa wrapper)
//   4) open-url event (fires for first-launch via LaunchServices only)
function tryReadPendingUrlFile(): string | null {
	try {
		const pid = Bun.env["MV_LAUNCHER_PID"];
		if (!pid) return null;
		const path = `/tmp/mdv-pending-url-${pid}`;
		if (!existsSync(path)) return null;
		const raw = readFileSync(path, "utf8").trim();
		try { (require("fs") as typeof import("fs")).unlinkSync(path); } catch {}
		const first = raw.split("\n")[0].trim();
		return first || null;
	} catch { return null; }
}

const argvFile = Bun.argv.slice(1).find((a) => MD_EXT_RE.test(a));
const envUrl = Bun.env["MV_PENDING_URL"];
const pendingFromFile = tryReadPendingUrlFile();
dbg("[mv] sources — argv:", argvFile || "(none)",
	"env MV_PENDING_URL:", envUrl || "(none)",
	"pending file:", pendingFromFile || "(none)");

let initialFile: string | null = null;
if (argvFile) initialFile = argvFile;
else if (pendingFromFile) initialFile = pendingFromFile.startsWith("file://") ? urlToPath(pendingFromFile) : pendingFromFile;
else if (envUrl) initialFile = envUrl.startsWith("file://") ? urlToPath(envUrl) : envUrl;

if (initialFile && MD_EXT_RE.test(initialFile)) {
	dbg("[mv] dispatching initial file:", initialFile);
	dispatchFile(initialFile);
}

Electrobun.events.on("open-url", (e) => {
	dbg("[mv] open-url event:", JSON.stringify(e.data));
	const url = e.data.url;
	if (!url) return;
	if (url.startsWith("file://")) dispatchFile(urlToPath(url));
});

ApplicationMenu.setApplicationMenu([
	{
		submenu: [
			{ role: "about" },
			{ type: "separator" },
			{ role: "services" },
			{ type: "separator" },
			{ role: "hide" },
			{ role: "hideOthers" },
			{ role: "unhide" },
			{ type: "separator" },
			{ role: "quit" },
		],
	},
	{
		label: "File",
		submenu: [
			{ label: "Open File…", action: "open-file", accelerator: "cmd+o" },
			{ label: "Open Folder…", action: "open-folder", accelerator: "cmd+shift+o" },
			{ type: "separator" },
			{ label: "Reveal in Finder", action: "reveal-in-finder", accelerator: "cmd+shift+r" },
			{ type: "separator" },
			{ label: "Print…", action: "print", accelerator: "cmd+p" },
			{ label: "Export to HTML…", action: "export-html" },
			{ type: "separator" },
			{ role: "close" },
		],
	},
	{
		label: "Edit",
		submenu: [
			{ role: "undo" },
			{ role: "redo" },
			{ type: "separator" },
			{ role: "cut" },
			{ role: "copy" },
			{ role: "paste" },
			{ role: "selectAll" },
			{ type: "separator" },
			{ label: "Find in Document", action: "find", accelerator: "cmd+f" },
			{ label: "Find in Folder", action: "find-in-folder", accelerator: "cmd+shift+f" },
		],
	},
	{
		label: "View",
		submenu: [
			{ label: "Reload", action: "reload", accelerator: "cmd+r" },
			{ type: "separator" },
			{ label: "Toggle Sidebar", action: "toggle-sidebar", accelerator: "cmd+\\" },
			{ label: "Toggle Theme", action: "toggle-theme", accelerator: "cmd+d" },
			{ type: "separator" },
			{ label: "Zoom In", action: "zoom-in", accelerator: "cmd+=" },
			{ label: "Zoom Out", action: "zoom-out", accelerator: "cmd+-" },
			{ label: "Reset Zoom", action: "zoom-reset", accelerator: "cmd+0" },
			{ type: "separator" },
			{ role: "togglefullscreen" },
		],
	},
	{
		label: "Window",
		submenu: [
			{ role: "minimize" },
			{ role: "zoom" },
			{ type: "separator" },
			{ role: "front" },
		],
	},
	{
		label: "Help",
		submenu: [
			{ label: "License…", action: "show-license" },
		],
	},
]);

Electrobun.events.on("application-menu-clicked", (e) => {
	const action = e.data.action;
	if (!action) return;
	// Handle license action in the main process (native dialog, no renderer needed).
	if (action === "show-license") { showLicenseInfo(); return; }
	if (!mainWindow) return;
	mainWindow.webview.rpc?.send.menuAction({ action });
});

// titleBarStyle is a macOS-defined concept. On macOS "hiddenInset" gives the
// transparent titlebar with native traffic-light buttons inset over the
// content. On Windows/Linux the same option produced a borderless window
// with no native chrome AND no resize edges — so we use "hidden" there and
// let the renderer draw its own min/maximize/close controls in the existing
// 28-px titlebar slot.
const isMac = process.platform === "darwin";

mainWindow = new BrowserWindow({
	title: "Markdown Viewer",
	url: "views://mainview/index.html",
	rpc,
	titleBarStyle: isMac ? "hiddenInset" : "hidden",
	frame: { width: 1240, height: 840, x: 120, y: 80 },
});

console.log("[markdown-viewer] started");
