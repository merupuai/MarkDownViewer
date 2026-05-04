---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/03b-project-knowledge-base.md
pipeline: brownfield
topic: 01-intake
title: "Project Knowledge Base"
order: 5
audiences: ["architect", "delivery-lead", "stakeholder"]
source_sha256: e94629bac121a4e2015f926519b3df98ce60a85cef5acd5218973fe938990149
source_size: 2030
published_at: 2026-05-04T14:36:58.135Z
published_by: cobolt-publish-docs
---

# 03b — Project Knowledge Base

## Tech Stack Specifics

- **Bun** is the JavaScript runtime (not Node). Use `Bun.file`, `Bun.spawn`, `Bun.write`, `Bun.env` instead of `fs` / `child_process` / `process.env` where Bun has a typed wrapper.
- **Electrobun** is in beta (1.17.3-beta.12). Some workarounds are in place: `scripts/cocoa-launcher.swift` recovers argv that Electrobun's Zig launcher otherwise drops; `scripts/postwrap.ts` patches Info.plist's CFBundleIconFile because Electrobun's beta does not honor `app.icon`.
- **DOMPurify** is loaded via `isomorphic-dompurify` so the same sanitizer can run in both the renderer (real DOM) and any future server-side / CLI mode.

## Pitfalls

- `Bun.argv` does not include the file path the user double-clicked on macOS unless the app already running. The Cocoa launcher captures argv on the launcher process and forwards via env / temp file.
- `/tmp` does not exist on Windows. The bun debug log path is hardcoded to `/tmp/mdv-bun.log`; on Windows the appendFileSync silently fails — see SEC-005.
- `fs.watch` is unreliable on network filesystems; consider polling fallback for ENH-009.
- Mermaid `securityLevel: "loose"` allows HTML in diagrams. The SVG output is NOT re-sanitized by DOMPurify before injection — see SEC-001.
- `gray-matter` v4 uses js-yaml SAFE_SCHEMA by default; this is correct and safe (no `!!js/function` execution).

## Build / Distribution

- macOS .app bundle is produced by `electrobun build` then post-processed by `scripts/wrap-launcher.sh` (Cocoa wrapper) and `scripts/postwrap.ts` (icon).
- Windows installer is built by Inno Setup (`windows/MarkdownViewerSetup.iss`).
- No Linux package yet (.deb / .AppImage / Flatpak) — opportunity for ENH-021 sibling.

## License Posture

- The `MIT (Non-Resale Variant)` license bans bundling-for-fee but allows modification and redistribution.
- DOMPurify is MPL-2.0; needs THIRD_PARTY_LICENSES.md attribution in distribution (DEBT-002 / MOD-008).
- All other deps are MIT or BSD-3-Clause (compatible).

