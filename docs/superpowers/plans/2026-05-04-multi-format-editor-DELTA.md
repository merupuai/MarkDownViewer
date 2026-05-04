# Multi-format Editor — Path B Delta Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Layer encoding awareness, F2 lossy refusal, Save As, and session restore on top of M3's already-shipped editor (`src/mainview/editor/`, `src/bun/index.ts:saveDocumentFile`).

**Architecture:** M3 base is canonical. `text-io.ts` (already at `src/bun/text-io.ts` per commits `87d4f3e` + `ed0186e`) becomes the encoding library both `readMarkdownFile` and `saveDocumentFile` delegate to. RPC types extend additively. Renderer's `editor-app.ts` gains a lossy-confirm flow.

**Tech Stack:** Bun + Electrobun, `<textarea>` editor (M3 choice — no CodeMirror), `bun:test` for unit tests under `tests/unit/`.

**Reference:**
- Delta spec: [`docs/superpowers/specs/2026-05-04-multi-format-editor-DELTA.md`](../specs/2026-05-04-multi-format-editor-DELTA.md)
- Original spec (background): [`docs/superpowers/specs/2026-05-04-multi-format-editor-design.md`](../specs/2026-05-04-multi-format-editor-design.md)
- Conflict report: [`docs/superpowers/review-reports/2026-05-04-editor-design-conflict.md`](../review-reports/2026-05-04-editor-design-conflict.md)

---

## File Structure

### New files
```
src/bun/session-store.ts            Persist/load ~/.MarkdownViewer/session.json
src/mainview/editor/session.ts      Renderer-side session save/restore wrapper
tests/unit/session-store.test.ts    Session persist/load unit tests
tests/unit/bundle-size.test.ts      F5 bundle-size guard (textarea baseline)
```

### Modified files
```
src/bun/index.ts                    readMarkdownFile delegates to text-io.readText;
                                    saveDocumentFile delegates to text-io.writeText;
                                    new saveAsDialog RPC handler;
                                    new loadSession/saveSession RPC handlers
src/shared/rpc.ts                   FilePayload + saveFile + SaveResponse extended
                                    (additive); new saveAsDialog + Session types
src/mainview/editor/editor-app.ts   saveActiveImpl handles error:"lossy" + retry;
                                    Save As wired (replaces M3.S2 deferred TODO)
src/mainview/editor/editor-state.ts (no changes needed — it's canonical)
src/mainview/editor/tabs.ts         (no changes — canonical)
src/mainview/index.ts               Wire createSession + boot-time restore loop
                                    (with F3 setActive-after-loop fix)
package.json                        Remove CodeMirror deps (revert b72a2c9 effect);
                                    keep bundle-size script if added
bun.lock                            Cascades from package.json
README.md                           Document encoding-aware open/save + Save As
```

### Untouched (deliberately)
```
src/mainview/editor/editor-pane.ts  M3 textarea — canonical
src/mainview/editor/format-adapters.ts  M3 — canonical
src/bun/text-io.ts                  Already shipped, no changes needed
tests/unit/text-io.test.ts          Already passes 14 tests
```

---

## Phase 0 — Roll back the misaligned CodeMirror commit

### Task 1: Remove CodeMirror dependencies

**Files:**
- Modify: `package.json`, `bun.lock`

- [ ] **Step 1: Remove the 18 CM packages**

  ```bash
  bun remove @codemirror/autocomplete @codemirror/commands @codemirror/lang-css \
             @codemirror/lang-html @codemirror/lang-javascript @codemirror/lang-json \
             @codemirror/lang-markdown @codemirror/lang-python @codemirror/lang-sql \
             @codemirror/lang-xml @codemirror/lang-yaml @codemirror/language \
             @codemirror/legacy-modes @codemirror/lint @codemirror/search \
             @codemirror/state @codemirror/view codemirror
  ```

  Expected: `bun remove` reports 18 packages removed, `bun install` re-resolves the lock.

- [ ] **Step 2: Verify nothing imports CodeMirror**

  ```bash
  bun -e 'import("@codemirror/state").then(() => console.log("FAIL: still installed"), () => console.log("OK: gone"))'
  ```

  Expected: prints `OK: gone`. If it prints `FAIL`, manually inspect `package.json`/`bun.lock` and re-run.

