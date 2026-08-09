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
  There are exactly TWO exceptions, both of which attach no CDP:
  - `kangentic_browser_list_panes`, the discovery tool: it only reads the pane registry (no CDP attach,
    no `sendCommand`) and enumerates every pane rather than resolving one target, so the single-target
    `withGuest` path does not apply. It echoes `automationEnabled` so the agent sees the policy state.
  - `kangentic_browser_close_pane`: closing is renderer state (`browserOpenTasks`), reached by an IPC
    push, so there is no guest to resolve and nothing to drive. It still resolves its single-target
    form through `resolveTarget` and still checks `config.enabled` explicitly, since it never reaches
    `withGuest`'s capability gate. It is annotated MUTATING despite driving no CDP - it changes what is
    on the user's screen.

  `kangentic_browser_open_pane` is NOT an exception: every path that LOADS a URL ends by resolving
  through `withGuest` at the `navigate` tier, which is what makes "the pane is registered AND
  driveable" true rather than merely claimed. Its orchestration lives in
  `src/main/browser/browser-pane-opener.ts`, and the tool passes the tier in explicitly so it sits
  next to the `annotations:` it has to agree with. Its one non-navigating path - the pane is already
  up and no `url` was passed - returns registry status without attaching CDP, so it reports liveness
  (via `resolveLiveGuest`) rather than driveability; do not read the guarantee as covering it.

  Because that tool mutates the screen BEFORE it can reach a guest, it calls the driver's exported
  `capabilityGate` itself, up front. Gating only inside `withGuest` would let a gated-off capability
  open a window and seed a URL and only then refuse. A tool with side effects ahead of its
  `withGuest` call must do the same; the gate stays defined once, in the driver.

  A new tool that drives a pane must still go through `withGuest`.
- **A tool that opens or closes UI is caller-scoped by construction, and says what it did.**
  `open_pane` takes no `sessionId` / `taskId` at all: it targets the caller's own task, so there is no
  argument that could name another project's task. `close_pane` defaults to the caller's project and
  crosses projects only on an explicit `includeOtherProjects`, because a backgrounded project may have
  an agent mid-verification in its pane. Either way the response names the scope it applied and lists
  what it actually closed, so a partial result can never be reported as complete.
- **Every pane target is caller-scoped.** `registerBrowserTools` takes a `BrowserToolDependencies`
  carrying the URL-path `projectId` (always present) and the optional `callerSessionId`, mirroring
  `registerSteeringTools`. `ResolveTargetSelector.projectId` is required and explicitly nullable, so
  every branch of `resolveTarget` refuses a pane outside the caller's project with the
  `foreign-project` kind, and a new call site cannot fall back to process-wide behavior by omission
  (`null` is the deliberate unscoped path: main-process internal callers, plus the ONE opt-in below).
  The family deliberately has NO `project` argument and is deliberately NOT handed the
  `RequestResolver`, so "there is no path to DRIVING another project's pane" is a type-level
  guarantee rather than a convention.

  The single opt-in is `kangentic_browser_close_pane`'s `includeOtherProjects`, which passes
  `projectId: null` for an explicitly named target. It is scoped as narrowly as the feature allows:
  closing is not reading or controlling someone else's page, the flag is off by default, and it
  never widens a DRIVING call. A foreign pane can therefore be seen (`list_panes`) and closed, never
  driven. Any OTHER new `projectId: null` call site on this path is the bug this rule exists to
  catch.
  The `list_panes` exception above is only an exception to `withGuest`: it must still scope to the
  caller's project by default. The pane's registered `projectId` is backfilled in
  `BROWSER_PANE_REGISTER` from the session registry, since the renderer's value is ambient
  `currentProject` and a pop-out window's separate store holds it stale across a project switch.
- **A capture against a non-composited pane must fail fast, never hang.** Chromium stops
  compositing a window that is minimized, hidden, or fully occluded, and `Page.captureScreenshot`
  then never resolves: every later command for that guest queues behind it, wedging the pane for
  good. Two layers, and only the second is a guarantee:
  1. `withGuest` refuses up front with `pane-not-rendering` when
     `BrowserWindow.fromWebContents(guest.hostWebContents)?.isMinimized()`. Minimized is the only
     case main can observe, so this is a nicety that yields a clearer error, not coverage.
  2. `captureScreenshot` races the command against `SCREENSHOT_TIMEOUT_MS` (`cdp/cdp.ts`). This is
     the real backstop, because a merely hidden or occluded window is indistinguishable from a
     visible one through Electron's main-process API (`isVisible()` stays true). Do not remove the
     bound on the strength of the precondition check.
  The same physics is why a retained background pane must be hidden with `opacity: 0` rather than
  `visibility: hidden` or offscreen positioning: those stop compositing, an `opacity: 0` subtree
  does not.
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
  the navigation-URL policy. `tests/unit/mcp-browser-tools-project-scope.test.ts` is the
  caller-scoping guard: it enumerates the REGISTERED tools at runtime and fails when one has no
  entry in its args map, so a newly added browser tool cannot ship unscoped even though this rule
  may not be loaded when it is written. Run in CI via `npm run test:unit`.
- **Review:** `/code-review` flags a new `kangentic_browser_*` tool that bypasses `withGuest`, an
  ungated eval path, a shipped import of `src/devtools/`, or a `resolveTarget` / `withGuest` call
  site that passes `projectId: null` without being a main-process internal caller.

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
