# Markdown Viewer — Brand Mark Design Spec

**Status:** Implemented — reconciled with disk reality on 2026-05-04
**Date:** 2026-05-04 (concept) · reconciled 2026-05-04
**Owner:** veera@mftlabs.io
**Topic:** Application logo + favicon + native bundle icon

> **Reconciliation note (2026-05-04):** This spec was originally drafted with
> a deep-indigo container gradient. During implementation the design pivoted
> to an **aurora gradient** (teal → blue → fuchsia → rose). This document has
> been rewritten to reflect the aurora as canonical. The mark itself (M+chevron
> geometry, mark gradient, optical centering) is unchanged from the original
> concept. Two original sub-deliverables — `logo-mark.svg` and the CSS
> `--brand-*` token set — are deferred (see §6).

---

## 1. Concept

A bold `M↓` monogram inside a deep super-ellipse ("squircle"), evoking the
markdown file convention while standing apart from the well-known
`markdown-here` black-square `M↓` mark.

The mark itself carries a subtle iridescent gradient (white → pale lilac →
soft cyan) over a vivid **aurora-gradient** squircle (teal → blue → fuchsia →
rose). Personality: **vibrant & expressive** — a deliberate visual signature
that won't be confused with the conservative dark-mark fleet (Linear, Raycast,
Arc) but reads cleanly at all sizes.

**Why this concept wins:**
- Honors the markdown convention (`M` + down-arrow) so it's instantly
  recognizable as a markdown app.
- Differentiates from the dominant `markdown-here` mark via the construction
  (chevron-walled M) **and** the aurora container (vs. flat black).
- Reads cleanly at 16×16 favicon size — the silhouette is a single bold glyph;
  the mark gradient (light) has strong contrast against any aurora hue.
- The aurora hue rotation creates an iridescent feel that holds up in dock
  rows, taskbars, and Start Menu without going faddish.

---

## 2. Visual specification

### 2.1 Canvas
- Master file: `assets/brand/MarkDownViewerLogo.svg`
- viewBox: `0 0 1024 1024` (square)
- All coordinates below are in this 1024-unit space.

### 2.2 Container — squircle (aurora gradient)
- Shape: rounded rectangle, `x=0 y=0 w=1024 h=1024`, `rx = ry = 232`
  (approximates iOS super-ellipse curvature at this scale).
- Fill: linear gradient `gradContainer`
  - Direction: 8% → 92% on x, 0% → 100% on y (≈ 135° top-left → bottom-right)
  - Stop 0%: `#0F766E` (teal-700)
  - Stop 34%: `#2563EB` (blue-600)
  - Stop 68%: `#A21CAF` (fuchsia-700)
  - Stop 100%: `#E11D48` (rose-600)
- Inner top highlight: 1.5px stroke at `x=0.75 y=0.75 w=1022.5 h=1022.5`,
  filled with the `gradHighlight` gradient (white at 16% opacity at the top
  fading to 0 at 40% down). Adds a soft dimensional ridge at the top edge.
- Inner bottom shadow: 2px stroke at `x=1 y=1 w=1022 h=1022`, filled with the
  `gradShadow` gradient (transparent above 75%, fading to slate-900 at 28%
  opacity at the bottom). Grounds the icon visually.

> The original spec described the highlight/shadow as masked rectangles. The
> implemented form uses gradient-filled stroke rectangles, which is cleaner
> SVG with identical visual result.

### 2.3 Mark — the `M↓`
Constructed as a single stroked `M` plus a separate downward-arrow descender.

- Stroke: **92 units**
- `stroke-linecap="square"`
- `stroke-linejoin="miter"`, `stroke-miterlimit="10"`
- Fill / stroke color: linear gradient `gradMark`
  - Direction: vertical (top → bottom)
  - Stop 0%: `#FFFFFF`
  - Stop 55%: `#E8E2FF` (pale lilac)
  - Stop 100%: `#D6F4F0` (pale cyan)

### 2.4 Geometry

**The M** — single stroked path:
```
M 240 700  L 240 280  L 512 580  L 784 280  L 784 700
```

**The descender chevron** — centered below the M:
- V-chevron: `M 408 760 L 512 880 L 616 760` (stroke 92, square cap, miter
  join, miterlimit 10)

