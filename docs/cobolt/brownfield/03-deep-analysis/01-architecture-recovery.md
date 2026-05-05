---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/13-architecture-recovery.md
pipeline: brownfield
topic: 03-deep-analysis
title: "Architecture Recovery"
order: 1
audiences: ["architect", "build-agent"]
source_sha256: 820bfe2950dd9b0077b7515fe4c8c9011c4070e189efbddc0eeae67525710d95
source_size: 3782
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# 13 — Architecture Recovery

## Recovered C4-style View

### Level 1 — System Context

```
                    +----------------+
                    |     User       |
                    +-------+--------+
                            |
                  Double-click .md file (LaunchServices / Win Shell)
                            |
                            v
                  +---------+----------+
                  |  Markdown Viewer   |
                  |  (.app / .exe)     |
                  +---------+----------+
                            |
                            | reads
                            v
                +-----------+-------------+
                |   Local filesystem      |
                |  (markdown + images)    |
                +-------------------------+
```

### Level 2 — Container

```
+--------------------------------------------------+
|              Markdown Viewer process tree        |
|                                                  |
|  +--------------------+    typed RPC (stdio)    |
|  |   Bun process      | <-----------------+      |
|  |   (main)           |                   |      |
|  |                    |                   v      |
|  |  - File I/O        |    +-----------------+   |
|  |  - File watchers   |    | WebKit/WebView2  |  |
|  |  - Recent.json     |    | view process     |  |
|  |  - Native menus    |    | (mainview)       |  |
|  |  - License gate    |    |                  |  |
|  +--------------------+    | - markdown-it    |  |
|                            | - DOMPurify      |  |
|                            | - mermaid        |  |
|                            | - KaTeX          |  |
|                            | - highlight.js   |  |
|                            +------------------+  |
+--------------------------------------------------+
```

### Level 3 — Component (renderer)

```
+----------------------------------------------+
|              mainview (Electroview)         |
|                                              |
|  index.ts (boot + RPC + UI orchestration)   |
|     |                                        |
|     +-> markdown.ts (buildMarkdown / parse) |
|     |        |                               |
|     |        +-> markdown-it pipeline       |
|     |        +-> alerts plugin              |
|     |        +-> wikilinks plugin           |
|     |        +-> link-open / image hooks    |
|     |                                        |
|     +-> find-in-doc.ts (find controller)   |
|     +-> lightbox.ts (overlay viewer)       |
|     +-> DOMPurify (sanitize)                |
|     +-> mermaid (render)                    |
|     +-> KaTeX (math)                        |
|     +-> highlight.js (code blocks)          |
+----------------------------------------------+
```

## Layer Separation

- `src/shared/rpc.ts` is the only shared module; it defines the cross-process contract.
- `src/bun/` and `src/mainview/` do not import each other (they CAN'T — they run in different processes).
- Within mainview, `markdown.ts` is pure (no DOM access); `index.ts` does all DOM work.

## Coupling

- The renderer holds a reference to the Bun RPC client and uses it from many places. This is fine because it's a single-window app, but a future refactor could thread the client through a small DI seam.

## Recovered Invariants

- The DOMPurify call site is the **single** HTML injection point that takes attacker-controlled content. Any future code path that injects HTML must go through DOMPurify or be re-sanitized.
- Mermaid SVG injection (line 272 of `src/mainview/index.ts`) is currently NOT covered by this invariant — see SEC-001.
- The bun process owns ALL filesystem access. The renderer never reads or writes files except via RPC.

