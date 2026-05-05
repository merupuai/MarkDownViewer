---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/05-database-and-data-store-report.md
pipeline: brownfield
topic: 02-discovery
title: "Database & Data Store Report"
order: 2
audiences: ["architect", "security", "build-agent"]
source_sha256: 686b43207003c9d4d55bbe9fcb8d8b5fffde38ed10f9d34847c5c0f6a0216547
source_size: 4320
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# Database and Data Store Report — MarkDownViewer

**Verdict**: NO RELATIONAL OR NoSQL DATABASE. Application persists state through three filesystem-only mechanisms.

## Inventory

| Storage | Format | Location | Schema | Lifecycle |
|---|---|---|---|---|
| Recent-files store | JSON | `Utils.paths.userData/recent.json` (per-user data dir) | `RecentEntry[]` (max 20 entries: `{ path, name, openedAt }`) | Created on first `pushRecent`; mutated on every file open; cleared via `clearRecent` RPC |
| EULA acceptance marker | Plain text | `<userDataDir>/eula-accepted-${EULA_VERSION}` (Mac: `~/Library/Application Support/com.local.markdownviewer/`; Windows: `%APPDATA%/MarkdownViewer/`; Linux: `${XDG_CONFIG_HOME}/markdown-viewer/`) | Single timestamp line | Created on EULA accept; persisted across runs; bumped if `EULA_VERSION` changes (currently `v1`) |
| Sidebar width preference | localStorage | Browser localStorage (key `sidebar-w`) | CSS pixel string e.g. `"260px"` | Mutated on resize handle drag end; restored on boot |
| Bun debug log | Plain text (append) | `/tmp/mdv-bun.log` (Unix); on Windows the path is unfiltered which means appendFileSync may fail silently | One line per event: `[ISO timestamp] message` | Append-only; not rotated; cleared only manually |

## Data Dictionary

### `recent.json`

```jsonc
[
  {
    "path": "/abs/path/to/file.md",   // string, absolute, can include `~` if shell-expanded
    "name": "file.md",                 // string, basename
    "openedAt": 1714838400000          // number, ms since epoch
  }
  // ... up to 20 entries; deduplicated by path on push
]
```

Read & validation in `src/bun/index.ts::loadRecent` (lines 345-352):
- Parses with `JSON.parse`; on any error returns `[]`
- Filters to entries with `typeof e.path === 'string'`
- No schema validator (e.g. zod) — TypeScript types only

### EULA marker file

Single line:
```
2026-05-04T10:35:55.689Z (accepted at first run)
```

Implicit schema: presence of file = acceptance. Content is human-readable context only. The Windows Inno Setup installer pre-populates this marker if the user clicked through the EULA at install time.

## ERD

There are no relational entities. A trivial Mermaid graph below is provided for traceability:

```mermaid
graph LR
  RECENT[recent.json<br/>RecentEntry[]] -->|read by| BUN[Bun main process]
  EULA[eula-accepted-v1<br/>marker file] -->|read by| BUN
  LOCALSTORAGE[localStorage:sidebar-w] -->|read by| MAIN[Electroview renderer]
  LOG[/tmp/mdv-bun.log<br/>append-only] -.->|written by| BUN
  LOG -.->|forwarded via RPC.log| MAIN
```

## Migration Strategy (n/a)

No SQL DDL, no migrations needed. The recent-files JSON is forward-compatible (extra keys ignored on read). The EULA marker version bump (`EULA_VERSION = "v2"`) is an explicit re-acceptance event — there is no schema migration concept.

## Risks Identified

| Risk | Severity | Source | Notes |
|---|---|---|---|
| `loadRecent` does no path-validation; entries pointing to deleted files render as broken history | Low | `src/bun/index.ts:345-352` | UI correctly degrades — clicking a missing file produces a `FilePayload.error`. Offer "remove broken entries" as future enhancement. |
| `/tmp/mdv-bun.log` path is hardcoded — does not exist on Windows by default; appendFileSync fails silently | Low | `src/bun/index.ts:508`, `:517` | Affects diagnostics only. Replace with `os.tmpdir()` + `dbg.log` for cross-platform parity. |
| No size cap on `mdv-bun.log` — append-only log can grow unboundedly | Low | `src/bun/index.ts:508`, `:517` | Real-world impact tiny (verbose only on file-change render). Rotation not required for typical use. |

## Backup / Retention

User responsibility — `recent.json` and EULA marker live in standard OS user-data directories that are picked up by Time Machine / Windows Backup / dotfile sync.

## Caching / Search Indices / Queues

None. The folder search at `src/bun/index.ts:279-336` performs an on-demand regex scan with no index, bounded by:

- `MAX_TREE_DEPTH = 8`
- `MAX_TREE_ENTRIES = 5000`
- `MAX_SEARCH_HITS_PER_FILE = 20`
- `MAX_SEARCH_TOTAL_HITS = 500`
- `MAX_SEARCH_FILES = 5000`
- `MAX_SEARCH_FILE_SIZE = 2 MB`

These are reasonable caps for a desktop app over a typical Obsidian/Notes vault but would require an index for vaults > 10 K files.
