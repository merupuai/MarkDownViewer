#!/usr/bin/env node
// Fallback spec-kit generator — derives specs from task manifest for all M1 stories.
import fs from 'node:fs';
import path from 'node:path';

const MILESTONE = 'M1';
const MANIFEST = `_cobolt-output/latest/build/${MILESTONE}/${MILESTONE}-task-manifest.json`;
const OUT_DIR = `_cobolt-output/latest/build/${MILESTONE}/${MILESTONE}-story-specs`;
const PLANNING_OUT_DIR = `_cobolt-output/latest/planning/story-specs`;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(PLANNING_OUT_DIR, { recursive: true });

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

// Stack-specific templates
const roundOrder = { 1: 'Foundation', 2: 'Core Logic', 3: 'API Layer', 4: 'Frontend', 5: 'Finalize' };

function mdTable(rows) {
  return rows.join('\n');
}

function buildSpec(epic, story) {
  const tasks = story.tasks || [];
  const allFiles = tasks.flatMap((t) => t.files || []);
  const allReqs = [
    ...new Set(
      tasks.flatMap((t) => [
        ...(t.frIds || []),
        ...(t.nfrIds || []),
        ...(t.trIds || []),
        ...(t.irIds || []),
        ...(t.requirementIds || []),
      ]),
    ),
  ];
  const allAcceptance = tasks.flatMap((t) => (t.acceptanceCriteria || []).map((ac) => ({ taskId: t.id, ac })));
  const waveNum = tasks[0]?.wave || 1;
  const round = roundOrder[waveNum] || `Wave ${waveNum}`;
  const agents = [...new Set(tasks.map((t) => t.assignedAgent))];

  // File map table
  const fileMapRows = ['| Path | Action | Owner Task | Purpose |', '|---|---|---|---|'];
  tasks.forEach((t) => {
    (t.files || []).forEach((f) => {
      const entry = manifest.fileOwnership?.[f];
      const action = entry?.new ? 'create' : 'modify';
      fileMapRows.push(`| \`${f}\` | ${action} | ${t.id} | ${inferPurpose(f)} |`);
    });
  });

  // Function signatures / key exports per file type
  const fnLines = [];
  tasks.forEach((t) => {
    (t.files || []).forEach((f) => {
      const sig = inferSignature(f, t, story);
      if (sig) fnLines.push(sig);
    });
  });

  // Capability edges + security + test evidence for this story
  const capEdges = [...new Set(tasks.flatMap((t) => t.capabilityEdges || []))];
  const surfaces = [...new Set(tasks.flatMap((t) => t.surfaceImpacts || []))];
  const proofs = [...new Set(tasks.flatMap((t) => t.requiredIntegrationProof || []))];

  // Dependencies
  const deps = [...new Set(tasks.flatMap((t) => t.dependsOn || []))];

  return `# ${story.id} — ${story.title}

> Epic: **${epic.id}** — ${epic.title}
> Round: **${waveNum} (${round})**
> Agents: ${agents.join(', ')}
> Requirement IDs: ${allReqs.length ? allReqs.join(', ') : '(none — platform/infra story)'}

### Overview

${story.id} delivers: ${story.title}. Scope in M1: ${tasks.length} task${tasks.length === 1 ? '' : 's'} producing ${allFiles.length} file${allFiles.length === 1 ? '' : 's'}, grounded by the M1 build packet. Round ${waveNum} scheduling — depends on: ${deps.length ? deps.join(', ') : '(none)'}.

Applicable architecture non-negotiables (from build packet):
- Server-side execution only (NFR-02)
- Fail-closed middleware chain on mutating routes (NFR-01)
- Evidence ledger append before 2xx return (FEAT-023, applies if this story touches a mutating API)
- Topology parity (NFR-14), no \`reusable_assets/\` at runtime (NFR-13)

### Data Structures

${inferDataStructures(story, tasks)}

### Function Signatures

${fnLines.length ? fnLines.join('\n\n') : '_No external function signatures — this is a config/infra/migration story. See File Map for artifact list._'}

### API Endpoints

${inferApiEndpoints(story, tasks)}

### Integration Points

${inferIntegrationPoints(story, tasks, deps)}

### UI Components

${inferUIComponents(story, tasks, waveNum)}

### File Map

${mdTable(fileMapRows)}

### Implementation Order

${tasks.map((t, i) => `${i + 1}. **${t.id}** (${t.assignedAgent}) — ${t.title}`).join('\n')}

### Capability Edges & Surface Impact (must-prove)

${capEdges.length ? capEdges.map((e) => `- \`${e}\``).join('\n') : '- (none — internal/infrastructure story)'}

**Surfaces impacted**: ${surfaces.length ? surfaces.join(', ') : '(none)'}

**Required integration proof**:
${proofs.length ? proofs.map((p) => `- ${p}`).join('\n') : '- (none declared)'}

### Acceptance Criteria Traceability

${allAcceptance.length ? allAcceptance.map((a) => `- [${a.taskId}] ${a.ac}`).join('\n') : '_no criteria specified_'}

### Testing Hints

${inferTestingHints(story, tasks, waveNum)}

### Security Invariants to Honor

Review the Security & Data Protection Invariants in \`M1-build-packet.md\` before implementing. Specifically for this story:
${inferSecurityInvariants(story, tasks)}
`;
}

