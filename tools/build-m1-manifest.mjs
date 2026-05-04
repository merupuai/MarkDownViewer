#!/usr/bin/env node
// Programmatic task manifest builder for M1 — main-session write.
import fs from 'node:fs';
import path from 'node:path';

const OUT = '_cobolt-output/latest/build/M1/M1-task-manifest.json';

let tid = 0;
const T = () => `T${String(++tid).padStart(3, '0')}`;

const epics = [];
const fileOwnership = {};
const allTasks = [];
const waves = { 1: [], 2: [], 3: [], 4: [], 5: [] };

function addFile(file, taskId, isNew = true) {
  if (fileOwnership[file]) {
    throw new Error(`Duplicate ownership: ${file} (task ${taskId} vs ${fileOwnership[file].taskId})`);
  }
  fileOwnership[file] = { taskId, new: isNew };
}
function addTask(t) {
  allTasks.push(t);
  waves[t.wave].push(t.id);
  (t.files || []).forEach((f) => {
    if (!fileOwnership[f]) addFile(f, t.id, t._new !== false);
  });
  delete t._new;
  return t;
}

// ── E12 Platform Bootstrap ──
const e12 = { id: 'E12', title: 'Platform Bootstrap & Quality Harness', stories: [] };

e12.stories.push({
  id: 'E12-S1',
  title: 'Monorepo setup (pnpm + Turborepo/Nx)',
  tasks: [
    addTask({
      id: T(),
      title: 'Initialize pnpm + Turborepo monorepo',
      assignedAgent: 'devops-agent',
      requirementIds: ['TR-300', 'TR-105'],
      frIds: [],
      nfrIds: [],
      trIds: ['TR-300', 'TR-105'],
      irIds: [],
      files: ['package.json', 'pnpm-workspace.yaml', 'turbo.json', 'tsconfig.base.json', '.node-version'],
      surfaceImpacts: [],
      capabilityEdges: [],
      requiredIntegrationProof: [],
      doNotBreakContracts: [],
      wave: 1,
      dependsOn: [],
      acceptanceCriteria: [
        'pnpm install completes',
        'turbo run build works across workspaces',
        'TypeScript strict enforced root-level',
        'Node 22 LTS required via .node-version',
      ],
    }),
    addTask({
      id: T(),
      title: 'Provision apps + services + packages workspace folders',
      assignedAgent: 'devops-agent',
      requirementIds: [],
      frIds: [],
      nfrIds: [],
      trIds: ['TR-101'],
      irIds: [],
      files: [
        'apps/web/package.json',
        'apps/api-gateway/package.json',
        'services/auth/package.json',
        'services/tenant/package.json',
        'services/evidence-ledger/package.json',
        'services/app-builder/package.json',
        'services/collaboration/package.json',
        'packages/ui/package.json',
        'packages/authz-matrix/package.json',
        'packages/observability/package.json',
      ],
      surfaceImpacts: [],
      capabilityEdges: [],
      requiredIntegrationProof: [],
      doNotBreakContracts: [],
      wave: 1,
      dependsOn: ['T001'],
      acceptanceCriteria: [
        'Every workspace resolves to its own package',
        'Cross-workspace imports enforced via tsconfig paths',
      ],
    }),
  ],
});

e12.stories.push({
  id: 'E12-S2',
  title: 'CI lint rules (reusable_assets ban, RLS requirement, no-any)',
  tasks: [
    addTask({
      id: T(),
      title: 'Root ESLint config + custom CoBolt rules package',
      assignedAgent: 'devops-agent',
      requirementIds: ['TR-105', 'NFR-13'],
      frIds: [],
      nfrIds: ['NFR-13'],
      trIds: ['TR-105'],
      irIds: [],
      files: [
        'tools/lint-rules/package.json',
        'tools/lint-rules/index.ts',
        'tools/lint-rules/rules/no-reusable-assets.ts',
        'tools/lint-rules/rules/rls-required.ts',
        'tools/lint-rules/rules/no-any-leak.ts',
        'eslint.config.mjs',
      ],
      surfaceImpacts: ['test'],
      capabilityEdges: [],
      requiredIntegrationProof: [],
      doNotBreakContracts: [],
      wave: 1,
      dependsOn: ['T001'],
      acceptanceCriteria: [
        'cobolt/no-reusable-assets blocks reusable_assets/ imports',
        'cobolt/rls-required flags raw Postgres queries',
        'cobolt/no-any-leak flags cross-module any casts',
      ],
    }),
    addTask({
      id: T(),
      title: 'CI pipeline (lint→typecheck→test→a11y→authz-census→migration→bundle-budget)',
      assignedAgent: 'devops-agent',
      requirementIds: ['TR-300', 'TR-105'],
      frIds: [],
      nfrIds: [],
      trIds: ['TR-300'],
      irIds: [],
      files: ['.github/workflows/ci.yml', '.github/workflows/pr-gates.yml'],
      surfaceImpacts: [],
      capabilityEdges: [],
      requiredIntegrationProof: [],
      doNotBreakContracts: [],
      wave: 1,
      dependsOn: ['T003'],
      acceptanceCriteria: ['All 8 gates run in order on PR', 'CI fails if any gate red'],
    }),
  ],
});

e12.stories.push({
  id: 'E12-S3',
  title: 'Authz matrix + static census',
  tasks: [
    addTask({
      id: T(),
      title: 'authz-matrix.json schema and seed for M1 routes',
      assignedAgent: 'backend-dev',
      requirementIds: ['SR-AUTHZ-002'],
      frIds: ['FR-35'],
      nfrIds: [],
      trIds: [],
      irIds: [],
      files: ['packages/authz-matrix/src/matrix.schema.ts', 'authz-matrix.json'],
      surfaceImpacts: ['permissions', 'admin'],
      capabilityEdges: ['FEAT-026->permissions'],
      requiredIntegrationProof: ['authz-matrix.json validates against schema in CI'],
      doNotBreakContracts: [],
      wave: 3,
      dependsOn: ['T003'],
      acceptanceCriteria: ['Every M1 route × role tuple has explicit effect', 'Schema validates JSON'],
    }),
    addTask({
      id: T(),
      title: 'Static authz census tool (scan-routes vs authz-matrix diff)',
      assignedAgent: 'backend-dev',
      requirementIds: ['SR-AUTHZ-002'],
      frIds: [],
      nfrIds: [],
      trIds: [],
      irIds: [],
      files: [
        'tools/authz-census/package.json',
        'tools/authz-census/src/scan-routes.ts',
        'tools/authz-census/src/diff.ts',
        'tools/authz-census/bin.ts',
        'tests/authz/census.test.ts',
      ],
      surfaceImpacts: ['test', 'permissions'],
      capabilityEdges: ['FEAT-022->test', 'FEAT-022->data'],
      requiredIntegrationProof: ['Census fails CI on unmapped route (TE-08)'],
      doNotBreakContracts: [],
      wave: 3,
      dependsOn: ['T005'],
      acceptanceCriteria: ['Scans all /v1 routes', 'Exits non-zero if any route lacks matrix entry'],
    }),
  ],
});