A single V-chevron (no separate shaft) keeps the geometry crisp and avoids
visual overlap with the bottom of the M legs (square stroke caps on the M
legs extend to ~y=746; the chevron's top sits at ~y=714 with ~30 units of
clean separation). The chevron also echoes the M's central V — a quiet
visual rhyme.

**Optical centering:** The whole mark group (M + chevron) is wrapped in
`<g transform="translate(0, -24)">` to shift it 24 units up — the original
spec recommended a 24–32 unit upward shift to compensate for the descender
making the glyph feel bottom-heavy at small sizes. 24 was the implemented
value.

### 2.5 Color tokens — DEFERRED

The original spec exposed `--brand-ink`, `--brand-paper`, `--brand-lilac`,
`--brand-cyan` as CSS custom properties for app-wide consumption. That
deliverable is **deferred** for two reasons:

1. The aurora container has four stops, not the two-color palette the
   original tokens assumed — porting to CSS would require a new token shape.
2. No app surface currently consumes the would-be tokens; the brand mark
   ships as an icon set, not a theming surface.

When CSS theming is needed, design new tokens against the implemented aurora
palette in a separate spec.

---

## 3. Deliverables — implementation status

All assets generated from the single source-of-truth SVG.

### 3.1 Source

| File | Status |
|---|---|
| `assets/brand/MarkDownViewerLogo.svg` | ✅ implemented (filename differs from original `logo.svg` — the implemented filename is canonical) |
| `assets/brand/logo-mark.svg` | ⏸ deferred (no consumer yet — see §6) |

### 3.2 Generated rasters

All committed to the repo so end users can build the app without running the
generation script.

| File | Status |
|---|---|
| `assets/brand/icon-16.png` | ✅ |
| `assets/brand/icon-32.png` | ✅ |
| `assets/brand/icon-48.png` | ✅ |
| `assets/brand/icon-64.png` | ✅ (added during implementation, not in original spec) |
| `assets/brand/icon-128.png` | ✅ |
| `assets/brand/icon-180.png` (Apple touch icon) | ✅ |
| `assets/brand/icon-192.png` | ✅ |
| `assets/brand/icon-256.png` | ✅ |
| `assets/brand/icon-512.png` | ✅ |
| `assets/brand/icon-1024.png` | ✅ |

### 3.3 Generated containers

| File | Status |
|---|---|
| `assets/brand/favicon.ico` (multi-resolution 16/32/48) | ✅ |
| `assets/brand/AppIcon.ico` (multi-resolution 16/32/48/64/128/256) | ✅ |
| `assets/brand/icon.icns` (macOS bundle, 16/32/64/128/256/512/1024) | ✅ |

### 3.4 Generation script

| Item | Status |
|---|---|
| `scripts/gen-icons.ts` — Bun script using `@resvg/resvg-js` + `png2icons` | ✅ |
| `package.json` `gen:icons` script | ✅ |
| `package.json` devDeps (`@resvg/resvg-js`, `png2icons`) | ✅ |

---

## 4. Wiring — implementation status

### 4.1 Web view favicon
✅ Wired into `src/mainview/index.html`:
```html
<link rel="icon" type="image/svg+xml" href="brand/MarkDownViewerLogo.svg">
<link rel="icon" type="image/png" sizes="32x32" href="brand/icon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="brand/icon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="brand/icon-180.png">
```

### 4.2 Asset copy (Electrobun build)
✅ Wired into `electrobun.config.ts` `build.copy`:
```ts
"assets/brand/MarkDownViewerLogo.svg": "views/mainview/brand/MarkDownViewerLogo.svg",
"assets/brand/icon-16.png":  "views/mainview/brand/icon-16.png",
"assets/brand/icon-32.png":  "views/mainview/brand/icon-32.png",
"assets/brand/icon-180.png": "views/mainview/brand/icon-180.png",
```

### 4.3 macOS bundle icon
✅ `app.icon = "assets/brand/icon.icns"` set in `electrobun.config.ts`.

