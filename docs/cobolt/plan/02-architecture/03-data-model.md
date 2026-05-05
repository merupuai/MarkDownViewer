---
cobolt_published: true
canonical: _cobolt-output/latest/planning/data-model-spec.md
pipeline: plan
topic: 02-architecture
title: "Data Model Specification"
order: 3
audiences: ["architect", "platform-lead", "build-agent"]
source_sha256: 6087eedbd5a71610a88a7e34e8d4ff42d2ec7b22bb2c79df93efcf58725b04ab
source_size: 5027
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# Modernization Data Model Specification — MarkDownViewer

The application has no relational or NoSQL database. Data persistence is entirely filesystem-based via three small JSON / text artifacts. This document codifies their schemas for forward use (and for the M3 multi-format editor's per-tab state).

## 1. Persisted Stores

### 1.1 `recent.json`

Location: `<userDataDir>/recent.json` (resolved by `Utils.paths.userData` from Electrobun)

Schema (TypeScript):
```ts
type RecentEntry = {
  path: string;       // absolute filesystem path
  name: string;       // basename(path)
  openedAt: number;   // ms since epoch
  // M3 additions:
  format?: "markdown" | "plain-text" | "json" | "yaml" | "toml" | string; // undefined = auto-detect
  lastEdit?: number;   // ms since epoch (only set if user opened in edit mode)
};

type RecentStore = RecentEntry[];   // capped at 20 entries
```

Invariants:
- Length ≤ 20
- Deduplicated by `path`
- Sorted by recency (most recent first)
- New entries unshifted; old entries dropped from tail
- All filesystem paths in this file MUST be the OS-canonical path returned by Bun's `path.resolve`

Migration plan:
- Adding `format` and `lastEdit` is forward-compatible — existing files load without these fields
- Schema-version field is NOT introduced (the cap of 20 entries makes a wholesale rewrite trivial; if breaking change ever needed, write `recent.v2.json`)

### 1.2 EULA acceptance marker

Location: `<userDataDir>/eula-accepted-${EULA_VERSION}` (currently `eula-accepted-v1`)

Schema:
- Plain text, single line, ISO-8601 timestamp + free-text descriptor
- Presence of file = acceptance
- Absence = first-run dialog required

Invariants:
- File mode 0644 on Linux/macOS (M1 hardening per § Compliance)
- File creation is the ATOMIC sign of acceptance — partial writes acceptable because absence-or-presence is the only signal

### 1.3 Sidebar width preference

Location: Renderer localStorage, key `sidebar-w`

Schema:
- CSS pixel string (e.g. `"260px"`)

Invariants:
- Clamped to [180px, 560px] on read

### 1.4 Bun debug log

Location (M1 onward): `os.tmpdir() / mdv-bun.log` (was `/tmp/mdv-bun.log`)

Schema:
- Plain text, line-oriented, ISO-8601 timestamp prefix
- Examples: `[2026-05-04T12:34:56.789Z] [mv] dispatching initial file: /Users/me/notes.md`
- Levels in renderer-piped lines: `[view info] msg`, `[view warn] msg`, `[view error] msg`

Invariants:
- File rotates at 10 MB → `mdv-bun.log.1`
- Older `.1` is overwritten (no `.2`, `.3`, ...)
- File MUST NOT contain user file body content (only paths, sizes, durations, counter telemetry, error messages)

## 2. M3 New State (multi-format editor)

### 2.1 Per-tab editor state (in-memory + autosave-to-disk)

Schema (proposed):
```ts
type EditorTab = {
  id: string;                  // uuid v4
  path: string | null;         // null for unsaved-new
  format: string;              // "markdown" | "plain-text" | ...
  content: string;             // current buffer
  dirty: boolean;
  cursor: { line: number; col: number };
  selection?: { start: number; end: number };
  lastSavedAt?: number;        // ms since epoch
  autosaveInterval?: number;   // ms; default 5000
};

type EditorState = {
  tabs: EditorTab[];
  activeTabId: string | null;
};
```

Persistence:
- In-memory while running
- Per-tab autosave to original path on dirty + interval
- On crash: tab state in `<userDataDir>/editor-tabs.json` recovered next launch (out of scope for M3 v1; deferred)

### 2.2 New RPC payloads (M3)

```ts
type SaveRequest = { path: string; content: string };
type SaveResponse = { ok: boolean; savedAt?: number; error?: string };

type AutosaveTick = { tabId: string; path: string; contentHash: string; bytes: number };  // signal only; no content
```

## 3. Validation Rules

| Rule | Where | Status |
|---|---|---|
| `path` must be absolute, non-empty, no NUL bytes | RPC.readFile, RPC.openFolder, RPC.searchFolder, RPC.save (M3) | TODO (M1 + M3) |
| `content` size cap (configurable, default 10 MB) | RPC.save (M3) | TODO (M3) |
| `format` must be in registered adapters list | EditorTab construction (M3) | TODO (M3) |
| Folder search query length ≤ 1024 | RPC.searchFolder | TODO (M1) |

## 4. Out of Scope (now and forever-ish)

- Centralized cloud sync of recent / preferences / editor state
- Multi-user shared documents
- Database (relational or NoSQL)
- ORM / migration framework

<!-- COBOLT_BROWNFIELD_FEATURE_TRACEABILITY:START -->

## Brownfield Feature Traceability

- Feature: FEAT-001 Brownfield modernization access slice
- Requirement IDs: FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007, FR-008, FR-009, FR-010, FR-011, FR-012, FR-013, NFR-001, NFR-002, NFR-003, NFR-004, NFR-005, NFR-006
- Coverage: product intent, user flow, UI states, wireframes, backend, middleware, API, data, integrations, auth, security, privacy, NFRs, observability, tests, rollout, service blueprint, spec contracts, accessibility, and architecture.

<!-- COBOLT_BROWNFIELD_FEATURE_TRACEABILITY:END -->
