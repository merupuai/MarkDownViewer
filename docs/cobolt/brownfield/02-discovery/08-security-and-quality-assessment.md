---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/12-security-and-quality-assessment.md
pipeline: brownfield
topic: 02-discovery
title: "Security & Quality Assessment"
order: 8
audiences: ["architect", "security", "build-agent"]
source_sha256: 18be8043e041e470c984ab4cfd8d8baaec02df1115e3bdc911069ec8c8f9e071
source_size: 15918
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# Security & Quality Assessment — MarkDownViewer

**Method**: Direct read of every source file by orchestrator; deterministic Security Wave 3 (11 tools) executed in parallel; OWASP-relevant categories mapped against actual code.

**Headline**: The application has a **narrow but non-trivial security surface**. Because there is no network, no auth, no database, and no remote attack surface, the realistic threats are all driven by hostile *content* (markdown files the user may open) plus the local OS surface.

## Threat Model

```
ATTACK VECTOR                          | APPLIES?
---------------------------------------|----------
Network ingress (no server)            | NO
Cross-tenant authz (no tenants)        | NO
SQL/NoSQL injection (no DB)            | NO
SSRF (no outbound HTTP)                | NO
Auth bypass (no auth)                  | NO
---------------------------------------|----------
Hostile markdown content               | YES (focus)
Hostile YAML front-matter              | YES (focus)
Hostile mermaid diagram source         | YES (focus)
Hostile filename / path traversal      | YES
Supply-chain compromise (npm)          | YES
Local file read via image src          | YES (focus)
Command injection via openExternal     | Mitigated
Race conditions (file watcher / EULA)  | Possible
Privilege escalation                   | NO (user app)
```

## Findings

### SEC-001 — Mermaid SVG output is not re-sanitized after `securityLevel: "loose"` rendering (HIGH)

**File**: `src/mainview/index.ts:259-290` (renderMermaidBlocks); config at `src/mainview/index.ts:64-72` (configureMermaid)

**Issue**: The markdown-it `highlight` hook (markdown.ts:40-46) base64-encodes the mermaid source into a `data-mermaid-src-b64` attribute. DOMPurify (index.ts:201) then sanitizes the rendered HTML — but it does NOT see the raw mermaid source (only the encoded blob in the attribute). After DOMPurify runs, `renderMermaidBlocks` decodes the source, calls `mermaid.render()` which executes with `securityLevel: "loose"`, and at line 272 the resulting SVG is assigned into a wrapper element via the property setter that DOMPurify cannot intercept (i.e. the SVG is parsed and inserted as DOM, not re-sanitized). With loose mode, mermaid CAN emit `<foreignObject>` containing arbitrary HTML in diagram labels. **A hostile markdown file can therefore inject HTML into the rendered DOM via a hostile mermaid block, bypassing the DOMPurify boundary.**

**Mitigation options**:
1. Lower `securityLevel` to `"strict"` (the mermaid default) — kills the attack vector but breaks any user mermaid diagrams that rely on HTML labels.
2. Run DOMPurify a second time on the mermaid SVG output before injection.
3. Render mermaid in a sandboxed iframe / shadow DOM with strict CSP.

Recommended: option 2 (re-sanitize) — preserves UX, closes the vector. Carry as **MOD-001** in the modernization PRD.

**CWE**: CWE-79 (Improper Neutralization of Input During Web Page Generation), CWE-87 (Improper Neutralization of Alternate XSS Syntax).

### SEC-002 — `resolveImage` path traversal allows reading any user-readable file (MEDIUM)

**File**: `src/bun/index.ts:365-383`

**Issue**: After rejecting `https?:`, `data:`, and `file:` schemes, the function calls `resolve(docDir, src)` with no containment check. A hostile markdown file at `/Users/me/.notes/exam.md` containing `![](../../.ssh/id_rsa)` will resolve to `/Users/me/.ssh/id_rsa`, read its bytes via `readFileSync`, and embed them as `data:application/octet-stream;base64,...` inside the rendered HTML. While there is no exfiltration channel (no network), the content is now accessible to any other JavaScript loaded into the WebKit view (e.g. via SEC-001) and via `Export to HTML` it can be persisted to an attacker-chosen location.