e12.stories.push({
  id: 'E12-S7',
  title: 'Accessibility scanner (axe-core + Playwright)',
  tasks: [
    addTask({
      id: T(),
      title: 'axe-core + Playwright a11y scanner harness',
      assignedAgent: 'test-writer',
      requirementIds: ['NFR-a11y'],
      frIds: [],
      nfrIds: [],
      trIds: [],
      irIds: [],
      files: [
        'tools/a11y/package.json',
        'tools/a11y/src/scan.ts',
        'tools/a11y/playwright.config.ts',
        'tests/a11y/landing.a11y.spec.ts',
        'tests/a11y/workspace.a11y.spec.ts',
      ],
      surfaceImpacts: ['accessibility', 'test'],
      capabilityEdges: ['FEAT-002->accessibility'],
      requiredIntegrationProof: ['axe zero critical on landing+workspace (TE-13, TE-14)'],
      doNotBreakContracts: [],
      wave: 5,
      dependsOn: ['T004'],
      acceptanceCriteria: ['Scanner reports by severity', 'CI fails on critical', 'Runs on /landing, /workspace'],
    }),
  ],
});

// E12 stubs
for (const [sid, title, deferTo, filePath] of [
  ['E12-S4', 'Authz deep runtime tests (M2 groundwork)', 'M2', 'tests/authz/runtime-deep.stub.test.ts'],
  ['E12-S5', 'Chaos engineering harness (M2 stub)', 'M2', 'tools/chaos/src/index.ts'],
  ['E12-S6', 'Load-baseline harness k6 (M2 stub)', 'M2', 'tools/k6-load/scenarios/baseline.js'],
]) {
  e12.stories.push({
    id: sid,
    title,
    tasks: [
      addTask({
        id: T(),
        title: `${title} M1 scaffold`,
        assignedAgent: sid === 'E12-S4' ? 'test-writer' : 'devops-agent',
        requirementIds: sid === 'E12-S4' ? ['SR-AUTHZ-003'] : [],
        frIds: [],
        nfrIds: [],
        trIds: [],
        irIds: [],
        files: [filePath],
        surfaceImpacts: [],
        capabilityEdges: [],
        requiredIntegrationProof: [`@cobolt:defer-to: ${deferTo}`],
        doNotBreakContracts: [],
        wave: 5,
        dependsOn: sid === 'E12-S4' ? ['T006'] : [],
        acceptanceCriteria: [`Stub exists with @cobolt:defer-to: ${deferTo} comment`],
      }),
    ],
  });
}
epics.push(e12);

// ── E10 Design System & UI Shell ──
const e10 = { id: 'E10', title: 'Design System & Workspace UI Shell', stories: [] };

e10.stories.push({
  id: 'E10-S1',
  title: 'Design tokens + base shadcn/ui primitives',
  tasks: [
    addTask({
      id: T(),
      title: 'Design tokens (design-tokens.json) + tailwind preset',
      assignedAgent: 'ui-component-builder',
      requirementIds: [],
      frIds: [],
      nfrIds: [],
      trIds: [],
      irIds: [],
      files: ['design-tokens.json', 'packages/ui/tailwind-preset.ts', 'packages/ui/src/tokens.ts'],
      surfaceImpacts: ['accessibility'],
      capabilityEdges: [],
      requiredIntegrationProof: ['WCAG 2.2 AA contrast on primary/on-primary'],
      doNotBreakContracts: [],
      wave: 1,
      dependsOn: ['T002'],
      acceptanceCriteria: [
        'Tokens cover color/typography/spacing/motion/radius',
        'Tailwind preset exposes token names',
      ],
    }),
    addTask({
      id: T(),
      title: 'shadcn/ui primitives wrapped for CoBolt (Button, Input, Dialog, Card, Toast, Select, Tabs)',
      assignedAgent: 'ui-component-builder',
      requirementIds: [],
      frIds: [],
      nfrIds: [],
      trIds: [],
      irIds: [],
      files: [
        'packages/ui/src/components/button.tsx',
        'packages/ui/src/components/input.tsx',
        'packages/ui/src/components/dialog.tsx',
        'packages/ui/src/components/card.tsx',
        'packages/ui/src/components/toast.tsx',
        'packages/ui/src/components/select.tsx',
        'packages/ui/src/components/tabs.tsx',
        'packages/ui/src/index.ts',
        'packages/ui/src/lib/utils.ts',
      ],
      surfaceImpacts: ['accessibility'],
      capabilityEdges: ['FEAT-002->accessibility'],
      requiredIntegrationProof: ['Each primitive keyboard-accessible'],
      doNotBreakContracts: [],
      wave: 1,
      dependsOn: ['T011'],
      acceptanceCriteria: ['Every primitive exports props type', 'Tailwind classes use tokens'],
    }),
  ],
});

e10.stories.push({
  id: 'E10-S2',
  title: 'Workspace shell + navigation',
  tasks: [
    addTask({
      id: T(),
      title: 'Workspace shell layout + sidebar + topbar + skip-link',
      assignedAgent: 'frontend-dev',
      requirementIds: ['FR-02'],
      frIds: ['FR-02'],
      nfrIds: [],
      trIds: [],
      irIds: [],
      files: [
        'apps/web/src/app/(workspace)/layout.tsx',
        'apps/web/src/app/(workspace)/components/sidebar.tsx',
        'apps/web/src/app/(workspace)/components/topbar.tsx',
        'apps/web/src/app/(workspace)/components/skip-link.tsx',
      ],
      surfaceImpacts: ['accessibility', 'observability', 'i18n'],
      capabilityEdges: ['FEAT-002->accessibility', 'FEAT-002->observability', 'FEAT-002->i18n'],
      requiredIntegrationProof: ['TE-14 keyboard nav+focus traps; page-view span in OTLP'],
      doNotBreakContracts: [],
      wave: 4,
      dependsOn: ['T012', 'T031'],
      acceptanceCriteria: [
        'Skip-to-content link present',
        'Focus trap on modals',
        'RTL locale renders without layout break',
      ],
    }),
  ],
});

