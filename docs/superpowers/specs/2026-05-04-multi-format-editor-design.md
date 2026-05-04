# Multi-format editor design

**Date:** 2026-05-04
**Status:** Draft — awaiting user review
**Scope:** Add inline editing and multi-format text-file support to Markdown Viewer

---

## 1. Goal

Turn Markdown Viewer from a viewer-only into a viewer + Notepad++-class text editor, without losing the existing "double-click any `.md` file → renders instantly" promise.

**In scope**
- Inline editing for any text file (markdown, code, config, plain text)
- Tabs (multiple files per window)
- Notepad++-equivalent daily editing features
- Save / Save As, dirty tracking, session restore
- Encoding and line-ending preservation

**Out of scope (deliberately, to avoid feature bloat)**
- Macros (record/replay)
- Plugin system
- Hex view / document map / file compare
- FTP/SFTP / remote editing
- Spell check (deferred to a future revision)
- Multi-pane same-doc split
- Linux build (still a separate roadmap item)

---

## 2. View modes

The current app renders markdown to HTML on open. After this change:

| File category | Default open behavior |
|---|---|
| `.md`, `.markdown`, `.mdown`, `.mkd`, `.mkdn`, `.mdx` | **Preview** mode (existing rendered output) |
| Anything else (`.txt`, `.json`, `.yaml`, `.html`, `.css`, `.js`, `.ts`, `.py`, `.sh`, `.ps1`, `.go`, `.rs`, …) | **Editor** mode (CodeMirror 6) |

`Ctrl+E` / `⌘E` toggles between Editor and Preview. Toggle is only meaningful for markdown; other file types stay in Editor.

The "double-click any `.md` file → renders instantly" promise is preserved — first paint is still preview.

---

## 3. Architecture

```
┌─ Bun main process (src/bun/index.ts) ───────────────┐
│  • file I/O (read/write) — write is NEW             │
│  • watcher — extended to suppress self-write echoes │
│  • encoding detect (NEW): UTF-8/16/Latin-1, BOM     │
│  • session restore (NEW): persist open tabs         │
│  • RPC handlers — extended                          │
└──────────────────────┬──────────────────────────────┘
                       │  RPC (typed, AppRPC)
┌──────────────────────▼──────────────────────────────┐
│  Renderer (src/mainview/) — REORGANIZED             │
│                                                     │
│  ┌─ TabBar ───────────────────────────────────┐    │
│  │  [README.md •] [config.json] [+]           │    │  NEW
│  └────────────────────────────────────────────┘    │
│                                                     │
│  Per-tab document state (Doc):                     │
│    • path | content | savedContent | encoding | …   │
│    • Editor (CodeMirror 6) — created lazily        │  NEW
│    • Preview (existing pipeline) — md only         │
│                                                     │
│  Toggle: ⌘E flips Editor ↔ Preview (md only)       │
└─────────────────────────────────────────────────────┘
```

### 3.1 New files

**Renderer (`src/mainview/`):**
- `editor.ts` — CodeMirror 6 instance factory + per-language loader
- `tabs.ts` — tab strip, tab state, close-confirm, switching
- `session.ts` — persist/restore open tabs (thin RPC wrapper)

**Bun (`src/bun/`):**
- `text-io.ts` — encoding-aware read+write (BOM detect, line-ending detect, preserve-on-save)
- `session-store.ts` — persist `~/.MarkdownViewer/session.json`

### 3.2 Touched files

