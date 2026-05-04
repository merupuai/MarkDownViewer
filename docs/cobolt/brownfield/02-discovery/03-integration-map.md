---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/06-integration-map.md
pipeline: brownfield
topic: 02-discovery
title: "Integration Map"
order: 3
audiences: ["architect", "security", "build-agent"]
source_sha256: 8a53ceaaeb9811122d2aabd564b36b3f5f808012d9e1b81e1afdb627b4bf3059
source_size: 4639
published_at: 2026-05-04T14:36:58.135Z
published_by: cobolt-publish-docs
---

# Integration Map — MarkDownViewer

**Verdict**: ZERO REMOTE INTEGRATIONS. The application makes no outbound HTTP, no database connections, no message queue calls, no webhooks, no scheduled batch jobs.

## Network Egress Surface

| Channel | Inventory | Notes |
|---|---|---|
| Outbound HTTP | None observed in source | No `fetch()` / `XMLHttpRequest` / `axios` / `https.request` outside markdown-it's `linkify` (which only parses, never fetches) |
| WebSockets | None | No `new WebSocket(...)` |
| Message queues | None | |
| gRPC / SOAP | None | |
| Email (SMTP/IMAP) | None | |
| FTP / S3 / shared drives | None | |
| Database links | None | |
| Webhooks (consumer) | None | |
| Scheduled jobs (cron / systemd / Task Scheduler) | None | |

## OS-Process Spawns (out-of-process integrations)

These are **local OS process integrations**, not network integrations. Inventory:

| Caller | Command | Purpose | File:Line |
|---|---|---|---|
| `showLicenseInfo` (mac) | `osascript -e <display dialog ...>` | Native EULA / about dialog | `src/bun/index.ts:94` |
| `showLicenseInfo` (win) | `powershell -NoProfile -NonInteractive -Command <Add-Type System.Windows.Forms.MessageBox ...>` | Native EULA dialog (only when Inno installer didn't pre-drop marker) | `src/bun/index.ts:104` |
| `showLicenseInfo` (linux) | `zenity --info ...` then fallback `kdialog --msgbox ...` | Native EULA dialog | `src/bun/index.ts:108-115` |
| `showEulaDialog` | Same per-OS spawns | First-run EULA accept | `src/bun/index.ts:118-168` |
| `RPC.openExternal` | win: `cmd /c start "" <url>`, mac/linux: `open <url>` | Open URL in default browser | `src/bun/index.ts:455` |
| `RPC.revealInFinder` | win: `explorer /select,<path>`, mac/linux: `open -R <path>` | Reveal file in OS file manager | `src/bun/index.ts:464-467` |
| Cocoa launcher | `scripts/cocoa-launcher.swift` (built into macOS .app via `wrap-launcher.sh`) | Capture argv and `open-url` events that Electrobun's Zig launcher would otherwise drop | `scripts/cocoa-launcher.swift` |
| postwrap | `cp -f <icon.icns> <Resources>` and `plutil -replace CFBundleIconFile -string AppIcon <Info.plist>` | Patch Info.plist post-build (Electrobun beta does not honor `app.icon`) | `scripts/postwrap.ts:54, 62` |
| Argv recovery | Reads `/tmp/mdv-pending-url-<pid>` written by Cocoa wrapper | Recover initial file path from launcher | `src/bun/index.ts:541-552` |

## Inbound Integration Surface

The app receives external input through three channels:

| Channel | Source | Format | Trust |
|---|---|---|---|
| Bun.argv | Direct invocation (e.g. `markdown-viewer foo.md`) | Path strings | Trusted (user-controlled CLI) |
| `MV_PENDING_URL` env var | Cocoa launcher wrapper sets this on macOS | URL string (file:// or path) | Trusted (set by sibling process in same app bundle) |
| `/tmp/mdv-pending-url-<pid>` file | Cocoa launcher wrapper writes; main process reads then `unlinkSync` | URL string | Trusted (filesystem ACL inside `/tmp`); unlinkSync fails silently if process can't delete |
| Electrobun `open-url` event | LaunchServices on macOS (first-launch only) | URL string | Trusted (OS-mediated) |
| Drag-and-drop | DOM `drop` event on window (renderer process) | `File` object with optional `.path` extension; otherwise reads as text | Trusted to the extent the user dragged the file in |
| File-association launches | LaunchServices (mac), Inno Setup `OpenWithList`+`shell\open\command` (win) | argv | Trusted (OS-mediated) |

## File-Type Associations

Configured in `electrobun.config.ts:13-19`:

```ts
fileAssociations: [
  { ext: ["md","markdown","mdown","mkd","mkdn","mdx"],
    name: "Markdown Document",
    role: "Viewer" }
]
```

Windows installer (`windows/MarkdownViewerSetup.iss`) registers the same extension set under `HKCR\<ext>\OpenWithProgids` and registers the program ID under `HKCR\MarkdownViewer.Document`.

## RPC (in-process IPC, not network)

The Electrobun typed RPC in `src/shared/rpc.ts` is the only IPC. It is not exposed beyond the process tree of the .app bundle; transport is stdio between Bun and the WebKit/WebView2 view process spawned by Electrobun.

## Verdict on Integration Risk

- **Supply chain** is the only meaningful external dependency: 14 npm dependencies (markdown-it ecosystem, mermaid, katex, highlight.js, dompurify, gray-matter, electrobun, svg-pan-zoom). See `09-supply-chain-and-vulnerability-review.md`.
- **No network attack surface** — the app cannot be reached over any network, ever.
- **Local content threat surface** — a hostile markdown file is the realistic threat vector (see `12-security-and-quality-assessment.md` § Threat Model).
