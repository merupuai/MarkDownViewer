---
cobolt_published: true
canonical: _cobolt-output/latest/planning/architecture.md
pipeline: plan
topic: 02-architecture
title: "Composite Architecture"
order: 1
audiences: ["architect", "platform-lead", "build-agent"]
source_sha256: 2b04cd0a86c763db2a71215b0919274891d4265854b635f231c4428a6b6e546d
source_size: 2265
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# Architecture Overview

> Canonical planning index synthesized from brownfield modernization artifacts.

This file keeps the standard build/review pipeline pointed at the canonical planning contract while preserving the richer brownfield packet as the source material.

## Execution Specs

### System Architecture
- File: `system-architecture.md`
- Summary: **Two-process Electrobun desktop application** — preserved from current architecture. No replatform. ```                     ┌────────────────────────────────┐

### Data Model
- File: `data-model-spec.md`
- Summary: The application has no relational or NoSQL database. Data persistence is entirely filesystem-based via three small JSON / text artifacts. This document codifies their schemas for forward use (and for the M3 multi-format editor's per-tab state). Location: `<userDataDir>/recent.jso

### API Contracts
- File: `api-contracts.md`
- Summary: The application has no HTTP/REST/GraphQL/gRPC API. The only "contract" is the in-process typed RPC between the bun and mainview processes, defined in `src/shared/rpc.ts`. This document is the authoritative source for the RPC contract — current state plus the M1 / M3 deltas. ```ts

### Security Requirements
- File: `security-requirements.md`
- Summary: | STRIDE | Realistic in this app? | |---|---| | Spoofing | NO — single-user desktop app, no identity model |

### Delivery Plan
- File: `delivery-plan.md`
- Summary: | Release | Trigger | Audience | Channel | |---|---|---|---| | `dev` | Push to `main` | Internal devs | GitHub Actions artifact (unsigned) |

<!-- COBOLT_BROWNFIELD_FEATURE_TRACEABILITY:START -->

## Brownfield Feature Traceability

- Feature: FEAT-001 Brownfield modernization access slice
- Requirement IDs: FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007, FR-008, FR-009, FR-010, FR-011, FR-012, FR-013, NFR-001, NFR-002, NFR-003, NFR-004, NFR-005, NFR-006
- Coverage: product intent, user flow, UI states, wireframes, backend, middleware, API, data, integrations, auth, security, privacy, NFRs, observability, tests, rollout, service blueprint, spec contracts, accessibility, and architecture.

<!-- COBOLT_BROWNFIELD_FEATURE_TRACEABILITY:END -->
