#!/usr/bin/env node
// Generate M1 test plan + test strategy from task manifest + story specs.
import fs from 'node:fs';

const MILESTONE = 'M1';
const BUILD_DIR = `_cobolt-output/latest/build/${MILESTONE}`;
const MANIFEST = JSON.parse(fs.readFileSync(`${BUILD_DIR}/${MILESTONE}-task-manifest.json`, 'utf8'));
const allStoryIds = [];
for (const e of MANIFEST.epics || []) for (const s of e.stories || []) allStoryIds.push(s.id);

// ── Build round-assigned test files ──
const rounds = {
  1: {
    id: 1,
    name: 'foundation',
    description: 'Monorepo scaffolding, CI gates, design tokens, Postgres schema + RLS',
    testFiles: [],
    builders: ['devops-agent', 'db-migration-writer', 'ui-component-builder'],
    dependsOn: [],
    skip: false,
  },
  2: {
    id: 2,
    name: 'core',
    description: 'Domain services: middleware pipeline, ledger, policy engine, tenant provisioning',
    testFiles: [],
    builders: ['backend-dev', 'db-migration-writer'],
    dependsOn: [1],
    skip: false,
  },
  3: {
    id: 3,
    name: 'api',
    description: 'HTTP handlers, SSE, route registration',
    testFiles: [],
    builders: ['api-endpoint-builder', 'backend-dev'],
    dependsOn: [2],
    skip: false,
  },
  4: {
    id: 4,
    name: 'frontend',
    description: 'Next.js App Router pages, components, Playwright E2E',
    testFiles: [],
    builders: ['frontend-dev', 'ui-component-builder'],
    dependsOn: [3],
    skip: false,
  },
  5: {
    id: 5,
    name: 'finalize',
    description: 'Docker, CI, a11y, authz census, stub presence',
    testFiles: [],
    builders: ['devops-agent', 'docker-builder', 'test-writer'],
    dependsOn: [4],
    skip: false,
  },
};

function addTest(round, path, type, testCount, writer, stories, requirements) {
  rounds[round].testFiles.push({ path, type, testCount, writer, stories, requirements });
}

// Round 1 — Foundation
addTest(
  1,
  'tests/integration/monorepo-boot.test.ts',
  'integration',
  4,
  'integration-test-agent',
  ['E12-S1'],
  ['TR-300', 'TR-105'],
);
addTest(1, 'tools/lint-rules/tests/no-reusable-assets.test.ts', 'unit', 6, 'test-writer', ['E12-S2'], ['NFR-13']);
addTest(1, 'tools/lint-rules/tests/rls-required.test.ts', 'unit', 8, 'test-writer', ['E12-S2'], ['NFR-13', 'NFR-04']);
addTest(1, 'tools/lint-rules/tests/no-any-leak.test.ts', 'unit', 5, 'test-writer', ['E12-S2'], ['TR-105']);
addTest(1, 'packages/ui/tests/tokens.test.ts', 'unit', 6, 'test-writer', ['E10-S1'], []);
addTest(1, 'packages/ui/tests/button.test.tsx', 'unit', 8, 'test-writer', ['E10-S1'], []);
addTest(1, 'packages/ui/tests/dialog.test.tsx', 'unit', 7, 'test-writer', ['E10-S1'], []);
addTest(1, 'packages/ui/tests/input.test.tsx', 'unit', 5, 'test-writer', ['E10-S1'], []);
addTest(1, 'packages/ui/tests/tabs-select-toast-card.test.tsx', 'unit', 10, 'test-writer', ['E10-S1'], []);
addTest(1, 'db/tests/schema-tenants.test.ts', 'database', 8, 'db-test-agent', ['E1-S1'], ['FR-30', 'NFR-04']);
addTest(
  1,
  'db/tests/rls-census.test.ts',
  'database',
  14,
  'db-test-agent',
  ['E1-S1'],
  ['NFR-04', 'FR-35', 'SR-AUTHZ-001'],
);
addTest(1, 'db/tests/cross-tenant-denial.test.ts', 'database', 12, 'db-test-agent', ['E1-S1'], ['NFR-04']);
addTest(
  1,
  'db/tests/migration-ordering.test.ts',
  'database',
  4,
  'db-test-agent',
  ['E1-S1', 'E1-S4', 'E1-S5', 'E1-S8'],
  [],
);
addTest(1, 'packages/ui/tests/tailwind-preset.test.ts', 'unit', 4, 'test-writer', ['E10-S1'], []);

