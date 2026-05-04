---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/30-modernization-api-contracts.md
pipeline: brownfield
topic: 06-target-state
title: "Modernization API Contracts"
order: 10
audiences: ["architect", "security", "build-agent"]
source_sha256: 731a52f1cfe66e59915ac1812336e88e2f5da1e2edff7849662eb689d92d41c6
source_size: 5304
published_at: 2026-05-04T14:36:58.135Z
published_by: cobolt-publish-docs
---

# API Contracts — MarkDownViewer

The application has no HTTP/REST/GraphQL/gRPC API. The only "contract" is the in-process typed RPC between the bun and mainview processes, defined in `src/shared/rpc.ts`.

This document is the authoritative source for the RPC contract — current state plus the M1 / M3 deltas.

## 1. Current Contract (post-M0, pre-M1)

```ts
type AppRPC = {
  bun: RPCSchema<{
    requests: {
      openDialog:        { params: {}; response: FilePayload | null };
      openFolderDialog:  { params: {}; response: FolderPayload | null };
      readFile:          { params: { path: string }; response: FilePayload };
      resolveImage:      { params: { docPath: string; src: string }; response: ImageResolveResult };
      getInitialFile:    { params: {}; response: FilePayload | null };
      openExternal:      { params: { url: string }; response: { ok: boolean } };
      revealInFinder:    { params: { path: string }; response: { ok: boolean } };
      getRecent:         { params: {}; response: RecentEntry[] };
      clearRecent:       { params: {}; response: { ok: boolean } };
      searchFolder:      { params: { root: string; query: string; caseSensitive?: boolean; wholeWord?: boolean }; response: SearchResults };
      exportHtml:        { params: { html: string; title: string; defaultName: string }; response: { ok: boolean; path?: string } };
    };
    messages: {
      ready: {};
      print: {};
      log:   { level: "info" | "warn" | "error"; msg: string };
    };
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {
      fileOpened:     FilePayload;
      fileChanged:    FilePayload;
      folderOpened:   FolderPayload;
      folderUpdated:  FolderPayload;
      menuAction:     { action: string };
    };
  }>;
};
```

## 2. M1 Deltas (security hardening)

### 2.1 `resolveImage` response gains a typed error

```ts
type ImageResolveResult =
  | { dataUrl: string; mime: string; bytes: number }
  | { error: "external" }                              // existing (https/data/file scheme)
  | { error: "not-found"; resolved: string }
  | { error: "out-of-bounds"; resolved: string }       // NEW (SR-02 path containment)
  | { error: "unsupported-type"; ext: string }         // NEW (SR-05 MIME enforcement)
  | { error: "too-large"; bytes: number }              // NEW (size cap)
  | { error: "io-failure"; message: string };
```

### 2.2 `searchFolder` query length cap

`query` MUST be ≤ 1024 characters. Server-side rejection: `{ query, hits: [], truncated: false, scanned: 0, matched: 0, error: "query-too-long" }`.

### 2.3 New: `getCspViolations`

```ts
getCspViolations: { params: {}; response: CspViolation[] };
```

Used by the renderer to surface CSP violations during dev. Hidden in prod builds.

## 3. M3 Deltas (multi-format editor)

### 3.1 Open with intent

`readFile` gets an optional `intent`:

```ts
readFile: { params: { path: string; intent?: "view" | "edit" }; response: FilePayload };
```

### 3.2 Save / autosave

```ts
saveFile: { params: { path: string; content: string; encoding?: "utf-8" }; response: { ok: boolean; savedAt?: number; error?: string } };
```

Autosave is signal-only via the `autosaveTick` message (no content carried; renderer keeps content):

```ts
messages: {
  autosaveTick: { tabId: string; path: string; contentHash: string; bytes: number };
}
```

### 3.3 Format detection

`detectFormat: { params: { path: string }; response: { format: string; confidence: number } }`

Detects markdown / plain-text / json / yaml / toml from extension + content sniff. Confidence ≥ 0.8 = auto; < 0.8 = ask user.

### 3.4 New webview messages

```ts
webview: {
  messages: {
    ...existing...,
    tabClosed:     { tabId: string };
    tabSaved:      { tabId: string; path: string; savedAt: number };
    tabFormatChanged: { tabId: string; format: string };
  };
}
```

## 4. Versioning Strategy

The RPC contract is in-process and ships in a single .app bundle — both ends always at the same version. No backward-compat is needed in production. However:

- Use **discriminated-union response types** (e.g. `ImageResolveResult` above) so adding new error cases is forward-compatible.
- Use **optional request fields** (e.g. `intent?` for `readFile`) so older renderers can call newer handlers safely.
- Document any breaking change in `28-modernization-architecture-decisions.md` as a new ADR.

## 5. Error Shape

All RPC error responses use one of these shapes:

```ts
// Boolean ok pattern (most current handlers)
{ ok: true } | { ok: false; error?: string }

// Discriminated-union pattern (M1 onward, preferred)
{ dataUrl: string } | { error: "..."; ...details }
```

New handlers SHOULD use the discriminated-union pattern. Existing handlers keep their shape unless modernized.

## 6. Authorization

n/a — the renderer and bun both run in the same .app bundle as the same OS user. There is no cross-tenant or cross-user surface. RPC is implicitly authorized by process identity.

## 7. Rate Limiting

Not applicable in process-local IPC. Folder search is bounded by file-count / file-size / hit-count caps in the bun handler (BR-005).

## 8. Documentation Source-of-Truth

`src/shared/rpc.ts` is the canonical source. This document is human-readable narrative; if the two diverge, the .ts file wins.
