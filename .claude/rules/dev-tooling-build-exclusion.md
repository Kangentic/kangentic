---
paths:
  - "src/devtools/**"
  - "src/main/index.ts"
---
# Rule: dev tooling is build-time excluded from production

Dev and debug tooling for Kangentic (the inspection HTTP bridge, MCP devtools tools, debug
overlays, the activity-engine overlay) must be physically removed from production builds, not
shipped behind a runtime toggle. Production users drive Claude Code on their own projects; they
never debug Kangentic itself, so dev tooling is pure surface area, bundle bloat, and confusing UX.

Product diagnostics under `src/main/diagnostics/` are not dev tooling and ship: the IPC traffic
recorder (`ipc-recorder.ts`, off until `developer.recordIpcTraffic`), the log mirror and crash
capture. Production error reporting does not depend on any of them. The IPC report wrap is its own
patch of `ipcMain.handle` (`src/main/analytics/ipc-handler-report.ts`), so a later dev gate on the
recorder cannot turn reporting off (`tests/unit/ipc-handler-report.test.ts` pins the install).

## The rule

- Anything under `src/devtools/` is dev-only.
- Gate every product-code hook into devtools with the build-time flag `__KANGENTIC_DEV__`
  (esbuild `define`: true in dev, false in prod) so dead-code elimination drops both the import
  and the body in production, e.g. `if (__KANGENTIC_DEV__) { installDevtools(...); }` in
  `src/main/index.ts`.
- The Developer settings tab must not render in production.
- Settings keys (e.g. `developer.activityDebugOverlay`) may live in `src/shared/types.ts` for
  type compatibility, but their UI affordances and runtime effects belong in dev-only modules.
- Do not use a runtime "include, default off" toggle in place of build-time exclusion.

## Enforcement (self-maintaining)

- **Review:** `/code-review` flags devtools imports or installs in product code that are not
  guarded by `__KANGENTIC_DEV__`.
- No dedicated mechanical test yet. A scan asserting every product-code import of `src/devtools/`
  sits inside a `__KANGENTIC_DEV__` guard is a candidate future test.

## Scope

Dev/debug tooling and its product-code entry points. Normal product features are not affected.