// Round 2 — Core Logic
addTest(
  2,
  'services/tenant/tests/scoped-client.test.ts',
  'integration',
  6,
  'integration-test-agent',
  ['E1-S1'],
  ['NFR-04'],
);
addTest(
  2,
  'services/tenant/tests/provisioning.test.ts',
  'integration',
  10,
  'integration-test-agent',
  ['E1-S1'],
  ['FR-30', 'FR-35'],
);
addTest(
  2,
  'apps/api-gateway/tests/scope.test.ts',
  'integration',
  8,
  'integration-test-agent',
  ['E1-S3'],
  ['FR-30', 'FR-31', 'IR-052'],
);
addTest(2, 'apps/api-gateway/tests/correlation.test.ts', 'unit', 5, 'test-writer', ['E1-S3'], ['IR-052']);
addTest(
  2,
  'apps/api-gateway/tests/idempotency.test.ts',
  'integration',
  10,
  'integration-test-agent',
  ['E1-S4'],
  ['FR-31', 'IR-046'],
);
addTest(
  2,
  'apps/api-gateway/tests/pipeline.test.ts',
  'integration',
  6,
  'integration-test-agent',
  ['E1-S3', 'E1-S4', 'E1-S8'],
  ['NFR-01'],
);
addTest(
  2,
  'services/evidence-ledger/tests/hash-chain.test.ts',
  'unit',
  8,
  'test-writer',
  ['E1-S5'],
  ['FR-32', 'IR-025'],
);
addTest(
  2,
  'services/evidence-ledger/tests/writer.test.ts',
  'integration',
  10,
  'integration-test-agent',
  ['E1-S5'],
  ['FR-32', 'SR-AUTH-010'],
);
addTest(
  2,
  'services/evidence-ledger/tests/writer-atomicity.test.ts',
  'integration',
  5,
  'integration-test-agent',
  ['E1-S5'],
  ['FR-32'],
);
addTest(
  2,
  'services/evidence-ledger/tests/audit-emitter.test.ts',
  'integration',
  8,
  'integration-test-agent',
  ['E1-S6'],
  ['FR-32', 'FR-35', 'IR-052'],
);
addTest(
  2,
  'services/evidence-ledger/tests/audit-query.test.ts',
  'integration',
  5,
  'integration-test-agent',
  ['E1-S6'],
  [],
);
addTest(
  2,
  'services/evidence-ledger/tests/integrity-job.test.ts',
  'integration',
  6,
  'integration-test-agent',
  ['E1-S7'],
  ['FR-32', 'IR-025'],
);
addTest(
  2,
  'services/evidence-ledger/tests/tamper-detection.test.ts',
  'integration',
  4,
  'integration-test-agent',
  ['E1-S7'],
  ['FR-32'],
);
addTest(
  2,
  'services/tenant/tests/policy-engine.test.ts',
  'unit',
  14,
  'test-writer',
  ['E1-S8'],
  ['FR-33', 'FR-35', 'SR-AUTHZ-001'],
);
addTest(
  2,
  'services/tenant/tests/policy-rbac.test.ts',
  'unit',
  10,
  'test-writer',
  ['E1-S8'],
  ['SR-AUTHZ-001', 'SR-AUTHZ-004'],
);
addTest(2, 'services/tenant/tests/policy-abac.test.ts', 'unit', 8, 'test-writer', ['E1-S8'], ['SR-AUTHZ-001']);
addTest(
  2,
  'services/tenant/tests/policy-deny-by-default.test.ts',
  'unit',
  5,
  'test-writer',
  ['E1-S8'],
  ['SR-AUTHZ-002'],
);
addTest(
  2,
  'services/tenant/tests/policy-abac-injection-denied.test.ts',
  'integration',
  4,
  'integration-test-agent',
  ['E1-S8'],
  ['SR-AUTHZ-001'],
);

