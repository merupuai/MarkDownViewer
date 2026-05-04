# CoBolt Operate Adapters (v0.44.0)

This directory ships **stub** adapters that conform to the operate-adapter
contract (`source/schemas/operate-adapter.schema.json`). They intentionally
return `not-implemented` verdicts — they exist so that:

1. `cobolt-mttr-probe.js` can resolve `--adapter <name>` against a module on disk (no runtime import error during contract integration tests).
2. Projects can `require()` the stub and use it as a scaffold for their own
   in-tree adapter.
3. v0.44.x iterations can ship first-party plugin packages
   (`@mftlabs/cobolt-adapter-fly`, `@mftlabs/cobolt-adapter-prometheus`, etc.)
   that drop in as replacements.

**Do not use the stubs as production probes.** Each one's `inject()` returns
an advisory verdict with `notImplemented: true`, `observe()` returns
`recovered: false`, and the mttr-probe surfaces these as `adapter-not-shipped`
at the gate level.

## Shipped stubs

| Name | Capabilities | Replacement package (planned) |
|---|---|---|
| `local-docker` | chaos, health-probe | In-tree; Docker/Compose-based local chaos |
| `fly-deploy` | deploy, rollback | `@mftlabs/cobolt-adapter-fly` |
| `docker-deploy` | deploy, rollback | `@mftlabs/cobolt-adapter-docker` |
| `prometheus-verify` | metrics, health-probe | `@mftlabs/cobolt-adapter-prometheus` |
| `grafana-dashboard` | dashboards | `@mftlabs/cobolt-adapter-grafana` |
| `sentry-error` | errors | `@mftlabs/cobolt-adapter-sentry` |

## Contract

```js
// Every adapter exports three async functions:

/**
 * Inject a fault per the declared scenario.
 * @param {object} scenario  — one entry from operate-feedback.mttrScenarios
 * @returns {Promise<{ok, detail, notImplemented?}>}
 */
async function inject(scenario) {}

/**
 * Observe the system until recovered OR timeout.
 * @param {object} scenario
 * @param {{timeoutMs:number}} options
 * @returns {Promise<{recovered:boolean, detail}>}
 */
async function observe(scenario, options) {}

/**
 * Best-effort cleanup regardless of inject/observe outcome.
 * @param {object} scenario
 * @param {object} faultHandle  — value returned by inject()
 * @returns {Promise<{ok:boolean, detail}>}
 */
async function restore(scenario, faultHandle) {}
```