e10.stories.push({
  id: 'E10-S7',
  title: 'Landing page (marketing minimal)',
  tasks: [
    addTask({
      id: T(),
      title: 'Landing page route + hero + features + CTA',
      assignedAgent: 'frontend-dev',
      requirementIds: [],
      frIds: [],
      nfrIds: [],
      trIds: [],
      irIds: [],
      files: [
        'apps/web/src/app/(marketing)/page.tsx',
        'apps/web/src/app/(marketing)/layout.tsx',
        'apps/web/src/app/(marketing)/components/hero.tsx',
        'apps/web/src/app/(marketing)/components/feature-grid.tsx',
        'apps/web/src/app/(marketing)/components/cta.tsx',
      ],
      surfaceImpacts: ['accessibility', 'i18n'],
      capabilityEdges: ['FEAT-002->accessibility'],
      requiredIntegrationProof: ['TE-13 Lighthouse a11y ≥ 90 and WCAG 2.2 AA'],
      doNotBreakContracts: [],
      wave: 4,
      dependsOn: ['T012'],
      acceptanceCriteria: ['axe zero critical', 'Lighthouse a11y ≥ 90', 'Renders at 320px+ viewport'],
    }),
  ],
});

for (const [sid, title, route, deferTo] of [
  ['E10-S3', 'Admin console', '/admin', 'M2'],
  ['E10-S4', 'Auditor console', '/auditor', 'M3'],
  ['E10-S5', 'Studio workspace', '/studio', 'M4'],
  ['E10-S6', 'Billing console', '/billing', 'M3'],
]) {
  e10.stories.push({
    id: sid,
    title: `${title} (${deferTo} stub)`,
    tasks: [
      addTask({
        id: T(),
        title: `${title} M1 scaffold`,
        assignedAgent: 'frontend-dev',
        requirementIds: [],
        frIds: [],
        nfrIds: [],
        trIds: [],
        irIds: [],
        files: [`apps/web/src/app${route}/page.tsx`],
        surfaceImpacts: [],
        capabilityEdges: [],
        requiredIntegrationProof: [`@cobolt:defer-to: ${deferTo}`],
        doNotBreakContracts: [],
        wave: 5,
        dependsOn: ['T016'],
        acceptanceCriteria: [`Route renders "not implemented in M1" with @cobolt:defer-to: ${deferTo}`],
      }),
    ],
  });
}
epics.push(e10);

// ── E1 BC04 Core ──
const e1 = { id: 'E1', title: 'Platform Foundation & Tenant Scope (BC04 + BC01 core)', stories: [] };

e1.stories.push({
  id: 'E1-S1',
  title: 'Tenant & user provisioning (RLS in force)',
  tasks: [
    addTask({
      id: T(),
      title: 'Postgres schema: tenants, users, role_bindings, projects, RLS policies',
      assignedAgent: 'db-migration-writer',
      requirementIds: ['FR-30', 'FR-35', 'NFR-04', 'SR-AUTH-003'],
      frIds: ['FR-30', 'FR-35'],
      nfrIds: ['NFR-04'],
      trIds: [],
      irIds: [],
      files: [
        'db/migrations/0001_tenants.sql',
        'db/migrations/0002_users.sql',
        'db/migrations/0003_role_bindings.sql',
        'db/migrations/0004_projects.sql',
        'db/migrations/0005_rls_policies.sql',
      ],
      surfaceImpacts: ['data', 'permissions', 'audit-log'],
      capabilityEdges: ['FEAT-022->data', 'FEAT-022->test'],
      requiredIntegrationProof: ['TE-18 RLS census every tenant_id column'],
      doNotBreakContracts: ['tenant_id session GUC contract'],
      wave: 2,
      dependsOn: ['T002'],
      acceptanceCriteria: [
        'Tables created tenant_id NOT NULL',
        "RLS policies enforce current_setting('cobolt.tenant_id')::uuid = tenant_id",
        'Cross-tenant rejected (TE-01, TE-18)',
      ],
    }),
    addTask({
      id: T(),
      title: 'Tenant provisioning service (tenant + default project + admin user + role bindings)',
      assignedAgent: 'backend-dev',
      requirementIds: ['FR-30', 'FR-35', 'NFR-04'],
      frIds: ['FR-30', 'FR-35'],
      nfrIds: ['NFR-04'],
      trIds: [],
      irIds: [],
      files: [
        'services/tenant/src/provisioning.ts',
        'services/tenant/src/tenant-repository.ts',
        'services/tenant/src/index.ts',
        'services/tenant/tests/provisioning.test.ts',
      ],
      surfaceImpacts: ['audit-log', 'permissions'],
      capabilityEdges: ['FEAT-022->data'],
      requiredIntegrationProof: ['TE-01 cross-tenant negative path'],
      doNotBreakContracts: [],
      wave: 2,
      dependsOn: ['T021'],
      acceptanceCriteria: [
        'onboard(tenant,adminEmail)→tenant+admin+default project',
        'Idempotent on retry',
        'Ledger event before success',
      ],
    }),
  ],
});

e1.stories.push({
  id: 'E1-S3',
  title: 'Scope + correlation middleware',
  tasks: [
    addTask({
      id: T(),
      title: 'Scope + correlation middleware (X-Tenant-Id, X-Correlation-Id)',
      assignedAgent: 'api-endpoint-builder',
      requirementIds: ['FR-30', 'FR-31', 'IR-052'],
      frIds: ['FR-30', 'FR-31'],
      nfrIds: [],
      trIds: [],
      irIds: ['IR-052'],
      files: [
        'apps/api-gateway/src/middleware/scope.ts',
        'apps/api-gateway/src/middleware/correlation.ts',
        'apps/api-gateway/src/middleware/pipeline.ts',
        'apps/api-gateway/tests/scope.test.ts',
      ],
      surfaceImpacts: ['API', 'observability'],
      capabilityEdges: ['FEAT-022->API', 'FEAT-002->observability'],
      requiredIntegrationProof: ['TE-02 missing/mismatched scope rejection'],
      doNotBreakContracts: ['Downstream services require scope propagation'],
      wave: 2,
      dependsOn: ['T022'],
      acceptanceCriteria: [
        'Missing X-Tenant-Id→400',
        'Missing X-Correlation-Id generated+echoed',
        'Mismatch tenant→403+audit',
        'session GUC cobolt.tenant_id set',
      ],
    }),
  ],
});

e1.stories.push({
  id: 'E1-S4',
  title: 'Idempotency middleware',
  tasks: [
    addTask({
      id: T(),
      title: 'Idempotency middleware + idempotency_keys table',
      assignedAgent: 'api-endpoint-builder',
      requirementIds: ['FR-31', 'IR-046'],
      frIds: ['FR-31'],
      nfrIds: [],
      trIds: [],
      irIds: ['IR-046'],
      files: [
        'db/migrations/0006_idempotency_keys.sql',
        'apps/api-gateway/src/middleware/idempotency.ts',
        'apps/api-gateway/tests/idempotency.test.ts',
      ],
      surfaceImpacts: ['API', 'data'],
      capabilityEdges: ['FEAT-022->API', 'FEAT-022->data'],
      requiredIntegrationProof: ['TE-03 replay identical; diff body same key→409; 24h TTL'],
      doNotBreakContracts: [],
      wave: 2,
      dependsOn: ['T023'],
      acceptanceCriteria: ['Same key returns stored body+status', 'Different body same key→409', '24h TTL'],
    }),
  ],
});