// Round 3 — API Layer
addTest(
  3,
  'services/auth/tests/saml.test.ts',
  'integration',
  10,
  'integration-test-agent',
  ['E1-S2'],
  ['FR-35', 'FR-42', 'SR-AUTH-001', 'SR-AUTH-005'],
);
addTest(
  3,
  'services/auth/tests/oidc.test.ts',
  'integration',
  9,
  'integration-test-agent',
  ['E1-S2'],
  ['FR-35', 'FR-42', 'SR-AUTH-006'],
);
addTest(
  3,
  'services/auth/tests/session-manager.test.ts',
  'unit',
  8,
  'test-writer',
  ['E1-S2'],
  ['SR-AUTH-005', 'SR-AUTH-006'],
);
addTest(
  3,
  'services/auth/tests/refresh-rotation.test.ts',
  'integration',
  8,
  'integration-test-agent',
  ['E1-S2'],
  ['SR-AUTH-006'],
);
addTest(
  3,
  'services/auth/tests/refresh-replay-invalidation.test.ts',
  'integration',
  5,
  'integration-test-agent',
  ['E1-S2'],
  ['SR-AUTH-006'],
);
addTest(3, 'tools/authz-census/tests/scan-routes.test.ts', 'unit', 6, 'test-writer', ['E12-S3'], ['SR-AUTHZ-002']);
addTest(3, 'tools/authz-census/tests/diff.test.ts', 'unit', 5, 'test-writer', ['E12-S3'], ['SR-AUTHZ-002']);
addTest(3, 'tests/authz/census.test.ts', 'integration', 6, 'integration-test-agent', ['E12-S3'], ['SR-AUTHZ-002']);
addTest(
  3,
  'services/app-builder/tests/create-app.test.ts',
  'integration',
  10,
  'integration-test-agent',
  ['E2-S1'],
  ['FR-01', 'NFR-02', 'IR-001', 'IR-040'],
);
addTest(
  3,
  'apps/api-gateway/tests/routes-apps.test.ts',
  'integration',
  8,
  'integration-test-agent',
  ['E2-S1'],
  ['FR-01', 'NFR-02'],
);
addTest(3, 'services/app-builder/tests/mock-provider.test.ts', 'unit', 4, 'test-writer', ['E2-S4'], ['FR-06']);
addTest(
  3,
  'services/app-builder/tests/stream.test.ts',
  'integration',
  10,
  'integration-test-agent',
  ['E2-S4'],
  ['FR-06', 'NFR-02', 'IR-005'],
);
addTest(
  3,
  'services/app-builder/tests/stream-reconnect.test.ts',
  'integration',
  6,
  'integration-test-agent',
  ['E2-S4'],
  ['IR-005'],
);
addTest(
  3,
  'services/app-builder/tests/state-machine.test.ts',
  'unit',
  10,
  'test-writer',
  ['E2-S5'],
  ['FR-07', 'NFR-03', 'IR-041'],
);
addTest(
  3,
  'services/app-builder/tests/lifecycle.test.ts',
  'integration',
  6,
  'integration-test-agent',
  ['E2-S5'],
  ['FR-07', 'IR-041'],
);
addTest(
  3,
  'services/app-builder/tests/revisions.test.ts',
  'integration',
  9,
  'integration-test-agent',
  ['E2-S6'],
  ['FR-05', 'IR-004', 'IR-016', 'IR-017'],
);
addTest(
  3,
  'services/app-builder/tests/preview.test.ts',
  'integration',
  6,
  'integration-test-agent',
  ['E2-S8'],
  ['FR-12', 'NFR-08', 'IR-006'],
);
addTest(3, 'services/app-builder/tests/signed-url.test.ts', 'unit', 6, 'test-writer', ['E2-S8'], ['FR-12', 'NFR-08']);
addTest(
  3,
  'services/collaboration/tests/share-links.test.ts',
  'integration',
  10,
  'integration-test-agent',
  ['E2-S9'],
  ['FR-22', 'IR-010'],
);
addTest(
  3,
  'services/collaboration/tests/presence.test.ts',
  'integration',
  6,
  'integration-test-agent',
  ['E2-S10'],
  ['FR-20', 'FR-21', 'IR-045'],
);
addTest(
  3,
  'services/collaboration/tests/edit-locks.test.ts',
  'integration',
  5,
  'integration-test-agent',
  ['E2-S10'],
  ['FR-21', 'IR-045'],
);
addTest(
  3,
  'services/app-builder/tests/templates.test.ts',
  'integration',
  7,
  'integration-test-agent',
  ['E2-S11'],
  ['FR-23', 'FR-24', 'IR-011'],
);
addTest(
  3,
  'apps/api-gateway/tests/evidence-routes.test.ts',
  'integration',
  6,
  'integration-test-agent',
  ['E1-S5', 'E1-S6'],
  ['FR-32'],
);
addTest(
  3,
  'apps/api-gateway/tests/policy-routes.test.ts',
  'integration',
  4,
  'integration-test-agent',
  ['E1-S8'],
  ['FR-33'],
);

