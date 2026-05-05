---
cobolt_published: true
canonical: _cobolt-output/latest/planning/event-schemas.md
pipeline: plan
topic: 02-architecture
title: "Event Schemas"
order: 7
audiences: ["architect", "platform-lead", "build-agent"]
source_sha256: eca89c24513c048331be96784494091cf2558ccb2b39283b6dfcf72512eb1e67
source_size: 3578
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# Event Schemas — MarkDownViewer

## Scope

The application has no domain-event bus or event-driven architecture. The closest analog is the **in-process RPC message stream** between `bun` and `mainview` (defined in `src/shared/rpc.ts`).

This document catalogs those messages as "events" so the planning-sync contract has a destination to point to. For RPC request/response contracts see `30-modernization-api-contracts.md`.

## Event Catalog

### bun → bun (none)

The bun process is a single-threaded event loop. No internal pub/sub.

### view → bun (one-way "messages")

| Event | Schema | Producer | Consumer | Purpose |
|---|---|---|---|---|
| `ready` | `{}` | `src/mainview/index.ts:809` (boot IIFE) | `src/bun/index.ts:496` | Renderer signals it has booted; bun flushes any pending initial file |
| `print` | `{}` | menuAction print handler | `src/bun/index.ts:504` | Trigger `webview.print()` |
| `log` | `{ level: "info"|"warn"|"error", msg: string }` | renderer (via `rlog`) | `src/bun/index.ts:507` | Pipe renderer console messages into the bun debug log |

### bun → view (one-way "messages")

| Event | Schema | Producer | Consumer | Purpose |
|---|---|---|---|---|
| `fileOpened` | `FilePayload` | `dispatchFile` (initial open + `getInitialFile`); RPC handlers post-read | renderer's `renderFile` | Push opened file payload |
| `fileChanged` | `FilePayload` | file watcher debounced 80 ms | renderer's `renderFile({preserveScroll: true})` | Push file change |
| `folderOpened` | `FolderPayload` | `openFolderDialog` post-walk | renderer's `renderFolder(payload, true)` | Push folder tree |
| `folderUpdated` | `FolderPayload` | folder watcher debounced 250 ms | renderer's `renderFolder(payload, false)` | Push refreshed tree |
| `menuAction` | `{ action: string }` | `application-menu-clicked` event handler | renderer's `handleMenuAction(action)` | Forward menu click |

### M1 additions

| Event | Schema | Purpose |
|---|---|---|
| `cspViolation` | `{ violatedDirective: string; blockedURI: string; sourceFile?: string; lineNumber?: number }` | Renderer's `securitypolicyviolation` handler forwards to bun for logging |

### M3 additions (multi-format editor)

| Event | Schema | Producer | Consumer | Purpose |
|---|---|---|---|---|
| `autosaveTick` | `{ tabId: string; path: string; contentHash: string; bytes: number }` | renderer (every 5 s if dirty; signal-only — no content) | bun (acknowledges) | Heartbeat + drift detection |
| `tabClosed` | `{ tabId: string }` | renderer | bun | Cleanup any per-tab state in bun |
| `tabSaved` | `{ tabId: string; path: string; savedAt: number }` | renderer | bun | Update recent.json with `lastEdit` |
| `tabFormatChanged` | `{ tabId: string; format: string }` | renderer | bun | Optional: bun may pre-warm format-specific behavior |
| `fileChangedExternal` | `{ tabId: string; path: string }` | bun (file watcher) when an open editor's file changes outside the app | renderer | Renderer prompts user "Reload from disk?" |

## Versioning

Same as `30-modernization-api-contracts.md`: in-process RPC ships in a single bundle, both ends always at the same version. No backward-compat is needed across versions; each release of the .app pairs the bun and renderer codepaths.

For NEW events (M1, M3), use **optional fields** (e.g., `sourceFile?` on `cspViolation`) so adding details doesn't break older receivers. For event-name changes, treat as breaking and capture in an ADR.

## Replay / Persistence

No event sourcing or persistent log. Events are ephemeral and live for the duration of the app process.
