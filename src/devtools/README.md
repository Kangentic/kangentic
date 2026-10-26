# Devtools

Dev-only inspection bridge for the kangentic `/preview` instance. Lets an
agent (Claude Code in the dev session, an external MCP client, a
Playwright spec) query the running app's state and drive its UI.

## Boundary

This whole tree is excluded from production builds at compile time via
the esbuild `define` constant `__KANGENTIC_DEV__`.

- In dev (`npm start`, `npm run dev`): `__KANGENTIC_DEV__` is `true`.
  Each of the seven product hook lines that touch this tree resolves to
  the real implementation.
- In prod (`npm run package`, `npm run make`): `__KANGENTIC_DEV__` is
  `false`. Dead-code elimination drops both the `import` statement and
  the body of every `if (__KANGENTIC_DEV__) { ... }` guard, so this
  folder never reaches the production binary.

Product code may NOT import from this folder unguarded. The check is
mechanical: every entry from `src/main/`, `src/preload/`, `src/renderer/`,
or `src/shared/` into `src/devtools/` must be inside an
`if (__KANGENTIC_DEV__)` block (or, for renderer JSX, the equivalent
`{__KANGENTIC_DEV__ && <X />}` form). The reverse direction (devtools →
product) is unrestricted.

## Layout

```
src/devtools/
  install.ts                ← single entry from main/index.ts
  index.ts                  ← public re-exports
  README.md                 ← this file

  main/
    lockfile.ts              ← <projectRoot>/.kangentic/preview.lock
    instances.ts             ← combines product worktree-list with lockfile/port info
    inspection-server.ts     ← localhost HTTP bridge (SessionEvent injection is inline here)
    cdp.ts                   ← webContents.debugger.attach wrapper
    screenshot.ts            ← Page.captureScreenshot plumbing
    scroll-latency-route.ts  ← POST /scroll-latency: arm both rings, drive the wheel, read and join
    scroll-latency-report.ts ← the pure join and stats behind it
    ephemeral-projects.ts    ← --ephemeral preview project setup
    preview-task-title.ts    ← preview window title
    seed-*.ts                ← board/data seeders (usage, git changes, conversation, backlog)

  preload/
    install-globals.ts       ← installs window.__kangenticPreviewSnapshot, __kangenticPreviewReact
    mutation-observer.ts     ← in-renderer mutation ring buffer
    react-fiber-walker.ts    ← __REACT_DEVTOOLS_GLOBAL_HOOK__ utilities + the onCommitFiberRoot
                               ring. NOTE: the ring is inert under Vite dev - see the KNOWN GAP
                               block on installRenderTracker before trusting an empty result

  renderer/
    install.tsx              ← <DevtoolsBootstrap />
    state-mirror.ts          ← buildPreviewSnapshot() + PREVIEW_STORES registry / readStoreState()
    store-state.ts           ← pure store path-walk + JSON sanitization helpers
    lag-recorder.ts          ← event-loop lag ring + the long-animation-frame ring that carries
                               per-script attribution (both surfaced via /event-loop-lag)
    TestHarness.tsx          ← floating board-seeding toolbar (ephemeral previews only)
    DevToolsSections.tsx     ← rendered inside DeveloperTab when __KANGENTIC_DEV__

  mcp/
    register.ts              ← single entry from mcp-http-server.ts
    preview-tools.ts         ← all kangentic_devtools_* tools

  shared/
    types.ts                 ← PreviewLockfile, RendererStateSnapshot, ReactComponentInfo, etc.
```

## Subsystems

### Discovery (`main/lockfile.ts`, `main/instances.ts`)

Each running preview writes a per-worktree lockfile at
`<projectRoot>/.kangentic/preview.lock` recording the bound HTTP port.
External tools (the agent's MCP client, other preview instances, Playwright
specs) discover instances by walking every registered project's worktrees
and reading the lockfiles. Stale lockfiles are detected via PID liveness
(`isAlive(pid)` from the existing process-tree probe).

### HTTP bridge (`main/inspection-server.ts`)

Localhost-only HTTP server on a random port. Endpoints wrap product
diagnostics (`/logs`, `/crashes`, `/process-metrics`, `/ipc-log`),
expose live engine + renderer state (`/engine-state`, `/renderer-state`,
`/store-state`), serve screenshots + DOM (`/screenshot`, `/dom`,
`/query-all`, `/bounding-box`, `/bounding-box-all`, etc.), and accept
interaction commands (`/click`, `/type`, `/keypress`, `/drag`, `/drop-files`,
`/wait`, `/script`, `/eval`). `/drop-files` is the one OS-level input: it
dispatches a real file drop (`Input.dispatchDragEvent` with `files`) so the
page's `dataTransfer.files` carry path-backed `File` objects, which is what a
file-drop feature needs and no in-page `new File()` can fake. `POST /quit` runs Electron's real quit path; it is what
`scripts/dev.js` calls when a stop file asks it to shut a preview down, so a
`worktree-preview.js --stop` no longer force-kills the app past its
synchronous cleanup.

### CDP wrapper (`main/cdp.ts`)