**Mitigation**:
1. Reject `src` if `resolve(docDir, src)` does not start with `docDir` (or a configured allowlist of subdirs).
2. Restrict `extname(resolved)` to the existing image MIME map (`png/jpg/jpeg/gif/svg/webp/bmp/ico/avif`) — the function already builds the MIME map; just enforce it at the gate (today it falls through to `application/octet-stream` for unknown ext).

Recommended: both. Carry as **MOD-002**.

**CWE**: CWE-22 (Path Traversal), CWE-200 (Information Exposure).

### SEC-003 — DOMPurify allowlist permits `style` attribute (LOW-MEDIUM)

**File**: `src/mainview/index.ts:201-206`

**Issue**: The DOMPurify config explicitly adds `"style"` to `ADD_ATTR`. Inline CSS can contain `background: url(...)` or `@import url(...)`. In strict-CSP browsers those would be blocked, but here the WebKit/WebView2 view runs without an explicit Content Security Policy. A hostile markdown file can therefore make the renderer attempt to fetch external URLs (information leak / tracking pixel). With `bundleCEF: false` in `electrobun.config.ts`, the view uses the system WebKit/WebView2 — its default network policy IS the system's, which permits arbitrary outbound HTTP.

**Mitigation**: scope `style` to a CSS allowlist (e.g. via DOMPurify's `ALLOWED_CSS` hook), or strip `url()` from style values, or set a renderer CSP. Carry as **MOD-003**.

**CWE**: CWE-79 (XSS via CSS); CWE-201 (Information Exposure Through Data).

### SEC-004 — `gray-matter` YAML parsing error is silently swallowed (LOW)

**File**: `src/mainview/markdown.ts:115-124`

**Issue**: gray-matter v4 uses js-yaml SAFE_SCHEMA by default, which prevents `!!js/function` / `!!python/object` style code execution. So this is **not a code-execution risk**. However, the empty `catch {}` means a malformed front-matter block is rendered as the file body without front-matter — silently stripping legitimate document content if the user accidentally typed a YAML separator and resulting in confusing UX.

**Mitigation**: log the parse error via `rlog("warn", ...)` and surface in the front-matter card with a clear "front-matter parse error" affordance. Carry as **MOD-004**.

### SEC-005 — `/tmp/mdv-bun.log` hardcoded path is non-portable and unbounded (LOW)

**File**: `src/bun/index.ts:62-65, 508, 517`

**Issue**: On Windows the `/tmp` path doesn't exist by default. `appendFileSync` errors are caught and discarded — losing the diagnostic. Also, log file is append-only with no rotation.

**Mitigation**: use `path.join(os.tmpdir(), "mdv-bun.log")` and add a 10 MB cap with rotation (`mdv-bun.log.1`). Carry as **MOD-005**.

### SEC-006 — `markdown-it` is configured with `html: true` (INFO)

**File**: `src/mainview/markdown.ts:34-38`

`html: true` allows arbitrary inline HTML to pass through the markdown parser. **This is the documented and intentional reliance on DOMPurify as the security gate.** It means the entire DOMPurify allowlist must be the security boundary — see SEC-003 for the allowlist concern. Documenting for completeness; not a separate finding.

### SEC-007 — Renderer has no Content Security Policy (LOW-MEDIUM)

**File**: `src/mainview/index.html:1-13`

The HTML head contains `<meta charset>`, `<meta viewport>`, and stylesheet links — but no `<meta http-equiv="Content-Security-Policy">`. With `html: true` markdown and the hostile-content threat model above, a CSP would be a low-cost defense-in-depth layer.

**Mitigation**: add a CSP `<meta http-equiv>` with `default-src 'self' 'unsafe-inline' data:`, `script-src 'self'`, `connect-src 'none'`, `frame-src 'none'`. Tune the exact policy after testing against rendering paths (KaTeX inline styles, mermaid generated SVG, image data URLs). Carry as **MOD-006**.

## Code Quality Findings

### SCAN-001 — Six `// @ts-expect-error - no types` suppressions (LOW)

`src/mainview/markdown.ts:2-13` has `// @ts-expect-error` comments for six markdown-it plugins. These suppress all type errors at the import site, including future legitimate ones if the plugin API changes. Replace with ambient `declare module "markdown-it-emoji" { ... }` declarations in a `types.d.ts`. **DEBT-004**.

### SCAN-002 — Magic numbers should be named constants (LOW)

| Location | Magic number | Suggested name |
|---|---|---|
| `src/bun/index.ts:208` | `80` (debounce ms) | `FILE_WATCH_DEBOUNCE_MS` |
| `src/bun/index.ts:271` | `250` (debounce ms) | `FOLDER_WATCH_DEBOUNCE_MS` |
| `src/mainview/index.ts:559` | `250` (debounce ms) | `FOLDER_SEARCH_DEBOUNCE_MS` |
| `src/mainview/index.ts:165` | `180`, `560` (sidebar min/max) | `SIDEBAR_MIN_PX`, `SIDEBAR_MAX_PX` |
| `src/mainview/index.ts:144` | `0.6`, `2.5` (zoom range) | `ZOOM_MIN`, `ZOOM_MAX` |

**DEBT-005**.

### SCAN-003 — `escAttr` declared in two files with slightly different escape sets (LOW)

- `src/mainview/markdown.ts:26-28` — escapes `&`, `"`, `<`, `>`, `'`
- `src/mainview/index.ts:248-250` — escapes `&`, `"`, `<`, `>` (no apostrophe)

The renderer's `escAttr` is used for `escAttr(payload.error)` and `escAttr(payload.path)` in error rendering, where the missing apostrophe escape is a real (low-impact) gap. Consolidate into shared util. **DEBT-006**.

### SCAN-004 — Implicit-any escape hatches in markdown-it plugin hooks (LOW)

`src/mainview/markdown.ts:88, 89, 105` use `(tokens: any, idx: any, options: any, env: any, self: any)` for the link_open and image renderer hooks. markdown-it's plugin types do export proper signatures (`Renderer.RenderRule`). Replace `any`. **DEBT-007**.

### SCAN-005 — `searchInFolder` overwrites `matched` twice (DEAD CODE) (LOW)

`src/bun/index.ts:332-334` zeroes `matched`, runs `walk()`, then sets `matched = hits.length`. The line 321 logic that conditionally `matched++`s is dead because `matched` is overwritten unconditionally afterwards. Delete the inner increment. **DEBT-008**.

### SCAN-006 — Tree filter has no debounce (UX) (LOW)

`src/mainview/index.ts:553` attaches the input listener directly. Folder search debounces input (250 ms); the file-tree filter does not. For a 5000-entry tree, every keystroke walks the entire DOM. Add a 100 ms debounce. **DEBT-009**.

## Architecture Findings

### ARCH-001 — Renderer process trusts main process implicitly (NOTE)

The Electrobun typed RPC contract is the only IPC; both processes are part of the same .app bundle and ship together, so this is not a separation-of-trust failure. Documenting for completeness.

### ARCH-002 — Two `escAttr` implementations (see SCAN-003)

### ARCH-003 — Renderer maintains UI state in module-level `let` bindings (NOTE)

`src/mainview/index.ts` declares `let lastPayload`, `let currentFolder`, `let zoom`, `let activeFilePath`, `let currentTheme` as module globals. This is fine for a single-window app and does not need an upgrade to a state container. Documenting; no action.

## Performance Findings

### PERF-001 — `exportHtml` reads ALL stylesheet rules synchronously (LOW)

`src/mainview/index.ts:730-732`. For typical-sized stylesheets this completes in < 50 ms. No observed issue; cross-origin / blocked stylesheets trigger the catch path silently. Optionally inline only the rules used by the rendered tree (offline tree-shake). **PERF-001**.

### PERF-002 — DOMPurify and mermaid each rerun on theme toggle (NOTE)

`applyTheme(...)` calls `renderFile(lastPayload, { preserveScroll: true })` — which re-parses, re-purifies, re-renders mermaid. For very large documents this is visible. Cache `parsed.html`+`safeBody` keyed on file content; only re-render mermaid blocks (which DO need the new theme). **MOD-007**.

## Illusion Findings Triage

The `cobolt-illusion-scan` reported 2 HIGH findings. Both verified false-positive:

- **ILL-001** (`resolveImage` in `src/bun/index.ts:365`): claimed "Function accepts 2 parameters but none used in body". **FALSE POSITIVE** — `docPath` is used at line 368 (`dirname(docPath)`) and `src` is tested at 367 and used at 369. The illusion scanner appears confused by the union-return type signature.
- **ILL-002** (`scheduleFolderSearch` in `src/mainview/index.ts:557`): claimed "Uses setTimeout/sleep to simulate async work instead of real I/O". **FALSE POSITIVE** — this is a debounce pattern (clear pending timeout, schedule new one 250 ms out). It IS real I/O — the actual search runs in `runFolderSearch` after the debounce.

Recorded for the verifier under `audit-verifier`.

## Source-Contamination Triage

`cobolt-pr-threat-scan --path .` reported **51 findings, verdict BLOCK** at the source level. Manual triage:

| Bucket | Count | Verdict |
|---|---|---|
| Findings on built binaries (`MarkdownViewer-dev/bin/*.exe`, `*.dll`) | 11 | False positive — compiled binary noise (zero-width chars, suspicious patterns) |
| Findings on KaTeX font files (`katex/fonts/*.woff2`) | 9 | False positive — vendored binary fonts |
| Findings on minified built JS (`app/bun/index.js`, `views/mainview/index.js`) | 11 | False positive — minified bundle noise |
| Findings on `.claude/settings.json` | 1 | False positive — file path matches "CoBolt system file" pattern |
| Findings on `.env.cobolt` line 49 | 1 | False positive — line 49 is a comment (`# Local: postgres://postgres:postgres@localhost:5432/myapp_dev`) |
| Findings on CI workflows (`.github/workflows/*.yml`) | 4 | Worth reviewing in P2 |
| Findings on `LICENSE` text | 1 | False positive — license text matched a generic-text pattern |
| Findings on `bun.lock`, `cobolt-state.json`, `_cobolt-docker/.env` | 3 | False positive — generated files |
| Findings on `scripts/install-macos.sh` | 1 | Worth reviewing |
| Findings on `.worktrees/multi-format-editor/...` | 5 | False positive — sub-worktree build outputs |
| Findings with no file (`(no-file)`) | 2 | Filter-tool noise |

**Net real findings**: ~6 (CI workflows, install script). Tracking under DEBT-010 / DEBT-011 if not later closed.

## Compliance Posture

`cobolt-compliance-gate` returned `status: "not_applicable"` — no regulated framework is in scope for a desktop markdown viewer with no PII processing. This is correct.

## CIS Benchmarks

`cobolt-cis-benchmarks` flagged **4 violations** on `_cobolt-docker/docker-compose.yml`:

| ID | Severity | Title | Status |
|---|---|---|---|
| CIS-DOCKER-5.25 | HIGH | Missing `security_opt: [no-new-privileges:true]` | Auto-generated by `/cobolt-init`; we don't ship the docker-compose; consider hardening or noting it's optional dev-only |
| CIS-DOCKER-5.10 | HIGH | No memory limit declared | Same |
| CIS-DOCKER-5.12 | HIGH | No read-only root filesystem | Same |
| CIS-DOCKER-5.11 | MEDIUM | No CPU limit declared | Same |

**Recommendation**: harden the CoBolt-generated docker-compose template upstream (in CoBolt itself), since this app does not author or ship that file. Documented as `OPS-001` in the issues registry — outside-app remediation.

## Crypto Posture

`cobolt-crypto-posture` returned **0 findings**. Correct — the app does no crypto work.

## Auth Contract / AuthZ Census / AuthZ Probe

All three returned `skipped: authz-matrix-absent` or empty — correct, the app has no auth model.

## Threat-Test Generator

`cobolt-threat-test-gen` requires `_cobolt-output/latest/planning/threat-model.md` (not yet produced). Will be generated as part of P4-P5 modernization planning.

## Net Verdict

| Area | Verdict |
|---|---|
| Network attack surface | Not applicable |
| Authn / Authz | Not applicable |
| Database / data store | No DB; trivial JSON store, low risk |
| Hostile-content security | **3 HIGH/MEDIUM findings (SEC-001, SEC-002, SEC-003)**; 4 LOW (SEC-004, SEC-005, SEC-006, SEC-007) |
| Supply chain | Low risk; recommended hardening (DEBT-002, SCA-001, SCA-002) |
| Code quality | Solid; 6 small DEBT items |
| Performance | No hot-path issues; one optional optimization (PERF-001 / MOD-007) |
| Compliance | Out of scope |

The application is well-engineered for its scope. The actionable security upgrades all cluster around **the markdown rendering pipeline as the trust boundary** — close those three and the app's security posture is materially stronger.
