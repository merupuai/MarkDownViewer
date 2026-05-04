# Multi-format Editor — Path B Delta Spec

**Date:** 2026-05-04
**Status:** Active — supersedes the relevant sections of `2026-05-04-multi-format-editor-design.md`
**Owner:** veera@mftlabs.io
**Topic:** Reconcile the patched editor plan with the M3 design that's already shipped in `src/`

> **Why this exists:** The original spec (`2026-05-04-multi-format-editor-design.md`) and its
> patched plan were written assuming a greenfield. During execution we discovered that M3
> has already shipped a substantial editor — tabs, per-tab state, textarea-backed editor
> pane, format adapters, mtime-conflict save flow, format detection. This delta spec
> describes Path B (per the conflict report `2026-05-04-editor-design-conflict.md`):
> **M3 wins as the base; the plan's value-adds layer on top.**

---

## 1. What M3 has shipped (canonical, do not rebuild)

### 1.1 Bun process — `src/bun/index.ts`
- `readMarkdownFile(path)` — reads file, captures `mtimeMs`, returns `FilePayload`. **UTF-8 only** (`Bun.file.text()`).
- `saveDocumentFile(path, content, expectedMtimeMs?)` — atomic save via tmp+rename. Path validation (NUL/length cap), 50 MB cap, mtime-conflict detection, Windows rename retry. **UTF-8 only** (`Buffer.from(content, "utf8")`).
- `detectDocumentFormat(path)` — extension match + first-1KB content sniff → `{ format, confidence }`.
- `watchFile(path)` — fs.watch with 80ms debounce → `webview.send.fileChanged`.
- RPC handlers: `readFile` (intent param), `saveFile` (mtime conflict), `detectFormat`.

### 1.2 Renderer — `src/mainview/editor/`
- `editor-state.ts` (M3.S5) — Tab[] array, dirty tracking, 5-second autosave debounce, typed `EditorEvent` subscription.
- `editor-pane.ts` (M3.S3) — `<textarea>`-backed surface. **Deliberately NOT CodeMirror** — keeps bundle size small.
- `tabs.ts` (M3.S4 + M3.S11) — tab strip with dirty marker, click-to-activate, ×-to-close, dirty-close confirm prompt.
- `format-adapters.ts` (M3.S8/S9) — markdown (Cmd-B/I/K shortcuts), plain-text, json/yaml/toml degrade to plain-text.
- `editor-app.ts` — composer; full save flow with mtime-conflict resolution (save-anyway / reload / cancel).

### 1.3 Shared types — `src/shared/rpc.ts`
- `FilePayload` with `mtimeMs`.
- `SaveResponse` discriminated union: `{ ok: true, savedAt, mtimeMs, bytes }` vs. `{ ok: false, error: "conflict" | "io-failure" | "unsafe-path" | "too-large", ... }`.
- `FormatDetectResult`, `EditorFormat`.
- Window control RPCs (`windowMinimize` / `windowMaximizeToggle` / `windowClose`).

### 1.4 What M3 lacks (genuine gaps this delta closes)
| Gap | Impact today | Layer |
|---|---|---|
| Encoding awareness on read (UTF-8 only) | Can't open UTF-16 / Latin-1 files at all without mojibake | L1 |
| Encoding awareness on save (UTF-8 only) | Can't preserve original encoding round-trip | L2 |
| EOL detection + preservation (LF / CRLF) | Saves get bun's default line-ending behavior, may mangle Windows files | L2 |
| BOM detect + preserve | UTF-8-BOM and UTF-16-BOM files lose their BOM on save | L2 |
| Lossy-encoding refusal (Latin-1 + emoji etc.) | `Buffer.from(str, "latin1")` silently truncates to `0x3F` — silent data loss | L3 |
| Save As for untitled buffers | M3.S2 explicitly deferred — see editor-app.ts:113 | L4 |
| Session restore across launches | App quit loses all open tabs | L5 |
| Watcher self-write echo guard | After saveFile, watcher fires `fileChanged` on the saver's own write | L6 (optional) |

---

## 2. Path B Layers — additive, M3-respecting

### Layer 1 — Encoding-aware `readFile`

Replace the inside of `readMarkdownFile` (Bun side) to delegate to `text-io.readText`. Extend `FilePayload` with optional `encoding`, `eol`, `bom`, `binary` fields (additive — old consumers ignore them).

```diff
 export type FilePayload = {
   path: string;
   content: string;
   error?: string;
   mtimeMs?: number;
+  // L1: encoding/EOL/BOM captured at read time so the renderer can
+  // round-trip the file faithfully. Default to utf-8/lf/false on missing.
+  encoding?: "utf-8" | "utf-16le" | "utf-16be" | "latin-1";
+  eol?: "lf" | "crlf";
+  bom?: boolean;
+  binary?: boolean;
 };
```

