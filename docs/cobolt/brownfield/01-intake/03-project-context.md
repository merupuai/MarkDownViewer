---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/03-project-context.md
pipeline: brownfield
topic: 01-intake
title: "Project Context"
order: 3
audiences: ["architect", "delivery-lead", "stakeholder"]
source_sha256: 95f9e81d4d00026a7b3df9f10a68254cb233dcc3b61813a2115f10ff66e99bff
source_size: 834
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# 03 — Project Context

MarkDownViewer is a single-purpose desktop application that ships as a native binary on macOS, Windows, and Linux. It opens .md files (and aliases .markdown / .mdown / .mkd / .mkdn / .mdx) and renders them with markdown-it + DOMPurify + mermaid + KaTeX + highlight.js.

Architecture: two-process Electrobun model — `bun` (main) for file I/O, RPC dispatch, native menus, and `mainview` (WebKit/WebView2) for rendering. The contract between the two is `src/shared/rpc.ts`.

Operating model: single-window, single-document at a time. Sidebar tabs for Files / Search / Recent / Outline. No persistent state beyond a 20-entry `recent.json` and an EULA acceptance marker.

In-flight: a multi-format editor expansion is under planning (Notepad++-class editing). The viewer will become the renderer of an editor.

