import {
	BrowserView,
	BrowserWindow,
	Utils,
	ApplicationMenu,
} from "electrobun/bun";
import Electrobun from "electrobun/bun";
import { watch, readdirSync, statSync, mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, type FSWatcher } from "fs";
import { fileURLToPath } from "url";
import { basename, join, dirname, resolve, extname } from "path";
import type { AppRPC, FilePayload, FolderPayload, TreeNode, RecentEntry, SearchResults, SearchHit } from "../shared/rpc";

const APP_NAME = "MarkdownViewer";
const PLATFORM_HOME = Bun.env["HOME"] || Bun.env["USERPROFILE"] || "/";

let mainWindow: BrowserWindow | null = null;
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
function resolveImage(docPath: string, src: string): { dataUrl: string } | { error: string } {
	try {
		if (/^(https?:|data:|file:)/.test(src)) return { error: "external" };
		const docDir = dirname(docPath);
		const resolved = resolve(docDir, src);
		if (!existsSync(resolved)) return { error: `Not found: ${resolved}` };
		const buf = readFileSync(resolved);
		const ext = extname(resolved).toLowerCase().slice(1);
		const mime: Record<string, string> = {
			png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
			gif: "image/gif", svg: "image/svg+xml", webp: "image/webp",
			bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif",
		};
		const mt = mime[ext] || "application/octet-stream";
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
		},
		messages: {
			ready: () => {
				viewReady = true;
				if (pendingInitialFile && mainWindow) {
					mainWindow.webview.rpc?.send.fileOpened(pendingInitialFile);
					if (!pendingInitialFile.error) watchFile(pendingInitialFile.path);
					pendingInitialFile = null;
				}
			},
			print: () => {
				try { (mainWindow as any)?.webview?.print?.(); } catch {}
			},
			log: ({ level, msg }) => {
				try { appendFileSync("/tmp/mdv-bun.log", `[view ${level}] ${msg}\n`); } catch {}
			},
		},
	},
});

// ============== Boot ==============
function dbg(...args: unknown[]) {
	const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
	try { appendFileSync("/tmp/mdv-bun.log", line); } catch {}
	console.log(...args);
}
dbg("[mv] boot — Bun.argv =", JSON.stringify(Bun.argv), "ppid=", process.ppid);

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
]);

Electrobun.events.on("application-menu-clicked", (e) => {
	const action = e.data.action;
	if (!mainWindow || !action) return;
	mainWindow.webview.rpc?.send.menuAction({ action });
});

mainWindow = new BrowserWindow({
	title: "Markdown Viewer",
	url: "views://mainview/index.html",
	rpc,
	titleBarStyle: "hiddenInset",
	frame: { width: 1240, height: 840, x: 120, y: 80 },
});

console.log("[markdown-viewer] started");
