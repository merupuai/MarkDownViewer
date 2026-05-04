# Brand Mark — Commit & Smoke-Test Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the already-implemented brand mark (SVG, raster set, generation script, all wiring) into source control with clean commit boundaries, then verify it visually on the live build.

**Architecture:** The brand mark is functionally complete in the working tree — only commits + visual smoke remain. Some files are untracked (clean to commit alone); others (`M` files) have brand-mark wiring interleaved with the owner's separate in-flight work and require a per-hunk staging or a deferral until those files settle.

**Tech Stack:** Bun (`bun run gen:icons`, `bun run start`); Inno Setup (`ISCC.exe`); Electrobun build pipeline.

**Reference:** [Spec — `docs/superpowers/specs/2026-05-04-brand-mark-design.md`](../specs/2026-05-04-brand-mark-design.md)

---

## File Structure

### Files to commit (currently untracked — clean)
```
assets/brand/MarkDownViewerLogo.svg     Master 1024×1024 SVG (aurora gradient)
assets/brand/icon-16.png                ┐
assets/brand/icon-32.png                │
assets/brand/icon-48.png                │
assets/brand/icon-64.png                │
assets/brand/icon-128.png               │  Generated raster set
assets/brand/icon-180.png               │  (from `bun run gen:icons`)
assets/brand/icon-192.png               │
assets/brand/icon-256.png               │
assets/brand/icon-512.png               │
assets/brand/icon-1024.png              ┘
assets/brand/favicon.ico                Multi-res 16/32/48 (browser tab)
assets/brand/AppIcon.ico                Multi-res 16/32/48/64/128/256 (Windows app)
assets/brand/icon.icns                  macOS bundle icon (16/32/64/128/256/512/1024)
scripts/gen-icons.ts                    Generation script (Resvg + png2icons)
```

### Files with interleaved in-flight work (DEFER)
```
package.json                            gen:icons script + brand devDeps INTERLEAVED
src/mainview/index.html                 favicon HTML INTERLEAVED with other UI work
electrobun.config.ts                    app.icon + asset copy INTERLEAVED
scripts/postwrap.ts                     macOS bundle icon install INTERLEAVED
scripts/install-windows.ps1             AppIcon.ico copy INTERLEAVED
windows/MarkdownViewerSetup.iss         Inno Setup icon wiring INTERLEAVED
README.md                               Hero img tag INTERLEAVED
```

These files are flagged `M` in `git status` and contain brand-mark code mixed
with the owner's separate in-flight work. The plan **defers** committing them
in this session — see Phase 3.

### Out of scope for this plan
```
assets/brand/logo-mark.svg              Deferred per spec §6
CSS --brand-* tokens                    Deferred per spec §6 (separate spec needed)
scripts/gen-licenses.ts                 Untracked but unrelated to brand mark
.codex/, .stitch/, _cobolt-docker/      Untracked but unrelated
```

---

## Phase 1 — Commit the untracked brand assets

### Task 1: Verify the SVG file is present and matches spec geometry

**Files:** none changed

- [ ] **Step 1:** Confirm the file exists.

  ```bash
  ls -la assets/brand/MarkDownViewerLogo.svg
  ```

  Expected: file present, non-zero size.

- [ ] **Step 2:** Spot-check the geometry matches spec §2.4. Open the file and verify:
  - `viewBox="0 0 1024 1024"` is present
  - `<rect ... rx="232" ry="232" fill="url(#gradContainer)" />` is present
  - The M path is exactly `M 240 700 L 240 280 L 512 580 L 784 280 L 784 700`
  - The chevron path is exactly `M 408 760 L 512 880 L 616 760`
  - The mark group has `transform="translate(0, -24)"`

  No commit for this task — it's a sanity check only.

---

### Task 2: Verify the generated raster set is complete

**Files:** none changed

- [ ] **Step 1:** Run a one-line check that all 10 expected PNG sizes are on disk.

  ```bash
  for s in 16 32 48 64 128 180 192 256 512 1024; do
    test -f "assets/brand/icon-${s}.png" && echo "OK ${s}" || echo "MISSING ${s}"
  done
  ```

  Expected: 10 lines all starting with `OK`.