Calls `webContents.debugger.attach('1.3')` on the main window and
exposes typed wrappers around the DevTools-Protocol calls used by the
HTTP bridge: `Page.captureScreenshot`, `DOM.querySelector` /
`getOuterHTML` / `getBoxModel`, `Input.dispatchMouseEvent` /
`dispatchKeyEvent` / `dispatchDragEvent`, `Runtime.evaluate`,
`Console.messageAdded`.

### Renderer mirror (`renderer/state-mirror.ts`, `renderer/store-state.ts`)

`buildPreviewSnapshot()` aggregates every Zustand store plus a few ring
buffers (toasts shown, dialogs opened, IPC errors). Installed on
`window.__kangenticPreviewSnapshot` so the inspection server can read
it via `Runtime.evaluate('JSON.stringify(window.__kangenticPreviewSnapshot())')`.

For reads beyond the fixed snapshot, `readStoreState(name, path)` (backed
by the `PREVIEW_STORES` registry, with the pure path-walk + sanitization
in `store-state.ts`) is installed on `window.__kangenticPreviewStoreState`
and serves `/store-state`. `PREVIEW_STORES` is the single place a new
Zustand store must be registered to become readable; the
`devtools-preview-stores` unit test fails CI if a `*-store.ts` is missing.

`renderer/lag-recorder.ts` holds the two dev-only performance rings: the
event-loop lag sampler (WHEN the thread blocked) and the
`long-animation-frame` ring with per-script attribution (WHAT ran). Both
are served by `/event-loop-lag`, beside main's report and the pty host's
own (`ptyHost`, from its `devLagReport` request).

### Scroll latency (`main/scroll-latency-route.ts`, `main/scroll-latency-report.ts`)

`POST /scroll-latency` (tool `kangentic_devtools_scroll_latency`) times a
fullscreen agent's scroll from the wheel to the painted frame. It arms two
rings that live in shipped code with dev-gated writes, since the pty host
may not import this tree: the renderer's
(`src/renderer/utils/scroll-latency-probe.ts`: wheel, report, paced send,
arrival, parse, paint) and the host's
(`src/main/diagnostics/pty-round-trip-probe.ts`: PTY write, first output,
flush, and how late each flush timer fired). It then drives trusted wheel
ticks through CDP, or records a person's own scrolling for a window, and
joins the rings. Every interval is taken on one process's clock; the
`transport` (both hops between the renderer and the host, over the
renderer's own port) comes from pairing the renderer's k-th report with the
host's k-th, and `transportLegs` splits it into its two hops by lining the
rings up by each process's `performance.timeOrigin`, to about a millisecond.
A keys drive also stamps each key at its `keydown` event time (the
renderer's `key` stage), so `keyToSend` and `keyToPainted` count a renderer
frame the key waited behind before its handler ran, which every leg that
starts at the handler misses. `slowKeys` counts the keys whose `keyToPainted`
reached 50 ms.
Every leg reports p50, p95, p99 and max, and each session's stream carries
the longest gap between its flushes and between its arrivals, which says
whether every terminal froze or only one. `profileHost` adds a CPU profile
of the host thread. For a zero-quota
floor, point a preview's `agent.cliPaths.claude` at a `.cmd` that runs
`tests/fixtures/mock-claude-scroll.js`, which answers each wheel report at
once (`scroll-load=<hz>` in a task's prompt makes it a streaming load).
`tornPaints` counts frames painted while an answer was partly delivered.
It also counts an answer made of several whole repaints, so check a high
count against the raw bytes (`kangentic_devtools_terminal_forensics`).

Fiber walking lives in `preload/react-fiber-walker.ts`, not here: it rides
`__REACT_DEVTOOLS_GLOBAL_HOOK__` to walk fibers from a DOM node and to
maintain a ring buffer of recent commits (via `onCommitFiberRoot`). Read
the KNOWN GAP block on `installRenderTracker` before trusting an empty
`recentRenders` result - under a Vite dev server the ring never attaches,
so `[]` means "not instrumented", not "no React work happened".

### MCP tools (`mcp/preview-tools.ts`, `mcp/register.ts`)

Every dev-only tool uses the `kangentic_devtools_*` prefix to keep them
distinct from the product-tier tools that ship in all builds. Each tool
talks to the inspection server over HTTP (the bridge could be in this
process or a different running preview instance - discovery picks the
right port).

## Adding a new tool

1. Add the new endpoint to `main/inspection-server.ts`.
2. Wire its implementation through `main/cdp.ts` if it needs DOM /
   Page / Input / Runtime / Console; or through a fresh module in
   `main/` if it talks to filesystem / process state.
3. Register a `kangentic_devtools_*` tool in `mcp/preview-tools.ts`
   that calls the new endpoint and formats the result.
4. Update this README's subsystem list.

Both gates apply to every tool:
- `developer.previewInspectionServer` (master switch - lockfile + bridge)
- `developer.previewEvalEnabled` (extra gate for arbitrary-code surfaces:
  `eval`, the `script` `eval` step, `inject_session_event`,
  `pty-input.bytes`). Read tools built on fixed server-generated
  expressions (`/renderer-state`, `/store-state`, `/query-all`,
  `/bounding-box-all`, `/react-component`) are NOT eval-gated - the
  selector / store name / path is interpolated as a JSON string literal,
  never executed as caller-supplied code.