### Layer 2 — Encoding-aware `saveFile`

Extend `saveFile`'s params with optional `encoding`, `eol`, `bom`. Replace `Buffer.from(content, "utf8")` with a call to `text-io.writeText` (which already handles BOM stamping + EOL conversion + per-encoding byte production). Defaults preserve current behavior when fields are omitted.

```diff
 saveFile: {
   params: {
     path: string;
     content: string;
     expectedMtimeMs?: number;
+    // L2: optional encoding metadata. Defaults to utf-8 / lf / no-bom
+    // (current M3 behavior) when omitted.
+    encoding?: Encoding;
+    eol?: EOL;
+    bom?: boolean;
+    // L3: opt in to a save that's known to lose chars in target encoding
+    allowLossy?: boolean;
   };
   response: SaveResponse;
 };
```

### Layer 3 — F2 lossy refusal as new SaveResponse variant

Extend `SaveResponse` with a new error case for the F2 finding:

```diff
 export type SaveResponse =
   | { ok: true; savedAt: number; mtimeMs: number; bytes: number }
+  | { ok: true; savedAt: number; mtimeMs: number; bytes: number; lossyChars: number }  // saved with allowLossy=true; lossyChars counts truncated chars
   | { ok: false; error: "conflict"; diskMtimeMs: number; expectedMtimeMs: number }
   | { ok: false; error: "io-failure"; message: string }
   | { ok: false; error: "unsafe-path"; message: string }
   | { ok: false; error: "too-large"; bytes: number }
+  | { ok: false; error: "lossy"; lossy: { encoding: Encoding; lossyCharCount: number; firstIndex: number; sample: string } };
```

When the renderer (`editor-app.ts`) receives `{ ok: false, error: "lossy" }`, it shows a confirm modal:
> *"Saving as Latin-1 will lose 3 character(s) that aren't representable. First lossy char at index 42. Continue?"*

If the user confirms, the renderer retries `saveFile` with `allowLossy: true`. Bun's `saveDocumentFile` then calls `text-io.writeText({ allowLossy: true })` and returns the success variant with `lossyChars` populated.

### Layer 4 — Save As for untitled

Add a `saveAsDialog` RPC that opens the system folder picker, builds a target path, then funnels through `saveDocumentFile` (same atomic + lossy-aware code path).

```ts
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
```

Renderer-side: `editor-app.ts:saveActiveImpl` — replace the `notify("Use \"Save As\" for untitled documents (not yet wired in M3.S2 — defer)", "warn")` with a `saveAsDialog` call. After success, update the tab's `path` field and re-trigger `markSaved`.

### Layer 5 — Session restore across launches

