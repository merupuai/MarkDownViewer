# Multi-format Editor — Spec + Plan Review Report

**Date:** 2026-05-04
**Reviewer:** Claude (Opus 4.7)
**Reviewed artifacts:**
- Spec: [`docs/superpowers/specs/2026-05-04-multi-format-editor-design.md`](../specs/2026-05-04-multi-format-editor-design.md) (commit `eb17b5b`)
- Plan: [`docs/superpowers/plans/2026-05-04-multi-format-editor.md`](../plans/2026-05-04-multi-format-editor.md) (commit `af327fe`)

**Verdict:** **Approved with required pre-execution fixes.** The plan is genuinely high-quality TDD work with complete spec coverage and a credible self-review. Three real bugs and two minor gaps were found; all are fixable with surgical edits to specific tasks before execution begins.

---

## TL;DR — Issues, by severity

| # | Severity | Title | Where |
|---|---|---|---|
| F1 | **BUG (test will fail)** | `isBinary` misclassifies all UTF-16 files as binary | Plan Task 2, `src/bun/text-io.ts` |
| F2 | **DATA LOSS** | Latin-1 save silently corrupts non-Latin-1 characters | Plan Task 3, spec §8 |
| F3 | **UX BUG** | Session restore overrides the double-clicked file's foreground state | Plan Task 18 step 3 |
| F4 | **CONTRADICTION** | Spec says "two tabs same path = allowed + flagged"; plan dedups silently | Spec §8 vs Plan Task 15 step 3 |
| F5 | **GAP** | No automated bundle-size guard — risk §11.1 mitigation is "manual smoke only" | Plan Task 1 / Task 20 |

---

## Strengths (worth preserving)

These are not problems — they're things the plan does well that should not be undone during fixes.

1. **TDD throughout.** Every implementation task has a fail-then-pass test pair. No "implement now, test later" drift.
2. **Watcher self-write echo discipline.** `recentSelfWrites` Map with 1s TTL, stamped *before* `writeText` invocation (Task 5 step 3 (b)→(c)→handler), checked in the debounced watcher callback (Task 5 step 2(d)). Ordering is correct — there's no race window.
3. **CodeMirror compartments used idiomatically.** `languageCompartment`, `wrapCompartment`, `indentCompartment` — three Compartments for the three reconfigure axes. `languageCompartment.reconfigure(lang ? [lang] : [])` is the canonical CM6 pattern.
4. **Tab strip is XSS-safe.** Task 16 step 4 mandates `createElement` + `textContent` — no `innerHTML` with user-controlled content (filenames, etc.).
5. **Encoding round-trip coverage.** Task 3 covers UTF-8/UTF-16 LE/UTF-16 BE/Latin-1 × LF/CRLF × BOM/no-BOM as unit tests with concrete byte-level expectations.
6. **Untitled-tab persistence cap.** 1 MB hard cap prevents pathological session.json bloat.
7. **Spec coverage table at the end of the plan.** Every spec section maps to a task. Reviewers don't have to reverse-engineer coverage.
8. **Boot-order intent for session vs double-click is documented** even if the implementation has a bug (see F3).

---

## F1 — `isBinary` misclassifies all UTF-16 files as binary  *(BUG)*

### Severity
**Will fail the plan's own tests.** Task 2 step 5 expects `bun test tests/text-io.test.ts` to produce "6 pass, 0 fail" — but the proposed implementation will fail the **UTF-16 LE** and **UTF-16 BE** test cases.

### Evidence

The proposed `readText` (Task 2 step 4) calls `isBinary(buf)` *before* `detectEncoding(buf)`:

```ts
export async function readText(path: string): Promise<ReadResult> {
    const buf = readFileSync(path);
    if (isBinary(buf)) {
        return { content: "", encoding: "utf-8", eol: "lf", bom: false, binary: true };
    }
    const { encoding, bom, bomLen } = detectEncoding(buf);
    ...
}
```

…and `isBinary` flags any file with `≥ 1` NUL byte in the first 8 KB:

```ts
const BINARY_NUL_THRESHOLD = 1; // a single NUL byte in first 8KB → binary

function isBinary(buf: Buffer): boolean {
    const limit = Math.min(buf.length, NUL_SCAN_BYTES);
    let nuls = 0;
    for (let i = 0; i < limit; i++) {
        if (buf[i] === 0x00) nuls++;
    }
    return nuls >= BINARY_NUL_THRESHOLD;
}
```

