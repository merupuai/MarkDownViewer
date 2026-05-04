# Editor Design Conflict — M3 (in-flight) vs. Patched Plan

**Date:** 2026-05-04
**Reporter:** Claude (Opus 4.7)
**Trigger:** Editor Plan Task 4 (RPC schema extension) discovered an existing
M3 multi-format editor design already partially implemented in
`src/shared/rpc.ts` (committed as part of WIP anchor `307c4c6`).

**Status:** Phase 0 execution **HALTED** at Task 4 / step 1. Tasks 1-3 are
committed (deps + `text-io.readText` + `writeText` with F1/F2 fixes).
text-io.ts is portable across either design and does not need rollback.

---

## The conflict

The plan and the in-flight code have **two different RPC surfaces for the
same problem space**.

### What the patched plan adds (Task 4)

```ts
// From docs/superpowers/plans/2026-05-04-multi-format-editor.md (post-F1-F5)
writeFile:    params: { path, content, encoding, eol, bom, allowLossy? }
              response: { ok: true, lossyChars? } | { ok: false, lossy } | { ok: false, error }
saveAsDialog: params: { defaultName, content, encoding, eol, bom, allowLossy? }
              response: { ok: true, path, lossyChars? } | { ok: false, lossy? }
loadSession:  params: {}; response: SessionState
saveSession:  params: { state }; response: { ok: boolean }
readFile:     params: { path }; response: FilePayload  // FilePayload includes encoding/eol/bom
fileChanged   message; routes through watcher with recentSelfWrites self-echo suppression
```

**Design properties:**
- Watcher echo guarded by `recentSelfWrites` Map with 1s TTL (Bun-side)
- Encoding-aware (`utf-8` / `utf-16le` / `utf-16be` / `latin-1`) round-trip
- Latin-1 lossy save refuses + returns diagnostic (F2 patch)
- Tabs + per-tab `Doc` state in renderer
- `session.json` for cross-launch tab restore (1MB cap on untitled blobs)
- Save-As shows native folder picker, sanitizes filename

### What's already in the WIP anchor (M3 design)

```ts
// From src/shared/rpc.ts at HEAD (committed in 307c4c6)
readFile:    params: { path, intent?: "view" | "edit" }; response: FilePayload
             // FilePayload includes mtimeMs (server-recorded read-time mtime)
saveFile:    params: { path, content, expectedMtimeMs? }
             response: { ok: true, savedAt, mtimeMs, bytes }
                     | { ok: false, error: "conflict",   diskMtimeMs, expectedMtimeMs }
                     | { ok: false, error: "io-failure", message }
                     | { ok: false, error: "unsafe-path", message }
                     | { ok: false, error: "too-large",  bytes }
detectFormat:params: { path }; response: { format: EditorFormat, confidence }
windowMinimize/MaximizeToggle/Close: window control surface (NEW vs. plan)
getPlatform: params: {}; response: { platform, isMac }     (NEW vs. plan)
```

**Design properties:**
- Conflict detection via **mtimeMs comparison** at save time (renderer captures
  `mtimeMs` at read; `saveFile` rejects if disk mtime advanced)
- Explicit error taxonomy: `conflict` / `io-failure` / `unsafe-path` / `too-large`
- Format detection via dedicated `detectFormat` RPC (sniff content + extension)
- Window controls now part of RPC (titlebar restructure work in WIP anchor uses these)
- M3 task identifiers (`M3.S1`, `M3.S2`, `M3.S6`, `M3.S7`) in code comments
  suggest a different planning/build pipeline

**Missing vs. the plan:**
- No encoding/EOL/BOM round-trip (`FilePayload` has `path`, `content`, `mtimeMs` only)
- No tab state — looks like single-document editor (matches the existing
  preview/single-doc renderer architecture)
- No session restore
- No `saveAsDialog` separate from `saveFile`
- No watcher self-echo suppression (the mtimeMs approach handles a different
  problem — concurrent external edits, not save→watcher echo)

### Why they're not trivially mergeable

| Concern | Plan approach | M3 approach | Mergeable? |
|---|---|---|---|
| Save conflict detection | Watcher echo suppression via `recentSelfWrites` (avoid spurious "external change") | `expectedMtimeMs` comparison server-side (atomic save-or-fail) | **No — different problems.** Plan stops the watcher from firing on self-writes; M3 detects races between editor read and save. Both are useful, but they solve **different races**. |
| Encoding awareness | First-class: `encoding`, `eol`, `bom` are top-level params | Absent: `saveFile` takes string content only, no encoding info | **Partial.** M3 could add encoding fields, but the FilePayload would need them too — non-trivial schema change. |
| Save API shape | `writeFile` + `saveAsDialog` separate | `saveFile` covers both (Save dialog handled in renderer) | **Conflict.** Pick one. |
| Error reporting | Boolean `ok` + lossy variant | Discriminated union with named errors | **M3 is richer.** Plan's `error: string` is a step backwards. |
| Format detection | Inferred from extension in `editor.ts` (`languageForExtension`) | Server-side `detectFormat` RPC | **Both ship.** They're complementary — extension-only fast path + content-sniff for ambiguous files. |
| Tabs | Yes (TabStore + session restore) | No (single-doc) | **Conflict.** Plan adds significant renderer architecture; M3 design has no tabs. |
| Window controls | Out of scope (existing) | New RPCs (titlebar restructure) | **Both ship.** Window controls are independent of editor design. |

