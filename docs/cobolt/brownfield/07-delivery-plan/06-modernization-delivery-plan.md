---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/39-modernization-delivery-plan.md
pipeline: brownfield
topic: 07-delivery-plan
title: "Modernization Delivery Plan"
order: 6
audiences: ["delivery-lead", "build-agent"]
source_sha256: 8e3b3b2bf7d716ca554e3cb224f0b6b32ea5876cef40c9a67b8bbb4ea1fb34a2
source_size: 4194
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# Delivery Plan — MarkDownViewer Modernization

## 1. Release Strategy

| Release | Trigger | Audience | Channel |
|---|---|---|---|
| `dev` | Push to `main` | Internal devs | GitHub Actions artifact (unsigned) |
| `canary` | Manual / weekly tag | Power users | GitHub Releases (signed for win+mac) |
| `stable` | Tagged release with M1 + M2 closed | Public | GitHub Releases (signed + mac-notarized) |

Modernization milestones map to versions:

| Milestone | Version |
|---|---|
| M0 (current) | `1.0.0` |
| M1 close | `1.1.0` (security) |
| M2 close | `1.2.0` (signed distribution) |
| M3 close | `2.0.0` (multi-format editor — major bump) |
| M4 close | `2.1.0` (polish) |

Versioning policy: SemVer. M0→M1 and M0→M2 are minor (additive features, no breaking change). M0→M3 is major (the editor is a substantial UX shift).

## 2. Environment Promotion

For a desktop app, "environment" = build target + signing config:

```
dev build (unsigned)
   ↓ (smoke test on PR)
canary build (signed)
   ↓ (1 week canary period; opt-in update channel)
stable build (signed + notarized + announced)
```

## 3. Rollout Stages

| Stage | Artifacts | Confidence gate |
|---|---|---|
| 1. Internal dev | Unsigned dev build | Lint + unit + e2e (golden + hostile) pass |
| 2. Canary | Signed canary build, manual download | + perf budget pass + a11y axe-core pass + visual regression baseline |
| 3. Stable | Signed + notarized stable build | + 1 week with no canary regression reports |
| 4. Auto-update notification | Signed manifest update on the CDN (M4) | + signature verification on client side |

## 4. Pre-release Checklist

See `44-modernization-release-readiness-checklist.md` for the gating list.

## 5. Rollback Strategy

- A signed installer is uploaded to GitHub Releases. Rollback = remove the bad release tag and re-publish the prior good tag.
- No server-side rollback because there's no server.
- For users with auto-update enabled (M4), a "downgrade" entry in the manifest can pin to a prior version.
- All releases are non-destructive on user data: no schema migrations, no irreversible state changes.

## 6. Feature Flags

n/a for M1/M2 (security hardening should not be flag-gated — always on).

For M3 (editor), the multi-format editor IS the feature flag — until M3 ships, the app is view-only.

For M4 (polish), individual features (PDF export, update-check, crash-report) are exposed as user-facing toggles in `Help → Preferences`. They default to OFF for the privacy-by-default principle.

## 7. Release Cadence

| Class | Cadence |
|---|---|
| Security patch | On demand (any HIGH/CRITICAL CVE in deps; any new SR-01..06 regression) |
| Minor release | Every 2-3 months once M1 is stable |
| Major release | M3 close (multi-format editor); M-future as relevant |

## 8. Acceptance Gating

A release is gated by:

1. All tests pass (unit + e2e + hostile + a11y + perf + visual regression)
2. CI build is signed and (mac) notarized
3. `bun audit` passes (no HIGH/CRITICAL CVE)
4. Standards gate (P5.5) returns no critical violations
5. Release notes are written and committed
6. Tag matches `package.json::version` and `electrobun.config.ts::app.version`

## 9. Distribution Channels

| Channel | Status |
|---|---|
| GitHub Releases | Primary; M2 onward |
| Direct download from MFTLabs.io | Future / optional |
| Mac App Store | Out of scope (requires sandboxing rework) |
| Microsoft Store | Out of scope |
| Homebrew cask | Future / community contribution acceptable |
| `winget` | Future / community contribution acceptable |
| Linux distribution channels (.deb / Snap / AppImage) | Deferred beyond M2 |

## 10. Communication Plan

- M1 release: changelog highlights "hostile-content hardening — see security advisory"
- M2 release: announce code-signing on README and via release notes
- M3 release: marketing-grade announcement (the editor is the headline feature)
- M4: smaller patch-flavored notes per feature

## 11. Post-Release Monitoring

For a desktop app without telemetry, monitoring is via:

- GitHub Issues (user-reported bugs)
- Optional crash-report uploads (M4 / opt-in)
- Manual canary testing of each release across both supported OSes