e1.stories.push({
  id: 'E1-S5',
  title: 'Evidence ledger writer (hash-chain append)',
  tasks: [
    addTask({
      id: T(),
      title: 'evidence_events table + append-only ledger writer + hash-chain',
      assignedAgent: 'backend-dev',
      requirementIds: ['FR-32', 'IR-025', 'IR-053', 'SR-AUTH-010'],
      frIds: ['FR-32'],
      nfrIds: [],
      trIds: [],
      irIds: ['IR-025', 'IR-053'],
      files: [
        'db/migrations/0007_evidence_events.sql',
        'services/evidence-ledger/src/writer.ts',
        'services/evidence-ledger/src/hash-chain.ts',
        'services/evidence-ledger/src/index.ts',
        'services/evidence-ledger/tests/writer.test.ts',
        'services/evidence-ledger/tests/hash-chain.test.ts',
      ],
      surfaceImpacts: ['audit-log', 'rollout', 'observability'],
      capabilityEdges: ['FEAT-023->audit-log', 'FEAT-023->rollout', 'FEAT-023->observability'],
      requiredIntegrationProof: ['TE-04 hash chain; atomic append; signed event verified before side effect'],
      doNotBreakContracts: ['Ledger writer API is M1-produced cross-milestone contract'],
      wave: 2,
      dependsOn: ['T024'],
      acceptanceCriteria: [
        'h_n=sha256(prev+payload)',
        'Atomic append with handler commit',
        'HMAC-SHA-256/JWS signature verified before append',
        'Ledger write latency metric in OTLP',
      ],
    }),
  ],
});

e1.stories.push({
  id: 'E1-S6',
  title: 'Audit event emitter',
  tasks: [
    addTask({
      id: T(),
      title: 'Audit event emitter + query endpoint',
      assignedAgent: 'backend-dev',
      requirementIds: ['FR-32', 'FR-35', 'IR-052'],
      frIds: ['FR-32', 'FR-35'],
      nfrIds: [],
      trIds: [],
      irIds: ['IR-052'],
      files: [
        'services/evidence-ledger/src/audit-emitter.ts',
        'services/evidence-ledger/src/audit-query.ts',
        'services/evidence-ledger/tests/audit-emitter.test.ts',
      ],
      surfaceImpacts: ['audit-log', 'admin'],
      capabilityEdges: ['FEAT-026->audit-log', 'FEAT-023->audit-log'],
      requiredIntegrationProof: ['TE-05 schema-valid events'],
      doNotBreakContracts: [],
      wave: 2,
      dependsOn: ['T025'],
      acceptanceCriteria: [
        'Every auth-fail/policy-deny/export/support→event',
        'Events carry actor/verb/object/scope/ts/correlation_id',
        'Query supports date+tenant filter',
      ],
    }),
  ],
});

e1.stories.push({
  id: 'E1-S7',
  title: 'Ledger integrity job (nightly)',
  tasks: [
    addTask({
      id: T(),
      title: 'Nightly hash-chain integrity job + tamper detection test',
      assignedAgent: 'backend-dev',
      requirementIds: ['FR-32', 'IR-025'],
      frIds: ['FR-32'],
      nfrIds: [],
      trIds: [],
      irIds: ['IR-025'],
      files: ['services/evidence-ledger/src/integrity-job.ts', 'services/evidence-ledger/tests/integrity-job.test.ts'],
      surfaceImpacts: ['audit-log', 'observability'],
      capabilityEdges: ['FEAT-023->audit-log', 'FEAT-023->observability'],
      requiredIntegrationProof: ['TE-04 ext: tamper detected on injected-hash corruption'],
      doNotBreakContracts: [],
      wave: 2,
      dependsOn: ['T025'],
      acceptanceCriteria: [
        'Walks chain end-to-end',
        'Emits OTLP metric+alert on break',
        'Synthetic tamper fixture proves detection',
      ],
    }),
  ],
});

e1.stories.push({
  id: 'E1-S8',
  title: 'Policy engine baseline (RBAC + ABAC)',
  tasks: [
    addTask({
      id: T(),
      title: 'RBAC/ABAC engine + policy_rules + evaluate() API',
      assignedAgent: 'backend-dev',
      requirementIds: ['FR-33', 'FR-35', 'SR-AUTHZ-001', 'SR-AUTHZ-002', 'SR-AUTHZ-004'],
      frIds: ['FR-33', 'FR-35'],
      nfrIds: [],
      trIds: [],
      irIds: [],
      files: [
        'db/migrations/0008_policy_rules.sql',
        'services/tenant/src/policy/engine.ts',
        'services/tenant/src/policy/rbac.ts',
        'services/tenant/src/policy/abac.ts',
        'services/tenant/src/policy/index.ts',
        'services/tenant/tests/policy-engine.test.ts',
      ],
      surfaceImpacts: ['permissions', 'audit-log', 'admin'],
      capabilityEdges: ['FEAT-026->permissions', 'FEAT-026->audit-log'],
      requiredIntegrationProof: [
        'TE-06 RBAC 403+audit; ABAC data-class; deny-by-default; TE-15 abuse ABAC injection blocked',
      ],
      doNotBreakContracts: ['evaluate() signature is M1-produced cross-milestone contract'],
      wave: 2,
      dependsOn: ['T022'],
      acceptanceCriteria: [
        'evaluate(subject,action,resource,env)→allow|deny|undefined',
        'Deny-by-default',
        'Auditor role 403+audit on write',
        'ABAC attrs per-request not from body (TE-15)',
      ],
    }),
  ],
});