function inferPurpose(file) {
  if (/\.sql$/.test(file)) return 'Postgres migration';
  if (/middleware\//.test(file)) return 'Request middleware';
  if (/providers?\//.test(file)) return 'External provider seam';
  if (/routes\//.test(file)) return 'API route handler';
  if (/\/src\/index\.ts$/.test(file)) return 'Service entry point';
  if (/\/src\/policy\//.test(file)) return 'Policy engine component';
  if (/\/src\/session\//.test(file)) return 'Session/auth component';
  if (/tests?\//.test(file) || /\.test\.ts$/.test(file)) return 'Test suite';
  if (/components\//.test(file)) return 'UI component';
  if (/layout\.tsx$/.test(file)) return 'Route layout';
  if (/page\.tsx$/.test(file)) return 'Route page';
  if (/panels\//.test(file)) return 'Workspace panel';
  if (/package\.json$/.test(file)) return 'Package manifest';
  if (/tsconfig/.test(file)) return 'TypeScript config';
  if (/turbo\.json$/.test(file)) return 'Turborepo config';
  if (/pnpm-workspace/.test(file)) return 'pnpm workspace config';
  if (/eslint/.test(file)) return 'ESLint config';
  if (/\.yml$/.test(file)) return 'CI workflow';
  if (/\.js$/.test(file) && /k6/.test(file)) return 'k6 load scenario';
  if (/\.schema\.ts$/.test(file)) return 'Zod schema';
  if (/rules\//.test(file)) return 'Custom ESLint rule';
  if (/\.json$/.test(file)) return 'Config/data file';
  if (/\.ts$/.test(file)) return 'Service/library module';
  if (/\.tsx$/.test(file)) return 'React component';
  if (/\.md$/.test(file)) return 'Documentation';
  return 'Module file';
}

function inferSignature(file, task, _story) {
  // Only generate for non-test source files
  if (/tests?\//.test(file) || /\.test\./.test(file) || /\.sql$/.test(file) || /\.md$/.test(file)) return null;
  if (/tsconfig|package\.json|pnpm-workspace|turbo\.json|\.yml$|\.json$/.test(file)) return null;

  // Middleware
  if (/middleware\/scope\.ts$/.test(file)) {
    return '**`apps/api-gateway/src/middleware/scope.ts`** — `export async function scopeMiddleware(req: Request, ctx: Ctx): Promise<void>` — extracts `X-Tenant-Id`, rejects with 400 if missing, rejects with 403 on URL/header mismatch, sets Postgres session GUC `cobolt.tenant_id` via the scoped client helper (returned via `ctx.db`). Throws `HttpError` (fail-closed).';
  }
  if (/middleware\/correlation\.ts$/.test(file)) {
    return '**`apps/api-gateway/src/middleware/correlation.ts`** — `export function correlationMiddleware(req: Request, ctx: Ctx): void` — reads `X-Correlation-Id` if present, else generates via `crypto.randomUUID()`; echoes on response header; stamps `ctx.correlationId` for downstream.';
  }
  if (/middleware\/idempotency\.ts$/.test(file)) {
    return '**`apps/api-gateway/src/middleware/idempotency.ts`** — `export async function idempotencyMiddleware(req: Request, ctx: Ctx): Promise<Response | null>` — on mutating methods, reads `Idempotency-Key` header; looks up `idempotency_keys` table scoped by (tenant_id, key); returns stored response if hit; if key+body hash differs returns 409; stores response after handler success; 24h TTL.';
  }
  if (/middleware\/pipeline\.ts$/.test(file)) {
    return '**`apps/api-gateway/src/middleware/pipeline.ts`** — `export async function runPipeline(req: Request, handler: Handler): Promise<Response>` — runs scope → correlation → idempotency → authz → handler → ledger-emit in order; any throw short-circuits to error response (fail-closed, NFR-01).';
  }
  // Tenant provisioning
  if (/services\/tenant\/src\/provisioning\.ts$/.test(file)) {
    return "**`services/tenant/src/provisioning.ts`** — `export async function onboardTenant(input: { name: string; adminEmail: string; region: string; plan: 'free'|'team'|'enterprise' }): Promise<{ tenant: Tenant; admin: User; project: Project }>` — idempotent; transactional; emits ledger event `tenant.onboarded` before return.";
  }
  if (/services\/tenant\/src\/tenant-repository\.ts$/.test(file)) {
    return '**`services/tenant/src/tenant-repository.ts`** — `export class TenantRepo { async upsert(tenant: NewTenant): Promise<Tenant>; async findById(id: string): Promise<Tenant|null>; async findByName(name: string): Promise<Tenant|null> }` — uses `withTenant()` helper; every query scoped by tenant_id session GUC.';
  }
  if (/services\/tenant\/src\/policy\/engine\.ts$/.test(file)) {
    return "**`services/tenant/src/policy/engine.ts`** — `export async function evaluate(subject: Subject, action: string, resource: Resource, env: EvalEnv): Promise<Effect>` where `type Effect = 'allow' | 'deny' | 'undefined'`. Deny-by-default. Combines RBAC check → ABAC rules → break-glass → default deny. **This signature is an M1 cross-milestone contract — do NOT change in M2+.**";
  }
  if (/services\/tenant\/src\/policy\/rbac\.ts$/.test(file)) {
    return '**`services/tenant/src/policy/rbac.ts`** — `export function rbacCheck(role: Role, action: string, resource: Resource): Effect` — pure function; reads `authz-matrix.json` at startup into memory.';
  }
  if (/services\/tenant\/src\/policy\/abac\.ts$/.test(file)) {
    return '**`services/tenant/src/policy/abac.ts`** — `export function abacCheck(subject: Subject, resource: Resource, env: EvalEnv, rules: PolicyRule[]): Effect` — evaluates attribute-based rules; rules loaded per-request from `policy_rules` (tenant-scoped).';
  }
  // Evidence ledger
  if (/services\/evidence-ledger\/src\/writer\.ts$/.test(file)) {
    return '**`services/evidence-ledger/src/writer.ts`** — `export async function appendEvent(event: LedgerEvent, opts: { client: PoolClient; verifySignature?: boolean }): Promise<{ id: string; hash: string }>` — atomic with caller transaction (shared pool client); rejects if `verifySignature=true` and HMAC/JWS fails. **M1 cross-milestone contract.**';
  }
  if (/services\/evidence-ledger\/src\/hash-chain\.ts$/.test(file)) {
    return '**`services/evidence-ledger/src/hash-chain.ts`** — `export function computeHash(prevHash: string, payload: object): string` — returns `sha256(prevHash + canonicalJson(payload))` in hex. `export function verifyChain(events: LedgerEvent[]): { broken: boolean; firstBreakId?: string }`.';
  }
  if (/services\/evidence-ledger\/src\/integrity-job\.ts$/.test(file)) {
    return '**`services/evidence-ledger/src/integrity-job.ts`** — `export async function runIntegrityJob(opts: { client: PoolClient; metric: Metric }): Promise<{ scanned: number; firstBreakId: string|null }>` — walks chain per-tenant partition; emits OTLP counter `ledger.integrity.breaks`.';
  }
  if (/services\/evidence-ledger\/src\/audit-emitter\.ts$/.test(file)) {
    return "**`services/evidence-ledger/src/audit-emitter.ts`** — `export async function emitAuditEvent(evt: { actor: string; verb: AuditVerb; object: string; scope: Scope; result: 'allow'|'deny'; correlationId: string; payload?: object }): Promise<void>` — thin wrapper over `writer.appendEvent` with `AuditVerb` schema enforced.";
  }
  // Auth / SSO
  if (/services\/auth\/src\/saml\/callback\.ts$/.test(file)) {
    return '**`services/auth/src/saml/callback.ts`** — `export async function handleSamlCallback(req: Request): Promise<Response>` — validates SAML assertion (signature, NotOnOrAfter, unique AssertionID), issues session cookie with `HttpOnly+Secure+SameSite=Lax` per SR-AUTH-005.';
  }
  if (/services\/auth\/src\/oidc\/callback\.ts$/.test(file)) {
    return '**`services/auth/src/oidc/callback.ts`** — `export async function handleOidcCallback(req: Request): Promise<Response>` — exchanges code for tokens against tenant IdP; creates session + rotates refresh token.';
  }
  if (/services\/auth\/src\/session\/manager\.ts$/.test(file)) {
    return '**`services/auth/src/session/manager.ts`** — `export async function issueSession(userId: string, tenantId: string): Promise<{ accessToken: string; refreshCookie: string }>` (access ≤10 min, memory-only); `export async function revokeSession(sessionId: string): Promise<void>`.';
  }
  if (/services\/auth\/src\/session\/refresh-rotation\.ts$/.test(file)) {
    return '**`services/auth/src/session/refresh-rotation.ts`** — `export async function rotateRefresh(refreshToken: string): Promise<{ accessToken: string; refreshCookie: string }>` — single-use rotation; replay detection invalidates entire family + audit event (TE-16).';
  }
  // App builder
  if (/services\/app-builder\/src\/create-app\.ts$/.test(file)) {
    return '**`services/app-builder/src/create-app.ts`** — `export async function createAppFromPrompt(input: { prompt: string; templateId?: string; tenantId: string; projectId: string; ownerId: string }): Promise<App>` — persists app row status=creating; emits analytics + ledger events; returns immediately (generation runs async via Temporal workflow stub in M1).';
  }
  if (/services\/app-builder\/src\/app-repository\.ts$/.test(file)) {
    return '**`services/app-builder/src/app-repository.ts`** — `export class AppRepo { async create(app: NewApp): Promise<App>; async findById(id: string): Promise<App|null>; async updateStatus(id: string, status: AppStatus): Promise<void> }`.';
  }
  if (/services\/app-builder\/src\/stream-manager\.ts$/.test(file)) {
    return '**`services/app-builder/src/stream-manager.ts`** — `export async function* stream(appId: string, opts?: { resumeFromEventId?: string }): AsyncGenerator<StreamEvent>` — yields `{ id: string; type: GenEventType; data: object }`; reconnect-resume via `opts.resumeFromEventId` reading from Valkey stream buffer.';
  }
  if (/services\/app-builder\/src\/state-machine\.ts$/.test(file)) {
    return '**`services/app-builder/src/state-machine.ts`** — `export function transition(current: AppStatus, event: AppEvent): AppStatus` (throws on invalid transition → 409). States: `creating → streaming → paused → resumed | cancelled | completed`.';
  }
  if (/services\/app-builder\/src\/revisions\.ts$/.test(file)) {
    return '**`services/app-builder/src/revisions.ts`** — `export async function createRevision(appId: string, input: { parentId: string; branch: string; message: string }): Promise<Revision>`; `export async function restore(appId: string, revisionId: string): Promise<Revision>` (non-destructive — creates new revision whose parent is target).';
  }
  if (/services\/app-builder\/src\/preview\.ts$/.test(file)) {
    return '**`services/app-builder/src/preview.ts`** — `export async function buildPreview(appId: string, revisionId: string): Promise<{ url: string; expiresAt: Date }>`.';
  }
  if (/services\/app-builder\/src\/signed-url\.ts$/.test(file)) {
    return '**`services/app-builder/src/signed-url.ts`** — `export function signPreviewUrl(appId: string, revisionId: string, expiresAt: Date, secret: string): string` and `verify(url: string, secret: string): boolean` — HMAC-SHA-256.';
  }
  if (/services\/app-builder\/src\/templates\.ts$/.test(file)) {
    return '**`services/app-builder/src/templates.ts`** — `export async function listTemplates(): Promise<Template[]>`; `export async function createFromTemplate(templateId: string, tenantId: string, projectId: string, ownerId: string): Promise<App>`.';
  }
  if (/services\/app-builder\/src\/providers\/mock-provider\.ts$/.test(file)) {
    return '**`services/app-builder/src/providers/mock-provider.ts`** — `export const mockProvider: LLMProvider = { async *stream(prompt: string) { /* yield deterministic chunks */ } }` — `/* @cobolt:defer-real-provider: M2 */`. Implements `LLMProvider` interface stable across M1/M2.';
  }
  // Collaboration
  if (/services\/collaboration\/src\/presence\.ts$/.test(file)) {
    return '**`services/collaboration/src/presence.ts`** — `export async function heartbeat(appId: string, userId: string): Promise<void>` (Valkey SETEX 30s); `export async function getPresence(appId: string): Promise<PresenceEntry[]>`.';
  }
  if (/services\/collaboration\/src\/edit-locks\.ts$/.test(file)) {
    return '**`services/collaboration/src/edit-locks.ts`** — `export async function acquire(filePath: string, userId: string, ttlSec: number): Promise<boolean>` (Valkey SET NX EX); `export async function release(filePath: string, userId: string): Promise<void>`.';
  }
  if (/services\/collaboration\/src\/share-links\.ts$/.test(file)) {
    return "**`services/collaboration/src/share-links.ts`** — `export async function createShareLink(input: { appId: string; kind: 'sso-only'|'password'|'domain-allowlist'; params: ShareLinkParams; expiresAt?: Date }): Promise<{ id: string; secret: string }>` (secret returned ONCE; stored as argon2 hash); `export async function redeemShareLink(id: string, credential: string, request: Request): Promise<App | Redirect>`.";
  }
  // API routes
  if (/apps\/api-gateway\/src\/routes\//.test(file)) {
    const name = path.basename(file, '.ts');
    return `**\`${file}\`** — Route handler registered via pipeline middleware. Exports \`GET|POST|...\` matching resource semantics. Uses service layer (never directly queries DB). Returns via \`Response\` or \`Response.json()\`; non-2xx paths emit audit event where SR-AUTHZ-004 applies. Route file: \`${name}\`.`;
  }
  // Packages/UI primitives
  if (/packages\/ui\/src\/components\//.test(file)) {
    const comp = path.basename(file, '.tsx');
    return `**\`${file}\`** — shadcn/ui ${comp} primitive. Export named \`${comp[0].toUpperCase() + comp.slice(1)}\` and variants where appropriate. Use \`cn()\` from \`packages/ui/src/lib/utils.ts\`. Use semantic tokens (primary/muted/destructive), never raw Tailwind colors. Keyboard-accessible + focus ring (\`focus-visible:ring-2\`).`;
  }
  if (/packages\/ui\/src\/tokens\.ts$/.test(file)) {
    return '**`packages/ui/src/tokens.ts`** — `export const tokens = <typeof designTokens>` — TypeScript-typed re-export of `design-tokens.json` for consumer packages.';
  }
  if (/packages\/ui\/tailwind-preset\.ts$/.test(file)) {
    return '**`packages/ui/tailwind-preset.ts`** — `export default` Tailwind preset wiring design tokens into semantic class names (see M1-docs-cache.md §Tailwind preset).';
  }
  if (/packages\/authz-matrix\/src\/matrix\.schema\.ts$/.test(file)) {
    return '**`packages/authz-matrix/src/matrix.schema.ts`** — Zod schema for `authz-matrix.json`: `export const MatrixSchema = z.object({ version: z.literal(1), rules: z.array(RuleSchema) })`.';
  }
  // Lint rules
  if (/tools\/lint-rules\/rules\//.test(file)) {
    const rule = path.basename(file, '.ts');
    return `**\`${file}\`** — Custom ESLint rule \`cobolt/${rule}\`. Exports default \`Rule.RuleModule\`. See M1-docs-cache.md §ESLint Custom Rules for skeleton.`;
  }
  if (/tools\/authz-census\//.test(file)) {
    if (/scan-routes\.ts$/.test(file))
      return '**`tools/authz-census/src/scan-routes.ts`** — `export async function scanRoutes(root: string): Promise<RouteDescriptor[]>` — AST-walks `apps/**/routes/*.ts` and `services/**/routes/*.ts`, returns `{ method, path, file, line }[]`.';
    if (/diff\.ts$/.test(file))
      return '**`tools/authz-census/src/diff.ts`** — `export function diffRoutesAgainstMatrix(routes: RouteDescriptor[], matrix: AuthzMatrix): { unmapped: RouteDescriptor[]; orphaned: MatrixRule[] }`.';
    if (/bin\.ts$/.test(file))
      return '**`tools/authz-census/bin.ts`** — CLI: exit 1 on any unmapped route. Used by CI (T004).';
  }
  // Workspace shell / marketing pages
  if (/app\/\(workspace\)\/layout\.tsx$/.test(file)) {
    return '**`apps/web/src/app/(workspace)/layout.tsx`** — Next.js route-group layout. Renders `<SkipLink>`, `<Sidebar>`, `<Topbar>`, `<main>`. Server component by default; client subtrees mark with `"use client"`.';
  }
  if (/app\/\(workspace\)\/components\/sidebar\.tsx$/.test(file)) {
    return '**`apps/web/src/app/(workspace)/components/sidebar.tsx`** — `export function Sidebar({ collapsed }: { collapsed?: boolean })` — keyboard-accessible nav with ARIA landmarks. Uses primitives from `packages/ui`.';
  }
  if (/app\/\(workspace\)\/components\/topbar\.tsx$/.test(file)) {
    return '**`apps/web/src/app/(workspace)/components/topbar.tsx`** — `export function Topbar()` — tenant switcher + user menu (primitive `Select`, `Dialog`). Page-view OTLP span emitted on mount.';
  }
  if (/app\/\(workspace\)\/components\/skip-link\.tsx$/.test(file)) {
    return '**`apps/web/src/app/(workspace)/components/skip-link.tsx`** — `export function SkipLink()` — keyboard-only visible link that jumps focus to `<main id="content">`.';
  }
  if (/app\/\(marketing\)\/page\.tsx$/.test(file)) {
    return '**`apps/web/src/app/(marketing)/page.tsx`** — Landing route. Composes `<Hero>`, `<FeatureGrid>`, `<CTA>`. Server component; passes token-driven classes only.';
  }
  if (/app\/\(marketing\)\/layout\.tsx$/.test(file)) {
    return '**`apps/web/src/app/(marketing)/layout.tsx`** — Marketing-only layout (lightweight, no auth gate).';
  }
  if (/app\/\(marketing\)\/components\/hero\.tsx$/.test(file)) {
    return '**`apps/web/src/app/(marketing)/components/hero.tsx`** — `export function Hero()` — heading + subheading + primary CTA `<Button>` + SVG illustration (`/assets/hero.svg`).';
  }
  if (/app\/\(marketing\)\/components\/feature-grid\.tsx$/.test(file)) {
    return '**`apps/web/src/app/(marketing)/components/feature-grid.tsx`** — `export function FeatureGrid({ features }: { features: FeatureCard[] })` — 3-column grid at `md+`, stacked below.';
  }
  if (/app\/\(marketing\)\/components\/cta\.tsx$/.test(file)) {
    return '**`apps/web/src/app/(marketing)/components/cta.tsx`** — `export function CTA()` — email capture + primary button.';
  }
  if (/app\/\(workspace\)\/apps\/\[appId\]\/page\.tsx$/.test(file)) {
    return '**`apps/web/src/app/(workspace)/apps/[appId]/page.tsx`** — Workspace app route. Server component fetches app metadata, passes to client `<WorkspaceLayout>` with panels.';
  }
  if (/panels\/chat\.tsx$/.test(file)) {
    return '**`apps/web/src/app/(workspace)/apps/[appId]/panels/chat.tsx`** — Client component. Subscribes to SSE via `new EventSource("/v1/apps/" + appId + "/stream")`. Handles reconnect with `Last-Event-ID`.';
  }
  if (/panels\/preview\.tsx$/.test(file)) {
    return '**`apps/web/src/app/(workspace)/apps/[appId]/panels/preview.tsx`** — iframe with signed preview URL (from `/v1/apps/{id}/preview`).';
  }
  if (/panels\/logs\.tsx$/.test(file)) {
    return '**`apps/web/src/app/(workspace)/apps/[appId]/panels/logs.tsx`** — Streams OTLP spans tagged for this app; virtualized list.';
  }
  if (/panels\/evidence\.tsx$/.test(file)) {
    return '**`apps/web/src/app/(workspace)/apps/[appId]/panels/evidence.tsx`** — Fetches `GET /v1/evidence/events?appId=...&limit=50`; paginated list.';
  }
  if (/panels\/layout\.tsx$/.test(file)) {
    return '**`apps/web/src/app/(workspace)/apps/[appId]/panels/layout.tsx`** — CSS grid with 5 named areas. Responsive at `≥1024px`. Sidebar collapses below breakpoint.';
  }
  if (/panels\/editor\.tsx$/.test(file)) {
    return '**`apps/web/src/app/(workspace)/apps/[appId]/panels/editor.tsx`** — Lazy-wraps Monaco via `next/dynamic({ ssr: false })`. Binds save → `POST /v1/apps/{id}/revisions`.';
  }
  if (/components\/monaco\/monaco-loader\.tsx$/.test(file)) {
    return "**`apps/web/src/components/monaco/monaco-loader.tsx`** — `export const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false })`.";
  }
  if (/visual-patch\/overlay\.tsx$/.test(file)) {
    return '**`apps/web/src/app/(workspace)/apps/[appId]/visual-patch/overlay.tsx`** — Mounts a preview overlay; on element click emits a CSS selector + screenshot region.';
  }
  if (/visual-patch\/comment-to-patch\.tsx$/.test(file)) {
    return '**`apps/web/src/app/(workspace)/apps/[appId]/visual-patch/comment-to-patch.tsx`** — Comment box that POSTs `{ selector, comment }` to `/v1/apps/{id}/stream` as a patch request.';
  }
  if (/visual-patch\/anchor\.ts$/.test(file)) {
    return '**`apps/web/src/app/(workspace)/apps/[appId]/visual-patch/anchor.ts`** — `export function computeSelector(el: Element): string` — stable selector that survives hydration re-renders.';
  }
  // a11y tools
  if (/tools\/a11y\/src\/scan\.ts$/.test(file)) {
    return '**`tools/a11y/src/scan.ts`** — `export async function scanPage(url: string, tags: string[]): Promise<AxeResult>`. Exits non-zero on critical findings.';
  }
  if (/tools\/a11y\/playwright\.config\.ts$/.test(file)) {
    return '**`tools/a11y/playwright.config.ts`** — Playwright config targeting `apps/web` dev server. See M1-docs-cache.md §Playwright.';
  }
  // Misc stubs + placeholders
  if (/route\.ts$/.test(file)) {
    return `**\`${file}\`** — Next.js App Router route handler. Exports \`GET|POST|...\` as needed.`;
  }
  if (/\.ts$/.test(file)) {
    return `**\`${file}\`** — TypeScript module. Exports specific to task ${task.id}. See acceptance criteria for behavior.`;
  }
  if (/\.tsx$/.test(file)) {
    return `**\`${file}\`** — React component. See acceptance criteria for props/state.`;
  }
  return null;
}

function inferDataStructures(story, _tasks) {
  const id = story.id;
  if (id === 'E1-S1')
    return `\`\`\`ts
type Tenant = { id: string; name: string; plan: 'free'|'team'|'enterprise'; region: string; createdAt: Date; idpConfig?: IdpConfig };
type User = { id: string; tenantId: string; email: string; displayName: string; idpSubject?: string };
type Project = { id: string; tenantId: string; name: string; ownerId: string };
type RoleBinding = { userId: string; scope: Scope; role: Role };
type Role = 'admin'|'builder'|'auditor'|'member';
type Scope = { kind: 'tenant'|'project'|'app'; id: string };
\`\`\`
Corresponding migrations: \`0001_tenants.sql\`, \`0002_users.sql\`, \`0003_role_bindings.sql\`, \`0004_projects.sql\`, \`0005_rls_policies.sql\` — ALL enable + FORCE RLS per M1-docs-cache.md §PostgreSQL 16.`;
  if (id === 'E1-S4')
    return `\`\`\`sql
CREATE TABLE idempotency_keys (
  tenant_id UUID NOT NULL,
  key TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
\`\`\``;
  if (id === 'E1-S5')
    return `\`\`\`sql
CREATE TABLE evidence_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  actor TEXT NOT NULL,
  verb TEXT NOT NULL,
  object TEXT NOT NULL,
  scope JSONB NOT NULL,
  correlation_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  signature TEXT,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_evidence_tenant_ts ON evidence_events (tenant_id, ts DESC);
\`\`\`
\`\`\`ts
type LedgerEvent = { tenantId: string; actor: string; verb: AuditVerb; object: string; scope: Scope; correlationId: string; payload: object; signature?: string };
type AuditVerb = 'tenant.onboarded'|'user.created'|'auth.failed'|'policy.denied'|'app.created'|'revision.created'|'share.created'|'break-glass.granted'|'export.produced'|'support.action'|'connector.rejected';
\`\`\``;
  if (id === 'E1-S8')
    return `\`\`\`ts
type Effect = 'allow'|'deny'|'undefined';
type Subject = { userId: string; tenantId: string; roles: Role[]; attrs: Record<string,unknown> };
type Resource = { kind: string; id?: string; tenantId?: string; attrs: Record<string,unknown> };
type EvalEnv = { now: Date; requestIp: string; correlationId: string; breakGlass?: BreakGlassToken };
type PolicyRule = { id: string; tenantId?: string; subjectMatch: Match; action: string; resourceMatch: Match; effect: 'allow'|'deny'; attrs?: Record<string,unknown> };
\`\`\``;
  if (id === 'E1-S2')
    return `\`\`\`ts
type Session = { id: string; userId: string; tenantId: string; refreshFamily: string; rotatedAt: Date; ipHash: string; userAgentHash: string; expiresAt: Date };
\`\`\`
Migration: \`0009_sessions.sql\`. Refresh-token family invalidation on replay per SR-AUTH-006 + TE-16.`;
  if (id === 'E2-S1')
    return `\`\`\`ts
type App = { id: string; tenantId: string; projectId: string; ownerId: string; status: AppStatus; templateId?: string; createdAt: Date };
type AppStatus = 'creating'|'streaming'|'paused'|'resumed'|'cancelled'|'completed'|'failed';
type NewApp = Omit<App, 'id'|'createdAt'>;
\`\`\``;
  if (id === 'E2-S6')
    return `\`\`\`ts
type Revision = { id: string; appId: string; parentId: string|null; branch: string; message: string; commitHash: string; createdAt: Date };
\`\`\`
Restore NEVER destroys history — creates a new revision whose parent is the target.`;
  if (id === 'E2-S9')
    return `\`\`\`ts
type ShareLink = { id: string; appId: string; kind: 'sso-only'|'password'|'domain-allowlist'; params: ShareLinkParams; secretHash: string; expiresAt: Date|null };
type ShareLinkParams = { allowedDomains?: string[]; ssoTenantId?: string };
\`\`\`
Secret is returned once at creation; stored as argon2 hash. Log at creation + redemption.`;
  if (id === 'E2-S10')
    return `Valkey keys:
- \`presence:{appId}:{userId}\` → JSON \`{ lastSeen }\`, TTL 30s
- \`lock:file:{appId}:{path}\` → userId, TTL 60s, SET NX EX`;
  if (id === 'E2-S11')
    return `\`\`\`ts
type Template = { id: string; kind: 'first-party'|'marketplace'; publisherId?: string; name: string; description: string; tags: string[]; manifest: TemplateManifest };
\`\`\``;
  if (id === 'E10-S1')
    return `\`design-tokens.json\` shape: \`{ colors, typography, spacing, motion, radius }\`. Re-exported via \`packages/ui/src/tokens.ts\` (TypeScript-typed).`;
  if (id === 'E12-S3')
    return `\`authz-matrix.json\` shape: \`{ version: 1, rules: [{ method: 'GET'|'POST'|..., pathPattern: string, role: Role|'*', effect: 'allow'|'deny' }] }\``;
  return '_Pure logic / config story — see File Map and Function Signatures._';
}

function inferApiEndpoints(story, _tasks) {
  const map = {
    'E1-S1': ['POST /v1/tenants — create tenant + admin + default project (idempotent)'],
    'E1-S2': ['POST /v1/auth/sso/saml/callback', 'POST /v1/auth/sso/oidc/callback', 'POST /v1/auth/refresh'],
    'E1-S5': ['POST /v1/evidence/events (A2A-signed)', 'GET /v1/evidence/events (scoped, paginated)'],
    'E1-S6': ['GET /v1/audit/events (query by date/tenant)'],
    'E1-S8': ['POST /v1/policy/evaluate'],
    'E2-S1': ['POST /v1/apps'],
    'E2-S4': ['GET /v1/apps/{id}/stream (SSE)'],
    'E2-S5': ['POST /v1/apps/{id}/pause', 'POST /v1/apps/{id}/resume', 'POST /v1/apps/{id}/cancel'],
    'E2-S6': ['POST /v1/apps/{id}/revisions', 'POST /v1/apps/{id}/revisions/{revId}/restore'],
    'E2-S8': ['POST /v1/apps/{id}/preview'],
    'E2-S9': ['POST /v1/apps/{id}/share-links', 'POST /v1/apps/{id}/share-links/{slId}/redeem'],
    'E2-S10': [
      'POST /v1/apps/{id}/presence',
      'GET /v1/apps/{id}/presence',
      'POST /v1/apps/{id}/locks',
      'DELETE /v1/apps/{id}/locks/{path}',
    ],
    'E2-S11': ['GET /v1/templates', 'POST /v1/apps/from-template'],
    'E12-S3': ['(CLI tool, not API)'],
  };
  const lines = map[story.id];
  if (!lines) return '_No HTTP endpoints for this story (infrastructure or UI-only)._';
  return (
    lines.map((l) => `- \`${l}\``).join('\n') +
    `\n\nAll endpoints above run through: \`scope → correlation → idempotency → authz → handler → ledger-emit\`. Error response envelope: \`{ error: string, code: string, correlationId: string }\`.`
  );
}

function inferIntegrationPoints(story, _tasks, deps) {
  const notes = [];
  if (deps.length)
    notes.push(
      `Depends on tasks: ${deps.join(', ')} (earlier waves). Do NOT proceed until their build checkpoints confirm.`,
    );
  if (story.id.startsWith('E1-'))
    notes.push('Integrates with `packages/observability/` for OTLP correlation-id propagation.');
  if (story.id.startsWith('E2-')) {
    notes.push('Integrates with `services/evidence-ledger/` for audit/ledger events.');
    notes.push('Integrates with `services/tenant/` policy engine for authorization checks (evaluate() contract).');
  }
  if (['E2-S2', 'E2-S3', 'E2-S7', 'E10-S2', 'E10-S7'].includes(story.id))
    notes.push('Consumes `packages/ui/` primitives — never duplicate components.');
  if (['E1-S5', 'E1-S6', 'E1-S7'].includes(story.id))
    notes.push(
      'Evidence writer API is a cross-milestone contract — M2/M3/M4/M5 services will call it. Signature stable.',
    );
  if (story.id === 'E1-S8')
    notes.push('Policy engine `evaluate()` is a cross-milestone contract — used by every M2+ authorization decision.');
  return notes.length ? notes.map((n) => `- ${n}`).join('\n') : '_No cross-story integrations — standalone slice._';
}

function inferUIComponents(_story, _tasks, waveNum) {
  if (waveNum !== 4) return '_Not a frontend story._';
  return `Use primitives from \`packages/ui/\`:
- \`Button\`, \`Input\`, \`Dialog\`, \`Card\`, \`Toast\`, \`Select\`, \`Tabs\`
- Semantic color tokens via Tailwind preset (\`bg-primary\`, \`text-muted-foreground\`, etc.)
- Keyboard nav + focus rings (\`focus-visible:ring-2 focus-visible:ring-offset-2\`)
- Skip-link on workspace routes (\`(workspace)/components/skip-link.tsx\`)

See M1-design-cache.md for screen inventory + per-element guidance. All layouts token-driven; no raw Tailwind color or arbitrary pixel values.`;
}

function inferTestingHints(story, _tasks, _waveNum) {
  const hints = [];
  const id = story.id;

  if (id === 'E1-S1')
    hints.push(
      '- Happy: onboard creates tenant + admin + default project; idempotent on retry\n- Negative (TE-01): user in tenant A cannot read tenant B apps (RLS enforced)\n- RLS matrix (TE-18): cross-tenant SELECT/UPDATE/DELETE on every tenant_id table rejected',
    );
  else if (id === 'E1-S3')
    hints.push(
      '- Happy: request with valid `X-Tenant-Id` + matching URL tenant → pipeline proceeds\n- Negative (TE-02): missing header → 400; tenant mismatch → 403 + audit; missing correlation-id generated+echoed',
    );
  else if (id === 'E1-S4')
    hints.push(
      '- Happy (TE-03): same `Idempotency-Key` returns stored response\n- Negative: same key + different body → 409\n- Edge: 24h TTL expires correctly',
    );
  else if (id === 'E1-S5')
    hints.push(
      '- Happy (TE-04): hash chain correct (`h_n = sha256(h_{n-1} + payload)`)\n- Negative: unsigned A2A event → reject before side effect\n- Atomicity: append within same tx as caller; rollback cascades',
    );
  else if (id === 'E1-S6')
    hints.push(
      '- Happy (TE-05): auth failure/policy denial/export/support event has schema-valid shape\n- Edge: query filter by date + tenant returns subset',
    );
  else if (id === 'E1-S7')
    hints.push(
      '- Happy: integrity job walks chain end-to-end, reports clean\n- Negative (TE-04 ext): synthetic injected-hash corruption → `firstBreakId` correct + OTLP alert',
    );
  else if (id === 'E1-S8')
    hints.push(
      '- Happy (TE-06): RBAC allows admin; deny-by-default unmapped\n- Negative: non-admin on admin endpoint → 403 + audit\n- Auditor write → 403 + audit (SR-AUTHZ-004)\n- Abuse (TE-15): ABAC attribute injection via request body → ignored; policy uses verified subject attrs only',
    );
  else if (id === 'E1-S2')
    hints.push(
      '- Happy (TE-07): SAML signature valid, assertion not expired, session cookie flags set\n- Negative: replayed assertion (same AssertionID) → 401\n- Abuse (TE-16): replayed refresh token → 401 + invalidates family + audit',
    );
  else if (id === 'E12-S3')
    hints.push(
      '- Happy (TE-08): every route in repo appears in `authz-matrix.json`\n- Negative: add a new route without matrix entry → census CLI exits non-zero',
    );
  else if (id === 'E2-S1')
    hints.push(
      '- Happy: POST /v1/apps creates app row + emits analytics + ledger events before 2xx\n- Permission: auditor role POST → 403\n- Abuse: server-side execution only (TE-09) — no client JS path executes business logic',
    );
  else if (id === 'E2-S4')
    hints.push(
      '- Happy (TE-10): SSE stream yields events with monotonic IDs\n- Reconnect: `Last-Event-ID` resume replays from buffer\n- Lifecycle: heartbeat every 15s keeps connection alive',
    );
  else if (id === 'E2-S8')
    hints.push(
      '- Happy (TE-11): signed URL redirects to preview content\n- Negative: tampered signature → 403\n- Edge: expired URL → 403',
    );
  else if (id === 'E2-S9')
    hints.push(
      '- Happy (TE-12): domain-allowlist share redirects non-matching domain to error\n- SSO share: redirects to tenant IdP callback',
    );
  else if (id === 'E10-S7')
    hints.push(
      '- Happy (TE-13): axe-core zero critical; Lighthouse a11y ≥ 90\n- Responsive: ≥320px renders without overflow',
    );
  else if (id === 'E10-S2')
    hints.push(
      '- Happy (TE-14): keyboard nav tabs through sidebar + topbar\n- Focus: modal opens → focus trap; Escape returns focus to trigger\n- Skip-link: Tab from body start jumps to main content',
    );
  else if (id.startsWith('E10-S'))
    hints.push(
      `- Happy: route renders "not implemented in M1" placeholder\n- File carries \`@cobolt:defer-to: ${id === 'E10-S3' ? 'M2' : id === 'E10-S4' || id === 'E10-S6' ? 'M3' : 'M4'}\` comment\n- Accessibility: page title + skip-link present even in stub`,
    );
  else if (id.startsWith('E12-S'))
    hints.push('- Stub-only story — tests assert file exists + carries `@cobolt:defer-to: M2` comment');
  else
    hints.push(
      "- Happy path: primary API/UI flow succeeds\n- Negative path: required security invariant enforced (see M1-build-packet.md)\n- Edge case: failure mode for this story's domain",
    );

  hints.push('- Coverage: ≥ 85% lines; 100% for middleware + policy-engine paths');
  hints.push('- Follow AAA pattern (see M1-docs-cache.md §Vitest)');
  return hints.join('\n');
}

function inferSecurityInvariants(story, _tasks) {
  const invs = [];
  const id = story.id;
  if (['E1-S1'].includes(id))
    invs.push('- SR-AUTHZ-001 (RBAC/ABAC ownership); NFR-04 tenant isolation; RLS on every tenant_id table.');
  if (['E1-S2'].includes(id)) invs.push('- SR-AUTH-005 cookie flags; SR-AUTH-006 token rotation; SR-AUTH-007 CSRF.');
  if (['E1-S3'].includes(id))
    invs.push('- Fail-closed (NFR-01): missing/invalid scope must throw; never silently proceed.');
  if (['E1-S4'].includes(id)) invs.push('- TE-17: idempotency replay cannot execute twice.');
  if (['E1-S5'].includes(id))
    invs.push('- SR-AUTH-010 signature verify BEFORE side effect; SR-AUTH-011 scoped identity payload.');
  if (['E1-S6'].includes(id)) invs.push('- SR-APP-062 redaction at ingest; never log secrets/tokens/PHI.');
  if (['E1-S8'].includes(id))
    invs.push(
      '- SR-AUTHZ-002 deny-by-default; SR-AUTHZ-004 auditor write → 403+audit; SR-AUTHZ-005 break-glass scope+expiry.',
    );
  if (id.startsWith('E2-'))
    invs.push(
      '- NFR-02 server-side only; every mutating route runs full middleware chain (scope→correlation→idempotency→authz→handler→ledger).',
    );
  if (['E2-S9'].includes(id)) invs.push('- Secret hashed server-side (argon2); never stored plaintext.');
  if (id.startsWith('E10-') && id !== 'E10-S7')
    invs.push('- WCAG 2.2 AA; keyboard-only access; focus management on modals.');
  if (id === 'E12-S3') invs.push('- Census MUST fail CI on unmapped route (SR-AUTHZ-002).');
  if (invs.length === 0)
    invs.push(
      "- Review Security & Data Protection Invariants in M1-build-packet.md — apply any that touch this story's code paths.",
    );
  return invs.join('\n');
}

// ── Write specs ──
let written = 0;
for (const epic of manifest.epics || []) {
  for (const story of epic.stories || []) {
    const spec = buildSpec(epic, story);
    const filename = `${story.id}-impl-spec.md`;
    fs.writeFileSync(path.join(OUT_DIR, filename), spec);
    fs.writeFileSync(path.join(PLANNING_OUT_DIR, filename), spec);
    written++;
  }
}
console.log(`Wrote ${written} spec files to ${OUT_DIR} and ${PLANNING_OUT_DIR}`);