- [ ] **Step 3: Run baseline tests + typecheck**

  ```bash
  bun test tests/unit/
  bunx tsc --noEmit
  ```

  Expected: 51 tests pass (37 baseline + 14 text-io); 0 type errors. (text-io.ts only imports from `fs` and Bun built-ins — no CM deps.)

- [ ] **Step 4: Commit**

  ```bash
  git add package.json bun.lock
  git commit -m "deps: remove CodeMirror — M3 chose textarea editor (Path B)

  M3's editor-pane.ts uses <textarea>, not CodeMirror. The CM deps added
  in b72a2c9 are dead weight against the canonical M3 design. Reverting
  per docs/superpowers/specs/2026-05-04-multi-format-editor-DELTA.md.

  text-io.ts is unaffected — it only depends on fs + Bun built-ins."
  ```

---

## Phase 1 — RPC schema extension (additive)

### Task 2: Extend rpc.ts with encoding/EOL/BOM/lossy types

**Files:**
- Modify: `src/shared/rpc.ts`

- [ ] **Step 1: Add Encoding/EOL/LossyInfo types and extend FilePayload + SaveResponse**

  Replace `FilePayload` and `SaveResponse` definitions in `src/shared/rpc.ts` with:

  ```ts
  // L1/L2: encoding awareness for read + write
  export type Encoding = "utf-8" | "utf-16le" | "utf-16be" | "latin-1";
  export type EOL = "lf" | "crlf";

  // L3: lossy-encoding diagnostic (e.g. saving emoji as Latin-1)
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
      mtimeMs?: number;
      // L1: optional encoding metadata captured at read time
      encoding?: Encoding;
      eol?: EOL;
      bom?: boolean;
      binary?: boolean;
  };

  export type SaveResponse =
      | { ok: true; savedAt: number; mtimeMs: number; bytes: number; lossyChars?: number }
      | { ok: false; error: "conflict"; diskMtimeMs: number; expectedMtimeMs: number }
      | { ok: false; error: "io-failure"; message: string }
      | { ok: false; error: "unsafe-path"; message: string }
      | { ok: false; error: "too-large"; bytes: number }
      // L3: NEW — content has chars unrepresentable in target encoding
      | { ok: false; error: "lossy"; lossy: LossyInfo };
  ```

- [ ] **Step 2: Extend saveFile params + add saveAsDialog + session RPCs**

  In the `requests` block of `bun: RPCSchema<{...}>`, replace the existing `saveFile` line and append new lines:

  ```ts
  saveFile: {
      params: {
          path: string;
          content: string;
          expectedMtimeMs?: number;
          // L2/L3: encoding metadata + lossy opt-in (all optional — defaults
          // preserve current M3 utf-8 / lf / no-bom behavior)
          encoding?: Encoding;
          eol?: EOL;
          bom?: boolean;
          allowLossy?: boolean;
      };
      response: SaveResponse;
  };

  // L4: Save As for untitled buffers (closes M3.S2 deferred TODO at editor-app.ts:113)
  saveAsDialog: {
      params: {
          defaultName: string;
          content: string;
          encoding?: Encoding;
          eol?: EOL;
          bom?: boolean;
          allowLossy?: boolean;
      };
      response:
          | { ok: true; path: string; savedAt: number; mtimeMs: number; bytes: number; lossyChars?: number }
          | { ok: false; error: "user-cancelled" }
          | { ok: false; error: "lossy"; lossy: LossyInfo }
          | { ok: false; error: "io-failure"; message: string };
  };

  // L5: session restore across launches
  loadSession: { params: {}; response: SessionState };
  saveSession: { params: { state: SessionState }; response: { ok: boolean } };
  ```

- [ ] **Step 3: Add SessionState + SessionTab types**

  Append above the `AppRPC` type:

  ```ts
  export type SessionTab = {
      id: string;
      path: string | null;
      format: EditorFormat;
      mtimeMs?: number;
      // L5: untitled-tab content persisted in-memory at quit; capped at 1 MB
      // by session-store on save.
      untitledContent?: string;
  };

  export type SessionState = {
      tabs: SessionTab[];
      activeTabId: string | null;
  };
  ```

