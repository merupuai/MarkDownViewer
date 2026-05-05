---
cobolt_published: true
canonical: _cobolt-output/latest/planning/release-readiness-checklist.md
pipeline: plan
topic: 06-operations
title: "Release Readiness Checklist"
order: 4
audiences: ["sre", "ops", "qa", "platform-lead"]
source_sha256: 747e7865f610cb84cacbda97b8305e66ad7fe661d369613a696a103c8ec65ac9
source_size: 5073
published_at: 2026-05-05T04:08:56.184Z
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

<!-- COBOLT_BROWNFIELD_FEATURE_TRACEABILITY:START -->

## Brownfield Feature Traceability

- Feature: FEAT-001 Brownfield modernization access slice
- Requirement IDs: FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007, FR-008, FR-009, FR-010, FR-011, FR-012, FR-013, NFR-001, NFR-002, NFR-003, NFR-004, NFR-005, NFR-006
- Coverage: product intent, user flow, UI states, wireframes, backend, middleware, API, data, integrations, auth, security, privacy, NFRs, observability, tests, rollout, service blueprint, spec contracts, accessibility, and architecture.

<!-- COBOLT_BROWNFIELD_FEATURE_TRACEABILITY:END -->

## K. Rollback procedure

If a stable release introduces a regression discovered post-publish:

1. **Identify**: confirm regression via reproduction + linked GitHub issue
2. **Re-tag**: remove the bad tag (`git tag -d`); push the prior good tag forward as a re-release with a `-rerelease` suffix in the release notes
3. **Re-publish**: trigger CI release job on the prior good tag; signed installers re-uploaded to GitHub Releases
4. **Communicate**: pin a notice on the README + release-notes for the bad version explaining the issue and pointing to the rollback
5. **For users on opt-in auto-update (M4)**: edit the update manifest CDN to point users back to the prior version (downgrade entry)

No server-side rollback needed (no backend). No user data migration needed (no schema). Recent.json and EULA marker are forward-compatible.
