---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/15-feature-triage-matrix.md
pipeline: brownfield
topic: 03-deep-analysis
title: "Feature Triage Matrix"
order: 3
audiences: ["architect", "build-agent"]
source_sha256: 158c0ea56abfd69261949557928d8558dc1c75e2411ee4cd21c57eb187d3fa9a
source_size: 1739
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# 15 — Feature Triage Matrix

Quadrant: Value × Quality. Q1 = high value + low quality (modernize). Q2 = high value + high quality (keep). Q3 = low value + low quality (deprecate). Q4 = low value + high quality (keep but deprioritize).

| Feature | Value | Quality | Quadrant | Action |
|---|---|---|---|---|
| Open file (.md) and render | High | High | Q2 | Keep |
| Mermaid rendering | High | Medium (SEC-001) | Q1 | Modernize — re-sanitize SVG |
| KaTeX math | High | High | Q2 | Keep |
| Code highlight (highlight.js) | High | High | Q2 | Keep |
| GFM alerts | Medium | High | Q4 | Keep |
| Wikilinks (`[[Target]]`) | Medium | High | Q4 | Keep |
| Folder open + tree | High | High | Q2 | Keep |
| Folder search | High | High | Q2 | Keep |
| Find-in-document | High | High | Q2 | Keep |
| Recent files | Medium | High | Q4 | Keep |
| Theme (auto/light/dark) | Medium | High | Q4 | Keep |
| Image rendering (data URL) | High | Medium (SEC-002) | Q1 | Modernize — path containment |
| Lightbox image / mermaid viewer | Medium | High | Q4 | Keep |
| Print | Medium | High | Q4 | Keep |
| Export to HTML | Medium | High | Q4 | Keep |
| Reveal in Finder/Explorer | Medium | High | Q4 | Keep |
| Drag & drop | Medium | High | Q4 | Keep |
| Application menu | Medium | High | Q4 | Keep |
| EULA gate | High (license enforcement) | High | Q2 | Keep |
| File watcher (auto-reload) | High | High | Q2 | Keep |
| Folder watcher | Medium | High | Q4 | Keep |
| /tmp/mdv-bun.log | Low | Low (SEC-005) | Q3 | Modernize — portable path |
| **Multi-format editor (planned)** | High | n/a (not built) | n/a | **Build (M3)** |
| PDF export | Medium | n/a | n/a | Add later (ENH-006) |
| Auto-update | Medium | n/a | n/a | Add later (ENH-018) |