But the UTF-16 LE fixture is `FF FE 68 00 69 00 0D 00 0A 00` — that's **4 NUL bytes**. The test expects `r.encoding === "utf-16le"` but the implementation returns `r.binary === true`. Same for UTF-16 BE (`FE FF 00 68 00 69 00 0A`).

### Required fix

Detect encoding *first*, then run binary detection on the post-BOM bytes with NUL detection skipped for UTF-16 encodings. Replace `readText` body with:

```ts
export async function readText(path: string): Promise<ReadResult> {
    const buf = readFileSync(path);
    const { encoding, bom, bomLen } = detectEncoding(buf);
    // Skip NUL-byte binary check for UTF-16 — NUL bytes are normal there
    if (encoding !== "utf-16le" && encoding !== "utf-16be" && isBinary(buf.subarray(bomLen))) {
        return { content: "", encoding: "utf-8", eol: "lf", bom: false, binary: true };
    }
    const content = decode(buf, encoding, bomLen);
    const eol = detectEOL(content);
    return { content, encoding, eol, bom };
}
```

### Test coverage to add

The plan should add an explicit test that proves a real binary file with a UTF-16 BOM-like prefix isn't misdetected:

```ts
test("file starting with FFFE bytes but with UTF-16-invalid trailing data is still readable as UTF-16LE", async () => {
    // FF FE followed by actual UTF-16 LE text — should NOT be flagged binary
    const r = await readText("tests/text-io.fixtures/utf16le-bom-crlf.txt");
    expect(r.binary).toBeUndefined();
    expect(r.encoding).toBe("utf-16le");
});
```

(The existing test covers this implicitly by asserting `r.encoding === "utf-16le"`, but adding an explicit `expect(r.binary).toBeUndefined()` catches regressions if someone re-orders the calls.)

---

## F2 — Latin-1 save silently corrupts non-Latin-1 characters  *(DATA LOSS)*

### Severity
**Silent data loss** in a foreseeable path. A user opens a UTF-8 file with emoji (😀, code point U+1F600) or an em-dash (— U+2014), changes the encoding chip to Latin-1, saves. The chars get coerced to `0x3F` (`?`) by `Buffer.from(str, "latin1")` for any code point > 255. Original content is gone after save.

### Evidence

`writeText` (Task 3 step 3):
```ts
} else if (meta.encoding === "latin-1") {
    bodyBytes = Buffer.from(withEol, "latin1");
}
```

Node/Bun's `Buffer.from(str, "latin1")` truncates each char to its low byte — silently. No throw, no warning.

`statusEncoding` chip menu (Task 11 step 1) lets users pick "Save next time as Latin-1" with no preview of what will be lost.

### Required fix

Two-part fix:

**Part A — runtime check in `writeText`.** Add a pre-write scan that returns a "would lose chars" flag instead of silently truncating:

```ts
export async function writeText(path: string, content: string, meta: WriteMeta): Promise<{ ok: true } | { ok: false; lossy: { encoding: Encoding; firstLossyCharIndex: number; sample: string } }> {
    if (meta.encoding === "latin-1") {
        for (let i = 0; i < content.length; i++) {
            if (content.charCodeAt(i) > 255) {
                return { ok: false, lossy: { encoding: "latin-1", firstLossyCharIndex: i, sample: content.slice(Math.max(0, i - 10), i + 11) } };
            }
        }
    }
    // ...existing write logic, returning { ok: true }
}
```

**Part B — UI confirmation in the encoding chip flow.** Task 11 step 1 should call a "preview lossy save" check before commit and surface a confirm modal:

```
"Saving as Latin-1 will lose 3 characters that aren't representable
 in Latin-1 (first one: '—' at line 42 col 13). Continue?"
 [Save anyway] [Cancel]
```

If user clicks Cancel → no save, encoding choice not committed. If "Save anyway" → write proceeds with the silent truncation (the user opted in).

### Spec update needed

Spec §8 should add:
```
| Saving content with chars unrepresentable in target encoding | Confirm modal: "<n> chars would be lost. Save anyway?" — never silent |
```

---

## F3 — Session restore overrides double-click's foreground state  *(UX BUG)*

### Severity
**UX-visible bug.** The plan's intent (Task 18 step 4 manual verification, plan self-review note "double-click file dispatches *before* session restore loop, so the user's clicked file remains foremost") is correct. The implementation does not achieve it.

