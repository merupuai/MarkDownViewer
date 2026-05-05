---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/03a-domain-knowledge-base.md
pipeline: brownfield
topic: 01-intake
title: "Domain Knowledge Base"
order: 4
audiences: ["architect", "delivery-lead", "stakeholder"]
source_sha256: 774fac2c08cfc03cea41d7b77e8bdd5bbab38e867e81d043f2f5cb4a639184ba
source_size: 1664
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# 03a — Domain Knowledge Base

## Domain: Markdown rendering

| Concept | Definition |
|---|---|
| CommonMark | Standardized subset of markdown that markdown-it implements |
| GFM (GitHub Flavored Markdown) | Extension over CommonMark: tables, task lists, autolinks, strikethrough, alerts |
| Front-matter | Optional YAML/TOML/JSON header delimited by `---` at the top of a document |
| KaTeX | Inline & display math: `$x^2$` / `$$ ... $$` |
| Mermaid | Graph-as-code (flowchart / sequence / class / state / gantt) compiled to SVG |
| Wikilink | `[[Target]]` or `[[Target|Alias]]` syntax for cross-document links |
| GFM Alert | `> [!NOTE]` / `[!TIP]` / `[!IMPORTANT]` / `[!WARNING]` / `[!CAUTION]` |

## Domain: Native desktop runtime

| Concept | Definition |
|---|---|
| Electrobun | Bun-based desktop runtime, alternative to Electron; smaller bundle, no Chromium |
| WebKit (mac) / WebView2 (win) | Embedded browser engine |
| LaunchServices | macOS subsystem that handles file-association launches |
| Inno Setup | Windows installer toolchain used here for code-signed-installer + EULA click-through |
| .icns / .ico | macOS / Windows icon container formats |
| CFBundleIconFile | macOS Info.plist key for app bundle icon |

## Threat model vocabulary

| Concept | Definition |
|---|---|
| Hostile content | A markdown file received from an untrusted source that may contain XSS, exfil, or path traversal vectors |
| DOMPurify | HTML sanitizer; the security trust boundary in this app |
| CSP | Content Security Policy — defense-in-depth network policy in the renderer |
| Path containment | Verifying `resolve(base, user-input)` is still under `base` |