---

## Three resolution paths

### Path A — Plan wins (replace M3 surface)

Adopt the patched plan's design. Consequences:
- Replace `saveFile` → `writeFile` (lose mtime-conflict semantics, recover them later)
- Replace `readFile` intent param → drop (the plan doesn't need it)
- Replace `FilePayload` → add `encoding/eol/bom`, drop `mtimeMs`
- Drop `detectFormat` — use extension-only path (`languageForExtension`)
- Keep window-control RPCs (orthogonal)
- Continue plan execution from Task 4

**Cost:** loses M3's mtime-conflict detection (a real correctness property)
and forces a second pass to re-add it later.

### Path B — M3 wins (rewrite plan against M3 surface)

Adopt the M3 surface as canonical. Consequences:
- Rewrite editor plan Tasks 4, 5, 9, 10, 16 to use `saveFile` + `expectedMtimeMs`
- Add encoding/EOL/BOM as additive fields on `FilePayload` and `saveFile`
- Plan's tabs + session restore land on top of M3's single-doc renderer
- F2 lossy refusal becomes part of `saveFile`'s error union (a new `error: "lossy"`
  variant alongside `conflict`/`io-failure`/`unsafe-path`/`too-large`)
- Watcher self-echo handled differently (M3 may not need `recentSelfWrites`
  if the renderer always writes via `saveFile` + ignores `fileChanged` for
  files where local content matches disk content)
- Keep `detectFormat` in addition to `languageForExtension`

**Cost:** plan rewrite is substantial (~5 tasks). But the resulting plan ships
on a richer error model and preserves M3's correctness properties.

### Path C — Hybrid (preserve both surfaces, deprecate over time)

Keep M3's `saveFile` + `detectFormat` AS-IS. Add the plan's `writeFile` /
`saveAsDialog` / `loadSession` / `saveSession` AS NEW. Renderer chooses which
to call based on intent.

**Cost:** API surface bloat. Two ways to save a file (`saveFile` for explicit
mtime-aware saves; `writeFile` for the editor flow). Confusing for future
maintainers. Almost certainly the wrong call.

---

## Recommendation

**Path B.** The M3 design has a real correctness property (mtime-conflict
detection at save time) that the plan lacked, and the plan has features (tabs,
encoding round-trip, session restore, lossy refusal) that M3 lacks. M3's
error union is more idiomatic. Combining them — M3's surface as the base,
plan's features as additive layers — gives the strongest result.

**Concrete next steps if Path B chosen:**

1. Author a delta-spec at `docs/superpowers/specs/2026-05-04-multi-format-editor-DELTA.md`
   that describes Path B's resolution and the API the plan should target.
2. Re-write Plan Tasks 4, 5, 9, 10, 16 against the M3 surface. Smaller diff
   than the original plan because we're augmenting, not building from scratch.
3. Move the F2 lossy refusal into `saveFile`'s error union as `error: "lossy"`.
4. Decide explicitly: do we keep tabs as a Phase-2 feature, or scope the M3
   design as final and drop tabs from this work? (Spec §3 has tabs as a
   primary deliverable; M3 may have already decided against them.)
5. Re-run the F1-F5 review against the rewritten plan to confirm the review's
   findings still apply (most do; the F1 readText fix in particular is still
   correct).

---

## What's already committed (do NOT roll back)

| Commit | Why it's portable across both designs |
|---|---|
| `b72a2c9` | CodeMirror deps — agnostic to RPC shape |
| `87d4f3e` | `readText()` + 8 tests — pure encoding/EOL/BOM work, useful in either design |
| `ed0186e` | `writeText()` + F2 lossy + 6 tests — same; the function is callable from any save handler |

`src/bun/text-io.ts` is a clean library that either design can wrap. M3's
`saveFile` could call it with `meta = { encoding, eol, bom }` when those
fields are added to `saveFile`'s params.

---

## What's HALTED

| Editor plan task | Status |
|---|---|
| Task 4 (RPC schema) | HALTED — design conflict needs resolution |
| Task 5+ (Bun handlers, editor.ts, tabs.ts, etc.) | NOT STARTED — depends on Task 4 |

---

## Question for the owner

**Which path: A, B (recommended), or C?** Or is the M3 design fully owned and
the plan should be scrapped (Path D — drop the editor plan, keep text-io as
a library, let M3 evolve organically)?