- [ ] **Step 4: Type-check**

  ```bash
  bunx tsc --noEmit
  ```

  Expected: errors only in `src/bun/index.ts` referencing the new RPCs (Tasks 3-5 will satisfy them). No errors in `src/shared/rpc.ts`.

- [ ] **Step 5: Commit**

  ```bash
  git add src/shared/rpc.ts
  git commit -m "feat(rpc): extend schema with encoding, lossy, save-as, session (Path B L1-L5)"
  ```

---

## Phase 2 — Bun-side wiring

### Task 3: `readMarkdownFile` delegates to `text-io.readText`

**Files:**
- Modify: `src/bun/index.ts`

- [ ] **Step 1: Add the import**

  At the top of `src/bun/index.ts` near the other local imports:

  ```ts
  import { readText, writeText, type Encoding, type EOL, type LossyInfo } from "./text-io";
  ```

- [ ] **Step 2: Replace `readMarkdownFile` body**

  Find the existing `async function readMarkdownFile(path: string)` (around line 192) and replace its body:

  ```ts
  async function readMarkdownFile(path: string): Promise<FilePayload> {
      try {
          const file = Bun.file(path);
          if (!(await file.exists())) {
              return { path, content: "", error: `File not found: ${path}` };
          }
          // M3.S6: capture mtime first (before any decode work) so retry/conflict
          // logic stays consistent.
          let mtimeMs: number | undefined;
          try { mtimeMs = statSync(path).mtimeMs; } catch {}
          // L1: encoding-aware read via text-io.
          const r = await readText(path);
          if (r.binary) {
              return { path, content: "", error: "Binary file refused", binary: true, mtimeMs };
          }
          return {
              path,
              content: r.content,
              encoding: r.encoding,
              eol: r.eol,
              bom: r.bom,
              mtimeMs,
          };
      } catch (err) {
          return { path, content: "", error: err instanceof Error ? err.message : String(err) };
      }
  }
  ```

- [ ] **Step 3: Verify existing tests still pass**

  ```bash
  bun test tests/unit/
  ```

  Expected: 51 pass (the existing markdown-pipeline tests don't introspect encoding fields, so additive changes don't regress them).

- [ ] **Step 4: Commit**

  ```bash
  git add src/bun/index.ts
  git commit -m "feat(bun): readMarkdownFile delegates to text-io.readText (L1)

  Files now opened with encoding/EOL/BOM detection. UTF-16 LE/BE and
  Latin-1 files no longer mojibake. UTF-8 path unchanged."
  ```

---

### Task 4: `saveDocumentFile` delegates to `text-io.writeText` + lossy plumbing

**Files:**
- Modify: `src/bun/index.ts`

