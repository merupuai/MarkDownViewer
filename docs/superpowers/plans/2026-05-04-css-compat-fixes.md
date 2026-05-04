# CSS Compat Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the four `compat-api/css` errors in `src/mainview/index.css` by adding `-webkit-` vendor prefixes for `user-select` and `backdrop-filter`, and silence the six `-webkit-app-region` warnings via a project-level `.hintrc`.

**Architecture:** Two surgical edits — (1) prepend prefixed declarations next to the unprefixed ones at four exact line sites in `src/mainview/index.css`; (2) add `.hintrc` at project root to ignore `-webkit-app-region` from the `compat-api/css` hint set. No new tooling, no PostCSS pipeline, no other files.

**Tech Stack:** Hand-written CSS (no autoprefixer); webhint via Edge Tools VS Code extension.

**Reference:** [Spec — `docs/superpowers/specs/2026-05-04-css-compat-fixes-design.md`](../specs/2026-05-04-css-compat-fixes-design.md)

---

## File Structure

### New files
```
.hintrc                       Webhint config — ignore -webkit-app-region from compat-api/css
```

### Modified files
```
src/mainview/index.css        Four lines gain a -webkit- prefixed sibling declaration
```

### Untouched (deliberately)
```
package.json                  No autoprefixer / postcss dep added
electrobun.config.ts          No build pipeline change
src/mainview/*.ts             No JS/TS touched
```

---

## Verification model — why this plan has no unit tests

Both changes are declarative configuration:
- The CSS prefix additions cannot be unit-tested without spinning up a Safari/WKWebView, which we don't do in CI today.
- The `.hintrc` change is verified by re-running the diagnostics it configures.

So verification is **diagnostic-driven**: re-open the file in the IDE after each task and confirm the expected diagnostic count.

If the IDE-driven verification feels insufficient, the fallback is the **runtime smoke** in Task 6 — actually running the app and verifying the affected styles render correctly.

---

## Phase 0 — Establish baseline

### Task 1: Capture current diagnostic count

**Files:** none changed

- [ ] **Step 1: Open `src/mainview/index.css` in VS Code with Edge Tools active.** Confirm the Problems panel shows exactly:
  - 4 errors (severity 8) — 2 × `user-select` + 2 × `backdrop-filter` Safari/iOS
  - 6 warnings (severity 4) — 6 × `-webkit-app-region` Firefox/Safari

  Expected total: **10 `compat-api/css` issues**.

- [ ] **Step 2: Note baseline.** Record this count in your scratch notes or PR description so you can verify the delta after each fix.

No commit for this task.

---

## Phase 1 — Fix the four Safari errors

### Task 2: Prefix `.titlebar` user-select (line 113)

**Files:**
- Modify: `src/mainview/index.css:112-113`

- [ ] **Step 1: Edit `.titlebar` block.**

  Locate (lines 112-113):
  ```css
  	-webkit-app-region: drag;
  	user-select: none;
  ```

  Replace with:
  ```css
  	-webkit-app-region: drag;
  	-webkit-user-select: none;
  	user-select: none;
  ```

- [ ] **Step 2: Verify diagnostics.** Save the file. Re-open the Problems panel.
  - Expected: error count drops from 4 → 3 (the line-113 `user-select` error is gone).
  - Expected: warning count unchanged at 6.

- [ ] **Step 3: Commit.**

  ```bash
  git add src/mainview/index.css
  git commit -m "fix(css): add -webkit-user-select prefix on .titlebar for Safari/WKWebView"
  ```

---

### Task 3: Prefix `.tree-node` user-select (line 283, single-line rule)

**Files:**
- Modify: `src/mainview/index.css:283`

- [ ] **Step 1: Edit `.tree-node` rule.**

  Locate (line 283 — single-line rule):
  ```css
  .tree-node { font-size: 13px; color: var(--text-muted); user-select: none; }
  ```

  Replace with (still single-line — insert prefixed declaration immediately before the unprefixed one):
  ```css
  .tree-node { font-size: 13px; color: var(--text-muted); -webkit-user-select: none; user-select: none; }
  ```

- [ ] **Step 2: Verify diagnostics.** Save and re-check Problems panel.
  - Expected: error count drops 3 → 2.

- [ ] **Step 3: Commit.**

  ```bash
  git add src/mainview/index.css
  git commit -m "fix(css): add -webkit-user-select prefix on .tree-node for Safari/WKWebView"
  ```

---

### Task 4: Prefix `.dropzone` backdrop-filter (line 712)

**Files:**
- Modify: `src/mainview/index.css:711-712`

- [ ] **Step 1: Edit `.dropzone` block.**

  Locate (lines 711-712):
  ```css
  	background: rgba(9, 105, 218, 0.12);
  	backdrop-filter: blur(4px);
  ```

  Replace with:
  ```css
  	background: rgba(9, 105, 218, 0.12);
  	-webkit-backdrop-filter: blur(4px);
  	backdrop-filter: blur(4px);
  ```

