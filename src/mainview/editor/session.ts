// Renderer-side session helper (Path B Layer 5).
//
// Thin wrapper around loadSession/saveSession RPCs. Owns the snapshot
// transformation from M3's runtime EditorTab[] to the persistable
// SessionTab[] shape (untitled-content blob included for path === null,
// path-only for saved tabs).
import type { SessionState, SessionTab } from "../../shared/rpc";
import type { EditorStateApi } from "./editor-state";

// Loose RPC contract — accepts anything with the loadSession/saveSession
// methods of the right shape. Avoids leaking electrobun's Electroview type
// generics into this module.
export type SessionRpc = {
	loadSession: (params: {}) => Promise<SessionState>;
	saveSession: (params: { state: SessionState }) => Promise<{ ok: boolean }>;
};

export type SessionApi = {
	load: () => Promise<SessionState>;
	save: (state: SessionState) => Promise<void>;
	snapshot: (api: EditorStateApi) => SessionState;
};

export function createSession(rpc: SessionRpc): SessionApi {
	async function load(): Promise<SessionState> {
		return rpc.loadSession({});
	}

	async function save(state: SessionState): Promise<void> {
		await rpc.saveSession({ state });
	}

	function snapshot(api: EditorStateApi): SessionState {
		const list = api.allTabs();
		const active = api.getActive();
		return {
			activeTabId: active?.id ?? null,
			tabs: list.map<SessionTab>((t) => ({
				id: t.id,
				path: t.path,
				format: t.format,
				mtimeMs: t.mtimeMs,
				// Only carry inline content for untitled tabs. Saved tabs get
				// re-read from disk on restore so we stay in sync if the file
				// changed between launches.
				untitledContent: t.path === null ? t.content : undefined,
			})),
		};
	}

	return { load, save, snapshot };
}