e1.stories.push({
  id: 'E1-S2',
  title: 'SSO via SAML/OIDC',
  tasks: [
    addTask({
      id: T(),
      title: 'SAML assertion callback handler',
      assignedAgent: 'backend-dev',
      requirementIds: ['FR-35', 'FR-42', 'SR-AUTH-001', 'SR-AUTH-005', 'SR-AUTH-006'],
      frIds: ['FR-35', 'FR-42'],
      nfrIds: [],
      trIds: [],
      irIds: [],
      files: [
        'services/auth/src/saml/callback.ts',
        'services/auth/src/saml/validate.ts',
        'services/auth/tests/saml.test.ts',
      ],
      surfaceImpacts: ['permissions'],
      capabilityEdges: [],
      requiredIntegrationProof: [
        'TE-07 signature verify; replay prevent NotOnOrAfter+unique ID; cookies Secure+HttpOnly+SameSite',
      ],
      doNotBreakContracts: [],
      wave: 3,
      dependsOn: ['T022'],
      acceptanceCriteria: [
        'Signature verified against IdP cert',
        'Replayed assertion rejected',
        'Session cookie Secure+HttpOnly+SameSite=Lax',
      ],
    }),
    addTask({
      id: T(),
      title: 'OIDC token exchange + session + refresh rotation',
      assignedAgent: 'backend-dev',
      requirementIds: ['FR-35', 'FR-42', 'SR-AUTH-006'],
      frIds: ['FR-35', 'FR-42'],
      nfrIds: [],
      trIds: [],
      irIds: [],
      files: [
        'services/auth/src/oidc/callback.ts',
        'services/auth/src/session/manager.ts',
        'services/auth/src/session/refresh-rotation.ts',
        'db/migrations/0009_sessions.sql',
        'services/auth/tests/oidc.test.ts',
        'services/auth/tests/refresh-rotation.test.ts',
      ],
      surfaceImpacts: ['permissions', 'audit-log'],
      capabilityEdges: [],
      requiredIntegrationProof: ['TE-16 abuse replayed refresh→401+invalidates family'],
      doNotBreakContracts: ['Refresh-token HttpOnly+rotation contract'],
      wave: 3,
      dependsOn: ['T032'],
      acceptanceCriteria: [
        'Access token TTL ≤ 10 min, memory-only',
        'Refresh rotates each use',
        'Replayed refresh invalidates family+audit',
        'JIT only if tenant flag',
      ],
    }),
  ],
});
epics.push(e1);

// ── E2 Builder Workspace ──
const e2 = { id: 'E2', title: 'Builder Workspace & App Creation (BC01)', stories: [] };

e2.stories.push({
  id: 'E2-S1',
  title: 'Create app from prompt',
  tasks: [
    addTask({
      id: T(),
      title: 'POST /v1/apps endpoint + app-builder service + apps migration',
      assignedAgent: 'api-endpoint-builder',
      requirementIds: ['FR-01', 'IR-001', 'IR-040', 'NFR-02'],
      frIds: ['FR-01'],
      nfrIds: ['NFR-02'],
      trIds: [],
      irIds: ['IR-001', 'IR-040'],
      files: [
        'db/migrations/0010_apps.sql',
        'services/app-builder/src/create-app.ts',
        'services/app-builder/src/app-repository.ts',
        'services/app-builder/src/index.ts',
        'apps/api-gateway/src/routes/apps.ts',
        'services/app-builder/tests/create-app.test.ts',
      ],
      surfaceImpacts: ['analytics', 'audit-log', 'permissions', 'dashboard', 'API'],
      capabilityEdges: ['FEAT-001->analytics', 'FEAT-001->audit-log', 'FEAT-001->permissions', 'FEAT-001->dashboard'],
      requiredIntegrationProof: [
        'TE-09 server-side only; analytics requested+succeeded events; ledger before 2xx; builder role only',
      ],
      doNotBreakContracts: [],
      wave: 3,
      dependsOn: ['T021', 'T023', 'T024', 'T025', 'T029'],
      acceptanceCriteria: [
        'Creates app row tenant+project+owner+status=creating',
        'Server-side only',
        'Analytics events emitted',
        'Ledger before 2xx',
        'Only builder role (E1-S8 denies others)',
      ],
    }),
  ],
});

e2.stories.push({
  id: 'E2-S4',
  title: 'Stream generation via SSE',
  tasks: [
    addTask({
      id: T(),
      title: 'Mock LLM provider (M1 seam; real provider in M2)',
      assignedAgent: 'backend-dev',
      requirementIds: ['FR-06', 'NFR-02'],
      frIds: ['FR-06'],
      nfrIds: ['NFR-02'],
      trIds: [],
      irIds: [],
      files: ['services/app-builder/src/providers/mock-provider.ts'],
      surfaceImpacts: [],
      capabilityEdges: [],
      requiredIntegrationProof: ['@cobolt:defer-real-provider: M2'],
      doNotBreakContracts: ['Provider interface stable M1/M2'],
      wave: 3,
      dependsOn: [],
      acceptanceCriteria: ['Mock yields deterministic stream', '@cobolt:defer-real-provider: M2 comment present'],
    }),
    addTask({
      id: T(),
      title: 'GET /v1/apps/{id}/stream SSE endpoint + reconnect-resume',
      assignedAgent: 'api-endpoint-builder',
      requirementIds: ['FR-06', 'IR-005', 'NFR-02'],
      frIds: ['FR-06'],
      nfrIds: ['NFR-02'],
      trIds: [],
      irIds: ['IR-005'],
      files: [
        'apps/api-gateway/src/routes/apps-stream.ts',
        'services/app-builder/src/stream-manager.ts',
        'services/app-builder/tests/stream.test.ts',
      ],
      surfaceImpacts: ['API', 'observability'],
      capabilityEdges: [],
      requiredIntegrationProof: ['TE-10 reconnect resumes; state transitions correct'],
      doNotBreakContracts: [],
      wave: 3,
      dependsOn: ['T035', 'T037'],
      acceptanceCriteria: ['SSE emits events with monotonic IDs', 'Last-Event-ID resumes', 'Heartbeat 15s'],
    }),
  ],
});

e2.stories.push({
  id: 'E2-S5',
  title: 'Pause / resume / cancel workflows',
  tasks: [
    addTask({
      id: T(),
      title: 'Pause/resume/cancel endpoints + state machine',
      assignedAgent: 'api-endpoint-builder',
      requirementIds: ['FR-07', 'NFR-03', 'IR-041'],
      frIds: ['FR-07'],
      nfrIds: ['NFR-03'],
      trIds: [],
      irIds: ['IR-041'],
      files: [
        'apps/api-gateway/src/routes/apps-lifecycle.ts',
        'services/app-builder/src/state-machine.ts',
        'services/app-builder/tests/lifecycle.test.ts',
      ],
      surfaceImpacts: ['API', 'audit-log'],
      capabilityEdges: [],
      requiredIntegrationProof: ['TE-10 state transitions emit events'],
      doNotBreakContracts: [],
      wave: 3,
      dependsOn: ['T038'],
      acceptanceCriteria: [
        'SM: creating→streaming→paused→resumed|cancelled|completed',
        'Invalid transition→409',
        'Each transition emits ledger+audit',
      ],
    }),
  ],
});

