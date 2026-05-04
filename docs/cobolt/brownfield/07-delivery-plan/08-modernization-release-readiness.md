---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/44-modernization-release-readiness-checklist.md
pipeline: brownfield
topic: 07-delivery-plan
title: "Modernization Release Readiness Checklist"
order: 8
audiences: ["delivery-lead", "build-agent"]
source_sha256: 916ddcaeaab854da9ae7a40e657438c7e41adcfbdef04bffadabace037e8b801
source_size: 3617
published_at: 2026-05-04T14:36:58.135Z
published_by: cobolt-publish-docs
---

# Release-Readiness Checklist — MarkDownViewer

This checklist gates a public stable release. Every item MUST be checked before tagging a stable release.

## A. Code Quality

- [ ] All FR-01..13 implemented and validated by Playwright tests
- [ ] All SR-01..06 implemented and exercised by hostile-content fixtures
- [ ] Lint, type-check, and format-check pass on `main`
- [ ] No HIGH/CRITICAL CVE in `bun audit` (or waivered with justification + expiry)
- [ ] All `// @ts-expect-error` suppressions replaced with proper types (M4 / DEBT-004)
- [ ] No empty `catch {}` blocks remain (M4 / DEBT-014)

## B. Tests

- [ ] All Playwright golden-render tests pass on macOS-latest + windows-latest
- [ ] All Playwright hostile-content fixtures pass (no leak / no inject / no exfil)
- [ ] axe-core a11y tests pass (no serious / critical violations)
- [ ] Performance budget tests pass (NFR-01..NFR-03)
- [ ] Visual regression baseline diff < 0.1% pixel-diff on tracked screens
- [ ] Unit-test coverage on new modules ≥ 70%

## C. Build & Distribution

- [ ] macOS: `electrobun build --release` produces .app for arm64 + x64
- [ ] macOS: `codesign` signs with Apple Developer ID; `xcrun stapler` validates
- [ ] macOS: `xcrun notarytool` returns "Accepted"
- [ ] Windows: `electrobun build --release` produces .exe
- [ ] Windows: `signtool` signs both .exe and Inno Setup installer
- [ ] Inno Setup installer created and signed
- [ ] Linux: deferred — n/a for this release

## D. Documentation

- [ ] README.md describes how to install on each platform
- [ ] LICENSE present and current
- [ ] THIRD_PARTY_LICENSES.md regenerated from `bun.lock`
- [ ] Release notes written and committed
- [ ] CHANGELOG.md updated
- [ ] `package.json::version` matches the release tag
- [ ] `electrobun.config.ts::app.version` matches `package.json::version`

## E. Security

- [ ] All HIGH/MEDIUM findings closed (SEC-001..007 → M1; OPS-001 noted as out-of-app)
- [ ] CSP meta tag present and verified by hostile-content fixtures
- [ ] DOMPurify config reviewed for any new ALLOWED_TAGS or ALLOWED_ATTR additions
- [ ] No new RPC handler bypasses input validation
- [ ] No new third-party dependency introduces a higher-risk profile (license, CVE history)

## F. Compliance

- [ ] EULA marker created with mode 0644 on Linux/macOS
- [ ] No telemetry / analytics ship enabled-by-default
- [ ] Update-check (M4) defaults to OFF if shipped

## G. Standards Gate (P5.5)

- [ ] `cobolt-standards.js all --profile all` reports no Critical violations
- [ ] `cobolt-standards-gate.js planning` returns exit 0
- [ ] ISO/IEC 25010 quality attributes meet target
- [ ] ISO/IEC 29148 requirements quality score above min

## H. User Impact

- [ ] On macOS: app opens .md files via Finder double-click (verify)
- [ ] On Windows: app opens .md files via Explorer double-click (verify)
- [ ] On Linux: app launches from CLI / .desktop file (verify if shipping)
- [ ] First-run EULA accepts/declines correctly on each platform
- [ ] Recent files / Open dialog / drag-drop / find-bar / lightbox all functional
- [ ] Theme switch (auto/light/dark) works; mermaid theme follows

## I. Approvals

- [ ] CoBolt: technical / build approval
- [ ] MFTLabs: copyright / brand approval
- [ ] Security: reviewed and signed off on the M1 closure

## J. Tag & Publish

- [ ] Git tag created: `vX.Y.Z`
- [ ] GitHub Release published with: signed installers (.app/.exe/.exe-installer), checksums.txt, release notes
- [ ] `main` advanced to next development cycle (post-release version bump)
- [ ] Update manifest (M4, optional) refreshed if auto-update is shipped
