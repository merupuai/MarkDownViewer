---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/24-modernization-prd.md
pipeline: brownfield
topic: 06-target-state
title: "Modernization PRD"
order: 1
audiences: ["architect", "security", "build-agent"]
source_sha256: b8407c87dce5431019cb6590996bef398e6d12bd9f2411f757eb186e8a05af4f
source_size: 5453
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# Modernization PRD — MarkDownViewer

**Status**: Ready for review
**Source assessment**: `23-master-assessment.md`
**Scope verdict**: forward-invest (no replatform)

## 1. Vision

Markdown Viewer is a fast, native, file-association-driven markdown reader that becomes the user's default `.md` handler on macOS, Windows, and Linux. Modernization keeps that identity and adds (a) a defensible security posture against hostile content, (b) a public-distribution path with code signing, (c) a foundational test suite, and (d) the in-flight multi-format editor that was already planned.

## 2. Stakeholders

| Role | Identity |
|---|---|
| Copyright holder | MFTLabs |
| Developer | CoBolt |
| Primary user | Knowledge-worker / developer browsing local markdown vaults (Obsidian-adjacent, Notes-adjacent) |
| Distributors | Direct download (signed installer / .app bundle) |

## 3. Functional Requirements

| ID | Requirement | Acceptance |
|---|---|---|
| FR-01 | The application MUST render any well-formed markdown file the OS user can read, with mermaid, KaTeX, GFM alerts, wikilinks, and code highlighting. | Existing test corpus passes; no regressions vs. baseline. |
| FR-02 | The application MUST sanitize markdown-derived HTML through DOMPurify before injecting it into the renderer DOM. | Inspect render path; verify SanitizeBoundary invariant in `13-architecture-recovery.md`. |
| FR-03 | The application MUST re-sanitize mermaid SVG output before injecting it into the DOM. *(Closes SEC-001 / MOD-001.)* | Hostile-mermaid fixture in test corpus fails to inject HTML. |
| FR-04 | The application MUST reject image src that resolves outside the document's directory (or a configured allowlist). *(Closes SEC-002 / MOD-002.)* | Hostile-image-src fixture: `![](../../.ssh/id_rsa)` returns `error: out-of-bounds`. |
| FR-05 | The application MUST scope DOMPurify's `style` attribute to a CSS allowlist that prohibits `url()` and `@import`. *(Closes SEC-003 / MOD-003.)* | Hostile-CSS fixture: `<p style="background:url(...)">` is stripped. |
| FR-06 | The renderer MUST set a Content Security Policy that blocks all network egress (`connect-src 'none'`), frames, and external scripts. *(Closes SEC-007 / MOD-006.)* | CSP meta tag present; CSP-violation log clean for the test corpus. |
| FR-07 | The application MUST emit a clear error affordance when YAML front-matter parsing fails, instead of silently dropping the document. *(Closes SEC-004 / MOD-004.)* | Malformed-front-matter fixture: front-matter card shows "Parse error: …". |
| FR-08 | The application MUST persist its debug log at `os.tmpdir() / mdv-bun.log` and rotate at 10 MB. *(Closes SEC-005 / MOD-005.)* | On Windows, log appears in `%TEMP%`. Log file size never exceeds 10 MB. |
| FR-09 | The Windows installer and macOS .app bundle MUST be code-signed and (macOS) notarized. *(Closes ENH-020 / ENH-021.)* | SmartScreen no longer warns; Gatekeeper accepts. |
| FR-10 | The distribution MUST include a `THIRD_PARTY_LICENSES.md` reachable from `Help → License…`. *(Closes DEBT-002 / MOD-008.)* | New menu item; file present in app bundle. |
| FR-11 | CI MUST run a dependency vulnerability scan (OSV or `bun audit`) on every PR. *(Closes SCA-002 / MOD-009.)* | New CI workflow step; non-zero CVE count fails the build. |
| FR-12 | A Playwright domain test suite MUST exist with at least: (a) golden-render fixtures for mermaid+KaTeX+alerts+wikilinks; (b) hostile-content fixtures for SEC-001..007. *(Closes ENH-014 / ENH-015.)* | Playwright suite passes; coverage on rendered DOM ≥ 80% of UI surface. |
| FR-13 | The application MUST gain a multi-format editor (Notepad++-class) that allows editing markdown and other text formats in tabbed views. | Per-tab editor state; save flushes to disk; existing rendering pipeline reused for preview. |

## 4. Non-functional Requirements

| ID | NFR |
|---|---|
| NFR-01 | A 50 KB markdown document with 20 mermaid blocks renders in ≤ 1.5 s on M1 / Ryzen 5 hardware. |
| NFR-02 | Theme toggle on a 50 KB document completes in ≤ 200 ms (NEW: cached parse tree, MOD-007). |
| NFR-03 | Memory footprint ≤ 250 MB resident with 5 documents in Recent and a 1000-file folder open. |
| NFR-04 | The application MUST NOT make ANY outbound network request unless the user explicitly invokes "Check for updates" (ENH-018, deferred). |
| NFR-05 | All security findings of severity ≥ medium MUST close before public distribution. |
| NFR-06 | License attribution MUST be visible from `Help → License…`. |

## 5. Out of scope

- Cloud sync of recent / preferences
- Multi-user / collaborative editing
- Server-side rendering / hosting
- Plugin SDK (deferred beyond modernization)

## 6. Personas

| Persona | Goal | Pain (today) |
|---|---|---|
| **Vivek** — power user, Obsidian-adjacent | Open `.md` files from Finder/Explorer with full mermaid/KaTeX rendering | Currently great; wants editing too |
| **Dana** — developer browsing repo docs | Use viewer as fast read-only mode for repo READMEs | Currently great; wants confidence about hostile content from PR diffs |
| **Sam** — receives `.md` files in email | Double-click and read | Threat model: hostile content; closed by M1 |

## 7. Acceptance Strategy

The modernization PRD is satisfied when:
- All FR-01..13 and NFR-01..06 pass acceptance tests
- 0 high-severity security findings remain open (SEC-001/002/003 closed)
- M1, M2, M3 milestones complete; M4 is post-MVP