e2.stories.push({
  id: 'E2-S6',
  title: 'Revisions + branches + restore',
  tasks: [
    addTask({
      id: T(),
      title: 'app_revisions + revision/branch/restore service',
      assignedAgent: 'db-migration-writer',
      requirementIds: ['FR-05', 'IR-004', 'IR-016', 'IR-017'],
      frIds: ['FR-05'],
      nfrIds: [],
      trIds: [],
      irIds: ['IR-004', 'IR-016', 'IR-017'],
      files: [
        'db/migrations/0011_app_revisions.sql',
        'services/app-builder/src/revisions.ts',
        'apps/api-gateway/src/routes/apps-revisions.ts',
        'services/app-builder/tests/revisions.test.ts',
      ],
      surfaceImpacts: ['API', 'audit-log'],
      capabilityEdges: [],
      requiredIntegrationProof: [],
      doNotBreakContracts: [],
      wave: 3,
      dependsOn: ['T035'],
      acceptanceCriteria: [
        'Revision parent chain DAG',
        'Branch forks from any revision',
        'Restore creates new revision (no destructive overwrite)',
      ],
    }),
  ],
});

e2.stories.push({
  id: 'E2-S8',
  title: 'Preview builds with signed URLs',
  tasks: [
    addTask({
      id: T(),
      title: 'Preview build + signed URL endpoint',
      assignedAgent: 'api-endpoint-builder',
      requirementIds: ['FR-12', 'NFR-08', 'IR-006'],
      frIds: ['FR-12'],
      nfrIds: ['NFR-08'],
      trIds: [],
      irIds: ['IR-006'],
      files: [
        'services/app-builder/src/preview.ts',
        'services/app-builder/src/signed-url.ts',
        'apps/api-gateway/src/routes/apps-preview.ts',
        'services/app-builder/tests/preview.test.ts',
      ],
      surfaceImpacts: ['API', 'observability'],
      capabilityEdges: [],
      requiredIntegrationProof: ['TE-11 expiry+signature; tamper→403'],
      doNotBreakContracts: [],
      wave: 3,
      dependsOn: ['T035'],
      acceptanceCriteria: ['URL signed HMAC + expiry ≤ 15min', 'Tamper→403', 'Revoke invalidates'],
    }),
  ],
});

e2.stories.push({
  id: 'E2-S9',
  title: 'Share-link with SSO/password/domain allowlist',
  tasks: [
    addTask({
      id: T(),
      title: 'Share link table + endpoints + enforcement',
      assignedAgent: 'backend-dev',
      requirementIds: ['FR-22', 'IR-010', 'SR-AUTH-005'],
      frIds: ['FR-22'],
      nfrIds: [],
      trIds: [],
      irIds: ['IR-010'],
      files: [
        'db/migrations/0012_share_links.sql',
        'services/collaboration/src/share-links.ts',
        'apps/api-gateway/src/routes/apps-share-links.ts',
        'services/collaboration/tests/share-links.test.ts',
      ],
      surfaceImpacts: ['API', 'audit-log', 'permissions'],
      capabilityEdges: [],
      requiredIntegrationProof: ['TE-12 domain allowlist; SSO redirect to IdP'],
      doNotBreakContracts: [],
      wave: 3,
      dependsOn: ['T032'],
      acceptanceCriteria: [
        'Types: sso-only, password, domain-allowlist',
        'Secret hashed at rest',
        'Expiry enforced',
        'Audit on create+redeem',
      ],
    }),
  ],
});

e2.stories.push({
  id: 'E2-S10',
  title: 'Collaboration presence + edit locks',
  tasks: [
    addTask({
      id: T(),
      title: 'Presence + edit-lock endpoints (Valkey-backed)',
      assignedAgent: 'backend-dev',
      requirementIds: ['FR-20', 'FR-21', 'IR-045'],
      frIds: ['FR-20', 'FR-21'],
      nfrIds: [],
      trIds: [],
      irIds: ['IR-045'],
      files: [
        'services/collaboration/src/presence.ts',
        'services/collaboration/src/edit-locks.ts',
        'apps/api-gateway/src/routes/apps-presence.ts',
        'services/collaboration/tests/presence.test.ts',
      ],
      surfaceImpacts: ['API'],
      capabilityEdges: [],
      requiredIntegrationProof: [],
      doNotBreakContracts: [],
      wave: 3,
      dependsOn: ['T035'],
      acceptanceCriteria: ['Presence TTL 30s', 'Edit lock per file; conflict 409', 'Auto-expire on disconnect'],
    }),
  ],
});

e2.stories.push({
  id: 'E2-S11',
  title: 'Template start (first-party + marketplace)',
  tasks: [
    addTask({
      id: T(),
      title: 'Template catalog + create-from-template endpoint',
      assignedAgent: 'api-endpoint-builder',
      requirementIds: ['FR-23', 'FR-24', 'IR-011'],
      frIds: ['FR-23', 'FR-24'],
      nfrIds: [],
      trIds: [],
      irIds: ['IR-011'],
      files: [
        'db/migrations/0013_templates.sql',
        'services/app-builder/src/templates.ts',
        'apps/api-gateway/src/routes/templates.ts',
        'services/app-builder/tests/templates.test.ts',
      ],
      surfaceImpacts: ['API', 'dashboard'],
      capabilityEdges: [],
      requiredIntegrationProof: [],
      doNotBreakContracts: [],
      wave: 3,
      dependsOn: ['T035'],
      acceptanceCriteria: [
        'First-party list endpoint',
        'Marketplace entries flagged with publisher ID',
        'Create-from-template + ledger event',
      ],
    }),
  ],
});

e2.stories.push({
  id: 'E2-S2',
  title: 'Workspace shell (chat + editor + preview + logs + evidence)',
  tasks: [
    addTask({
      id: T(),
      title: 'Workspace panels: chat + preview + logs + evidence + layout',
      assignedAgent: 'frontend-dev',
      requirementIds: ['FR-02', 'IR-002'],
      frIds: ['FR-02'],
      nfrIds: [],
      trIds: [],
      irIds: ['IR-002'],
      files: [
        'apps/web/src/app/(workspace)/apps/[appId]/page.tsx',
        'apps/web/src/app/(workspace)/apps/[appId]/panels/chat.tsx',
        'apps/web/src/app/(workspace)/apps/[appId]/panels/preview.tsx',
        'apps/web/src/app/(workspace)/apps/[appId]/panels/logs.tsx',
        'apps/web/src/app/(workspace)/apps/[appId]/panels/evidence.tsx',
        'apps/web/src/app/(workspace)/apps/[appId]/panels/layout.tsx',
      ],
      surfaceImpacts: ['accessibility', 'observability', 'dashboard'],
      capabilityEdges: ['FEAT-002->accessibility', 'FEAT-002->observability', 'FEAT-001->dashboard'],
      requiredIntegrationProof: ['TE-14 + app appears in workspace within 1s'],
      doNotBreakContracts: [],
      wave: 4,
      dependsOn: ['T013', 'T016'],
      acceptanceCriteria: [
        '5 panels mount+resize grid',
        'Evidence panel reads /v1/evidence/events by app_id',
        'New app appears within 1s',
      ],
    }),
  ],
});