// Round 4 — Frontend
addTest(4, 'tests/e2e/landing.spec.ts', 'e2e', 6, 'uat-agent', ['E10-S7'], []);
addTest(4, 'tests/a11y/landing.a11y.spec.ts', 'a11y', 4, 'uat-agent', ['E10-S7'], []);
addTest(4, 'tests/e2e/workspace-shell.spec.ts', 'e2e', 7, 'uat-agent', ['E10-S2'], ['FR-02']);
addTest(4, 'tests/a11y/workspace.a11y.spec.ts', 'a11y', 5, 'uat-agent', ['E10-S2'], []);
addTest(4, 'tests/e2e/create-app-flow.spec.ts', 'e2e', 5, 'uat-agent', ['E2-S1', 'E10-S2'], ['FR-01', 'FR-02']);
addTest(4, 'tests/e2e/workspace-app-panels.spec.ts', 'e2e', 8, 'uat-agent', ['E2-S2'], ['FR-02', 'IR-002']);
addTest(
  4,
  'apps/web/src/app/(workspace)/apps/[appId]/panels/__tests__/chat.test.tsx',
  'unit',
  6,
  'test-writer',
  ['E2-S2'],
  ['FR-02'],
);
addTest(
  4,
  'apps/web/src/app/(workspace)/apps/[appId]/panels/__tests__/evidence.test.tsx',
  'unit',
  5,
  'test-writer',
  ['E2-S2'],
  ['FR-32'],
);
addTest(
  4,
  'apps/web/src/app/(workspace)/apps/[appId]/panels/__tests__/editor.test.tsx',
  'unit',
  5,
  'test-writer',
  ['E2-S3'],
  ['FR-03', 'IR-003'],
);
addTest(4, 'tests/e2e/monaco-editor.spec.ts', 'e2e', 4, 'uat-agent', ['E2-S3'], ['FR-03']);
addTest(
  4,
  'apps/web/src/app/(workspace)/apps/[appId]/visual-patch/__tests__/overlay.test.tsx',
  'unit',
  4,
  'test-writer',
  ['E2-S7'],
  ['FR-04'],
);
addTest(
  4,
  'apps/web/src/app/(workspace)/apps/[appId]/visual-patch/__tests__/anchor.test.ts',
  'unit',
  6,
  'test-writer',
  ['E2-S7'],
  [],
);
addTest(4, 'apps/web/src/app/(marketing)/__tests__/hero.test.tsx', 'unit', 4, 'test-writer', ['E10-S7'], []);
addTest(
  4,
  'apps/web/src/app/(workspace)/components/__tests__/sidebar.test.tsx',
  'unit',
  5,
  'test-writer',
  ['E10-S2'],
  [],
);
addTest(
  4,
  'apps/web/src/app/(workspace)/components/__tests__/skip-link.test.tsx',
  'unit',
  3,
  'test-writer',
  ['E10-S2'],
  [],
);
addTest(4, 'tests/e2e/i18n-rtl-smoke.spec.ts', 'e2e', 2, 'uat-agent', ['E10-S2'], []);

