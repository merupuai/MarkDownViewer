// Session-store (Path B Layer 5 — closes ENH-003).
//
// Persists the editor's open tabs across launches. On boot, the renderer
// calls loadSession(); on tab/state changes (debounced 300ms) and on
// beforeunload, it calls saveSession().
//
// Untitled-tab content is persisted INLINE in the session blob (capped at
// 1 MB per tab on save). Saved tabs persist only the path — the content
// is re-read from disk on restore so it stays in sync if the file changed
// between launches.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { SessionState } from "../shared/rpc";

const FILE_NAME = "session.json";
const UNTITLED_CAP = 1024 * 1024; // 1 MB hard cap on per-tab untitled blob

export type SessionStore = {
	load: () => SessionState;
	save: (state: SessionState) => void;
};

export function createSessionStore(dir: string): SessionStore {
	try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
	const path = join(dir, FILE_NAME);

	function load(): SessionState {
		if (!existsSync(path)) return { tabs: [], activeTabId: null };
		try {
			const raw = readFileSync(path, "utf8");
			const parsed = JSON.parse(raw);
			// Defensive — corrupted JSON shouldn't crash the app, just lose the
			// session.
			if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tabs)) {
				return { tabs: [], activeTabId: null };
			}
			return parsed as SessionState;
		} catch {
			return { tabs: [], activeTabId: null };
		}
	}

	function save(state: SessionState): void {
		const tabs = state.tabs.map((t) => {
			// Cap untitled-tab content. Saved tabs never carry untitledContent
			// so the cap is essentially unreachable for them.
			if (t.path === null && t.untitledContent && t.untitledContent.length > UNTITLED_CAP) {
				return { ...t, untitledContent: t.untitledContent.slice(0, UNTITLED_CAP) };
			}
			return t;
		});
		try {
			writeFileSync(path, JSON.stringify({ tabs, activeTabId: state.activeTabId }, null, 2), "utf8");
		} catch {
			// Best-effort — losing a session save is annoying but never fatal.
		}
	}

	return { load, save };
}