- [ ] **Step 2:** Confirm the 3 container files are on disk.

  ```bash
  ls -la assets/brand/favicon.ico assets/brand/AppIcon.ico assets/brand/icon.icns
  ```

  Expected: all three files present, non-zero size.

  No commit.

---

### Task 3: Verify the generation script is regenerable (round-trip)

**Files:** none changed

- [ ] **Step 1:** Re-run the generation script to confirm it still works against the current SVG.

  ```bash
  bun run gen:icons
  ```

  Expected output (per the script's `console.log` statements):
  - `[gen-icons] Source : .../assets/brand/MarkDownViewerLogo.svg`
  - `[gen-icons] Output : .../assets/brand/`
  - 10 `PNG <size> <bytes> bytes` lines
  - ICO/ICNS pack lines

- [ ] **Step 2:** Confirm `git status` shows no diff against the regenerated files.

  ```bash
  git status --short assets/brand/
  ```

  Expected: still all `??` (the regenerated files are byte-identical or close
  enough that git treats them as the same untracked-set). If any show as
  modified, the script may have non-determinism — note it but do not block.

  No commit yet.

---

### Task 4: Commit the SVG and the raster/container set

**Files:**
- Commit (new): `assets/brand/MarkDownViewerLogo.svg`
- Commit (new): `assets/brand/icon-{16,32,48,64,128,180,192,256,512,1024}.png`
- Commit (new): `assets/brand/favicon.ico`
- Commit (new): `assets/brand/AppIcon.ico`
- Commit (new): `assets/brand/icon.icns`

- [ ] **Step 1:** Stage only the brand assets directory (NOT `scripts/` or anything else).

  ```bash
  git add assets/brand/
  ```

- [ ] **Step 2:** Verify the staged set matches expectations.

  ```bash
  git diff --cached --stat
  ```

  Expected: 14 new files (1 SVG + 10 PNG + 3 container files).

  If anything else is staged, unstage it: `git restore --staged <path>`.

- [ ] **Step 3:** Commit.

  ```bash
  git commit -m "feat(brand): add brand mark master SVG + generated raster set

  Master SVG (assets/brand/MarkDownViewerLogo.svg) implements the M↓ monogram
  inside an aurora-gradient squircle (teal/blue/fuchsia/rose), per the
  reconciled brand mark design (docs/superpowers/specs/2026-05-04-brand-mark-design.md).

  Generated raster set: PNGs at 16/32/48/64/128/180/192/256/512/1024,
  multi-res favicon.ico (16/32/48), AppIcon.ico (16/32/48/64/128/256), and
  icon.icns for the macOS bundle. All produced by scripts/gen-icons.ts (next
  commit) and committed so cloning the repo and running install scripts
  works without bun run gen:icons."
  ```

  Expected: commit succeeds with 14 new files.

---

### Task 5: Commit the generation script

**Files:**
- Commit (new): `scripts/gen-icons.ts`

- [ ] **Step 1:** Stage **only** `scripts/gen-icons.ts` — do NOT stage `scripts/gen-licenses.ts` (out of scope) or any `M` script files (those have interleaved work and are deferred).

  ```bash
  git add scripts/gen-icons.ts
  ```

- [ ] **Step 2:** Verify only one file is staged.

  ```bash
  git diff --cached --stat
  ```

  Expected: 1 new file (`scripts/gen-icons.ts`).

- [ ] **Step 3:** Commit.

  ```bash
  git commit -m "feat(brand): generation script for icons (Resvg + png2icons)

  scripts/gen-icons.ts reads the master SVG and produces every PNG/ICO/ICNS
  the app needs. Pure-JS pipeline (@resvg/resvg-js for rasterisation,
  png2icons for ICO/ICNS packing) — no native build step required.

  package.json wiring (gen:icons script + devDependencies) lives alongside
  other in-flight work and is committed in a separate later step."
  ```

---

## Phase 2 — Verification

### Task 6: Re-run gen:icons to prove the script is reproducible

**Files:** none changed

- [ ] **Step 1:** Re-run the script.

  ```bash
  bun run gen:icons
  ```

  Expected: same output as Task 3, completes without error.

- [ ] **Step 2:** Confirm no diff in the committed assets.

  ```bash
  git status --short assets/brand/
  ```

  Expected: empty (or only minor metadata diffs — note them but do not
  block). If significant byte diffs appear, file an issue against
  `gen-icons.ts` for non-determinism.

  No commit.

---

### Task 7: Manual visual smoke (handed back to the owner)

**Files:** none changed

This task requires GUI interaction and is **handed back to the human owner**:

- [ ] **Step 1 (owner):** Open `assets/brand/MarkDownViewerLogo.svg` directly in a browser. Confirm the aurora gradient renders smoothly with the white/lilac/cyan mark visible and centered.

- [ ] **Step 2 (owner):** Open `assets/brand/icon-16.png` and `icon-32.png` in an image viewer. Confirm the mark is still legible at favicon scale (the M and chevron should still be distinguishable; the aurora gradient may band at 16px — that's expected).

- [ ] **Step 3 (owner):** On Windows, double-click `assets/brand/AppIcon.ico` (or open in the file properties dialog). Confirm the multi-resolution embedding shows clean icons at 16/32/48/64/128/256.

- [ ] **Step 4 (owner):** On macOS (if applicable), use `qlmanage -p assets/brand/icon.icns` to preview. Confirm all sizes render.

- [ ] **Step 5 (owner):** Run `bun run start` and confirm the app's titlebar shows the brand icon and the dev window's tab favicon is the brand mark.

  No commit.

---

## Phase 3 — DEFERRED items (not executed in this plan)

These items are documented here for completeness but are **explicitly deferred** to a later session:

### Deferred 1: Commit `M` files containing brand-mark wiring

The following files have brand-mark code interleaved with the owner's
separate in-flight work and cannot be committed cleanly without surgical
hunk staging or first having the owner commit/stash the unrelated work:

- `package.json` (gen:icons script + devDeps)
- `src/mainview/index.html` (favicon HTML)
- `electrobun.config.ts` (asset copy + app.icon)
- `scripts/postwrap.ts` (macOS Info.plist patch)
- `scripts/install-windows.ps1` (AppIcon.ico copy)
- `windows/MarkdownViewerSetup.iss` (Inno Setup icon wiring)
- `README.md` (hero img tag)

**To resume Phase 3:** once the owner has committed or stashed their
unrelated in-flight work in each file, the brand-mark hunks will become
isolatable. At that point, write a follow-up plan that commits each `M`
file with a brand-mark-scoped message.

### Deferred 2: `assets/brand/logo-mark.svg`

Per spec §6 — author when a hero row or inline-on-light surface consumes it.
No work in this plan.

### Deferred 3: CSS `--brand-*` tokens

Per spec §6 — author in a separate "design tokens" spec when CSS theming is
needed. No work in this plan.

---

## Phase 4 — Wrap-up

### Task 8: Final sanity check

**Files:** none changed

- [ ] **Step 1:** Confirm the new commits.

  ```bash
  git log --oneline -5
  ```

  Expected (top of log):
  - `feat(brand): generation script for icons (Resvg + png2icons)`
  - `feat(brand): add brand mark master SVG + generated raster set`
  - (older commits below)

- [ ] **Step 2:** Confirm working tree is otherwise unchanged.

  ```bash
  git status --short
  ```

  Expected: same untracked/modified set as before this plan ran, MINUS
  `assets/brand/` and `scripts/gen-icons.ts` (which are now committed).
  Specifically the `M` files from Phase 3-deferred should still be `M`,
  untracked items (`.codex/`, `.stitch/`, `_cobolt-docker/`, `e2e/`,
  `references/`, `tools/`, `cobolt-state.json`, `design-tokens.json`,
  `AGENTS.md`, `CLAUDE.md`, `windows/license-notice.txt`,
  `scripts/gen-licenses.ts`) should still be `??`.

- [ ] **Step 3:** Brand mark is now in source control. Plan complete; remaining work is in the deferred list above and the visual smoke (Task 7) handed back to the owner.