e2.stories.push({
  id: 'E2-S3',
  title: 'Editor with Monaco',
  tasks: [
    addTask({
      id: T(),
      title: 'Monaco editor panel (lazy-loaded)',
      assignedAgent: 'frontend-dev',
      requirementIds: ['FR-03', 'IR-003'],
      frIds: ['FR-03'],
      nfrIds: [],
      trIds: [],
      irIds: ['IR-003'],
      files: [
        'apps/web/src/app/(workspace)/apps/[appId]/panels/editor.tsx',
        'apps/web/src/components/monaco/monaco-loader.tsx',
      ],
      surfaceImpacts: ['accessibility'],
      capabilityEdges: ['FEAT-002->accessibility'],
      requiredIntegrationProof: ['Monaco keyboard+focus-ring'],
      doNotBreakContracts: [],
      wave: 4,
      dependsOn: ['T052'],
      acceptanceCriteria: [
        'Monaco lazy-loaded',
        'TypeScript language support enabled',
        'Save triggers revision create',
      ],
    }),
  ],
});

e2.stories.push({
  id: 'E2-S7',
  title: 'Visual-element patch (preview-anchored)',
  tasks: [
    addTask({
      id: T(),
      title: 'Preview-anchored visual patch overlay + comment-to-patch',
      assignedAgent: 'frontend-dev',
      requirementIds: ['FR-04', 'IR-003'],
      frIds: ['FR-04'],
      nfrIds: [],
      trIds: [],
      irIds: ['IR-003'],
      files: [
        'apps/web/src/app/(workspace)/apps/[appId]/visual-patch/overlay.tsx',
        'apps/web/src/app/(workspace)/apps/[appId]/visual-patch/comment-to-patch.tsx',
        'apps/web/src/app/(workspace)/apps/[appId]/visual-patch/anchor.ts',
      ],
      surfaceImpacts: [],
      capabilityEdges: [],
      requiredIntegrationProof: [],
      doNotBreakContracts: [],
      wave: 4,
      dependsOn: ['T052'],
      acceptanceCriteria: [
        'Click element→overlay+comment box',
        'Comment+selector→SSE patch request',
        'Anchor survives re-render',
      ],
    }),
  ],
});
epics.push(e2);

// ── Compile security + evidence + capability edges ──
const securityInvariants = [
  {
    id: 'SR-AUTH-005',
    summary: 'Session cookies Secure+HttpOnly+SameSite=Lax (Strict for admin)',
    source: 'security-requirements.md',
  },
  {
    id: 'SR-AUTH-006',
    summary: 'JWT access TTL ≤ 10 min; rotating refresh with server-side revocation + family invalidation on replay',
    source: 'security-requirements.md',
  },
  {
    id: 'SR-AUTH-007',
    summary: 'CSRF via double-submit cookie + same-site cookies',
    source: 'security-requirements.md',
  },
  {
    id: 'SR-AUTH-010',
    summary: 'A2A scoped bearer tokens; HMAC-SHA-256 or JWS signed events verified before side effect',
    source: 'security-requirements.md',
  },
  {
    id: 'SR-AUTH-011',
    summary: 'Service identities carry tenant/project/app/env/capability scope',
    source: 'security-requirements.md',
  },
  {
    id: 'SR-AUTHZ-001',
    summary: 'RBAC+ABAC engine covers tenant/project/app/env/role/data-class/provider/connector/approval/break-glass',
    source: 'security-requirements.md',
  },
  {
    id: 'SR-AUTHZ-002',
    summary: 'Deny-by-default; every endpoint+action mapped in authz-matrix.json',
    source: 'security-requirements.md',
  },
  {
    id: 'SR-AUTHZ-003',
    summary: 'Cross-tenant runtime access tests for every authenticated endpoint × role',
    source: 'security-requirements.md',
  },
  {
    id: 'SR-AUTHZ-004',
    summary: 'Auditor role read-only; any write → 403 + audit event',
    source: 'security-requirements.md',
  },
  {
    id: 'SR-AUTHZ-005',
    summary: 'Break-glass requires approver+scope+expiry+justification; recorded as ledger event',
    source: 'security-requirements.md',
  },
  {
    id: 'SR-CRYPTO-004',
    summary: 'Key rotation: signing keys 365d, service tokens 90d, CI/CD tokens 30d',
    source: 'security-requirements.md',
  },
  {
    id: 'SR-APP-022',
    summary: 'Env vars for platform config only — no PII/tokens/customer secrets',
    source: 'security-requirements.md',
  },
  {
    id: 'SR-APP-062',
    summary: 'Logs redacted at ingest; never log secrets/tokens/PAN/PHI plaintext',
    source: 'security-requirements.md',
  },
  {
    id: 'password-reset-single-use',
    summary: 'Password-reset single-use; reset/verification tokens hashed server-side (defer to M2)',
    source: 'security-requirements.md',
  },
  {
    id: 'encryption-at-rest',
    summary: 'Encryption-at-rest via KMS envelope for tenant data',
    source: 'security-requirements.md',
  },
];

const requiredTestEvidence = [
  { id: 'TE-01', summary: 'Tenant provisioning — user in tenant A cannot access tenant B (RLS)' },
  {
    id: 'TE-02',
    summary:
      'Scope middleware — missing X-Tenant-Id 400; missing X-Correlation-Id generated+echoed; tenant mismatch 403',
  },
  { id: 'TE-03', summary: 'Idempotency — same key returns stored response; different body same key 409; 24h TTL' },
  {
    id: 'TE-04',
    summary: 'Ledger writer — hash chain correct; integrity job detects tamper; atomic append with handler',
  },
  {
    id: 'TE-05',
    summary: 'Audit emitter — auth failures/policy denials/exports/support actions emit schema-valid events',
  },
  { id: 'TE-06', summary: 'Policy engine — RBAC 403+audit; ABAC deny by data-class; deny-by-default unmapped' },
  { id: 'TE-07', summary: 'SSO — SAML/OIDC validation; JIT only if enabled; session cookie flags verified' },
  { id: 'TE-08', summary: 'Authz census — every endpoint in authz-matrix.json; unmapped route fails CI' },
  { id: 'TE-09', summary: 'App creation — server-side execution only (NFR-02)' },
  { id: 'TE-10', summary: 'SSE stream — reconnect resumes; pause/resume/cancel transitions emit events' },
  { id: 'TE-11', summary: 'Preview URL — expiry+signature; tamper 403' },
  { id: 'TE-12', summary: 'Share-link — domain allowlist enforced; SSO redirect to IdP' },
  { id: 'TE-13', summary: 'Landing page — Lighthouse a11y ≥ 90; axe zero-critical; WCAG 2.2 AA' },
  { id: 'TE-14', summary: 'Workspace shell — keyboard nav; focus traps; skip-link' },
  { id: 'TE-15', summary: 'Abuse — admin cannot escalate to super-admin via ABAC body injection' },
  { id: 'TE-16', summary: 'Abuse — replayed refresh returns 401 + invalidates family' },
  { id: 'TE-17', summary: 'Abuse — signed event replay with same idempotency key returns cached response' },
  { id: 'TE-18', summary: 'RLS census — every tenant_id table rejects cross-tenant SELECT/UPDATE/DELETE' },
];