// Round 5 — Finalize
addTest(
  5,
  'tests/unit/stub-presence.test.ts',
  'unit',
  7,
  'test-writer',
  ['E10-S3', 'E10-S4', 'E10-S5', 'E10-S6', 'E12-S4', 'E12-S5', 'E12-S6'],
  [],
);
addTest(5, 'tools/a11y/tests/scan.test.ts', 'unit', 5, 'test-writer', ['E12-S7'], []);
addTest(5, 'tests/a11y/ci-gate.test.ts', 'a11y', 3, 'test-writer', ['E12-S7'], []);
addTest(5, 'tests/integration/docker-compose-up.test.ts', 'integration', 4, 'integration-test-agent', ['E12-S1'], []);
addTest(5, 'tests/integration/health-endpoint.test.ts', 'integration', 3, 'integration-test-agent', ['E12-S1'], []);
addTest(5, 'tests/integration/ci-lint-chain.test.ts', 'integration', 5, 'integration-test-agent', ['E12-S2'], []);
addTest(
  5,
  'tests/integration/authz-matrix-census-gate.test.ts',
  'integration',
  4,
  'integration-test-agent',
  ['E12-S3'],
  ['SR-AUTHZ-002'],
);

// ── Verify coverage ──
const coveredStories = new Set();
for (const r of Object.values(rounds)) for (const t of r.testFiles) for (const s of t.stories) coveredStories.add(s);
const missing = allStoryIds.filter((s) => !coveredStories.has(s));
if (missing.length > 0) {
  console.error('ERROR: stories not covered by test plan:', missing);
  process.exit(1);
}

// Totals
const byRound = {};
let totalTests = 0;
for (const r of Object.values(rounds)) {
  const sum = r.testFiles.reduce((a, t) => a + t.testCount, 0);
  byRound[r.name] = sum;
  totalTests += sum;
}

const plan = {
  milestone: MILESTONE,
  generatedAt: new Date().toISOString(),
  totalRounds: 5,
  rounds: [rounds[1], rounds[2], rounds[3], rounds[4], rounds[5]],
  stories_covered: [...coveredStories].sort(),
  summary: { totalTests, byRound },
};

fs.writeFileSync(`${BUILD_DIR}/${MILESTONE}-test-plan.json`, JSON.stringify(plan, null, 2));