- [ ] **Step 1: Replace `saveDocumentFile` signature + body**

  Find `async function saveDocumentFile(path: string, content: string, expectedMtimeMs?: number)` (around line 225) and replace with:

  ```ts
  async function saveDocumentFile(
      path: string,
      content: string,
      expectedMtimeMs?: number,
      meta?: { encoding?: Encoding; eol?: EOL; bom?: boolean; allowLossy?: boolean },
  ) {
      // Path validation (unchanged)
      if (!path || typeof path !== "string" || path.length > 4096 || path.includes("\0")) {
          return { ok: false, error: "unsafe-path", message: "path empty / too long / contains NUL" } as const;
      }

      // L2/L3: encoding-aware byte production via text-io
      const encoding: Encoding = meta?.encoding || "utf-8";
      const eol: EOL = meta?.eol || "lf";
      const bom = meta?.bom || false;
      const allowLossy = meta?.allowLossy || false;

      // Conflict detection (unchanged — runs BEFORE any byte production so we
      // don't burn cycles encoding for a stale write)
      if (expectedMtimeMs !== undefined && existsSync(path)) {
          try {
              const diskMtimeMs = statSync(path).mtimeMs;
              if (Math.abs(diskMtimeMs - expectedMtimeMs) > 1) {
                  return { ok: false, error: "conflict", diskMtimeMs, expectedMtimeMs } as const;
              }
          } catch (err) {
              return { ok: false, error: "io-failure", message: `stat failed: ${String(err)}` } as const;
          }
      }

      // L3: pre-flight lossy check via text-io.writeText against a temp path
      // (writeText returns ok:false with diagnostic when content has chars
      // unrepresentable in target encoding and allowLossy=false).
      const dir = dirname(path);
      const base = basename(path);
      const tmpPath = join(dir, `.${base}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);

      const writeRes = await writeText(tmpPath, content, { encoding, eol, bom }, { allowLossy });
      if (writeRes.ok === false) {
          // L3: surface the lossy refusal back to the renderer
          return { ok: false, error: "lossy", lossy: writeRes.lossy } as const;
      }

      // Size cap (computed post-write since byte length depends on encoding)
      let bytes: number;
      try {
          bytes = statSync(tmpPath).size;
          if (bytes > MAX_SAVE_BYTES) {
              try { (require("fs") as typeof import("fs")).unlinkSync(tmpPath); } catch {}
              return { ok: false, error: "too-large", bytes } as const;
          }
      } catch (err) {
          return { ok: false, error: "io-failure", message: `stat tmp failed: ${String(err)}` } as const;
      }

      // chmod (unchanged)
      if (process.platform !== "win32") {
          try { chmodSync(tmpPath, 0o644); } catch {}
      }

      // Atomic rename with Windows retry (unchanged)
      let renamed = false;
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 3 && !renamed; attempt++) {
          try {
              const fs = require("fs") as typeof import("fs");
              fs.renameSync(tmpPath, path);
              renamed = true;
          } catch (err) {
              lastErr = err;
              const until = Date.now() + 50 * (attempt + 1);
              while (Date.now() < until) { /* spin briefly */ }
          }
      }
      if (!renamed) {
          try { (require("fs") as typeof import("fs")).unlinkSync(tmpPath); } catch {}
          return {
              ok: false,
              error: "io-failure",
              message: `rename failed after retry: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
          } as const;
      }

      const finalMtime = statSync(path).mtimeMs;
      return {
          ok: true,
          savedAt: Date.now(),
          mtimeMs: finalMtime,
          bytes,
          ...(writeRes.ok && writeRes.lossyChars ? { lossyChars: writeRes.lossyChars } : {}),
      } as const;
  }
  ```

- [ ] **Step 2: Update the `saveFile` RPC handler to forward meta**

  Find the `saveFile` RPC handler (around line 660) and update the call:

  ```ts
  saveFile: async (params) => {
      return saveDocumentFile(params.path, params.content, params.expectedMtimeMs, {
          encoding: params.encoding,
          eol: params.eol,
          bom: params.bom,
          allowLossy: params.allowLossy,
      });
  },
  ```

- [ ] **Step 3: Type-check + tests**

  ```bash
  bunx tsc --noEmit
  bun test tests/unit/
  ```

  Expected: 0 type errors, 51 tests pass.

- [ ] **Step 4: Commit**

  ```bash
  git add src/bun/index.ts
  git commit -m "feat(bun): saveFile encoding-aware + F2 lossy refusal (L2/L3)

  saveDocumentFile now takes optional encoding/eol/bom/allowLossy meta and
  delegates the byte-production step to text-io.writeText. Latin-1 saves
  with non-Latin-1 chars return error:'lossy' with diagnostic info; renderer
  retries with allowLossy=true after user confirms. UTF-8 default path
  unchanged."
  ```

---

### Task 5: Add `saveAsDialog` RPC handler

**Files:**
- Modify: `src/bun/index.ts`

- [ ] **Step 1: Implement the handler**

  In the `requests` block, after `saveFile`:

  ```ts
  saveAsDialog: async (params) => {
      const folder = await Utils.openFileDialog({
          startingFolder: PLATFORM_HOME,
          canChooseFiles: false,
          canChooseDirectory: true,
          allowsMultipleSelection: false,
      });
      const dir = folder?.[0];
      if (!dir) return { ok: false, error: "user-cancelled" } as const;

      // Sanitize the filename — no path separators, no NUL, length cap
      const safeName = (params.defaultName || "untitled.txt")
          .replace(/[/\\\0]/g, "_")
          .slice(0, 255);
      const target = join(dir, safeName);

      const result = await saveDocumentFile(target, params.content, undefined, {
          encoding: params.encoding,
          eol: params.eol,
          bom: params.bom,
          allowLossy: params.allowLossy,
      });
      if (result.ok === false) {
          if (result.error === "lossy") {
              return { ok: false, error: "lossy", lossy: result.lossy } as const;
          }
          if (result.error === "io-failure") {
              return { ok: false, error: "io-failure", message: result.message } as const;
          }
          // unsafe-path / too-large / conflict shouldn't occur on a fresh save-as
          return { ok: false, error: "io-failure", message: `save-as failed: ${result.error}` } as const;
      }
      return {
          ok: true,
          path: target,
          savedAt: result.savedAt,
          mtimeMs: result.mtimeMs,
          bytes: result.bytes,
          ...(result.lossyChars ? { lossyChars: result.lossyChars } : {}),
      } as const;
  },
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add src/bun/index.ts
  git commit -m "feat(bun): saveAsDialog RPC for untitled docs (L4 — closes M3.S2 defer)"
  ```

---

## Phase 3 — Renderer-side lossy + Save As

### Task 6: `editor-app.ts` handles error:"lossy" + Save As

**Files:**
- Modify: `src/mainview/editor/editor-app.ts`

- [ ] **Step 1: Update RpcSaveResponse type to include the lossy variant**

  Find the local `type RpcSaveResponse = …` (around line 25) and replace:

  ```ts
  type LossyInfo = { encoding: string; lossyCharCount: number; firstIndex: number; sample: string };

  type RpcSaveResponse =
      | { ok: true; savedAt: number; mtimeMs: number; bytes: number; lossyChars?: number }
      | { ok: false; error: "conflict"; diskMtimeMs: number; expectedMtimeMs: number }
      | { ok: false; error: "io-failure"; message: string }
      | { ok: false; error: "unsafe-path"; message: string }
      | { ok: false; error: "too-large"; bytes: number }
      | { ok: false; error: "lossy"; lossy: LossyInfo };
  ```

- [ ] **Step 2: Add `confirmLossy` to deps and the lossy-handling branch in saveActiveImpl**

  Add to `EditorAppDeps`:

  ```ts
  confirmLossy: (lossy: LossyInfo) => Promise<boolean>;
  ```

  And in `saveActiveImpl`, after the existing `result.error === "conflict"` block:

  ```ts
  if (result.error === "lossy") {
      const proceed = await confirmLossy(result.lossy);
      if (!proceed) {
          notify(`Save cancelled — would have lost ${result.lossy.lossyCharCount} character(s)`, "warn");
          return false;
      }
      const retry = await rpc.saveFile({
          path: tab.path!,
          content: tab.content,
          expectedMtimeMs: tab.mtimeMs,
          allowLossy: true,
      });
      if (retry.ok) {
          state.markSaved(tab.id, retry.mtimeMs);
          notify(retry.lossyChars ? `Saved (${retry.lossyChars} char(s) lost)` : "Saved", "info");
          return true;
      }
      notify(`Save retry failed: ${retry.error}`, "error");
      return false;
  }
  ```

- [ ] **Step 3: Wire Save As for untitled tabs**

  Add to `EditorAppDeps`:

  ```ts
  rpc: {
      // ...existing fields...
      saveAsDialog: (params: {
          defaultName: string;
          content: string;
          allowLossy?: boolean;
      }) => Promise<
          | { ok: true; path: string; mtimeMs: number; lossyChars?: number }
          | { ok: false; error: "user-cancelled" }
          | { ok: false; error: "lossy"; lossy: LossyInfo }
          | { ok: false; error: "io-failure"; message: string }
      >;
  };
  ```

  Replace the M3.S2-deferred branch in `saveActiveImpl`:

  ```ts
  if (!tab.path) {
      // L4: Save As for untitled tabs
      const defaultName = `untitled-${tab.format === "markdown" ? "md" : "txt"}`;
      let allowLossy = false;
      for (let attempt = 0; attempt < 2; attempt++) {
          const result = await rpc.saveAsDialog({
              defaultName,
              content: tab.content,
              allowLossy,
          });
          if (result.ok) {
              state.setPathAndMtime(tab.id, result.path, result.mtimeMs);
              state.markSaved(tab.id, result.mtimeMs);
              notify(result.lossyChars ? `Saved as ${result.path} (${result.lossyChars} char(s) lost)` : `Saved as ${result.path}`, "info");
              return true;
          }
          if (result.error === "user-cancelled") return false;
          if (result.error === "lossy") {
              const proceed = await confirmLossy(result.lossy);
              if (!proceed) return false;
              allowLossy = true;
              continue;
          }
          notify(`Save As failed: ${result.error}`, "error");
          return false;
      }
      return false;
  }
  ```

- [ ] **Step 4: Add `setPathAndMtime` to editor-state**

  In `src/mainview/editor/editor-state.ts`, add to the `EditorStateApi`:

  ```ts
  setPathAndMtime: (tabId: string, path: string, mtimeMs: number) => void;
  ```

  And implement in the `createEditorState` return:

  ```ts
  setPathAndMtime(tabId, path, mtimeMs) {
      const tab = findTab(tabId);
      if (!tab) return;
      tab.path = path;
      tab.mtimeMs = mtimeMs;
      tab.lastSavedAt = Date.now();
      emit({ type: "tab-changed", tabId });
  },
  ```

- [ ] **Step 5: Type-check + tests**

  ```bash
  bunx tsc --noEmit
  bun test tests/unit/
  ```

  Expected: 0 errors, 51 tests pass.

- [ ] **Step 6: Commit**

  ```bash
  git add src/mainview/editor/editor-app.ts src/mainview/editor/editor-state.ts
  git commit -m "feat(editor): F2 lossy confirm flow + Save As for untitled (L3/L4)"
  ```

---

## Phase 4 — Session restore (with F3 fix)

### Task 7: session-store + RPC + boot restore

**Files:**
- Create: `src/bun/session-store.ts`
- Create: `src/mainview/editor/session.ts`
- Create: `tests/unit/session-store.test.ts`
- Modify: `src/bun/index.ts`
- Modify: `src/mainview/index.ts`

- [ ] **Step 1: Create `src/bun/session-store.ts`** (per the patched plan, no changes needed):

  ```ts
  import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
  import { join } from "path";
  import type { SessionState } from "../shared/rpc";

  const FILE_NAME = "session.json";
  const UNTITLED_CAP = 1024 * 1024; // 1 MB

  export function createSessionStore(dir: string) {
      try { mkdirSync(dir, { recursive: true }); } catch {}
      const path = join(dir, FILE_NAME);

      function load(): SessionState {
          if (!existsSync(path)) return { tabs: [], activeTabId: null };
          try {
              const raw = readFileSync(path, "utf8");
              const parsed = JSON.parse(raw);
              if (!parsed || !Array.isArray(parsed.tabs)) return { tabs: [], activeTabId: null };
              return parsed as SessionState;
          } catch { return { tabs: [], activeTabId: null }; }
      }

      function save(state: SessionState) {
          const tabs = state.tabs.map((t) => {
              if (t.path === null && t.untitledContent && t.untitledContent.length > UNTITLED_CAP) {
                  return { ...t, untitledContent: t.untitledContent.slice(0, UNTITLED_CAP) };
              }
              return t;
          });
          try {
              writeFileSync(path, JSON.stringify({ tabs, activeTabId: state.activeTabId }, null, 2), "utf8");
          } catch {}
      }

      return { load, save };
  }
  ```

- [ ] **Step 2: Create `tests/unit/session-store.test.ts`** with 3 tests (round-trip, missing-file, untitled-cap) — see the patched plan Task 17. Import path is `../../src/bun/session-store`.

- [ ] **Step 3: Run — expect 3 fail then 3 pass after step 1 lands.**

  ```bash
  bun test tests/unit/session-store.test.ts
  ```

  Expected: 3 pass.

- [ ] **Step 4: Wire RPC handlers in `src/bun/index.ts`**

  ```ts
  import { createSessionStore } from "./session-store";

  // In boot block, near recent-files setup:
  const sessionStore = createSessionStore(join(PLATFORM_HOME, `.${APP_NAME}`));

  // In the requests block:
  loadSession: async () => sessionStore.load(),
  saveSession: async ({ state }) => { sessionStore.save(state); return { ok: true }; },
  ```

- [ ] **Step 5: Create `src/mainview/editor/session.ts`** — renderer wrapper.

  ```ts
  import type { Electroview } from "electrobun/view";
  import type { AppRPC, SessionState, SessionTab } from "../../shared/rpc";
  import type { EditorStateApi } from "./editor-state";

  export function createSession(electroview: Electroview<AppRPC>) {
      async function load(): Promise<SessionState> {
          return electroview.rpc!.request.loadSession({});
      }
      async function save(state: SessionState): Promise<void> {
          await electroview.rpc!.request.saveSession({ state });
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
                  untitledContent: t.path === null ? t.content : undefined,
              })),
          };
      }
      return { load, save, snapshot };
  }
  ```

- [ ] **Step 6: Wire into `src/mainview/index.ts` boot block** (with F3 fix):

  ```ts
  import { createSession } from "./editor/session";

  // In the existing boot IIFE — after editor-app is created and mounted:
  const session = createSession(electroview as any);
  const sessionState = await session.load();

  // Honor double-click open first; capture initialTabId for F3 fix
  const initial = await electroview.rpc!.request.getInitialFile({});
  let initialTabId: string | null = null;
  if (initial && !initial.error) {
      const tab = await editorApp.openFile(initial.path);
      initialTabId = tab?.id ?? null;
  }

  // Restore tabs that still resolve on disk; skip the double-clicked path
  // (already opened). Untitled tabs always restore from in-memory blob.
  for (const t of sessionState.tabs) {
      if (initial && t.path && t.path === initial.path) continue;
      if (t.path === null && t.untitledContent !== undefined) {
          editorApp.state.open(null, t.untitledContent, t.format);
          continue;
      }
      if (t.path) {
          await editorApp.openFile(t.path);
      }
  }

  // F3 fix: re-assert active AFTER the loop. M3's editor-state.open also
  // sets active on every call, so without this the active tab ends up
  // being the last-restored, not the user's intent.
  if (initialTabId) {
      editorApp.state.activate(initialTabId);
  } else if (sessionState.activeTabId) {
      const list = editorApp.state.allTabs();
      const sess = sessionState.tabs.find((s) => s.id === sessionState.activeTabId);
      const match = sess ? list.find((tt) => tt.path === sess.path) : null;
      if (match) editorApp.state.activate(match.id);
  }

  // Persist on every state change (debounced 300ms)
  let saveDebounce: ReturnType<typeof setTimeout> | null = null;
  editorApp.state.subscribe(() => {
      if (saveDebounce) clearTimeout(saveDebounce);
      saveDebounce = setTimeout(() => session.save(session.snapshot(editorApp.state)), 300);
  });
  window.addEventListener("beforeunload", () => session.save(session.snapshot(editorApp.state)));
  ```

- [ ] **Step 7: Tests**

  ```bash
  bun test tests/unit/
  ```

  Expected: 54 pass (51 + 3 session-store).

- [ ] **Step 8: Commit**

  ```bash
  git add src/bun/session-store.ts src/bun/index.ts src/mainview/editor/session.ts src/mainview/index.ts tests/unit/session-store.test.ts
  git commit -m "feat(session): persist+restore tabs across launches with F3 active fix (L5)"
  ```

---

## Phase 5 — Bundle-size guard (F5, recalibrated for textarea)

### Task 8: F5 bundle-size guard

**Files:**
- Create: `tests/unit/bundle-size.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Establish baseline**

  ```bash
  bun run build:release
  ```

  Then measure renderer bundle (path varies by platform). Record the size as `POST_DELTA_BUNDLE_SIZE`. Ceiling = `POST_DELTA_BUNDLE_SIZE × 1.15`.

  *Note: the textarea-based ceiling will be MUCH lower than CodeMirror — likely < 500 KB instead of ~1 MB+.*

- [ ] **Step 2: Create the test** (same shape as the patched plan's Task 19a but in `tests/unit/bundle-size.test.ts` and with the recalibrated CEILING).

- [ ] **Step 3: Add `test:bundle` script to package.json**

  ```json
  "test:bundle": "bun run build:release && bun test tests/unit/bundle-size.test.ts"
  ```

- [ ] **Step 4: Verify**

  ```bash
  bun run test:bundle
  ```

  Expected: 1 pass.

- [ ] **Step 5: Commit**

  ```bash
  git add tests/unit/bundle-size.test.ts package.json
  git commit -m "feat(ci): bundle-size guard recalibrated for textarea baseline (F5)"
  ```

---

## Phase 6 — Wrap

### Task 9: README + final smoke

**Files:**
- Modify: `README.md`
- (Optional) Create: `docs/superpowers/test-checklists/editor-smoke.md`

- [ ] **Step 1: Add to README's feature list**

  ```markdown
  - 🔤 **Encoding-aware open + save** — UTF-8, UTF-16 LE/BE, Latin-1 round-trip
  - 💾 **Save As** — for untitled documents
  - 📑 **Session restore** — tabs reopen on next launch
  ```

- [ ] **Step 2: Walk a manual smoke list**

  - Open a UTF-8 markdown file, edit, save → file unchanged in encoding
  - Open a UTF-16 LE file → reads cleanly (no mojibake), saves back as UTF-16 LE
  - Open a UTF-8 file with content, paste an emoji, change format chip to Latin-1, save → confirm modal appears, picking Cancel preserves content; picking Save Anyway truncates
  - New untitled tab, type content, ⌘S → Save As dialog opens, saves to chosen path
  - Open 3 files, edit one (don't save), quit, relaunch → 3 tabs reappear, edited one is back to disk content (saved tabs only restore from disk)
  - Untitled tab with content survives quit + relaunch

- [ ] **Step 3: Final commit**

  ```bash
  git add README.md
  git commit -m "docs(readme): document encoding-aware editor + Save As + session restore"
  ```

---

## Spec coverage check

| Delta spec section | Plan task |
|---|---|
| §1.1/§1.2/§1.3 (M3 canonical inventory) | n/a (preserved, not modified) |
| §1.4 + §2 L1 (encoding read) | Task 3 |
| §2 L2 (encoding write) + L3 (lossy) schema | Task 2 (types), Task 4 (Bun impl), Task 6 (renderer) |
| §2 L4 (Save As) | Task 5 (Bun), Task 6 (renderer) |
| §2 L5 (session restore) + F3 fix | Task 7 |
| §2 L6 (watcher self-write echo) | Deferred — no task |
| §3 (what we're NOT doing — CM6 etc.) | Task 1 (rollback) |
| §6 F1–F5 traceability | Task 3 (F1 already in text-io), Task 4/6 (F2), Task 7 (F3), Task 8 (F5) |

---

## Plan self-review

- **Placeholder scan:** No "TBD"/"TODO" outside of out-of-scope notes.
- **Type consistency:** `Encoding`, `EOL`, `LossyInfo`, `SessionTab`, `SessionState` defined once in `rpc.ts`, imported everywhere they're used.
- **API surface compatibility:** All extensions are additive (new optional fields, new error variants, new RPCs). M3 callers that don't pass new fields get exact current behavior.
- **F1 (binary detect ordering)** — locked in `text-io.readText` (already shipped, two regression tests in `tests/unit/text-io.test.ts`).
- **F2 (lossy refusal)** — fully formalized as `error: "lossy"` in SaveResponse + saveAsDialog response. Renderer confirm-and-retry flow in Task 6.
- **F3 (session active-tab override)** — Task 7 step 6 captures `initialTabId` from `editorApp.openFile`, calls `editorApp.state.activate(initialTabId)` AFTER restore loop. Skips the double-clicked path during the loop to avoid dedup collision.
- **F4 (dup-tab dedup)** — already correct in M3's `editor-state.open`.
- **F5 (bundle guard)** — Task 8, recalibrated for textarea.
- **No CodeMirror plumbing.** Task 1 rolls back the misaligned commit; Tasks 2–9 don't import CM.