### Evidence

Task 18 step 3 boot block:
```ts
const initial = await electroview.rpc!.request.getInitialFile({});
if (initial && !initial.error) {
    await openOrActivate(initial);   // sets active to the double-clicked file
}

for (const t of sessionState.tabs) {
    // each tabs.openDoc(...) sets this.active = newId
    if (t.path === null && t.untitledContent !== undefined) { tabs.openDoc({...}); continue; }
    if (t.path) { /* ...readFile + openDoc... */ }
}

if (!initial && sessionState.activeTabId) {
    // only restores active when there was NO double-click
    ...
}
```

`TabStore.openDoc` (Task 15 step 3) ends with `this.active = id; this.emit(tab); return id;` — every call overrides `active`. So after the loop, `active` is the *last* session tab opened, not the double-clicked file.

The `if (!initial && sessionState.activeTabId)` guard explicitly skips re-asserting the double-clicked file as active when `initial` is set. So the double-clicked file is never re-activated.

### Required fix

After the session-restore loop, re-assert the double-click priority:

```ts
const initial = await electroview.rpc!.request.getInitialFile({});
let initialTabId: string | null = null;
if (initial && !initial.error) {
    initialTabId = await openOrActivate(initial);  // make openOrActivate return the id
}

for (const t of sessionState.tabs) { ... }

if (initialTabId) {
    // Double-click takes priority over previous session active
    tabs.setActive(initialTabId);
} else if (sessionState.activeTabId) {
    // No double-click → restore previous active
    const list = tabs.list();
    const sess = sessionState.tabs.find((s) => s.id === sessionState.activeTabId);
    const match = sess ? list.find((tt) => tt.path === sess.path) : null;
    if (match) tabs.setActive(match.id);
}
```

This requires changing `openOrActivate`'s return type from `Promise<void>` to `Promise<string>` (the id of the opened/activated tab). One-line API change in Task 16 step 3 (c).

### Test coverage

Add a `tabs-state.test.ts` case:
```ts
test("setActive after multiple openDoc calls overrides last-active", () => {
    const s = new TabStore();
    const a = s.openDoc(baseTab("/a.txt", "a"));
    const b = s.openDoc(baseTab("/b.txt", "b"));
    const c = s.openDoc(baseTab("/c.txt", "c"));
    expect(s.activeId()).toBe(c);
    s.setActive(a);
    expect(s.activeId()).toBe(a);
});
```

---

## F4 — Spec/plan contradiction on duplicate-path tabs  *(CONTRADICTION)*

### Severity
**Minor.** Pick one behavior and document it consistently. The plan's behavior (de-dup) is more user-friendly; the spec's "allowed but flagged" wording is more permissive.

### Evidence

Spec §8:
> | Two tabs pointing at same path | Allowed but flagged in status bar |

Plan Task 15 step 3:
```ts
openDoc(input: Omit<Tab, "id">): string {
    if (input.path) {
        const existing = this.tabs.find((t) => t.path === input.path);
        if (existing) {
            this.active = existing.id;
            return existing.id;     // ← deduplicates
        }
    }
    ...
}
```

…and Task 15 step 1 test:
```ts
test("openDoc on already-open path returns existing id (no dupe)", () => {
    ...
    expect(s.list().length).toBe(1);
});
```

### Required fix

**Recommended:** keep the plan's behavior (dedupe + activate existing). Update spec §8 row to:

> | Opening a file that's already open in another tab | Activate the existing tab; do not create a duplicate |