- [ ] **Step 2: Verify diagnostics.** Save and re-check Problems panel.
  - Expected: error count drops 2 → 1.

- [ ] **Step 3: Commit.**

  ```bash
  git add src/mainview/index.css
  git commit -m "fix(css): add -webkit-backdrop-filter prefix on .dropzone for Safari/WKWebView"
  ```

---

### Task 5: Prefix `.lightbox` backdrop-filter (line 763)

**Files:**
- Modify: `src/mainview/index.css:762-763`

- [ ] **Step 1: Edit `.lightbox` block.**

  Locate (lines 762-763):
  ```css
  	background: rgba(0, 0, 0, 0.65);
  	backdrop-filter: blur(6px);
  ```

  Replace with:
  ```css
  	background: rgba(0, 0, 0, 0.65);
  	-webkit-backdrop-filter: blur(6px);
  	backdrop-filter: blur(6px);
  ```

- [ ] **Step 2: Verify diagnostics.** Save and re-check Problems panel.
  - Expected: **error count drops 1 → 0**. All Safari-prefix errors resolved.

- [ ] **Step 3: Commit.**

  ```bash
  git add src/mainview/index.css
  git commit -m "fix(css): add -webkit-backdrop-filter prefix on .lightbox for Safari/WKWebView"
  ```

---

## Phase 2 — Suppress accepted `-webkit-app-region` warnings

### Task 6: Add project-level `.hintrc`

**Files:**
- Create: `.hintrc`

- [ ] **Step 1: Create `.hintrc` at project root with this exact content:**

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

- [ ] **Step 2: Reload the VS Code window** so Edge Tools picks up the new config (`Ctrl+Shift+P → Developer: Reload Window`).

- [ ] **Step 3: Verify diagnostics.** Re-open `src/mainview/index.css` Problems panel.
  - Expected: **0 errors, 0 warnings** for `compat-api/css` against this file.
  - Other hints (if any) may still appear — this config narrowly disables one rule for one property.

- [ ] **Step 4: Commit.**

  ```bash
  git add .hintrc
  git commit -m "chore(hint): ignore -webkit-app-region in compat-api/css

  -webkit-app-region is intentionally Chromium-only — it powers the WebView2
  drag region for the custom titlebar on Windows. Firefox/Safari have no
  equivalent and we do not target them."
  ```

---

## Phase 3 — Runtime smoke

### Task 7: Boot the app and confirm nothing visually regressed

**Files:** none changed

- [ ] **Step 1: Start the dev build.**

  ```bash
  bun run start
  ```

  Expected: Markdown Viewer dev window opens.

- [ ] **Step 2: Verify titlebar drag works.** On Windows: click and drag the empty area of the titlebar — the window should move.

- [ ] **Step 3: Verify titlebar buttons still receive clicks.** Click Min, then click Restore, then hover Close (do not click). All three should respond, proving `-webkit-app-region: no-drag` still works for the controls.

- [ ] **Step 4: Verify drop-zone backdrop blur.** Drag a `.md` file from your file explorer over the window. The drop overlay should appear with a visibly *blurred* background (not just the flat tint).

- [ ] **Step 5: Verify lightbox backdrop blur.** Open a markdown doc with an image (any of the README files works). Click the image — the lightbox should open with a visibly *blurred* background.

- [ ] **Step 6: Verify tree row no-select.** In the sidebar file tree, attempt to drag-select text across a row. Selection should not occur (the rule is doing its job).

- [ ] **Step 7: No commit needed** — this task is verification only.

---

## Phase 4 — Wrap-up

### Task 8: Final sanity check

**Files:** none changed

- [ ] **Step 1: Confirm git log.**

  ```bash
  git log --oneline -7
  ```

  Expected to see (in reverse chronological order):
  - `chore(hint): ignore -webkit-app-region in compat-api/css`
  - `fix(css): add -webkit-backdrop-filter prefix on .lightbox …`
  - `fix(css): add -webkit-backdrop-filter prefix on .dropzone …`
  - `fix(css): add -webkit-user-select prefix on .tree-node …`
  - `fix(css): add -webkit-user-select prefix on .titlebar …`
  - `docs(spec): CSS compat fixes …`
  - (older history below)

- [ ] **Step 2: Confirm working tree is clean.**

  ```bash
  git status --short
  ```

  Expected: no changes from this plan's scope. Pre-existing untracked / modified files (e.g. `assets/`, `scripts/gen-icons.ts`, the brand-mark spec) may still be present from other workstreams — they are **out of scope** for this plan.

- [ ] **Step 3: Confirm IDE diagnostics for `src/mainview/index.css`.** Open the file once more.
  - Expected: zero `compat-api/css` issues. Plan is complete.