- `bun/index.ts` — add `writeFile`, `getFileMeta`, `saveSession`, `loadSession` RPC handlers; watcher consults `recentSelfWrites: Map<path, timestamp>` (1-second TTL) before firing
- `mainview/index.ts` — render path becomes "render the active tab" instead of "render the document"; existing markdown pipeline unchanged
- `shared/rpc.ts` — extend types
- `mainview/index.html` — add tab strip and editor host
- `mainview/index.css` — tab-strip styles, dirty indicator, encoding/EOL chips
- `electrobun.config.ts` — file associations stay markdown-only on install (don't claim `.txt` etc.)

### 3.3 Editor choice — CodeMirror 6

**Why not Monaco:** ~3 MB minified. The whole pitch of this app is a tiny bundle (~20–30 MB total). Monaco doesn't fit.
**Why not `<textarea>`:** No line numbers, no syntax highlight, no bracket matching, no search-replace API. Fails the Notepad++ bar.
**Why CM6:** ~150 KB core + 10–30 KB per language pack, lazy-loaded. Has built-in line numbers, search, indent, bracket matching, code folding, multi-cursor, rectangular select. Clean extension API.

### 3.4 Components & boundaries

| Unit | Purpose | Public interface |
|---|---|---|
| `editor.ts` | Wrap CM6. Create/destroy per-tab. Load language packs. Emit `change`. | `createEditor(host, opts) → { setDoc, getDoc, focus, destroy, on('change') }` |
| `tabs.ts` | Tab strip UI + active-tab state. Owns the array of `Doc`. | `openDoc(path)`, `closeTab(id)`, `getActive()`, `markDirty(id)` |
| `session.ts` | Persist+restore open tabs across launches. Thin RPC wrapper. | `save(tabs)`, `restore() → Tab[]` |
| `find-in-doc.ts` (existing) | Extended to also work inside the editor (delegates to CM6's `@codemirror/search` when active is editor) | unchanged outer signature |
| `markdown.ts` (existing) | Untouched. Still produces preview HTML. | unchanged |
| `index.ts` | Top-level wiring. Holds `tabs`, listens to menu actions, routes to active doc. | unchanged outer signature |
| `text-io.ts` | Encoding-aware file I/O. | `readText(path) → { content, encoding, eol, bom }`, `writeText(path, content, meta)` |
| `session-store.ts` | Read/write `session.json` on disk. | `load()`, `save(state)` |

### 3.5 The `Doc` type — single source of truth per tab

```ts
type Doc = {
  id: string;            // uuid, stable across writes
  path: string | null;   // null for untitled
  name: string;
  content: string;       // current editor content
  savedContent: string;  // last saved/loaded — diff = dirty
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'latin-1';
  eol: 'lf' | 'crlf';
  bom: boolean;
  language: string;      // for CM6 language pack ('markdown' | 'json' | …)
  viewMode: 'preview' | 'editor';  // markdown only; non-md is always 'editor'
  editor?: EditorHandle;  // lazily created when tab is shown
};
```

`dirty` is derived (`content !== savedContent`) — never stored. Eliminates a class of out-of-sync bugs.

---

## 4. Supported file types

**Tier 1 — Plain text (no syntax highlight needed):** `.txt`, `.log`, `.ini`, `.env`, `.conf`, `.gitignore`, `.editorconfig`, files with no extension.

**Tier 2 — Common data formats:** `.json`, `.yaml`/`.yml`, `.toml`, `.xml`, `.csv`, `.html`, `.css`.

**Tier 3 — Code files:** `.js`, `.jsx`, `.ts`, `.tsx`, `.py`, `.sh`, `.ps1`, `.bat`, `.go`, `.rs`, `.rb`, `.java`, `.c`, `.cpp`, `.h`, `.sql`.

Language packs are lazy-loaded — opening a `.py` file dynamically imports the Python pack; the JSON pack stays unloaded until needed.

**File associations on install (unchanged):** the OS-level file-type registration still claims only the markdown family. The app *opens* any text file via File menu, drag-drop, or "Open With…", but it doesn't steal `.txt` from Notepad/TextEdit on install. Safer for users.

---

## 5. Daily features in scope

| Feature | Notes |
|---|---|
| Line numbers, current-line highlight | CM6 default |
| Find / Replace with regex toggle | Extends current find-bar; uses `@codemirror/search` |
| Goto line `Ctrl+G` | New, simple modal |
| Word wrap toggle | View menu |
| Tabs vs spaces, indent width | Per-document state, stored in session |
| Block comment / uncomment `Ctrl+/` | Language-aware |
| Duplicate line `Ctrl+D`, move line `Alt+↑/↓` | Standard Notepad++ keys |
| Multi-cursor, rectangular select | CM6 free (Alt-click, Alt-drag) |
| Bracket matching, code folding | CM6 free |
| Encoding indicator (status bar) | Click → Reopen As: UTF-8 / UTF-16 LE / UTF-16 BE / Latin-1 |
| Line-ending indicator (status bar) | LF / CRLF |
| Modified indicator | `*` in tab title and window title |
| Confirm before discarding unsaved changes | Modal with Save / Discard / Cancel |
| Save `Ctrl+S` / Save As `Ctrl+Shift+S` | Native dialog for Save As |
| Reopen session on launch | Tabs + active tab restored |
| Right-click editor context menu | Cut / Copy / Paste / Select All / Comment |

### 5.1 Keyboard binding change

`Ctrl+D` currently toggles the theme. Notepad++ uses `Ctrl+D` for duplicate-line, and editor users will hit it constantly. Resolution:

- **`Ctrl+D` → duplicate line** (in editor) / no-op (in preview)
- **`Ctrl+Shift+L` → toggle theme** (Light/Dark)
- The sidebar theme button keeps working as before.

---

## 6. Out of scope (explicit excludes)

| Excluded | Why |
|---|---|
| Macros (record/replay) | Used by ~5% of Notepad++ users; large surface |
| Plugin system | Massive surface; out of v1 ambit |
| Hex view | Niche; binary files are refused outright instead |
| Document map | Niche; outline tab serves the same purpose for prose |
| File compare | Belongs in a diff tool, not an editor |
| Multi-pane same-doc split | Different problem (view, not edit) |
| FTP/SFTP / remote editing | Trust/auth surface, rarely daily |
| Spell check | Useful but deferred — language detection + dictionary work is non-trivial |
| Auto-save | Surprise auto-saves are how people lose work; explicit `Ctrl+S` only |

---

## 7. Data flow

### 7.1 Open file
```
User → File ▸ Open / drag-drop / tree click
     → renderer asks Bun: readFile(path)
     → Bun: text-io.readText() → { content, encoding, eol, bom }
     → renderer: tabs.openDoc(payload) creates a Doc
     → if .md → preview pipeline (existing)
       else  → mount CodeMirror with language pack
     → status bar shows: encoding · eol · language · zoom
     → file-watcher attaches (existing flow)
```

### 7.2 Edit
```
keystroke → CM6 'change' → Doc.content updated → derived dirty=true
        → tab title repaints with leading *
        → window title gets * prefix
(no IPC, no preview re-render)
```

### 7.3 Save (Ctrl+S)
```
renderer → editor.getDoc() → RPC writeFile({ path, content, encoding, eol, bom })
       → Bun: text-io.writeText() — also stamps recentSelfWrites[path] = Date.now()
       → watcher fires within ~80ms but sees recent self-write → suppresses
       → renderer: Doc.savedContent = content → dirty=false
       → if path was null (untitled) → Save As dialog first
```

### 7.4 External change (e.g. `git pull`)
```
watcher fires → not in recentSelfWrites
            → if Doc is clean → reload silently (existing behavior)
            → if Doc is dirty → show non-blocking banner:
              "File changed on disk. [Reload] [Keep my changes]"
```

### 7.5 Close tab
```
if dirty → modal: "Save changes to README.md?" [Save] [Discard] [Cancel]
       → Save → save flow above, then close
       → Discard → close
       → Cancel → no-op
else → close immediately
```

### 7.6 App quit
session.save() runs first; on next launch, tabs reopen in order with the previously-active tab focused. Untitled-tab content is persisted in-memory-blob style (capped at 1 MB per tab).

---

## 8. Error handling & edge cases

| Case | Behavior |
|---|---|
| File doesn't exist on save | Inline error in status bar; tab stays dirty |
| Permission denied on save | Surface OS error verbatim; tab stays dirty |
| File deleted while open | Tab persists ("orphan"); first save re-creates the file at original path |
| Disk full | Native error bubbles up; tab stays dirty; nothing silently lost |
| Binary file opened by mistake (e.g. `.png`) | Detect via NUL-byte scan in first 8 KB → refuse: "Binary file. Open with system app?" |
| File too large (>10 MB) | Open in read-only mode with warning |
| Encoding misdetect | Encoding chip in status bar → click to Reopen As… |
| Two tabs pointing at same path | Allowed but flagged in status bar |
| Markdown preview crash (e.g. mermaid bug) | Existing per-block catch survives; if whole pipeline throws, tab falls back to editor mode with banner |
| Watcher echo loop | `recentSelfWrites` map with 1-second TTL |
| Untitled tab + app quit | Session-store keeps content as in-memory blob (capped 1 MB); paths-only for everything else |

---

## 9. Testing strategy

Three layers, scaled to risk:

1. **Unit (`text-io.test.ts`)** — encoding detection (BOM patterns), line-ending detection, round-trip preservation. Small, fast, no Electron. The riskiest unit; needs the heaviest coverage.
2. **Renderer integration** — boot the renderer in the dev build, simulate "open file → edit → save" via direct function calls. Verify dirty state, watcher suppression, tab switching. ~10 cases.
3. **Manual smoke checklist** — committed as `docs/superpowers/test-checklists/editor-smoke.md`. Covers what's hard to automate inside Electrobun: dialogs, drag-drop, system menu actions, OS-level external file change. ~15 items.

No E2E framework. Electrobun has no stable headless mode and adding Playwright for one app isn't worth it. Manual smoke + tight unit coverage on `text-io` is the right balance.

---

## 10. Migration / backward compatibility

- Existing `.md` workflows are preserved: double-click still opens to rendered preview.
- Existing keyboard shortcuts continue to work, with the documented `Ctrl+D` rebind.
- The current `recent.json` format is forward-compatible; `session.json` is new and additive.
- No changes to the install scripts' file-type registrations on day one. (A future opt-in flag could let users register `.txt` etc., but that's a follow-up.)

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| CM6 bundle bloat from language packs | Lazy-load per language; measure final bundle in CI |
| Watcher echo causing flicker on save | `recentSelfWrites` TTL map; tested explicitly |
| Encoding round-trip data loss | Unit tests for every encoding/EOL/BOM combo |
| Performance on large files | Hard cap at 10 MB; read-only above that; CM6 handles up to ~1 MM lines fine in profile |
| User confusion: edit vs preview | `⌘E` indicator in status bar; tab title shows mode chip |

---

## 12. Open questions (none blocking)

None. All decisions above are committed; the spec is implementation-ready pending user review.