The "allowed but flagged" wording in the spec made sense when the editor allowed multiple buffers per file (e.g., Notepad++'s "view in another window"). The plan correctly identifies that this app's UX target — single window, tabs — has no good reason for parallel buffers on one file (would create save-conflict pathologies that aren't in scope).

---

## F5 — No automated bundle-size guard  *(GAP)*

### Severity
**Latent risk.** Spec §11.1 risk: "CM6 bundle bloat from language packs" with mitigation "Lazy-load per language; **measure final bundle in CI**". The plan implements lazy-loading correctly but **does not measure**. Task 20 step 2 has a manual smoke checkbox: "bun run build:release completes; bundle size delta vs pre-feature baseline < +5 MB" — that's not a guard, it's a hope.

### Evidence

- Task 1 (deps) does not capture a baseline bundle size.
- Task 20 (final smoke) has the +5 MB check as a manual checkbox in `editor-smoke.md`.
- No `bun test` step or CI workflow asserts on bundle size.

### Required fix

Add a tiny bundle-size guard task between Task 19 (README) and Task 20 (smoke):

**New Task 19a: Bundle size guard**
- Measure baseline (run `bun run build:release` on `main`, capture size of `build/dev-*/views/mainview/index.js` or whatever the bundled-renderer artifact is).
- Re-measure after Task 19 lands.
- Add a `tests/bundle-size.test.ts` with a hard assertion:
  ```ts
  import { describe, expect, test } from "bun:test";
  import { statSync } from "fs";
  describe("bundle size", () => {
      test("renderer bundle is under 1.5 MB", () => {
          const sz = statSync("build/dev-{platform-arch}/views/mainview/index.js").size;
          expect(sz).toBeLessThan(1.5 * 1024 * 1024);
      });
  });
  ```
- The exact ceiling is calibrated against the post-Task 19 measurement + slack.

**Why it matters:** the spec calls out a 20-30 MB total bundle as a defining property of this app. CM6 + 14 language packs lazy-loaded is the design, but a future contributor adding `@codemirror/lang-cpp` to the eager bundle (instead of legacy-modes) could blow the budget silently. A failing test catches it on the PR.

---

## What I did NOT find issues with (positive verifications)

These were specifically inspected and are clean:

1. **`detectEOL` heuristic** — counts `crlf` vs `lf` in first 64 line breaks, ties go to LF. Sane default.
2. **CodeMirror v6 keymap composition** — `closeBracketsKeymap`, `defaultKeymap`, `searchKeymap`, `historyKeymap`, `foldKeymap`, `completionKeymap`, `lintKeymap`, `indentWithTab` is the standard six-pack + Tab. Correct.
3. **Beforeunload handler** (Task 10) — only prefers default when dirty. ✓ doesn't spam confirm dialogs on clean quits.
4. **Untitled-tab cap** (Task 17) — 1 MB applied only to `untitledContent`, not to total session.json size. Caps the worst-case correctly without overhead for typical sessions.
5. **EOL conversion in `writeText`** — collapse to LF first, then expand. Idempotent and Windows/Unix-safe.
6. **Type drift** — author's self-review claims types are consistent across `text-io.ts` ↔ `tabs.ts` ↔ `rpc.ts` ↔ `session-store.ts`. Spot-checked `Encoding`, `EOL`, `Tab`, `SessionTab` — agree.
7. **Find-bar regression** — Task 13 delegates Find to CM6's `@codemirror/search` when active is editor; current preview-mode Find on rendered HTML stays as-is. No regression.
8. **`recentSelfWrites` cleanup** — done inline on each `stampSelfWrite` call. Map size stays bounded by concurrent saves × 1s TTL — fine.

---

## Recommended pre-execution work

Before starting Plan Task 1, apply these patches inline to the plan file:

1. **F1 patch** — rewrite Task 2 step 4 `readText` to detect encoding before binary check; skip NUL detection for UTF-16. Add the `r.binary` regression assertion to existing UTF-16 LE/BE tests.
2. **F2 patch** — change `writeText` return type to `{ ok, lossy? }`. Update Task 3 round-trip tests to assert `ok: true`. Add a new "F2 — Latin-1 lossy save returns lossy info" test. Update Task 11 to call `writeText`, branch on lossy result, present confirm modal.
3. **F3 patch** — change `openOrActivate` return type to `Promise<string>`. Restructure Task 18 step 3 boot block to capture `initialTabId` and call `tabs.setActive(initialTabId)` after the restore loop.
4. **F4 patch** — update spec §8 wording. No code change needed (plan is the canonical behavior).
5. **F5 patch** — insert Task 19a (bundle size guard with hard assertion).

After patches: re-run plan self-review, confirm "0 unmapped spec sections" still holds.

---

## Verdict

**Approved with required fixes.** The plan is rigorous and implementation-ready *after* the F1, F2, F3 patches land. F4 is a doc-only fix. F5 is a defensive add. None of the issues require redesign — they're surgical edits to specific tasks. After the patches, the plan can proceed to execution via `superpowers:subagent-driven-development` (recommended given the 20-task scope) or `superpowers:executing-plans`.
