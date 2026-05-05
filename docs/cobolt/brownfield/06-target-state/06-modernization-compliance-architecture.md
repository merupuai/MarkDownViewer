---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/26c-modernization-compliance-architecture.md
pipeline: brownfield
topic: 06-target-state
title: "Modernization Compliance Architecture"
order: 6
audiences: ["architect", "security", "build-agent"]
source_sha256: 6e7c8936dc839a651a1bc66d3d17b8bd64721c723c8f77588304922c0ddda49b
source_size: 5039
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# Compliance Architecture — MarkDownViewer

## Summary

MarkDownViewer processes **no PII, no PHI, no payment data, no credentials**. The application is OUT OF SCOPE for GDPR / HIPAA / SOC2 / PCI-DSS / DPDP / FedRAMP. The `cobolt-compliance-gate` deterministic tool returned `status: "not_applicable"` — confirmed.

This document catalogs the controls that ARE in scope (license compliance, supply-chain, signing) and explicitly notes the frameworks that are NOT.

## In-Scope Controls

### 1. License Compliance

| Control | Status | Source |
|---|---|---|
| Redistribute the MIT (Non-Resale Variant) license text with every distribution | ✓ | `LICENSE` ships in app bundle |
| Include MFTLabs copyright notice and CoBolt attribution | ✓ | `package.json::copyright`, in-app status bar |
| Display CoBolt name logo in status bar footer | ✓ | `electrobun.config.ts:41` (asset wired) |
| Generate `THIRD_PARTY_LICENSES.md` covering all bundled npm deps | **TODO (FR-10 / MOD-008)** | M2 |
| Reachable from `Help → License…` menu | **TODO (FR-10)** | M2 |
| MPL-2.0 attribution for `isomorphic-dompurify` | **TODO** | Covered by THIRD_PARTY_LICENSES.md |

### 2. Supply Chain

| Control | Status | Source |
|---|---|---|
| `bun.lock` committed | ✓ | |
| Lockfile is the install source of truth in CI (`bun install --frozen-lockfile`) | **TODO** | M2 (CI workflow) |
| OSV / `bun audit` scan on every PR | **TODO (SR-07 / MOD-009)** | M2 |
| SBOM regenerated on every release (CycloneDX) | **TODO** | M2 |
| `engines.bun` pin (DEBT-003) | **TODO** | M2 |

### 3. Code Signing & Distribution Integrity

| Control | Status | Source |
|---|---|---|
| macOS .app code-signed with Apple Developer ID | **TODO (SR-08 / FR-09)** | M2 |
| macOS .app notarized + stapled | **TODO** | M2 |
| Windows Authenticode signing on .exe AND installer | **TODO** | M2 |
| Linux distribution checksums + GPG sig | **DEFERRED** | Beyond M2 |

### 4. End-User License Acceptance

| Control | Status | Source |
|---|---|---|
| First-run EULA dialog | ✓ | `src/bun/index.ts:118-168` |
| EULA marker file with version-bump invalidation | ✓ | `src/bun/index.ts:22, 32` |
| Inno Setup pre-acceptance for Windows installer | ✓ | `windows/MarkdownViewerSetup.iss` |
| Marker file 0644 on Linux/macOS (not world-writable) | **TODO** (verify with `chmod` post-create) | M1 quick fix |

### 5. Privacy

| Control | Status |
|---|---|
| No telemetry by default | ✓ |
| No outbound network calls without explicit user opt-in | ✓ |
| Bun debug log MUST NOT contain user file content | **TODO — verify in test (TR-DATA-02)** |

## Out-of-Scope Frameworks (verified)

| Framework | Reason |
|---|---|
| GDPR / DPDP / CCPA | No personal data is processed, stored, or transmitted. The only persisted user data is filesystem paths in `recent.json`, which IS user-private but not PII in the regulatory sense. |
| HIPAA | No PHI |
| SOC2 | No service offering; no third-party data trust |
| PCI-DSS | No payment data |
| FedRAMP | No US federal hosting |
| ISO 27001 | The app does not handle organizational data; if MFTLabs/CoBolt operates an ISMS, that is corporate-scope, not app-scope |
| ISO 42001 / NIST AI RMF | No AI components (verified by `ai-system-inventory.json`) |

## Architecture-Level Compliance Mapping

```
         ┌─────────────────────────────────────────────┐
         │     User runs MarkdownViewer.app/.exe       │
         └────────┬────────────────────────────────────┘
                  │
        ┌─────────▼────────┐
        │  EULA gate       │ ← § 4 (first-run + Inno)
        └─────────┬────────┘
                  │
        ┌─────────▼────────────┐
        │  Local-only operation│ ← § 5 (no network)
        │  - reads markdown    │
        │  - persists recent   │
        │  - persists EULA     │
        │  - logs (no body)    │
        └─────────┬────────────┘
                  │
        ┌─────────▼─────────┐
        │  Distribution     │ ← § 1, 2, 3
        │  - signed binary  │
        │  - SBOM           │
        │  - 3rd-party      │
        │    licenses       │
        └───────────────────┘
```

## Audit Evidence

| Claim | Evidence |
|---|---|
| No PII processing | `legacy-data-classification.json` |
| No regulated data | `compliance-gate.json` (status: not_applicable) |
| No AI components | `ai-system-inventory.json` (status: no-ai-system-detected) |
| Supply chain reviewed | `09-supply-chain-and-vulnerability-review.md` + `sbom.json` |
| EULA flow exists | `src/bun/index.ts:118-168` |