const capabilityEdges = [
  {
    featureId: 'FEAT-001',
    surface: 'analytics',
    status: 'impacts',
    requiredProof: ['Analytics event assertion app.create.requested/succeeded with tenant/app_id'],
    assignedTaskIds: ['T035'],
  },
  {
    featureId: 'FEAT-001',
    surface: 'audit-log',
    status: 'impacts',
    requiredProof: ['Ledger event append before 2xx'],
    assignedTaskIds: ['T035'],
  },
  {
    featureId: 'FEAT-001',
    surface: 'permissions',
    status: 'impacts',
    requiredProof: ['Only builder role can create (E1-S8)'],
    assignedTaskIds: ['T035', 'T029'],
  },
  {
    featureId: 'FEAT-001',
    surface: 'dashboard',
    status: 'impacts',
    requiredProof: ['App appears in workspace within 1s'],
    assignedTaskIds: ['T051'],
  },
  {
    featureId: 'FEAT-002',
    surface: 'accessibility',
    status: 'impacts',
    requiredProof: ['WCAG 2.2 AA; keyboard nav; focus traps'],
    assignedTaskIds: ['T013', 'T015', 'T016', 'T051', 'T052'],
  },
  {
    featureId: 'FEAT-002',
    surface: 'i18n',
    status: 'verify-no-change',
    requiredProof: ['Layout must not break in RTL/long-string locales'],
    assignedTaskIds: ['T015'],
  },
  {
    featureId: 'FEAT-002',
    surface: 'observability',
    status: 'impacts',
    requiredProof: ['Page view + user-action spans in OTLP'],
    assignedTaskIds: ['T015', 'T051'],
  },
  {
    featureId: 'FEAT-022',
    surface: 'API',
    status: 'impacts',
    requiredProof: ['Every mutating Tier-1 endpoint carries scope+idempotency headers'],
    assignedTaskIds: ['T023', 'T024'],
  },
  {
    featureId: 'FEAT-022',
    surface: 'data',
    status: 'impacts',
    requiredProof: ['RLS census every tenant_id column'],
    assignedTaskIds: ['T021', 'T024'],
  },
  {
    featureId: 'FEAT-022',
    surface: 'test',
    status: 'impacts',
    requiredProof: ['Cross-tenant abuse test per Tier-1 endpoint'],
    assignedTaskIds: ['T006', 'T021', 'T022'],
  },
  {
    featureId: 'FEAT-023',
    surface: 'audit-log',
    status: 'impacts',
    requiredProof: ['Hash-chain integrity job nightly; tamper detection test'],
    assignedTaskIds: ['T025', 'T027'],
  },
  {
    featureId: 'FEAT-023',
    surface: 'rollout',
    status: 'impacts',
    requiredProof: ['Ledger schema version gate at deploy; no forward-incompatible changes without dual-write'],
    assignedTaskIds: ['T025'],
  },
  {
    featureId: 'FEAT-023',
    surface: 'observability',
    status: 'impacts',
    requiredProof: ['Ledger write latency metric + SLO'],
    assignedTaskIds: ['T025', 'T027'],
  },
  {
    featureId: 'FEAT-026',
    surface: 'permissions',
    status: 'impacts',
    requiredProof: ['Admin protected; auditor read-only'],
    assignedTaskIds: ['T005', 'T029'],
  },
  {
    featureId: 'FEAT-026',
    surface: 'admin',
    status: 'impacts',
    requiredProof: ['Admin console stub exists (M1)'],
    assignedTaskIds: ['T017'],
  },
  {
    featureId: 'FEAT-026',
    surface: 'audit-log',
    status: 'impacts',
    requiredProof: ['Every denied request emits audit event'],
    assignedTaskIds: ['T026', 'T029'],
  },
  {
    featureId: 'FEAT-034',
    surface: 'observability',
    status: 'verify-no-change',
    requiredProof: ['Connector routes return 501 + audit in M1'],
    assignedTaskIds: ['T026'],
  },
];

const manifest = {
  milestone: 'M1',
  generatedAt: new Date().toISOString(),
  techStack: {
    languages: ['TypeScript', 'Python', 'Rust'],
    frameworks: ['Next.js 15', 'React 18', 'FastAPI', 'shadcn/ui', 'Tailwind 3.4'],
    databases: ['PostgreSQL 16', 'pgvector 0.7', 'Valkey 8 / Redis 7.2'],
    testFrameworks: ['Vitest', 'pytest', 'Playwright', 'axe-core'],
  },
  planningSkills: {
    projectManifestPresent: fs.existsSync('_cobolt-output/latest/planning/project-skills-manifest.md'),
    generatedManifestPresent: fs.existsSync('_cobolt-output/latest/planning/generated-skills-manifest.json'),
    appliedSkills: [],
  },
  securityInvariants,
  requiredTestEvidence,
  capabilityEdges,
  epics,
  waves: [1, 2, 3, 4, 5].map((n) => ({
    waveNumber: n,
    taskIds: waves[n],
    canParallelize: false,
    writerExecution: 'sequential-by-default',
  })),
  fileOwnership,
  totalTasks: allTasks.length,
  totalWaves: 5,
  totalFiles: Object.keys(fileOwnership).length,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2));

const storiesCount = epics.reduce((a, e) => a + e.stories.length, 0);
console.log('totalTasks:', manifest.totalTasks);
console.log('totalWaves:', manifest.totalWaves);
console.log('totalFiles:', manifest.totalFiles);
console.log('totalStories:', storiesCount);
console.log('securityInvariants:', manifest.securityInvariants.length);
console.log('requiredTestEvidence:', manifest.requiredTestEvidence.length);
console.log('capabilityEdges:', manifest.capabilityEdges.length);
console.log('written:', OUT);
