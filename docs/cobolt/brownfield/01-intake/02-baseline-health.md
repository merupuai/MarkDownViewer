---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/02-baseline-health-and-scan-summary.md
pipeline: brownfield
topic: 01-intake
title: "Baseline Health & Scan Summary"
order: 2
audiences: ["architect", "delivery-lead", "stakeholder"]
source_sha256: f7895d2415c08a32eb496223cab346d1fc5f6bae2caad1fb7b3d2ad870739d1d
source_size: 2245
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# 02 — Baseline Health & Scan Summary

**cobolt-health overall score**: 82
**cobolt-scan total findings**: 0 (after Wave 3 deterministic battery)
**cobolt-illusion-scan**: 2 high (both verified false-positive — see `16c-illusion-verification.json`)

## Pillar Scores

| Pillar | Score | Notes |
|---|---|---|
| Project Structure | 100 | README, .gitignore, license, tech stack all present |
| Dependencies | 0* | False fail — checks for npm `package-lock.json`, project uses `bun.lock` |
| Test Coverage | 83 | Test directory present, CI configured, 0 actual test files |
| Security Posture | (varies) | All 11 Wave 3 tools ran; see `12-security-and-quality-assessment.md` |

*The Dependencies pillar's lock-file check is npm-specific. The project DOES have a lockfile (`bun.lock`); cobolt-health does not yet detect Bun lockfiles.

## Deterministic Tools Executed

- cobolt-health → `health.json` (5786 bytes)
- cobolt-scan → `security-full.json` (33305 bytes; 0 findings)
- cobolt-sbom → `sbom.json` (CycloneDX 1.5; 14 components)
- cobolt-legacy-scan → `legacy-scan.json`
- cobolt-runtime-truth → `runtime-truth.json` (npm.cmd not present in PATH; expected on Bun-only systems)
- cobolt-route-wiring-check → `domain-liveness.json` (0 domains — correct, app has no HTTP routes)
- cobolt-query-migration-contract → `query-migration-contract.json`
- cobolt-semantic-stub-check → `semantic-stub-findings.json` (0 findings)
- cobolt-ui-placeholder-check → `ui-placeholder-mock-scan.json`
- cobolt-illusion-scan → `illusion-scan.json` (2 findings, both FP)
- cobolt-authz-census → `authz-census.json` (skipped: no authz-matrix; correct)
- cobolt-secret-entropy-scanner → `secret-entropy.json` (0 findings, 34 files scanned)
- cobolt-crypto-posture → `crypto-posture.json` (0 findings)
- cobolt-attack-path → `attack-path.json` (0 paths — correct, no entry-points)
- cobolt-cis-benchmarks → `cis-benchmarks.json` (4 findings on `_cobolt-docker/docker-compose.yml` — auto-generated, see OPS-001)
- cobolt-pr-threat-scan source-mode → `source-contamination.json` (51 findings, ~6 real, see triage)
- cobolt-compliance-gate → `compliance-gate.json` (status: not_applicable — correct, no regulated data)

