---
paths:
  - "src/main/browser/**"
  - "src/main/agent/mcp-http/browser-tools.ts"
  - "src/main/agent/mcp-http/tool-result.ts"
  - "src/devtools/main/cdp.ts"
  - "src/devtools/main/screenshot.ts"
---
# Rule: the browser-automation driver ships; the CDP driver is the single source

The `kangentic_browser_*` MCP tools let an agent drive the user's dev server in a task's embedded
Browser pane (an Electron `<webview>` guest), via Chrome DevTools Protocol attached in-process. This
is a SHIPPED product capability (it targets the user's own app), unlike the dev-only
`kangentic_devtools_*` tools (which debug Kangentic itself over an HTTP bridge and are build-excluded
via `__KANGENTIC_DEV__`). Both surfaces drive CDP through the same helper module. Two risks must stay
closed: the shipped surface accidentally importing dev-only code (dragging it into production), and
the two surfaces forking the CDP driver (so click/type/screenshot semantics drift).

## The rule

- **The CDP driver is shipped and singular.** All `webContents.debugger.*` calls
  (`sendCommand` / `attach` / `detach` / listeners) live in exactly one module:
  `src/main/browser/cdp/cdp.ts`. It operates on a generic `WebContents`. The dev inspection bridge
  consumes it through thin `src/devtools/main/{cdp,screenshot}.ts` BrowserWindow-compat shims; the
  shipped browser-pane driver consumes it directly. Do not add a second `sendCommand` path.
- **Shipped browser-automation code never imports `src/devtools/`.** Files under
  `src/main/browser/**` and the shipped MCP tool files
  (`src/main/agent/mcp-http/browser-tools.ts`, `tool-result.ts`) must not import the dev-only tree.
  Imports flow dev -> shipped only.
- **Every CDP-driving `kangentic_browser_*` tool routes through `browserPaneDriver.withGuest`** and
  declares its capability tier (`observe` / `interact` / `navigate` / `eval`). `withGuest` is the single
  chokepoint that gates the global automation policy, resolves the target pane, attaches CDP, and shapes
  the `{ kind, detail }` error envelope. No tool may attach CDP or read a guest webContents directly.
  The sole exception is the discovery tool `kangentic_browser_list_panes`: it only reads the pane
  registry (no CDP attach, no `sendCommand`) and enumerates every pane rather than resolving one target,
  so the single-target `withGuest` path does not apply. It echoes `automationEnabled` so the agent sees
  the policy state. A new tool that drives a pane must still go through `withGuest`.
- **`eval` is gated off by default.** `kangentic_browser_eval` uses the `eval` capability, which the
  driver blocks unless `AppConfig.browserAutomation.allowEval` is on. Do not ship an ungated
  arbitrary-JS path.
- **Detach is synchronous on shutdown.** `browserPaneRegistry.detachAll()` runs in the synchronous
  `before-quit` path (see [[synchronous-shutdown]]); never make it async.

## Enforcement (self-maintaining)

- **Test:** `tests/unit/browser-automation-invariants.test.ts` scans `src/` and fails if a
  `webContents.debugger.*` call appears outside `src/main/browser/cdp/cdp.ts`, or if shipped
  browser-automation code imports `src/devtools/`. `tests/unit/browser-pane-registry.test.ts` and
  `browser-pane-driver.test.ts` lock target resolution, self-healing eviction, capability gating, and
  the navigation-URL policy. Run in CI via `npm run test:unit`.
- **Review:** `/code-review` flags a new `kangentic_browser_*` tool that bypasses `withGuest`, an
  ungated eval path, or a shipped import of `src/devtools/`.

## Drift over time

New `kangentic_browser_*` tools and new CDP helpers get added as the surface grows, and the
read-trigger gap means this rule may not be loaded when that happens. The single-driver and
no-devtools-import scans are the mechanical backstop: a forked `sendCommand` or a prod->dev import
fails CI the first time it runs, independent of whether this rule was in context. When the tool list
grows, keep each new tool's body going through `withGuest`; when a new CDP primitive is needed, add it
to `src/main/browser/cdp/cdp.ts`, never a second module.

## Scope

The shipped browser-pane automation surface: `src/main/browser/**`, the `kangentic_browser_*` tools,
and the shared CDP driver. The dev-only inspection bridge and `kangentic_devtools_*` tools under
`src/devtools/` are governed by [[dev-tooling-build-exclusion]].
