# CSS Compat Fixes — Design Spec

**Date:** 2026-05-04
**Status:** Approved — ready for implementation
**Owner:** veera@mftlabs.io
**Topic:** Resolve Edge Tools `compat-api/css` diagnostics in `src/mainview/index.css`

---

## 1. Problem

The IDE flags ten `compat-api/css` issues against
[`src/mainview/index.css`](../../../src/mainview/index.css):

- **4 errors** (severity 8) — vendor-prefixed properties missing for Safari /
  Safari iOS:
  - `user-select` at lines 113, 283
  - `backdrop-filter` at lines 712, 763
- **6 warnings** (severity 4) — `-webkit-app-region` is unsupported in Firefox
  and Safari at lines 112, 120, 128, 131, 138, 403.

These appear in the IDE diagnostics panel and are noise during day-to-day
editing.

## 2. Background — runtime context

Markdown Viewer is an **Electrobun** desktop app. Electrobun renders via the
host platform's web view:

| Platform | Web view | `-webkit-app-region` | `backdrop-filter` | `user-select` |
|---|---|---|---|---|
| Windows | WebView2 (Chromium) | supported | supported | supported |
| macOS | WKWebView | not used by us — custom titlebar is hidden on macOS (see `index.css:148+`); native traffic lights take over | needs `-webkit-` prefix | needs `-webkit-` prefix |
| Linux | not yet shipped | n/a | n/a | n/a |

So the practical compat surface is **Chromium + WKWebView**, not the full
browser matrix the Edge Tools hint set assumes.

## 3. Decisions

### 3.1 Errors → fix with vendor prefixes

For each of the four error sites, prepend the `-webkit-`-prefixed variant
**before** the standard property. Cascade order matters: prefix first so newer
browsers prefer the unprefixed standard.

| Line | Before | After |
|---|---|---|
| 113 (`.titlebar`) | `user-select: none;` | `-webkit-user-select: none;`<br>`user-select: none;` |
| 283 (`.tree-node`) | `… user-select: none; }` (single-line rule) | `… -webkit-user-select: none; user-select: none; }` — keep the rule single-line; insert the prefixed declaration immediately before the unprefixed one |
| 712 (`.dropzone`) | `backdrop-filter: blur(4px);` | `-webkit-backdrop-filter: blur(4px);`<br>`backdrop-filter: blur(4px);` |
| 763 (`.lightbox`) | `backdrop-filter: blur(6px);` | `-webkit-backdrop-filter: blur(6px);`<br>`backdrop-filter: blur(6px);` |

### 3.2 Warnings → suppress via project-level `.hintrc`

`-webkit-app-region` is a Chromium-only property by design — it's how
draggable native title bars work in WebView2-class shells. The Firefox/Safari
warnings are not actionable in this codebase.

Add `.hintrc` at the project root:

```jsonc
{
  "extends": ["development"],
  "hints": {
    "compat-api/css": ["default", {
      "ignore": ["-webkit-app-region"]
    }]
  }
}
```

This silences the six warnings *globally* for that property without scattering
inline disable-comments through the CSS, and without weakening compat checks
for any other property.

### 3.3 What we explicitly do NOT do

- **Do not** add `-webkit-app-region` polyfill or any cross-browser shim — the
  property has no equivalent in Firefox/Safari and we don't need one because
  we don't run there.
- **Do not** restructure adjacent CSS rules to "clean up" while in here. Stay
  surgical.
- **Do not** add a PostCSS autoprefixer pipeline. The project ships hand-
  written CSS today and adding a build step for four prefixes is over-
  engineering.

## 4. Files touched

| File | Change |
|---|---|
| `src/mainview/index.css` | 4 prefix additions (lines 113, 283, 712, 763) |
| `.hintrc` (new) | webhint config to ignore `-webkit-app-region` |

No other source files are modified.

## 5. Verification

1. **IDE diagnostics:** reopen `src/mainview/index.css` after the edits land.
   Expected: zero `compat-api/css` errors, zero `-webkit-app-region` warnings.
2. **Visual smoke:** `bun run start`. Verify in the dev window that the
   following still work:
   - Title bar dragging on Windows (`-webkit-app-region: drag`).
   - Title bar control buttons (Min / Max / Close) still receive clicks
     (`-webkit-app-region: no-drag`).
   - Drag-drop overlay shows blur backdrop (`.dropzone`).
   - Image lightbox shows blur backdrop (`.lightbox`).
   - Sidebar tree rows do not select text on click (`.tree-node`).
3. **No layout shift:** the prefixes are *additions*, not changes — visual
   regressions are extremely unlikely, but a quick eye-pass is worth doing.

## 6. Out of scope

- Stylelint / autoprefixer integration.
- A broader audit of `index.css` for other compat issues beyond what Edge
  Tools currently flags.
- Linux build CSS work (deferred per the README roadmap).
