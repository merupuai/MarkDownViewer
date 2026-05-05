---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/26a-modernization-secure-coding-standard.md
pipeline: brownfield
topic: 06-target-state
title: "Modernization Secure Coding Standard"
order: 4
audiences: ["architect", "security", "build-agent"]
source_sha256: 7ff360dc8588e1e9a316a2a75750e774b5ffe3f699000234d6b062e68a129448
source_size: 4851
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# Secure Coding Standard — MarkDownViewer

Coding-level rules to prevent regressions of the closed security findings.

## A. HTML Injection

### A1. All HTML injection sites MUST go through DOMPurify

When you assign HTML to a DOM property that parses HTML (the property whose name starts with "inner" and ends with "HTML"), the assigned value MUST already be the output of `DOMPurify.sanitize(...)` on this run. Acceptable patterns:

- Set the inner-HTML property to `DOMPurify.sanitize(rawHtml, config)` directly
- Or set it to a variable that holds DOMPurify output from this render path

Forbidden:
- Setting the inner-HTML property directly to user-rendered markdown (skips sanitizer)
- Setting it to SVG that came from a third-party library (mermaid, etc.) without re-sanitization

### A2. Mermaid SVG MUST be re-sanitized

Always wrap the result of `mermaid.render(...)` via `DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } })` before injection.

### A3. Inline `style` MUST NOT permit url-loading or import

DOMPurify config: use ALLOWED_CSS (or FORBID_CSS_FUNCTIONS) excluding url-loading constructs.

## B. Path Handling

### B1. Path containment

Any function that takes a user-controlled path and resolves it against a base path MUST verify the resolved path is under the base. Pattern:

```ts
const resolved = resolve(baseDir, userPath);
const normalized = resolved + (resolved.endsWith(sep) ? "" : sep);
const baseNormalized = baseDir + (baseDir.endsWith(sep) ? "" : sep);
if (!normalized.startsWith(baseNormalized) && resolved !== baseDir) {
  return { error: "out-of-bounds" };
}
```

### B2. Filename allowlists

User-supplied filenames in `Bun.write` / `writeFileSync` MUST be sanitized to `[A-Za-z0-9._-]` (already done in `exportHtml`).

## C. External Process Spawning

### C1. ALWAYS use array argv form for `Bun.spawn`

Never construct a shell string. Pattern:

```ts
Bun.spawn(["open", url]);              // OK
Bun.spawn(["cmd", "/c", "start", "", url]); // OK
Bun.spawn("open " + url);              // FORBIDDEN
```

### C2. Length-cap user input passed to OS commands

URLs, paths, etc. MUST be < 2048 bytes before passing to OS. (Add to `openExternal` and `revealInFinder` in M4.)

## D. Cross-Platform File Handling

### D1. Use `os.tmpdir()` not hardcoded `/tmp`

Pattern: `const logPath = path.join(os.tmpdir(), "mdv-bun.log");`

### D2. Use `Utils.paths.userData` for persistent state

Already done for `recent.json`. Continue.

### D3. Watchers MUST handle ENOENT/ENOSPC

Wrap `fs.watch` setup and the watcher's `close()` call in try/catch with logged errors (replace empty `catch {}` blocks).

## E. Error Handling

### E1. NO empty `catch {}` blocks

Empty catches mask production issues. Always log via `rlog("warn", ...)` or `dbg(...)`. Acceptable exception: cleanup-only blocks where the error is genuinely uninteresting (e.g., closing an already-closed watcher) — but include a one-line comment explaining.

### E2. `try { ... } catch (err)` MUST log err

If the catch body discards the error, write `dbg("operation X failed", String(err))` first.

### E3. JSON parse: validate shape after parse

`JSON.parse(...)` returns `unknown`. Validate with explicit type guards (e.g. `Array.isArray`, `typeof x.path === "string"`) before use. Already done in `loadRecent`.

## F. Input Validation

### F1. Every RPC handler MUST validate its inputs at the boundary

The Electrobun typed RPC contract types the inputs at compile time, but at runtime the renderer can send arbitrary payloads (defense-in-depth). Each handler should:

- Verify required fields exist
- Cap string lengths (paths < 4096, queries < 1024)
- Reject NUL bytes

### F2. Regex constructed from user input MUST escape special chars

Already done in `searchInFolder`. Continue.

## G. TypeScript Hygiene

### G1. NO `as any` casts at trust boundaries

Specifically, `payload as Record<string, unknown>` is forbidden when `payload` came from disk or RPC. Use a runtime validator.

### G2. NO blanket `// @ts-expect-error` on imports

Replace with a `types.d.ts` ambient declaration. Six existing suppressions are tracked in DEBT-004.

## H. Logging

### H1. NEVER log user file content

The bun debug log MUST contain only paths, sizes, durations, error messages. No file body, no markdown content.

### H2. Log file MUST rotate

Cap at 10 MB; rotate to `mdv-bun.log.1`. (M1.)

## I. Testing Discipline

### I1. Every security control MUST have a hostile fixture

For SR-01..SR-06, the Playwright suite MUST contain a fixture that exercises the attack path and verifies the mitigation. PR review MUST verify the fixture exists.

### I2. Every silently-caught error MUST have a regression test

When you replace `catch {}` with `catch (err) { ... }`, add a test that triggers the error path and asserts the warning surfaces.
