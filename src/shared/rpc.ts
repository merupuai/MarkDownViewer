import type { RPCSchema } from "electrobun/bun";

// L1/L2 (Path B delta): encoding awareness for read + write
export type Encoding = "utf-8" | "utf-16le" | "utf-16be" | "latin-1";
export type EOL = "lf" | "crlf";

// L3 (Path B delta): lossy-encoding diagnostic (e.g. saving emoji as Latin-1)
export type LossyInfo = {
	encoding: Encoding;
	lossyCharCount: number;
	firstIndex: number;
	sample: string;
};

export type FilePayload = {
	path: string;
	content: string;
	error?: string;
	// M3.S6: server-recorded modification time at the moment we read the file.
	// Renderer keeps this; saveFile sends it back so the bun process can detect
	// "changed on disk during edit" before clobbering.
	mtimeMs?: number;
	// L1: optional encoding metadata captured at read time. Old consumers can
	// ignore — defaults match current M3 behavior (utf-8 / lf / no-bom).
	encoding?: Encoding;
	eol?: EOL;
	bom?: boolean;
	binary?: boolean;
};

// M3 — multi-format editor types
export type EditorFormat = "markdown" | "plain-text" | "json" | "yaml" | "toml" | string;

export type SaveResponse =
	| { ok: true; savedAt: number; mtimeMs: number; bytes: number; lossyChars?: number }
	| { ok: false; error: "conflict"; diskMtimeMs: number; expectedMtimeMs: number }
	| { ok: false; error: "io-failure"; message: string }
	| { ok: false; error: "unsafe-path"; message: string }
	| { ok: false; error: "too-large"; bytes: number }
	// L3: NEW — content has chars unrepresentable in target encoding
	| { ok: false; error: "lossy"; lossy: LossyInfo };

// L4 (Path B delta): Save As response — distinct from SaveResponse because
// it carries the chosen path on success and uses "user-cancelled" for picker
// dismissal.
export type SaveAsResponse =
	| { ok: true; path: string; savedAt: number; mtimeMs: number; bytes: number; lossyChars?: number }
	| { ok: false; error: "user-cancelled" }
	| { ok: false; error: "lossy"; lossy: LossyInfo }
	| { ok: false; error: "io-failure"; message: string };

// L5 (Path B delta): cross-launch session restore
export type SessionTab = {
	id: string;
	path: string | null;
	format: EditorFormat;
	mtimeMs?: number;
	// untitled-tab content persisted in-memory at quit; capped at 1 MB by
	// session-store on save.
	untitledContent?: string;
};

export type SessionState = {
	tabs: SessionTab[];
	activeTabId: string | null;
};

export type FormatDetectResult = { format: EditorFormat; confidence: number };

export type TreeNode =
	| { type: "dir"; name: string; path: string; children: TreeNode[] }
	| { type: "file"; name: string; path: string };

export type FolderPayload = {
	root: string;
	tree: TreeNode[];
	truncated: boolean;
	count: number;
};

export type RecentEntry = { path: string; name: string; openedAt: number };

export type SearchHit = {
	path: string;
	name: string;
	matches: { line: number; preview: string; column: number; length: number }[];
};

export type SearchResults = {
	query: string;
	hits: SearchHit[];
	truncated: boolean;
	scanned: number;
	matched: number;
};

export type ImageResolveResult = { dataUrl: string } | { error: string };

export type AppRPC = {
	bun: RPCSchema<{
		requests: {
			openDialog: { params: {}; response: FilePayload | null };
			openFolderDialog: { params: {}; response: FolderPayload | null };
			// M3.S1: optional intent — "edit" tells bun to capture mtimeMs and
			// (in future) prepare write locks. "view" is the existing behavior.
			readFile: { params: { path: string; intent?: "view" | "edit" }; response: FilePayload };
			// M3.S1/S2 + Path-B L2/L3: atomic save with encoding awareness.
			// expectedMtimeMs is the mtime renderer captured at read time; bun
			// rejects with {error:"conflict"} if disk mtime has advanced.
			// encoding/eol/bom optional — defaults preserve M3 utf-8/lf/no-bom.
			// allowLossy opts in to a save that loses chars in target encoding;
			// without it, latin-1 saves with non-latin-1 chars return {error:"lossy"}.
			saveFile: {
				params: {
					path: string;
					content: string;
					expectedMtimeMs?: number;
					encoding?: Encoding;
					eol?: EOL;
					bom?: boolean;
					allowLossy?: boolean;
				};
				response: SaveResponse;
			};
			// L4: Save As for untitled buffers (closes M3.S2 deferred TODO).
			// Opens a folder picker, sanitizes the filename, then funnels through
			// the same saveFile code path. Lossy refusal works identically.
			saveAsDialog: {
				params: {
					defaultName: string;
					content: string;
					encoding?: Encoding;
					eol?: EOL;
					bom?: boolean;
					allowLossy?: boolean;
				};
				response: SaveAsResponse;
			};
			// L5: cross-launch session restore. loadSession is called once at
			// boot; saveSession is debounced 300ms on tab/state changes and
			// fires synchronously on beforeunload.
			loadSession: { params: {}; response: SessionState };
			saveSession: { params: { state: SessionState }; response: { ok: boolean } };
			// M3.S7: format detection from extension + content sniff.
			detectFormat: { params: { path: string }; response: FormatDetectResult };
			// M4.S6: opt-in crash report — copies the bun debug log + system info
			// to a user-chosen path. NO automatic upload; pure local copy.
			saveCrashReport: { params: {}; response: { ok: boolean; path?: string; error?: string } };
			// M4.S7: read the user's optional mermaid theme override JSON
			// from <userDataDir>/mermaid-theme.json. Returns null if the file
			// is absent or invalid; logs the parse error in either case.
			getMermaidThemeOverride: { params: {}; response: { override: Record<string, unknown> | null; error?: string } };
			// M4.S10: read references.bib adjacent to the document (or in
			// the open folder root). Returns the file content as a string;
			// renderer parses it client-side via the bibtex plugin.
			readBibFile: { params: { docPath: string }; response: { content: string | null; path?: string } };
			resolveImage: { params: { docPath: string; src: string }; response: ImageResolveResult };
			getInitialFile: { params: {}; response: FilePayload | null };
			openExternal: { params: { url: string }; response: { ok: boolean } };
			revealInFinder: { params: { path: string }; response: { ok: boolean } };
			getRecent: { params: {}; response: RecentEntry[] };
			clearRecent: { params: {}; response: { ok: boolean } };
			searchFolder: { params: { root: string; query: string; caseSensitive?: boolean; wholeWord?: boolean }; response: SearchResults };
			exportHtml: { params: { html: string; title: string; defaultName: string }; response: { ok: boolean; path?: string } };
			windowMinimize: { params: {}; response: { ok: boolean } };
			windowMaximizeToggle: { params: {}; response: { ok: boolean; maximized: boolean } };
			windowClose: { params: {}; response: { ok: boolean } };
			getPlatform: { params: {}; response: { platform: "darwin" | "win32" | "linux"; isMac: boolean } };
		};
		messages: {
			ready: {};
			print: {};
			log: { level: "info" | "warn" | "error"; msg: string };
		};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {
			fileOpened: FilePayload;
			fileChanged: FilePayload;
			folderOpened: FolderPayload;
			folderUpdated: FolderPayload;
			menuAction: { action: string };
			windowStateChanged: { maximized: boolean };
			// M3: editor-mode pushes (bun → renderer)
			fileChangedExternal: { path: string; mtimeMs: number };
		};
	}>;
};