// ── Write strategy.md ──
const fileCount = plan.rounds.reduce((a, r) => a + r.testFiles.length, 0);
const strategy = `# M1 Test Strategy

**Milestone**: M1 — Foundation Platform
**Generated**: ${new Date().toISOString()}
**Total rounds**: 5 | **Total test files**: ${fileCount} | **Total test cases**: ${totalTests}

## 1. Overview

M1 runs 5 dependency-ordered TDD rounds. Each round has a RED→GREEN cycle: write tests first, verify they compile + fail, then implement until they pass. Previous-round tests must continue to pass after each new round's GREEN phase.

| Round | Name | Files | Tests | Writers | Builders |
|---|---|---|---|---|---|
${plan.rounds.map((r) => `| ${r.id} | ${r.name} | ${r.testFiles.length} | ${byRound[r.name]} | ${[...new Set(r.testFiles.map((t) => t.writer))].join(', ')} | ${r.builders.join(', ')} |`).join('\n')}

## 2. Coverage Goals

- **Line coverage**: ≥ 85% globally for new code, ≥ 100% for middleware pipeline (\`apps/api-gateway/src/middleware/\`) and policy engine (\`services/tenant/src/policy/\`).
- **Requirement traceability**: every FR-xx, NFR-xx, TR-xx, IR-xx, and SR-AUTH-xxx/SR-AUTHZ-xxx referenced in the M1 build packet maps to at least one test file.
- **Capability edges** (FEAT-001/002/022/023/026/034): every \`impacts\` / \`verify-no-change\` edge is proven by a named assertion (see §9).
- **Required Test Evidence** TE-01..TE-18 from the build packet: each TE maps to ≥1 named test (see §8).
- **Story coverage**: all 33 M1 stories appear in \`stories_covered[]\` with ≥ 1 test file referencing them.

## 3. Round 1 — Foundation (${byRound.foundation} tests)

Asserts: monorepo scaffolds & builds, custom ESLint rules fire correctly, design tokens exported, shadcn primitives render + keyboard accessible, Postgres migrations apply, RLS policies enforce tenant isolation on every \`tenant_id\` column, cross-tenant denial.

Stories: E12-S1, E12-S2, E10-S1, E1-S1 (schema + RLS).

## 4. Round 2 — Core Logic (${byRound.core} tests)

Asserts: scope/correlation/idempotency middleware chain with fail-closed semantics; evidence ledger hash-chain correctness + atomic append; audit emitter schema compliance; ledger integrity job detects tamper; policy engine deny-by-default + RBAC/ABAC decisions + auditor read-only; tenant provisioning idempotency with ledger event before success.

Stories: E1-S1, E1-S3, E1-S4, E1-S5, E1-S6, E1-S7, E1-S8.

## 5. Round 3 — API Layer (${byRound.api} tests)

Asserts: SAML/OIDC callbacks, refresh-token rotation + replay detection (family invalidation), authz static census detects unmapped routes, app-creation endpoint emits analytics + ledger events before 2xx, SSE stream with reconnect-resume via Last-Event-ID, pause/resume/cancel state machine, revisions + restore (non-destructive), signed preview URLs (tamper → 403), share-link domain allowlist + SSO redirect, presence/edit locks (Valkey TTL), template list + create-from-template, evidence/policy route integration.

Stories: E1-S2, E12-S3, E2-S1, E2-S4, E2-S5, E2-S6, E2-S8, E2-S9, E2-S10, E2-S11.

## 6. Round 4 — Frontend (${byRound.frontend} tests)

Playwright E2E via \`uat-agent\` covers browser-level UAT cases; component unit tests via \`test-writer\` cover logic. Every Playwright test name includes the corresponding UAT case ID from \`M1-uat-cases.json\` (e.g. \`[UAT-M1-001] landing page: hero renders with a11y AA\`).

Asserts: landing page hero + feature grid + CTA (WCAG 2.2 AA, axe zero-critical), workspace shell skip-link + focus traps + keyboard nav, workspace panels mount + app appears within 1s, Monaco lazy-loads and saves trigger revisions, visual patch overlay computes stable selectors, RTL layout smoke.

Stories: E10-S2, E10-S7, E2-S2, E2-S3, E2-S7.

## 7. Round 5 — Finalize (${byRound.finalize} tests)

Asserts: stub stories exist with \`@cobolt:defer-to: M{n}\` comments (E10-S3/S4/S5/S6, E12-S4/S5/S6), axe-core scanner runs, CI a11y gate fails on critical, Docker Compose boots all services, health endpoint responds, CI lint chain passes, authz-matrix census gate fails CI on unmapped route.

Stories: all M1 stubs + E12-S1 / E12-S2 / E12-S3 / E12-S7 CI integration.

## 8. Test Evidence Mapping (TE-01..TE-18)

| TE | Test File(s) |
|---|---|
| TE-01 | \`db/tests/cross-tenant-denial.test.ts\`, \`services/tenant/tests/provisioning.test.ts\` |
| TE-02 | \`apps/api-gateway/tests/scope.test.ts\`, \`apps/api-gateway/tests/correlation.test.ts\` |
| TE-03 | \`apps/api-gateway/tests/idempotency.test.ts\` |
| TE-04 | \`services/evidence-ledger/tests/hash-chain.test.ts\`, \`services/evidence-ledger/tests/writer-atomicity.test.ts\`, \`services/evidence-ledger/tests/tamper-detection.test.ts\` |
| TE-05 | \`services/evidence-ledger/tests/audit-emitter.test.ts\`, \`services/evidence-ledger/tests/audit-query.test.ts\` |
| TE-06 | \`services/tenant/tests/policy-engine.test.ts\`, \`services/tenant/tests/policy-rbac.test.ts\`, \`services/tenant/tests/policy-deny-by-default.test.ts\` |
| TE-07 | \`services/auth/tests/saml.test.ts\`, \`services/auth/tests/oidc.test.ts\`, \`services/auth/tests/session-manager.test.ts\` |
| TE-08 | \`tools/authz-census/tests/scan-routes.test.ts\`, \`tests/authz/census.test.ts\`, \`tests/integration/authz-matrix-census-gate.test.ts\` |
| TE-09 | \`services/app-builder/tests/create-app.test.ts\`, \`apps/api-gateway/tests/routes-apps.test.ts\` |
| TE-10 | \`services/app-builder/tests/stream.test.ts\`, \`services/app-builder/tests/stream-reconnect.test.ts\`, \`services/app-builder/tests/state-machine.test.ts\`, \`services/app-builder/tests/lifecycle.test.ts\` |
| TE-11 | \`services/app-builder/tests/preview.test.ts\`, \`services/app-builder/tests/signed-url.test.ts\` |
| TE-12 | \`services/collaboration/tests/share-links.test.ts\` |
| TE-13 | \`tests/e2e/landing.spec.ts\`, \`tests/a11y/landing.a11y.spec.ts\` |
| TE-14 | \`tests/e2e/workspace-shell.spec.ts\`, \`tests/a11y/workspace.a11y.spec.ts\`, \`apps/web/src/app/(workspace)/components/__tests__/skip-link.test.tsx\` |
| TE-15 | \`services/tenant/tests/policy-abac-injection-denied.test.ts\` |
| TE-16 | \`services/auth/tests/refresh-replay-invalidation.test.ts\` |
| TE-17 | \`apps/api-gateway/tests/idempotency.test.ts\` (replay case) |
| TE-18 | \`db/tests/rls-census.test.ts\`, \`db/tests/cross-tenant-denial.test.ts\` |

## 9. Capability Edge Proof

| Edge | Test Assertion |
|---|---|
| FEAT-001 → analytics | \`create-app.test.ts\` asserts \`app.create.requested\` + \`app.create.succeeded\` events with tenant/app_id labels |
| FEAT-001 → audit-log | Same; asserts ledger event appended before 2xx |
| FEAT-001 → permissions | Same + \`policy-engine.test.ts\` (only \`builder\` role allowed) |
| FEAT-001 → dashboard | \`workspace-app-panels.spec.ts\` asserts new app appears within 1s |
| FEAT-002 → accessibility | \`workspace.a11y.spec.ts\`, \`landing.a11y.spec.ts\` — axe zero critical |
| FEAT-002 → i18n | \`i18n-rtl-smoke.spec.ts\` — RTL + long-string renders without overflow |
| FEAT-002 → observability | \`workspace-shell.spec.ts\` asserts page-view OTLP span emitted |
| FEAT-022 → API | \`pipeline.test.ts\` asserts every mutating endpoint carries scope + idempotency headers |
| FEAT-022 → data | \`rls-census.test.ts\` — every tenant_id column has policy |
| FEAT-022 → test | \`cross-tenant-denial.test.ts\` + \`policy-abac-injection-denied.test.ts\` |
| FEAT-023 → audit-log | \`integrity-job.test.ts\`, \`tamper-detection.test.ts\` |
| FEAT-023 → rollout | \`writer.test.ts\` asserts schema-version gate |
| FEAT-023 → observability | \`writer.test.ts\` asserts ledger write latency metric exported |
| FEAT-026 → permissions | \`policy-rbac.test.ts\` (admin protected; auditor read-only) |
| FEAT-026 → admin | \`stub-presence.test.ts\` asserts admin stub exists |
| FEAT-026 → audit-log | \`policy-rbac.test.ts\` asserts denied request emits audit event |
| FEAT-034 → observability | \`stub-presence.test.ts\` asserts connector routes return 501 + audit in M1 |

## 10. Quality Gates

- Every round's tests MUST compile and FAIL before builder dispatch (TDD RED hard gate).
- Every round's tests MUST pass at GREEN before next round starts.
- After all 5 rounds: full test suite green.
- Vitest coverage threshold: 85% lines/functions/branches/statements globally; 100% for middleware + policy engine.
- Playwright: zero critical axe findings on landing + workspace; Lighthouse a11y ≥ 90 on landing.

## 11. Writer Assignments

| Round | test-writer | integration-test-agent | db-test-agent | uat-agent |
|---|---|---|---|---|
| 1 | unit tests, lint rules, UI primitives | monorepo boot | schema, RLS, migrations | — |
| 2 | policy/hash-chain/state-machine units | middleware, provisioning, writer/emitter integrations | — | — |
| 3 | token/signed-url/scan-route units | all HTTP handler + A2A integration | — | — |
| 4 | component unit tests | — | — | all Playwright E2E + a11y |
| 5 | stub presence, a11y tool units | Docker, CI, a11y, authz gate | — | — |
`;

fs.writeFileSync(`${BUILD_DIR}/${MILESTONE}-test-strategy.md`, strategy);

console.log(
  JSON.stringify({ fileCount, totalTests, byRound, storiesCovered: plan.stories_covered.length, missing }, null, 2),
);
