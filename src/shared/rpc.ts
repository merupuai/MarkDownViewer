import type { RPCSchema } from "electrobun/bun";

export type FilePayload = {
	path: string;
	content: string;
	error?: string;
};

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
			readFile: { params: { path: string }; response: FilePayload };
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
		};
	}>;
};