New module `src/bun/session-store.ts` (the plan's existing design — 1MB untitled-content cap is sound). New RPC handlers `loadSession` / `saveSession`. Renderer hook in `editor-app.mount()`: subscribe to `state` events, debounced 300ms persist call. Boot block: load → restore tabs → apply F3 fix (re-assert active after the loop).

`SessionTab` shape extends naturally from M3's `EditorTab`:
- `id`, `path`, `format`, `mtimeMs`, plus
- `untitledContent?: string` (only for `path === null`, capped at 1 MB)
- omit transient fields (`autosaveTimer`, `dirty` since it's derived)

### Layer 6 — Watcher self-write echo (optional)

After `saveDocumentFile` writes, the file watcher fires within ~80 ms and sends `fileChanged` for the file we just saved. M3's mtime-conflict approach makes this **non-fatal** (the renderer's view of mtime now matches disk after save), but the watcher event still triggers a preview re-render and may fire `markConflict` listeners. Adding a `recentSelfWrites: Map<string, number>` with 1s TTL silences the echo cleanly.

This is **deferred to a follow-up** unless the smoke test reveals visible flicker on save.

---

## 3. What we're NOT doing (vs. the original plan)

| Original plan task | M3 status | Decision |
|---|---|---|
| Task 1 — install CodeMirror 6 | M3 chose `<textarea>` | **Roll back** the `b72a2c9` commit. Don't ship 18 unused deps. |
| Task 6 — `editor.ts` CM6 wrapper | M3 has `editor-pane.ts` (textarea) | **Drop** — M3 architecture wins. |
| Task 7 — editor host element + status bar chips | M3 has tab UI; chips can land later | **Defer** — out of scope here. |
| Task 8 — `⌘E` toggle | M3 has format adapters via tab format field | **Defer** — different model than spec assumed. |
| Task 9 — `⌘S` save (single-doc) | M3 has multi-tab `saveActive` already | **Drop** — M3 superior. |
| Task 10 — external-change banner | M3 surfaces conflict via `markConflict` event | **Drop** — M3 model is richer (per-tab, not global). |
| Task 11 — encoding chip | Genuinely new — not in M3 | **Defer** — UI nicety, can ship later. |
| Task 12 — Goto Line | Not in M3 | **Defer** — textarea has Cmd-G already on mac; nice-to-have. |
| Task 13 — Word wrap toggle | Format adapter has `wrapLines` | **Drop** — M3 already configures per-format. |
| Task 14 — Phase 1 manual smoke | Replaced by L1–L5 manual smoke at the end |
| Task 15 — `tabs.ts` state machine | M3 has `editor-state.ts` | **Drop** — M3 is canonical. |
| Task 16 — Tab strip UI + active-tab routing | M3 has `tabs.ts` + `editor-app.ts` | **Drop** — M3 is canonical. |
| Task 17 — `session-store.ts` | Not in M3 | **Keep** — Layer 5. |
| Task 18 — Wire `loadSession`/`saveSession` + boot restore | Not in M3 | **Keep** — Layer 5, with F3 fix preserved. |
| Task 19 — README update | Still useful | **Keep** — deferred to end. |
| Task 19a — bundle-size guard (F5) | Useful regardless | **Keep** — but ceiling re-calibrated for textarea baseline (much smaller than CM6 ceiling would be). |
| Task 20 — final smoke | Always | **Keep** — narrowed to L1–L5 features. |

---

## 4. Revised task list (Path B)

The original 20+ tasks collapse to **8 tasks** under Path B. See the companion plan
`docs/superpowers/plans/2026-05-04-multi-format-editor-DELTA.md` for full step-by-step
detail. Summary:

| # | Task | Layer |
|---|---|---|
| 1 | Roll back CodeMirror deps (`b72a2c9`) | meta |
| 2 | Extend `FilePayload` + RPC types for encoding/EOL/BOM/lossy | L1 + L2 + L3 schema |
| 3 | Wire `text-io.readText` into `readMarkdownFile` (Bun) | L1 |
| 4 | Wire `text-io.writeText` into `saveDocumentFile` (Bun) — including `allowLossy` plumbing and the `error: "lossy"` response | L2 + L3 |
| 5 | Add `saveAsDialog` RPC + renderer wiring (replaces M3.S2-deferred TODO) | L4 |
| 6 | Renderer-side: `editor-app.ts` handles `error: "lossy"` with confirm modal + retry | L3 |
| 7 | Session-store + RPC + boot restore (with F3 active-tab fix) | L5 |
| 8 | Bundle-size guard (F5) calibrated for textarea baseline | quality |

Each task ships its own commit. Tests in `tests/unit/`. The `text-io.ts` library
already in `87d4f3e`/`ed0186e` is the foundation — both `readMarkdownFile` and
`saveDocumentFile` simply delegate to it.

---

## 5. Compatibility & rollout

- **Backward compatible:** all RPC fields are optional. Renderer that doesn't pass
  `encoding`/`eol`/`bom` gets exactly today's M3 behavior (UTF-8, no BOM, lf or
  os-default eol). New error variants (`"lossy"`) are unreachable unless caller
  passes `encoding: "latin-1"` with non-Latin-1 content.
- **Migration:** none required. M3's existing tabs, dirty tracking, conflict
  resolution, format adapters all keep working.
- **Out of scope (for this delta):** CodeMirror migration, encoding chip UI,
  goto-line, word-wrap toggle, light-on-light favicon variant.

---

## 6. F1–F5 review applicability

| Finding | Status under Path B |
|---|---|
| **F1** (`isBinary` ordering) | **Already correct** in `text-io.ts` (commit `87d4f3e`). Used by L1. |
| **F2** (Latin-1 lossy) | **Now Layer 3** — formalized as `error: "lossy"` SaveResponse variant. |
| **F3** (session restore active-tab override) | **Layer 5 task incorporates it** — boot block must `setActive(initialTabId)` after restore loop, since M3's `editor-state.open` also sets active. |
| **F4** (dup-tab spec contradiction) | **Already aligned** — M3's `editor-state.open` dedupes by path. Spec §8 update from earlier patch (commit `71870e7`) holds. |
| **F5** (bundle-size guard) | **Still valuable** but ceiling will be much lower (textarea baseline). Recalibrate against post-L1–L5 build. |

---

## 7. Decision points still open

These are deliberately *not* decided here. The delta plan can ship without them.

- **Encoding chip UI** in the status bar (lets user override next-save encoding).
  Useful but not load-bearing. Punt to a follow-up.
- **CodeMirror migration** (M3 chose textarea, kept bundle small). Reconsider
  only if the textarea ceiling proves limiting (no syntax highlight beyond
  format-adapter shortcuts; no multi-cursor; no built-in find-replace).
  Currently NO.
- **Linux build editor parity** — out of scope until Linux build lands.
- **Watcher self-write echo guard** (Layer 6) — defer unless smoke shows flicker.