✅ Postwrap fallback also implemented in `scripts/postwrap.ts` (since
Electrobun's beta does not always honor `app.icon`):
1. Copy `assets/brand/icon.icns` into `<App>.app/Contents/Resources/AppIcon.icns`.
2. Run `plutil -replace CFBundleIconFile -string AppIcon` against
   `<App>.app/Contents/Info.plist`.
3. Idempotent — runs on every postwrap.

### 4.4 Windows install / setup icon
✅ `windows/MarkdownViewerSetup.iss`:
- `#define MyAppIcon "..\assets\brand\AppIcon.ico"`
- `SetupIconFile = {#MyAppIcon}`
- `UninstallDisplayIcon = {app}\AppIcon.ico`
- Source-copied into `{app}` on install
- Used by Start Menu / Desktop shortcuts (`IconFilename`)
- Used by `.md` file-type `DefaultIcon` registration

✅ `scripts/install-windows.ps1`:
- Copies `assets\brand\AppIcon.ico` into install dir
- Falls back to `.exe`-embedded icon when `AppIcon.ico` is missing
- File-type registration uses `$installedIcon` for `DefaultIcon`

### 4.5 README hero
✅ `<img src="assets/brand/MarkDownViewerLogo.svg" width="120" height="120" alt="Markdown Viewer logo">` rendered inside the centered `<div align="center">` block at the top of `README.md`. Width/height is 120 (the original spec suggested 96; 120 was the implemented value and reads better at the README's typical line height).

---

## 5. What's left

The brand mark is **functionally complete** but not yet committed to source
control. The remaining work:

| # | Item | Notes |
|---|---|---|
| 1 | Commit `assets/brand/*` (16 files) and `scripts/gen-icons.ts` | All currently untracked. Spec §3 explicitly says "committed (not gitignored) so cloning works without `bun run gen:icons`". |
| 2 | Commit the brand-related portions of `M` files (`package.json`, `index.html`, `electrobun.config.ts`, `scripts/postwrap.ts`, `windows/MarkdownViewerSetup.iss`, `scripts/install-windows.ps1`, `README.md`) | These files have brand-mark wiring **interleaved** with other in-flight work. The owner needs to decide whether to commit them as one big "brand mark" commit, split them per file, or commit alongside their other in-flight changes. |
| 3 | Visual smoke once committed | Run `bun run start`, confirm favicon in dev window; build a release `.app` and `.exe`, confirm icons appear in Finder / Start Menu / Explorer file-type registration. |

These are tracked in the implementation plan companion document
(`docs/superpowers/plans/2026-05-04-brand-mark-commits.md`).

---

## 6. Out of scope (deferred)

| Item | Why deferred |
|---|---|
| `assets/brand/logo-mark.svg` (mark-only, no squircle) | No consumer on disk today. YAGNI — author when a hero row or inline-on-light usage actually appears. |
| CSS `--brand-*` tokens (`--brand-ink`, `--brand-paper`, `--brand-lilac`, `--brand-cyan`, etc.) | Aurora has 4 stops, original token shape was 2-color; no app surface consumes them yet. Address in a future "design tokens" spec, decoupled from the icon set. |
| Custom-typography wordmark variant | Future. |
| Animated / Lottie variant for landing page | Future. |
| Light-on-light favicon variant | Aurora reads cleanly on both light and dark browser chrome — not needed. |
| Linux `.desktop` icon set | Deferred until Linux build lands per existing README roadmap. |
| Code-signed `.icns` and signed installer icons | Deferred until macOS notarization work begins (also on README roadmap). |

---

## 7. Reconciliation log

| What changed during implementation | Reflected here? |
|---|---|
| Container gradient: indigo→ink → **aurora teal/blue/fuchsia/rose** | ✅ §1, §2.2 rewritten |
| Highlight/shadow: masked rects → **gradient-filled stroke rects** | ✅ §2.2 note |
| Filename: `logo.svg` → `MarkDownViewerLogo.svg` | ✅ §2.1, §3.1, §4.1, §4.2, §4.5 updated |
| Optical shift: "24–32" → **24** (implemented) | ✅ §2.4 |
| Added `icon-64.png` (not in original spec) | ✅ §3.2 |
| README hero: 96×96 → **120×120** | ✅ §4.5 |
| Postwrap icon install: noted as "may need" → **already implemented** | ✅ §4.3 |
| `logo-mark.svg`, CSS tokens | ⏸ deferred — moved to §6 |
